// The peer_files tool (P1.5 §4): one file operation on a paired peer, gated by the same
// mesh rules a peer delegation passes (mesh on, a lead chat, one hop, a configured peer)
// and then answered by the peer's own policy. The worker here is a canned in-process
// server (the real ServerHandshake over a memory link) answering fs.* exactly as the
// spec's wire shapes have it, so the refusals, the happy paths, and the binary guard are
// exercised end to end against what production talks to.
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import type { Agent } from "supertest";
import { mkdirSync } from "node:fs";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { ServerHandshake } from "../../src/server/mesh/handshake.js";
import { loadOrCreateIdentity, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { PeerManager } from "../../src/server/mesh/manager.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { memoryLink, type PeerLink } from "../../src/server/mesh/transport.js";
import { Orchestrator, type OrchestratorDeps } from "../../src/server/orchestration/orchestrator.js";
import { DEFAULT_ORCHESTRATION_LIMITS } from "../../src/server/orchestration/limits.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import { ChatManager } from "../../src/server/chats/manager.js";
import { Workspaces } from "../../src/server/workspaces.js";
import { makeTestApp, signedIn, tempDir, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

/**
 * A canned worker whose fs.* answers come from one in-memory tree: `files` maps the
 * path the leader asks for to its bytes, `entries` is what fs.list shows, and `writes`
 * records every write that passed the worker's own checks.
 */
function fileWorker(identity: NodeIdentity) {
  const files = new Map<string, { bytes: Buffer; mtimeMs: number; mode: number }>();
  const entries: Array<{ name: string; type: "file" | "dir" | "symlink"; size: number }> = [];
  const writes: Array<{ path: string; data: Buffer; mode: string }> = [];
  const spawn = (_peerName: string, _link: PeerLink) => {
    const pair = memoryLink();
    const rpc = new RpcPeer(pair.server.input, pair.server.output, { role: "server" });
    const handshake = new ServerHandshake({ identity, name: "worker-box", resolve: async () => ({ paired: true, policy: "worker" }) });
    rpc.onRequest(async (method, params) => {
      const handled = handshake.handle(method, params);
      if (handled !== null) return handled;
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === "fs.stat") {
        const file = files.get(String(p.path));
        if (file === undefined) throw new MeshRpcError(MeshErrorCode.not_found, "no such file", { code: "not_found" });
        return { type: "file", size: file.bytes.length, mtimeMs: file.mtimeMs, mode: file.mode };
      }
      if (method === "fs.list") {
        return { entries, truncated: false };
      }
      if (method === "fs.read") {
        const file = files.get(String(p.path));
        if (file === undefined) throw new MeshRpcError(MeshErrorCode.not_found, "no such file", { code: "not_found" });
        const offset = typeof p.offset === "number" ? p.offset : 0;
        const length = typeof p.length === "number" ? p.length : file.bytes.length - offset;
        const slice = file.bytes.subarray(offset, offset + length);
        return { data: slice.toString("base64"), size: file.bytes.length, eof: offset + slice.length >= file.bytes.length };
      }
      if (method === "fs.write") {
        const bytes = Buffer.from(String(p.data), "base64");
        const mode = String(p.mode);
        const existing = files.get(String(p.path));
        if (mode === "create" && existing !== undefined) throw new MeshRpcError(MeshErrorCode.denied, "the file already exists", { code: "denied" });
        writes.push({ path: String(p.path), data: bytes, mode });
        const mtimeMs = Date.now();
        files.set(String(p.path), { bytes, mtimeMs, mode: existing?.mode ?? 0o644 });
        return { size: bytes.length, mtimeMs };
      }
      throw new MeshRpcError(MeshErrorCode.method_not_found, `no handler answers "${method}"`, { code: "method_not_found" });
    });
    rpc.start();
    return { input: pair.client.input, output: pair.client.output, kill: () => rpc.close("killed by the test") };
  };
  return { spawn, files, entries, writes };
}

/** A real PeerManager over the file worker, with the worker's key pinned (what `peer add` leaves). */
async function meshManager(worker: ReturnType<typeof fileWorker>) {
  const client = await loadOrCreateIdentity(tempDir("awui-mesh-pf-c-"));
  const manager = new PeerManager({
    identity: async () => client,
    pins: PinStore(path.join(tempDir("awui-mesh-pf-pins-"), "pins.json")),
    config: () => ({ enabled: true, peers: [{ name: "lab", docker: "awui-worker-1" }] }),
    enabled: () => true,
    localName: () => "leader-box",
    spawn: worker.spawn,
  });
  const first = await manager.connect("lab", { tofu: true });
  await manager.pin("lab", first.serverKey);
  first.close();
  return manager;
}

/** The orchestrator's peers dep, as app.ts would wire it from config.yml. */
function peersOf(manager: PeerManager, over: { enabled?: () => boolean; chats?: () => "lead-only" | "all"; maxRemoteTasks?: () => number } = {}): NonNullable<OrchestratorDeps["peers"]> {
  return {
    manager,
    enabled: over.enabled ?? (() => true),
    chats: over.chats ?? (() => "lead-only"),
    maxRemoteTasks: over.maxRemoteTasks ?? (() => 8),
  };
}

async function setup(peers?: NonNullable<OrchestratorDeps["peers"]>) {
  const app = await makeTestApp(peers ? { orchestrationPeers: peers } : {});
  t = app;
  const agent = await signedIn(app);
  const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as WorkspaceInfo;
  const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as { chatId: string };
  const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
  if (!token) throw new Error("the chat was spawned without an orchestration token");
  return { app, agent, chat, token };
}

function call(agent: Agent, token: string, args: unknown) {
  return agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "peer_files", args });
}

