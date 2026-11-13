// render_html for Claude Code: awui's MCP server (extensions/render-html-mcp.mjs)
// speaks MCP, posts the page to the chat's render endpoint, and marks the page
// on its result's last line; the Claude adapter gives each chat the server and
// lifts the page onto the tool card, only from that tool.
import { spawn } from "node:child_process";
import { chmodSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import readline from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot, ToolItem } from "../../src/shared/protocol.js";
import { ClaudeAdapter } from "../../src/server/harness/claude.js";
import { renderHtmlMcpServer } from "../../src/server/harness/render-extension.js";
import { htmlRenderFromDetails, splitRenderMarker } from "../../src/server/harness/render-token.js";
import { makeTestApp, openSse, signedIn, tempDir, type TestApp } from "../helpers/app.js";

const server = renderHtmlMcpServer() as string;
const fakeClaude = path.join(import.meta.dirname, "..", "fixtures", "fake-claude.mjs");
chmodSync(fakeClaude, 0o755);

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

/** The MCP server on stdio, with `env`; `call` sends a request and waits for its answer. */
function mcp(env: Record<string, string>) {
  const child = spawn(process.execPath, [server], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map<number, (m: { result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }> }; error?: { message: string } }) => void>();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const m = JSON.parse(line) as { id: number; result?: Record<string, unknown>; error?: { message: string } };
    waiting.get(m.id)?.(m);
  });
  let id = 0;
  return {
    call: (method: string, params?: unknown) =>
      new Promise<{ result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string }> }; error?: { message: string } }>((resolve) => {
        waiting.set(++id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    stop: () => child.kill(),
  };
}

describe("the render_html MCP server", () => {
  it("lists render_html, posts the page with the chat's token, and marks the page on its last line", async () => {
    const posted: Array<{ token: string | undefined; body: unknown }> = [];
    const endpoint = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        posted.push({ token: req.headers["x-awui-render-token"] as string | undefined, body: JSON.parse(body) });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ id: "a".repeat(32), url: "/x" }));
      });
    });
    await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/api/render`;
    const s = mcp({ AWUI_RENDER_URL: url, AWUI_RENDER_TOKEN: "tok" });
    try {
      expect((await s.call("initialize", { protocolVersion: "2025-06-18" })).result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} } });
      const tools = (await s.call("tools/list")).result?.tools as Array<{ name: string }>;
      expect(tools.map((x) => x.name)).toEqual(["render_html", "browser_action"]);
      const done = (await s.call("tools/call", { name: "render_html", arguments: { html: "<h1>Hi</h1>", title: "Chart", height: 5000 } })).result as { content: Array<{ text: string }> };
      expect(posted).toEqual([{ token: "tok", body: { html: "<h1>Hi</h1>", title: "Chart", height: 2000 } }]);
      const split = splitRenderMarker(done.content[0]?.text ?? "");
      expect(split.text).toBe('Rendered "Chart" into the chat. The page is above; do not describe or restate it in your reply.');
      expect(htmlRenderFromDetails("mcp__awui__render_html", {}, split.details)).toEqual({ id: "a".repeat(32), title: "Chart", height: 2000 });
      expect((await s.call("tools/call", { name: "render_html", arguments: { html: " " } })).result).toMatchObject({ isError: true });
      expect((await s.call("nope")).error?.message).toMatch(/not found/);
    } finally {
      s.stop();
      endpoint.close();
    }
  });

  it("lets the local render driver match by URL only, not arbitrary remote pages", async () => {
    const posted: Array<{ token?: string; body: string }> = [];
    const endpoint = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => body += chunk);
      req.on("end", () => {
        posted.push({ token: req.headers["x-awui-render-token"] as string | undefined, body });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ renderId: "ac".repeat(16), action: "snapshot", elements: [{ role: "button", label: "hello", selector: "#done" }], console: [] }));
      });
    });
    await new Promise<void>((r) => endpoint.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/api/render`;
    const m = mcp({ AWUI_RENDER_URL: base, AWUI_RENDER_TOKEN: "owner-render-token" });
    try {
      const listed = (await m.call("tools/list")).result?.tools as Array<{ name: string }>;
      expect(listed.some((tool) => tool.name === "browser_action")).toBe(true);
      const answer = await m.call("tools/call", { name: "browser_action", arguments: { renderId: "ac".repeat(16), action: "snapshot" } });
      expect(answer.result?.content?.[0]?.text).toContain("hello");
      expect(answer.result?.content?.[0]?.text).toContain("hello");
      expect(posted[0]?.token).toBe("owner-render-token");
      const sent = posted[0];
      if (!sent) throw new Error("browser action did not reach the owner route");
      expect(JSON.parse(sent.body)).toEqual({ renderId: "ac".repeat(16), action: "snapshot" });
    } finally {
      m.stop();
      endpoint.close();
    }
  });

  it("serves no tool without the chat's endpoint", async () => {
    const s = mcp({ AWUI_RENDER_URL: "", AWUI_RENDER_TOKEN: "" });
    try {
      await s.call("initialize", {});
      expect((await s.call("tools/list")).result?.tools).toEqual([]);
    } finally {
      s.stop();
    }
  });

  it("takes a page only off a render result's last line, and only for the render tool", () => {
    const ref = { id: "b".repeat(32), title: "T", height: 300 };
    expect(splitRenderMarker(`done\nawui-html-render: ${JSON.stringify(ref)}`)).toEqual({ text: "done", details: { htmlRender: ref } });
    expect(splitRenderMarker("no marker here")).toEqual({ text: "no marker here" });
    expect(splitRenderMarker("x\nawui-html-render: {broken")).toEqual({ text: "x\nawui-html-render: {broken" });
    // The same line from a shell command publishes nothing.
    expect(htmlRenderFromDetails("Bash", {}, splitRenderMarker(`awui-html-render: ${JSON.stringify(ref)}`).details)).toBeUndefined();
  });
});

describe("render_html in a Claude Code chat", () => {
  it("is given to the CLI as an MCP server, allowed, and its page lands on the tool card", async () => {
    t = await makeTestApp();
    const home = tempDir("awui-claude-render-");
    const state = path.join(home, "state.json");
    const adapter = new ClaudeAdapter({ command: fakeClaude, home, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), FAKE_CLAUDE_STATE: state } });
    expect(adapter.capabilities.supportsHtmlRender).toBe(true);
    t.registry.register(adapter);
    await t.registry.refreshStatus();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "claude", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "render a chart" });
    const card = () => (t as TestApp).manager.get(chat.chatId).snapshot().items.find((i): i is ToolItem => i.kind === "tool" && i.name === "mcp__awui__render_html");
    await sse.waitFor(() => Boolean(card()?.htmlRender) && (t as TestApp).manager.get(chat.chatId).status === "idle", 20_000);
    expect(card()?.htmlRender).toMatchObject({ title: "Fake chart", height: 200 });
    expect(card()?.output).not.toContain("awui-html-render");
    // The page is this chat's, served back to it.
    const page = await agent.get(`/api/chats/${chat.chatId}/html-render/${card()?.htmlRender?.id}`);
    expect(page.status).toBe(200);
    expect(page.text).toContain("Fake chart");
    sse.close();
    await adapter.shutdown();
  });
});
