// Mesh invite pairing (P2 §3): the code's shape, the invite store's rules,
// and the redeem handling at the serve boundary. The store is exercised
// directly for its bounds (TTL, live cap, attempts, single use, expiry on an
// injected clock); the redeem path runs over a real in-process link with a
// real signed handshake, driven nonce by nonce so the test holds the very
// transcript the MAC must cover; and the owner's two commands are driven
// end to end — `accept` pre-filling an invited policy, `join` pinning the
// key the code carries. Every refusal is the wire's own error, never a
// best-effort read: a code that does not decode is a failure, a bad MAC is a
// denial, a burned or spent invite is not_found.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { AuditLog } from "../../src/server/mesh/audit.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { authSigInput, transcript } from "../../src/server/mesh/handshake.js";
import { loadOrCreateIdentity, nodeIdOf, sign, type NodeIdentity } from "../../src/server/mesh/identity.js";
import {
  decodeInviteCode,
  encodeInviteCode,
  inviteMac,
  InviteStore,
  MAX_LIVE_INVITES,
  type InviteCode,
} from "../../src/server/mesh/pairing.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { serve, type ServeDeps } from "../../src/server/mesh/serve.js";
import { memoryLink } from "../../src/server/mesh/transport.js";
import { EXIT_FAILED, EXIT_OK, EXIT_USAGE, runPeerCli, type PeerCliIo } from "../../src/server/mesh/cli.js";
import type { MeshConfig } from "../../src/server/user-config.js";
import { tempDir } from "../helpers/app.js";

/** A fresh in-memory identity, the shape loadOrCreateIdentity returns. */
function identity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
  return { publicKey: raw, privateKey, nodeId: nodeIdOf(raw) };
}

const fixtures: string[] = [];
afterAll(async () => {
  await Promise.all(fixtures.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A config folder whose config.yml turns the mesh on, for the CLI's own reads. */
function meshOnDir(): string {
  const dir = tempDir("awui-mesh-pair-cfg-");
  writeFileSync(path.join(dir, "config.yml"), ["mesh:", "  enabled: true", "  name: target-box", ""].join("\n"));
  return dir;
}

/** A collector instead of the process's streams, with the test's folders in the environment. */
function collector(env: NodeJS.ProcessEnv, ask?: (question: string) => Promise<string>) {
  const out: string[] = [];
  const err: string[] = [];
  const io: PeerCliIo = {
    env: { AWUI_CONFIG_DIR: "", AWUI_MESH: "", ...env },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    ...(ask
      ? {
          ask: (question: string) => {
            return ask(question);
          },
        }
      : {}),
  };
  return { io, out, err };
}

/** One target's world: temp state with real pins and audit, a live invite store, the worker policy. */
interface Fixture {
  stateDir: string;
  serverIdentity: NodeIdentity;
  pins: PinStore;
  auditFile: string;
  invites: InviteStore;
  /** Advances the store's injected clock, so an expiry runs without a real wait. */
  tick: (minutes: number) => void;
  mesh: MeshConfig;
}

async function makeFixture(): Promise<Fixture> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "mesh-pair-state-"));
  fixtures.push(stateDir);
  let clock = Date.now();
  return {
    stateDir,
    serverIdentity: identity(),
    pins: PinStore(path.join(stateDir, "mesh", "pins.json")),
    auditFile: path.join(stateDir, "mesh", "audit.jsonl"),
    invites: new InviteStore({ now: () => clock }),
    tick: (minutes: number) => {
      clock += minutes * 60_000;
    },
    mesh: { enabled: true, name: "target-box", policies: { worker: { roots: [tmpdir()], harnesses: ["fake"] } } },
  };
}