describe("peer_files", () => {
  it("is refused while the mesh is off, whichever way it is off", async () => {
    const { agent, token } = await setup();
    // No peers dep at all (no `mesh:` block): the refusal names the setting.
    const unwired = await call(agent, token, { peer: "lab", op: "stat", path: "/srv/proj/notes.md" });
    expect(unwired.status).toBe(403);
    expect(unwired.body).toMatchObject({ ok: false, code: "mesh_off" });

    const manager = await meshManager(fileWorker(await loadOrCreateIdentity(tempDir("awui-mesh-pf-w-"))));
    const off = await setup(peersOf(manager, { enabled: () => false }));
    const disabled = await call(off.agent, off.token, { peer: "lab", op: "stat", path: "/srv/proj/notes.md" });
    expect(disabled.body).toMatchObject({ code: "mesh_off" });
  });

  it("is refused for a chat that is not a lead, or one that arrived over the mesh", async () => {
    const manager = await meshManager(fileWorker(await loadOrCreateIdentity(tempDir("awui-mesh-pf-w-"))));
    const { app, agent, token } = await setup(peersOf(manager));
    const caller = app.manager.list().find((c) => c.orchestration?.token === token);
    if (!caller) throw new Error("no caller chat");
    // A delegated child (depth 1) may not reach mesh peers while mesh.chats is lead-only.
    caller.lineage = { kind: "delegate", taskId: "t1", parentChatId: "p1", parentTitle: null, depth: 1 };
    const child = await call(agent, token, { peer: "lab", op: "stat", path: "/srv/proj/notes.md" });
    expect(child.body).toMatchObject({ code: "mesh_lead_only" });
  });

  it("is refused for a peer the config does not name", async () => {
    const manager = await meshManager(fileWorker(await loadOrCreateIdentity(tempDir("awui-mesh-pf-w-"))));
    const { agent, token } = await setup(peersOf(manager));
    const res = await call(agent, token, { peer: "ghost", op: "stat", path: "/srv/proj/notes.md" });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "unknown_peer" });
  });

  it("stats and lists a peer's paths", async () => {
    const worker = fileWorker(await loadOrCreateIdentity(tempDir("awui-mesh-pf-w-")));
    worker.files.set("/srv/proj/notes.md", { bytes: Buffer.from("hello"), mtimeMs: 1234, mode: 0o644 });
    worker.entries.push({ name: "notes.md", type: "file", size: 5 }, { name: "sub", type: "dir", size: 0 });
    const manager = await meshManager(worker);
    const { agent, token } = await setup(peersOf(manager));

    const stat = await call(agent, token, { peer: "lab", op: "stat", path: "/srv/proj/notes.md" });
    expect(stat.status).toBe(200);
    expect(stat.body.data).toMatchObject({ type: "file", size: 5, mtimeMs: 1234, mode: 0o644 });
    expect(stat.body.text).toContain("lab:/srv/proj/notes.md");

    const listing = await call(agent, token, { peer: "lab", op: "list", path: "/srv/proj" });
    expect(listing.status).toBe(200);
    expect(listing.body.data).toMatchObject({ truncated: false });
    expect(listing.body.text).toContain("notes.md (file, 5 bytes)");
    expect(listing.body.text).toContain("sub (dir)");
  });

  it("reads utf8 text back, and refuses a binary file with a clear message", async () => {
    const worker = fileWorker(await loadOrCreateIdentity(tempDir("awui-mesh-pf-w-")));
    worker.files.set("/srv/proj/notes.md", { bytes: Buffer.from("the notes\n"), mtimeMs: 1234, mode: 0o644 });
    worker.files.set("/srv/proj/logo.png", { bytes: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d]), mtimeMs: 1234, mode: 0o644 });
    const manager = await meshManager(worker);
    const { agent, token } = await setup(peersOf(manager));

    const read = await call(agent, token, { peer: "lab", op: "read", path: "/srv/proj/notes.md" });
    expect(read.status).toBe(200);
    expect(read.body.text).toContain("the notes");
    expect((read.body.data as { eof: boolean }).eof).toBe(true);

    const binary = await call(agent, token, { peer: "lab", op: "read", path: "/srv/proj/logo.png" });
    expect(binary.status).toBe(422);
    expect(binary.body.message ?? binary.body.error ?? "").toMatch(/not utf8 text/);
  });

  it("writes utf8 text in create and overwrite modes, and refuses a write without its shape", async () => {
    const worker = fileWorker(await loadOrCreateIdentity(tempDir("awui-mesh-pf-w-")));
    const manager = await meshManager(worker);
    const { agent, token } = await setup(peersOf(manager));

    const created = await call(agent, token, { peer: "lab", op: "write", path: "/srv/proj/notes.md", data: "first draft\n", mode: "create" });
    expect(created.status).toBe(200);
    expect(worker.writes).toEqual([{ path: "/srv/proj/notes.md", data: Buffer.from("first draft\n"), mode: "create" }]);
    expect(created.body.text).toContain("12 bytes");

    const overwrite = await call(agent, token, { peer: "lab", op: "write", path: "/srv/proj/notes.md", data: "second", mode: "overwrite" });
    expect(overwrite.status).toBe(200);
    expect(worker.writes[1]).toEqual({ path: "/srv/proj/notes.md", data: Buffer.from("second"), mode: "overwrite" });

    // The tool's own shape: a write is data plus mode, and no more than 1 MiB of text.
    const bare = await call(agent, token, { peer: "lab", op: "write", path: "/srv/proj/notes.md", data: "x" });
    expect(bare.status).toBe(400);
    expect(bare.body).toMatchObject({ code: "invalid_request" });
    const modeless = await call(agent, token, { peer: "lab", op: "write", path: "/srv/proj/notes.md" });
    expect(modeless.status).toBe(400);
  });

  it("passes the peer's own refusal through with the peer named", async () => {
    const worker = fileWorker(await loadOrCreateIdentity(tempDir("awui-mesh-pf-w-")));
    worker.files.set("/srv/proj/notes.md", { bytes: Buffer.from("taken"), mtimeMs: 1234, mode: 0o644 });
    const manager = await meshManager(worker);
    const { agent, token } = await setup(peersOf(manager));
    const res = await call(agent, token, { peer: "lab", op: "write", path: "/srv/proj/notes.md", data: "x", mode: "create" });
    expect(res.status).toBe(502);
    expect(res.body.message ?? res.body.error ?? "").toMatch(/lab refused the request: the file already exists/);
  });

  it("reaches the same refusals through a direct orchestrator.run from a peer-owned chat", async () => {
    const manager = await meshManager(fileWorker(await loadOrCreateIdentity(tempDir("awui-mesh-pf-w-"))));
    const chats = new ChatManager();
    const registry = new HarnessRegistry();
    const fake = new FakeAdapter({});
    registry.register(fake);
    await registry.refreshStatus();
    const root = tempDir("awui-mesh-pf-hop-");
    const project = path.join(root, "proj");
    mkdirSync(project);
    const { workspaces } = await Workspaces.create([root], root);
    const orch = new Orchestrator({ chats, registry, workspaces, file: null, decisionsFile: null, limits: () => DEFAULT_ORCHESTRATION_LIMITS, peers: peersOf(manager), log: () => undefined });
    await orch.start();
    const caller = await chats.create(fake, await workspaces.open(project));
    // Only the worker side creates peer-owned chats; the guard is what is under test.
    (caller as { owner?: unknown }).owner = { kind: "peer", peerId: "node-1", peerName: "leader-box", remoteTaskId: "rt_upstream" };
    await expect(orch.run("peer_files", { peer: "lab", op: "stat", path: "/srv/proj/notes.md" }, caller)).rejects.toMatchObject({ code: "hop_limit" });
    // The unknown-peer refusal comes from the same gate.
    const clean = await chats.create(fake, await workspaces.open(project));
    await expect(orch.run("peer_files", { peer: "ghost", op: "stat", path: "/srv/proj/notes.md" }, clean)).rejects.toMatchObject({ code: "unknown_peer" });
  });
});
