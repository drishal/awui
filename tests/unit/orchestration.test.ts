// The orchestration surface: one token per live chat (minted with the spawn, 12 hours
// long, never for a read-only harness or a board-owned chat), the tool catalogue both
// bridges fetch, and the durable delegation behind it — a child chat with lineage, a
// record in the state folder, the settle watcher, the caps, thread_read and thread_send, and the
// wake ledger that reports a finished child back to a parent (coalesced, then delivered once).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import type { ChatItem, ChatSnapshot, DelegatedTaskView, Plan, PushNote, SessionsOverview, WorkspaceInfo } from "../../src/shared/protocol.js";
import { ChatManager } from "../../src/server/chats/manager.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import { Orchestrator } from "../../src/server/orchestration/orchestrator.js";
import { DEFAULT_ORCHESTRATION_LIMITS } from "../../src/server/orchestration/limits.js";
import { formatElapsed } from "../../src/server/orchestration/types.js";
import { Workspaces } from "../../src/server/workspaces.js";
import { makeTestApp, openSse, signedIn, tempDir, type TestApp } from "../helpers/app.js";
import { makeBot } from "../helpers/board.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const TOOL_NAMES = ["delegate_task", "resident_agent", "task_review", "task_status", "plan_workers", "task_cancel", "thread_send", "thread_read", "thread_wait", "set_status", "request_decision", "list_profiles", "schedule_heartbeat"];

async function setup(options: Parameters<typeof makeTestApp>[0] = {}) {
  const app = await makeTestApp(options);
  t = app;
  const agent = await signedIn(app);
  const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as WorkspaceInfo;
  const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
  const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
  if (!token) throw new Error("the chat was spawned without an orchestration token");
  return { app, agent, ws, chat, token };
}

describe("orchestration surface", () => {
  it("serves the tool catalogue to a live chat's child", async () => {
    const { agent, token } = await setup();
    const res = await agent.get("/api/orchestration/tools").set("x-awui-orch-token", token);
    expect(res.status).toBe(200);
    const tools = res.body.tools as Array<{ name: string; description: string; parameters: { type: string; required?: string[] } }>;
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.parameters.type).toBe("object");
    }
    // The brief is the one required argument of a delegation; a wait names its tasks.
    expect(tools.find((tool) => tool.name === "delegate_task")?.parameters.required).toEqual(["brief"]);
    expect(tools.find((tool) => tool.name === "thread_wait")?.parameters.required).toEqual(["taskIds"]);
  });

  it("answers a bad, absent, or expired token and nothing else", async () => {
    const { app, agent, token } = await setup();
    const absent = await agent.get("/api/orchestration/tools");
    expect(absent.status).toBe(401);
    expect(absent.body.code).toBe("bad_orch_token");
    expect((await agent.get("/api/orchestration/tools").set("x-awui-orch-token", "0".repeat(32))).status).toBe(401);

    // Twelve hours after the spawn the token is spent, and the answer says to restart the chat.
    const chat = app.manager.list().find((c) => c.orchestration?.token === token);
    if (!chat?.orchestration) throw new Error("no token to expire");
    chat.orchestration.expiresAt = Date.now() - 1;
    const expired = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "list_profiles", args: {} });
    expect(expired.status).toBe(401);
    expect(expired.body).toMatchObject({ ok: false, code: "orch_token_expired" });
  });

  it("serves an unknown tool as an error the bridges can read, and a task that is not this chat's", async () => {
    const { agent, token } = await setup();
    const unknown = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "steal_everything", args: {} });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ ok: false, code: "unknown_tool" });
    // A tool that exists answers about a task id it does not know, not with an unknown tool.
    const missing = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "thread_send", args: { taskId: "abcd", text: "x" } });
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ ok: false, code: "unknown_task" });
    // Arguments are validated before dispatch: a wait with no tasks is a bad request.
    const invalid = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "thread_wait", args: { taskIds: [] } });
    expect(invalid.status).toBe(400);
  });

  it("lists the project's bots and every delegation-capable harness", async () => {
    const { agent, ws, token } = await setup();
    const bot = await makeBot(agent, { name: "Critic", role: "review", instructions: "Review only, change nothing.", model: "fake/slow" });
    const res = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "list_profiles", args: {} });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const data = res.body.data as {
      profiles: Array<{ id: string; source: string; name: string; harnessId: string; model: string | null; provider: string | null; role: string | null; note: string | null; available: boolean }>;
      workspace: WorkspaceInfo;
      remainingDepth: number;
      remainingTasks: number;
    };
    expect(data.workspace.id).toBe(ws.id);
    expect(data.remainingDepth).toBe(2);
    expect(data.remainingTasks).toBe(4);
    expect(data.profiles.find((p) => p.id === bot.id)).toMatchObject({
      source: "bot",
      name: "Critic",
      harnessId: "fake",
      model: "fake/slow",
      provider: "fake",
      role: "review",
      note: "Review only, change nothing.",
      available: true,
    });
    // fake and fake-b are registered; each harness is one entry at its own default model.
    expect(data.profiles.filter((p) => p.source === "harness").map((p) => p.name)).toEqual(["Fake", "Fake B"]);
    expect(data.profiles.find((p) => p.source === "harness" && p.harnessId === "fake-b")?.model).toBeNull();
    // The text is one composed line per profile, which is what a model reads.
    expect(res.body.text).toContain(`Critic · Fake · fake/slow · review`);
  });

  it("serves the catalogue to a child's token while its chat is still starting", async () => {
    // A bridge fetches the catalogue the moment it loads, before the manager has a chat to stamp.
    const manager = new ChatManager();
    manager.orchestration = { baseUrl: "http://127.0.0.1:1" };
    const project = tempDir("awui-early-");
    mkdirSync(path.join(project, "proj"));
    const workspace: WorkspaceInfo = { id: "w1", path: path.join(project, "proj"), name: "proj" };
    let knewDuringSpawn: boolean | null = null;
    class Probe extends FakeAdapter {
      override async openChat(req: Parameters<FakeAdapter["openChat"]>[0]) {
        const token = req.toolEnv?.AWUI_ORCH_TOKEN ?? "";
        knewDuringSpawn = token !== "" && manager.knowsOrchToken(token) && manager.chatForOrchToken(token) === undefined;
        return super.openChat(req);
      }
    }
    try {
      const chat = await manager.create(new Probe({ id: "probe" }), workspace);
      expect(knewDuringSpawn).toBe(true);
      expect(manager.knowsOrchToken("0".repeat(32))).toBe(false);
      expect(manager.chatForOrchToken(chat.orchestration?.token ?? "")).toBe(chat);
    } finally {
      await manager.shutdown();
    }
  });

  it("gives a read-only harness no orchestration token", async () => {
    // The adapter-level rule the awui harness declares: a child of it would carry the write and exec tools it denies.
    const manager = new ChatManager();
    manager.render = { baseUrl: "http://127.0.0.1:1" };
    manager.orchestration = { baseUrl: "http://127.0.0.1:1" };
    const project = tempDir("awui-ro-");
    mkdirSync(path.join(project, "proj"));
    const workspace: WorkspaceInfo = { id: "w1", path: path.join(project, "proj"), name: "proj" };
    const adapter = new FakeAdapter({ id: "read-only", capabilities: { readOnlyHarness: true } });
    try {
      const chat = await manager.create(adapter, workspace);
      expect(chat.orchestration).toBeUndefined();
      expect(chat.render?.token).toMatch(/^[0-9a-f]{32}$/);
      expect(manager.chatForOrchToken("0".repeat(32))).toBeUndefined();
    } finally {
      await manager.shutdown();
    }
  });
});

type Agent = Awaited<ReturnType<typeof signedIn>>;

/** One tool call as the chat's child would make it. */
function call(agent: Agent, token: string, tool: string, args: unknown) {
  return agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool, args });
}

/** The token a live chat's child carries (every chat the manager spawned has one). */
function tokenOf(app: TestApp, chatId: string): string {
  const token = app.manager.list().find((c) => c.chatId === chatId)?.orchestration?.token;
  if (!token) throw new Error(`chat ${chatId} has no orchestration token`);
  return token;
}

