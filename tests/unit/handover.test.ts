// Two-way resume: copying a live chat's resume line hands the session to a terminal
// (the exact quoted line, locked), a second writer is refused during the handover,
// and reclaiming takes the lock and lets the same native session prompt again.
import path from "node:path";
import { mkdirSync } from "node:fs";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { shellWord } from "../../src/server/shell-line.js";
import type { ChatSnapshot, HandoverReclaim, ResumeCommand, SessionsOverview } from "../../src/shared/protocol.js";
import { makeTestApp, signedIn, tempDir, type TestApp } from "../helpers/app.js";

async function until(predicate: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, 10);
    await promise;
  }
}

describe("two-way resume handover", () => {
  let t: TestApp | null = null;
  afterEach(async () => {
    await t?.close();
    t = null;
  });

  it("records the handover with the actual command when the chat is live, and locks it", async () => {
    t = await makeTestApp();
    const manager = t.manager;
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string; path: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sessionId = chat.sessionId as string;
    const sse = request.agent(t.server);
    void sse;
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "keep me" });
    const nativeId = sessionId.slice("fake:".length);
    // A copy alone must never hand over: the explicit action closes the live writer and locks it.
    const resume = await agent.get("/api/sessions/resume-command").query({ harnessId: "fake", workspaceId: ws.id, sessionId });
    expect(resume.status).toBe(200);
    expect(resume.body).toEqual({ command: `cd ${shellWord(ws.path)} && fake --resume ${nativeId}`, live: true });
    await until(() => manager.get(chat.chatId).status === "idle");
    const taken = await agent.post("/api/sessions/handover").send({ harnessId: "fake", workspaceId: ws.id, sessionId }).expect(200);
    expect(taken.body.command).toContain(`fake --resume ${nativeId}`);
    expect(t.manager.list()).toHaveLength(0);
    // The lock marks the row in the list (a live chat here shows live, so no row mark yet).
    const listed = (await agent.get(`/api/sessions?path=${encodeURIComponent(t.project)}`)).body as SessionsOverview;
    const row = listed.sessions.find((s) => s.id === sessionId);
    expect(row?.handover).toBe(true);
    // A live chat's own resume returns the same open chat, never a second writer.
    await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId }).expect(409);
    // The explicit handover stops the live writer: an ordinary resume cannot be summed alone.
    const locked = await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId }).expect(409);
    expect(locked.body).toMatchObject({ code: "session_handed" });
    expect(locked.body.error).toContain("fake --resume");
    expect(t.manager.list()).toHaveLength(0);
    // The row is marked handed now that no live chat holds it.
    const after = (await agent.get(`/api/sessions?path=${encodeURIComponent(t.project)}`)).body as SessionsOverview;
    const handed = after.sessions.find((s) => s.id === sessionId);
    expect(handed?.handover).toBe(true);
    expect(handed?.handoverCommand).toBe(`cd ${shellWord(ws.path)} && fake --resume ${nativeId}`);
    // A resume that says reclaim takes the lock and opens the same native session.
    const reclaimBody = { harnessId: "fake", workspaceId: ws.id, sessionId, reclaim: true };
    const back = await agent.post("/api/chats/resume").send(reclaimBody).expect(200);
    expect((back.body as ChatSnapshot).sessionId).toBe(sessionId);
    expect(t.manager.list()).toHaveLength(1);
    // The lock is gone: the row mark is gone, and the prompt works again.
    const reclaimed = (await agent.get(`/api/sessions?path=${encodeURIComponent(t.project)}`)).body as SessionsOverview;
    expect(reclaimed.sessions.find((s) => s.id === sessionId)?.handover).toBeUndefined();
    await agent.post(`/api/chats/${(back.body as ChatSnapshot).chatId}/messages`).send({ text: "again" });
  });

  it("reclaims through the reclaim route, which answers the line the handover held", async () => {
    t = await makeTestApp();
    const manager = t.manager;
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string; path: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sessionId = chat.sessionId as string;
    const nativeId = sessionId.slice("fake:".length);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "keep me" });
    await until(() => manager.get(chat.chatId).status === "idle");
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hello" }).expect(202);
    await until(() => manager.get(chat.chatId).status === "idle");
    await agent.post("/api/sessions/handover").send({ harnessId: "fake", workspaceId: ws.id, sessionId }).expect(200);
    const reclaimed = await agent.post("/api/sessions/reclaim").send({ harnessId: "fake", workspaceId: ws.id, sessionId }).expect(200);
    expect(reclaimed.body as HandoverReclaim).toEqual({ command: `cd ${shellWord(ws.path)} && fake --resume ${nativeId}`, live: false });
    // The second reclaim has nothing to take.
    const again = await agent.post("/api/sessions/reclaim").send({ harnessId: "fake", workspaceId: ws.id, sessionId }).expect(200);
    expect((again.body as HandoverReclaim).command).toBeNull();
    // And the resume is no longer locked.
    await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId }).expect(200);
  });

  it("blocks a send on a live chat whose session was handed over, until it is reclaimed", async () => {
    t = await makeTestApp();
    const manager = t.manager;
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string; path: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sessionId = chat.sessionId as string;
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hello" }).expect(202);
    // A read-only copy does not start a handover or send a prompt.
    await agent.get("/api/sessions/resume-command").query({ harnessId: "fake", workspaceId: ws.id, sessionId });
    await until(() => manager.get(chat.chatId).status === "idle");
    await agent.post("/api/sessions/handover").send({ harnessId: "fake", workspaceId: ws.id, sessionId }).expect(200);
    const send = await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "more" }).expect(404);
    // An already-disposed chat cannot take another prompt until reopened and reclaimed.
    expect(send.body).toMatchObject({ code: "chat_not_found" });
    // Reclaiming through the resume takes the lock, and the prompt works again.
    const back = await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId, reclaim: true }).expect(200);
    const open = t.manager.get((back.body as ChatSnapshot).chatId);
    await until(() => open.status === "idle");
    await agent.post(`/api/chats/${(back.body as ChatSnapshot).chatId}/messages`).send({ text: "after reclaim" }).expect(202);
  });

  it("keeps another project's session out of the lock's way, and needs a signed-in device", async () => {
    const other = path.join(tempDir("awui-handover-"), "proj");
    mkdirSync(other, { recursive: true });
    t = await makeTestApp({ withPassword: true, lanHosts: ["192.168.1.50"] });
    const manager = t.manager;
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string; path: string };
    const otherWs = (await agent.post("/api/workspaces/open").send({ path: other })).body as { id: string; path: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sessionId = chat.sessionId as string;
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "keep me" });
    await until(() => manager.get(chat.chatId).status === "idle");
    await agent.get("/api/sessions/resume-command").query({ harnessId: "fake", workspaceId: ws.id, sessionId });
    // The wrong harness asked is a 400, before any lock is touched.
    await agent.post("/api/sessions/reclaim").send({ harnessId: "fake-b", workspaceId: ws.id, sessionId }).expect(400);
    // A LAN device that is not signed in learns nothing.
    const res = await request(t.server).post("/api/sessions/reclaim").set("Host", `192.168.1.50:${t.port}`).send({ harnessId: "fake", workspaceId: otherWs.id, sessionId });
    expect(res.status).toBe(401);
  });
});
