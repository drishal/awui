// The whole delegation loop on one server: a chat's child calls the orchestration
// tools the way the pi/omp extension and the MCP bridge do (the fake adapter POSTs
// to the real /api/orchestration/call with its own token), a real child chat starts
// with lineage, and the wait reports it. This is the loop every bridge rides on; the
// bridges' own spawn arguments are tested with the adapters.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot, ToolItem, WorkspaceInfo } from "../../src/shared/protocol.js";
import { makeTestApp, openSse, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe("a chat that delegates through the tools", () => {
  it("starts a child chat with lineage and waits for it, as the extension and the bridge do", async () => {
    const app = await makeTestApp();
    t = app;
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as WorkspaceInfo;
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(app, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));

    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "delegate a small task" });
    const live = () => app.manager.get(chat.chatId);
    const tool = (name: string) => live().snapshot().items.find((i): i is ToolItem => i.kind === "tool" && i.name === name);
    await sse.waitFor(() => live().status === "idle" && Boolean(tool("thread_wait")), 30_000);

    // The call went out and came back: a task in a fresh child chat, then its finished result.
    expect(tool("delegate_task")?.status).toBe("done");
    expect(tool("delegate_task")?.output).toMatch(/^Delegated task [0-9a-f]{4,16} is working in a fresh fake chat: "Fake delegated task"/);
    expect(tool("thread_wait")?.status).toBe("done");
    expect(tool("thread_wait")?.output).toMatch(/· result_available \(done\) · fake/);
    expect(tool("thread_wait")?.output).toContain("Echo: Reply with the word child.");

    // A real child chat, openable and carrying its lineage back to this one.
    const child = app.manager.list().find((c) => c.lineage?.parentChatId === chat.chatId);
    expect(child?.lineage).toMatchObject({ kind: "delegate", parentChatId: chat.chatId, depth: 1 });
    const childSnap = (await agent.get(`/api/chats/${child?.chatId}`)).body as ChatSnapshot;
    expect(childSnap.lineage?.taskId).toBeTruthy();
    expect(childSnap.items.some((i) => i.kind === "assistant" && i.text.includes("child"))).toBe(true);
    sse.close();
  });
});