/** One served link (ephemeral shape: no host, invites wired), plus its client end. */
function serveLink(f: Fixture, over: { origin?: "attach" | "stdio"; invites?: InviteStore | null } = {}): { client: RpcPeer; closed: Promise<string> } {
  const link = memoryLink();
  const deps: ServeDeps = {
    identity: f.serverIdentity,
    name: "target-box",
    pins: f.pins,
    audit: new AuditLog(f.auditFile, () => undefined),
    registry: {
      get: (id: string) => (id === "fake" ? new FakeAdapter({ chunkDelayMs: 1 }) : undefined),
      available: async (id: string) => id === "fake",
    },
    config: () => f.mesh,
    enabled: () => true,
    home: tmpdir(),
    ...(over.invites !== null ? { invites: over.invites ?? f.invites } : {}),
    ...(over.origin !== undefined ? { origin: over.origin } : {}),
  };
  const { closed } = serve({ input: link.server.input, output: link.server.output }, deps);
  const client = new RpcPeer(link.client.input, link.client.output, { role: "client" });
  client.start();
  return { client, closed };
}

/** One request that must fail, answered with the error the worker sent. */
async function refuse(rpc: RpcPeer, method: string, params: unknown): Promise<MeshRpcError> {
  return rpc.request(method, params).then(
    () => {
      throw new Error(`expected "${method}" to be refused`);
    },
    (error) => {
      expect(error).toBeInstanceOf(MeshRpcError);
      return error as MeshRpcError;
    },
  );
}

/** The client's hello reply, exactly as the wire promises it. */
interface HelloReply {
  v: number;
  name: string;
  publicKey: string;
  nonce: string;
  sig: string;
}

/**
 * A handshake driven nonce by nonce, so the test holds the very transcript a
 * redeem's MAC must cover — the same four values both signatures cover.
 */
async function handshakeAs(client: RpcPeer, who: NodeIdentity, name: string): Promise<Buffer> {
  const clientNonce = randomBytes(32);
  const hello = await client.request<HelloReply>("peer.hello", {
    v: 1,
    name,
    publicKey: who.publicKey.toString("base64url"),
    nonce: clientNonce.toString("base64url"),
    hops: 0,
  });
  const serverKey = Buffer.from(hello.publicKey, "base64url");
  const serverNonce = Buffer.from(hello.nonce, "base64url");
  const t = transcript(who.publicKey, clientNonce, serverKey, serverNonce);
  await client.request("peer.auth", { sig: sign(who, authSigInput(t)).toString("base64url") });
  return t;
}

/** One redeem's params, from an invite and a transcript. */
const redeemParams = (invite: { id: Buffer; secret: Buffer }, t: Buffer, mac?: Buffer): { inviteId: string; mac: string } => ({
  inviteId: invite.id.toString("base64url"),
  mac: (mac ?? inviteMac(invite.secret, t)).toString("base64url"),
});

/** Lets a served link end cleanly, so no listener outlives its test. */
async function endLink(client: RpcPeer, closed: Promise<string>): Promise<void> {
  client.close();
  await closed;
}

