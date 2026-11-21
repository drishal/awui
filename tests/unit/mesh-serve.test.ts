// The worker end of the mesh (serve.ts): one in-process link per test — a
// memoryLink pair, a real client RpcPeer with a real signed handshake, real
// identities, a real PinStore and AuditLog in a temp state folder, and the
// fake harness behind a minimal registry stub. Every rule the worker enforces
// gets its own test: the mesh-off refusal at hello, the unpaired floor with
// its pending entry, the paired happy path with a live event stream, each
// task.open refusal in the spec's order, a mid-link revocation and a config
// edit, forced-command TOFU and its pin mismatch, disposal on link close, and
// audit lines that carry lengths, never the prompt's words.
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import type { HarnessRegistry } from "../../src/server/harness/registry.js";
import type { LiveChat, OpenChatRequest } from "../../src/server/harness/types.js";
import { AuditLog } from "../../src/server/mesh/audit.js";
import { clientHandshake } from "../../src/server/mesh/handshake.js";
import { nodeIdOf, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { permissionModeFor, serve, type ServeDeps } from "../../src/server/mesh/serve.js";
import { memoryLink } from "../../src/server/mesh/transport.js";
import type { MeshConfig } from "../../src/server/user-config.js";

/** A fresh in-memory identity, the shape loadOrCreateIdentity returns. */
function identity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
  return { publicKey: raw, privateKey, nodeId: nodeIdOf(raw) };
}

/** The fake harness with its opens recorded, so a test can see the delegated flags and hold the live chats. */
class RecordingFake extends FakeAdapter {
  readonly openedChats: LiveChat[] = [];
  readonly openRequests: OpenChatRequest[] = [];

  override async openChat(req: OpenChatRequest): Promise<LiveChat> {
    this.openRequests.push(req);
    const live = await super.openChat(req);
    this.openedChats.push(live);
    return live;
  }
}

/** One worker's world: a temp state folder with real pins and audit, a root the worker policy grants, mutable mesh config. */
interface Fixture {
  stateDir: string;
  root: string;
  outside: string;
  serverIdentity: NodeIdentity;
  pins: PinStore;
  auditFile: string;
  adapter: RecordingFake;
  mesh: MeshConfig;
  enabled: boolean;
  forced?: { policy: string; peer: string };
}

const fixtures: string[] = [];
afterAll(async () => {
  await Promise.all(fixtures.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeFixture(): Promise<Fixture> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "mesh-serve-state-"));
  const root = await mkdtemp(path.join(tmpdir(), "mesh-serve-root-"));
  const outside = await mkdtemp(path.join(tmpdir(), "mesh-serve-out-"));
  fixtures.push(stateDir, root, outside);
  return {
    stateDir,
    root,
    outside,
    serverIdentity: identity(),
    pins: PinStore(path.join(stateDir, "mesh", "pins.json")),
    auditFile: path.join(stateDir, "mesh", "audit.jsonl"),
    adapter: new RecordingFake({ chunkDelayMs: 1 }),
    // The built-in worker policy, rooted and narrowed to the fake harness.
    mesh: { enabled: true, policies: { worker: { roots: [root], harnesses: ["fake"] } } },
    enabled: true,
  };
}

/** One served link and its client end, against the fixture's identity, pins, audit, and registry stub. */
function serveLink(f: Fixture): { client: RpcPeer; closed: Promise<string> } {
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
    ...(f.forced !== undefined ? { forced: f.forced } : {}),
  };
  const { closed } = serve({ input: link.server.input, output: link.server.output }, deps);
  const client = new RpcPeer(link.client.input, link.client.output, { role: "client" });
  client.start();
  return { client, closed };
}

/** A client that completed the signed handshake; its name and key are the fixture's to know. */
async function connect(f: Fixture, who: NodeIdentity, name = "leader-box"): Promise<{ client: RpcPeer; closed: Promise<string> }> {
  const { client, closed } = serveLink(f);
  await clientHandshake(client, { identity: who, name, hops: 0, expectedServerKey: f.serverIdentity.publicKey, tofu: false });
  return { client, closed };
}

