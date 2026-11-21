// Mesh ask approvals (P2 §2): the target-side queue and its serve wiring.
// One in-process link per test — a memoryLink pair, a real signed handshake,
// real pins and audit in a temp state folder, and a real TaskHost behind a
// real ChatManager, exactly as mesh-host.test.ts builds a daemon, plus the
// shared ApprovalQueue every link waits on. The spec's every case: an ask
// waits instead of failing, allow-once answers exactly one call, allow-for-link
// covers the link's remaining work in the same root (and nothing in another
// root), deny answers -33002, expiry answers "no one answered", the queue's
// caps answer -33004, an ephemeral link keeps P1's -33003, local.* is the
// attach socket's alone, and the owner's CLI drives it over a real attach
// socket end to end.
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { ChatManager } from "../../src/server/chats/manager.js";
import { ApprovalQueue } from "../../src/server/mesh/approvals.js";
import { startAttachListener } from "../../src/server/mesh/attach.js";
import { AuditLog } from "../../src/server/mesh/audit.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { clientHandshake } from "../../src/server/mesh/handshake.js";
import { TaskHost } from "../../src/server/mesh/host.js";
import { loadOrCreateIdentity, nodeIdOf, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { serve, type ServeDeps } from "../../src/server/mesh/serve.js";
import { memoryLink } from "../../src/server/mesh/transport.js";
import { runPeerCli, type PeerCliIo } from "../../src/server/mesh/cli.js";
import type { MeshConfig } from "../../src/server/user-config.js";
import { tempDir } from "../helpers/app.js";

/** A fresh in-memory identity, the shape loadOrCreateIdentity returns. */
function identity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
  return { publicKey: raw, privateKey, nodeId: nodeIdOf(raw) };
}

/** One daemon's world: temp state with real pins and audit, roots the worker policy grants, a host, the shared queue. */
interface Fixture {
  stateDir: string;
  root: string;
  rootB: string;
  rootC: string;
  rootD: string;
  rootE: string;
  serverIdentity: NodeIdentity;
  pins: PinStore;
  auditFile: string;
  host: TaskHost;
  mesh: MeshConfig;
  queue: ApprovalQueue;
}

const fixtures: string[] = [];
afterAll(async () => {
  for (const dir of fixtures) {
    // The link-closed audit line is written behind `closed` resolving, so a removal can
    // race one last append; it settles within a tick and the retry takes the folder away.
    for (let attempt = 0; ; attempt++) {
      try {
        await rm(dir, { recursive: true, force: true });
        break;
      } catch {
        if (attempt >= 5) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  }
});

/** A config folder whose config.yml turns the mesh on, for the CLI's own reads. */
function meshOnDir(): string {
  const dir = tempDir("awui-mesh-appr-cfg-");
  writeFileSync(path.join(dir, "config.yml"), ["mesh:", "  enabled: true", "  name: target-box", ""].join("\n"));
  return dir;
}

async function makeFixture(over: { queueTtlMs?: number } = {}): Promise<Fixture> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "mesh-appr-state-"));
  const root = await mkdtemp(path.join(tmpdir(), "mesh-appr-root-"));
  const rootB = await mkdtemp(path.join(tmpdir(), "mesh-appr-root-b-"));
  const rootC = await mkdtemp(path.join(tmpdir(), "mesh-appr-root-c-"));
  const rootD = await mkdtemp(path.join(tmpdir(), "mesh-appr-root-d-"));
  const rootE = await mkdtemp(path.join(tmpdir(), "mesh-appr-root-e-"));
  fixtures.push(stateDir, root, rootB, rootC, rootD, rootE);
  const adapter = new FakeAdapter({ chunkDelayMs: 1 });
  const manager = new ChatManager();
  const registry = {
    get: (id: string) => (id === "fake" ? adapter : undefined),
    available: async (id: string) => id === "fake",
  };
  const host = new TaskHost({
    chats: manager,
    registry,
    workspace: async (real) => ({ id: "ws", path: real, name: path.basename(real) || real }),
    clock: () => Date.now(),
    detachedTtlHours: () => 24,
    log: () => undefined,
  });
  return {
    stateDir,
    root,
    rootB,
    rootC,
    rootD,
    rootE,
    serverIdentity: identity(),
    pins: PinStore(path.join(stateDir, "mesh", "pins.json")),
    auditFile: path.join(stateDir, "mesh", "audit.jsonl"),
    host,
    // The built-in worker policy asks fs.write; five roots so a grant's scope and the per-node cap are testable.
    mesh: { enabled: true, policies: { worker: { roots: [root, rootB, rootC, rootD, rootE], harnesses: ["fake"] } } },
    queue: new ApprovalQueue(over.queueTtlMs !== undefined ? { ttlMs: over.queueTtlMs } : {}),
  };
}