describe("the invite code", () => {
  const code: InviteCode = {
    v: 1,
    name: "target-box",
    addresses: ["lab.example:4784", "[2001:db8::1]:4784"],
    targetKey: randomBytes(32),
    inviteId: randomBytes(8),
    secret: randomBytes(16),
  };

  it("round-trips exactly: every field, byte for byte", () => {
    const text = encodeInviteCode(code);
    expect(text.startsWith("awui-invite:1:")).toBe(true);
    const back = decodeInviteCode(text);
    expect(back).not.toBeNull();
    expect(back!.name).toBe(code.name);
    expect(back!.addresses).toEqual(code.addresses);
    expect(back!.targetKey.equals(code.targetKey)).toBe(true);
    expect(back!.inviteId.equals(code.inviteId)).toBe(true);
    expect(back!.secret.equals(code.secret)).toBe(true);
  });

  it("refuses anything that is not exactly the promised shape", () => {
    const good = encodeInviteCode(code);
    const broken = (mutate: (doc: Record<string, unknown>) => void): string => {
      const body = Buffer.from(good.slice("awui-invite:1:".length), "base64url").toString("utf8");
      const doc = JSON.parse(body) as Record<string, unknown>;
      mutate(doc);
      return "awui-invite:1:" + Buffer.from(JSON.stringify(doc), "utf8").toString("base64url");
    };
    // Wrong prefix, empty body, a body that is not base64url, broken JSON, an extra field,
    // a short key, an id of the wrong size, and an address with no port: all null, never a guess.
    expect(decodeInviteCode("awui-invite:2:" + good.slice(14))).toBeNull();
    expect(decodeInviteCode("awui-invite:1:")).toBeNull();
    expect(decodeInviteCode("awui-invite:1:!!!not-base64!!!")).toBeNull();
    expect(decodeInviteCode("awui-invite:1:" + Buffer.from("not json", "utf8").toString("base64url"))).toBeNull();
    expect(decodeInviteCode(broken((doc) => { doc.extra = 1; }))).toBeNull();
    expect(decodeInviteCode(broken((doc) => { doc.k = Buffer.alloc(31).toString("base64url"); }))).toBeNull();
    expect(decodeInviteCode(broken((doc) => { doc.i = Buffer.alloc(9).toString("base64url"); }))).toBeNull();
    expect(decodeInviteCode(broken((doc) => { doc.a = ["no-port-here"]; }))).toBeNull();
    expect(decodeInviteCode(broken((doc) => { doc.v = 2; }))).toBeNull();
  });

  it("derives the MAC the spec spells: 32 bytes, bound to the secret and the transcript", () => {
    const secret = randomBytes(16);
    const t = randomBytes(128);
    const mac = inviteMac(secret, t);
    expect(mac).toHaveLength(32);
    // The same inputs derive the same MAC; either input changing changes it.
    expect(inviteMac(secret, t).equals(mac)).toBe(true);
    expect(inviteMac(randomBytes(16), t).equals(mac)).toBe(false);
    expect(inviteMac(secret, Buffer.concat([t, Buffer.alloc(1)])).equals(mac)).toBe(false);
  });
});

describe("the invite store", () => {
  it("holds the TTL at 1..60 minutes and the live count at sixteen", async () => {
    let now = Date.now();
    const store = new InviteStore({ now: () => now });
    expect(() => store.create("worker", 0, [])).toThrow();
    expect(() => store.create("worker", 61, [])).toThrow();
    expect(() => store.create("worker", 10, [])).not.toThrow();
    expect(store.create("worker", 1, []).expiresAt).toBe(now + 60_000);
    expect(store.create("worker", 60, []).expiresAt).toBe(now + 60 * 60_000);
    // Sixteen live at once; the seventeenth is the wire's -33004.
    for (let i = 0; i < MAX_LIVE_INVITES - 3; i++) store.create("worker", 60, []);
    expect(store.list()).toHaveLength(16);
    expect(() => store.create("worker", 60, [])).toThrow(MeshRpcError);
    // An expired invite frees its slot without anyone touching it.
    now += 61 * 60_000;
    expect(store.list()).toEqual([]);
    expect(() => store.create("worker", 60, [])).not.toThrow();
  });

  it("spends an invite on its first good MAC: a replay finds nothing", async () => {
    const store = new InviteStore();
    const invite = store.create("worker", 10, ["h:1"]);
    const t = randomBytes(128);
    const good = inviteMac(invite.secret, t);
    expect(store.check(invite.id, good, t)).toEqual({ ok: true, policy: "worker" });
    expect(store.check(invite.id, good, t)).toEqual({ ok: false, reason: "unknown" });
    expect(store.list()).toEqual([]);
  });

  it("burns an invite after five bad MACs, and four bad ones leave it alive", async () => {
    const store = new InviteStore();
    const invite = store.create("worker", 10, ["h:1"]);
    const t = randomBytes(128);
    const bad = Buffer.alloc(32, 0xab);
    for (let i = 1; i <= 4; i++) {
      expect(store.check(invite.id, bad, t)).toEqual({ ok: false, reason: "bad-mac" });
      // Four attempts spent, the fifth is still allowed to be the right one.
      if (i === 4) expect(store.check(invite.id, inviteMac(invite.secret, t), t)).toEqual({ ok: true, policy: "worker" });
    }
    const second = store.create("worker", 10, ["h:1"]);
    for (let i = 0; i < 5; i++) expect(store.check(second.id, bad, t)).toEqual({ ok: false, reason: "bad-mac" });
    // Burned: even the right MAC now finds nothing.
    expect(store.check(second.id, inviteMac(second.secret, t), t)).toEqual({ ok: false, reason: "unknown" });
  });

  it("answers an expired invite with its own refusal, on an injected clock", async () => {
    let now = Date.now();
    const store = new InviteStore({ now: () => now });
    const invite = store.create("worker", 1, ["h:1"]);
    now += 61 * 60_000;
    expect(store.check(invite.id, inviteMac(invite.secret, randomBytes(128)), randomBytes(128))).toEqual({ ok: false, reason: "expired" });
    expect(store.check(invite.id, inviteMac(invite.secret, randomBytes(128)), randomBytes(128))).toEqual({ ok: false, reason: "unknown" });
  });
});

