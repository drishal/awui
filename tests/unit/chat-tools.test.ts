// A call the harness never answers: a cancelled question, or a lost result. The
// run says when it is over, and no row may still spin after that.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot, ToolItem } from "../../src/shared/protocol.js";
import { NO_RESULT_TEXT } from "../../src/server/harness/agent-events.js";
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

const tools = (chat: ChatSnapshot): ToolItem[] => chat.items.filter((i): i is ToolItem => i.kind === "tool");

describe("a call left open when its run ends", () => {
  it("is closed, and says it got no result, instead of spinning on", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const live = () => (t as TestApp).manager.get(chat.chatId);

    expect(tools(live().snapshot())).toEqual([]);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "leave one unfinished" });
    await until(() => tools(live().snapshot()).length === 1);
    await until(() => live().status === "idle");

    const [tool] = tools(live().snapshot());
    expect(tool).toMatchObject({ name: "ask_user", status: "done", output: NO_RESULT_TEXT });
    expect(tool?.endedAt).toBeTypeOf("number");
  });

  it("a task job it never heard back from stops at the settle, not at the stale cutoff", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const live = () => (t as TestApp).manager.get(chat.chatId);

    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "orphantask" });
    await until(() => live().status === "idle");

    const [spawn] = tools(live().snapshot());
    expect(spawn?.jobs).toBeDefined();
    const [job] = spawn?.jobs ?? [];
    expect(job?.id).toBe("EsetResearch");
    expect(job?.status).toBe("stopped");
    expect(job?.endedAt).toBeTypeOf("number");
  });
});

describe("a run that does more than write", () => {
  async function setUp() {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    return { agent, chat, live: () => (t as TestApp).manager.get(chat.chatId) };
  }

  it("stays running across a compaction in the middle of it, so the next send queues instead of being rejected", async () => {
    const { agent, chat, live } = await setUp();
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "midcompact please" });
    await until(() => live().status === "compacting");
    // pi sends no second start when its mid-run compaction ends: the run is still the one from the prompt.
    await until(() => live().status !== "compacting");
    expect(live().status).toBe("running");
    const queued = await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "and now this", mode: "followUp" });
    expect(queued.status).toBe(202);
    await until(() => live().status === "idle");
    expect(live().snapshot().items.flatMap((i) => (i.kind === "user" ? [i.text] : []))).toEqual(["midcompact please", "and now this"]);
  });

  it("does not call itself idle when the harness refuses a prompt because it is still going", async () => {
    const { agent, chat, live } = await setUp();
    const refused = await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "contended, are you busy?" });
    expect(refused.status).toBe(422);
    expect(refused.body).toMatchObject({ code: "prompt_rejected" });
    // The harness said it is processing: the chat keeps saying so, and a plain send is refused here.
    expect(live().status).toBe("running");
    const plain = await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hello again" });
    expect(plain.status).toBe(409);
  });
});