async function delegate(agent: Agent, token: string, args: Record<string, unknown>) {
  const res = await call(agent, token, "delegate_task", args);
  if (res.status !== 200) throw new Error(`delegate failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.data as { taskId: string; childChatId: string | null; state: string };
}

describe("delegated tasks", () => {
  it("spawns an ordinary child chat with lineage, and the parent's panel sees it live", async () => {
    const { app, agent, chat, token } = await setup();
    const sse = openSse(app, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));

    const started = await delegate(agent, token, { brief: "summarise the readme", title: "Summariser" });
    expect(started.childChatId).not.toBeNull();
    const childId = started.childChatId as string;
    expect(app.manager.list().some((c) => c.chatId === childId)).toBe(true);

    // The child is openable like any chat and carries the lineage chip's data.
    const childSnap = (await agent.get(`/api/chats/${childId}`)).body as ChatSnapshot;
    expect(childSnap.lineage).toEqual({ kind: "delegate", taskId: started.taskId, parentChatId: chat.chatId, parentTitle: null, depth: 1 });
    expect(childSnap.chatId).toBe(childId);

    // The brief the parent agent sent is a user item marked agent-authored.
    const brief = childSnap.items.find((i): i is Extract<ChatItem, { kind: "user" }> => i.kind === "user" && i.text === "summarise the readme");
    expect(brief && brief.source).toBe("agent");
    // The parent is told by a task event, and its snapshot carries the row.
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "task"));
    const parentSnap = (await agent.get(`/api/chats/${chat.chatId}`)).body as ChatSnapshot;
    expect(parentSnap.delegated?.[0]).toMatchObject({ id: started.taskId, parentChatId: chat.chatId, childChatId: childId, harnessId: "fake", title: "Summariser", depth: 1 });
    sse.close();
  });

  it("sets a chat's status line, shows it in the session list, and refuses a state it does not have", async () => {
    const { app, agent, token } = await setup();
    const set = await call(agent, token, "set_status", { status: "blocked", comment: "waiting on the flaky auth test" });
    expect(set.status).toBe(200);
    expect(set.body.text).toBe("Status set: blocked — waiting on the flaky auth test");
    const chat = app.manager.list().find((c) => c.orchestration?.token === token);
    if (!chat?.sessionId) throw new Error("the chat has no session");
    const overview = (await agent.get("/api/sessions").expect(200)).body as SessionsOverview;
    expect(overview.sessions.find((s) => s.id === chat.sessionId)?.agentStatus).toMatchObject({ state: "blocked", comment: "waiting on the flaky auth test" });
    // One state only, and the comment is bounded rather than refused.
    expect((await call(agent, token, "set_status", { status: "waiting" })).status).toBe(400);
    const long = await call(agent, token, "set_status", { status: "review", comment: "x".repeat(500) });
    expect(long.status).toBe(400);
    const ok = await call(agent, token, "set_status", { status: "review", comment: "y".repeat(200) });
    expect(ok.status).toBe(200);
    // A later write replaces the line.
    const again = await call(agent, token, "set_status", { status: "done", comment: "shipped" });
    expect((again.body.data as { state: string }).state).toBe("done");
  });

  it("lists a delegated child's session with its origin, so the sidebar can hide agent-started work", async () => {
    const { app, agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "summarise the readme" });
    await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });
    const child = app.manager.list().find((c) => c.chatId === started.childChatId);
    if (!child?.sessionId) throw new Error("the child never got a session");
    const overview = (await agent.get("/api/sessions").expect(200)).body as SessionsOverview;
    expect(overview.sessions.find((s) => s.id === child.sessionId)?.origin).toBe("agent");
    // A chat a person started carries no origin at all.
    const own = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: (await agent.post("/api/workspaces/open").send({ path: app.project })).body.id })).body as ChatSnapshot;
    const after = (await agent.get("/api/sessions").expect(200)).body as SessionsOverview;
    const mine = after.sessions.find((s) => s.liveChatId === own.chatId);
    expect(mine?.origin).toBeUndefined();
  });

  it("waits for the child's answer and returns it", async () => {
    const { agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "explain the build" });
    const waited = await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });
    expect(waited.status).toBe(200);
    const task = (waited.body.data as { tasks: DelegatedTaskView[] }).tasks[0] as DelegatedTaskView;
    expect(task).toMatchObject({ id: started.taskId, state: "result_available", outcome: "done", asking: null });
    expect(task.result?.finalText).toContain("Echo: explain the build");
    expect(task.result?.error).toBeNull();

    // task_status on the same task says the same thing, and an unknown id is a 404.
    const status = await call(agent, token, "task_status", { taskId: started.taskId });
    expect((status.body.data as { tasks: DelegatedTaskView[] }).tasks[0]?.outcome).toBe("done");
    expect((await call(agent, token, "task_status", { taskId: "ffff" })).status).toBe(404);
  });

  it("cancels a running child, and a second cancel is the same answer", async () => {
    const { app, agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "slow work on the parser" });
    const first = await call(agent, token, "task_cancel", { taskId: started.taskId });
    expect(first.status).toBe(200);
    const cancelled = (first.body.data as { task: DelegatedTaskView }).task;
    expect(cancelled).toMatchObject({ state: "result_available", outcome: "cancelled" });
    const second = await call(agent, token, "task_cancel", { taskId: started.taskId });
    expect(second.status).toBe(200);
    expect((second.body.data as { task: DelegatedTaskView }).task).toEqual(cancelled);
    // Nobody was watching, so the child chat was closed rather than left running.
    expect(app.manager.list().some((c) => c.chatId === started.childChatId)).toBe(false);
  });

  it("serves a chat's rows to its panel, and cancels one from the browser", async () => {
    const { app, agent, chat, ws, token } = await setup();
    const none = await agent.get(`/api/chats/${chat.chatId}/tasks`);
    expect(none.status).toBe(200);
    expect(none.body).toEqual({ tasks: [] });

    const started = await delegate(agent, token, { brief: "slow work behind the panel", title: "Panel row" });
    const listed = (await agent.get(`/api/chats/${chat.chatId}/tasks`)).body as { tasks: DelegatedTaskView[] };
    expect(listed.tasks.map((task) => task.id)).toEqual([started.taskId]);
    expect(listed.tasks[0]).toMatchObject({ title: "Panel row", state: "working" });

    const stopped = await agent.post(`/api/chats/${chat.chatId}/tasks/${started.taskId}/cancel`).send({});
    expect(stopped.status).toBe(200);
    expect(stopped.body.task).toMatchObject({ id: started.taskId, state: "result_available", outcome: "cancelled" });
    // A second click is the same answer rather than an error.
    const again = await agent.post(`/api/chats/${chat.chatId}/tasks/${started.taskId}/cancel`).send({});
    expect(again.body.task).toEqual(stopped.body.task);

    // Refusals are the tool's own codes: an id nobody has, and a task of another chat.
    const unknown = await agent.post(`/api/chats/${chat.chatId}/tasks/ffff/cancel`).send({});
    expect(unknown.status).toBe(404);
    expect(unknown.body.code).toBe("unknown_task");
    const other = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const second = await delegate(agent, token, { brief: "a task the other chat cannot stop", title: "Not yours" });
    const refused = await agent.post(`/api/chats/${other.chatId}/tasks/${second.taskId}/cancel`).send({});
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("not_your_task");
    expect(app.manager.get(second.childChatId as string).status).not.toBe("disposed");
  });

  it("returns the same task for a repeated clientRequestId", async () => {
    const { app, agent, token } = await setup();
    const one = await delegate(agent, token, { brief: "check the lockfile", clientRequestId: "round-1" });
    const two = await delegate(agent, token, { brief: "check the lockfile", clientRequestId: "round-1" });
    expect(two.taskId).toBe(one.taskId);
    const children = app.manager.list().filter((c) => c.lineage?.taskId === one.taskId);
    expect(children).toHaveLength(1);
  });

  it("starts one child when two calls with the same clientRequestId are in flight together", async () => {
    const { app, agent, token } = await setup();
    const [one, two] = await Promise.all([
      call(agent, token, "delegate_task", { brief: "check the lockfile", clientRequestId: "round-2" }),
      call(agent, token, "delegate_task", { brief: "check the lockfile", clientRequestId: "round-2" }),
    ]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(two.body.data.taskId).toBe(one.body.data.taskId);
    expect(app.manager.list().filter((c) => c.lineage?.taskId === one.body.data.taskId)).toHaveLength(1);
  });

  it("will not hand a restricted chat's work to a harness that has no permission modes", async () => {
    const { app, agent, token } = await setup();
    // fake-b stands in for a harness (Hermes, say) whose sessions cannot be held to a mode.
    const other = app.registry.get("fake-b");
    if (!other) throw new Error("fake-b is not registered");
    (other.capabilities as { supportsPermissionMode: boolean }).supportsPermissionMode = false;
    const res = await call(agent, token, "delegate_task", { brief: "edit things", harness: "fake-b" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("mode_escalation_denied");
  });

  it("refuses past the chat's live-task cap", async () => {
    const { agent, token } = await setup();
    // Each child parks on an approval, so none of them settles while the cap is counted.
    for (let i = 0; i < 4; i++) await delegate(agent, token, { brief: `ask before reviewing number ${i}` });
    const fifth = await call(agent, token, "delegate_task", { brief: "ask before reviewing number 5" });
    expect(fifth.status).toBe(429);
    expect(fifth.body).toMatchObject({ ok: false, code: "too_many_tasks" });
  });

  it("refuses a grandchild that would go past the depth cap", async () => {
    const { app, agent, token } = await setup();
    const child = await delegate(agent, token, { brief: "first level" });
    const grandchild = await delegate(agent, tokenOf(app, child.childChatId as string), { brief: "second level" });
    // The grandchild is depth 2: it may not delegate again.
    const deeper = await call(agent, tokenOf(app, grandchild.childChatId as string), "delegate_task", { brief: "third level" });
    expect(deeper.status).toBe(429);
    expect(deeper.body).toMatchObject({ ok: false, code: "max_depth" });
  });

  it("keeps the lineage and the parent's task list across a close and a resume", async () => {
    const { app, agent, ws, chat, token } = await setup();
    const started = await delegate(agent, token, { brief: "check the changelog" });
    await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });
    const child = app.manager.list().find((c) => c.chatId === started.childChatId);
    if (!child?.sessionId) throw new Error("the child chat was never given a session");
    const childSession = child.sessionId;
    const parentSession = app.manager.list().find((c) => c.chatId === chat.chatId)?.sessionId;
    await agent.post(`/api/chats/${child.chatId}/dispose`).send({});
    await agent.post(`/api/chats/${chat.chatId}/dispose`).send({});

    // Both are ordinary sessions: resuming one re-reads what the records say it is.
    const resumedChild = (await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: childSession })).body as ChatSnapshot;
    expect(resumedChild.chatId).not.toBe(child.chatId);
    expect(resumedChild.lineage).toMatchObject({ kind: "delegate", taskId: started.taskId, depth: 1 });
    if (parentSession) {
      const resumedParent = (await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: parentSession })).body as ChatSnapshot;
      expect(resumedParent.delegated?.map((task) => task.id)).toContain(started.taskId);
    }
  });

  it("fails the call when the task record cannot be written", async () => {
    const { app, agent, token, chat } = await setup();
    // A file where the store's folder goes: every write fails, so nothing may report success.
    mkdirSync(app.stateDir, { recursive: true });
    writeFileSync(path.join(app.stateDir, "orchestration"), "");
    const before = app.manager.list().length;
    const res = await call(agent, token, "delegate_task", { brief: "should never start" });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ ok: false, code: "store_failed" });
    // No child was spawned for a task that was never recorded.
    expect(app.manager.list().length).toBe(before);
    expect(app.manager.list().some((c) => c.lineage !== undefined)).toBe(false);
    const parentSnap = (await agent.get(`/api/chats/${chat.chatId}`)).body as ChatSnapshot;
    expect(parentSnap.delegated).toBeUndefined();
  });
});

/** Wait until `check` holds, or fail: the timers here are real, so every wait has a cap. */
async function waitUntil(check: () => boolean, timeoutMs = 8000, what = "condition"): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The report prompts the orchestrator delivered into a chat, oldest first. */
function reportPrompts(app: TestApp, chatId: string): string[] {
  return app.manager
    .get(chatId)
    .snapshot()
    .items.flatMap((item) => (item.kind === "user" && item.text.includes("[awui delegate") ? [item.text] : []));
}

/** One task record as the store's file keeps it: what a limit test reads back from disk. */
interface StoredRecord {
  id: string;
  state: string;
  outcome: string | null;
  wake: { pendingSince: number | null; skipped: string | null };
  result: { error: string | null } | null;
}

function taskRecords(app: TestApp): StoredRecord[] {
  try {
    return (JSON.parse(readFileSync(path.join(app.stateDir, "orchestration", "tasks.json"), "utf8")) as { tasks: StoredRecord[] }).tasks;
  } catch {
    return [];
  }
}

/** One decision record as the store's file keeps it: what a decision test reads back from disk. */
interface StoredDecisionRecord {
  id: string;
  decisionId: string;
  taskId: string;
  state: string;
  outcome: string | null;
  denialReason: string | null;
  answer: { kind: string; confirmed?: boolean; value?: string } | null;
}

function decisionRecords(app: TestApp): StoredDecisionRecord[] {
  try {
    return (JSON.parse(readFileSync(path.join(app.stateDir, "orchestration", "decisions.json"), "utf8")) as { decisions: StoredDecisionRecord[] }).decisions;
  } catch {
    return [];
  }
}

describe("thread_read", () => {
  it("reads a child's transcript just described, newest last and in pages", async () => {
    const { agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "tool read the readme" });
    await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });

    const read = await call(agent, token, "thread_read", { taskId: started.taskId });
    expect(read.status).toBe(200);
    const page = read.body.data as { task: DelegatedTaskView; items: ChatItem[]; truncated: boolean };
    expect(page.task).toMatchObject({ id: started.taskId, outcome: "done" });
    // Reading order: the prompt first, then the call the child made, then its answer.
    expect(page.items[0]?.kind).toBe("user");
    expect(page.items.some((item) => item.kind === "tool")).toBe(true);
    expect(page.items[page.items.length - 1]?.kind).toBe("assistant");
    expect(page.truncated).toBe(false);
    expect(read.body.text).toContain(`Task ${started.taskId}`);
    expect(read.body.text).toContain("Tool read");

    // Two items at a time: the older ones are left out, and `before` walks back through them.
    const newest = await call(agent, token, "thread_read", { taskId: started.taskId, limit: 2 });
    const newestPage = newest.body.data as { items: ChatItem[]; truncated: boolean };
    expect(newestPage.items).toHaveLength(2);
    expect(newestPage.truncated).toBe(true);
    expect(newestPage.items.map((item) => item.id)).toEqual(page.items.slice(-2).map((item) => item.id));
    const older = await call(agent, token, "thread_read", { taskId: started.taskId, limit: 2, before: 2 });
    const olderPage = older.body.data as { items: ChatItem[]; truncated: boolean };
    expect(olderPage.items.map((item) => item.id)).toEqual(page.items.slice(-4, -2).map((item) => item.id));
    // Once the first page reaches the start, there is nothing more to ask for.
    const whole = await call(agent, token, "thread_read", { taskId: started.taskId, limit: 200 });
    expect((whole.body.data as { truncated: boolean }).truncated).toBe(false);
  });

  it("lists shared profiles and applies the chosen model and thinking to its child", async () => {
    const folder = tempDir("awui-shared-profiles-");
    mkdirSync(folder, { recursive: true });
    const profile = "agent_profiles:\n  - name: Review team\n    harness: fake\n    model: fake/slow\n    thinking: high\n    note: Careful reviewer, changes only after evidence.\n";
    writeFileSync(path.join(folder, "config.yml"), profile);
    const t = await makeTestApp({ configDir: folder });
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body;
    const answer = await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id });
    const own = t.manager.get(answer.body.chatId);
    const listed = await call(agent, tokenOf(t, own.chatId), "list_profiles", {});
    expect(listed.body.data.profiles.find((p: { id: string }) => p.id === "shared:Review team")).toMatchObject({ model: "fake/slow", thinkingLevel: "high" });
    await waitUntil(() => own.snapshot().config.permissionMode === "default");
    const started = await call(agent, tokenOf(t, own.chatId), "delegate_task", { brief: "review this shared profile", profile: "Review team", title: "Shared profile test" });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const child = t.manager.get(started.body.data.childChatId);
    await waitUntil(() => child.status === "idle");
    expect(child.adapter.id).toBe("fake");
    await waitUntil(() => child.snapshot().config.model === "fake/slow");
    expect(child.adapter.id).toBe("fake");
    expect(child.snapshot().config.thinkingLevel).toBe("high");
    await child.dispose("test");
  });

  it("saves and edits a lead/worker plan through the chat route, and requires confirm to run", async () => {
    const { app, agent, chat } = await setup();
    const created = await agent.post(`/api/chats/${chat.chatId}/plans`).send({ title: "Review-first split", maxParallel: 1, tasks: [{ id: "inspect", prompt: "inspect the failing cases", isolation: "worktree", writeScope: ["tests/**"] }] });
    expect(created.status).toBe(201);
    expect(created.body.data.plan.status).toBe("draft");
    expect(app.manager.list().filter((c) => c.lineage?.kind === "delegate")).toHaveLength(0);
    const edited = await agent.post(`/api/chats/${chat.chatId}/plans`).send({
      title: "Review-first split", maxParallel: 1, planId: created.body.data.plan.id,
      tasks: [{ id: "inspect", prompt: "slow inspect the failing cases", title: "Inspect", writeScope: ["tests/**"] }],
    });
    expect(edited.body.data.plan.tasks[0].prompt).toBe("slow inspect the failing cases");
    const denied = await agent.post("/api/chats/a-dead-id/plans/confirm").send({ planId: created.body.data.plan.id });
    expect(denied.status).toBe(404);
    const confirmed = await agent.post(`/api/chats/${chat.chatId}/plans/confirm`).send({ planId: created.body.data.plan.id });
    expect(confirmed.status).toBe(200);
    const parent = app.manager.get(chat.chatId);
    await waitUntil(() => parent.snapshot().plan?.taskIds.inspect !== undefined);
    expect(app.manager.list().some((c) => c.lineage?.taskId === parent.snapshot().plan?.taskIds.inspect)).toBe(true);
  });

  it("records a denial's explanation, and refuses to attach it to approval", async () => {
    const { app, agent } = await setup();
    const { current: chat } = { current: app.manager.list()[0] };
    if (!chat) throw new Error("no parent chat");
    const wrong = await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "ask before saving", mode: "normal" });
    expect(wrong.status).toBe(202);
    await waitUntil(() => chat.snapshot().pending.length === 1);
    const requestId = chat.snapshot().pending[0]!.id;
    const wrongReason = await agent.post(`/api/chats/${chat.chatId}/requests/${requestId}`).send({ answer: { kind: "confirm", confirmed: true }, denialReason: "Not relevant" });
    expect(wrongReason.status).toBe(400);
    expect(wrongReason.body.code).toBe("bad_denial_reason");
    const response = await agent.post(`/api/chats/${chat.chatId}/requests/${requestId}`).send({ answer: { kind: "confirm", confirmed: false }, denialReason: "Use the smaller patch instead." });
    expect(response.status).toBe(200);
    const record = chat.snapshot().items.find((item): item is Extract<ChatItem, { kind: "request" }> => item.kind === "request" && item.request.id === requestId);
    expect(record).toMatchObject({ outcome: "Denied", denialReason: "Use the smaller patch instead." });
  });

  it("delivers a worker's denial reason as a corrective next turn", async () => {
    const { app, agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "ask before rewriting the test" });
    await waitUntil(() => app.manager.get(started.childChatId as string).snapshot().pending.length === 1);
    const child = app.manager.get(started.childChatId as string);
    const requestId = child.snapshot().pending[0]!.id;
    const response = await agent.post(`/api/chats/${child.chatId}/requests/${requestId}`).send({ answer: { kind: "confirm", confirmed: false }, denialReason: "Keep the existing assertion and explain why." });
    expect(response.status).toBe(200);
    await waitUntil(() => child.snapshot().items.some((item) => item.kind === "user" && item.source === "agent" && item.text.includes("Keep the existing assertion")), 8000, "the corrective worker turn");
    const denied = child.snapshot().items.find((item): item is Extract<ChatItem, { kind: "request" }> => item.kind === "request");
    expect(denied?.denialReason).toBe("Keep the existing assertion and explain why.");
    await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });
    const task = await call(agent, token, "task_status", { taskId: started.taskId });
    // The denied attempt's fatal error stays a failure even though the corrective turn started successfully.
    expect(task.body.data.tasks[0].outcome).toBe("failed");
  });

  it("leaves an ordinary chat's denial recorded without an extra prompt", async () => {
    const { app, agent } = await setup();
    const chat = app.manager.list()[0]!;
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "ask before editing", mode: "normal" });
    await waitUntil(() => chat.snapshot().pending.length === 1);
    await agent.post(`/api/chats/${chat.chatId}/requests/${chat.snapshot().pending[0]!.id}`).send({ answer: { kind: "confirm", confirmed: false }, denialReason: "Do not edit this file" }).expect(200);
    await waitUntil(() => chat.status === "idle");
    expect(chat.userTurns().some((text) => text.startsWith("The person denied"))).toBe(false);
  });

  it("edits a worker plan, starts only independent workers, then waits for a dependency", async () => {
    const { app, agent, chat, token } = await setup();
    const plan = await call(agent, token, "plan_workers", {
      action: "save", title: "Build, then document", maxParallel: 1,
      tasks: [
        { id: "build", prompt: "slow build", title: "Build", writeScope: ["src/**"] },
        { id: "docs", prompt: "write the docs", title: "Docs", dependsOn: ["build"], writeScope: ["docs/**"] },
      ],
    });
    const id = plan.body.data.plan.id as string;
    const sse = openSse(app, chat.chatId, agent.cookie);
    const confirmed = await call(agent, token, "plan_workers", { action: "confirm", planId: id });
    expect(confirmed.body.data.plan.taskIds.docs).toBeUndefined();
    for (const event of sse.chatEvents()) console.log("SSEEVENT", JSON.stringify(event));
    await sse.waitFor(() => app.manager.get(chat.chatId).snapshot().plan?.status === "review", 10_000);
    const assigned = app.manager.get(chat.chatId).snapshot().plan!.taskIds;
    expect(assigned.docs).toBeDefined();
    expect(app.manager.list().some((c) => c.lineage?.taskId === assigned.build)).toBe(true);
    expect(app.manager.list().some((c) => c.lineage?.taskId === assigned.docs)).toBe(true);
    expect((await call(agent, token, "plan_workers", { action: "confirm", planId: id })).status).toBe(409);
    sse.close();
  }, 20_000);

  it("direct probe of failing child's done semantics", async () => {
    const { agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "fail" });
    expect(started.childChatId).not.toBeNull();
    const waited = await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });
    expect(waited.body.data.tasks[0]).toMatchObject({ outcome: "failed", result: { error: "Fake failure" } });
  });

  it("stops a dependent plan after a worker fails, leaving later tasks unstarted", async () => {
    const { app, agent, token } = await setup();
    const plan = await call(agent, token, "plan_workers", {
      action: "save", title: "Fail before docs", maxParallel: 1,
      tasks: [{ id: "fail", prompt: "fail" }, { id: "docs", prompt: "never start docs", dependsOn: ["fail"] }],
    });
    const id = plan.body.data.plan.id as string;
    await call(agent, token, "plan_workers", { action: "confirm", planId: id });
    await waitUntil(() => {
      const stored = JSON.parse(readFileSync(path.join(app.stateDir, "orchestration", "plans.json"), "utf8")).plans as Array<{ id: string; status: string; note?: string }>;
      const record = stored.find((p) => p.id === id);
      return record?.status === "failed";
    }, 10_000, `plan records worker failure: ${JSON.stringify((await call(agent, token, "task_status", {})).body)}`);
    expect(app.manager.list().some((c) => c.lineage?.parentTitle === "never start docs")).toBe(false);
    const stored = JSON.parse(readFileSync(path.join(app.stateDir, "orchestration", "plans.json"), "utf8")).plans.find((p: { title: string }) => p.title === "Fail before docs") as { note: string; taskIds: Record<string, string>; status: string };
    expect(stored.taskIds.docs).toBeUndefined();
    expect(stored.note).toContain("Later workers did not start");
  });

  it("refuses to edit somebody else's plan or to start overlapping writers", async () => {
    const { app, agent, token } = await setup();
    const other = await call(agent, tokenOf(app, app.manager.list()[0]!.chatId), "delegate_task", { brief: "summarise a document" });
    const parentId = (other.body.data as { taskId: string }).taskId;
    const second = await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: (await agent.post("/api/workspaces/open").send({ path: app.project })).body.id });
    const foreign = await call(agent, tokenOf(app, second.body.chatId), "plan_workers", { action: "save", title: "Other", maxParallel: 1, tasks: [{ id: "one", prompt: "read the file" }] });
    const id = foreign.body.data.plan.id as string;
    expect((await call(agent, token, "plan_workers", { action: "cancel", planId: id })).body.code).toBe("unknown_plan");
    expect(parentId).toBeDefined();
    const collision = await call(agent, token, "plan_workers", { action: "save", title: "Collision", maxParallel: 2, tasks: [{ id: "a", prompt: "change A", writeScope: ["src/**"] }, { id: "b", prompt: "change B", writeScope: ["src/a.ts"] }] });
    expect(collision.status, JSON.stringify(collision.body)).toBe(422);
    expect(collision.body.code).toBe("scope_collision");
  });

  it("reads a closed child's chat from the harness's file, and says so when there is none", async () => {
    const { app, agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "explain the build" });
    await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });
    const child = app.manager.get(started.childChatId as string);
    const session = child.sessionId;
    await agent.post(`/api/chats/${child.chatId}/dispose`).send({});

    // The chat is gone, but the fake keeps the session it wrote: the read comes from there.
    const closed = await call(agent, token, "thread_read", { taskId: started.taskId });
    expect(closed.status).toBe(200);
    expect(closed.body.text).toContain("Echo: explain the build");
    expect((closed.body.data as { items: ChatItem[] }).items.length).toBeGreaterThan(0);

    // No file either: the record's own answer is all a parent can be given, and it says so.
    if (session) app.fake.sessions.delete(session.slice("fake:".length));
    const missing = await call(agent, token, "thread_read", { taskId: started.taskId });
    expect(missing.status).toBe(200);
    const data = missing.body.data as { items: ChatItem[]; truncated: boolean };
    expect(data.items).toEqual([]);
    expect(data.truncated).toBe(true);
    expect(missing.body.text).toContain("cannot be read");
    expect(missing.body.text).toContain("Echo: explain the build");
  });
});

describe("write scopes", () => {
  it("carries the assignment envelope in the brief and the note on the record", async () => {
    const { app, agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "unsafe edit the parser", writeScope: ["src/**"], title: "Scoped parser" });
    await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });

    // The brief the worker saw carries the machine-readable contract between the markers,
    // after the brief's own text (quoted markers broken first, so it cannot forge one).
    const child = app.manager.get(started.childChatId as string);
    const brief = child.snapshot().items.find((i): i is Extract<ChatItem, { kind: "user" }> => i.kind === "user" && i.text.includes("unsafe edit the parser"));
    expect(brief).toBeTruthy();
    if (!brief) throw new Error("the brief never echoed");
    expect(brief.text.startsWith("<<<AWUI_BOARD_CONTROL")).toBe(false);
    expect(brief.text).toContain("<<<AWUI_BOARD_CONTROL");
    expect(brief.text).toContain('"action": "assignment"');
    expect(brief.text).toContain('"src/**"');

    // The record's view carries the scope, and thread_read's answer names it.
    const status = await call(agent, token, "task_status", { taskId: started.taskId });
    const data = status.body.data as { tasks: Array<{ scope: { globs: string[] } | null }> };
    expect(data.tasks[0]?.scope).toMatchObject({ globs: ["src/**"] });
  });

  it("blocks an unsafe write on a capable harness, and counts it", async () => {
    const { app, agent, token } = await setup();
    // The child parks on the approval the fake raises before its write; the guard denies
    // the ask before the tool runs, and the fake records the denial.
    const started = await delegate(agent, token, { brief: "unsafe work on the parser", writeScope: ["src/**"] });
    await waitUntil(() => taskRecords(app).find((r) => r.id === started.taskId)?.outcome !== null, 10_000, "the task to settle");
    const record = taskRecords(app).find((r) => r.id === started.taskId);
    expect(record?.outcome).toBe("done");

    // The guard saw the write and refused the ask: the record counts one blocked write.
    const status = await call(agent, token, "task_status", { taskId: started.taskId });
    const data = status.body.data as { tasks: Array<{ scope: { attempted: number; blocked: number; landed: number; recent: string[] } | null }> };
    const scope = data.tasks[0]?.scope;
    expect(scope).toMatchObject({ attempted: 1, blocked: 1, landed: 0 });
    expect(scope?.recent[0]).toContain("blocked");
    expect(scope?.recent[0]).toContain("src/**");
  });

  it("reports a landed out-of-scope write on an incapable harness, and never claims it was blocked", async () => {
    const { app, agent, token } = await setup();
    // fake-b cannot take interactive asks: no pre-emption is possible, so the write lands
    // and the honest half is detection. The record says "reported, not blocked".
    const other = app.registry.get("fake-b");
    if (!other) throw new Error("fake-b is not registered");
    (other.capabilities as { supportsInteractiveRequests: boolean }).supportsInteractiveRequests = false;
    // A child inherits the caller's mode; fake-b has no permission modes to rank, so this
    // chat starts in its broadest mode before the delegation.
    const chat = app.manager.list().find((c) => c.orchestration?.token === token);
    if (!chat) throw new Error("no chat for the token");
    await chat.setConfig({ permissionMode: "bypass" });
    const started = await delegate(agent, token, { brief: "unsafe work on the parser", writeScope: ["src/**"], harness: "fake-b" });
    await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });

    const status = await call(agent, token, "task_status", { taskId: started.taskId });
    const data = status.body.data as { tasks: Array<{ scope: { attempted: number; blocked: number; landed: number; recent: string[] } | null }> };
    const scope = data.tasks[0]?.scope;
    expect(scope).toMatchObject({ attempted: 1, blocked: 0, landed: 1 });
    expect(scope?.recent[0]).toContain("reported, not blocked");
    expect(scope?.recent[0]).not.toContain("blocked outside");
  });

  it("re-arms the write scope when a finished task is revived", async () => {
    const { app, agent, token } = await setup();
    // The first run's out-of-scope write is refused before the tool runs.
    const started = await delegate(agent, token, { brief: "unsafe work on the parser", writeScope: ["src/**"] });
    await waitUntil(() => taskRecords(app).find((r) => r.id === started.taskId)?.outcome !== null, 10_000, "the first settle");
    const first = await call(agent, token, "task_status", { taskId: started.taskId });
    const scopeOf = (res: Awaited<ReturnType<typeof call>>) => (res.body.data as { tasks: Array<{ scope: { attempted: number; blocked: number; landed: number } | null }> }).tasks[0]?.scope;
    expect(scopeOf(first)).toMatchObject({ attempted: 1, blocked: 1, landed: 0 });

    // A follow-up run on the same task is held to the same scope: the guard went with the
    // watcher, so thread_send re-arms it. Without that the second ask waits for a person
    // and its write is neither refused nor counted.
    const revived = await call(agent, token, "thread_send", { taskId: started.taskId, text: "unsafe work on the lexer" });
    expect(revived.body.data).toMatchObject({ queued: "sent", state: "working" });
    await waitUntil(() => taskRecords(app).find((r) => r.id === started.taskId)?.outcome !== null, 10_000, "the revived settle");
    const second = await call(agent, token, "task_status", { taskId: started.taskId });
    expect(scopeOf(second)).toMatchObject({ attempted: 2, blocked: 2, landed: 0 });
  });

  it("answers bad_scope for a pattern holding .., and leaves the child unspawned", async () => {
    const { app, agent, token } = await setup();
    const res = await call(agent, token, "delegate_task", { brief: "should never start", writeScope: ["../outside/**"] });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ ok: false, code: "bad_scope" });
    expect(res.body.message).toContain("..");
    expect(app.manager.list().some((c) => c.lineage !== undefined)).toBe(false);
  });
});

describe("thread_send", () => {
  it("steers a running child, then revives a finished one for a second result", async () => {
    const { agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "slow review of the parser" });
    const steered = await call(agent, token, "thread_send", { taskId: started.taskId, text: "also check the lexer" });
    expect(steered.status).toBe(200);
    expect(steered.body.data).toMatchObject({ queued: "steered", state: "working" });

    // The run it was in carries the steer: the child answers it before settling.
    const first = await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });
    expect((first.body.data as { tasks: DelegatedTaskView[] }).tasks[0]?.result?.finalText).toContain("Steered: also check the lexer");

    // A finished task goes back to work, and this settle replaces the old result.
    const revived = await call(agent, token, "thread_send", { taskId: started.taskId, text: "and the changelog" });
    expect(revived.body.data).toMatchObject({ queued: "sent", state: "working" });
    const second = await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });
    const task = (second.body.data as { tasks: DelegatedTaskView[] }).tasks[0] as DelegatedTaskView;
    expect(task).toMatchObject({ state: "result_available", outcome: "done" });
    expect(task.result?.finalText).toContain("Echo: and the changelog");
  });

  it("refuses a task whose chat is closed", async () => {
    const { agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "check the lockfile" });
    await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });
    await agent.post(`/api/chats/${started.childChatId}/dispose`).send({});
    const refused = await call(agent, token, "thread_send", { taskId: started.taskId, text: "one more thing" });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ ok: false, code: "task_not_running" });
  });

  it("refuses a delegated worker a heartbeat of its own", async () => {
    const { app, agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "check the lockfile" });
    await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });
    // The child is a live chat with its own orchestration token, and a heartbeat it
    // scheduled would prompt it after its task settled: no watcher, no guard, nothing owed.
    const childToken = tokenOf(app, String(started.childChatId));
    const refused = await call(agent, childToken, "schedule_heartbeat", { name: "later", prompt: "carry on", intervalMs: 300_000 });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ ok: false, code: "delegated_caller" });
    // The chat that owns the work schedules one for itself as before.
    const allowed = await call(agent, token, "schedule_heartbeat", { name: "later", prompt: "carry on", intervalMs: 300_000 });
    expect(allowed.status).toBe(200);
  });
});

describe("finish delivery", () => {
  it("wakes an idle parent with one bounded report", async () => {
    const { app, agent, chat, token } = await setup();
    const started = await delegate(agent, token, { brief: "check the changelog", title: "Changelog check" });
    await waitUntil(() => reportPrompts(app, chat.chatId).length > 0, 8000, "the parent's report");
    const reports = reportPrompts(app, chat.chatId);
    expect(reports).toHaveLength(1);
    const report = reports[0] as string;
    expect(report).toMatch(/^\[awui delegate [0-9a-f]{4} · done · fake · /);
    expect(report).toContain(started.taskId);
    expect(report).toContain('"Changelog check"');
    expect(report).toContain("Echo: check the changelog");
    expect(report).toContain(`thread_read("${started.taskId}") for more`);
    expect(report.length).toBeLessThanOrEqual(6000);
  });

  it("coalesces three near-simultaneous finishes into one message", async () => {
    const { app, agent, chat, token } = await setup();
    const tasks = [];
    for (const role of ["one", "two", "three"]) tasks.push(await delegate(agent, token, { brief: `check the lockfile ${role}`, title: `Check ${role}` }));
    await waitUntil(() => reportPrompts(app, chat.chatId).length > 0, 8000, "one report for three tasks");
    // Nothing more arrives: the window closed after the first report carried all three.
    await sleep(600);
    const reports = reportPrompts(app, chat.chatId);
    expect(reports).toHaveLength(1);
    for (const task of tasks) expect(reports[0]).toContain(`[awui delegate ${task.taskId} ·`);
  });

  it("does not wake a parent that read the result itself", async () => {
    const { app, agent, chat, token } = await setup();
    const started = await delegate(agent, token, { brief: "check the changelog" });
    const waited = await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });
    expect((waited.body.data as { tasks: DelegatedTaskView[] }).tasks[0]?.outcome).toBe("done");
    // Past the coalescing window: the read was the delivery, so nothing is sent.
    await sleep(3000);
    expect(reportPrompts(app, chat.chatId)).toEqual([]);
    const store = JSON.parse(readFileSync(path.join(app.stateDir, "orchestration", "tasks.json"), "utf8")) as { tasks: Array<{ id: string; wake: { pendingSince: number | null; skipped: string | null } }> };
    expect(store.tasks.find((task) => task.id === started.taskId)?.wake).toMatchObject({ pendingSince: null, skipped: "read by the parent" });
  });

  it("delivers a restart's interrupted report once, when its parent registers", async () => {
    const root = tempDir("awui-orch-restart-");
    mkdirSync(path.join(root, "proj"));
    const manager = new ChatManager();
    const registry = new HarnessRegistry();
    const fake = new FakeAdapter();
    registry.register(fake);
    await registry.refreshStatus();
    const { workspaces } = await Workspaces.create([root], root);
    const workspace: WorkspaceInfo = { id: "w1", path: path.join(root, "proj"), name: "proj" };
    try {
      const parent = await manager.create(fake, workspace);
      expect(parent.sessionId).not.toBeNull();
      const file = path.join(root, ".state", "orchestration", "tasks.json");
      mkdirSync(path.dirname(file), { recursive: true });
      // A record the last process left mid-run: its child died with that process.
      writeFileSync(
        file,
        JSON.stringify({
          schemaVersion: 1,
          tasks: [
            {
              id: "beef",
              parentChatId: "gone",
              childChatId: null,
              title: "Parser work",
              harnessId: "fake",
              model: null,
              role: "",
              profile: null,
              depth: 1,
              state: "working",
              outcome: null,
              createdAt: Date.now() - 60_000,
              endedAt: null,
              activity: null,
              result: null,
              asking: null,
              workspacePath: workspace.path,
              parentTitle: "Parent",
              parentSessionId: parent.sessionId,
              childSessionId: "fake:gone-session",
              generation: 0,
              cancelRequestedAt: null,
              notify: "wake",
              clientRequestId: null,
              wake: { pendingSince: null, deliveredAt: null, attempts: 0, skipped: null },
            },
          ],
        }),
      );
      const orchestration = new Orchestrator({ chats: manager, registry, workspaces, file, limits: () => DEFAULT_ORCHESTRATION_LIMITS, log: () => undefined });
      await orchestration.start();
      await orchestration.registered(parent);
      await waitUntil(() => parent.snapshot().items.some((item) => item.kind === "user" && item.text.includes("[awui delegate beef")), 4000, "the interrupted report");
      const report = parent.snapshot().items.flatMap((item) => (item.kind === "user" ? [item.text] : [])).find((text) => text.includes("[awui delegate beef"));
      expect(report).toContain("interrupted");
      expect(report).toContain("restarted before this task settled");
      // Registering again (another tab, a resume) is not a second delivery.
      await orchestration.registered(parent);
      await sleep(300);
      expect(parent.snapshot().items.filter((item) => item.kind === "user").map((item) => item.text).filter((text) => text.includes("[awui delegate beef"))).toHaveLength(1);
      // The ledger is stamped on disk, so a restart would not deliver it again.
      type Ledger = { tasks: Array<{ id: string; state: string; outcome: string; wake: { pendingSince: number | null; deliveredAt: number | null } }> };
      const read = () => {
        try {
          return JSON.parse(readFileSync(file, "utf8")) as Ledger;
        } catch {
          return null;
        }
      };
      await waitUntil(() => read()?.tasks[0]?.wake.pendingSince === null, 4000, "the delivered wake's record");
      const store = read() as Ledger;
      expect(store.tasks[0]).toMatchObject({ state: "result_available", outcome: "interrupted" });
      expect(typeof store.tasks[0]?.wake.deliveredAt).toBe("number");
    } finally {
      await manager.shutdown();
    }
  });

  it("keeps a child's done note off the phone, and sends its question", async () => {
    const { app, agent, token } = await setup();
    const done = await delegate(agent, token, { brief: "check the changelog" });
    await call(agent, token, "thread_wait", { taskIds: [done.taskId], waitMs: 10_000 });
    let notes = (await agent.get("/api/notifications?since=0")).body.notes as PushNote[];
    expect(notes.some((note) => note.chatId === done.childChatId)).toBe(false);

    const asking = await delegate(agent, token, { brief: "ask before reviewing the parser" });
    await waitUntil(() => app.manager.get(asking.childChatId as string).snapshot().pending.length > 0, 8000, "the child's approval");
    notes = (await agent.get("/api/notifications?since=0")).body.notes as PushNote[];
    expect(notes.find((note) => note.chatId === asking.childChatId)?.kind).toBe("ask");
  });
});

describe("question routing", () => {
  it("ends a wait with the question's title, never its body", async () => {
    const { agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "quiz described the settings question" });
    const waited = await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });
    expect(waited.status).toBe(200);
    const data = waited.body.data as { tasks: DelegatedTaskView[]; pendingRequest?: { taskId: string; requestId: string | null; title: string } };
    expect(data.tasks[0]).toMatchObject({ id: started.taskId, state: "waiting_for_user" });
    expect(data.pendingRequest).toMatchObject({ taskId: started.taskId, title: "Settings" });
    expect(data.pendingRequest?.requestId).toBeTruthy();
    expect(waited.body.text).toContain('Task ' + started.taskId + ' is asking: "Settings"');
    // The request's own message is for the user, not for the parent agent.
    expect(waited.body.text).not.toContain("Should the theme and the text size both move");
  });

  it("does not end a wait on an approval the user already sees", async () => {
    const { agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "ask before reviewing the parser" });
    const began = Date.now();
    const waited = await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 600 });
    expect(Date.now() - began).toBeGreaterThanOrEqual(550);
    const data = waited.body.data as { tasks: DelegatedTaskView[]; pendingRequest?: unknown };
    expect(data.tasks[0]?.state).toBe("working");
    expect(data.pendingRequest).toBeUndefined();
  });
});

describe("turned off", () => {
  it("gives no tools and answers orch_off when it is turned off", async () => {
    const app = await makeTestApp({ orchestrationLimits: { enabled: false } });
    t = app;
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as WorkspaceInfo;
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    // No token is minted, so the child is spawned with no tools at all.
    expect(app.manager.get(chat.chatId).orchestration).toBeUndefined();
    // Every route says why, whatever token is offered, and the catalogue is refused too.
    const refused = await agent.post("/api/orchestration/call").set("x-awui-orch-token", "0".repeat(32)).send({ tool: "list_profiles", args: {} });
    expect(refused.status).toBe(404);
    expect(refused.body).toMatchObject({ ok: false, code: "orch_off" });
    const catalogue = await agent.get("/api/orchestration/tools").set("x-awui-orch-token", "0".repeat(32));
    expect(catalogue.status).toBe(404);
    expect(catalogue.body).toMatchObject({ code: "orch_off" });
  });
});

describe("cancel cascade", () => {
  it("cancels a task's own delegates before the task itself", async () => {
    const { app, agent, token } = await setup();
    const child = await delegate(agent, token, { brief: "slow review of the parser" });
    const grandchild = await delegate(agent, tokenOf(app, child.childChatId as string), { brief: "slow review of the lexer" });
    // Record the order the child chats are stopped in: the deeper one must go first.
    const order: string[] = [];
    for (const id of [child.childChatId, grandchild.childChatId]) {
      const chat = app.manager.get(id as string);
      const abort = chat.abort.bind(chat);
      chat.abort = async () => {
        order.push(chat.chatId);
        return abort();
      };
    }
    const cancelled = await call(agent, token, "task_cancel", { taskId: child.taskId });
    expect(cancelled.status).toBe(200);
    expect(order).toEqual([grandchild.childChatId, child.childChatId]);
    // Both records are terminal, and a second cancel is the same answer.
    expect(taskRecords(app).filter((task) => task.state === "result_available").map((task) => task.id)).toEqual(expect.arrayContaining([child.taskId, grandchild.taskId]));
    const again = await call(agent, token, "task_cancel", { taskId: child.taskId });
    expect(again.status).toBe(200);
    expect((again.body.data as { task: DelegatedTaskView }).task).toMatchObject({ state: "result_available", outcome: "cancelled" });
  });

  it("answers cancel_timeout when a stuck child will not stop, and records the cancel anyway", async () => {
    const { app, agent, token } = await setup({ fakeStopDelayMs: 6_000 });
    const started = await delegate(agent, token, { brief: "slow work on the parser" });
    const cancelled = await call(agent, token, "task_cancel", { taskId: started.taskId });
    expect(cancelled.status).toBe(504);
    expect(cancelled.body).toMatchObject({ ok: false, code: "cancel_timeout" });
    expect(cancelled.body.message).toContain("still stopping");
    // The record is honest about the half-stopped state: nothing claims to be running.
    const status = await call(agent, token, "task_status", { taskId: started.taskId });
    expect((status.body.data as { tasks: DelegatedTaskView[] }).tasks[0]).toMatchObject({ state: "result_available", outcome: "cancelled" });
    expect(taskRecords(app).find((task) => task.id === started.taskId)?.state).toBe("result_available");
  });
});

describe("the wall clock", () => {
  it("stops a task that passes its wall clock, and records the reason", async () => {
    const { app, agent, token } = await setup({ chunkDelayMs: 50, orchestrationLimits: { taskWallClockMs: 2_000 } });
    const started = await delegate(agent, token, { brief: "slow work on the parser" });
    const waited = await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 15_000 });
    const task = (waited.body.data as { tasks: DelegatedTaskView[] }).tasks[0] as DelegatedTaskView;
    expect(task.state).toBe("result_available");
    // Nobody asked for this stop, so it is a failure with the configured wall clock in the words.
    expect(task.outcome).toBe("failed");
    expect(task.result?.error).toBe(`wall clock exceeded (${formatElapsed(2_000)})`);
    // The wait read the failure itself, so the ledger records the read instead of a second report.
    await waitUntil(() => taskRecords(app).find((record) => record.id === started.taskId)?.wake.skipped === "read by the parent", 4_000, "the ledger's read mark");
  });
});

describe("budgets", () => {
  it("refuses more than callsPerMinute calls from one chat, then lets it call again", async () => {
    const { agent, token } = await setup({ orchestrationLimits: { callsPerMinute: 3 } });
    for (let i = 0; i < 3; i++) expect((await call(agent, token, "task_status", {})).status).toBe(200);
    const over = await call(agent, token, "task_status", {});
    expect(over.status).toBe(429);
    expect(over.body).toMatchObject({ ok: false, code: "too_many_calls" });
    expect(over.body.message).toContain("try again in");
    // A minute later the window has moved past those calls.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(Date.now() + 61_000);
      expect((await call(agent, token, "task_status", {})).status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips a wake and says so when wakes are off", async () => {
    const { app, agent, chat, token } = await setup({ orchestrationLimits: { wakeParents: false } });
    const started = await delegate(agent, token, { brief: "check the changelog" });
    // Reading the result does not overwrite the reason: there was never a pending report.
    await call(agent, token, "thread_wait", { taskIds: [started.taskId], waitMs: 10_000 });
    await sleep(3000);
    expect(reportPrompts(app, chat.chatId)).toEqual([]);
    expect(taskRecords(app).find((task) => task.id === started.taskId)?.wake).toMatchObject({ pendingSince: null, skipped: "wakes are off" });
  });

  it("spends a parent's hourly wake budget, and its results stay readable", async () => {
    const { app, agent, chat, token } = await setup({ orchestrationLimits: { maxWakesPerHour: 1 } });
    await delegate(agent, token, { brief: "check the changelog", title: "First" });
    await waitUntil(() => reportPrompts(app, chat.chatId).length === 1, 8_000, "the first report");
    const second = await delegate(agent, token, { brief: "check the lockfile", title: "Second" });
    await waitUntil(() => taskRecords(app).some((task) => task.id === second.taskId && task.wake.skipped === "wake budget used up"), 10_000, "the second report to be skipped");
    expect(reportPrompts(app, chat.chatId)).toHaveLength(1);
    // The budget only silences the prompt: the parent can still ask, and gets the result.
    const read = await call(agent, token, "task_status", { taskId: second.taskId });
    expect((read.body.data as { tasks: DelegatedTaskView[] }).tasks[0]).toMatchObject({ state: "result_available", outcome: "done" });
  });
});

describe("decision gates", () => {
  it("parks a delegated worker's decision, records the person's answer, and returns it to the caller", async () => {
    const { app, agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "slow pick the migration approach" });
    const child = app.manager.get(started.childChatId as string);
    // The call parks: it answers only after the person answers, not before.
    const workerToken = tokenOf(app, started.childChatId as string);
    const parked = call(agent, workerToken, "request_decision", { question: "Which migration approach?", kind: "select", options: ["Expand and contract", "Big bang"], decisionId: "approach" });
    void parked.then(() => undefined);
    await waitUntil(() => child.snapshot().pending.some((r) => r.id.startsWith("dc-")), 4_000, "the decision question on the worker's chat");
    const requestId = child.snapshot().pending.find((r) => r.id.startsWith("dc-"))!.id;
    const answer = await agent.post(`/api/chats/${child.chatId}/requests/${requestId}`).send({ answer: { kind: "select", value: "Expand and contract" } });
    expect(answer.status).toBe(200);
    const done = await parked;
    expect(done.status).toBe(200);
    expect(done.body.text).toContain('answered "Expand and contract"');
    const data = done.body.data as { decision: { decisionId: string; state: string; answer: { kind: string; value: string }; outcome: string } };
    expect(data.decision).toMatchObject({ decisionId: "approach", state: "answered", outcome: "Chose “Expand and contract”" });
    // The transcript item keeps the answer beside the question, as any request's outcome does.
    const record = child.snapshot().items.find((item) => item.kind === "request" && item.request.id === requestId) as Extract<ChatItem, { kind: "request" }> | undefined;
    expect(record?.outcome).toBe("Chose “Expand and contract”");
    // The record keeps the decision on disk, under its own decisions file, not the task records;
    // the persist rides beside the answer, so the read waits for it.
    await waitUntil(() => decisionRecords(app).find((decision) => decision.decisionId === "approach")?.state === "answered", 4_000, "the answered decision's record");
    expect(decisionRecords(app).find((decision) => decision.decisionId === "approach")).toMatchObject({ state: "answered" });
  });

  it("records a denial's corrective reason and returns it beside the verdict", async () => {
    const { app, agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "slow rewrite the parser" });
    const child = app.manager.get(started.childChatId as string);
    const workerToken = tokenOf(app, started.childChatId as string);
    const parked = call(agent, workerToken, "request_decision", { question: "Rewrite the parser now?", decisionId: "rewrite" });
    void parked.then(() => undefined);
    await waitUntil(() => child.snapshot().pending.some((r) => r.id.startsWith("dc-")), 4_000, "the decision question");
    const requestId = child.snapshot().pending.find((r) => r.id.startsWith("dc-"))!.id;
    const wrong = await agent.post(`/api/chats/${child.chatId}/requests/${requestId}`).send({ answer: { kind: "confirm", confirmed: true }, denialReason: "Not relevant" });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe("bad_denial_reason");
    const answered = await agent.post(`/api/chats/${child.chatId}/requests/${requestId}`).send({ answer: { kind: "confirm", confirmed: false }, denialReason: "Keep the existing assertion and explain why." });
    expect(answered.status).toBe(200);
    const done = await parked;
    expect(done.status).toBe(200);
    expect(done.body.text).toContain("denied");
    expect(done.body.text).toContain("Keep the existing assertion and explain why.");
    const data = done.body.data as { decision: { denialReason: string | null; outcome: string } };
    expect(data.decision).toMatchObject({ denialReason: "Keep the existing assertion and explain why.", outcome: "Denied" });
  });

  it("returns the recorded answer to a retry with the same decisionId, and asks once", async () => {
    const { app, agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "slow pick the migration approach" });
    const child = app.manager.get(started.childChatId as string);
    const workerToken = tokenOf(app, started.childChatId as string);
    const first = call(agent, workerToken, "request_decision", { question: "Which migration approach?", kind: "select", options: ["Expand and contract", "Big bang"], decisionId: "approach" });
    void first.then(() => undefined);
    await waitUntil(() => child.snapshot().pending.some((r) => r.id.startsWith("dc-")), 4_000, "the decision question");
    const requestId = child.snapshot().pending.find((r) => r.id.startsWith("dc-"))!.id;
    await agent.post(`/api/chats/${child.chatId}/requests/${requestId}`).send({ answer: { kind: "select", value: "Expand and contract" } });
    expect((await first).status).toBe(200);
    await waitUntil(() => decisionRecords(app).find((decision) => decision.decisionId === "approach")?.state === "answered", 4_000, "the answered decision's record");
    // The retry answers at once from the record: no second question is raised.
    const retry = await call(agent, workerToken, "request_decision", { question: "Which migration approach?", kind: "select", options: ["Expand and contract", "Big bang"], decisionId: "approach" });
    expect(retry.status).toBe(200);
    expect((retry.body.data as { decision: { state: string } }).decision.state).toBe("answered");
    expect(child.snapshot().pending.filter((r) => r.id.startsWith("dc-"))).toHaveLength(0);
    expect(child.snapshot().items.filter((item) => item.kind === "request" && item.request.id.startsWith("dc-"))).toHaveLength(1);
  });

  it("parks a pending repeat until the person answers, without raising a second question", async () => {
    const { app, agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "slow pick the migration approach" });
    const child = app.manager.get(started.childChatId as string);
    const workerToken = tokenOf(app, started.childChatId as string);
    const parked = call(agent, workerToken, "request_decision", { question: "Which migration approach?", kind: "select", options: ["A", "B"], decisionId: "approach", waitMs: 8_000 });
    void parked.then(() => undefined);
    await waitUntil(() => child.snapshot().pending.some((r) => r.id.startsWith("dc-")), 4_000, "the decision question");
    const requestId = child.snapshot().pending.find((r) => r.id.startsWith("dc-"))!.id;
    const repeat = call(agent, workerToken, "request_decision", { question: "Which migration approach?", kind: "select", options: ["A", "B"], decisionId: "approach", waitMs: 8_000 });
    void repeat.then(() => undefined);
    await agent.post(`/api/chats/${child.chatId}/requests/${requestId}`).send({ answer: { kind: "select", value: "A" } });
    expect((await repeat).body.data as { decision: { state: string } }).toBeTruthy();
    expect((await parked).status).toBe(200);
    expect(child.snapshot().pending.filter((r) => r.id.startsWith("dc-"))).toHaveLength(0);
  });

  it("leaves the decision pending after the cap, with the question still on the chat", async () => {
    const { app, agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "slow pick the migration approach" });
    const child = app.manager.get(started.childChatId as string);
    const began = Date.now();
    const workerToken = tokenOf(app, started.childChatId as string);
    const parked = await call(agent, workerToken, "request_decision", { question: "Which migration approach?", decisionId: "approach", waitMs: 300 });
    expect(Date.now() - began).toBeGreaterThanOrEqual(280);
    expect(parked.status).toBe(200);
    expect((parked.body.data as { state: string }).state).toBe("pending");
    expect(parked.body.text).toContain("still waiting for the person");
    // The record keeps the question: the person can still answer it, and the caller can ask again.
    expect(child.snapshot().pending.some((r) => r.id.startsWith("dc-"))).toBe(true);
  });

  it("denies a cross-agent answer: another chat cannot answer the worker's decision", async () => {
    const { app, agent, token, ws } = await setup();
    const started = await delegate(agent, token, { brief: "slow pick the migration approach" });
    const child = app.manager.get(started.childChatId as string);
    const workerToken = tokenOf(app, started.childChatId as string);
    const parked = call(agent, workerToken, "request_decision", { question: "Which migration approach?", decisionId: "approach", waitMs: 6_000 });
    void parked.then(() => undefined);
    await waitUntil(() => child.snapshot().pending.some((r) => r.id.startsWith("dc-")), 4_000, "the decision question");
    // A second delegated worker (a sibling) answers the first worker's decision.
    const sibling = await delegate(agent, token, { brief: "check the changelog" });
    const siblingChat = app.manager.get(sibling.childChatId as string);
    const requestId = child.snapshot().pending.find((r) => r.id.startsWith("dc-"))!.id;
    const foreign = await agent.post(`/api/chats/${siblingChat.chatId}/requests/${requestId}`).send({ answer: { kind: "confirm", confirmed: true } });
    expect(foreign.status).toBe(409);
    // The parked call is still waiting: the record says pending, and the question is still on the chat.
    expect(decisionRecords(app).find((decision) => decision.decisionId === "approach")).toMatchObject({ state: "pending" });
    expect(child.snapshot().pending.some((r) => r.id === requestId)).toBe(true);
    expect(siblingChat.chatId).not.toBe(child.chatId);
    // The person answers on the worker's own chat; the parked call returns.
    await agent.post(`/api/chats/${child.chatId}/requests/${requestId}`).send({ answer: { kind: "confirm", confirmed: false } });
    expect((await parked).status).toBe(200);
    void ws;
  });

  it("refuses the tool from an ordinary chat that is not a delegated worker", async () => {
    const { app, agent } = await setup();
    const chat = app.manager.list()[0]!;
    const refused = await agent.post("/api/orchestration/call").set("x-awui-orch-token", app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token ?? "").send({ tool: "request_decision", args: { question: "Which?", decisionId: "x" } });
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ ok: false, code: "not_delegated" });
  });

  it("answers a select decision with fewer than two options as a bad request", async () => {
    const { app, agent, token } = await setup();
    const started = await delegate(agent, token, { brief: "slow pick the migration approach" });
    const workerToken = tokenOf(app, started.childChatId as string);
    const invalid = await call(agent, workerToken, "request_decision", { question: "Which?", kind: "select", options: ["Only one"], decisionId: "x" });
    expect(invalid.status).toBe(400);
    void started;
  });

  it("keeps an unresolved decision across a restart, never auto-answers it, and re-raises the question", async () => {
    const root = tempDir("awui-decision-restart-");
    mkdirSync(path.join(root, "proj"), { recursive: true });
    const manager = new ChatManager();
    const registry = new HarnessRegistry();
    const fake = new FakeAdapter();
    registry.register(fake);
    await registry.refreshStatus();
    const { workspaces } = await Workspaces.create([root], root);
    const workspace: WorkspaceInfo = { id: "w1", path: path.join(root, "proj"), name: "proj" };
    try {
      const parent = await manager.create(fake, workspace);
      const file = path.join(root, ".state", "orchestration", "decisions.json");
      mkdirSync(path.dirname(file), { recursive: true });
      const childChatId = "gone-chat";
      // A decision still pending when the last process stopped: the person never answered it.
      writeFileSync(
        file,
        JSON.stringify({
          schemaVersion: 1,
          decisions: [
            {
              id: "dcbeef01",
              decisionId: "approach",
              taskId: "beef",
              parentChatId: "gone",
              childChatId,
              childSessionId: "fake:gone-session",
              question: "Which migration approach?",
              message: null,
              kind: "confirm",
              options: [],
              state: "pending",
              answer: null,
              outcome: null,
              denialReason: null,
              createdAt: Date.now() - 60_000,
              answeredAt: null,
            },
          ],
        }),
      );
      const orchestration = new Orchestrator({ chats: manager, registry, workspaces, file, decisionsFile: file, limits: () => DEFAULT_ORCHESTRATION_LIMITS, log: () => undefined });
      await orchestration.start();
      // The worker's session, as the last process left it: the fake keeps one per native id, and
      // the resume's readTranscript also proves the session is this project's.
      (fake as unknown as { sessions: Map<string, { nativeId: string; cwd: string; title: string; messages: unknown[]; updatedAt: Date }> }).sessions.set("gone-session", {
        nativeId: "gone-session",
        cwd: workspace.path,
        title: "Parser work",
        messages: [{ timestamp: Date.now(), role: "user", content: "pick the approach" }],
        updatedAt: new Date(),
      });
      // Nothing auto-answered it: the record stands as it was written.
      const readBack = () => {
        try {
          return (JSON.parse(readFileSync(file, "utf8")) as { decisions: Array<{ id: string; state: string; answer: unknown; outcome: string | null }> }).decisions;
        } catch {
          return null;
        }
      };
      expect(readBack()?.[0]).toMatchObject({ id: "dcbeef01", state: "pending", answer: null, outcome: null });
      // A worker chat for this session is opened again (a resume): the gate is installed on it,
      // and registering it re-raises the question from the record.
      const resumed = await manager.resume(fake, workspace, "gone-session");
      expect(resumed.chatId).not.toBe(childChatId);
      // The gate is installed by the registration below, as app.ts wires it for every chat.
      expect(resumed.decisionGate).toBeUndefined();
      await orchestration.registered(resumed);
      expect(resumed.decisionGate).toBeDefined();
      const requestId = resumed.snapshot().pending.find((r) => r.id.startsWith("dc-"))?.id;
      expect(requestId).toBe("dc-dcbeef01");
      // The person answers the re-raised question on the resumed chat: the recorded verdict lands,
      // and the record on disk says answered with the outcome.
      const outcome = resumed.answer("dc-dcbeef01", { kind: "confirm", confirmed: true });
      expect(outcome).toBe("Approved");
      await waitUntil(() => readBack()?.[0]?.state === "answered", 4_000, "the answered decision's record");
      expect(readBack()?.[0]).toMatchObject({ id: "dcbeef01", state: "answered", outcome: "Approved" });
    } finally {
      await manager.shutdown();
    }
  });
});