/** A paired client: the worker has already accepted this fresh key under this name and policy. */
async function connectPaired(f: Fixture, policy = "worker", name = "leader-box"): Promise<{ client: RpcPeer; closed: Promise<string> }> {
  const who = identity();
  await f.pins.setInbound(who.publicKey, name, policy, "accept");
  const end = await connect(f, who, name);
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

interface OpenResult {
  remoteTaskId: string;
  config: { model: string | null; thinkingLevel: string | null; permissionMode?: string | null };
}

async function openTask(rpc: RpcPeer, f: Fixture, over: { cwd?: string; harness?: string; hops?: number; clientRequestId?: string } = {}): Promise<OpenResult> {
  return rpc.request<OpenResult>("task.open", {
    clientRequestId: over.clientRequestId ?? `crq-${Math.random().toString(36).slice(2)}`,
    harness: over.harness ?? "fake",
    cwd: over.cwd ?? f.root,
    hops: over.hops ?? 0,
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

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until probe returns a value; the fake harness streams on real timers, and audit writes land behind the answer. */
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

describe("the mesh switch and pairing", () => {
  it("refuses the very first hello when the mesh is off, and closes the link", async () => {
    const f = await makeFixture();
    f.enabled = false;
    const { client, closed } = serveLink(f);
    const error = await clientHandshake(client, { identity: identity(), name: "leader-box", hops: 0, expectedServerKey: f.serverIdentity.publicKey, tofu: false }).then(
      () => {
        throw new Error("expected a refusal");
      },
      (e) => e as MeshRpcError,
    );
    expect(error).toBeInstanceOf(MeshRpcError);
    expect(error.code).toBe(MeshErrorCode.mesh_off);
    expect(error.data).toEqual({ code: "mesh_off" });
    await closed;
  });

  it("closes the link after a bad auth signature, and after a method sent before the handshake", async () => {
    const f = await makeFixture();
    const a = serveLink(f);
    const who = identity();
    await a.client.request("peer.hello", { v: 1, name: "leader-box", publicKey: who.publicKey.toString("base64url"), nonce: Buffer.alloc(32, 7).toString("base64url"), hops: 0 });
    const bad = await refuse(a.client, "peer.auth", { sig: Buffer.alloc(64, 1).toString("base64url") });
    expect(bad.code).toBe(MeshErrorCode.invalid_request);
    expect(await a.closed).toContain("handshake failed");

    const b = serveLink(f);
    const early = await refuse(b.client, "peer.info", {});
    expect(early.code).toBe(MeshErrorCode.not_paired);
    expect(await b.closed).toContain("before the handshake");
  });

  it("serves an unpaired client only ping, records it once as pending, and refuses everything else with not_paired", async () => {
    const f = await makeFixture();
    const who = identity();
    const { client, closed } = serveLink(f);
    const hs = await clientHandshake(client, { identity: who, name: "stranger", hops: 0, expectedServerKey: f.serverIdentity.publicKey, tofu: false });
    expect(hs.paired).toBe(false);
    expect(hs.policy).toBe("none");
    await expect(client.request("peer.ping", {})).resolves.toEqual({});
    const info = await refuse(client, "peer.info", {});
    expect(info.code).toBe(MeshErrorCode.not_paired);
    const open = await refuse(client, "task.open", { clientRequestId: "crq-1", harness: "fake", cwd: f.root, hops: 0 });
    expect(open.code).toBe(MeshErrorCode.not_paired);
    const pending = await f.pins.pending("stranger");
    expect(pending?.publicKey).toEqual(who.publicKey);
    await endLink(client, closed);
  });
});

describe("a paired worker link", () => {
  it("answers peer.info with the policy's shape and runs a task end to end", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f);
    const info = await client.request<{ name: string; nodeId: string; harnesses: string[]; roots: string[]; ceiling: string; approvalsAt: string; maxTasks: number }>("peer.info", {});
    expect(info).toEqual({
      name: "target-box",
      nodeId: f.serverIdentity.nodeId,
      harnesses: ["fake"],
      roots: [f.root],
      ceiling: "auto-edit",
      approvalsAt: "origin",
      maxTasks: 4,
    });
    const events = collectEvents(client);
    const opened = await openTask(client, f);
    expect(opened.remoteTaskId).toMatch(/^rt_[0-9a-f]{12}$/);
    // The ceiling the worker policy grants maps the fake harness to acceptEdits, and it was set.
    expect(opened.config.permissionMode).toBe("acceptEdits");
    // The chat is a real delegated session with no orchestration env at all: max_hops 1 is structural.
    expect(f.adapter.openRequests).toEqual([{ cwd: await realpath(f.root), delegated: true }]);
    await client.request("task.prompt", { remoteTaskId: opened.remoteTaskId, text: "hello over the mesh", mode: "prompt" });
    await waitFor(() => (events.some((e) => e.event.type === "settled") ? true : undefined), "the run to settle");
    const seqs = events.filter((e) => e.remoteTaskId === opened.remoteTaskId).map((e) => e.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1));
    expect(events.some((e) => e.event.type === "user_message")).toBe(true);
    const history = await client.request<unknown[]>("task.history", { remoteTaskId: opened.remoteTaskId });
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThan(0);
    await endLink(client, closed);
  });

  it("refuses a cwd outside the roots, one that climbs with .., and one behind a symlink that leaves the root", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f);
    const outside = await refuse(client, "task.open", { clientRequestId: "c1", harness: "fake", cwd: f.outside, hops: 0 });
    expect(outside.code).toBe(MeshErrorCode.denied);
    // A literal ".." segment, un-folded, so the guard that refuses it before any resolution sees it.
    const climb = await refuse(client, "task.open", { clientRequestId: "c2", harness: "fake", cwd: `${f.root}/../elsewhere`, hops: 0 });
    expect(climb.code).toBe(MeshErrorCode.denied);
    expect(climb.message).toContain("..");
    await symlink(f.outside, path.join(f.root, "escape"));
    const linked = await refuse(client, "task.open", { clientRequestId: "c3", harness: "fake", cwd: path.join(f.root, "escape"), hops: 0 });
    expect(linked.code).toBe(MeshErrorCode.denied);
    const missing = await refuse(client, "task.open", { clientRequestId: "c4", harness: "fake", cwd: path.join(f.root, "not-there"), hops: 0 });
    expect(missing.code).toBe(MeshErrorCode.denied);
    expect(missing.message).toContain("existing directory");
    expect(f.adapter.openedChats.length).toBe(0);
    await endLink(client, closed);
  });

  it("refuses a harness outside the policy's allowlist, and one the node does not serve", async () => {
    const f = await makeFixture();
    f.mesh = { enabled: true, policies: { worker: { roots: [f.root], harnesses: ["fake", "pi"] } } };
    const { client, closed } = await connectPaired(f);
    const notAllowed = await refuse(client, "task.open", { clientRequestId: "c1", harness: "codex", cwd: f.root, hops: 0 });
    expect(notAllowed.code).toBe(MeshErrorCode.denied);
    expect(notAllowed.message).toContain("codex");
    // Allowed by the policy but not registered here: still denied, never a silent empty task.
    const notServed = await refuse(client, "task.open", { clientRequestId: "c2", harness: "pi", cwd: f.root, hops: 0 });
    expect(notServed.code).toBe(MeshErrorCode.denied);
    expect(notServed.message).toContain("registered");
    await endLink(client, closed);
  });

  it("refuses a request that already hopped once", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f);
    const error = await refuse(client, "task.open", { clientRequestId: "c1", harness: "fake", cwd: f.root, hops: 1 });
    expect(error.code).toBe(MeshErrorCode.hop_limit);
    await endLink(client, closed);
  });

  it("answers needs_approval when the policy only asks for the cap (the built-in peer policy)", async () => {
    const f = await makeFixture();
    f.mesh = { enabled: true, policies: { peer: { roots: [f.root], harnesses: ["fake"] } } };
    const { client, closed } = await connectPaired(f, "peer");
    const error = await refuse(client, "task.open", { clientRequestId: "c1", harness: "fake", cwd: f.root, hops: 0 });
    expect(error.code).toBe(MeshErrorCode.needs_approval);
    expect(error.data).toEqual({ code: "needs_approval" });
    await endLink(client, closed);
  });

  it("answers needs_approval when the policy's approvals sit on the target", async () => {
    const f = await makeFixture();
    f.mesh = { enabled: true, policies: { worker: { roots: [f.root], harnesses: ["fake"], approvals_at: "target" } } };
    const { client, closed } = await connectPaired(f, "worker");
    const error = await refuse(client, "task.open", { clientRequestId: "c1", harness: "fake", cwd: f.root, hops: 0 });
    expect(error.code).toBe(MeshErrorCode.needs_approval);
    expect(error.message).toContain("target");
    await endLink(client, closed);
  });

  it("answers limit when the peer already holds the policy's maxTasks live tasks", async () => {
    const f = await makeFixture();
    f.mesh = { enabled: true, policies: { worker: { roots: [f.root], harnesses: ["fake"], max_tasks: 1 } } };
    const { client, closed } = await connectPaired(f);
    const first = await openTask(client, f, { clientRequestId: "crq-1" });
    const error = await refuse(client, "task.open", { clientRequestId: "crq-2", harness: "fake", cwd: f.root, hops: 0 });
    expect(error.code).toBe(MeshErrorCode.limit);
    // Closing the first frees the slot: the count is live tasks, not tasks ever opened.
    await client.request("task.close", { remoteTaskId: first.remoteTaskId });
    const reopened = await openTask(client, f, { clientRequestId: "crq-2" });
    expect(reopened.remoteTaskId).toMatch(/^rt_/);
    await endLink(client, closed);
  });

  it("answers a retried clientRequestId with the same task, not a second chat", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f);
    const first = await openTask(client, f, { clientRequestId: "crq-same" });
    const second = await openTask(client, f, { clientRequestId: "crq-same" });
    expect(second.remoteTaskId).toBe(first.remoteTaskId);
    expect(f.adapter.openedChats.length).toBe(1);
    await endLink(client, closed);
  });

  it("answers only a request that is currently pending on the task", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f);
    const events = collectEvents(client);
    const { remoteTaskId } = await openTask(client, f);
    await client.request("task.prompt", { remoteTaskId, text: "please ask before reading", mode: "prompt" });
    const event = await waitFor(() => events.find((e) => e.event.type === "request"), "a pending request");
    const requestId = (event.event as unknown as { request: { id: string } }).request.id;
    const unknown = await refuse(client, "task.answer", { remoteTaskId, requestId: "never-raised", answer: { kind: "confirm", confirmed: true } });
    expect(unknown.code).toBe(MeshErrorCode.not_found);
    await expect(client.request("task.answer", { remoteTaskId, requestId, answer: { kind: "confirm", confirmed: true } })).resolves.toEqual({ answered: true });
    // The request is resolved now: a second answer is not_found, not a second confirmation.
    const again = await refuse(client, "task.answer", { remoteTaskId, requestId, answer: { kind: "confirm", confirmed: true } });
    expect(again.code).toBe(MeshErrorCode.not_found);
    await waitFor(() => (events.some((e) => e.event.type === "settled") ? true : undefined), "the run to settle");
    await endLink(client, closed);
  });

  it("reads and sets model and thinking level, and never accepts a permission mode from the caller", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f);
    const { remoteTaskId } = await openTask(client, f);
    const before = await client.request<{ model: string | null }>("task.config", { remoteTaskId });
    expect(before.model).toBe("fake/echo");
    const after = await client.request<{ model: string | null }>("task.config", { remoteTaskId, patch: { model: "fake/slow" } });
    expect(after.model).toBe("fake/slow");
    const refused = await refuse(client, "task.config", { remoteTaskId, patch: { permissionMode: "bypassPermissions" } });
    expect(refused.code).toBe(MeshErrorCode.invalid_params);
    expect(refused.message).toContain("permissionMode");
    // What the ceiling set at open is still what the chat runs under.
    const config = await client.request<{ permissionMode?: string | null }>("task.config", { remoteTaskId });
    expect(config.permissionMode).toBe("acceptEdits");
    await endLink(client, closed);
  });

  it("turns a mid-link revocation into not_paired on the very next call", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f);
    await openTask(client, f);
    await f.pins.removeByName("leader-box");
    const error = await refuse(client, "peer.info", {});
    expect(error.code).toBe(MeshErrorCode.not_paired);
    await endLink(client, closed);
  });

  it("applies a config inbound_policy edit on the very next call", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f, "worker");
    await openTask(client, f, { clientRequestId: "crq-before" });
    // The config now names this peer with the stricter built-in policy: the pin's stored policy stands down.
    f.mesh = { ...f.mesh, peers: [{ name: "leader-box", docker: "leader-box-ctr", inbound_policy: "peer" }] };
    const error = await refuse(client, "task.open", { clientRequestId: "crq-after", harness: "fake", cwd: f.root, hops: 0 });
    expect(error.code).toBe(MeshErrorCode.needs_approval);
    const info = await client.request<{ ceiling: string; approvalsAt: string }>("peer.info", {});
    expect(info.ceiling).toBe("read-only");
    expect(info.approvalsAt).toBe("target");
    await endLink(client, closed);
  });
});

