// The leader's recovery of a dropped link (P1.5 §4): a PeerLiveChat whose task is still
// running on the peer reconnects on the backoff schedule, reattaches with the last seq it
// saw, and the worker replays exactly the missed events — no duplicates, no gaps. A peer
// that cannot answer attach the daemon way (an ephemeral P1 worker, or a task it closed)
// ends the run as P1 did, and a link that never comes back within the window is given up
// on with a fatal, under a fake clock so the whole two-minute shape is exercised in ms.
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ChatConfig } from "../../src/shared/protocol.js";
import type { HarnessEvent } from "../../src/server/harness/types.js";
import { ServerHandshake } from "../../src/server/mesh/handshake.js";
import { loadOrCreateIdentity, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { PeerManager, type PeerManagerDeps, type PeerSpawn } from "../../src/server/mesh/manager.js";
import { PeerLiveChat, type PeerReconnectPlan } from "../../src/server/mesh/peer-adapter.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { memoryLink, type PeerLink } from "../../src/server/mesh/transport.js";
import { tempDir } from "../helpers/app.js";

const REMOTE_TASK = "rt_1";
const CONFIG: ChatConfig = { model: null, thinkingLevel: null, models: [], thinkingLevels: [] };

/**
 * The far side as daemon mode has it: the event buffer and the task outlive every link,
 * and each new link reattaches to the same task. `attach` scripts what task.attach
 * answers; `emit` plays one event into the buffer and onto the link that is live now.
 */
function daemonWorker(identity: NodeIdentity, attach: "ok" | "gap" | "ephemeral" | "not_found" | "denied" = "ok") {
  const buffer: Array<{ seq: number; event: HarnessEvent }> = [];
  const attaches: Array<unknown> = [];
  let nextSeq = 0;
  let live: RpcPeer | null = null;
  let spawns = 0;
  const spawn = (_peerName: string, _link: PeerLink): PeerSpawn => {
    spawns += 1;
    const pair = memoryLink();
    const rpc = new RpcPeer(pair.server.input, pair.server.output, { role: "server" });
    live = rpc;
    const handshake = new ServerHandshake({ identity, name: "worker-box", resolve: async () => ({ paired: true, policy: "worker" }) });
    rpc.onRequest(async (method, params) => {
      const handled = handshake.handle(method, params);
      if (handled !== null) return handled;
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === "task.open") return { remoteTaskId: REMOTE_TASK, config: CONFIG };
      if (method === "task.prompt") return {};
      if (method === "task.attach") {
        attaches.push(p);
        if (attach === "ephemeral") throw new MeshRpcError(MeshErrorCode.method_not_found, `no method "task.attach" is served`, { code: "method_not_found" });
        if (attach === "not_found") throw new MeshRpcError(MeshErrorCode.not_found, `no task "${REMOTE_TASK}" is open here`, { code: "not_found" });
        if (attach === "denied") throw new MeshRpcError(MeshErrorCode.denied, "the policy refuses task.attach", { code: "denied" });
        const afterSeq = typeof p.afterSeq === "number" ? p.afterSeq : 0;
        const missed = buffer.filter((entry) => entry.seq > afterSeq);
        for (const entry of missed) rpc.notify("task.event", { remoteTaskId: REMOTE_TASK, seq: entry.seq, event: entry.event });
        // gap: the buffer does not reach back to what the leader last saw (trimmed).
        return { replayed: missed.length, gap: attach === "gap", state: "running" };
      }
      if (method === "task.history") return [];
      if (method === "task.abort" || method === "task.close") return {};
      throw new MeshRpcError(MeshErrorCode.method_not_found, `no handler answers "${method}"`, { code: "method_not_found" });
    });
    rpc.start();
    return { input: pair.client.input, output: pair.client.output, kill: () => rpc.close("killed by the test") };
  };
  return {
    spawn,
    /** One event into the buffer and onto the link that is up now (the daemon's seq keeps counting). */
    emit(event: HarnessEvent): number {
      nextSeq += 1;
      buffer.push({ seq: nextSeq, event });
      live?.notify("task.event", { remoteTaskId: REMOTE_TASK, seq: nextSeq, event });
      return nextSeq;
    },
    /** Ends the current link, the way a dropped SSH session does. */
    drop(): void {
      live?.close("the link was dropped");
    },
    get spawns() {
      return spawns;
    },
    get attaches() {
      return attaches;
    },
  };
}