/** One served link against the fixture's host and shared queue, plus its client end. */
function serveLink(f: Fixture, over: { daemon?: boolean; origin?: "attach" | "stdio"; approvals?: ApprovalQueue | null } = {}): { client: RpcPeer; closed: Promise<string> } {
  const link = memoryLink();
  const daemon = over.daemon !== false;
  const approvals = over.approvals === null ? undefined : over.approvals ?? f.queue;
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
    ...(daemon ? { host: f.host, approvals: approvals ?? f.queue, origin: over.origin ?? "stdio" } : {}),
  };
  const { closed } = serve({ input: link.server.input, output: link.server.output }, deps);
  const client = new RpcPeer(link.client.input, link.client.output, { role: "client" });
  client.start();
  return { client, closed };
}

/** A paired client: the daemon has already accepted this fresh key under the worker policy. */
async function connectPaired(f: Fixture, over: Parameters<typeof serveLink>[1] = {}): Promise<{ client: RpcPeer; closed: Promise<string> }> {
  const who = identity();
  await f.pins.setInbound(who.publicKey, "leader-box", "worker", "accept");
  const end = serveLink(f, over);
  await clientHandshake(end.client, { identity: who, name: "leader-box", hops: 0, expectedServerKey: f.serverIdentity.publicKey, tofu: false });
  return end;
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

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until probe returns a value; the queue answers on real timers behind the call. */
async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const value = await probe();
    if (value !== undefined) return value;
    await tick(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Lets a served link end cleanly, so no listener outlives its test. */
async function endLink(client: RpcPeer, closed: Promise<string>): Promise<void> {
  client.close();
  await closed;
}

/** One fs.write request payload, base64 as the wire carries it. */
const writeParams = (root: string, name: string): { path: string; data: string; mode: "create" } => ({
  path: path.join(root, name),
  data: Buffer.from(`hello ${name}`).toString("base64"),
  mode: "create",
});

describe("the queue itself", () => {
  it("caps a node at four pending cards and the queue at thirty-two, answering -33004 over either", async () => {
    const queue = new ApprovalQueue();
    const link = queue.openLink();
    // Four distinct roots: the dedupe folds same-root asks into one card, so the cap is what is tested.
    for (let i = 1; i <= 4; i++) {
      void queue.ask(link, { nodeId: "node-a", peerName: "a", method: "fs.write", cap: "fs.write", root: `r${i}`, summary: `fs.write r${i}` });
    }
    await expect(queue.ask(link, { nodeId: "node-a", peerName: "a", method: "fs.write", cap: "fs.write", root: "r5", summary: "x" })).rejects.toMatchObject({ code: MeshErrorCode.limit });
    // Seven more nodes at four each fill the queue to its spec total.
    for (let n = 2; n <= 8; n++) {
      const other = queue.openLink();
      for (let i = 1; i <= 4; i++) {
        void queue.ask(other, { nodeId: `node-${n}`, peerName: `n${n}`, method: "fs.write", cap: "fs.write", root: `r${i}`, summary: "x" });
      }
    }
    expect(queue.list()).toHaveLength(32);
    const ninth = queue.openLink();
    await expect(queue.ask(ninth, { nodeId: "node-9", peerName: "n9", method: "fs.write", cap: "fs.write", root: "r1", summary: "x" })).rejects.toMatchObject({ code: MeshErrorCode.limit });
  });

  it("expires a card nobody answers, settling its waiter and refusing a late decision", async () => {
    const queue = new ApprovalQueue({ ttlMs: 40 });
    const link = queue.openLink();
    const asked = queue.ask(link, { nodeId: "node-a", peerName: "a", method: "fs.write", cap: "fs.write", root: "r1", summary: "fs.write r1" });
    const card = await waitFor(() => queue.list()[0], "the card");
    await new Promise((resolve) => setTimeout(resolve, 90));
    expect(await queue.list()).toEqual([]);
    await expect(asked).resolves.toBe("expired");
    expect(queue.decide(card.id, "allow-once")).toBe("not-found");
  });

  it("answers a closed link's waiters with expired, and its grants end with it", async () => {
    const queue = new ApprovalQueue();
    const link = queue.openLink();
    const asked = queue.ask(link, { nodeId: "node-a", peerName: "a", method: "fs.write", cap: "fs.write", root: "r1", summary: "fs.write r1" });
    const card = await waitFor(() => queue.list()[0], "the card");
    queue.decide(card.id, "allow-for-link");
    expect(link.has("fs.write", "r1")).toBe(true);
    // The grant answers the link's own next same-root ask with no card at all.
    await expect(queue.ask(link, { nodeId: "node-a", peerName: "a", method: "fs.write", cap: "fs.write", root: "r1", summary: "fs.write r1" })).resolves.toBe("allow");
    expect(queue.list()).toEqual([]);
    // A card still waiting when the link ends settles expired, never allow.
    const second = queue.ask(link, { nodeId: "node-a", peerName: "a", method: "fs.write", cap: "fs.write", root: "r2", summary: "fs.write r2" });
    await waitFor(() => (queue.list()[0]?.root === "r2" ? queue.list()[0] : undefined), "the second card");
    queue.dropLink(link);
    expect(link.has("fs.write", "r1")).toBe(false);
    await expect(asked).resolves.toBe("allow");
    await expect(second).resolves.toBe("expired");
    expect(queue.list()).toEqual([]);
  });
});

describe("an ask on a daemon link", () => {
  it("waits on the queue, and allow-once answers exactly the one call", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f);
    const write = client.request("fs.write", writeParams(f.root, "a.txt"));
    const card = await waitFor(() => f.queue.list()[0], "the approval card");
    expect(card.method).toBe("fs.write");
    expect(card.cap).toBe("fs.write");
    expect(card.peerName).toBe("leader-box");
    expect(card.nodeId).toBe(nodeIdOf((await f.pins.inboundByName("leader-box"))!.publicKey));
    // The summary names the method and the path; it never carries the payload.
    expect(card.summary).toContain("fs.write");
    expect(card.summary).toContain("a.txt");
    expect(card.root).toBe(await realpath(f.root));
    expect(f.queue.decide(card.id, "allow-once")).toBe("ok");
    const done = (await write) as { size: number };
    expect(done.size).toBeGreaterThan(0);
    // Allow-once granted nothing: the next write in the same root is a fresh card.
    const second = client.request("fs.write", writeParams(f.root, "b.txt"));
    await waitFor(() => (f.queue.list()[0]?.summary.includes("b.txt") ? f.queue.list()[0] : undefined), "a second card");
    f.queue.decide(f.queue.list()[0]!.id, "deny");
    await expect(second).rejects.toMatchObject({ code: MeshErrorCode.denied });
    await endLink(client, closed);
  });

  it("allow-for-link covers the link's remaining work in the same root, and nothing in another root", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f);
    const first = client.request("fs.write", writeParams(f.root, "a.txt"));
    const card = await waitFor(() => f.queue.list()[0], "the approval card");
    f.queue.decide(card.id, "allow-for-link");
    await first;
    // Same root, another file: the grant answers, no card is raised.
    await client.request("fs.write", writeParams(f.root, "b.txt"));
    expect(f.queue.list()).toEqual([]);
    // Another root: the grant's key says no, so a card is raised again.
    const other = client.request("fs.write", writeParams(f.rootB, "c.txt"));
    const second = await waitFor(async () => (f.queue.list()[0]?.root === (await realpath(f.rootB)) ? f.queue.list()[0] : undefined), "a card for the other root");
    f.queue.decide(second.id, "allow-once");
    await other;
    await endLink(client, closed);
  });

  it("answers a deny with -33002 and an expiry with 'no one answered'", async () => {
    const f = await makeFixture({ queueTtlMs: 60 });
    const { client, closed } = await connectPaired(f);
    const denied = client.request("fs.write", writeParams(f.root, "a.txt"));
    const card = await waitFor(() => f.queue.list()[0], "the approval card");
    f.queue.decide(card.id, "deny");
    const error = await refusedAs(denied);
    expect(error.code).toBe(MeshErrorCode.denied);
    expect(error.message).toContain("denied on the target");

    const expired = client.request("fs.write", writeParams(f.root, "b.txt"));
    await waitFor(() => (f.queue.list()[0]?.summary.includes("b.txt") ? f.queue.list()[0] : undefined), "a second card");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const gone = await refusedAs(expired);
    expect(gone.code).toBe(MeshErrorCode.denied);
    expect(gone.message).toContain("no one answered on the target");
    expect(f.queue.list()).toEqual([]);
    await endLink(client, closed);
  });

  it("keeps the per-node cap on a live link: the fifth concurrent ask is -33004", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f);
    // Four cards first: one fs.write per root, so the one node holds four distinct
    // keys at once — exactly its per-node cap. The fifth, in the fifth root, is -33004.
    const roots = [f.root, f.rootB, f.rootC, f.rootD];
    const pending: Array<Promise<unknown>> = roots.map((root, i) => client.request("fs.write", writeParams(root, `${i}.txt`)));
    await waitFor(() => (f.queue.list().length === 4 ? f.queue.list() : undefined), "four cards");
    const fifth = await refuse(client, "fs.write", writeParams(f.rootE, "5.txt"));
    expect(fifth.code).toBe(MeshErrorCode.limit);
    for (const card of f.queue.list()) f.queue.decide(card.id, "deny");
    await Promise.allSettled(pending);
    await endLink(client, closed);
  });
});

