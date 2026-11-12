import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { ClaudeAdapter, liveClaudeChildren } from "../../src/server/harness/claude.js";
import type { LiveChat } from "../../src/server/harness/types.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { tempDir } from "../helpers/app.js";

const script = path.join(import.meta.dirname, "..", "fixtures", "fake-claude.mjs");
chmodSync(script, 0o755);

let home: string;
let project: string;
let state: string;
let adapter: ClaudeAdapter;
const open: LiveChat[] = [];

beforeEach(() => {
  home = tempDir("awui-claude-home-");
  project = path.join(home, "proj");
  mkdirSync(project);
  state = path.join(home, "state.json");
  adapter = new ClaudeAdapter({
    command: script,
    home,
    env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), FAKE_CLAUDE_STATE: state, CLAUDECODE: "1" },
  });
});

afterEach(async () => {
  for (const chat of open.splice(0)) await chat.dispose();
  await adapter.shutdown();
  expect(liveClaudeChildren()).toBe(0);
});

const ws = (): WorkspaceInfo => ({ id: "w", path: project, name: "proj" });

async function openChat(resumeNativeId?: string) {
  const live = await adapter.openChat({ cwd: project, ...(resumeNativeId ? { resumeNativeId } : {}) });
  open.push(live);
  return { live, chat: await Chat.open(`c${open.length}`, adapter, ws(), live) };
}

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

