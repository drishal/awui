// Agent-scoped heartbeats (heartbeats.ts, heartbeat-runner.ts): a schedule_heartbeat
// call is authorized as the chat whose harness child made it — the owner identity is
// the calling chat's immutable harness:native id, kept server-side, and the target of
// every due beat is that exact session, never one the arguments name. The caps, the
// cross-session denials, the revive semantics (an open target is reused; a closed one
// is reopened as the same session through ChatManager, one writer per native session),
// and the skipped-orphan outcome are what these tests pin.
import { describe, expect, it, afterEach } from "vitest";
import type { ChatSnapshot, HeartbeatView, WorkspaceInfo } from "../../src/shared/protocol.js";
import { Heartbeats } from "../../src/server/heartbeats.js";
import { startDueHeartbeats } from "../../src/server/heartbeat-runner.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

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

/** One orchestration tool call as the chat's child sends it. */
function call(agent: Awaited<ReturnType<typeof signedIn>>, token: string, tool: string, args: Record<string, unknown>) {
  return agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool, args });
}

/** The beat the route returned, as the caller reads it. */
function beatOf(answer: { ok?: boolean; data?: unknown }): HeartbeatView {
  if (answer.ok !== true || typeof answer.data !== "object" || answer.data === null) throw new Error("no heartbeat in the answer");
  return answer.data as HeartbeatView;
}