/** One request promise that must end in the wire's error shape. */
async function refusedAs(promise: Promise<unknown>): Promise<MeshRpcError> {
  return promise.then(
    () => {
      throw new Error("expected the request to be refused");
    },
    (error) => {
      expect(error).toBeInstanceOf(MeshRpcError);
      return error as MeshRpcError;
    },
  );
}

describe("ephemeral and non-attach links", () => {
  it("keeps P1's -33003 on an ephemeral link: there is no one to ask", async () => {
    const f = await makeFixture();
    const { client, closed } = serveLink(f, { daemon: false });
    const who = identity();
    await f.pins.setInbound(who.publicKey, "leader-box", "worker", "accept");
    await clientHandshake(client, { identity: who, name: "leader-box", hops: 0, expectedServerKey: f.serverIdentity.publicKey, tofu: false });
    const error = await refuse(client, "fs.write", writeParams(f.root, "a.txt"));
    expect(error.code).toBe(MeshErrorCode.needs_approval);
    expect(f.queue.list()).toEqual([]);
    await endLink(client, closed);
  });

  it("refuses local.* with method_not_found on a stdio link, daemon or not", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f);
    const error = await refuse(client, "local.approvals.list", {});
    expect(error.code).toBe(MeshErrorCode.method_not_found);
    await endLink(client, closed);
  });

  it("serves local.* to the attach socket's own unpaired CLI, and records no pending pin for it", async () => {
    const f = await makeFixture();
    const { client, closed } = serveLink(f, { origin: "attach" });
    const who = identity();
    const hs = await clientHandshake(client, { identity: who, name: "target-box", hops: 0, expectedServerKey: f.serverIdentity.publicKey, tofu: false });
    expect(hs.paired).toBe(false);
    await expect(client.request("local.approvals.list", {})).resolves.toEqual([]);
    const missing = await refuse(client, "local.approvals.decide", { id: "ap_nope", decision: "deny" });
    expect(missing.code).toBe(MeshErrorCode.not_found);
    // The owner's CLI is not a peer: no pending entry is left for a person to accept.
    expect(await f.pins.pending("target-box")).toBeNull();
    await endLink(client, closed);
  });
});