describe("claude adapter (scripted CLI)", () => {
  it("names the model and effort a new chat starts on, from the same child that lists the models", async () => {
    await adapter.shutdown();
    adapter = new ClaudeAdapter({
      command: script,
      home,
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), FAKE_CLAUDE_STATE: state, CLAUDECODE: "1", FAKE_CLAUDE_SETTINGS_MODEL: "fake-haiku" },
    });
    const [models, fallback] = await Promise.all([adapter.listModels(project), adapter.defaultModel(project)]);
    // Settings name the model by its full id; the start screen knows it by the picker's key.
    expect(fallback).toEqual({ model: "haiku", thinkingLevel: "medium" });
    expect(models.some((m) => m.key === fallback?.model)).toBe(true);
    expect(recorded("inits")).toHaveLength(1);
    adapter.forgetModels(project);
    await adapter.defaultModel(project);
    expect(recorded("inits")).toHaveLength(2);
  });

  it("gives the CLI awui's MCP servers only when the chat has their tokens", async () => {
    await openChat();
    expect((recorded("args").at(-1) as string[]).includes("--mcp-config")).toBe(false);
    const tokens = { AWUI_RENDER_URL: "http://127.0.0.1:4783/api/render", AWUI_RENDER_TOKEN: "r0ken", AWUI_ORCH_URL: "http://127.0.0.1:4783/api/orchestration", AWUI_ORCH_TOKEN: "t0ken" };
    const live = await adapter.openChat({ cwd: project, toolEnv: tokens });
    open.push(live);
    const args = recorded("args").at(-1) as string[];
    const config = JSON.parse(args[args.indexOf("--mcp-config") + 1] ?? "{}") as { mcpServers: Record<string, { args: string[]; env: Record<string, string> }> };
    expect(Object.keys(config.mcpServers)).toEqual(["awui", "awui-orchestrate"]);
    expect(config.mcpServers["awui-orchestrate"]).toEqual({
      type: "stdio",
      command: process.execPath,
      args: [path.join(import.meta.dirname, "..", "..", "extensions", "orchestrate-mcp.mjs")],
      env: { AWUI_ORCH_URL: tokens.AWUI_ORCH_URL, AWUI_ORCH_TOKEN: tokens.AWUI_ORCH_TOKEN },
    });
    // Both families are allowed without a prompt: one comma-separated argument, as the CLI documents it.
    const allowed = (args[args.indexOf("--allowedTools") + 1] ?? "").split(",");
    expect(allowed).toContain("mcp__awui__render_html");
    expect(allowed).toContain("mcp__awui-orchestrate__delegate_task");
    expect(allowed).toContain("mcp__awui-orchestrate__thread_wait");
    // Those schemas are deferred (tool search is on for every child), so loading one is allowed too.
    expect(allowed).toContain("ToolSearch");
    expect(recorded("env").at(-1)).toMatchObject({ ENABLE_TOOL_SEARCH: "true" });
  });

  it("turns tool search on for the child, and leaves a value the user set alone", () => {
    const base = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude") };
    expect(new ClaudeAdapter({ command: script, home, env: base }).childEnv()).toMatchObject({ ENABLE_TOOL_SEARCH: "true" });
    // Claude Code's own words for "schemas in full": the user's choice is not a default to replace.
    expect(new ClaudeAdapter({ command: script, home, env: { ...base, ENABLE_TOOL_SEARCH: "auto:100" } }).childEnv().ENABLE_TOOL_SEARCH).toBe("auto:100");
  });

  it("opens with a session id of its own, then streams a turn with thinking and usage", async () => {
    const { chat, live } = await openChat();
    expect(live.nativeId).toMatch(/^[0-9a-f-]{36}$/);
    expect(chat.snapshot().config).toMatchObject({ model: "default", thinkingLevel: "medium" });
    expect(chat.snapshot().config.models.map((m) => [m.key, m.levels])).toEqual([
      ["default", ["low", "medium", "high"]],
      ["haiku", ["low", "high"]],
      ["tiny", undefined],
    ]);
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says hello there"));
    const snap = chat.snapshot();
    expect(snap.items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(snap.items[1]).toMatchObject({ text: "claude says hello there", thinking: "hmm", streaming: false });
    expect(await live.getUsage()).toMatchObject({ turns: 1, steps: 1, input: 10, cachedInput: 100, cacheWrite: 20, output: 12, cost: 0.01 });
    // The account (email, plan) from the handshake never reaches a snapshot.
    expect(JSON.stringify(snap)).not.toContain("someone@example.com");
  });

  it("keeps how long its prompt cache lives, from the usage each call reports", async () => {
    const { chat, live } = await openChat();
    expect((await live.getUsage())?.promptCacheExpiresAt).toBeUndefined();
    const before = Date.now();
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says hello there"));
    const usage = chat.snapshot().usage;
    // The fake's calls write Claude's five-minute window; the reading starts with the request.
    expect(usage).toMatchObject({ promptCacheTtlMs: 300_000 });
    expect(usage?.promptCacheExpiresAt).toBeGreaterThanOrEqual(before + 300_000);
    expect(usage?.promptCacheExpiresAt).toBeLessThanOrEqual(Date.now() + 300_000);
  });

  it("shows tool calls after the model call that made them, with their output", async () => {
    const { chat } = await openChat();
    await chat.send("run tool please", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says"));
    const kinds = chat.snapshot().items.map((i) => i.kind);
    expect(kinds).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(chat.snapshot().items[2]).toMatchObject({ name: "Read", status: "done", output: "file.txt", category: "read", summary: "README.md" });
  });

  it("turns can_use_tool into an approval card and answers it, session rules scoped to the session", async () => {
    const { chat } = await openChat();
    await chat.send("ask to make a file", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    const card = chat.snapshot().pending[0];
    expect(card).toMatchObject({ kind: "select", title: "Allow Bash?", options: ["Allow once", "Allow for this session", "Deny"] });
    expect(card?.message).toContain("touch made.txt");
    chat.answer(card?.id as string, { kind: "select", value: "Allow for this session" });
    await until(() => chat.status === "idle" && answered(chat, "claude says"));
    const verdict = recorded("permissions")[0] as { behavior: string; updatedInput: unknown; updatedPermissions: Array<{ destination: string }> };
    expect(verdict.behavior).toBe("allow");
    expect(verdict.updatedInput).toMatchObject({ command: "touch made.txt" });
    expect(verdict.updatedPermissions.map((p) => p.destination)).toEqual(["session"]);
    expect(chat.snapshot().items.find((i) => i.kind === "tool")).toMatchObject({ status: "done", output: "made" });
  });

  it("a denial reaches the CLI and the tool shows as failed", async () => {
    const { chat } = await openChat();
    await chat.send("ask to make a file", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Deny" });
    await until(() => chat.status === "idle" && answered(chat, "claude says"));
    expect(recorded("permissions")[0]).toMatchObject({ behavior: "deny" });
    expect(chat.snapshot().items.find((i) => i.kind === "tool")).toMatchObject({ status: "error" });
  });

  it("asks AskUserQuestion's questions as cards and hands the answers back", async () => {
    const { chat } = await openChat();
    await chat.send("question time", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    expect(chat.snapshot().pending[0]).toMatchObject({ title: "Colour", message: "Which colour?", options: ["Red", "Blue"] });
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Blue" });
    await until(() => chat.status === "idle" && answered(chat, "claude says"));
    expect(recorded("permissions")[0]).toMatchObject({ behavior: "allow", updatedInput: { answers: { "Which colour?": "Blue" } } });
  });

  it("steers into the running turn and queues follow-ups for after it", async () => {
    const { chat } = await openChat();
    await chat.send("ask first", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    await chat.send("also this", "steer");
    await chat.send("and then that", "followUp");
    expect(chat.snapshot().queue).toEqual({ steering: ["also this"], followUp: ["and then that"] });
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Allow once" });
    await until(() => chat.status === "idle" && answered(chat, "claude says and then that"));
    const prompts = chat.snapshot().items.filter((i) => i.kind === "user").map((i) => (i.kind === "user" ? i.text : ""));
    expect(prompts).toEqual(["ask first", "also this", "and then that"]);
    expect(chat.snapshot().queue).toEqual({ steering: [], followUp: [] });
  });

  it("stops a run, dropping what was queued behind it", async () => {
    const { chat } = await openChat();
    await chat.send("slow please", "normal");
    await until(() => chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.length > 0));
    await chat.send("never run", "followUp");
    await chat.abort();
    expect(chat.status).toBe("idle");
    expect(recorded("cancelled")).toHaveLength(1);
    expect(chat.snapshot().queue.followUp).toEqual([]);
    const answer = chat.snapshot().items.find((i) => i.kind === "assistant");
    expect(answer && answer.kind === "assistant" && answer.text.length).toBeLessThan("claude says slow please".length + 80);
  });

  it("reports a failed turn as a notice and still settles", async () => {
    const { chat } = await openChat();
    await chat.send("fail now", "normal");
    await until(() => chat.status === "idle" && chat.snapshot().items.some((i) => i.kind === "notice"));
    expect(chat.snapshot().items.find((i) => i.kind === "notice")).toMatchObject({ level: "error", text: "fake failure" });
  });

  it("keeps Claude Code's TodoWrite list as the chat's todos", async () => {
    const { chat, live } = await openChat();
    await chat.send("todo list", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says"));
    expect(await live.getTodos()).toEqual([
      { text: "Write tests", status: "in_progress" },
      { text: "Ship", status: "pending" },
    ]);
  });

  it("changes model and effort for this session only", async () => {
    const { chat } = await openChat();
    await chat.setConfig({ model: "haiku", thinkingLevel: "high" });
    expect(chat.snapshot().config).toMatchObject({ model: "haiku", thinkingLevel: "high" });
    expect(recorded("models")).toEqual(["haiku"]);
    expect(recorded("flags")).toEqual([{ effortLevel: "high" }]);
    await chat.refreshModels();
    expect(chat.snapshot().config.models.map((m) => m.key)).toContain("sonnet");
  });

  it("offers the chosen model's effort levels, at the effort it really runs at", async () => {
    const { chat } = await openChat();
    // No settings file names an effort: the model's own default is the one in force.
    expect(chat.snapshot().config).toMatchObject({ model: "default", thinkingLevel: "medium", thinkingLevels: ["low", "medium", "high"] });
    await chat.setConfig({ model: "haiku" });
    expect(chat.snapshot().config).toMatchObject({ model: "haiku", thinkingLevel: "high", thinkingLevels: ["low", "high"] });
    // The CLI would take a level the model does not list; awui never sends one.
    await expect(chat.setConfig({ thinkingLevel: "medium" })).rejects.toMatchObject({ status: 422, code: "config_rejected" });
    expect(recorded("flags")).toEqual([]);
    await chat.setConfig({ thinkingLevel: "low" });
    expect(chat.snapshot().config).toMatchObject({ thinkingLevel: "low" });
    await chat.setConfig({ model: "tiny" });
    expect(chat.snapshot().config).toMatchObject({ model: "tiny", thinkingLevel: null, thinkingLevels: [] });
  });

  it("switches the permission mode mid-run, and follows the CLI's own changes", async () => {
    const { chat } = await openChat();
    const config = () => chat.snapshot().config;
    expect(config().permissionMode).toBe("default");
    expect(config().permissionModes?.map((m) => m.id)).toEqual(["default", "acceptEdits", "plan", "auto", "dontAsk"]);
    // While a run waits on an approval, as Shift+Tab does in Claude Code itself.
    await chat.send("ask first", "normal");
    await until(() => chat.snapshot().pending.length === 1);
    expect(chat.status).toBe("running");
    await expect(chat.setConfig({ model: "haiku" })).rejects.toMatchObject({ status: 409, code: "busy" });
    await chat.setConfig({ permissionMode: "acceptEdits" });
    expect(config().permissionMode).toBe("acceptEdits");
    expect(recorded("modes")).toEqual(["acceptEdits"]);
    chat.answer(chat.snapshot().pending[0]?.id as string, { kind: "select", value: "Allow once" });
    await until(() => chat.status === "idle");
    // Bypass needs a launch flag this chat's CLI was not given, so it is neither offered nor sent.
    await expect(chat.setConfig({ permissionMode: "bypassPermissions" })).rejects.toMatchObject({ status: 422, code: "config_rejected" });
    expect(recorded("modes")).toEqual(["acceptEdits"]);
    // Auto runs only on a model the CLI says can.
    await chat.setConfig({ model: "haiku" });
    expect(config().permissionModes?.map((m) => m.id)).not.toContain("auto");
    // An approved plan leaves plan mode by itself; the CLI's status frame moves the picker.
    await chat.setConfig({ permissionMode: "plan" });
    await chat.send("exitplan now", "normal");
    await until(() => chat.status === "idle" && config().permissionMode === "acceptEdits");
  });

  it("offers bypass only when config.yml's claude args let the CLI switch to it", async () => {
    adapter = new ClaudeAdapter({
      command: script,
      home,
      args: ["--allow-dangerously-skip-permissions"],
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), FAKE_CLAUDE_STATE: state },
    });
    const { chat } = await openChat();
    expect(chat.snapshot().config.permissionModes?.at(-1)).toMatchObject({ id: "bypassPermissions", caution: true });
    await chat.setConfig({ permissionMode: "bypassPermissions" });
    expect(chat.snapshot().config.permissionMode).toBe("bypassPermissions");
    expect(recorded("modes")).toEqual(["bypassPermissions"]);
  });

  it("reads context usage with Claude Code's own categories, minus deferred and free space", async () => {
    const { live } = await openChat();
    expect(await live.getContextUsage()).toEqual({
      tokens: 3000,
      window: 200000,
      percent: 1.5,
      categories: [
        { id: "system-prompt", label: "System prompt", tokens: 2000 },
        { id: "messages", label: "Messages", tokens: 1000 },
      ],
    });
    expect((await live.listCommands())[0]).toEqual({ name: "review", description: "Review the change", hint: "[focus]", source: "command" });
  });

  it("renames, lists, resumes from the file, and forks through a turn", async () => {
    const { chat, live } = await openChat();
    await chat.send("first prompt", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says first prompt"));
    await chat.send("second tool prompt", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says second tool prompt"));
    await chat.rename("Named session");
    const nativeId = live.nativeId as string;
    expect((await adapter.listSessions(project)).map((s) => [s.nativeId, s.title, s.messageCount])).toEqual([[nativeId, "Named session", 2]]);
    expect((await adapter.listRecentSessions(10)).map((s) => s.cwd)).toEqual([project]);
    await chat.dispose("done");

    const { chat: resumed, live: again } = await openChat(nativeId);
    expect(again.title).toBe("Named session");
    expect(resumed.snapshot().items.map((i) => i.kind)).toEqual(["user", "assistant", "user", "assistant", "tool", "assistant"]);
    expect(resumed.snapshot().usage).toMatchObject({ turns: 2, cost: 0.01 });
    // The file's own last call says which cache window it wrote, so a reopened chat knows before a prompt.
    expect(resumed.snapshot().usage).toMatchObject({ promptCacheTtlMs: 300_000 });
    expect(resumed.snapshot().usage?.promptCacheExpiresAt).toBeGreaterThan(0);

    const fork = await adapter.forkSession({ cwd: project, nativeId, throughTurns: 1 });
    const { chat: copy } = await openChat(fork.nativeId);
    expect(copy.snapshot().items.map((i) => (i.kind === "user" || i.kind === "assistant" ? i.text : i.kind))).toEqual(["first prompt", "claude says first prompt"]);
  });

  it("refuses to resume a session that has no file, and stops the child it started meanwhile", async () => {
    await expect(adapter.openChat({ cwd: project, resumeNativeId: "no-such-session" })).rejects.toThrow(/Session not found/);
  });

  it("gives a terminal command that resumes the session by id, once it is saved", async () => {
    const { chat, live } = await openChat();
    const nativeId = live.nativeId as string;
    expect(await adapter.resumeCommand({ cwd: project, nativeId })).toBeNull();
    await chat.send("hello there", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says hello there"));
    expect(await adapter.resumeCommand({ cwd: project, nativeId })).toEqual(["claude", "--resume", nativeId]);
    expect(await adapter.resumeCommand({ cwd: project, nativeId: "../../etc/passwd" })).toBeNull();
  });

  it("compacts and waits for the CLI to finish", async () => {
    const { chat } = await openChat();
    await chat.send("first prompt", "normal");
    await until(() => chat.status === "idle" && answered(chat, "claude says"));
    await chat.compact("keep it short");
    expect(chat.status).toBe("idle");
    expect(chat.snapshot().items.some((i) => i.kind === "notice" && i.text === "Compacted conversation")).toBe(true);
    // Reopened, the history starts at the compaction, not with what it summarized.
    expect((await open[0]?.history())?.map((i) => (i.kind === "user" ? i.text : i.kind))).toEqual(["notice", "/compact keep it short", "assistant"]);
  });

  it("refuses a session that is not in the project's folder", async () => {
    await expect(adapter.openChat({ cwd: project, resumeNativeId: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(/not found/);
  });
});

describe("Claude plan limits", () => {
  it("asks Claude Code for its plan usage in a quiet probe and keeps only the named windows", async () => {
    const accounts = await adapter.usageLimits();
    expect(accounts).toHaveLength(1);
    const claude = accounts[0];
    expect(claude).toMatchObject({ id: "claude", source: "Claude Code", plan: "pro", limited: false });
    expect(claude?.windows.map((w) => `${w.label} ${w.used}`)).toEqual(["5 hours 0.7", "7 days 0.1", "7 days · Fable 0.05"]);
    expect(claude?.windows[0]?.resetsAt).toBe(Date.parse("2026-10-12T22:59:59.775244+00:00"));
    // Only the plan's windows are asked for, from a child that writes no session and starts no MCP server or user hook.
    const asked = recorded("usage") as Array<{ skip_behaviors: boolean; args: string[] }>;
    expect(asked[0]?.skip_behaviors).toBe(true);
    expect(asked[0]?.args).toEqual(expect.arrayContaining(["--no-session-persistence", "--strict-mcp-config", "--setting-sources", "project"]));
    // A second ask within minutes is the cached answer: no new child.
    await adapter.usageLimits();
    expect(recorded("usage")).toHaveLength(1);
  });

  it("has no account when the plan has no limits", async () => {
    const { claudeUsageLimits } = await import("../../src/server/harness/limits.js");
    expect(claudeUsageLimits({ rate_limits_available: false, rate_limits: null })).toBeNull();
    expect(claudeUsageLimits({ rate_limits_available: true, rate_limits: { five_hour: { utilization: 100, resets_at: null } } })?.limited).toBe(true);
  });
});

describe("a claude child that dies at startup", () => {
  it("reports what it printed on stderr, not just the exit code", async () => {
    // The shape most CLIs use for a refused start: one line on stderr, exit 1.
    const refuses = path.join(home, "refuses.sh");
    writeFileSync(refuses, '#!/bin/sh\necho "Invalid API key · Please run /login" >&2\nexit 1\n');
    chmodSync(refuses, 0o755);
    const dying = new ClaudeAdapter({ command: refuses, home, env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(home, ".claude") } });
    try {
      await expect(dying.openChat({ cwd: project })).rejects.toThrow("claude exited (code 1): Invalid API key · Please run /login");
    } finally {
      await dying.shutdown();
    }
  });
});
