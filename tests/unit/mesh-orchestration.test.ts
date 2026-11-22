// The mesh's slice of the delegation surface (P1 leader side): the refusals a
// peer task answers with, and the one path that succeeds — a delegated task
// whose child chat is the relay to a paired peer. The worker here is a canned
// in-process server (the real ServerHandshake over a memory link) behind a real
// PeerManager, so the orchestrator exercises exactly what production does:
// the mesh rules first, then the relay, then the ordinary watcher that folds the
// child's answer into the task record. The peers dep is injected the way
// config.yml's `mesh:` block would wire it.
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import type { Agent } from "supertest";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { DelegatedTaskView, WorkspaceInfo } from "../../src/shared/protocol.js";
import { ServerHandshake } from "../../src/server/mesh/handshake.js";
import { loadOrCreateIdentity, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { PeerManager } from "../../src/server/mesh/manager.js";
import { PeerPeersStore } from "../../src/server/mesh/peer-store.js";
import { syncPeersToConfig } from "../../src/server/mesh/config-edit.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { memoryLink, type PeerLink } from "../../src/server/mesh/transport.js";
import { ORCH_INSTRUCTIONS } from "../../src/server/orchestration/tools.js";
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

const REMOTE_TASK = "rt_orch";
/** The child's answer, as the canned worker's settled run leaves it. */
const REMOTE_ANSWER = "Done from the peer.";

/**
 * A signed canned worker: the real server handshake (always paired, policy
 * worker) plus the task.* methods a relay needs. A prompt containing "never
 * settle" gets a session and a busy and then silence, so a task stays live.
 */
function cannedWorker(identity: NodeIdentity) {
  const prompts: string[] = [];
  const spawn = (_peerName: string, _link: PeerLink) => {
    const pair = memoryLink();
    const rpc = new RpcPeer(pair.server.input, pair.server.output, { role: "server" });
    const handshake = new ServerHandshake({ identity, name: "worker-box", resolve: async () => ({ paired: true, policy: "worker" }) });
    rpc.onRequest(async (method, params) => {
      const handled = handshake.handle(method, params);
      if (handled !== null) return handled;
      const p = (params ?? {}) as Record<string, unknown>;
      if (method === "task.open") return { remoteTaskId: REMOTE_TASK, config: { model: null, thinkingLevel: null, models: [], thinkingLevels: [] } };
      if (method === "task.prompt") {
        const text = String(p.text);
        prompts.push(text);
        // The run streams after the prompt is accepted, the way a real worker's does, so
        // delegate() returns with the task working and the watcher folds the rest.
        setTimeout(() => {
          let seq = 0;
          const push = (event: unknown) => {
            seq += 1;
            rpc.notify("task.event", { remoteTaskId: REMOTE_TASK, seq, event });
          };
          push({ type: "session", nativeId: "native-remote" });
          push({ type: "busy" });
          if (!text.includes("never settle")) {
            push({ type: "assistant_start" });
            push({ type: "assistant_delta", field: "text", delta: REMOTE_ANSWER });
            push({ type: "assistant_end", text: REMOTE_ANSWER, thinking: "" });
            push({ type: "settled" });
          }
        }, 5);
        return {};
      }
      if (method === "task.config") return { model: null, thinkingLevel: null, models: [], thinkingLevels: [] };
      if (method === "task.history") return [];
      if (method === "task.answer" || method === "task.abort" || method === "task.close") return {};
      throw new MeshRpcError(MeshErrorCode.method_not_found, `no handler answers "${method}"`, { code: "method_not_found" });
    });
    rpc.start();
    return { input: pair.client.input, output: pair.client.output, kill: () => rpc.close("killed by the test") };
  };
  return { prompts, spawn };
}

/** A real PeerManager over the canned worker, with the worker's key pinned (what `awui peer add` leaves behind). */
async function meshManager(worker?: ReturnType<typeof cannedWorker>) {
  const w = worker ?? cannedWorker(await loadOrCreateIdentity(tempDir("awui-mesh-w-")));
  const client = await loadOrCreateIdentity(tempDir("awui-mesh-c-"));
  const manager = new PeerManager({
    identity: async () => client,
    pins: PinStore(path.join(tempDir("awui-mesh-pins-"), "pins.json")),
    config: () => ({ enabled: true, peers: [{ name: "lab", docker: "awui-worker-1" }] }),
    enabled: () => true,
    localName: () => "leader-box",
    spawn: w.spawn,
  });
  const first = await manager.connect("lab", { tofu: true });
  await manager.pin("lab", first.serverKey);
  first.close();
  return { manager, worker: w };
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

function call(agent: Agent, token: string, tool: string, args: unknown) {
  return agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool, args });
}

