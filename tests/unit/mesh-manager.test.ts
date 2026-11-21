// The mesh leader's link manager (P1): one live connection per configured peer,
// spawned through an injectable transport and brought up through the signed
// handshake. These tests drive the manager against a hand-written minimal worker
// — a real RpcPeer in the server role with the real ServerHandshake — over an
// in-process memory link, so the only thing not exercised is the ssh/docker
// child itself. The pin rules (TOFU is explicit, a pin is always enforced, an
// unpinned worker is not paired until a person accepts it) are the security
// core, so each refusal is asserted by its message.
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MeshConfig } from "../../src/server/user-config.js";
import { ServerHandshake } from "../../src/server/mesh/handshake.js";
import { loadOrCreateIdentity, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { PeerManager, type PeerSpawn } from "../../src/server/mesh/manager.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { memoryLink, type PeerLink } from "../../src/server/mesh/transport.js";
import { tempDir } from "../helpers/app.js";

/** One worker identity per test pair, created once and shared across links (a real node's key is). */
async function identities(): Promise<{ client: NodeIdentity; worker: NodeIdentity }> {
  return { client: await loadOrCreateIdentity(tempDir("awui-mesh-c-")), worker: await loadOrCreateIdentity(tempDir("awui-mesh-w-")) };
}

/**
 * The far side of a link, as the leader sees it: the real server handshake with a
 * scripted pairing verdict, and nothing else but ping. Each spawn wires a fresh
 * RpcPeer to the same worker identity, so a re-pinned peer reconnects as itself.
 */
function fakeWorker(opts: { identity: NodeIdentity; name: string; paired: boolean; policy?: string; onRequest?: (method: string, params: unknown) => Promise<unknown> }) {
  let spawns = 0;
  const spawn = () => {
    spawns += 1;
    const pair = memoryLink();
    const rpc = new RpcPeer(pair.server.input, pair.server.output, { role: "server" });
    const handshake = new ServerHandshake({
      identity: opts.identity,
      name: opts.name,
      resolve: async () => ({ paired: opts.paired, policy: opts.policy ?? "worker" }),
    });
    rpc.onRequest(async (method, params) => {
      const handled = handshake.handle(method, params);
      if (handled !== null) return handled;
      if (method === "peer.ping") return {};
      if (opts.onRequest) {
        const extra = await opts.onRequest(method, params);
        if (extra !== undefined) return extra;
      }
      throw new MeshRpcError(MeshErrorCode.method_not_found, `no handler answers "${method}"`, { code: "method_not_found" });
    });
    rpc.start();
    return { pair, rpc };
  };
  return {
    spawn: (_peerName: string, _link: PeerLink): PeerSpawn => {
      const { pair, rpc } = spawn();
      return { input: pair.client.input, output: pair.client.output, kill: () => rpc.close("killed by the test") };
    },
    get spawns() {
      return spawns;
    },
  };
}

/** A manager over one config.yml `mesh:` block, a pin file, and the given worker. */
function manager(
  keys: { client: NodeIdentity },
  worker: { spawn: (peerName: string, link: PeerLink) => PeerSpawn },
  extra: { config?: () => MeshConfig | undefined; enabled?: () => boolean } = {},
) {
  const pins = PinStore(path.join(tempDir("awui-mesh-pins-"), "pins.json"));
  return new PeerManager({
    identity: async () => keys.client,
    pins,
    config: extra.config ?? (() => ({ enabled: true, peers: [{ name: "lab", docker: "awui-worker-1" }, { name: "ci", ssh: "ci@ci-box" }] })),
    enabled: extra.enabled ?? (() => true),
    localName: () => "leader-box",
    spawn: worker.spawn,
  });
}

/** The worker's key as the pins file will hold it: raw 32 bytes. */
const keyOf = (identity: NodeIdentity) => identity.publicKey;

describe("PeerManager", () => {
  it("lists the configured inventory without starting a link", async () => {
    const keys = await identities();
    const worker = fakeWorker({ identity: keys.worker, name: "worker-box", paired: true });
    const m = manager(keys, worker);
    expect(m.peers()).toEqual([
      { name: "lab", kind: "docker", pinned: false },
      { name: "ci", kind: "ssh", pinned: false },
    ]);
    // A pinned peer is named as one: the flag follows the pin, never the network.
    await m.pin("lab", keyOf(keys.worker));
    expect(m.peers().find((p) => p.name === "lab")?.pinned).toBe(true);
    expect(worker.spawns).toBe(0);
  });

  it("connects through tofu, pins the key, and reconnects with the pin enforced", async () => {
    const keys = await identities();
    const worker = fakeWorker({ identity: keys.worker, name: "worker-box", paired: true });
    const m = manager(keys, worker);

    const first = await m.connect("lab", { tofu: true });
    expect(first.serverKey.equals(keyOf(keys.worker))).toBe(true);
    expect(first.paired).toBe(true);
    expect(first.policy).toBe("worker");
    expect(first.sas).toMatch(/^\d{3} \d{3}$/);
    // TOFU contact is not trust: the pin is what the next plain connect holds the worker to.
    await m.pin("lab", first.serverKey);
    first.close();

    const second = await m.connect("lab");
    expect(second.serverKey.equals(keyOf(keys.worker))).toBe(true);
    expect(worker.spawns).toBe(2);
    second.close();
  });

  it("refuses an unpinned peer without tofu", async () => {
    const keys = await identities();
    const worker = fakeWorker({ identity: keys.worker, name: "worker-box", paired: true });
    const m = manager(keys, worker);
    await expect(m.connect("lab")).rejects.toThrow(/no pinned key, and TOFU is not enabled/);
  });

  it("refuses a worker whose key is not the pinned one", async () => {
    const keys = await identities();
    const stranger = await loadOrCreateIdentity(tempDir("awui-mesh-s-"));
    const worker = fakeWorker({ identity: keys.worker, name: "worker-box", paired: true });
    const m = manager(keys, worker);
    // The pin names another machine entirely: the link is closed, never continued.
    await m.pin("lab", stranger.publicKey);
    await expect(m.connect("lab")).rejects.toThrow(/does not match the pinned key/);
    expect(worker.spawns).toBe(1);
  });

  it("refuses an unpaired worker with the command that pairs it", async () => {
    const keys = await identities();
    const worker = fakeWorker({ identity: keys.worker, name: "worker-box", paired: false });
    const m = manager(keys, worker);
    // First contact under TOFU records the key (and reports the pairing verdict) without failing.
    const first = await m.connect("lab", { tofu: true });
    expect(first.paired).toBe(false);
    await m.pin("lab", first.serverKey);
    first.close();
    // A pinned but unaccepted worker is refused, and the error says what to run on the target.
    await expect(m.connect("lab")).rejects.toThrow(/awui peer accept leader-box --policy worker/);
  });

  it("shares one in-flight connect between concurrent callers", async () => {
    const keys = await identities();
    const worker = fakeWorker({ identity: keys.worker, name: "worker-box", paired: true });
    const m = manager(keys, worker);
    await m.pin("lab", keyOf(keys.worker));
    const [a, b] = await Promise.all([m.connect("lab"), m.connect("lab")]);
    expect(a).toBe(b);
    expect(worker.spawns).toBe(1);
    a.close();
  });

  it("forgets the connection when the link is lost, and reconnects on the next use", async () => {
    const keys = await identities();
    const worker = fakeWorker({ identity: keys.worker, name: "worker-box", paired: true });
    const m = manager(keys, worker);
    await m.pin("lab", keyOf(keys.worker));
    const first = await m.connect("lab");
    let lost = false;
    first.onClose(() => {
      lost = true;
    });
    first.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(lost).toBe(true);
    const second = await m.connect("lab");
    expect(second).not.toBe(first);
    expect(worker.spawns).toBe(2);
    second.close();
  });

  it("refuses to connect while the mesh is off, or to a peer that is not configured", async () => {
    const keys = await identities();
    const worker = fakeWorker({ identity: keys.worker, name: "worker-box", paired: true });
    const off = manager(keys, worker, { enabled: () => false });
    await expect(off.connect("lab")).rejects.toThrow(/mesh is turned off/);
    const on = manager(keys, worker);
    await expect(on.connect("nope")).rejects.toThrow(/No mesh peer called "nope"/);
    expect(worker.spawns).toBe(0);
  });

  it("answers peer.info from the far side", async () => {
    const keys = await identities();
    const worker = fakeWorker({
      identity: keys.worker,
      name: "worker-box",
      paired: true,
      onRequest: async (method) => (method === "peer.info" ? { name: "worker-box", roots: [], harnesses: ["fake"] } : undefined),
    });
    const m = manager(keys, worker);
    const conn = await m.connect("lab", { tofu: true });
    await expect(conn.info()).resolves.toMatchObject({ name: "worker-box" });
    conn.close();
  });
});
