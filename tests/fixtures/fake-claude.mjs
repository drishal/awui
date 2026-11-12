#!/usr/bin/env node
// Scripted `claude -p --input-format stream-json --output-format stream-json`
// for adapter tests: the frames and control requests the real CLI speaks (as
// recorded from Claude Code 2.1.289; settings and permission modes from
// 2.1.301), and session files in its shape under
// $CLAUDE_CONFIG_DIR/projects/<cwd as dashes>/<id>.jsonl. Prompt text selects
// behaviour:
//   "tool"  read a file first        "ask"       a Bash call that needs approval
//   "slow"  stream many chunks       "fail"      end the turn with an error
//   "todo"  write a TodoWrite list   "question"  an AskUserQuestion call
//   "/compact"  compact the conversation
//   "exitplan"  leave plan mode by itself (as an approved plan does), announced in a status frame
//   "render"    call render_html through the MCP server --mcp-config names, as the CLI does
// A message sent while a turn runs is queued: priority "next" lands after the
// current tool call, anything else runs once the turn ends. Every permission
// answer is recorded in $FAKE_CLAUDE_STATE.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const argv = process.argv.slice(2);
// As the CLI answers it, so discovery finds a version.
if (argv.includes("--version")) {
  console.log("2.1.289 (Claude Code)");
  process.exit(0);
}
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const persist = !argv.includes("--no-session-persistence");
const resume = flag("--resume");
const sessionId = resume ?? flag("--session-id") ?? randomUUID();
const cwd = process.cwd();
const projects = path.join(process.env.CLAUDE_CONFIG_DIR ?? path.join(process.env.HOME ?? "", ".claude"), "projects");
const file = path.join(projects, cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);
if (resume && !existsSync(file)) {
  console.error(`No conversation found with session ID: ${resume}`);
  process.exit(1);
}

const statePath = process.env.FAKE_CLAUDE_STATE;
const record = (key, value) => {
  if (!statePath) return;
  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {}
  state[key] = [...(state[key] ?? []), value];
  writeFileSync(statePath, JSON.stringify(state));
};

