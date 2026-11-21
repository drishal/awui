// The daemon-side task host (P1.5 §2): TaskHost plus serve()'s hosted mode,
// one in-process link per test exactly as mesh-serve.test.ts builds them, but
// every link lands on one shared host behind a real ChatManager — so a host
// task is a real chat with a peer owner, and the cases are the spec's: a task
// outlives its link and re-attaches with a replay, a different node id gets
// not_found, the per-peer cap and the idempotency hold across links, the
// detached TTL reaps on an injected clock while a running task keeps running,
// approvals on the target open a task but refuse the wire's answers, "both"
// answers from either side with the first answer winning, and turning the
// mesh off disposes everything the host holds.
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ChatManager } from "../../src/server/chats/manager.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import type { LiveChat, OpenChatRequest } from "../../src/server/harness/types.js";
import { AuditLog } from "../../src/server/mesh/audit.js";
import { clientHandshake } from "../../src/server/mesh/handshake.js";
import { nodeIdOf, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { TaskHost } from "../../src/server/mesh/host.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { serve, type ServeDeps } from "../../src/server/mesh/serve.js";
import { memoryLink } from "../../src/server/mesh/transport.js";
import type { MeshConfig } from "../../src/server/user-config.js";

/** A fresh in-memory identity, the shape loadOrCreateIdentity returns. */
function identity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
  return { publicKey: raw, privateKey, nodeId: nodeIdOf(raw) };
}

/** The fake harness with its opens recorded, so a test can see the delegated flag and hold the live chats. */
class RecordingFake extends FakeAdapter {
  readonly openRequests: OpenChatRequest[] = [];

  override async openChat(req: OpenChatRequest): Promise<LiveChat> {
    this.openRequests.push(req);
    return super.openChat(req);
  }
}

/** One daemon's world: a temp state folder with real pins and audit, a root the worker policy grants, one host over a real ChatManager. */
interface Fixture {
  stateDir: string;
  root: string;
  serverIdentity: NodeIdentity;
  pins: PinStore;
  auditFile: string;
  adapter: RecordingFake;
  manager: ChatManager;
  host: TaskHost;
  mesh: MeshConfig;
  enabled: boolean;
  /** The host's clock, advanced by hand in the TTL test. */
  clock: number;
  ttlHours: number;
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

async function makeFixture(over: { ringMaxEvents?: number } = {}): Promise<Fixture> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "mesh-host-state-"));
  const root = await mkdtemp(path.join(tmpdir(), "mesh-host-root-"));
  fixtures.push(stateDir, root);
  const f: Fixture = {
    stateDir,
    root,
    serverIdentity: identity(),
    pins: PinStore(path.join(stateDir, "mesh", "pins.json")),
    auditFile: path.join(stateDir, "mesh", "audit.jsonl"),
    adapter: new RecordingFake({ chunkDelayMs: 1 }),
    manager: new ChatManager(),
    host: null as unknown as TaskHost,
    // The built-in worker policy, rooted and narrowed to the fake harness.
    mesh: { enabled: true, policies: { worker: { roots: [root], harnesses: ["fake"] } } },
    enabled: true,
    clock: Date.now(),
    ttlHours: 24,
  };
  const registry = {
    get: (id: string) => (id === "fake" ? f.adapter : undefined),
    available: async (id: string) => id === "fake",
  };
  f.host = new TaskHost({
    // The real thing: a host task is a chat the service itself owns, visible in its own UI.
    chats: f.manager,
    registry,
    workspace: async (real) => ({ id: "ws", path: real, name: path.basename(real) || real }),
    clock: () => f.clock,
    detachedTtlHours: () => f.ttlHours,
    ...(over.ringMaxEvents !== undefined ? { ringBounds: { maxEvents: over.ringMaxEvents, maxBytes: 8 * 1024 * 1024 } } : {}),
    log: () => undefined,
  });
  return f;
}

/** One served link against the fixture's host, plus its client end. */
function serveHosted(f: Fixture): { client: RpcPeer; closed: Promise<string> } {
  const link = memoryLink();
  const deps: ServeDeps = {
    identity: f.serverIdentity,
    name: "target-box",
    pins: f.pins,
    audit: new AuditLog(f.auditFile, () => undefined),
    registry: {
      get: (id: string) => (id === "fake" ? f.adapter : undefined),
      available: async (id: string) => id === "fake",
    },
    config: () => f.mesh,
    enabled: () => f.enabled,
    home: tmpdir(),
    host: f.host,
  };
  const { closed } = serve({ input: link.server.input, output: link.server.output }, deps);
  const client = new RpcPeer(link.client.input, link.client.output, { role: "client" });
  client.start();
  return { client, closed };
}

