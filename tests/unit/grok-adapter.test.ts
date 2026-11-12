import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { GrokAdapter, liveGrokChildren } from "../../src/server/harness/grok.js";
import { contextTokens, costUsd, foldSessionUpdate, foldsFromJsonl, GrokSubagentBook, itemsFromFolds } from "../../src/server/harness/grok-transcript.js";
import type { LiveChat } from "../../src/server/harness/types.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

const script = path.join(import.meta.dirname, "..", "fixtures", "fake-grok.mjs");
chmodSync(script, 0o755);

let home: string;
/** The agent dir: what GROK_HOME points at, never the developer's ~/.grok. */
let grokHome: string;
let project: string;
let state: string;
let adapter: GrokAdapter;
const open: LiveChat[] = [];

beforeEach(() => {
  home = tempDir("awui-grok-home-");
  grokHome = path.join(home, ".grok");
  project = path.join(home, "proj");
  mkdirSync(project);
  state = path.join(home, "state.json");
  adapter = new GrokAdapter({ command: script, home, env: { ...process.env, GROK_HOME: grokHome, FAKE_GROK_HOME: grokHome, FAKE_GROK_STATE: state } });
});

afterEach(async () => {
  for (const chat of open.splice(0)) await chat.dispose();
  await adapter.shutdown();
  expect(liveGrokChildren()).toBe(0);
});

const ws = (): WorkspaceInfo => ({ id: "w", path: project, name: "proj" });

async function openChat(resumeNativeId?: string, toolEnv?: NodeJS.ProcessEnv) {
  const live = await adapter.openChat({ cwd: project, ...(resumeNativeId ? { resumeNativeId } : {}), ...(toolEnv ? { toolEnv } : {}) });
  open.push(live);
  return { live, chat: await Chat.open(`c${open.length}`, adapter, ws(), live) };
}

/** What a chat's render and orchestration tokens are, as the server hands them to a child. */
const tokens = { AWUI_RENDER_URL: "http://127.0.0.1:4783/api/render", AWUI_RENDER_TOKEN: "r0ken", AWUI_ORCH_URL: "http://127.0.0.1:4783/api/orchestration", AWUI_ORCH_TOKEN: "t0ken" };

async function until(predicate: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

const recorded = (key: string): unknown[] => {
  try {
    return (JSON.parse(readFileSync(state, "utf8")) as Record<string, unknown[]>)[key] ?? [];
  } catch {
    return [];
  }
};

const answered = (chat: Chat, text: string) => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.includes(text));
const toolItem = (chat: Chat) => {
  const item = chat.snapshot().items.find((i) => i.kind === "tool");
  if (!item || item.kind !== "tool") throw new Error("no tool item");
  return item;
};

/** The group directory Grok names after the encoded cwd. */
const grokSessions = (cwd: string) => path.join(grokHome, "sessions", encodeURIComponent(cwd));

/** A session directory with the summary and jsonl a session of Grok's would have. */
function plantSession(id: string, cwd: string, options: { title?: string | null; updates?: Array<Record<string, unknown>>; group?: string } = {}) {
  const group = options.group ? path.join(grokHome, "sessions", options.group) : grokSessions(cwd);
  const dir = path.join(group, id);
  mkdirSync(dir, { recursive: true });
  const lines = (options.updates ?? []).map((update) => JSON.stringify({ timestamp: 1792245548, method: "session/update", params: { update } }));
  writeFileSync(path.join(dir, "updates.jsonl"), lines.length > 0 ? `${lines.join("\n")}\n` : "");
  writeFileSync(
    path.join(dir, "summary.json"),
    `${JSON.stringify({ info: { id, cwd }, generated_title: options.title ?? null, current_model_id: "grok-4.7", created_at: new Date().toISOString(), updated_at: new Date().toISOString(), num_messages: lines.length }, null, 2)}\n`,
  );
  return dir;
}