// What awui spawned this child with: the MCP config and allow list, and the two variables
// awui sets for every chat child, which a test asserts on.
record("args", argv);
record("env", { ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH ?? null, CLAUDE_CODE_PROMPT_CACHE_TTL: process.env.CLAUDE_CODE_PROMPT_CACHE_TTL ?? null });

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the session file ------------------------------------------------------
let leaf = null;
if (resume) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const e = JSON.parse(line);
      if (typeof e.uuid === "string") leaf = e.uuid;
    } catch {}
  }
}
const write = (entry) => {
  if (!persist) return;
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ...entry, sessionId })}\n`);
};
const chained = (entry) => {
  const uuid = randomUUID();
  write({ ...entry, uuid, parentUuid: leaf, isSidechain: false, cwd, timestamp: new Date().toISOString() });
  leaf = uuid;
};

// ---- turns -------------------------------------------------------------------
const MODELS = [
  { value: "default", resolvedModel: "fake-opus", displayName: "Default (recommended)", supportsEffort: true, supportedEffortLevels: ["low", "medium", "high"], supportsAutoMode: true },
  { value: "haiku", resolvedModel: "fake-haiku", displayName: "Haiku", supportsEffort: true, supportedEffortLevels: ["low", "high"] },
  { value: "tiny", resolvedModel: "fake-tiny", displayName: "Tiny", supportsThinkingOff: true },
];
/** Each model's effort when nothing names one (a model without levels has none). */
const DEFAULT_EFFORT = { default: "medium", haiku: "high" };
let model = "default";
/** The effort the flag layer set (apply_flag_settings), if any. */
let flagEffort = null;
const canBypass = argv.includes("--allow-dangerously-skip-permissions") || argv.includes("--dangerously-skip-permissions");
let permissionMode = flag("--permission-mode") ?? (argv.includes("--dangerously-skip-permissions") ? "bypassPermissions" : "default");
/** As 2.1.301 announces a mode change, the CLI's own or the host's. */
const announceMode = () => out({ type: "system", subtype: "status", status: null, permissionMode, uuid: randomUUID(), session_id: sessionId });
let busy = false;
let aborted = false;
const steering = [];
const followUps = [];
const pendingPermissions = new Map();

// A call's usage, in the shape a real message carries: the cache breakdown names which window
// the call wrote, which a chat turns into the prompt cache's lifetime.
function usage(output) {
  return { input_tokens: 10, cache_read_input_tokens: 100, cache_creation_input_tokens: 20, cache_creation: { ephemeral_5m_input_tokens: 20, ephemeral_1h_input_tokens: 0 }, output_tokens: output };
}

/** One model call: stream its text, then write its blocks; returns the message id. */
async function modelCall(text, { thinking = "hmm", tool = null, chunks = null, delay = 2 } = {}) {
  const id = `msg_${randomUUID().slice(0, 8)}`;
  out({ type: "stream_event", event: { type: "message_start", message: { id, model: "fake-opus", usage: usage(1) } }, parent_tool_use_id: null, session_id: sessionId });
  if (thinking) {
    out({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking } }, parent_tool_use_id: null, session_id: sessionId });
    out({ type: "assistant", message: { id, model: "fake-opus", role: "assistant", content: [{ type: "thinking", thinking }] }, parent_tool_use_id: null, session_id: sessionId });
    chained({ type: "assistant", message: { id, model: "fake-opus", role: "assistant", content: [{ type: "thinking", thinking, signature: "sig" }], usage: usage(1) } });
  }
  let body = "";
  for (const chunk of chunks ?? (text ? [text] : [])) {
    if (aborted) break;
    await sleep(delay);
    body += chunk;
    out({ type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: chunk } }, parent_tool_use_id: null, session_id: sessionId });
  }
  if (body) {
    out({ type: "assistant", message: { id, model: "fake-opus", role: "assistant", content: [{ type: "text", text: body }] }, parent_tool_use_id: null, session_id: sessionId });
    chained({ type: "assistant", message: { id, model: "fake-opus", role: "assistant", content: [{ type: "text", text: body }], usage: usage(12) } });
  }
  if (tool && !aborted) {
    const block = { type: "tool_use", id: tool.id, name: tool.name, input: tool.input };
    out({ type: "assistant", message: { id, model: "fake-opus", role: "assistant", content: [block] }, parent_tool_use_id: null, session_id: sessionId });
    chained({ type: "assistant", message: { id, model: "fake-opus", role: "assistant", content: [block], usage: usage(12) } });
  }
  out({ type: "stream_event", event: { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn" }, usage: { output_tokens: 12 } }, parent_tool_use_id: null, session_id: sessionId });
  out({ type: "stream_event", event: { type: "message_stop" }, parent_tool_use_id: null, session_id: sessionId });
  return body;
}

function toolResult(toolUseId, content, isError = false) {
  const block = { type: "tool_result", tool_use_id: toolUseId, content, is_error: isError };
  out({ type: "user", message: { role: "user", content: [block] }, parent_tool_use_id: null, session_id: sessionId, uuid: randomUUID() });
  chained({ type: "user", message: { role: "user", content: [block] } });
}

/** Ask the host, as the CLI does over --permission-prompt-tool stdio. */
function askPermission(toolName, input, toolUseId) {
  const requestId = randomUUID();
  out({
    type: "control_request",
    request_id: requestId,
    request: {
      subtype: "can_use_tool",
      tool_name: toolName,
      display_name: toolName,
      input,
      description: "Create a scratch file",
      permission_suggestions: [{ type: "addRules", rules: [{ toolName, ruleContent: input.command ?? "" }], behavior: "allow", destination: "localSettings" }],
      tool_use_id: toolUseId,
    },
  });
  return new Promise((resolve) => pendingPermissions.set(requestId, resolve));
}

/** Messages that arrived mid-turn and land at this tool boundary. */
function drainSteering() {
  while (steering.length > 0) {
    const m = steering.shift();
    consume(m, true);
  }
}

/** The CLI takes a prompt: echo it, and record it (injected ones as queued_command attachments). */
function consume(m, injected, record = true) {
  out({ type: "user", message: m.message, parent_tool_use_id: null, session_id: sessionId, uuid: m.uuid, isReplay: true, timestamp: new Date().toISOString() });
  const text = typeof m.message.content === "string" ? m.message.content : m.message.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  if (!record) return text;
  if (injected) chained({ type: "attachment", attachment: { type: "queued_command", prompt: text, source_uuid: m.uuid } });
  else chained({ type: "user", message: m.message });
  return text;
}

/** Call `tool` on the MCP server --mcp-config names `awui`: start it, initialize, call, stop (what the CLI does, in short). */
async function callMcp(tool, args) {
  const config = JSON.parse(flag("--mcp-config") ?? "{}");
  const server = config.mcpServers?.awui;
  if (!server) return [{ type: "text", text: "No such tool available: mcp__awui__render_html" }];
  record("mcp", { command: server.command, args: server.args, allowed: flag("--allowedTools") ?? null, hasToken: Boolean(server.env?.AWUI_RENDER_TOKEN) });
  const child = spawn(server.command, server.args, { env: { ...process.env, ...server.env }, stdio: ["pipe", "pipe", "inherit"] });
  const replies = new Map();
  readline.createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    replies.get(message.id)?.(message);
  });
  let next = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const id = ++next;
      replies.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-claude", version: "1" } });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  const reply = await call("tools/call", { name: tool, arguments: args });
  child.kill();
  return reply.result?.content ?? [{ type: "text", text: reply.error?.message ?? "MCP error" }];
}

async function runTurn(m) {
  busy = true;
  aborted = false;
  const compacting = typeof m.message.content === "string" && m.message.content.startsWith("/compact");
  const text = consume(m, false, !compacting);
  out({ type: "system", subtype: "init", session_id: sessionId, cwd, model: "fake-opus", tools: ["Bash", "Read"], permissionMode });
  if (text.includes("exitplan")) {
    permissionMode = "acceptEdits";
    announceMode();
  }
  let error = null;
  let answer = "";
  if (text.startsWith("/compact")) {
    out({ type: "system", subtype: "status", status: "compacting", session_id: sessionId });
    await sleep(5);
    // As recorded from print mode: boundary → summary on a new chain, the
    // command's own entries still appended to the old leaf.
    const boundary = randomUUID();
    write({ type: "system", subtype: "compact_boundary", uuid: boundary, parentUuid: null, cwd, timestamp: new Date().toISOString() });
    write({ type: "user", uuid: randomUUID(), parentUuid: boundary, isCompactSummary: true, cwd, timestamp: new Date().toISOString(), message: { role: "user", content: "Summary of the conversation so far" } });
    chained({ type: "user", message: { role: "user", content: `<command-name>/compact</command-name>\n<command-args>${text.slice("/compact".length).trim()}</command-args>` } });
    chained({ type: "user", message: { role: "user", content: "<local-command-stdout>Compacted </local-command-stdout>" } });
    out({ type: "system", subtype: "compact_boundary", session_id: sessionId });
  } else {
    if (/\btool\b/.test(text)) {
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      await modelCall("", { tool: { id, name: "Read", input: { file_path: "README.md" } } });
      toolResult(id, "file.txt");
      drainSteering();
    }
    if (/\brender\b/.test(text)) {
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      const input = { html: "<!doctype html><h1>Fake chart</h1>", title: "Fake chart", height: 200 };
      await modelCall("", { tool: { id, name: "mcp__awui__render_html", input } });
      toolResult(id, await callMcp("render_html", input));
    }
    if (/\btodo\b/.test(text)) {
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      await modelCall("", { tool: { id, name: "TodoWrite", input: { todos: [{ content: "Write tests", status: "in_progress", activeForm: "Writing tests" }, { content: "Ship", status: "pending", activeForm: "Shipping" }] } } });
      toolResult(id, "Todos have been modified successfully.");
    }
    if (/\bask\b/.test(text)) {
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      const input = { command: "touch made.txt", description: "Create a scratch file" };
      await modelCall("", { tool: { id, name: "Bash", input } });
      const verdict = await askPermission("Bash", input, id);
      record("permissions", verdict);
      if (verdict.behavior === "allow") toolResult(id, "made");
      else toolResult(id, verdict.message ?? "denied", true);
      drainSteering();
    }
    if (/\bquestion\b/.test(text)) {
      const id = `toolu_${randomUUID().slice(0, 8)}`;
      const input = { questions: [{ question: "Which colour?", header: "Colour", options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }], multiSelect: false }] };
      await modelCall("", { tool: { id, name: "AskUserQuestion", input } });
      const verdict = await askPermission("AskUserQuestion", input, id);
      record("permissions", verdict);
      toolResult(id, verdict.behavior === "allow" ? `answered ${JSON.stringify(verdict.updatedInput?.answers ?? {})}` : "dismissed", verdict.behavior !== "allow");
    }
    const slow = /\bslow\b/.test(text);
    answer = await modelCall(`claude says ${text}`, slow ? { chunks: Array.from({ length: 40 }, (_, i) => `${i} `), delay: 20 } : {});
    if (/\bfail\b/.test(text)) error = "fake failure";
  }
  const interrupted = aborted;
  if (interrupted) write({ type: "user", message: { role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }] }, uuid: randomUUID(), parentUuid: leaf, cwd, timestamp: new Date().toISOString() });
  out({
    type: "result",
    subtype: interrupted ? "error_during_execution" : error ? "error_max_turns" : "success",
    is_error: interrupted || Boolean(error),
    terminal_reason: interrupted ? "aborted_streaming" : "completed",
    ...(error ? { errors: [error] } : {}),
    result: answer,
    usage: usage(12),
    total_cost_usd: 0.01,
    num_turns: 1,
    session_id: sessionId,
  });
  write({ type: "cost-state", totalCostUSD: 0.01, modelUsage: {} });
  busy = false;
  const next = followUps.shift() ?? steering.shift();
  if (next) void runTurn(next);
}

// ---- control ---------------------------------------------------------------------
function control(frame) {
  const { request_id: id, request } = frame;
  const ok = (response) => out({ type: "control_response", response: { subtype: "success", request_id: id, ...(response === undefined ? {} : { response }) } });
  const fail = (error) => out({ type: "control_response", response: { subtype: "error", request_id: id, error } });
  switch (request.subtype) {
    case "initialize":
      record("inits", process.cwd());
      return ok({
        commands: [{ name: "review", description: "Review the change", argumentHint: "[focus]" }],
        models: MODELS,
        account: { email: "someone@example.com", subscriptionType: "Claude Pro" },
        current_permission_mode: permissionMode,
      });
    case "get_settings": {
      // As 2.1.301 answers: `effective` is what the settings layers name, `applied` what runs.
      const levels = MODELS.find((m) => m.value === model)?.supportedEffortLevels ?? [];
      const effort = levels.length === 0 ? null : levels.includes(flagEffort) ? flagEffort : (DEFAULT_EFFORT[model] ?? null);
      // FAKE_CLAUDE_SETTINGS_MODEL: a settings file naming a model (by its full id, as some do).
      return ok({ effective: { model: process.env.FAKE_CLAUDE_SETTINGS_MODEL ?? "default", ...(flagEffort ? { effortLevel: flagEffort } : {}) }, applied: { model: MODELS.find((m) => m.value === model)?.resolvedModel, effort } });
    }
    case "set_model":
      model = request.model ?? "default";
      record("models", model);
      return ok();
    case "apply_flag_settings":
      record("flags", request.settings);
      if (typeof request.settings?.effortLevel === "string") flagEffort = request.settings.effortLevel;
      return ok();
    case "set_max_thinking_tokens":
      return ok();
    case "set_permission_mode": {
      // The answers and refusals as recorded from 2.1.301.
      const modes = ["acceptEdits", "auto", "bypassPermissions", "default", "dontAsk", "plan"];
      if (!modes.includes(request.mode)) return fail(`Cannot set permission mode: must be one of ${modes.join(", ")}`);
      if (request.mode === "bypassPermissions" && !canBypass) return fail("Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions");
      permissionMode = request.mode;
      record("modes", permissionMode);
      ok({ mode: permissionMode });
      return announceMode();
    }
    case "list_models":
      return ok({ models: [...MODELS, { value: "sonnet", resolvedModel: "fake-sonnet", displayName: "Sonnet", supportedEffortLevels: ["low"] }] });
    case "get_usage":
      record("usage", { skip_behaviors: request.skip_behaviors, args: process.argv.slice(2) });
      return ok({
        subscription_type: "pro",
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 70, resets_at: "2026-10-12T22:59:59.775244+00:00" },
          seven_day: { utilization: 10, resets_at: "2026-10-19T17:59:59+00:00" },
          seven_day_opus: null,
          iguana_necktie: { utilization: 0, resets_at: "2026-11-05T07:59:00+00:00" },
          model_scoped: [{ display_name: "Fable", utilization: 5, resets_at: null }],
        },
        behaviors: null,
      });
    case "get_context_usage":
      return ok({
        totalTokens: 3000,
        maxTokens: 200000,
        percentage: 1.5,
        categories: [
          { name: "System prompt", tokens: 2000, kind: "used" },
          { name: "System tools (deferred)", tokens: 9000, kind: "deferred" },
          { name: "Messages", tokens: 1000, kind: "used" },
          { name: "Free space", tokens: 197000, kind: "free" },
        ],
      });
    case "rename_session":
      write({ type: "custom-title", customTitle: request.title });
      out({ type: "system", subtype: "session_title_changed", title: request.title, session_id: sessionId });
      return ok();
    case "interrupt":
      aborted = true;
      for (const [rid, resolve] of pendingPermissions) {
        pendingPermissions.delete(rid);
        out({ type: "control_cancel_request", request_id: rid });
        resolve({ behavior: "deny", message: "interrupted" });
      }
      return ok();
    case "cancel_async_message": {
      for (const queue of [steering, followUps]) {
        const i = queue.findIndex((m) => m.uuid === request.message_uuid);
        if (i >= 0) queue.splice(i, 1);
      }
      record("cancelled", request.message_uuid);
      return ok({ cancelled: true });
    }
    default:
      return fail(`unknown subtype ${request.subtype}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (frame.type === "control_request") return control(frame);
  if (frame.type === "control_response") {
    const resolve = pendingPermissions.get(frame.response.request_id);
    if (resolve) {
      pendingPermissions.delete(frame.response.request_id);
      resolve(frame.response.response);
    }
    return;
  }
  if (frame.type === "user") {
    const m = { message: frame.message, uuid: frame.uuid ?? randomUUID() };
    if (!busy) return void runTurn(m);
    if (frame.priority === "next") steering.push(m);
    else followUps.push(m);
  }
});
rl.on("close", () => process.exit(0));