describe("the forced command form", () => {
  it("TOFU-pins a first contact, then refuses a different key under the same forced name", async () => {
    const f = await makeFixture();
    f.forced = { policy: "worker", peer: "leader-box" };
    const who = identity();
    const first = serveLink(f);
    const hs = await clientHandshake(first.client, { identity: who, name: "leader-box", hops: 0, expectedServerKey: f.serverIdentity.publicKey, tofu: false });
    expect(hs.paired).toBe(true);
    expect(hs.policy).toBe("worker");
    const pin = await f.pins.inboundByName("leader-box");
    expect(pin?.publicKey).toEqual(who.publicKey);
    expect(pin?.policy).toBe("worker");
    expect(pin?.via).toBe("forced");
    await endLink(first.client, first.closed);
    // A second key claiming the same forced peer name is an impersonation: pin_mismatch, and the link closes.
    const second = serveLink(f);
    const error = await clientHandshake(second.client, { identity: identity(), name: "leader-box", hops: 0, expectedServerKey: f.serverIdentity.publicKey, tofu: false }).then(
      () => {
        throw new Error("expected a pin mismatch");
      },
      (e) => e as MeshRpcError,
    );
    expect(error.code).toBe(MeshErrorCode.pin_mismatch);
    expect(error.data).toEqual({ code: "pin_mismatch" });
    await second.closed;
  });
});

