// Second opinions: the one-turn brief, the record kept in the state folder, and the
// routes that ask another harness, refuse the wrong ones, and read the reply back.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatItem, ChatSnapshot, SecondOpinion, SecondOpinionResult } from "../../src/shared/protocol.js";
import { OPINION_MAX_CHARS, turnBrief } from "../../src/server/harness/handoff.js";
import { reportExcerpt, SecondOpinions } from "../../src/server/second-opinions.js";
import { makeTestApp, signedIn, tempDir, type TestApp } from "../helpers/app.js";

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

const turn = {
  prompt: { text: "Add a retry" },
  answer: { text: "Added retry() and a test." },
  tools: [{ name: "Edit", summary: "src/app.ts (+12 −3)", output: "ok" }],
};

describe("turnBrief", () => {
  it("frames the turn as context and a review, and ends on the question", () => {
    const brief = turnBrief(turn, { from: "Pi", project: "proj", ask: "Is the retry bounded?" });
    expect(brief).toContain("produced by Pi in proj");
    expect(brief).toContain("do not edit files");
    expect(brief).toContain("User: Add a retry");
    expect(brief).toContain("· Edit src/app.ts (+12 −3)");
    expect(brief).toContain("Pi: Added retry() and a test.");
    expect(brief.trimEnd().endsWith("Is the retry bounded?")).toBe(true);
  });

  it("asks its own default question when the box was left empty", () => {
    const brief = turnBrief(turn, { from: "Pi", project: "proj", ask: null });
    expect(brief).toContain("give a second opinion");
  });

  it("gives up tool output before the turn itself, and never the question", () => {
    // Ten calls' output is more than the budget allows beside the prompt and the answer.
    const long = {
      prompt: { text: "p".repeat(8_000) },
      answer: { text: "a".repeat(8_000) },
      tools: Array.from({ length: 10 }, (_, i) => ({ name: "Run", summary: `npm test ${i}`, output: "x".repeat(4_000) })),
    };
    const brief = turnBrief(long, { from: "Pi", project: "proj", ask: "Is this right?" });
    expect(brief.length).toBeLessThanOrEqual(OPINION_MAX_CHARS);
    expect(brief).not.toContain("xxxxxxxxxx");
    expect(brief.endsWith("Is this right?")).toBe(true);
  });
});

describe("the record", () => {
  it("keeps one chat's opinions newest first, prunes the oldest at the cap, and survives a reopen", async () => {
    const dir = tempDir("awui-opinions-");
    const store = await SecondOpinions.open(dir);
    for (let i = 0; i < 25; i += 1) await store.add("chat-1", { turn: i + 1, from: "pi", to: "omp", chatId: `child-${i}`, ask: `q${i}` });
    await store.add("chat-2", { turn: 1, from: "pi", to: "fake-b", chatId: "other", ask: "" });
    const list = store.list("chat-1");
    expect(list).toHaveLength(20);
    expect(list[0]?.ask).toBe("q24");
    expect(store.list("chat-2")).toHaveLength(1);

    const reopened = await SecondOpinions.open(dir);
    expect(reopened.list("chat-1")).toHaveLength(20);
    expect(reopened.list("chat-2")[0]).toMatchObject({ chatId: "other", report: null });
  });

  it("shows the opening of the other agent's last reply, bounded", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u", text: "p" },
      { kind: "assistant", id: "a1", text: "first", thinking: "", streaming: false },
      { kind: "assistant", id: "a2", text: "y".repeat(5_000), thinking: "", streaming: false },
    ];
    expect(reportExcerpt(items)).toBe(`${"y".repeat(2_000)}…`);
    expect(reportExcerpt(items.slice(0, 1))).toBeNull();
    expect(reportExcerpt([...items.slice(0, 2), { kind: "assistant", id: "a3", text: "  ", thinking: "", streaming: false }])).toBe("first");
  });
});

describe("the second-opinion routes", () => {
  it("sends one turn to another harness as an ordinary chat, and lists the card with its reply", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hello opinion" });
    await until(() => t?.manager.get(chat.chatId).status === "idle" && t?.manager.get(chat.chatId).snapshot().items.some((item) => item.kind === "assistant"));

    const asked = await agent.post(`/api/chats/${chat.chatId}/second-opinion`).send({ turn: 1, harness: "fake-b", ask: "Was that right?" });
    expect(asked.status).toBe(201);
    const result = asked.body as SecondOpinionResult;
    expect(result.opinion).toMatchObject({ turn: 1, from: "fake", to: "fake-b", ask: "Was that right?", report: null });
    // The opinion runs in an ordinary chat of the same project, and its first prompt is the turn's brief.
    expect(result.snapshot.workspace.id).toBe(chat.workspace.id);
    expect(result.snapshot.harnessId).toBe("fake-b");
    const prompts = () => t?.manager.get(result.snapshot.chatId).snapshot().items.flatMap((item) => (item.kind === "user" ? [item.text] : [])) ?? [];
    await until(() => prompts().length === 1);
    expect(prompts()[0]).toContain("A second opinion on one turn");
    expect(prompts()[0]).toContain("hello opinion");
    expect(prompts()[0]?.endsWith("Was that right?")).toBe(true);

    // Once the other agent answers, the card carries the opening of its reply.
    await until(() => (t?.manager.peek(result.snapshot.chatId)?.snapshot().items.some((item) => item.kind === "assistant" && item.text.length > 0)) ?? false);
    const listed = await agent.get(`/api/chats/${chat.chatId}/second-opinion`);
    const opinions = (listed.body as { opinions: SecondOpinion[] }).opinions;
    expect(opinions).toHaveLength(1);
    expect(opinions[0]?.report).not.toBeNull();
    expect(opinions[0]?.id).toBe(result.opinion.id);
    // Nothing was written into this chat: its items are its own turns only.
    expect(t?.manager.get(chat.chatId).snapshot().items.some((item) => item.kind === "notice")).toBe(false);
  });

  it("refuses the same harness, a turn that does not exist, and a harness that is not available", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "one turn" });
    await until(() => t?.manager.get(chat.chatId).status === "idle");

    const same = await agent.post(`/api/chats/${chat.chatId}/second-opinion`).send({ turn: 1, harness: "fake" });
    expect(same.body).toMatchObject({ code: "same_harness" });
    const far = await agent.post(`/api/chats/${chat.chatId}/second-opinion`).send({ turn: 9, harness: "fake-b" });
    expect(far.body).toMatchObject({ code: "no_turn" });
    const missing = await agent.post(`/api/chats/${chat.chatId}/second-opinion`).send({ turn: 1, harness: "nope" });
    expect(missing.status).toBeGreaterThanOrEqual(400);
    const tooLong = await agent.post(`/api/chats/${chat.chatId}/second-opinion`).send({ turn: 1, harness: "fake-b", ask: "x".repeat(2_001) });
    expect(tooLong.status).toBe(400);
  });
});