/** A paired identity: the daemon has already accepted this fresh key under this name and policy. */
async function paired(f: Fixture, name = "leader-box", policy = "worker"): Promise<NodeIdentity> {
  const who = identity();
  await f.pins.setInbound(who.publicKey, name, policy, "accept");
  return who;
}

/** A link that completed the signed handshake as `who`. */
async function connectAs(f: Fixture, who: NodeIdentity, name = "leader-box"): Promise<{ client: RpcPeer; closed: Promise<string> }> {
  const { client, closed } = serveHosted(f);
  await clientHandshake(client, { identity: who, name, hops: 0, expectedServerKey: f.serverIdentity.publicKey, tofu: false });
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

interface OpenResult {
  remoteTaskId: string;
  config: { model: string | null; thinkingLevel: string | null; permissionMode?: string | null };
  nativeId: string | null;
}

async function openTask(rpc: RpcPeer, f: Fixture, over: { cwd?: string; clientRequestId?: string } = {}): Promise<OpenResult> {
  return rpc.request<OpenResult>("task.open", {
    clientRequestId: over.clientRequestId ?? `crq-${Math.random().toString(36).slice(2)}`,
    harness: "fake",
    cwd: over.cwd ?? f.root,
    hops: 0,
  });
}

interface TaskEvent {
  remoteTaskId: string;
  seq: number;
  event: { type: string } & Record<string, unknown>;
}

function collectEvents(rpc: RpcPeer): TaskEvent[] {
  const got: TaskEvent[] = [];
  rpc.onNotification((method, params) => {
    if (method === "task.event") got.push(params as TaskEvent);
  });
  return got;
}

interface ListEntry {
  remoteTaskId: string;
  harness: string;
  cwd: string;
  state: string;
  lastSeq: number;
  createdAt: number;
}

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until probe returns a value; the fake harness streams on real timers. */
async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const value = await probe();
    if (value !== undefined) return value;
    await tick(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Ends a link cleanly. */
async function endLink(link: { client: RpcPeer; closed: Promise<string> }): Promise<void> {
  link.client.close();
  await link.closed;
}

/** Ends a test: every link down, then the host and its ChatManager with it. */
async function teardown(f: Fixture, ...links: Array<{ client: RpcPeer; closed: Promise<string> }>): Promise<void> {
  for (const link of links) {
    try {
      link.client.close();
    } catch {
      // Already down.
    }
    await link.closed.catch(() => undefined);
  }
  await f.host.shutdown("test over");
  await f.manager.shutdown();
}

const HOUR = 3_600_000;

describe("host tasks outlive their link", () => {
  it("opens a real delegated chat with the peer as its owner, and it survives the link that opened it", async () => {
    const f = await makeFixture();
    const who = await paired(f);
    const a = await connectAs(f, who);
    const events = collectEvents(a.client);
    const opened = await openTask(a.client, f, { clientRequestId: "crq-1" });
    expect(opened.config.permissionMode).toBe("acceptEdits");
    expect(opened.nativeId).toBeTruthy();
    // A real chat: created through the manager, delegated, owned by the peer's node id.
    expect(f.adapter.openRequests).toEqual([{ cwd: await realpath(f.root), delegated: true }]);
    const chat = f.manager.list()[0]!;
    expect(chat.owner).toEqual({ kind: "peer", peerId: who.nodeId, peerName: "leader-box", remoteTaskId: opened.remoteTaskId });
    await a.client.request("task.prompt", { remoteTaskId: opened.remoteTaskId, text: "hello over the mesh", mode: "prompt" });
    await waitFor(() => (events.some((e) => e.event.type === "settled") ? true : undefined), "the run to settle");
    // Closing the link detaches; the chat behind the task lives on.
    await endLink(a);
    expect(f.manager.list()[0]!.status).not.toBe("disposed");
    // A later link with the same node id drives the same task without opening a second chat.
    const b = await connectAs(f, who);
    await b.client.request("task.prompt", { remoteTaskId: opened.remoteTaskId, text: "still here", mode: "prompt" });
    await waitFor(() => (f.manager.list()[0]!.status === "idle" ? true : undefined), "the second run to settle");
    expect(f.adapter.openRequests.length).toBe(1);
    await teardown(f, b);
  });

  it("re-attaches with a replay past afterSeq, then streams live; the ring's seqs are consecutive", async () => {
    const f = await makeFixture();
    const who = await paired(f);
    const a = await connectAs(f, who);
    const eventsA = collectEvents(a.client);
    const opened = await openTask(a.client, f, { clientRequestId: "crq-1" });
    await a.client.request("task.prompt", { remoteTaskId: opened.remoteTaskId, text: "hello over the mesh", mode: "prompt" });
    await waitFor(() => (eventsA.some((e) => e.event.type === "settled") ? true : undefined), "the run to settle");
    const seen = eventsA.filter((e) => e.remoteTaskId === opened.remoteTaskId).map((e) => e.seq);
    expect(seen).toEqual(seen.map((_, i) => i + 1));
    await endLink(a);
    const b = await connectAs(f, who);
    const eventsB = collectEvents(b.client);
    const attached = await b.client.request<{ replayed: number; gap: boolean; state: string }>("task.attach", {
      remoteTaskId: opened.remoteTaskId,
      afterSeq: 0,
    });
    expect(attached.gap).toBe(false);
    expect(attached.state).toBe("idle");
    await waitFor(() => (eventsB.length >= attached.replayed ? true : undefined), "the replay to arrive");
    // Everything the first link saw, in order, before anything new.
    expect(eventsB.map((e) => e.seq)).toEqual(seen);
    await b.client.request("task.prompt", { remoteTaskId: opened.remoteTaskId, text: "one more", mode: "prompt" });
    await waitFor(() => (eventsB.some((e) => e.event.type === "settled" && e.seq > seen.length) ? true : undefined), "the live run to settle");
    const seqs = eventsB.map((e) => e.seq);
    expect(seqs.length).toBe(new Set(seqs).size);
    // task.list names this peer's live tasks, and nothing else.
    const listed = await b.client.request<ListEntry[]>("task.list", {});
    expect(listed).toEqual([
      { remoteTaskId: opened.remoteTaskId, harness: "fake", cwd: await realpath(f.root), state: "idle", lastSeq: expect.any(Number), createdAt: expect.any(Number) },
    ]);
    await teardown(f, b);
  });

  it("flags a gap when afterSeq is older than the ring, and task.history still tells the whole story", async () => {
    const f = await makeFixture({ ringMaxEvents: 3 });
    const who = await paired(f);
    const a = await connectAs(f, who);
    const events = collectEvents(a.client);
    const opened = await openTask(a.client, f, { clientRequestId: "crq-1" });
    await a.client.request("task.prompt", { remoteTaskId: opened.remoteTaskId, text: "hello over the mesh", mode: "prompt" });
    await waitFor(() => (events.some((e) => e.event.type === "settled") ? true : undefined), "the run to settle");
    await endLink(a);
    const b = await connectAs(f, who);
    const attached = await b.client.request<{ replayed: number; gap: boolean }>("task.attach", { remoteTaskId: opened.remoteTaskId, afterSeq: 0 });
    // The ring (3 events here) no longer holds the first events, so the leader must refresh from history.
    expect(attached.gap).toBe(true);
    expect(attached.replayed).toBe(3);
    // And the history still carries what the ring dropped: the whole turn, prompt and answer.
    const history = await b.client.request<Array<{ kind: string }>>("task.history", { remoteTaskId: opened.remoteTaskId });
    expect(history.map((item) => item.kind)).toEqual(expect.arrayContaining(["user", "assistant"]));
    await teardown(f, b);
  });

  it("answers not_found for a different node id, and lists it nothing", async () => {
    const f = await makeFixture();
    const who = await paired(f);
    const other = await paired(f, "other-box");
    const a = await connectAs(f, who);
    const opened = await openTask(a.client, f, { clientRequestId: "crq-1" });
    const b = await connectAs(f, other, "other-box");
    const prompt = await refuse(b.client, "task.prompt", { remoteTaskId: opened.remoteTaskId, text: "mine now", mode: "prompt" });
    expect(prompt.code).toBe(MeshErrorCode.not_found);
    const attach = await refuse(b.client, "task.attach", { remoteTaskId: opened.remoteTaskId, afterSeq: 0 });
    expect(attach.code).toBe(MeshErrorCode.not_found);
    const history = await refuse(b.client, "task.history", { remoteTaskId: opened.remoteTaskId });
    expect(history.code).toBe(MeshErrorCode.not_found);
    const close = await refuse(b.client, "task.close", { remoteTaskId: opened.remoteTaskId });
    expect(close.code).toBe(MeshErrorCode.not_found);
    await expect(b.client.request("task.list", {})).resolves.toEqual([]);
    // The owner's link is untouched by all that probing.
    expect(f.manager.list().length).toBe(1);
    await teardown(f, a, b);
  });
});

describe("the host's bounds", () => {
  it("caps live tasks per peer across links, and closing one frees the slot", async () => {
    const f = await makeFixture();
    f.mesh = { enabled: true, policies: { worker: { roots: [f.root], harnesses: ["fake"], max_tasks: 1 } } };
    const who = await paired(f);
    const a = await connectAs(f, who);
    await openTask(a.client, f, { clientRequestId: "crq-1" });
    // A SECOND link of the same peer: the cap is per node id now, not per link.
    const b = await connectAs(f, who);
    const refused = await refuse(b.client, "task.open", { clientRequestId: "crq-2", harness: "fake", cwd: f.root, hops: 0 });
    expect(refused.code).toBe(MeshErrorCode.limit);
    await a.client.request("task.close", { remoteTaskId: (await f.host.list(who.nodeId))[0]!.remoteTaskId });
    const reopened = await openTask(b.client, f, { clientRequestId: "crq-2" });
    expect(reopened.remoteTaskId).toMatch(/^rt_/);
    await teardown(f, a, b);
  });

  it("answers a retried clientRequestId with the same task, from a new link", async () => {
    const f = await makeFixture();
    const who = await paired(f);
    const a = await connectAs(f, who);
    const first = await openTask(a.client, f, { clientRequestId: "crq-same" });
    await endLink(a);
    // The retry arrives over a link that never saw the first open: host-wide idempotency, not per-link.
    const b = await connectAs(f, who);
    const second = await openTask(b.client, f, { clientRequestId: "crq-same" });
    expect(second.remoteTaskId).toBe(first.remoteTaskId);
    expect(f.adapter.openRequests.length).toBe(1);
    await teardown(f, b);
  });
});

describe("the detached TTL", () => {
  it("reaps a detached settled task past the TTL, and keeps a detached running task running", async () => {
    const f = await makeFixture();
    const who = await paired(f);
    const a = await connectAs(f, who);
    const events = collectEvents(a.client);
    const settled = await openTask(a.client, f, { clientRequestId: "crq-settled" });
    await a.client.request("task.prompt", { remoteTaskId: settled.remoteTaskId, text: "hello over the mesh", mode: "prompt" });
    await waitFor(() => (events.some((e) => e.remoteTaskId === settled.remoteTaskId && e.event.type === "settled") ? true : undefined), "the first run to settle");
    const asking = await openTask(a.client, f, { clientRequestId: "crq-asking" });
    await a.client.request("task.prompt", { remoteTaskId: asking.remoteTaskId, text: "please ask before reading", mode: "prompt" });
    await waitFor(() => (events.some((e) => e.remoteTaskId === asking.remoteTaskId && e.event.type === "request") ? true : undefined), "the pending request");
    await endLink(a);
    f.clock += 12 * HOUR;
    await f.host.reap();
    expect(f.host.list(who.nodeId).length).toBe(2);
    // Past the TTL: the settled task goes, the one still holding an unanswered request stays.
    f.clock += 13 * HOUR;
    await f.host.reap();
    const left = f.host.list(who.nodeId);
    expect(left.map((t) => t.remoteTaskId)).toEqual([asking.remoteTaskId]);
    expect(left[0]!.state).toBe("running");
    const chat = f.manager.list()[0]!;
    expect(chat.pendingCount).toBe(1);
    await teardown(f);
  });
});

describe("approvals in daemon mode", () => {
  it("opens under approvals_at target, shows the request in the target's own UI, and refuses the wire's answer", async () => {
    const f = await makeFixture();
    f.mesh = { enabled: true, policies: { worker: { roots: [f.root], harnesses: ["fake"], approvals_at: "target" } } };
    const who = await paired(f);
    const a = await connectAs(f, who);
    const events = collectEvents(a.client);
    // The P1 refusal is lifted: the chat is a real chat here, so its request is answerable here.
    const opened = await openTask(a.client, f, { clientRequestId: "crq-1" });
    await a.client.request("task.prompt", { remoteTaskId: opened.remoteTaskId, text: "please ask before reading", mode: "prompt" });
    const event = await waitFor(() => events.find((e) => e.event.type === "request"), "a pending request");
    // The request landed on the target's own chat: its UI answers it, not the peer.
    const chat = f.manager.list()[0]!;
    expect(chat.pendingCount).toBe(1);
    const denied = await refuse(a.client, "task.answer", {
      remoteTaskId: opened.remoteTaskId,
      requestId: (event.event as unknown as { request: { id: string } }).request.id,
      answer: { kind: "confirm", confirmed: true },
    });
    expect(denied.code).toBe(MeshErrorCode.denied);
    expect(denied.message).toContain("target");
    await teardown(f, a);
  });

  it("answers under approvals_at both from either side, and the first answer wins", async () => {
    const f = await makeFixture();
    f.mesh = { enabled: true, policies: { worker: { roots: [f.root], harnesses: ["fake"], approvals_at: "both" } } };
    const who = await paired(f);
    const a = await connectAs(f, who);
    const events = collectEvents(a.client);
    const chatOf = (remoteTaskId: string) => f.manager.list().find((c) => c.owner?.kind === "peer" && c.owner.remoteTaskId === remoteTaskId)!;

    // The target's own UI answers first; the peer's answer then finds nothing pending.
    const targetFirst = await openTask(a.client, f, { clientRequestId: "crq-1" });
    await a.client.request("task.prompt", { remoteTaskId: targetFirst.remoteTaskId, text: "please ask before reading", mode: "prompt" });
    const firstRequest = await waitFor(() => events.find((e) => e.remoteTaskId === targetFirst.remoteTaskId && e.event.type === "request"), "the first request");
    const firstId = (firstRequest.event as unknown as { request: { id: string } }).request.id;
    chatOf(targetFirst.remoteTaskId).answer(firstId, { kind: "confirm", confirmed: true });
    const late = await refuse(a.client, "task.answer", { remoteTaskId: targetFirst.remoteTaskId, requestId: firstId, answer: { kind: "confirm", confirmed: true } });
    expect(late.code).toBe(MeshErrorCode.not_found);

    // And the other way around: the peer answers, and the target's own answer is refused.
    const peerFirst = await openTask(a.client, f, { clientRequestId: "crq-2" });
    await a.client.request("task.prompt", { remoteTaskId: peerFirst.remoteTaskId, text: "please ask before reading", mode: "prompt" });
    const secondRequest = await waitFor(() => events.find((e) => e.remoteTaskId === peerFirst.remoteTaskId && e.event.type === "request"), "the second request");
    const secondId = (secondRequest.event as unknown as { request: { id: string } }).request.id;
    await expect(a.client.request("task.answer", { remoteTaskId: peerFirst.remoteTaskId, requestId: secondId, answer: { kind: "confirm", confirmed: true } })).resolves.toEqual({ answered: true });
    expect(() => chatOf(peerFirst.remoteTaskId).answer(secondId, { kind: "confirm", confirmed: true })).toThrow(/already answered/i);
    await teardown(f, a);
  });
});

describe("turning the mesh off", () => {
  it("closes the link and disposes every host task with it", async () => {
    const f = await makeFixture();
    const who = await paired(f);
    const a = await connectAs(f, who);
    const opened = await openTask(a.client, f, { clientRequestId: "crq-1" });
    await a.client.request("task.prompt", { remoteTaskId: opened.remoteTaskId, text: "hello over the mesh", mode: "prompt" });
    f.enabled = false;
    const off = await refuse(a.client, "peer.ping", {});
    expect(off.code).toBe(MeshErrorCode.mesh_off);
    await a.closed;
    // Off is off for the whole node: the host's chats are disposed, and a later link finds nothing.
    await waitFor(() => (f.manager.list().length === 0 ? true : undefined), "the host's tasks to be disposed");
    expect(f.host.list(who.nodeId)).toEqual([]);
    f.enabled = true;
    const b = await connectAs(f, who);
    const gone = await refuse(b.client, "task.attach", { remoteTaskId: opened.remoteTaskId, afterSeq: 0 });
    expect(gone.code).toBe(MeshErrorCode.not_found);
    await teardown(f, b);
  });
});
