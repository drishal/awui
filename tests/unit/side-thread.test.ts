// Side threads: a question about one block of a chat, answered in a chat of its own
// that every session list keeps out. The brief is pure; the route is driven against
// the fake harness, once without awui's own harness (a fork) and once with it.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot, SideThreadResult } from "../../src/shared/protocol.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { sideThreadPrompt } from "../../src/server/harness/handoff.js";
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

const turn = { prompt: { text: "Add a retry" }, answer: { text: "Done." }, tools: [{ name: "Edit", summary: "src/app.ts", output: "" }] };

async function asked(turnNumber = 1) {
  const agent = await signedIn(t as TestApp);
  const ws = (await agent.post("/api/workspaces/open").send({ path: (t as TestApp).project })).body as { id: string };
  const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
  await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hello side" });
  await until(() => (t as TestApp).manager.get(chat.chatId).status === "idle" && (t as TestApp).manager.get(chat.chatId).nativeId !== null);
  return { agent, ws, chat, turnNumber };
}

describe("sideThreadPrompt", () => {
  it("frames the block as context and the question as the only request", () => {
    const prompt = sideThreadPrompt(turn, { from: "Pi", project: "proj", question: "Why a retry?" });
    expect(prompt).toContain("A side question about a conversation");
    expect(prompt).toContain("change nothing");
    expect(prompt).toContain("User: Add a retry");
    expect(prompt).toContain("Pi: Done.");
    expect(prompt.trimEnd().endsWith("Why a retry?")).toBe(true);
  });
});

describe("the side route", () => {
  it("forks a chat that can fork, asks the question there, and keeps it out of every session list", async () => {
    t = await makeTestApp();
    const { agent, chat } = await asked();
    const before = (t as TestApp).manager.get(chat.chatId).snapshot().items.length;
    const opened = await agent.post(`/api/chats/${chat.chatId}/side`).send({ turn: 1, question: "Why a retry?" });
    expect(opened.status).toBe(201);
    const result = opened.body as SideThreadResult;
    expect(result.readOnly).toBe(false);
    expect(result.snapshot.chatId).not.toBe(chat.chatId);
    expect(result.snapshot.harnessId).toBe("fake");

    // The question is the side chat's own first new turn, and the fork carried the block above it.
    const prompts = () => (t as TestApp).manager.get(result.snapshot.chatId).snapshot().items.flatMap((item) => (item.kind === "user" ? [item.text] : []));
    await until(() => prompts().includes("Why a retry?"));

    // Hidden: neither the sessions list nor the harness's own session list names it while this server holds it.
    const sessions = (await agent.get("/api/sessions")).body as { sessions: Array<{ liveChatId?: string }> };
    expect(sessions.sessions.some((s) => s.liveChatId === result.snapshot.chatId)).toBe(false);
    const native = (await agent.get(`/api/harnesses/fake/sessions?workspaceId=${chat.workspace.id}`)).body as { sessions: Array<{ liveChatId?: string }> };
    expect(native.sessions.some((s) => s.liveChatId === result.snapshot.chatId)).toBe(false);
    // The main chat was not touched by it.
    expect((t as TestApp).manager.get(chat.chatId).snapshot().items).toHaveLength(before);
  });

  it("uses awui's own read-only harness when it is installed", async () => {
    t = await makeTestApp();
    // A stand-in for awui's harness: the route only asks that one is registered and available.
    t.registry.register(new FakeAdapter({ id: "awui", displayName: "Awui" }));
    await t.registry.refreshStatus();
    const { agent, chat } = await asked();
    const opened = await agent.post(`/api/chats/${chat.chatId}/side`).send({ turn: 1, question: "Where is that used?" });
    expect(opened.status).toBe(201);
    const result = opened.body as SideThreadResult;
    expect(result.readOnly).toBe(true);
    expect(result.snapshot.harnessId).toBe("awui");
    // Its first prompt is the block's brief, since awui keeps no past turns of its own.
    const prompts = () => (t as TestApp).manager.get(result.snapshot.chatId).snapshot().items.flatMap((item) => (item.kind === "user" ? [item.text] : []));
    await until(() => prompts().length === 1);
    expect(prompts()[0]).toContain("A side question about a conversation");
    expect(prompts()[0]?.endsWith("Where is that used?")).toBe(true);
  });

  it("refuses a turn that does not exist and an empty question", async () => {
    t = await makeTestApp();
    const { agent, chat } = await asked();
    expect((await agent.post(`/api/chats/${chat.chatId}/side`).send({ turn: 7, question: "why?" })).body).toMatchObject({ code: "no_turn" });
    expect((await agent.post(`/api/chats/${chat.chatId}/side`).send({ turn: 1, question: "  " })).status).toBe(400);
    expect((await agent.post(`/api/chats/${chat.chatId}/side`).send({ turn: 1, question: "x".repeat(2_001) })).status).toBe(400);
  });
});