describe("peer.redeem over a live link", () => {
  it("records a pending inbound request marked invited, and spends the invite", async () => {
    const f = await makeFixture();
    const { client, closed } = serveLink(f);
    const who = identity();
    const t = await handshakeAs(client, who, "joiner");
    const invite = f.invites.create("worker", 10, ["lab.example:4784"]);
    await expect(client.request("peer.redeem", redeemParams(invite, t))).resolves.toEqual({});
    const pending = await f.pins.pending("joiner");
    expect(pending?.publicKey.equals(who.publicKey)).toBe(true);
    expect(pending?.invited).toEqual({ inviteId: invite.id.toString("base64url"), policy: "worker" });
    // Single use: the same id and MAC again find nothing.
    const again = await refuse(client, "peer.redeem", redeemParams(invite, t));
    expect(again.code).toBe(MeshErrorCode.not_found);
    await endLink(client, closed);
  });

  it("answers an unknown id with not_found, and a bad MAC with a denial that still leaves the invite alive", async () => {
    const f = await makeFixture();
    const { client, closed } = serveLink(f);
    const who = identity();
    const t = await handshakeAs(client, who, "joiner");
    const unknown = await refuse(client, "peer.redeem", redeemParams({ id: randomBytes(8), secret: randomBytes(16) }, t));
    expect(unknown.code).toBe(MeshErrorCode.not_found);
    const invite = f.invites.create("worker", 10, ["h:1"]);
    const bad = await refuse(client, "peer.redeem", redeemParams(invite, t, Buffer.alloc(32, 0xcd)));
    expect(bad.code).toBe(MeshErrorCode.denied);
    expect(bad.message).toContain("did not verify");
    // One bad MAC burned nothing: the right one still redeems.
    await expect(client.request("peer.redeem", redeemParams(invite, t))).resolves.toEqual({});
    await endLink(client, closed);
  });

  it("refuses an expired invite with its own words", async () => {
    const f = await makeFixture();
    const { client, closed } = serveLink(f);
    const who = identity();
    const t = await handshakeAs(client, who, "joiner");
    const invite = f.invites.create("worker", 1, ["h:1"]);
    f.tick(61); // the fixture's store reads an injected clock, so the expiry needs no real wait
    const expired = await refuse(client, "peer.redeem", redeemParams(invite, t));
    expect(expired.code).toBe(MeshErrorCode.denied);
    expect(expired.message).toContain("expired");
    await endLink(client, closed);
  });

  it("answers method_not_found with no invite store, and refuses a link that is already paired", async () => {
    const f = await makeFixture();
    const bare = serveLink(f, { invites: null });
    const who = identity();
    const t = await handshakeAs(bare.client, who, "joiner");
    const missing = await refuse(bare.client, "peer.redeem", redeemParams({ id: randomBytes(8), secret: randomBytes(16) }, t));
    expect(missing.code).toBe(MeshErrorCode.method_not_found);
    await endLink(bare.client, bare.closed);

    // A paired caller has nothing to redeem: the answer is a denial, not a pending record.
    await f.pins.setInbound(who.publicKey, "joiner", "worker", "accept");
    const paired = serveLink(f);
    const t2 = await handshakeAs(paired.client, who, "joiner");
    const invite = f.invites.create("worker", 10, ["h:1"]);
    const denied = await refuse(paired.client, "peer.redeem", redeemParams(invite, t2));
    expect(denied.code).toBe(MeshErrorCode.denied);
    expect(denied.message).toContain("already paired");
    await endLink(paired.client, paired.closed);
  });
});

