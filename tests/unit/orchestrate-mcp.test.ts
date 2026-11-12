// The orchestration tools for Claude Code, Codex, and DSH: awui's MCP server
// (extensions/orchestrate-mcp.mjs) fetches the tool catalogue from the chat's
// own endpoint and forwards every call to it with the chat's token, which is
// what makes one tool description (orchestration/tools.ts) serve every harness.
import { spawn } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";

const script = path.join(import.meta.dirname, "..", "..", "extensions", "orchestrate-mcp.mjs");

/** The MCP server on stdio, with `env`; `call` sends a request and waits for its answer. */
function mcp(env: Record<string, string>) {
  const child = spawn(process.execPath, [script], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map<number, (m: Message) => void>();
  const lines: string[] = [];
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    lines.push(line);
    const m = JSON.parse(line) as Message;
    waiting.get(m.id as number)?.(m);
  });
  readline.createInterface({ input: child.stderr }).on("line", (line) => lines.push(line));
  let id = 0;
  return {
    lines,
    call: (method: string, params?: unknown) =>
      new Promise<Message>((resolve) => {
        waiting.set(++id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    stop: () => child.kill(),
  };
}

interface Message {
  id: number | null;
  result?: {
    protocolVersion?: string;
    capabilities?: unknown;
    tools?: Array<{ name: string }>;
    prompts?: Array<{ name: string; description?: string }>;
    messages?: Array<{ role: string; content: { type: string; text: string } }>;
    content?: Array<{ text: string }>;
    isError?: boolean;
  };
  error?: { code: number; message: string };
}

const TOOLS = [
  { name: "delegate_task", description: "Delegate one task.", parameters: { type: "object", properties: { brief: { type: "string" } }, required: ["brief"] } },
  { name: "task_status", description: "Report your tasks.", parameters: { type: "object", properties: {} } },
];

/** The skills the endpoint serves as prompts; the bridge repeats none of their words. */
const PROMPTS = [
  { name: "council", description: "Three reviewers, merged.", text: "# Council\n\nCall list_profiles, then delegate_task three times." },
  { name: "advisor", description: "One reviewer.", text: "# Advisor\n\nReview only. Change nothing." },
];

/** A stub endpoint: the catalogue, then whatever the test queues for each call. */
async function endpoint(answers: Array<{ status: number; body: unknown }>) {
  const seen: Array<{ path: string; token: string | undefined; body: unknown }> = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const token = req.headers["x-awui-orch-token"] as string | undefined;
      if (req.url === "/api/orchestration/tools") {
        seen.push({ path: req.url, token, body: null });
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ tools: TOOLS }));
      }
      if (req.url === "/api/orchestration/prompts") {
        seen.push({ path: req.url, token, body: null });
        res.setHeader("content-type", "application/json");
        return res.end(JSON.stringify({ prompts: PROMPTS }));
      }
      const answer = answers.shift() ?? { status: 500, body: {} };
      seen.push({ path: req.url ?? "", token, body: JSON.parse(body) });
      res.statusCode = answer.status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/orchestration`;
  return { url, seen, close: () => server.close() };
}

let open: (() => void) | null = null;
afterEach(() => {
  open?.();
  open = null;
});

describe("the orchestration MCP server", () => {
  it("serves the chat's catalogue and forwards a call with the chat's token", async () => {
    const stub = await endpoint([{ status: 200, body: { ok: true, text: "Delegated task ab12 to pi.", data: { taskId: "ab12" } } }]);
    const s = mcp({ AWUI_ORCH_URL: stub.url, AWUI_ORCH_TOKEN: "a".repeat(32) });
    open = () => {
      s.stop();
      stub.close();
    };
    try {
      // Both capabilities are advertised when the chat has an endpoint; neither without one.
      expect((await s.call("initialize", { protocolVersion: "2025-06-18" })).result).toMatchObject({
        protocolVersion: "2025-06-18",
        capabilities: { tools: {}, prompts: {} },
      });
      expect((await s.call("tools/list")).result?.tools).toEqual(TOOLS);
      // Fetched once: a second listing comes from memory, not the endpoint.
      expect((await s.call("tools/list")).result?.tools).toEqual(TOOLS);
      expect(stub.seen.filter((r) => r.path.endsWith("/tools"))).toHaveLength(1);
      // The skills come the same way: listed by name and description, fetched once, and the
      // prompt's message is exactly the text the server carries.
      expect((await s.call("prompts/list")).result?.prompts).toEqual(PROMPTS.map(({ name, description }) => ({ name, description })));
      expect((await s.call("prompts/get", { name: "advisor" })).result?.messages).toEqual([{ role: "user", content: { type: "text", text: PROMPTS[1]?.text } }]);
      expect((await s.call("prompts/list")).result?.prompts).toHaveLength(2);
      expect(stub.seen.filter((r) => r.path.endsWith("/prompts"))).toHaveLength(1);
      expect((await s.call("prompts/get", { name: "steal_everything" })).error?.message).toMatch(/Unknown prompt/);
      const done = (await s.call("tools/call", { name: "delegate_task", arguments: { brief: "Do the thing" } })).result;
      expect(done?.content).toEqual([{ type: "text", text: "Delegated task ab12 to pi." }]);
      expect(done?.isError).toBeUndefined();
      expect(stub.seen.at(-1)).toEqual({ path: "/api/orchestration/call", token: "a".repeat(32), body: { tool: "delegate_task", args: { brief: "Do the thing" } } });
    } finally {
      s.stop();
      stub.close();
      open = null;
    }
  });

  it("answers a refused call with its code and message, and serves no tool without the chat's endpoint", async () => {
    const stub = await endpoint([
      { status: 403, body: { ok: false, code: "not_your_task", message: "That task belongs to another chat" } },
      { status: 404, body: { ok: false, code: "unknown_tool", message: "No such tool: thread_read" } },
    ]);
    const s = mcp({ AWUI_ORCH_URL: stub.url, AWUI_ORCH_TOKEN: "b".repeat(32) });
    open = () => {
      s.stop();
      stub.close();
    };
    try {
      await s.call("initialize", {});
      const refused = (await s.call("tools/call", { name: "task_status", arguments: { taskId: "ab12" } })).result;
      expect(refused).toEqual({ content: [{ type: "text", text: "not_your_task: That task belongs to another chat" }], isError: true });
      const unwired = (await s.call("tools/call", { name: "task_status", arguments: { taskId: "ab12" } })).result;
      expect(unwired).toEqual({ content: [{ type: "text", text: "unknown_tool: No such tool: thread_read" }], isError: true });
      expect((await s.call("nope")).error?.message).toMatch(/not found/);
      // A tool outside the catalogue never reaches the endpoint.
      expect((await s.call("tools/call", { name: "rm_rf", arguments: {} })).error?.message).toMatch(/Unknown tool/);
      expect(stub.seen.filter((r) => r.path.endsWith("/call"))).toHaveLength(2);
    } finally {
      s.stop();
      stub.close();
      open = null;
    }
  });

  it("serves no tool at all without both variables, and names an unreachable endpoint clearly", async () => {
    const bare = mcp({ AWUI_ORCH_URL: "", AWUI_ORCH_TOKEN: "" });
    try {
      expect((await bare.call("initialize", {})).result?.capabilities).toEqual({ tools: {} });
      expect((await bare.call("tools/list")).result?.tools).toEqual([]);
      // Prompts are not advertised without the endpoint, and a prompt nobody serves is unknown.
      expect((await bare.call("prompts/list")).result).toEqual({ prompts: [] });
      expect((await bare.call("prompts/get", { name: "council" })).error?.message).toMatch(/Unknown prompt/);
    } finally {
      bare.stop();
    }
    // A port nothing listens on: the call fails as a readable result, not a hang.
    const s = mcp({ AWUI_ORCH_URL: "http://127.0.0.1:9/api/orchestration", AWUI_ORCH_TOKEN: "c".repeat(32) });
    try {
      const listed = await s.call("tools/list");
      expect(listed.error?.message).toContain("could not read the orchestration tool catalogue");
      expect((await s.call("prompts/list")).error?.message).toContain("could not read the orchestration skills");
      expect(s.lines.join("\n")).not.toContain("c".repeat(32));
    } finally {
      s.stop();
    }
  });
});