describe("the owner's CLI over a real attach socket", () => {
  /** A collector instead of the process's streams, with the test's folders in the environment. */
  function collector(env: NodeJS.ProcessEnv) {
    const out: string[] = [];
    const err: string[] = [];
    const io: PeerCliIo = {
      env: { AWUI_CONFIG_DIR: "", AWUI_MESH: "", ...env },
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    };
    return { io, out, err };
  }

  /** The service's own identity in the state folder, so the CLI's handshake pins it exactly. */
  interface ServedFixture {
    stateDir: string;
    root: string;
    rootB: string;
    pins: PinStore;
    queue: ApprovalQueue;
    identity: NodeIdentity;
    listener: ReturnType<typeof startAttachListener>;
  }

  async function serveAttached(): Promise<ServedFixture> {
    const stateDir = await mkdtemp(path.join(tmpdir(), "mesh-appr-cli-"));
    const root = await mkdtemp(path.join(tmpdir(), "mesh-appr-cli-root-"));
    const rootB = await mkdtemp(path.join(tmpdir(), "mesh-appr-cli-root-b-"));
    fixtures.push(stateDir, root, rootB);
    const who = await loadOrCreateIdentity(stateDir);
    const pins = PinStore(path.join(stateDir, "mesh", "pins.json"));
    const queue = new ApprovalQueue();
    const mesh: MeshConfig = { enabled: true, name: "target-box", policies: { worker: { roots: [root, rootB], harnesses: ["fake"] } } };
    const at = path.join(stateDir, "mesh", "attach.sock");
    const listener = startAttachListener({
      path: at,
      log: () => undefined,
      onLink: (link) => {
        void serve({ input: link.input, output: link.output }, {
          identity: who,
          name: "target-box",
          pins,
          audit: new AuditLog(path.join(stateDir, "mesh", "audit.jsonl"), () => undefined),
          registry: { get: () => undefined, available: async () => false },
          config: () => mesh,
          enabled: () => true,
          home: tmpdir(),
          host: new TaskHost({
            chats: new ChatManager(),
            registry: { get: () => undefined, available: async () => false },
            workspace: async (real) => ({ id: "ws", path: real, name: path.basename(real) || real }),
            clock: () => Date.now(),
            detachedTtlHours: () => 24,
            log: () => undefined,
          }),
          approvals: queue,
          origin: "attach",
          log: () => undefined,
        } satisfies ServeDeps);
      },
    });
    return { stateDir, root, rootB, pins, queue, identity: who, listener };
  }

  it("lists, approves for the link, and denies, against a live service", async () => {
    const f = await serveAttached();
    try {
      const env = { AWUI_MESH_SOCKET: path.join(f.stateDir, "mesh", "attach.sock"), AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: f.stateDir };
      // A paired peer link raises the cards; the CLI answers them over the socket.
      const leader = identity();
      await f.pins.setInbound(leader.publicKey, "leader-box", "worker", "accept");
      const link = memoryLink();
      const mesh: MeshConfig = { enabled: true, name: "target-box", policies: { worker: { roots: [f.root, f.rootB], harnesses: ["fake"] } } };
      const served = serve({ input: link.server.input, output: link.server.output }, {
        identity: f.identity,
        name: "target-box",
        pins: f.pins,
        audit: new AuditLog(path.join(f.stateDir, "mesh", "audit.jsonl"), () => undefined),
        registry: { get: () => undefined, available: async () => false },
        config: () => mesh,
        enabled: () => true,
        home: tmpdir(),
        host: new TaskHost({
          chats: new ChatManager(),
          registry: { get: () => undefined, available: async () => false },
          workspace: async (real) => ({ id: "ws", path: real, name: path.basename(real) || real }),
          clock: () => Date.now(),
          detachedTtlHours: () => 24,
          log: () => undefined,
        }),
        approvals: f.queue,
        log: () => undefined,
      });
      const peer = new RpcPeer(link.client.input, link.client.output, { role: "client" });
      peer.start();
      await clientHandshake(peer, { identity: leader, name: "leader-box", hops: 0, expectedServerKey: f.identity.publicKey, tofu: false });
      const write = peer.request("fs.write", writeParams(f.root, "a.txt"));
      const card = await waitFor(() => f.queue.list()[0], "the approval card");

      const list = collector(env);
      expect(await runPeerCli(["approvals"], list.io)).toBe(0);
      expect(list.out.join("\n")).toContain(card.id);
      expect(list.out.join("\n")).toContain("fs.write");
      expect(list.out.join("\n")).toContain("a.txt");
      expect(list.err).toEqual([]);

      const approve = collector(env);
      expect(await runPeerCli(["approve", card.id, "--for-link"], approve.io)).toBe(0);
      expect(approve.out.join("\n")).toContain("link's lifetime");
      await write;
      // The grant answered: the same root again needs no card and no person.
      await peer.request("fs.write", writeParams(f.root, "b.txt"));
      expect(f.queue.list()).toEqual([]);

      // The handler is attached at creation: the denial travels back over the socket
      // while the test awaits the CLI, and a bare promise would read as unhandled.
      const other = refusedAs(peer.request("fs.write", writeParams(f.rootB, "c.txt")));
      const card2 = await waitFor(() => (f.queue.list()[0]?.summary.includes("c.txt") ? f.queue.list()[0] : undefined), "a card in the other root");
      const deny = collector(env);
      expect(await runPeerCli(["deny", card2.id], deny.io)).toBe(0);
      const error = await other;
      expect(error.code).toBe(MeshErrorCode.denied);
      expect(error.message).toContain("denied on the target");
      peer.close();
      await served.closed;
    } finally {
      f.listener.close();
    }
  });

  it("fails clearly when no awui service is running", async () => {
    const stateDir = tempDir("awui-mesh-appr-none-");
    const c = collector({ AWUI_MESH_SOCKET: path.join(stateDir, "nothing.sock"), AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: tempDir("awui-mesh-appr-none2-") });
    expect(await runPeerCli(["approvals"], c.io)).toBe(1);
    expect(c.err.join("\n")).toContain("no running awui service");
  });

  it("answers a stray --for-link with usage on deny, and needs an id", async () => {
    for (const args of [["approve"], ["deny"], ["deny", "ap_x", "--for-link"]]) {
      const c = collector({ AWUI_CONFIG_DIR: meshOnDir(), AWUI_STATE_DIR: tempDir("awui-mesh-appr-u-") });
      expect(await runPeerCli(args, c.io), JSON.stringify(args)).toBe(2);
      expect(c.err.join("\n")).toContain("Usage");
      expect(c.out).toEqual([]);
    }
  });
});