describe("the grok adapter (scripted CLI)", () => {
  it("discovers the installed CLI, and reports a missing one with the reason to install it", async () => {
    const discovery = await adapter.discover();
    expect(discovery).toMatchObject({ available: true, version: "1.0.62", warnings: [], overrides: { GROK_HOME: "set" } });
    const missing = new GrokAdapter({ command: path.join(home, "no-such-grok"), home, env: { ...process.env, GROK_HOME: grokHome } });
    try {
      expect(await missing.discover()).toMatchObject({
        available: false,
        reason: "The grok CLI is not installed. Install Grok Build, run `grok` once, and log in.",
        warnings: [],
        overrides: { GROK_HOME: "set" },
      });
    } finally {
      await missing.shutdown();
    }
  });

  it("opens at Grok's own model and effort, with the levels each model lists", async () => {
    const { chat, live } = await openChat();
    expect(live.nativeId).toMatch(/^[0-9a-f-]{36}$/);
    const config = chat.snapshot().config;
    expect(config).toMatchObject({ model: "grok-4.7", thinkingLevel: "high" });
    expect(config.models.map((m) => [m.key, m.provider, m.levels])).toEqual([
      ["grok-4.7", "grok", ["high", "medium", "low"]],
      ["grok-4.5", "grok", ["low"]],
    ]);
    expect(config.thinkingLevels).toEqual(["high", "medium", "low"]);
  });

  it("mounts awui's MCP servers on the handshake only when the chat was given their tokens", async () => {
    await openChat();
    expect(recorded("mcpServers")).toEqual([{ method: "session/new", servers: [] }]);

    await openChat(undefined, tokens);
    const sent = recorded("mcpServers").at(-1) as { servers: Array<{ type: string; name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> };
    expect(sent.servers).toEqual([
      {
        type: "stdio",
        name: "awui",
        command: process.execPath,
        args: [path.join(import.meta.dirname, "..", "..", "extensions", "render-html-mcp.mjs")],
        env: [
          { name: "AWUI_RENDER_URL", value: tokens.AWUI_RENDER_URL },
          { name: "AWUI_RENDER_TOKEN", value: tokens.AWUI_RENDER_TOKEN },
        ],
      },
      {
        type: "stdio",
        name: "awui-orchestrate",
        command: process.execPath,
        args: [path.join(import.meta.dirname, "..", "..", "extensions", "orchestrate-mcp.mjs")],
        env: [
          { name: "AWUI_ORCH_URL", value: tokens.AWUI_ORCH_URL },
          { name: "AWUI_ORCH_TOKEN", value: tokens.AWUI_ORCH_TOKEN },
        ],
      },
    ]);
    // Grok admits a server whose name starts with a letter, holds letters, digits, underscores and
    // hyphens, and does not end in one underscore (that would make `server__tool` contain `___`).
    for (const server of sent.servers) {
      expect(server.name).toMatch(/^[A-Za-z][A-Za-z0-9_-]*[A-Za-z0-9]$/);
      expect(server.name.includes("_")).toBe(false);
    }
  });

  it("mounts the same servers when a session is loaded, and keeps their tokens off the child's own environment", async () => {
    plantSession("5c1c9a54-6a6f-4a6f-8d1c-0e6d4f0a1b2c", project, { title: "A resume" });
    const { chat } = await openChat("5c1c9a54-6a6f-4a6f-8d1c-0e6d4f0a1b2c", tokens);
    const sent = recorded("mcpServers").at(-1) as { method: string; servers: Array<{ name: string; env: Array<{ name: string; value: string }> }> };
    expect(sent.method).toBe("session/load");
    expect(sent.servers.map((server) => server.name)).toEqual(["awui", "awui-orchestrate"]);
    expect(sent.servers[0]?.env).toContainEqual({ name: "AWUI_RENDER_TOKEN", value: tokens.AWUI_RENDER_TOKEN });
    // The token travels inside the server entry the CLI spawns, never in the CLI's own environment
    // or a snapshot: a child that echoed either would leak it into a transcript.
    expect(adapter.childEnv()).not.toHaveProperty("AWUI_RENDER_TOKEN");
    expect(JSON.stringify(chat.snapshot())).not.toContain(tokens.AWUI_RENDER_TOKEN);
  });

  it("accepts a prompt the child never echoes, and does not paint an echo twice", async () => {
    const { chat } = await openChat();
    await chat.send("noecho please", "normal");
    await until(() => chat.status === "idle" && answered(chat, "grok says noecho please"));
    expect(chat.snapshot().items.filter((i) => i.kind === "user").map((i) => i.kind === "user" && i.text)).toEqual(["noecho please"]);

    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "grok says hello there"));
    expect(chat.snapshot().items.filter((i) => i.kind === "user")).toHaveLength(2);
  });

  it("streams a turn, counts its tokens, and reports the window it filled", async () => {
    const { chat, live } = await openChat();
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "grok says hello there"));
    const snap = chat.snapshot();
    expect(snap.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(snap.items[1]).toMatchObject({ text: "grok says hello there", streaming: false });
    expect(await live.getUsage()).toMatchObject({ turns: 1, steps: 1, input: 10, cachedInput: 100, cacheWrite: 2, output: 12, cost: 0.01 });
    expect(await live.getContextUsage()).toEqual({ tokens: 112, window: 256000, percent: 0 });
  });

  it("takes the context window from usage_update when the CLI sends one", async () => {
    const { chat, live } = await openChat();
    await chat.send("context please", "normal");
    await until(() => chat.status === "idle" && answered(chat, "grok says context please"));
    expect(await live.getContextUsage()).toEqual({ tokens: 2200, window: 500000, percent: 0 });
  });

  it("shows a spawn_subagent on the delegation card, and opens that child's transcript", async () => {
    const { chat } = await openChat();
    await chat.send("subagent please", "normal");
    await until(() => chat.status === "idle" && answered(chat, "grok says pong"));
    const tool = toolItem(chat);
    expect(tool).toMatchObject({
      name: "spawn_subagent",
      category: "agent",
      status: "done",
      output: "pong",
      subagents: { runs: [{ id: "11111111-1111-4111-8111-111111111111", agent: "general-purpose", task: "Ping a subagent", status: "done", model: "opencode-go", tokens: 11593, durationMs: 4776, output: "pong", transcript: true }] },
    });
    const run = tool.subagents?.runs[0];
    if (!run) throw new Error("expected a subagent run");
    const transcript = await chat.subagentTranscript(tool.id, run.id);
    expect(transcript.items.filter((item) => item.kind === "assistant").map((item) => item.kind === "assistant" && item.text)).toEqual(["pong"]);
    const nativeId = chat.nativeId;
    if (!nativeId) throw new Error("expected a session");
    // Another session of this project, and a child this chat did not spawn, stay unread.
    await expect(adapter.subagentTranscript({ nativeId: "22222222-2222-4222-8222-222222222222", cwd: project }, run)).resolves.toBeNull();
    await expect(adapter.subagentTranscript({ nativeId, cwd: project }, { ...run, id: "33333333-3333-4333-8333-333333333333" })).resolves.toBeNull();
  });

  it("keeps a background subagent running after the tool returns, then records its answer", async () => {
    const { chat } = await openChat();
    await chat.send("subagentbg please", "normal");
    await until(() => chat.status === "idle" && answered(chat, "grok says pong"));
    const tool = toolItem(chat);
    expect(tool).toMatchObject({
      status: "done",
      output: "Subagent started in background.",
      subagents: { background: true, runs: [{ status: "done", output: "pong", transcript: true }] },
    });
  });

  it("shows a tool call with its category, summary, and output", async () => {
    const { chat } = await openChat();
    await chat.send("use the tool", "normal");
    await until(() => chat.status === "idle" && toolItem(chat).status === "done");
    expect(toolItem(chat)).toMatchObject({ name: "read_file", category: "read", summary: "README.md", output: "file.txt", status: "done" });
  });

  it("settles a turn the harness finished on the wire when the prompt request is never answered", async () => {
    const { chat } = await openChat();
    await chat.send("unanswered", "normal");
    // session/prompt answers only after three seconds: turn_completed is the only
    // end of the turn here, so this settles well before that answer could.
    await until(() => chat.status === "idle" && answered(chat, "done but unanswered"), 1500);
    expect(chat.snapshot().items.some((i) => i.kind === "user" && i.text === "unanswered")).toBe(true);
  });

  it("turns Grok's permission request into a card in Grok's own words, and allows once", async () => {
    const { chat } = await openChat();
    await chat.send("ask to make a file", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    const card = chat.snapshot().pending[0];
    expect(card).toMatchObject({ kind: "select", title: "Bash", options: ["Allow once", "Always allow", "Reject"] });
    expect(card?.message).toContain("touch made.txt");
    chat.answer(card?.id as string, { kind: "select", value: "Allow once" });
    await until(() => chat.status === "idle" && toolItem(chat).status === "done");
    expect(recorded("permissions")[0]).toEqual({ outcome: "selected", optionId: "allow-once" });
    expect(toolItem(chat)).toMatchObject({ status: "done", output: "made" });
  });

  it("sends a rejection back as the option Grok named, and the tool shows as failed", async () => {
    const { chat } = await openChat();
    await chat.send("ask to make a file", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Reject" });
    await until(() => chat.status === "idle" && toolItem(chat).status === "error");
    expect(recorded("permissions")[0]).toEqual({ outcome: "selected", optionId: "reject-once" });
  });

  it("turns Grok's diff block into the unified diff the chat folds", async () => {
    const { chat } = await openChat();
    await chat.send("diff the file", "normal");
    await until(() => chat.status === "idle" && toolItem(chat).status === "done");
    const tool = toolItem(chat);
    expect(tool).toMatchObject({ category: "edit", diffStat: { added: 1, removed: 1 } });
    const lines = tool.diff?.lines ?? [];
    expect(lines.some((line) => line.kind === "del" && line.text === "a")).toBe(true);
    expect(lines.some((line) => line.kind === "add" && line.text === "b")).toBe(true);
  });

  it("streams a thought before the answer", async () => {
    const { chat } = await openChat();
    await chat.send("think about it", "normal");
    await until(() => chat.status === "idle" && answered(chat, "grok says think about it"));
    expect(chat.snapshot().items.find((i) => i.kind === "assistant")).toMatchObject({ thinking: "hmm" });
  });

  it("switches model and effort with bare strings, and refuses a level the model does not list", async () => {
    const { chat } = await openChat();
    // A level the target model does not list is refused before either value is sent.
    await expect(chat.setConfig({ model: "grok-4.5", thinkingLevel: "high" })).rejects.toMatchObject({ status: 422, code: "config_rejected" });
    expect(recorded("setConfig")).toEqual([]);
    expect(chat.snapshot().config.model).toBe("grok-4.7");
    await chat.setConfig({ model: "grok-4.5" });
    expect(chat.snapshot().config).toMatchObject({ model: "grok-4.5", thinkingLevel: "low", thinkingLevels: ["low"] });
    const sent = recorded("setConfig") as Array<{ configId: string; value: unknown }>;
    expect(sent).toEqual([{ configId: "model", value: "grok-4.5" }]);
    expect(sent.every((entry) => typeof entry.value === "string")).toBe(true);
    // A level the model does not list never reaches the wire.
    await expect(chat.setConfig({ thinkingLevel: "xhigh" })).rejects.toMatchObject({ status: 422, code: "config_rejected" });
    expect(recorded("setConfig")).toHaveLength(1);
    await chat.setConfig({ thinkingLevel: "low" });
    expect(recorded("setConfig")[1]).toEqual({ configId: "reasoning_effort", value: "low" });
  });

  it("refuses an image on a build that takes none, without sending a prompt", async () => {
    const { chat } = await openChat();
    await expect(chat.send("hello there", "normal", [{ mimeType: "image/png", data: "aGk=" }])).rejects.toMatchObject({ code: "prompt_rejected" });
    expect(recorded("prompts")).toEqual([]);
  });

  it("stops a slow run on Grok's own cancel", async () => {
    const { chat } = await openChat();
    await chat.send("slow please", "normal");
    await until(() => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.length > 0));
    await chat.abort();
    expect(chat.status).toBe("idle");
    expect(recorded("cancels")).toHaveLength(1);
  });

  it("reports a turn that failed after Grok took it, and still settles", async () => {
    const { chat } = await openChat();
    await chat.send("fail now", "normal");
    await until(() => chat.status === "idle" && chat.snapshot().items.some((i) => i.kind === "notice"));
    expect(chat.snapshot().items.find((i) => i.kind === "notice")).toMatchObject({ level: "error", text: "boom" });
    expect(recorded("prompts")).toEqual(["fail now"]);
  });

  it("resumes from the session file without replaying the load or double-counting its turn", async () => {
    const { chat, live } = await openChat();
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "grok says hello there"));
    const nativeId = live.nativeId as string;
    await chat.dispose("done");

    const { chat: resumed, live: again } = await openChat(nativeId);
    expect(again.nativeId).toBe(nativeId);
    expect(JSON.stringify(resumed.snapshot())).not.toContain("REPLAY");
    expect(resumed.snapshot().items.filter((i) => i.kind === "user")).toHaveLength(1);
    expect(await again.getUsage()).toMatchObject({ turns: 1, cost: 0.01 });

    await resumed.send("and again", "normal");
    await until(() => resumed.status === "idle" && answered(resumed, "grok says and again"));
    expect(await again.getUsage()).toMatchObject({ turns: 2, cost: 0.02 });
    // The new prompt is its own row. Reusing the loaded `u1` used to replace the first message, and the new thought landed in the first assistant row.
    const users = resumed.snapshot().items.filter((item) => item.kind === "user").map((item) => (item.kind === "user" ? item.text : ""));
    expect(users).toEqual(["hello there", "and again"]);
    expect(resumed.snapshot().items.some((item) => item.kind === "assistant" && item.text.includes("grok says hello there"))).toBe(true);
  });

  it("lists a project's sessions, and gives a resume command for them", async () => {
    const { chat, live } = await openChat();
    await chat.send("list me", "normal");
    await until(() => chat.status === "idle" && answered(chat, "grok says list me"));
    const nativeId = live.nativeId as string;
    const sessions = await adapter.listSessions(project);
    expect(sessions.map((s) => [s.nativeId, s.title, s.messageCount])).toEqual([[nativeId, "list me", 1]]);
    expect((await adapter.listRecentSessions(10)).map((s) => s.nativeId)).toEqual([nativeId]);
    expect(await adapter.resumeCommand({ cwd: project, nativeId })).toEqual(["grok", "--resume", nativeId]);
    expect(await adapter.resumeCommand({ cwd: project, nativeId: "../../etc/passwd" })).toBeNull();
    expect(await adapter.resumeCommand({ cwd: project, nativeId: "00000000-0000-4000-8000-000000000000" })).toBeNull();
  });

  it("leaves out a session whose own cwd is elsewhere", async () => {
    const other = path.join(home, "other");
    mkdirSync(other);
    plantSession("33333333-3333-4333-8333-333333333333", other, { group: "not-this-project" });
    expect(await adapter.listSessions(project)).toEqual([]);
  });

  it("includes a sibling group directory whose .cwd file names the project", async () => {
    const group = "a-very-long-slug-and-hash";
    mkdirSync(path.join(grokHome, "sessions", group), { recursive: true });
    writeFileSync(path.join(grokHome, "sessions", group, ".cwd"), `${project}\n`);
    plantSession("44444444-4444-4444-8444-444444444444", project, { group });
    expect((await adapter.listSessions(project)).map((s) => s.nativeId)).toEqual(["44444444-4444-4444-8444-444444444444"]);
  });

  it("reads a transcript from the file, with the generated title or none", async () => {
    const id = "55555555-5555-4555-8555-555555555555";
    const dir = plantSession(id, project, { updates: [{ sessionUpdate: "user_message_chunk", content: [{ type: "text", text: "hi" }] }, { sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "hello" }] }] });
    const read = await adapter.readTranscript({ cwd: project, nativeId: id });
    expect(read?.title).toBeNull();
    expect(read?.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    plantSession(id, project, { title: "Named session", updates: [{ sessionUpdate: "user_message_chunk", content: [{ type: "text", text: "hi" }] }] });
    const titled = await adapter.readTranscript({ cwd: project, nativeId: id });
    expect(titled?.title).toBe("Named session");
    expect(await adapter.readTranscript({ cwd: project, nativeId: "../../etc/passwd" })).toBeNull();
    expect(await adapter.readTranscript({ cwd: path.join(home, "elsewhere"), nativeId: id })).toBeNull();
    expect(existsSync(dir)).toBe(true);
  });

  it("names the model a new chat starts on from the same handshake as the list", async () => {
    const [models, fallback] = await Promise.all([adapter.listModels(project), adapter.defaultModel(project)]);
    expect(fallback).toEqual({ model: "grok-4.7", thinkingLevel: null });
    expect(models.some((m) => m.key === fallback?.model)).toBe(true);
    expect(liveGrokChildren()).toBe(0);
  });

  it("lists Grok's models from a short-lived handshake, leaving no session behind", async () => {
    const models = await adapter.listModels(project);
    expect(models.map((m) => [m.key, m.provider, m.levels])).toEqual([
      ["grok-4.7", "grok", ["high", "medium", "low"]],
      ["grok-4.5", "grok", ["low"]],
    ]);
    expect(liveGrokChildren()).toBe(0);
    expect(existsSync(path.join(grokHome, "sessions"))).toBe(false);
  });
});

