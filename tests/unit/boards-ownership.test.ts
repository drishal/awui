// Board-owned chats are driven by their room and must never appear as, or be
// reachable through, ordinary chat surfaces: the session list (including the
// per-harness route), search, usage, preview, resume command, resume, every
// chat route, and ordinary push news. The ownership oracle is the one filter
// all of them share; an ordinary chat beside it still shows.
import { describe, expect, it } from "vitest";
import { makeTestApp } from "../helpers/app.js";
import { RoomManager } from "../../src/server/boards/manager.js";
import { agent, botRuns, makeBot, makeRoom, openProject, send, waitRecords } from "../helpers/board.js";

describe("board session ownership", () => {
  it("hides and rejects a room's native session and live chat everywhere ordinary", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      await send(a, room.room.id, "hello");
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 1);

      const owned = t.manager.list().find((chat) => chat.owner);
      expect(owned).toBeDefined();
      const nativeId = owned!.nativeId as string;
      expect(t.boards.ownsNativeSession("fake", nativeId)).toBe(true);
      const sessionId = `fake:${nativeId}`;

      const overview = await a.get("/api/sessions").query({ path: t.project });
      expect(overview.status).toBe(200);
      expect(JSON.stringify(overview.body)).not.toContain(nativeId);
      expect(overview.body.sessions.some((session: { liveChatId?: string }) => session.liveChatId === owned!.chatId)).toBe(false);

      const harnessSessions = await a.get("/api/harnesses/fake/sessions").query({ workspaceId: ws.id });
      expect(harnessSessions.status).toBe(200);
      expect(harnessSessions.body.sessions).toHaveLength(0);

      const search = await a.get("/api/sessions/search").query({ q: "Echo from Atlas" });
      expect(search.status).toBe(200);
      expect(search.body.results).toHaveLength(0);

      const usage = await a.get("/api/usage").query({ days: 7, tz: "0" });
      expect(usage.status).toBe(200);
      expect(JSON.stringify(usage.body)).not.toContain(nativeId);

      const preview = await a.get("/api/sessions/preview").query({ harnessId: "fake", workspaceId: ws.id, sessionId });
      expect(preview.status).toBe(404);
      const resumeCommand = await a.get("/api/sessions/resume-command").query({ harnessId: "fake", workspaceId: ws.id, sessionId });
      expect(resumeCommand.status).toBe(404);
      const resume = await a.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId });
      expect(resume.status).toBe(404);

      expect((await a.get(`/api/chats/${owned!.chatId}`)).status).toBe(404);
      expect((await a.get(`/api/chats/${owned!.chatId}/events`)).status).toBe(404);
      expect((await a.post(`/api/chats/${owned!.chatId}/messages`).send({ text: "second writer" })).status).toBe(404);

      const notes = await a.get("/api/notifications").query({ since: 0 });
      const boardNotes = (notes.body.notes as Array<{ chatId: string }>).filter((note) => note.chatId === owned!.chatId);
      expect(boardNotes).toHaveLength(0);

      // Control: an ordinary chat in the same project is still listed and reachable.
      const ordinary = await a.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id });
      expect(ordinary.status).toBe(201);
      await a.post(`/api/chats/${ordinary.body.chatId}/messages`).send({ text: "ordinary hello" });
      await t.manager.get(ordinary.body.chatId).waitSettled();
      expect((await a.get(`/api/chats/${ordinary.body.chatId}`)).status).toBe(200);
      const after = await a.get("/api/sessions");
      expect(after.body.sessions.some((session: { liveChatId?: string }) => session.liveChatId === ordinary.body.chatId)).toBe(true);
    } finally {
      await t.close();
    }
  });

  it("keeps a removed membership's native session claimed forever (the tombstone)", async () => {
    const t = await makeTestApp();
    try {
      const a = await agent(t);
      const ws = await openProject(t, a);
      const lead = await makeBot(a, { name: "Atlas", harnessId: "fake" });
      const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
      await send(a, room.room.id, "hello");
      await waitRecords(a, room.room.id, (s) => s.activeTurn === null && botRuns(s).length === 1);
      const owned = t.manager.list().find((chat) => chat.owner);
      const nativeId = owned!.nativeId as string;
      const memberId = room.room.members[0]!.id;
      const removed = await a.delete(`/api/rooms/${room.room.id}/members/${memberId}`);
      expect(removed.status).toBe(200);
      expect(t.boards.ownsNativeSession("fake", nativeId)).toBe(true);
      const resume = await a.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: `fake:${nativeId}` });
      expect(resume.status).toBe(404);
      // The tombstone is durable: a restarted manager still claims the old session.
      const fresh = new RoomManager({ registry: t.registry, workspaces: t.workspaces, chats: t.manager, stateDir: t.stateDir, log: () => undefined });
      await fresh.start();
      expect(fresh.ownsNativeSession("fake", nativeId)).toBe(true);
      await fresh.shutdown();
    } finally {
      await t.close();
    }
  });
});