describe("local.invite.create", () => {
  it("serves only the attach origin, and the code it answers decodes to this node's facts", async () => {
    const f = await makeFixture();
    const { client, closed } = serveLink(f, { origin: "attach" });
    const who = identity();
    await handshakeAs(client, who, "target-box");
    const made = await client.request<{ code: string; policy: string; expiresAt: number }>("local.invite.create", {
      policy: "worker",
      ttlMinutes: 5,
      addresses: ["lab.example:4784"],
    });
    expect(made.policy).toBe("worker");
    expect(made.expiresAt).toBeGreaterThan(Date.now() + 4 * 60_000);
    expect(made.expiresAt).toBeLessThan(Date.now() + 6 * 60_000);
    const code = decodeInviteCode(made.code);
    expect(code).not.toBeNull();
    expect(code!.name).toBe("target-box");
    expect(code!.targetKey.equals(f.serverIdentity.publicKey)).toBe(true);
    expect(code!.addresses).toEqual(["lab.example:4784"]);
    // The default TTL is ten minutes, and the policy defaults to worker.
    const plain = await client.request<{ expiresAt: number; policy: string }>("local.invite.create", {});
    expect(plain.policy).toBe("worker");
    expect(plain.expiresAt).toBeGreaterThan(Date.now() + 9 * 60_000);
    await endLink(client, closed);

    // A stdio link answers method_not_found: local.* is the attach socket's alone.
    const stdio = serveLink(f, { invites: f.invites });
    await handshakeAs(stdio.client, who, "target-box");
    const refused = await refuse(stdio.client, "local.invite.create", { policy: "worker" });
    expect(refused.code).toBe(MeshErrorCode.method_not_found);
    await endLink(stdio.client, stdio.closed);
  });

  it("refuses an unknown policy, a bad TTL, and a bad address with the wire's own errors", async () => {
    const f = await makeFixture();
    const { client, closed } = serveLink(f, { origin: "attach" });
    const who = identity();
    await handshakeAs(client, who, "target-box");
    const policy = await refuse(client, "local.invite.create", { policy: "nowhere" });
    expect(policy.code).toBe(MeshErrorCode.denied);
    expect(policy.message).toContain('no mesh policy named "nowhere"');
    const ttl = await refuse(client, "local.invite.create", { ttlMinutes: 0 });
    expect(ttl.code).toBe(MeshErrorCode.invalid_params);
    const address = await refuse(client, "local.invite.create", { addresses: ["no-port"] });
    expect(address.code).toBe(MeshErrorCode.invalid_params);
    expect(f.invites.list()).toEqual([]);
    await endLink(client, closed);
  });

  it("answers -33004 once sixteen invites are live", async () => {
    const f = await makeFixture();
    for (let i = 0; i < MAX_LIVE_INVITES; i++) f.invites.create("worker", 60, []);
    const { client, closed } = serveLink(f, { origin: "attach" });
    const who = identity();
    await handshakeAs(client, who, "target-box");
    const error = await refuse(client, "local.invite.create", { policy: "worker" });
    expect(error.code).toBe(MeshErrorCode.limit);
    await endLink(client, closed);
  });
});

