// A room's run path end to end through the real routes and FakeAdapter: a bare
// message reaches only the lead, mentions run exactly those bots in room rank
// order, a second message queues behind the active turn, Stop aborts and
// suppresses late work, and a restart marks old work interrupted instead of
// resuming it.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/app.js";
import { RoomManager } from "../../src/server/boards/manager.js";
import { Workspaces } from "../../src/server/workspaces.js";
import { BoardStoreImpl } from "../../src/server/boards/store.js";
import { agent, botRuns, makeBot, makeRoom, openProject, openRoomSse, patchMember, send, snapshot, waitRecords, waitUntil } from "../helpers/board.js";
import type { RoomRecord } from "../../src/shared/protocol.js";

describe("board runs", () => {
  it("runs only the lead for a bare message and records a settled bot_run", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake", role: "lead" });
      const scout = await makeBot(a, { name: "Scout", harnessId: "fake", role: "researcher" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }, { botId: scout.id, handle: "scout" }]);
      const sse = openRoomSse(t, room.room.id, a.cookie);
      await send(a, room.room.id, "hello room");
      const snap = await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).some((run) => run.status === "done"));
      const runs = botRuns(snap);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.memberId).toBe(room.room.members[0]?.id);
      expect(runs[0]?.items.some((item) => item.kind === "assistant" && item.text.includes("Echo from Atlas"))).toBe(true);
      expect(snap.activeTurn).toBeNull();
      await sse.waitFor(() => sse.roomEvents().some((event) => event.type === "record"));
      sse.close();
    } finally {
      await t.close();
    }
  });

  it("runs exactly the mentioned bots, in room rank order, even when the mention order differs", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const scout = await makeBot(a, { name: "Scout", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [
        { botId: lead.id, handle: "atlas", rank: 0 },
        { botId: scout.id, handle: "scout", rank: 1 },
      ]);
      const [atlas, scoutMember] = room.room.members;
      const sent = await send(a, room.room.id, "roomtwice", [scoutMember!.id, atlas!.id]);
      expect(sent.turn.state).toBe("queued");
      const snap = await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 2);
      const runs = botRuns(snap);
      expect(runs.map((run) => run.memberId)).toEqual([atlas!.id, scoutMember!.id]);
      expect(runs[0]?.items.some((item) => item.kind === "assistant" && item.text.includes("Answer from Atlas"))).toBe(true);
      expect(runs[1]?.items.some((item) => item.kind === "assistant" && item.text.includes("Answer from Scout"))).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("rejects unknown, disabled, duplicated, and missing-lead mentions instead of fanning out", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const scout = await makeBot(a, { name: "Scout", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [
        { botId: lead.id, handle: "atlas", rank: 0 },
        { botId: scout.id, handle: "scout", rank: 1 },
      ]);
      const [atlas, scoutMember] = room.room.members;
      expect((await a.post(`/api/rooms/${room.room.id}/messages`).send({ text: "x", mentions: ["nope"] })).status).toBe(400);
      expect((await a.post(`/api/rooms/${room.room.id}/messages`).send({ text: "x", mentions: [atlas!.id, atlas!.id] })).status).toBe(400);
      await patchMember(a, room.room.id, scoutMember!.id, { enabled: false });
      expect((await a.post(`/api/rooms/${room.room.id}/messages`).send({ text: "x", mentions: [scoutMember!.id] })).status).toBe(400);
      // Disabling the only canLead member leaves no lead: a bare message explains rather than running anyone.
      await patchMember(a, room.room.id, atlas!.id, { enabled: false });
      const bare = await a.post(`/api/rooms/${room.room.id}/messages`).send({ text: "x", mentions: [] });
      expect(bare.status).toBe(409);
      expect(bare.body.code).toBe("no_lead");
    } finally {
      await t.close();
    }
  });

  it("keeps one active turn per room, queues the next, and answers a retried clientId with the first turn", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      const first = await send(a, room.room.id, "slow", [], "client-1");
      const retried = await send(a, room.room.id, "slow", [], "client-1");
      expect(retried.turn.id).toBe(first.turn.id);
      const second = await send(a, room.room.id, "queued behind it");
      expect(second.queued.map((turn) => turn.id)).toContain(second.turn.id);
      const running = await waitRecords(a, room.room.id, (s) => s.activeTurn !== null && s.queued.length >= 1);
      expect(running.activeTurn?.text).toBe("slow");
      expect(running.records.filter((record) => record.kind === "user")).toHaveLength(2);
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 2);
    } finally {
      await t.close();
    }
  });

  it("stops the active turn, aborts its bot, drops the queue, and records partial work as stopped", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      await send(a, room.room.id, "slow");
      await send(a, room.room.id, "never runs");
      await waitRecords(a, room.room.id, (s) => s.activeTurn !== null && s.queued.length === 1);
      const stopped = await a.post(`/api/rooms/${room.room.id}/stop`);
      expect(stopped.status).toBe(200);
      const snap = await waitRecords(a, room.room.id, (s) => s.activeTurn === null);
      expect(snap.queued).toHaveLength(0);
      expect(botRuns(snap).every((run) => run.status === "stopped")).toBe(true);
      expect(snap.records.some((record) => record.kind === "notice" && /queued turn/.test(record.text))).toBe(true);
      // Nothing queued survives Stop: its turn is recorded as stopped and never ran.
      expect(snap.records.some((record) => record.kind === "notice" && /Stopped 1 queued turn/.test(record.text))).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("shows a running bot_run record before the answer, and settles it in place", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      const sse = openRoomSse(t, room.room.id, a.cookie);
      await send(a, room.room.id, "slow");
      const running = await waitRecords(a, room.room.id, (s) => botRuns(s).some((run) => run.status === "running"));
      const live = botRuns(running).find((run) => run.status === "running");
      expect(live?.id).toBe(live?.invocationId);
      expect(running.activeTurn?.state).toBe("running");
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).every((run) => run.status === "done"));
      await sse.waitFor(() => sse.roomEvents().filter((event) => event.type === "record" && (event.record as { kind?: string }).kind === "bot_run").length >= 1);
      const recordEvents = sse.roomEvents().filter((event) => event.type === "record" && (event.record as { kind?: string }).kind === "bot_run");
      const first = recordEvents[0]?.record as { status: string } | undefined;
      expect(first?.status).toBe("running");
      sse.close();
    } finally {
      await t.close();
    }
  });

  it("applies and confirms the bot's model and effort before the prompt", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake", model: "fake/slow", thinkingLevel: "high" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      await send(a, room.room.id, "hello");
      const snap = await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 1);
      const run = botRuns(snap)[0];
      expect(run?.model).toBe("fake/slow");
      expect(run?.thinkingLevel).toBe("high");
      const owned = t.manager.list().find((chat) => chat.owner);
      expect(owned?.snapshot().config).toMatchObject({ model: "fake/slow", thinkingLevel: "high" });
      // A profile edit is applied on the next invocation, not by rewriting the room.
      await a.patch(`/api/bots/${lead.id}`).send({ model: "fake/echo", thinkingLevel: "low" });
      await send(a, room.room.id, "again");
      const second = await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 2);
      expect(botRuns(second)[1]?.model).toBe("fake/echo");
      expect(botRuns(second)[1]?.thinkingLevel).toBe("low");
    } finally {
      await t.close();
    }
  });

  it("fails an invocation visibly when the profile's model is no longer accepted", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      await a.patch(`/api/bots/${lead.id}`).send({ model: "fake/gone" });
      await send(a, room.room.id, "hello");
      const snap = await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 1);
      const run = botRuns(snap)[0];
      expect(run?.status).toBe("failed");
      expect(run?.error).toContain("Unknown model");
      expect(snap.activeTurn).toBeNull();
    } finally {
      await t.close();
    }
  });

  it("cancels one queued turn without touching the active one", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      await send(a, room.room.id, "slow");
      const queued = await send(a, room.room.id, "cancel me");
      await waitRecords(a, room.room.id, (s) => s.queued.some((turn) => turn.id === queued.turn.id));
      const cancelled = await a.delete(`/api/rooms/${room.room.id}/queue/${queued.turn.id}`);
      expect(cancelled.status).toBe(200);
      expect(cancelled.body.queued).toHaveLength(0);
      const active = await waitRecords(a, room.room.id, (s) => s.activeTurn !== null);
      const onActive = await a.delete(`/api/rooms/${room.room.id}/queue/${active.activeTurn!.id}`);
      expect(onActive.status).toBe(409);
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 1);
    } finally {
      await t.close();
    }
  });

  it("sends room-level notes for a finished turn, a failure, and a pending request — not per-chat news", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      await send(a, room.room.id, "hello");
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 1);
      // The settled runtime is durable before the note goes out, so the note can land a moment after the turn clears.
      await expect.poll(() => t.boardNotes.some((note) => note.kind === "done" && note.roomId === room.room.id)).toBe(true);
      await send(a, room.room.id, "ask");
      const asking = await waitRecords(a, room.room.id, (s) => s.pending.length > 0);
      expect(t.boardNotes.some((note) => note.kind === "ask" && note.request?.id === asking.pending[0]?.id)).toBe(true);
      // The ordinary chat's news hook is not involved: no note names a chat id or a session id.
      const notes = await a.get("/api/notifications").query({ since: 0 });
      expect((notes.body.notes as Array<{ sessionId: string | null }>).every((note) => note.sessionId === null)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("prunes a request when its turn ends without an answer", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      // The fake's ask waits for an answer forever; the turn's wall clock is what ends it,
      // and the card must not outlive the turn (a phantom "waiting for you").
      await a.patch(`/api/rooms/${room.room.id}`).send({ budgets: { turnWallClockMs: 10_000 } });
      await send(a, room.room.id, "ask");
      const asking = await waitRecords(a, room.room.id, (s) => s.pending.length > 0);
      expect(asking.pending).toHaveLength(1);
      const ended = await waitRecords(a, room.room.id, (s) => s.activeTurn === null, 25_000);
      expect(ended.pending).toHaveLength(0);
    } finally {
      await t.close();
    }
  }, 30_000);

  it("reports a harness that refuses to stop within the teardown bound", async () => {
    const t = await makeTestApp({ fakeStopDelayMs: 6_000 });
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      await send(a, room.room.id, "slow");
      await waitUntil(() => t.manager.list().some((chat) => chat.owner && chat.status === "running"));
      const stopped = await a.post(`/api/rooms/${room.room.id}/stop`);
      expect(stopped.status).toBe(200);
      const snap = await waitRecords(a, room.room.id, (s) => s.activeTurn === null && s.records.some((record) => record.kind === "notice" && /Stop did not finish cleanly/.test(record.text)));
      expect(snap.records.some((record) => record.kind === "bot_run" && record.status === "stopped")).toBe(true);
    } finally {
      await t.close();
    }
  }, 20_000);

  it("refuses to edit, remove, disable, or reset a member while its bot is running", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      const member = room.room.members[0]!;
      await send(a, room.room.id, "slow");
      await waitUntil(() => t.manager.list().some((chat) => chat.owner && chat.status === "running"));
      expect((await a.patch(`/api/bots/${lead.id}`).send({ name: "Renamed" })).status).toBe(409);
      expect((await a.delete(`/api/rooms/${room.room.id}/members/${member.id}`)).status).toBe(409);
      expect((await a.post(`/api/rooms/${room.room.id}/members/${member.id}/reset`)).status).toBe(409);
      expect((await a.patch(`/api/rooms/${room.room.id}/members/${member.id}`).send({ enabled: false })).status).toBe(409);
      await a.post(`/api/rooms/${room.room.id}/stop`);
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null);
    } finally {
      await t.close();
    }
  });

  it("resets a session by starting a new one, keeping the old native session claimed", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      await send(a, room.room.id, "hello");
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 1);
      const first = t.manager.list().find((chat) => chat.owner);
      const oldNative = first!.nativeId as string;
      const reset = await a.post(`/api/rooms/${room.room.id}/members/${room.room.members[0]!.id}/reset`);
      expect(reset.status).toBe(200);
      expect(t.boards.ownsNativeSession("fake", oldNative)).toBe(true);
      expect(t.fake.sessions.has(oldNative)).toBe(true);
      await send(a, room.room.id, "hello again");
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 2);
      const second = t.manager.list().find((chat) => chat.owner);
      expect(second?.nativeId).not.toBe(oldNative);
    } finally {
      await t.close();
    }
  });

  it("gives each room membership its own native session, even for the same profile", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const bot = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const one = await makeRoom(a, ws.id, [{ botId: bot.id, handle: "atlas" }], { name: "One" });
      const two = await makeRoom(a, ws.id, [{ botId: bot.id, handle: "atlas" }], { name: "Two" });
      await send(a, one.room.id, "one");
      await send(a, two.room.id, "two");
      await waitRecords(a, one.room.id, (s) => s.activeTurn === null && botRuns(s).length === 1);
      await waitRecords(a, two.room.id, (s) => s.activeTurn === null && botRuns(s).length === 1);
      const owned = t.manager.list().filter((chat) => chat.owner);
      expect(owned).toHaveLength(2);
      expect(new Set(owned.map((chat) => chat.nativeId)).size).toBe(2);
    } finally {
      await t.close();
    }
  });

  it("replays missed room events on reconnect and never projects the internal prompt as a user item", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      const first = openRoomSse(t, room.room.id, a.cookie);
      await first.waitFor(() => first.roomEvents().length > 0);
      expect(first.roomEvents()[0]?.type).toBe("snapshot");
      await send(a, room.room.id, "hello");
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 1);
      await first.waitFor(() => first.roomEvents().some((event) => event.type === "record"));
      expect(first.roomEvents().filter((event) => event.type === "item").every((event) => (event.item as { kind: string }).kind !== "user")).toBe(true);
      const cursor = first.lastId();
      first.close();
      expect(cursor).toBeDefined();
      await send(a, room.room.id, "second");
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 2);
      const again = openRoomSse(t, room.room.id, a.cookie, cursor);
      await again.waitFor(() => again.roomEvents().length > 0);
      expect(again.roomEvents().every((event) => event.type !== "snapshot")).toBe(true);
      expect(again.roomEvents().some((event) => event.type === "record" && (event.record as { kind?: string }).kind === "user")).toBe(true);
      again.close();
    } finally {
      await t.close();
    }
  });

  it("cancels a pending request when the turn is stopped", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      await send(a, room.room.id, "ask");
      const asking = await waitRecords(a, room.room.id, (s) => s.pending.length > 0);
      expect(asking.activeTurn?.state).toBe("waiting_for_user");
      await a.post(`/api/rooms/${room.room.id}/stop`);
      const snap = await waitRecords(a, room.room.id, (s) => s.activeTurn === null);
      expect(snap.pending).toHaveLength(0);
      expect(snap.records.some((record) => record.kind === "bot_run" && record.status === "stopped")).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("detaches its projection subscription at settle, so idle reaping is not blocked", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      await send(a, room.room.id, "hello");
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 1);
      const owned = t.manager.list().filter((chat) => chat.owner);
      expect(owned).toHaveLength(1);
      expect(owned[0]?.subscriberCount).toBe(0);
    } finally {
      await t.close();
    }
  });

  it("resumes a membership's stored native session after a restart", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      await send(a, room.room.id, "hello");
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 1);
      const oldNative = t.manager.list().find((chat) => chat.owner)?.nativeId as string;
      await t.boards.shutdown();
      const fresh = new RoomManager({ registry: t.registry, workspaces: t.workspaces, chats: t.manager, stateDir: t.stateDir, log: () => undefined });
      await fresh.start();
      // The turn finished before the restart, so the saved runtime must not claim it was still active.
      const restored = await fresh.roomSnapshot(room.room.id);
      expect(restored.records.filter((record) => record.kind === "notice" && /interrupted/.test(record.text))).toHaveLength(0);
      await fresh.postMessage(room.room.id, { text: "after restart", mentions: [] });
      const started = Date.now();
      for (;;) {
        const snap = await fresh.roomSnapshot(room.room.id);
        if (snap.activeTurn === null && snap.records.filter((record) => record.kind === "bot_run").length === 2) break;
        if (Date.now() - started > 8_000) throw new Error("the resumed run did not finish");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const resumed = t.manager.list().find((chat) => chat.owner && chat.nativeId === oldNative);
      expect(resumed).toBeDefined();
      expect(t.fake.sessions.has(oldNative)).toBe(true);
      await fresh.shutdown();
    } finally {
      await t.close();
    }
  });

  it("marks a turn left running by a previous process interrupted instead of resuming it", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      const roomId = room.room.id;
      await t.boards.shutdown();
      const store = new BoardStoreImpl({ dir: path.join(t.stateDir, "boards") });
      const { workspaces: freshWorkspaces } = await Workspaces.create([t.root], t.root);
      const now = Date.now();
      await store.saveRuntime(roomId, {
        activeTurnId: "active-turn",
        queue: [{ id: "queued-turn", text: "was waiting", mentions: [], queuedAt: now }],
        generation: 3,
        clientTurns: [
          { clientId: "c1", turn: { id: "active-turn", state: "running", text: "was running", mentions: [], directMemberIds: [], queuedAt: now, startedAt: now, endedAt: null, invocationCount: 1, consultCount: 0 } },
        ],
      });
      const fresh = new RoomManager({ registry: t.registry, workspaces: freshWorkspaces, chats: t.manager, stateDir: t.stateDir, log: () => undefined });
      await fresh.start();
      const snap = await fresh.roomSnapshot(roomId);
      // The workspace map is in-memory: a restart re-opens the stored path and re-validates it.
      expect(snap.room.workspaceName).toBe("proj");
      expect(snap.activeTurn).toBeNull();
      expect(snap.queued).toHaveLength(0);
      const interrupted = snap.records.filter((record): record is Extract<RoomRecord, { kind: "notice" }> => record.kind === "notice" && /interrupted/.test(record.text));
      expect(interrupted).toHaveLength(2);
      await fresh.shutdown();
    } finally {
      await t.close();
    }
  });
});
