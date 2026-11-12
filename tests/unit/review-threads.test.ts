// Review threads: the store's bounds and line moves, and the routes that create,
// reply, resolve, delete and send a chat's comments on its diffs.
import { afterEach, describe, expect, it } from "vitest";
import { MAX_REVIEW_NOTES_PER_THREAD, MAX_REVIEW_THREADS_PER_CHAT, type ChatSnapshot, type ReviewThread } from "../../src/shared/protocol.js";
import { hashLine } from "../../src/shared/review.js";
import { ReviewThreads } from "../../src/server/review-threads.js";
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

const anchor = (path = "src/a.ts") => ({ path, side: "add" as const, line: 4, hash: hashLine("new();"), text: "new();" });

async function setUp() {
  t = await makeTestApp();
  const agent = await signedIn(t);
  const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
  const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
  const prompts = (id: string) => (t as TestApp).manager.get(id).snapshot().items.flatMap((i) => (i.kind === "user" ? [i.text] : []));
  return { agent, ws, chat, prompts };
}

describe("the review thread store", () => {
  it("creates, replies, resolves, moves and deletes, and survives a reopen", async () => {
    const stateDir = tempDir("awui-review-");
    const store = await ReviewThreads.open(stateDir);
    const thread = await store.create("chat-1", anchor(), "Call it with the config.");
    expect(thread.notes).toHaveLength(1);
    expect(thread.status).toBe("open");

    await store.addNote("chat-1", thread.id, "And pass the timeout.");
    const resolved = await store.setStatus("chat-1", thread.id, "resolved");
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolvedAt).toBeTypeOf("number");
    expect((await store.setStatus("chat-1", thread.id, "open")).resolvedAt).toBeUndefined();

    expect(await store.move("chat-1", [{ id: thread.id, line: 9 }])).toBe(1);
    await store.markSent("chat-1", [thread.id], 1_700_000_000_000);

    const reopened = await ReviewThreads.open(stateDir);
    const kept = reopened.list("chat-1");
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: thread.id, lastSentAt: 1_700_000_000_000, notes: [{ text: "Call it with the config." }, { text: "And pass the timeout." }] });
    expect(kept[0]?.anchor.line).toBe(9);

    expect(await reopened.remove("chat-1", thread.id)).toBe(true);
    expect(reopened.list("chat-1")).toEqual([]);
  });

  it("refuses a second open thread on the same pin, and never moves a removed line's pin", async () => {
    const store = ReviewThreads.inMemory();
    const thread = await store.create("c", anchor(), "First");
    await expect(store.create("c", anchor(), "Again")).rejects.toMatchObject({ code: "duplicate", status: 409 });

    const removed = await store.create("c", { ...anchor("src/b.ts"), side: "del", line: 2 }, "Keep this");
    expect(await store.move("c", [{ id: removed.id, line: 7 }])).toBe(0);
    expect(store.thread("c", removed.id)?.anchor.line).toBe(2);
    expect(store.thread("c", thread.id)).toBeDefined();
  });

  it("prunes the oldest resolved thread at the chat's cap, and keeps refusing while every thread is open", async () => {
    const store = ReviewThreads.inMemory();
    for (let i = 0; i < MAX_REVIEW_THREADS_PER_CHAT; i++) await store.create("c", { ...anchor(), line: i + 1 }, `note ${i}`);
    await expect(store.create("c", { ...anchor(), line: 999 }, "one more")).rejects.toMatchObject({ code: "thread_limit" });

    const oldest = store.list("c").at(-1) as ReviewThread;
    await store.setStatus("c", oldest.id, "resolved");
    const fresh = await store.create("c", { ...anchor(), line: 999 }, "one more");
    expect(store.list("c")).toHaveLength(MAX_REVIEW_THREADS_PER_CHAT);
    expect(store.thread("c", oldest.id)).toBeUndefined();
    expect(store.thread("c", fresh.id)).toBeDefined();
  });

  it("stops a thread at its note cap", async () => {
    const store = ReviewThreads.inMemory();
    const thread = await store.create("c", anchor(), "first");
    for (let i = 1; i < MAX_REVIEW_NOTES_PER_THREAD; i++) await store.addNote("c", thread.id, `note ${i}`);
    await expect(store.addNote("c", thread.id, "too many")).rejects.toMatchObject({ code: "note_limit", status: 409 });
  });
});