describe("link teardown and the audit log", () => {
  it("disposes every live chat when the link closes", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f);
    await openTask(client, f, { clientRequestId: "crq-1" });
    await openTask(client, f, { clientRequestId: "crq-2" });
    expect(f.adapter.openedChats.length).toBe(2);
    await endLink(client, closed);
    for (const live of f.adapter.openedChats) {
      await expect(live.prompt("anything")).rejects.toThrow(/closed/i);
    }
  });

  it("audits every call with lengths, never the prompt's or the answer's words", async () => {
    const f = await makeFixture();
    const { client, closed } = await connectPaired(f);
    const events = collectEvents(client);
    const { remoteTaskId } = await openTask(client, f);
    await client.request("task.prompt", { remoteTaskId, text: "ZZTOP-SECRET-PROMPT", mode: "prompt" });
    await waitFor(() => (events.some((e) => e.event.type === "settled") ? true : undefined), "the run to settle");
    await endLink(client, closed);
    // The audit write lands behind the answer, and the link-closed line is the last one, so waiting for it waits for all.
    const text = await waitFor(async () => {
      const read = await readFile(f.auditFile, "utf8").catch(() => "");
      return read.includes('"link closed"') ? read : undefined;
    }, "the audit log to settle");
    expect(text).not.toContain("ZZTOP-SECRET-PROMPT");
    expect(text).not.toContain("Echo:");
    const lines = text.trim().split("\n").map((line) => JSON.parse(line) as { peer: string | null; method: string; decision: string; outcome?: string; target?: string });
    expect(lines.some((line) => line.method === "peer.hello" && line.decision === "allow")).toBe(true);
    const openLine = lines.find((line) => line.method === "task.open");
    expect(openLine?.peer).toBe("leader-box");
    expect(openLine?.decision).toBe("allow");
    expect(openLine?.target).toBe(f.root);
    expect(openLine?.outcome).toMatch(/^rt_[0-9a-f]{12}$/);
    const promptLine = lines.find((line) => line.method === "task.prompt");
    expect(promptLine?.decision).toBe("allow");
    expect(promptLine?.target).toBe(remoteTaskId);
    expect(promptLine?.outcome).toMatch(/^prompt \d+ chars$/);
    expect(lines.some((line) => line.method === "link closed")).toBe(true);
  });
});

