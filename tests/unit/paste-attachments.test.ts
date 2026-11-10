// The pasted-blob attachment route: oversized text stays as a file under /tmp
// for seven days so agents may re-read it, then expires; unsent files delete now. The
// client may only reference ids the server itself issued.
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ChatSnapshot } from "../../src/shared/protocol.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp;
import { afterEach } from "vitest";
afterEach(async () => {
  await t?.close();
});

async function setup() {
  t = await makeTestApp({});
  const agent = await signedIn(t);
  const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string; path: string };
  const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
  return { t, agent, chat };
}

describe("paste attachments", () => {
  it("stores a paste for a chat and returns its path", async () => {
    const { agent, chat } = await setup();
    const res = await agent.post(`/api/chats/${chat.chatId}/pastes`).send({ text: "line 1\nline 2\nline 3\n" });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ lines: 4 });
    expect(String(res.body.path)).toMatch(/awui-pastes/);
    expect(readFileSync(res.body.path, "utf8")).toBe("line 1\nline 2\nline 3\n");
  });

  it("rejects pastes over the 1 MiB cap", async () => {
    const { agent, chat } = await setup();
    const res = await agent.post(`/api/chats/${chat.chatId}/pastes`).send({ text: "x".repeat(1025 * 1024) });
    expect(res.status).toBe(413);
  });

  it("sends paste references as a prompt header naming the file", async () => {
    const { agent, chat } = await setup();
    const pasted = (await agent.post(`/api/chats/${chat.chatId}/pastes`).send({ text: "big blob body" })).body as { id: string; path: string };
    const send = await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "summarise the paste", attachments: [{ id: pasted.id }] });
    expect(send.status).toBe(202);
    const { items } = (await agent.get(`/api/chats/${chat.chatId}`)).body as ChatSnapshot;
    const user = items.find((i) => i.kind === "user");
    expect(user?.text).toContain(pasted.path);
    expect(user?.text).toContain("summarise the paste");
  });

  it("deletes unused drafts and expires a weekly paste after the agent's read window", async () => {
    const { agent, chat } = await setup();
    const unused = (await agent.post(`/api/chats/${chat.chatId}/pastes`).send({ text: "throw me away" })).body as { id: string; path: string };
    expect((await agent.delete(`/api/chats/${chat.chatId}/pastes/${unused.id}`)).status).toBe(200);
    expect(existsSync(unused.path)).toBe(false);
    const kept = (await agent.post(`/api/chats/${chat.chatId}/pastes`).send({ text: "read later" })).body as { id: string; path: string };
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60_000);
    utimesSync(kept.path, eightDaysAgo, eightDaysAgo);
    const expired = await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "read it again", attachments: [{ id: kept.id }] });
    expect(expired.status).toBe(410);
    expect(expired.body.error).toContain("expired");
  });

  it("refuses attachments ids the server did not issue or from another chat", async () => {
    const { agent, chat } = await setup();
    const invalid = await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hi", attachments: [{ id: "../../etc/passwd" }] });
    expect(invalid.status).toBe(400);
    const missing = await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hi", attachments: [{ id: "abcdefgh" }] });
    expect(missing.status).toBe(404);
  });
});
