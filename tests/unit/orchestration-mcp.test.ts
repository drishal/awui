// The orchestration tools as an HTTP MCP server, driven the way a client drives it: one POST per
// JSON-RPC message with the chat's token in `Authorization: Bearer`. The point of these tests is
// that nothing about a call changes with the transport — the catalogue, the skills, the refusals,
// and the per-chat budget are the same ones the REST routes and the stdio bridge serve — and that
// the token rule is the routes' rule: a minted token for a handshake or a list, the live chat for
// a call, and a plain 401 for anything else.
import { describe, expect, it, afterEach } from "vitest";
import type { ChatSnapshot, WorkspaceInfo } from "../../src/shared/protocol.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

const TOOL_NAMES = ["delegate_task", "task_review", "task_status", "plan_workers", "task_cancel", "thread_send", "thread_read", "thread_wait", "set_status", "request_decision", "list_profiles", "schedule_heartbeat"];

async function setup(options: Parameters<typeof makeTestApp>[0] = {}) {
  const app = await makeTestApp(options);
  t = app;
  const agent = await signedIn(app);
  const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as WorkspaceInfo;
  const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
  const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
  if (!token) throw new Error("the chat was spawned without an orchestration token");
  return { app, agent, chat, token };
}

type Agent = Awaited<ReturnType<typeof signedIn>>;

/** One JSON-RPC message as the chat's child sends it. */
function post(agent: Agent, token: string, message: Record<string, unknown>) {
  return agent.post("/api/orchestration/mcp").set("authorization", `Bearer ${token}`).send(message);
}

const init = { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } };

describe("orchestration over HTTP MCP", () => {
  it("handshakes, lists the catalogue with the schema field clients require, and answers a notification 202", async () => {
    const { agent, token } = await setup();
    const hello = await post(agent, token, init);
    expect(hello.status).toBe(200);
    expect(hello.body).toMatchObject({
      jsonrpc: "2.0",
      id: 0,
      result: { protocolVersion: "2025-11-25", capabilities: { tools: {}, prompts: {} }, serverInfo: { name: "awui-orchestrate" } },
    });

    const listed = await post(agent, token, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(listed.status).toBe(200);
    const tools = listed.body.result.tools as Array<{ name: string; description: string; inputSchema: { type: string; required?: string[] } }>;
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    // The catalogue names its schema `parameters` (the Pi/omp extension's registerTool reads it);
    // MCP clients require `inputSchema`, and Claude Code and Codex refuse a tool without it.
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe("object");
      expect(tool).not.toHaveProperty("parameters");
    }
    expect(tools.find((tool) => tool.name === "delegate_task")?.inputSchema.required).toEqual(["brief"]);

    // A notification needs no answer, and 202 with an empty body is the answer.
    const noted = await post(agent, token, { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(noted.status).toBe(202);
    expect(noted.text).toBe("");
    // A method this server does not serve is a JSON-RPC error, not a crash: a newer client's own
    // probe (`server/discover`) must be able to fall back to initialize.
    const unknown = await post(agent, token, { jsonrpc: "2.0", id: 2, method: "server/discover" });
    expect(unknown.body.error).toMatchObject({ code: -32601 });
    expect((await post(agent, token, { jsonrpc: "2.0", id: 3, method: "ping" })).body.result).toEqual({});
  });

  it("runs a call as the token's chat, and answers a refusal as a result the model can read", async () => {
    const { agent, token } = await setup({ orchestrationLimits: { callsPerMinute: 2 } });
    const profiles = await post(agent, token, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "list_profiles", arguments: {} } });
    expect(profiles.status).toBe(200);
    const listed = profiles.body.result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(listed.isError).toBeUndefined();
    expect(listed.content[0]?.text.length).toBeGreaterThan(0);

    // The arguments are the tool's own schema: a wait with no tasks is refused the way REST refuses it.
    const bad = await post(agent, token, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "thread_wait", arguments: {} } });
    expect(bad.body.result).toMatchObject({ isError: true });
    expect(bad.body.result.content[0].text).toMatch(/^invalid_request: /);

    // The per-minute budget is the orchestrator's, so a third call is the same 429 as REST, as a result.
    const over = await post(agent, token, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_profiles", arguments: {} } });
    expect(over.body.result).toMatchObject({ isError: true });
    expect(over.body.result.content[0].text).toMatch(/^too_many_calls: /);
    // The refusal's typed code rides beside the sentence, so an agent tests the code, not the words.
    const structured = over.body.result.structuredContent as { ok: boolean; code: string; message: string };
    expect(structured).toMatchObject({ ok: false, code: "too_many_calls" });
    expect(structured.message).toBe(over.body.result.content[0].text.slice("too_many_calls: ".length));

    // A name the catalogue does not carry is a protocol error, as it is through the stdio bridge.
    const unknown = await post(agent, token, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "steal_everything", arguments: {} } });
    expect(unknown.body.error).toMatchObject({ code: -32602, message: "Unknown tool: steal_everything" });
  });

  it("serves the orchestration skills as prompts, and refuses one it does not have", async () => {
    const { agent, token } = await setup();
    const listed = await post(agent, token, { jsonrpc: "2.0", id: 1, method: "prompts/list" });
    expect(listed.body.result.prompts.map((prompt: { name: string }) => prompt.name)).toEqual(["council", "advisor", "handoff"]);
    const got = await post(agent, token, { jsonrpc: "2.0", id: 2, method: "prompts/get", params: { name: "advisor" } });
    const prompt = got.body.result as { description: string; messages: Array<{ role: string; content: { type: string; text: string } }> };
    expect(prompt.description.length).toBeGreaterThan(10);
    expect(prompt.messages[0]?.role).toBe("user");
    expect(prompt.messages[0]?.content.type).toBe("text");
    expect(prompt.messages[0]?.content.text).toContain("advisor");
    const missing = await post(agent, token, { jsonrpc: "2.0", id: 3, method: "prompts/get", params: { name: "steal_everything" } });
    expect(missing.body.error).toMatchObject({ code: -32602, message: "Unknown prompt: steal_everything" });
  });

  it("answers a missing, unknown, expired, or absent token the way the sibling routes do, and never repeats one", async () => {
    const { app, agent, token } = await setup();
    const absent = await agent.post("/api/orchestration/mcp").send(init);
    expect(absent.status).toBe(401);
    expect(absent.body).toMatchObject({ ok: false, code: "bad_orch_token" });

    // The routes' own header is not this endpoint's: MCP clients send `Authorization: Bearer`.
    const wrongHeader = await agent.post("/api/orchestration/mcp").set("x-awui-orch-token", token).send(init);
    expect(wrongHeader.status).toBe(401);

    const wrong = await post(agent, token.replace(/.$/, "0"), init);
    expect(wrong.status).toBe(401);
    expect(wrong.body.code).toBe("bad_orch_token");

    const chat = app.manager.list().find((c) => c.orchestration?.token === token);
    if (!chat?.orchestration) throw new Error("no token to expire");
    chat.orchestration.expiresAt = Date.now() - 1;
    const expired = await post(agent, token, init);
    expect(expired.status).toBe(401);
    expect(expired.body.code).toBe("orch_token_expired");
    // Nothing in an answer carries the token back.
    expect(JSON.stringify(expired.body)).not.toContain(token);
  });

  // A body that is not JSON at all: a client must be told its message was not a message, which the
  // route map's `{ ok: false, code }` envelope does not say.
  it("answers a body it cannot parse with JSON-RPC's parse error", async () => {
    const { app, agent, token } = await setup();
    const broken = await agent.post("/api/orchestration/mcp").set("authorization", `Bearer ${token}`).set("content-type", "application/json").send('{"jsonrpc": "2.0", "id": 1, ');
    expect(broken.status).toBe(400);
    expect(broken.body).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    // The endpoint is still there afterwards.
    const ok = await post(agent, token, init);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ jsonrpc: "2.0", id: 0 });
    void app;
  });

  it("is off with the rest of the surface, and needs the chat itself to run a tool", async () => {
    const off = await makeTestApp({ orchestrationLimits: { enabled: false } });
    t = off;
    const agent = await signedIn(off);
    const ws = (await agent.post("/api/workspaces/open").send({ path: off.project })).body as WorkspaceInfo;
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    // The switch is read now: a chat already open keeps its token, but the endpoint refuses it.
    const token = off.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token ?? "0".repeat(32);
    const res = await post(agent, token, init);
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ ok: false, code: "orch_off" });
  });
});