/** A real PeerManager over the daemon worker, with the worker's key pinned (what `peer add` leaves). */
async function manager(worker: ReturnType<typeof daemonWorker>, over: { reconnect?: PeerManagerDeps["reconnect"] } = {}) {
  const client = await loadOrCreateIdentity(tempDir("awui-mesh-rc-c-"));
  const m = new PeerManager({
    identity: async () => client,
    pins: PinStore(path.join(tempDir("awui-mesh-rc-pins-"), "pins.json")),
    config: () => ({ enabled: true, peers: [{ name: "lab", docker: "awui-worker-1" }] }),
    enabled: () => true,
    localName: () => "leader-box",
    spawn: worker.spawn,
    ...(over.reconnect !== undefined ? { reconnect: over.reconnect } : {}),
  });
  const first = await m.connect("lab", { tofu: true });
  await m.pin("lab", first.serverKey);
  first.close();
  return m;
}

/** A reconnect plan the tests can afford: 5 ms between attempts, a window long enough to try a few. */
const FAST_PLAN: PeerReconnectPlan = {
  schedule: [5, 5, 10, 10],
  giveUpMs: 5_000,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

async function openLive(m: PeerManager, plan: PeerReconnectPlan = FAST_PLAN): Promise<{ live: PeerLiveChat; connection: Awaited<ReturnType<PeerManager["connect"]>> }> {
  const connection = await m.connect("lab");
  const live = new PeerLiveChat(connection, "lab", REMOTE_TASK, CONFIG, { reconnect: () => m.connect("lab"), plan });
  return { live, connection };
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("a dropped link under an unsettled peer task", () => {
  it("reconnects, reattaches from the last seq seen, and folds the replay without duplicates", async () => {
    const identity = await loadOrCreateIdentity(tempDir("awui-mesh-rc-w-"));
    const worker = daemonWorker(identity);
    const m = await manager(worker);
    const { live } = await openLive(m);
    const seen: HarnessEvent[] = [];
    live.subscribe((event) => seen.push(event));

    worker.emit({ type: "session", nativeId: "native-1" }); // seq 1
    worker.emit({ type: "busy" }); // seq 2
    worker.drop();
    // The run carries on over the fresh link; the leader's reattach replays 1 and 2, then goes live.
    await waitFor(() => worker.spawns >= 2, "the reconnect to come up");
    await waitFor(() => worker.attaches.length >= 1, "the attach to be asked");
    expect(worker.attaches[0]).toMatchObject({ remoteTaskId: REMOTE_TASK, afterSeq: 2 });
    worker.emit({ type: "assistant_end", text: "done", thinking: "" }); // seq 3, live
    worker.emit({ type: "settled" }); // seq 4, live

    await waitFor(() => seen.some((event) => event.type === "settled"), "the run to settle");
    expect(seen.map((event) => event.type)).toEqual(["session", "busy", "notice", "assistant_end", "settled"]);
    // One replayed session, not two: the seq filter absorbed the overlap.
    expect(seen.filter((event) => event.type === "session")).toHaveLength(1);
    const notice = seen[2] as Extract<HarnessEvent, { type: "notice" }>;
    expect(notice.level).toBe("info");
    expect(notice.text).toContain("reconnected to lab");
    await live.dispose();
  });

  it("says events were missed when the peer's buffer does not reach back (gap)", async () => {
    const identity = await loadOrCreateIdentity(tempDir("awui-mesh-rc-w-"));
    const worker = daemonWorker(identity, "gap");
    const m = await manager(worker);
    const { live } = await openLive(m);
    const seen: HarnessEvent[] = [];
    live.subscribe((event) => seen.push(event));

    worker.emit({ type: "session", nativeId: "native-1" });
    worker.emit({ type: "busy" });
    worker.drop();
    worker.emit({ type: "settled" }); // buffered only; nothing replays it (gap)
    await waitFor(() => seen.some((event) => event.type === "notice"), "the gap notice");
    const warning = seen.find((event) => event.type === "notice") as Extract<HarnessEvent, { type: "notice" }>;
    expect(warning.level).toBe("warning");
    expect(warning.text).toMatch(/missed/);
    await live.dispose();
  });

  it("ends the run with fatal and settled against an ephemeral P1 peer that knows no attach", async () => {
    const identity = await loadOrCreateIdentity(tempDir("awui-mesh-rc-w-"));
    const worker = daemonWorker(identity, "ephemeral");
    const m = await manager(worker);
    const { live } = await openLive(m);
    const seen: HarnessEvent[] = [];
    live.subscribe((event) => seen.push(event));

    worker.emit({ type: "session", nativeId: "native-1" });
    worker.drop();
    await waitFor(() => seen.some((event) => event.type === "settled"), "the fatal end");
    expect(seen.map((event) => event.type)).toEqual(["session", "fatal", "settled"]);
    expect(seen[1]).toMatchObject({ type: "fatal" });
    expect((seen[1] as { message: string }).message).toContain("link to lab lost");
    // One reconnect attempt, then the honest end: no retrying what the peer cannot answer.
    // (The pin helper's TOFU contact, the open, and the one attempt.)
    expect(worker.spawns).toBe(3);
    await live.dispose();
  });

  it("ends the run with fatal and settled when the peer no longer holds the task", async () => {
    const identity = await loadOrCreateIdentity(tempDir("awui-mesh-rc-w-"));
    const worker = daemonWorker(identity, "not_found");
    const m = await manager(worker);
    const { live } = await openLive(m);
    const seen: HarnessEvent[] = [];
    live.subscribe((event) => seen.push(event));

    worker.drop();
    await waitFor(() => seen.some((event) => event.type === "settled"), "the fatal end");
    expect(seen.map((event) => event.type)).toEqual(["fatal", "settled"]);
    await live.dispose();
  });

  it("gives up after the reconnect window and ends the run, on a fake clock", async () => {
    const identity = await loadOrCreateIdentity(tempDir("awui-mesh-rc-w-"));
    const worker = daemonWorker(identity, "denied");
    const m = await manager(worker);
    // A window of 100 fake ms over a 10/20 ms schedule: six attempts, then the fatal.
    let clock = 0;
    const plan: PeerReconnectPlan = {
      schedule: [10, 20],
      giveUpMs: 100,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    };
    const { live } = await openLive(m, plan);
    const seen: HarnessEvent[] = [];
    live.subscribe((event) => seen.push(event));

    worker.drop();
    await waitFor(() => seen.some((event) => event.type === "settled"), "the give-up end", 5_000);
    expect(seen.map((event) => event.type)).toEqual(["fatal", "settled"]);
    const fatal = seen[0] as { message: string };
    expect(fatal.message).toMatch(/no reconnection within/);
    expect(worker.spawns).toBe(8); // the helper's tofu link, the open, and six attempts on the schedule
    await live.dispose();
  });

  it("does not reconnect a link lost after the run already settled", async () => {
    const identity = await loadOrCreateIdentity(tempDir("awui-mesh-rc-w-"));
    const worker = daemonWorker(identity);
    const m = await manager(worker);
    const { live } = await openLive(m);
    const seen: HarnessEvent[] = [];
    live.subscribe((event) => seen.push(event));

    worker.emit({ type: "settled" }); // the run ended before the link went
    await waitFor(() => seen.length === 1, "the settled event");
    worker.drop();
    await waitFor(() => seen.length >= 3, "the fatal end");
    expect(seen.map((event) => event.type)).toEqual(["settled", "fatal", "settled"]);
    expect(worker.spawns).toBe(2); // the helper's tofu link and the open; no attempt, no run left to save
    await live.dispose();
  });
});