/** One refusal, by status and code: what the bridges and the model both read. */
async function refuse(agent: Agent, token: string, args: Record<string, unknown>) {
  const res = await call(agent, token, "delegate_task", args);
  expect(res.status).toBeGreaterThan(399);
  return res.body as { ok: false; code: string };
}

async function waitUntil(check: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("mesh orchestration", () => {
  it("refuses a peer task while the mesh is off, whichever way it is off", async () => {
    const { agent, token } = await setup();
    // No peers dep at all (no `mesh:` block): the refusal names the setting.
    const unwired = await refuse(agent, token, { brief: "x", peer: "lab", peerCwd: "/srv/proj" });
    expect(unwired).toMatchObject({ ok: false, code: "mesh_off" });

    const { manager } = await meshManager();
    const off = await setup(peersOf(manager, { enabled: () => false }));
    const disabled = await refuse(off.agent, off.token, { brief: "x", peer: "lab", peerCwd: "/srv/proj" });
    expect(disabled).toMatchObject({ ok: false, code: "mesh_off" });
  });

  it("refuses a peer task without the project's path on that peer", async () => {
    const { manager } = await meshManager();
    const { agent, token } = await setup(peersOf(manager));
    const res = await call(agent, token, "delegate_task", { brief: "x", peer: "lab" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, code: "invalid_request" });
    expect(res.body.message ?? res.body.error ?? "").toMatch(/peerCwd/);
  });

  it("refuses a peer task from a chat that is not a lead", async () => {
    const { manager } = await meshManager();
    const { app, agent, token } = await setup(peersOf(manager));
    const caller = app.manager.list().find((c) => c.orchestration?.token === token);
    if (!caller) throw new Error("no caller chat");
    // A delegated child (depth 1) may not start remote tasks while mesh.chats is lead-only.
    caller.lineage = { kind: "delegate", taskId: "t1", parentChatId: "p1", parentTitle: null, depth: 1 };
    const body = await refuse(agent, token, { brief: "x", peer: "lab", peerCwd: "/srv/proj" });
    expect(body).toMatchObject({ code: "mesh_lead_only" });
    // The same chat may when the config says every chat may.
    const all = await setup(peersOf(manager, { chats: () => "all" }));
    const child = all.app.manager.list().find((c) => c.orchestration?.token === all.token);
    if (!child) throw new Error("no caller chat");
    child.lineage = { kind: "delegate", taskId: "t1", parentChatId: "p1", parentTitle: null, depth: 1 };
    const allowed = await call(all.agent, all.token, "delegate_task", { brief: "never settle", peer: "lab", peerCwd: "/srv/proj" });
    expect(allowed.status).toBe(200);
  });

  it("refuses a peer task from a chat that arrived over the mesh", async () => {
    // The REST route answers an owned chat with its own 401 before the orchestrator is reached,
    // and a worker's child chats get no orchestration tools at all — so the one caller that can
    // reach this guard is a direct orchestrator.run, which is what the route itself forwards to.
    const { manager } = await meshManager();
    const chats = new ChatManager();
    const registry = new HarnessRegistry();
    const fake = new FakeAdapter({});
    registry.register(fake);
    await registry.refreshStatus();
    const root = tempDir("awui-mesh-hop-");
    const project = path.join(root, "proj");
    mkdirSync(project);
    const { workspaces } = await Workspaces.create([root], root);
    const orch = new Orchestrator({ chats, registry, workspaces, file: null, decisionsFile: null, limits: () => DEFAULT_ORCHESTRATION_LIMITS, peers: peersOf(manager), log: () => undefined });
    await orch.start();
    const caller = await chats.create(fake, await workspaces.open(project));
    // Only the worker side creates peer-owned chats; the guard is what is under test, not the creation.
    (caller as { owner?: unknown }).owner = { kind: "peer", peerId: "node-1", peerName: "leader-box", remoteTaskId: "rt_upstream" };
    await expect(orch.run("delegate_task", { brief: "x", peer: "lab", peerCwd: "/srv/proj" }, caller)).rejects.toMatchObject({ code: "hop_limit" });
  });

  it("refuses isolation and write scopes with a peer", async () => {
    const { manager } = await meshManager();
    const { agent, token } = await setup(peersOf(manager));
    const isolated = await refuse(agent, token, { brief: "x", peer: "lab", peerCwd: "/srv/proj", isolation: "worktree" });
    expect(isolated).toMatchObject({ code: "unsupported_with_peer" });
    const scoped = await refuse(agent, token, { brief: "x", peer: "lab", peerCwd: "/srv/proj", writeScope: ["src/**"] });
    expect(scoped).toMatchObject({ code: "unsupported_with_peer" });
    const moded = await refuse(agent, token, { brief: "x", peer: "lab", peerCwd: "/srv/proj", permissionMode: "acceptEdits" });
    expect(moded).toMatchObject({ code: "unsupported_with_peer" });
  });

  it("refuses a peer the config does not name", async () => {
    const { manager } = await meshManager();
    const { agent, token } = await setup(peersOf(manager));
    const body = await refuse(agent, token, { brief: "x", peer: "ghost", peerCwd: "/srv/proj" });
    expect(body).toMatchObject({ code: "unknown_peer" });
  });

  it("refuses a peer task beyond the outbound remote-task limit", async () => {
    const { manager, worker } = await meshManager();
    const { agent, token } = await setup(peersOf(manager, { maxRemoteTasks: () => 1 }));
    // One live remote task fills the budget; the second is the refusal under test.
    const first = await call(agent, token, "delegate_task", { brief: "never settle", peer: "lab", peerCwd: "/srv/proj" });
    expect(first.status).toBe(200);
    expect(worker.prompts.length).toBe(1);
    const body = await refuse(agent, token, { brief: "also work", peer: "lab", peerCwd: "/srv/proj" });
    expect(body).toMatchObject({ code: "remote_limit" });
  });

  it("runs a task on a paired peer: the view names the host and the child's answer is the result", async () => {
    const { manager, worker } = await meshManager();
    const { agent, token } = await setup(peersOf(manager));
    const started = await call(agent, token, "delegate_task", { brief: "parse the logs on that machine", peer: "lab", peerCwd: "/srv/proj" });
    expect(started.status).toBe(200);
    const task = started.body.data as DelegatedTaskView;
    expect(task.state).toBe("working");
    // The brief crossed the link once, to the remote task, as the worker's own prompt.
    await waitUntil(() => worker.prompts.length === 1, 8000, "the brief to reach the worker");
    expect(worker.prompts[0]).toContain("parse the logs on that machine");

    // The watcher folds the relayed run into the record exactly as it folds a local child's.
    const deadline = Date.now() + 8000;
    for (;;) {
      const res = await call(agent, token, "task_status", { taskId: task.id });
      if (!res.ok) throw new Error(`task_status failed: ${JSON.stringify(res.body)}`);
      const view = (res.body.data as { tasks: DelegatedTaskView[] }).tasks[0];
      if (view?.state === "result_available") {
        expect(view.harnessId).toBe("peer:lab:fake");
        expect(view.host).toBe("lab");
        expect(view.outcome).toBe("done");
        expect(view.result?.finalText).toBe(REMOTE_ANSWER);
        expect(view.reviewable).toBe(false);
        break;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for the remote task to settle (state ${view?.state ?? "?"})`);
      await new Promise((r) => setTimeout(r, 20));
    }
  });

  it("names the peers in list_profiles only while the mesh is on", async () => {
    const { manager } = await meshManager();
    const on = await setup(peersOf(manager));
    const listed = await call(on.agent, on.token, "list_profiles", {});
    expect(listed.status).toBe(200);
    expect(listed.body.text).toContain("Peers (mesh): lab (docker)");
    expect(listed.body.text).toContain("delegate_task with peer + peerCwd runs on that machine");

    const off = await setup(peersOf(manager, { enabled: () => false }));
    const bare = await call(off.agent, off.token, "list_profiles", {});
    expect(bare.body.text).not.toContain("Peers (mesh)");
  });

  it("adds a machine from a chat, pairs only on the confirmed SAS, and moves it into config.yml", async () => {
    const worker = cannedWorker(await loadOrCreateIdentity(tempDir("awui-mesh-w-")));
    const client = await loadOrCreateIdentity(tempDir("awui-mesh-c-"));
    const pins = PinStore(path.join(tempDir("awui-mesh-pins-"), "pins.json"));
    const saved = PeerPeersStore(path.join(tempDir("awui-mesh-saved-"), "mesh", "peers.json"));
    const manager = new PeerManager({
      identity: async () => client,
      pins,
      config: () => ({ enabled: true, peers: [] }),
      enabled: () => true,
      localName: () => "leader-box",
      savedPeers: () => saved.snapshot(),
      spawn: worker.spawn,
    });
    const configDir = tempDir("awui-mesh-cfg-");
    const configFile = path.join(configDir, "config.yml");
    writeFileSync(configFile, "mesh:\n  enabled: true\n  name: leader-box\n");
    const { app, agent, token } = await setup({
      ...peersOf(manager),
      admin: {
        saved,
        localName: () => "leader-box",
        syncConfig: (names?: string[]) => syncPeersToConfig(configDir, saved, names),
      },
    });

    const added = await call(agent, token, "mesh_peer_add", { name: "newbox", ssh: "user@lab" });
    expect(added.status).toBe(200);
    expect((await saved.list()).map((peer) => peer.name)).toEqual(["newbox"]);
    expect(added.body.text).toContain("Compare that SAS");
    const sas = String(added.body.data.contact.sas);
    // A wrong SAS pins nothing and closes the link.
    const wrong = sas === "000 000" ? "000 001" : "000 000";
    const mismatched = await call(agent, token, "mesh_peer_pair", { name: "newbox", sas: wrong });
    expect(mismatched.status).toBe(409);
    expect(mismatched.body.code).toBe("sas_mismatch");
    expect(await pins.outbound("newbox")).toBeNull();
    // The confirmed one pins the key.
    const paired = await call(agent, token, "mesh_peer_pair", { name: "newbox", sas });
    expect(paired.status).toBe(200);
    expect(await pins.outbound("newbox")).not.toBeNull();
    // Sync moves it to config.yml and out of peers.json.
    const synced = await call(agent, token, "mesh_peer_sync_config", { names: ["newbox"] });
    expect(synced.status).toBe(200);
    expect(synced.body.data.moved).toEqual(["newbox"]);
    expect(await saved.list()).toEqual([]);
    expect(readFileSync(configFile, "utf8")).toContain("newbox");

    // A delegated child may never add a machine, whatever mesh.chats says.
    const caller = app.manager.list().find((chat) => chat.orchestration?.token === token);
    if (!caller) throw new Error("no caller chat");
    caller.lineage = { kind: "delegate", taskId: "t1", parentChatId: "p1", parentTitle: null, depth: 1 };
    const child = await call(agent, token, "mesh_peer_add", { name: "otherbox", tls: "127.0.0.1:4785" });
    expect(child.status).toBe(403);
    expect(child.body.code).toBe("mesh_lead_only");
  });

  it("keeps ORCH_INSTRUCTIONS within the byte budget the harnesses impose", () => {
    expect(Buffer.byteLength(ORCH_INSTRUCTIONS)).toBeLessThan(4000);
    // The one bullet the mesh adds says what a peer task needs.
    expect(ORCH_INSTRUCTIONS).toContain("peer + peerCwd");
  });
});
