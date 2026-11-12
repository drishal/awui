// "Resume working." after a restart: a session that was running when the last process
// stopped carries the intent to carry on, and the first open after the restart sends it
// once — never for a session nobody reopened.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot } from "../../src/shared/protocol.js";
import { RESUME_TEXT, ResumeIntents } from "../../src/server/resume-intent.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const texts = (snapshot: ChatSnapshot) => snapshot.items.flatMap((item) => (item.kind === "user" ? [item.text] : []));

describe("a session that was running at shutdown", () => {
  it("is told to carry on when it is opened again, once", async () => {
    const resumeIntents = ResumeIntents.inMemory();
    t = await makeTestApp({ resumeIntents });
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "persist me" });
    await until(() => t?.manager.get(chat.chatId).status === "idle");
    const sessionId = t.manager.get(chat.chatId).sessionId as string;
    expect(sessionId).toMatch(/^fake:/);
    await agent.post(`/api/chats/${chat.chatId}/dispose`);

    // The last process stopped mid-run: this session carries the intent.
    await resumeIntents.markMany([sessionId]);
    const reopened = (await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId })).body as ChatSnapshot;
    const id = reopened.chatId;
    const app = t;
    await until(() => app.manager.get(id).snapshot().items.some((item) => item.kind === "user" && item.text === RESUME_TEXT));
    expect(resumeIntents.all()).toEqual([]);

    // A second reopen sends nothing: the intent was one use, so the history keeps one such prompt.
    await agent.post(`/api/chats/${id}/dispose`);
    const again = (await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId })).body as ChatSnapshot;
    await until(() => app.manager.get(again.chatId).status === "idle");
    expect(texts(app.manager.get(again.chatId).snapshot()).filter((text) => text === RESUME_TEXT)).toHaveLength(1);
  });

  it("sends nothing for a session nobody reopened", async () => {
    const resumeIntents = ResumeIntents.inMemory();
    t = await makeTestApp({ resumeIntents });
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "persist me" });
    await until(() => t?.manager.get(chat.chatId).status === "idle");
    const sessionId = t.manager.get(chat.chatId).sessionId as string;
    await resumeIntents.markMany([sessionId]);
    expect(resumeIntents.all()).toEqual([sessionId]);
    expect(t.fake.sessions.size).toBe(1);
  });
});