describe("permissionModeFor", () => {
  const CLAUDE_MODES = ["plan", "default", "acceptEdits", "bypassPermissions"];

  it("maps each ceiling to the spec's mode for claude, codex, and the fake", () => {
    expect(permissionModeFor("claude", "read-only", CLAUDE_MODES)).toEqual({ ok: true, mode: "plan" });
    expect(permissionModeFor("claude", "default", CLAUDE_MODES)).toEqual({ ok: true, mode: "default" });
    expect(permissionModeFor("claude", "auto-edit", CLAUDE_MODES)).toEqual({ ok: true, mode: "acceptEdits" });
    expect(permissionModeFor("codex", "read-only", ["read-only", "auto", "full-access"])).toEqual({ ok: true, mode: "read-only" });
    expect(permissionModeFor("codex", "default", ["read-only", "auto", "full-access"])).toEqual({ ok: true, mode: "read-only" });
    expect(permissionModeFor("codex", "auto-edit", ["read-only", "auto", "full-access"])).toEqual({ ok: true, mode: "auto" });
    expect(permissionModeFor("fake", "read-only", ["default", "acceptEdits", "bypass"])).toEqual({ ok: true, mode: "default" });
    expect(permissionModeFor("fake", "default", ["default", "acceptEdits", "bypass"])).toEqual({ ok: true, mode: "default" });
    expect(permissionModeFor("fake", "auto-edit", ["default", "acceptEdits", "bypass"])).toEqual({ ok: true, mode: "acceptEdits" });
  });

  it("never hands a remote caller claude's bypass or full access, whatever the harness offers", () => {
    for (const ceiling of ["read-only", "default", "auto-edit"] as const) {
      const mode = permissionModeFor("claude", ceiling, [...CLAUDE_MODES, "full-access", "auto"]);
      expect(mode.ok).toBe(true);
      if (mode.ok) expect(mode.mode).not.toMatch(/bypassPermissions|full-access|auto/);
    }
  });

  it("refuses a harness whose modes do not contain the mapped id", () => {
    const refused = permissionModeFor("claude", "read-only", ["default", "acceptEdits"]);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("plan");
  });

  it("refuses a harness that reports modes but has no mapping, and a modeless harness below auto-edit", () => {
    const unmapped = permissionModeFor("opencode", "auto-edit", ["default"]);
    expect(unmapped.ok).toBe(false);
    if (!unmapped.ok) expect(unmapped.reason).toContain("opencode");
    const refused = permissionModeFor("pi", "read-only", undefined);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("read-only");
    expect(permissionModeFor("pi", "auto-edit", undefined)).toEqual({ ok: true, mode: null });
    expect(permissionModeFor("omp", "auto-edit", [])).toEqual({ ok: true, mode: null });
  });
});
