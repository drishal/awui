// The orchestration surface's foundations: one token per live chat (minted with the
// spawn, 12 hours long, never for a read-only harness or a board-owned chat), the tool
// catalogue both bridges fetch, and the call endpoint. At this stage only list_profiles
// is served; the delegation tools are defined and answer unknown_tool until the durable
// task store lands.
import { mkdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import type { ChatSnapshot, WorkspaceInfo } from "../../src/shared/protocol.js";
import { ChatManager } from "../../src/server/chats/manager.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { makeTestApp, signedIn, tempDir, type TestApp } from "../helpers/app.js";
import { makeBot } from "../helpers/board.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const TOOL_NAMES = ["delegate_task", "task_status", "task_cancel", "thread_send", "thread_read", "thread_wait", "list_profiles"];

async function setup() {
  const app = await makeTestApp();
  t = app;
  const agent = await signedIn(app);
  const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as WorkspaceInfo;
  const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
  const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
  if (!token) throw new Error("the chat was spawned without an orchestration token");
  return { app, agent, ws, chat, token };
}

describe("orchestration surface", () => {
  it("serves the tool catalogue to a live chat's child", async () => {
    const { agent, token } = await setup();
    const res = await agent.get("/api/orchestration/tools").set("x-awui-orch-token", token);
    expect(res.status).toBe(200);
    const tools = res.body.tools as Array<{ name: string; description: string; parameters: { type: string; required?: string[] } }>;
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(40);
      expect(tool.parameters.type).toBe("object");
    }
    // The brief is the one required argument of a delegation; a wait names its tasks.
    expect(tools.find((tool) => tool.name === "delegate_task")?.parameters.required).toEqual(["brief"]);
    expect(tools.find((tool) => tool.name === "thread_wait")?.parameters.required).toEqual(["taskIds"]);
  });

  it("answers a bad, absent, or expired token and nothing else", async () => {
    const { app, agent, token } = await setup();
    const absent = await agent.get("/api/orchestration/tools");
    expect(absent.status).toBe(401);
    expect(absent.body.code).toBe("bad_orch_token");
    expect((await agent.get("/api/orchestration/tools").set("x-awui-orch-token", "0".repeat(32))).status).toBe(401);

    // Twelve hours after the spawn the token is spent, and the answer says to restart the chat.
    const chat = app.manager.list().find((c) => c.orchestration?.token === token);
    if (!chat?.orchestration) throw new Error("no token to expire");
    chat.orchestration.expiresAt = Date.now() - 1;
    const expired = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "list_profiles", args: {} });
    expect(expired.status).toBe(401);
    expect(expired.body).toMatchObject({ ok: false, code: "orch_token_expired" });
  });

  it("serves an unknown tool and an unwired one as an error the bridges can read", async () => {
    const { agent, token } = await setup();
    const unknown = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "steal_everything", args: {} });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ ok: false, code: "unknown_tool" });
    const unwired = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "delegate_task", args: { brief: "x" } });
    expect(unwired.status).toBe(400);
    expect(unwired.body).toMatchObject({ ok: false, code: "unknown_tool" });
    // Arguments are validated before dispatch: a wait with no tasks is a bad request.
    const invalid = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "thread_wait", args: { taskIds: [] } });
    expect(invalid.status).toBe(400);
  });

  it("lists the project's bots and every delegation-capable harness", async () => {
    const { agent, ws, token } = await setup();
    const bot = await makeBot(agent, { name: "Critic", role: "review", instructions: "Review only, change nothing.", model: "fake/slow" });
    const res = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "list_profiles", args: {} });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const data = res.body.data as {
      profiles: Array<{ id: string; source: string; name: string; harnessId: string; model: string | null; provider: string | null; role: string | null; note: string | null; available: boolean }>;
      workspace: WorkspaceInfo;
      remainingDepth: number;
      remainingTasks: number;
    };
    expect(data.workspace.id).toBe(ws.id);
    expect(data.remainingDepth).toBe(2);
    expect(data.remainingTasks).toBe(4);
    expect(data.profiles.find((p) => p.id === bot.id)).toMatchObject({
      source: "bot",
      name: "Critic",
      harnessId: "fake",
      model: "fake/slow",
      provider: "fake",
      role: "review",
      note: "Review only, change nothing.",
      available: true,
    });
    // fake and fake-b are registered; each harness is one entry at its own default model.
    expect(data.profiles.filter((p) => p.source === "harness").map((p) => p.name)).toEqual(["Fake", "Fake B"]);
    expect(data.profiles.find((p) => p.source === "harness" && p.harnessId === "fake-b")?.model).toBeNull();
    // The text is one composed line per profile, which is what a model reads.
    expect(res.body.text).toContain(`Critic · Fake · fake/slow · review`);
  });

  it("gives a read-only harness no orchestration token", async () => {
    // The adapter-level rule the awui harness declares: a child of it would carry the write and exec tools it denies.
    const manager = new ChatManager();
    manager.render = { baseUrl: "http://127.0.0.1:1" };
    manager.orchestration = { baseUrl: "http://127.0.0.1:1" };
    const project = tempDir("awui-ro-");
    mkdirSync(path.join(project, "proj"));
    const workspace: WorkspaceInfo = { id: "w1", path: path.join(project, "proj"), name: "proj" };
    const adapter = new FakeAdapter({ id: "read-only", capabilities: { readOnlyHarness: true } });
    try {
      const chat = await manager.create(adapter, workspace);
      expect(chat.orchestration).toBeUndefined();
      expect(chat.render?.token).toMatch(/^[0-9a-f]{32}$/);
      expect(manager.chatForOrchToken("0".repeat(32))).toBeUndefined();
    } finally {
      await manager.shutdown();
    }
  });
});