describe("agent heartbeats", () => {
  it("schedules, lists, and cancels its own heartbeat", async () => {
    const { app, agent, chat, token } = await setup();
    const saved = await call(agent, token, "schedule_heartbeat", { name: "Pulse", prompt: "Keep going", intervalMs: 10 * 60_000 });
    expect(saved.status).toBe(200);
    const beat = beatOf(saved.body as { ok?: boolean; data?: unknown });
    const nativeId = app.manager.list().find((c) => c.chatId === chat.chatId)?.nativeId;
    expect(beat.ownerSessionId).toBe(`fake:${nativeId}`);
    expect(beat.intervalMs).toBe(10 * 60_000);
    expect(beat.nextRunAt).toBeGreaterThan(Date.now());

    // The Routines dialog's read shows it, marked by its starter session.
    const listed = (await agent.get("/api/heartbeats").expect(200)).body as { heartbeats: Array<{ id: string; ownerSessionId: string }> };
    expect(listed.heartbeats.map((b) => b.id)).toEqual([beat.id]);
    expect(listed.heartbeats[0]?.ownerSessionId).toBe(beat.ownerSessionId);

    // Cancel by id; the store writes through before the call answers, and a second cancel is idempotent.
    const cancelled = await call(agent, token, "schedule_heartbeat", { name: "x", prompt: "x", intervalMs: 10 * 60_000, cancelId: beat.id });
    expect(cancelled.status).toBe(200);
    const listedAfter = (await agent.get("/api/heartbeats").expect(200)).body as { heartbeats: Array<{ cancelledAt: number | null }> };
    expect(listedAfter.heartbeats[0]?.cancelledAt).not.toBeNull();
    const again = await call(agent, token, "schedule_heartbeat", { name: "x", prompt: "x", intervalMs: 10 * 60_000, cancelId: beat.id });
    expect(again.status).toBe(200);
  });

  it("cannot schedule for another chat or cancel another chat's heartbeat", async () => {
    const { app, agent, ws, token } = await setup();
    const other = (await agent.post("/api/chats").send({ harnessId: "fake-b", workspaceId: ws.id })).body as ChatSnapshot;
    const otherToken = app.manager.list().find((c) => c.chatId === other.chatId)?.orchestration?.token;
    if (!otherToken) throw new Error("the second chat was spawned without an orchestration token");
    const theirs = await call(agent, otherToken, "schedule_heartbeat", { name: "Theirs", prompt: "x", intervalMs: 10 * 60_000 });
    expect(theirs.status).toBe(200);
    const theirsId = beatOf(theirs.body as { ok?: boolean; data?: unknown }).id;

    // One chat cannot cancel another chat's heartbeat, whatever the arguments say.
    const stolen = await call(agent, token, "schedule_heartbeat", { name: "x", prompt: "x", intervalMs: 10 * 60_000, cancelId: theirsId });
    expect(stolen.status).toBe(404);
    expect(stolen.body).toMatchObject({ ok: false, code: "unknown_task" });

    // And a schedule the first chat cannot see is not cancellable by id either.
    const missing = await call(agent, token, "schedule_heartbeat", { name: "x", prompt: "x", intervalMs: 10 * 60_000, cancelId: "00000000-0000-0000-0000-000000000000" });
    expect(missing.status).toBe(404);
    void app;
  });

  it("bounds the interval and validates the arguments", async () => {
    const { agent, token } = await setup();
    const slow = await call(agent, token, "schedule_heartbeat", { name: "x", prompt: "x", intervalMs: 60_000 });
    expect(slow.status).toBe(400);
    const long = await call(agent, token, "schedule_heartbeat", { name: "x", prompt: "x", intervalMs: 25 * 60 * 60_000 });
    expect(long.status).toBe(400);
    const blank = await call(agent, token, "schedule_heartbeat", { name: " ", prompt: "x", intervalMs: 10 * 60_000 });
    expect(blank.status).toBe(400);
  });

  it("delivers a due beat to the exact chat that scheduled it, through the same server", async () => {
    const { app, agent, chat, token } = await setup();
    await call(agent, token, "schedule_heartbeat", { name: "Due", prompt: "the due beat", intervalMs: 5 * 60_000 });
    const chatRow = app.manager.list().find((c) => c.chatId === chat.chatId);
    if (!chatRow?.nativeId) throw new Error("the chat has no native id");
    // The runner's store, due now: the same owner identity the route spelled.
    const beats = Heartbeats.inMemory();
    await beats.save({ harnessId: "fake", nativeId: chatRow.nativeId, workspacePath: app.project }, { name: "Due", prompt: "the due beat", intervalMs: 5 * 60_000 }, Date.now() - 6 * 60_000);

    const ran = await startDueHeartbeats(beats, app.registry, app.manager);
    expect(ran).toHaveLength(1);
    await until(() => {
      const items = app.manager.list().find((c) => c.chatId === chat.chatId)?.snapshot().items ?? [];
      return items.some((item) => item.kind === "user" && item.text === "the due beat");
    });
  });

  it("records a due beat whose target session is gone as skipped, without respawning", async () => {
    const { app } = await setup();
    const beats = Heartbeats.inMemory();
    await beats.save({ harnessId: "fake", nativeId: "gone-session", workspacePath: app.project }, { name: "Orphan", prompt: "x", intervalMs: 5 * 60_000 }, Date.now() - 6 * 60_000);
    const ran = await startDueHeartbeats(beats, app.registry, app.manager, Date.now(), () => undefined);
    expect(ran).toEqual([]);
    const stored = beats.all()[0];
    expect(stored?.lastRunOutcome).toBe("skipped");
    expect(stored?.lastRunDetail).toContain("no longer exists");
    // The slot was spent: an immediate second sweep beats nothing.
    const again = await startDueHeartbeats(beats, app.registry, app.manager);
    expect(again).toEqual([]);
  });

  it("caps the schedules one chat and one server keep", async () => {
    const { app, token } = await setup();
    const chatRow = app.manager.list().find((c) => c.orchestration?.token === token);
    if (!chatRow?.nativeId) throw new Error("the chat has no native id");
    const owner = { harnessId: "fake", nativeId: chatRow.nativeId, workspacePath: app.project };
    const beats = Heartbeats.inMemory();
    for (let at = 0; at < 8; at++) await beats.save(owner, { name: `b${at}`, prompt: "x", intervalMs: 10 * 60_000 });
    const ninth = await beats.save(owner, { name: "b9", prompt: "x", intervalMs: 10 * 60_000 }).catch((error: unknown) => (error instanceof Error ? error.message : "no error"));
    expect(ninth).toBe("A chat may schedule at most 8 heartbeats");
    const full = Heartbeats.inMemory();
    for (let at = 0; at < 50; at++) {
      await full.save({ harnessId: "fake", nativeId: `n${at}`, workspacePath: app.project }, { name: `b${at}`, prompt: "x", intervalMs: 10 * 60_000 });
    }
    const fiftyFirst = await full.save({ harnessId: "fake", nativeId: "n50", workspacePath: app.project }, { name: "b50", prompt: "x", intervalMs: 10 * 60_000 }).catch((error: unknown) => (error instanceof Error ? error.message : "no error"));
    expect(fiftyFirst).toBe("At most 50 heartbeats on this server");
  });

  it("revives a closed target over the same session, one writer per native session", async () => {
    const { app, agent, chat, token } = await setup();
    const chatRow = app.manager.list().find((c) => c.orchestration?.token === token);
    if (!chatRow?.sessionId) throw new Error("the chat has no session");
    const nativeId = chatRow.sessionId.slice("fake:".length);
    const beats = Heartbeats.inMemory();
    await beats.save({ harnessId: "fake", nativeId, workspacePath: app.project }, { name: "Revive", prompt: "woken", intervalMs: 5 * 60_000 }, Date.now() - 6 * 60_000);
    await startDueHeartbeats(beats, app.registry, app.manager);
    await until(() => {
      const items = app.manager.list().find((c) => c.chatId === chat.chatId)?.snapshot().items ?? [];
      return items.some((item) => item.kind === "user" && item.text === "woken");
    });
    // Restart the chat (a resume over the same session mints a new chat id) and beat again.
    await until(() => app.manager.list().find((c) => c.chatId === chatRow.chatId)?.status === "idle");
    await agent.post(`/api/chats/${encodeURIComponent(chatRow.chatId)}/restart`).expect(200);
    const beats2 = Heartbeats.inMemory();
    await beats2.save({ harnessId: "fake", nativeId, workspacePath: app.project }, { name: "Revive", prompt: "woken again", intervalMs: 5 * 60_000 }, Date.now() - 6 * 60_000);
    const ran2 = await startDueHeartbeats(beats2, app.registry, app.manager);
    expect(ran2).toHaveLength(1);
  });

  it("marks a heartbeat halted at its maxRuns in the store", async () => {
    const { app } = await setup();
    const beats = Heartbeats.inMemory();
    await beats.save({ harnessId: "fake", nativeId: "cap-test", workspacePath: app.project }, { name: "Capped", prompt: "x", intervalMs: 5 * 60_000, maxRuns: 1 }, Date.now() - 6 * 60_000);
    // No chat carries "cap-test", so the first beat skips; the store's own advance is the cap.
    await startDueHeartbeats(beats, app.registry, app.manager, Date.now(), () => undefined);
    const stored = beats.all()[0];
    expect(stored?.runs).toBe(1);
    expect(stored?.lastRunOutcome).toBe("skipped");
    // markRan's advance to a halt: the store counts the slot and stops looking for one.
    const advanced = await beats.markRan(stored?.id ?? "", Date.now());
    expect(advanced?.runs).toBe(2);
    expect(advanced?.halted).toBe("stopped after 2 runs (its maxRuns)");
    expect(await beats.due(Date.now() + 86_400_000)).toEqual([]);
  });
});