describe("the review thread routes", () => {
  it("creates, lists, replies, resolves, follows and deletes a thread", async () => {
    const { agent, chat } = await setUp();
    const base = `/api/chats/${chat.chatId}/review-threads`;

    const created = await agent.post(base).send({ anchor: anchor(), text: "  Call it with the config.  " });
    expect(created.status).toBe(201);
    const thread = created.body as ReviewThread;
    expect(thread.notes[0]?.text).toBe("Call it with the config.");
    expect(thread.anchor.hash).toBe(hashLine("new();"));

    expect((await agent.post(base).send({ anchor: anchor(), text: "Again" })).body).toMatchObject({ code: "duplicate" });
    // A path that could point outside the project never reaches the store.
    expect((await agent.post(base).send({ anchor: anchor("../a.ts"), text: "Out" })).status).toBe(400);

    const reply = await agent.post(`${base}/${thread.id}/notes`).send({ text: "And pass the timeout." });
    expect(reply.status).toBe(201);
    expect((reply.body as ReviewThread).notes).toHaveLength(2);

    const resolved = await agent.post(`${base}/${thread.id}/status`).send({ status: "resolved" });
    expect(resolved.body).toMatchObject({ status: "resolved" });
    expect((resolved.body as ReviewThread).resolvedAt).toBeTypeOf("number");

    expect((await agent.post(`${base}/reanchor`).send({ moves: [{ id: thread.id, line: 12 }] })).body).toEqual({ moved: 1 });
    expect((await agent.get(base)).body).toMatchObject({ threads: [{ id: thread.id, anchor: { line: 12 } }] });

    expect((await agent.delete(`${base}/${thread.id}`)).body).toEqual({ ok: true });
    expect((await agent.post(`${base}/${thread.id}/notes`).send({ text: "late" })).status).toBe(404);
    expect((await agent.get(base)).body).toEqual({ threads: [] });
  });

  it("sends every open thread to this chat as one prompt, and marks what it carried", async () => {
    const { agent, chat, prompts } = await setUp();
    const base = `/api/chats/${chat.chatId}/review-threads`;
    const first = (await agent.post(base).send({ anchor: anchor(), text: "Call it with the config." })).body as ReviewThread;
    const second = (await agent.post(base).send({ anchor: anchor("src/b.ts"), text: "Rename this" })).body as ReviewThread;
    const resolved = (await agent.post(base).send({ anchor: anchor("src/c.ts"), text: "Done already" })).body as ReviewThread;
    await agent.post(`${base}/${resolved.id}/status`).send({ status: "resolved" });

    const sent = await agent.post(`${base}/send`).send({ target: { kind: "chat", chatId: chat.chatId }, stale: [second.id] });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ accepted: true, targetChatId: chat.chatId, sent: 2 });

    await until(() => prompts(chat.chatId).length === 1);
    expect(prompts(chat.chatId)[0]).toBe(
      [
        "Review comments on your changes:",
        "",
        "1. src/a.ts:4",
        "    + new();",
        "   Call it with the config.",
        "",
        "2. src/b.ts:4 — the line has since changed",
        "    + new();",
        "   Rename this",
        "",
        "(2 open threads sent; 1 resolved thread not included)",
      ].join("\n"),
    );

    const kept = (await agent.get(base)).body as { threads: ReviewThread[] };
    expect(kept.threads.filter((x) => x.lastSentAt !== undefined).map((x) => x.id).sort()).toEqual([first.id, second.id].sort());
    expect(kept.threads.find((x) => x.id === resolved.id)?.lastSentAt).toBeUndefined();
  });

  it("sends to a new chat in the same project", async () => {
    const { agent, chat, prompts } = await setUp();
    const created = (await agent.post(`/api/chats/${chat.chatId}/review-threads`).send({ anchor: anchor(), text: "Call it with the config." })).body as ReviewThread;
    const sent = await agent.post(`/api/chats/${chat.chatId}/review-threads/send`).send({ target: { kind: "new", harnessId: "fake" } });
    expect(sent.status).toBe(202);
    const target = (sent.body as { targetChatId: string }).targetChatId;
    expect(target).not.toBe(chat.chatId);
    await until(() => prompts(target).length === 1);
    expect(prompts(target)[0]).toContain("1. src/a.ts:4");
    expect((await agent.get(`/api/chats/${chat.chatId}/review-threads`)).body).toMatchObject({ threads: [{ id: created.id }] });
    expect((t as TestApp).manager.get(target).workspace.id).toBe((t as TestApp).manager.get(chat.chatId).workspace.id);
  });

  it("queues a follow-up to a chat that is running, and waits for one that is not", async () => {
    const { agent, chat, prompts } = await setUp();
    await agent.post(`/api/chats/${chat.chatId}/review-threads`).send({ anchor: anchor(), text: "Call it with the config." });
    const base = `/api/chats/${chat.chatId}/review-threads/send`;

    // Compacting is busy but not running: a follow-up has nowhere to go.
    await agent.post(`/api/chats/${chat.chatId}/compact`).send({});
    const waiting = await agent.post(base).send({ target: { kind: "chat", chatId: chat.chatId } });
    expect(waiting.status).toBe(409);
    expect(waiting.body).toMatchObject({ code: "chat_busy", error: "Wait until the agent is idle" });
    await until(() => (t as TestApp).manager.get(chat.chatId).status === "idle");

    // A long run takes the batch as a follow-up.
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: `slow ${"x".repeat(800)}` });
    expect((t as TestApp).manager.get(chat.chatId).status).toBe("running");
    const queued = await agent.post(base).send({ target: { kind: "chat", chatId: chat.chatId } });
    expect(queued.status).toBe(202);
    await until(() => prompts(chat.chatId).some((text) => text.startsWith("Review comments on your changes:")));
  });

  it("refuses a send with nothing open, and a target that is not open", async () => {
    const { agent, chat } = await setUp();
    const base = `/api/chats/${chat.chatId}/review-threads/send`;
    const empty = await agent.post(base).send({ target: { kind: "chat", chatId: chat.chatId } });
    expect(empty.status).toBe(400);
    expect(empty.body).toMatchObject({ code: "nothing_to_send" });

    await agent.post(`/api/chats/${chat.chatId}/review-threads`).send({ anchor: anchor(), text: "Call it with the config." });
    expect((await agent.post(base).send({ target: { kind: "chat", chatId: "not-a-chat" } })).status).toBe(404);

    await agent.post(`/api/chats/${chat.chatId}/dispose`).send({});
    expect((await agent.post(base).send({ target: { kind: "chat", chatId: chat.chatId } })).status).toBe(404);
  });
});