describe("the owner's CLI: accept pre-fills, join pins", () => {
  const codeOf = (over: Partial<InviteCode> = {}): string =>
    encodeInviteCode({
      v: 1,
      name: "target-box",
      addresses: ["lab.example:4784"],
      targetKey: randomBytes(32),
      inviteId: randomBytes(8),
      secret: randomBytes(16),
      ...over,
    });

  it("accept pre-fills an invited request's policy when --policy is omitted", async () => {
    const stateDir = tempDir("awui-mesh-pair-acc-");
    const pins = PinStore(path.join(stateDir, "mesh", "pins.json"));
    const who = await loadOrCreateIdentity(tempDir("awui-mesh-pair-who-"));
    await pins.addPending(who.publicKey, "joiner", { inviteId: randomBytes(8).toString("base64url"), policy: "worker" });
    const c = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: stateDir });
    expect(await runPeerCli(["accept", "joiner", "--yes"], c.io)).toBe(EXIT_OK);
    expect(c.out.join("\n")).toContain("policy: worker (pre-filled from the invite)");
    expect((await pins.inboundByName("joiner"))?.policy).toBe("worker");

    // A plain first contact still needs the policy spelled out: nothing is guessed.
    await pins.addPending(randomBytes(32), "stranger");
    const plain = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: stateDir });
    expect(await runPeerCli(["accept", "stranger", "--yes"], plain.io)).toBe(EXIT_USAGE);
    expect(plain.err.join("\n")).toContain("--policy is needed");
  });

  it("join pins the key the code carries, under its own name or --name, and stops there", async () => {
    const stateDir = tempDir("awui-mesh-pair-join-");
    const key = randomBytes(32);
    const text = codeOf({ targetKey: key });
    const c = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: stateDir });
    expect(await runPeerCli(["join", text], c.io)).toBe(EXIT_OK);
    const pinned = await PinStore(path.join(stateDir, "mesh", "pins.json")).outbound("target-box");
    expect(pinned?.publicKey.equals(key)).toBe(true);
    expect(pinned?.nodeId).toBe(nodeIdOf(key));
    const printed = c.out.join("\n");
    expect(printed).toContain(`Pinned target-box (${nodeIdOf(key)})`);
    expect(printed).toContain("tls: lab.example:4784");
    expect(printed).toContain("stops after pinning");

    const named = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: stateDir });
    expect(await runPeerCli(["join", codeOf({ targetKey: randomBytes(32) }), "--name", "lab"], named.io)).toBe(EXIT_OK);
    expect((await PinStore(path.join(stateDir, "mesh", "pins.json")).outbound("lab"))?.nodeId).toBeTruthy();
  });

  it("join refuses a code that does not decode, and a name already pinned to another key", async () => {
    const stateDir = tempDir("awui-mesh-pair-join2-");
    const bad = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: stateDir });
    expect(await runPeerCli(["join", "awui-invite:1:garbage"], bad.io)).toBe(EXIT_FAILED);
    expect(bad.err.join("\n")).toContain("not an awui invite code");

    const pins = PinStore(path.join(stateDir, "mesh", "pins.json"));
    await pins.setOutbound("target-box", randomBytes(32));
    const clash = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: stateDir });
    expect(await runPeerCli(["join", codeOf()], clash.io)).toBe(EXIT_FAILED);
    expect(clash.err.join("\n")).toContain("already pinned to a different key");
    expect(await runPeerCli(["join", "--nope"], collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: stateDir }).io)).toBe(EXIT_USAGE);
  });

  it("invite's command line is judged before anything is asked of a service", async () => {
    for (const args of [["invite", "--ttl", "90m"], ["invite", "stray"], ["invite", "--address", "no-port"], ["join"], ["join", "a", "b"]]) {
      const c = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: tempDir("awui-mesh-pair-u-") });
      const outcome = await runPeerCli(args, c.io);
      if (args[0] === "invite" && args[1] === "--address") {
        // A bad address shape passes the CLI (it is the service that judges addresses) and
        // fails against a socket that does not exist — still a failure, with a clear line.
        expect(outcome).toBe(EXIT_FAILED);
        expect(c.err.join("\n")).toContain("no running awui service");
      } else {
        expect(outcome, JSON.stringify(args)).toBe(EXIT_USAGE);
        expect(c.err.join("\n")).toContain("Usage");
        expect(c.out).toEqual([]);
      }
    }
  });
});