describe("grok's session folds (no process)", () => {
  const line = (update: Record<string, unknown>) => JSON.stringify({ timestamp: 1792245548, method: "session/update", params: { update } });

  it("folds a diff block into a unified diff, and a tool that never finished into an error", () => {
    const folds = foldsFromJsonl(
      [
        line({ sessionUpdate: "tool_call", toolCallId: "t1", title: "Edit file.txt", rawInput: { file_path: "file.txt" }, _meta: { "x.ai/tool": { name: "search_replace" } } }),
        line({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", content: [{ type: "diff", path: "file.txt", oldText: "a\n", newText: "b\n" }] }),
        line({ sessionUpdate: "tool_call", toolCallId: "t2", rawInput: { command: "true" }, _meta: { "x.ai/tool": { name: "bash" } } }),
      ].join("\n"),
    );
    // A 10-digit clock is epoch seconds: 1792245548 is 2026, not 1970.
    expect(folds[0]).toMatchObject({ type: "tool_start", at: 1792245548 * 1000 });
    const items = itemsFromFolds(folds);
    const edit = items[0];
    if (!edit || edit.kind !== "tool") throw new Error("expected a tool item");
    expect(edit).toMatchObject({ category: "edit", status: "done", diffStat: { added: 1, removed: 1 } });
    const lines = edit.diff?.lines ?? [];
    expect(lines.some((entry) => entry.kind === "del" && entry.text === "a")).toBe(true);
    expect(lines.some((entry) => entry.kind === "add" && entry.text === "b")).toBe(true);
    expect(items[1]).toMatchObject({ kind: "tool", status: "error" });
  });

  it("marks turn_completed as the end of the turn", () => {
    const folds = foldsFromJsonl([line({ sessionUpdate: "turn_completed", usage: { inputTokens: 1, outputTokens: 2 } })].join("\n"));
    expect(folds[0]).toMatchObject({ type: "usage", turnEnded: true });
  });

  it("prices a turn in dollars, and leaves an unpriced one null", () => {
    expect(costUsd(100000000)).toBe(0.01);
    expect(costUsd(0)).toBeNull();
  });

  it("does not add cache hits that are already inside input tokens", () => {
    // Recorded from grok 1.0.77: totalTokens was input + output, and cachedRead was a subset of input.
    expect(contextTokens({ input: 224866, output: 3037, cacheRead: 176768, cacheWrite: 0 })).toBe(227903);
    // The scripted CLI reports cache on top of a small input. That sum stays.
    expect(contextTokens({ input: 10, output: 12, cacheRead: 100, cacheWrite: 2 })).toBe(112);
  });

  it("reads a usage_update as the context occupancy", () => {
    const folds = foldsFromJsonl([line({ sessionUpdate: "usage_update", used: 2200, size: 500000 })].join("\n"));
    expect(folds[0]).toEqual({ type: "context", used: 2200, size: 500000 });
  });

  const spawn = (toolCallId: string, extra: Record<string, unknown> = {}) =>
    line({
      sessionUpdate: "tool_call",
      toolCallId,
      title: "spawn_subagent",
      rawInput: { description: "Ping a subagent", prompt: "Reply with the single word pong", background: false, ...extra },
      _meta: { "x.ai/tool": { name: "spawn_subagent" } },
    });

  it("folds a spawn and its retries onto one delegation card", () => {
    const a = "11111111-1111-4111-8111-111111111111";
    const b = "22222222-2222-4222-8222-222222222222";
    const folds = foldsFromJsonl(
      [
        spawn("c1"),
        line({ sessionUpdate: "subagent_spawned", child_session_id: a, subagent_type: "general-purpose", description: "Ping a subagent", model: "opencode-go" }),
        line({ sessionUpdate: "subagent_finished", child_session_id: a, status: "failed", error: "expired key", tool_calls: 0, tokens_used: 0, duration_ms: 30 }),
        line({ sessionUpdate: "subagent_spawned", child_session_id: b, subagent_type: "general-purpose", description: "Ping a subagent", model: "opencode-go" }),
        line({ sessionUpdate: "subagent_finished", child_session_id: b, status: "cancelled", error: "Subagent was cancelled", tool_calls: 9, tokens_used: 80, duration_ms: 90 }),
        line({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "failed", content: [{ type: "text", text: "expired key" }] }),
      ].join("\n"),
    );
    const items = itemsFromFolds(folds);
    const tool = items[0];
    if (!tool || tool.kind !== "tool") throw new Error("expected a tool");
    expect(tool).toMatchObject({ category: "agent", status: "error", name: "spawn_subagent" });
    expect(tool.subagents?.runs.map((run) => [run.id, run.status, run.agent, run.task])).toEqual([
      [a, "failed", "general-purpose", "Ping a subagent"],
      [b, "stopped", "general-purpose", "Ping a subagent"],
    ]);
    expect(tool.subagents?.runs[1]).toMatchObject({ toolCount: 9, tokens: 80, durationMs: 90, error: "Subagent was cancelled", transcript: true });
    expect(tool.subagents?.runs.some((run) => run.id === "0")).toBe(false);
  });

  it("keeps a background child's row after the tool's own result, including a finish read on resume", () => {
    const id = "11111111-1111-4111-8111-111111111111";
    const folds = foldsFromJsonl(
      [
        spawn("c1", { background: true, description: "Implement Grok harness" }),
        line({ sessionUpdate: "subagent_spawned", child_session_id: id, subagent_type: "general-purpose", description: "Implement Grok harness", model: "opencode-go" }),
        line({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "text", text: "Subagent started in background." }] }),
      ].join("\n"),
    );
    const midway = itemsFromFolds(folds);
    expect(midway[0]).toMatchObject({ status: "done", output: "Subagent started in background.", subagents: { background: true, runs: [{ id, status: "running" }] } });
    // Resume reads the file into the book, then the finish arrives live.
    const book = new GrokSubagentBook();
    for (const fold of folds) book.ingest(fold);
    const late = foldSessionUpdate({ sessionUpdate: "subagent_finished", child_session_id: id, status: "completed", output: "pong", tool_calls: 2, tokens_used: 9, duration_ms: 4 }, 0);
    const linked = book.ingest(late);
    expect(linked).toMatchObject({ toolCallId: "c1", details: { background: true, results: [{ id, status: "completed", output: "pong", toolCount: 2 }] } });
    const done = itemsFromFolds([...folds, late]);
    expect(done[0]).toMatchObject({ output: "Subagent started in background.", subagents: { background: true, runs: [{ id, status: "done", output: "pong" }] } });
  });

  it("ignores a subagent event whose child id is not a session id", () => {
    expect(foldSessionUpdate({ sessionUpdate: "subagent_spawned", child_session_id: "../escape", subagent_type: "general-purpose" }, 0)).toEqual({ type: "ignore" });
  });
});
