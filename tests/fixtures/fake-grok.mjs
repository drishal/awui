#!/usr/bin/env node
// Scripted `grok agent --no-leader stdio` for adapter tests: the JSON-RPC lines
// (ACP) the real CLI speaks on stdio, and session files in Grok's own shape
// under <home>/sessions/<encoded cwd>/<id>/ (summary.json + updates.jsonl).
// Prompt text selects behaviour:
//   "tool"  a read_file call            "ask"   a Bash call that needs approval
//   "diff"  a search_replace edit        "think" a thought before the answer
//   "slow"  many small chunks (cancellable)   "fail"  accept the prompt, then error
//   "subagent" a spawn_subagent call and its child session
//   "subagentbg" the same, finishing after the tool has returned
// Every prompt, set_config value, permission answer, and cancel is recorded in
// $FAKE_GROK_STATE so a test can see what went out on the wire.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const argv = process.argv.slice(2);
// As the CLI answers it, so discovery finds a version.
if (argv.includes("--version")) {
  console.log("grok 1.0.62");
  process.exit(0);
}

const home = process.env.FAKE_GROK_HOME ?? process.env.GROK_HOME ?? path.join(process.env.HOME ?? "", ".grok");
const cwd = path.resolve(process.cwd());
// The group directory Grok names after the encoded cwd (short paths only; a long
// one falls back to a slug and hash, which the adapter finds through `.cwd`).
const group = path.join(home, "sessions", encodeURIComponent(cwd));

const statePath = process.env.FAKE_GROK_STATE;
const record = (key, value) => {
  if (!statePath) return;
  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {}
  state[key] = [...(state[key] ?? []), value];
  writeFileSync(statePath, JSON.stringify(state));
};

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const respond = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method, params) => out({ jsonrpc: "2.0", method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the models and their session options ------------------------------------

const MODELS = [
  {
    modelId: "grok-4.7",
    name: "Grok 4.7",
    description: "Frontier model",
    _meta: {
      reasoningEfforts: [
        { id: "high", value: "high", label: "High" },
        { id: "medium", value: "medium", label: "Medium" },
        { id: "low", value: "low", label: "Low" },
      ],
      totalContextTokens: 256000,
      contextWindows: [256000, 500000],
    },
  },
  {
    modelId: "grok-4.5",
    name: "Grok 4.5",
    description: "Fast model",
    _meta: {
      reasoningEfforts: [{ id: "low", value: "low", label: "Low" }],
      reasoningEffort: "low",
      totalContextTokens: 128000,
      contextWindows: [128000],
    },
  },
];
/** Each model's effort when nothing names one. */
const DEFAULT_EFFORT = { "grok-4.7": "high", "grok-4.5": "low" };
const efforts = (modelId) => MODELS.find((m) => m.modelId === modelId)?._meta.reasoningEfforts ?? [];

let currentModelId = "grok-4.7";
let effort = "high";

const modelState = () => ({ currentModelId, availableModels: MODELS });
const configOptions = () => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: currentModelId,
    options: MODELS.map((m) => ({ value: m.modelId, name: m.name, description: m.description })),
  },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "reasoning",
    type: "select",
    currentValue: effort,
    options: efforts(currentModelId).map((e) => ({ value: e.value, name: e.label })),
  },
];

// ---- the session -------------------------------------------------------------

let sessionId = null;
let sessionDir = null;
let createdAt = null;
let updatedAt = null;
let messages = 0;
let cancelled = false;
let generatedTitle = null;
let toolSeq = 0;

function writeSummary() {
  if (!sessionDir) return;
  const summary = {
    info: { id: sessionId, cwd },
    generated_title: generatedTitle,
    current_model_id: currentModelId,
    created_at: createdAt,
    updated_at: updatedAt ?? new Date().toISOString(),
    num_messages: messages,
  };
  // Atomically: a listing started right after the turn must never read a half-written file.
  writeFileSync(path.join(sessionDir, "summary.json.tmp"), `${JSON.stringify(summary, null, 2)}\n`);
  renameSync(path.join(sessionDir, "summary.json.tmp"), path.join(sessionDir, "summary.json"));
}

/** One session/update on the wire, and the same line in the session's jsonl unless `keep` is false (a replay). */
function send(update, keep = true) {
  notify("session/update", { sessionId, update });
  if (!keep || !sessionDir) return;
  updatedAt = new Date().toISOString();
  const line = { timestamp: Math.floor(Date.now() / 1000), method: "session/update", params: { update } };
  appendFileSync(path.join(sessionDir, "updates.jsonl"), `${JSON.stringify(line)}\n`);
}

function startSession(id) {
  sessionId = randomUUID();
  sessionDir = path.join(group, sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(path.join(sessionDir, "updates.jsonl"), "");
  createdAt = new Date().toISOString();
  updatedAt = createdAt;
  messages = 0;
  writeSummary();
  // A notification awui must ignore rather than crash on.
  notify("_x.ai/session/setup", { sessionId, cwd });
  respond(id, { sessionId, models: modelState(), configOptions: configOptions() });
}

function loadSession(id, params) {
  const wanted = String(params.sessionId ?? "");
  const dir = path.join(group, wanted);
  if (!existsSync(path.join(dir, "summary.json"))) {
    fail(id, -32000, `unknown session ${wanted}`);
    return;
  }
  sessionId = wanted;
  sessionDir = dir;
  const summary = JSON.parse(readFileSync(path.join(dir, "summary.json"), "utf8"));
  currentModelId = summary.current_model_id ?? currentModelId;
  effort = DEFAULT_EFFORT[currentModelId] ?? effort;
  messages = summary.num_messages ?? 0;
  createdAt = summary.created_at ?? createdAt;
  updatedAt = summary.updated_at ?? null;
  generatedTitle = summary.generated_title ?? null;
  // The conversation replayed, before the result and never written to the file.
  send({ sessionUpdate: "user_message_chunk", content: [{ type: "text", text: "REPLAY" }] }, false);
  send({ sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "replayed" }] }, false);
  respond(id, { models: modelState(), configOptions: configOptions() });
}

// ---- turns -------------------------------------------------------------------

function usage() {
  return { inputTokens: 10, cachedReadTokens: 100, cacheCreationTokens: 2, outputTokens: 12, costUsdTicks: 100000000, modelUsage: { [currentModelId]: {} }, modelCalls: 1 };
}

function endTurn(id) {
  send({ sessionUpdate: "turn_completed", usage: usage() });
  writeSummary();
  respond(id, { stopReason: "end_turn" });
}

/** A request of the client this script waits on (the approval prompt). */
const asked = new Map();
let askSeq = 50;
function askClient(method, params) {
  const id = askSeq++;
  return new Promise((resolve) => {
    asked.set(id, resolve);
    out({ jsonrpc: "2.0", id, method, params });
  });
}

async function turn(id, text) {
  record("prompts", text);
  messages += 1;
  // The real CLI does not echo the prompt. "noecho" is that shape; anything else
  // still echoes, so a second user row in the chat is a bug.
  if (!text.includes("noecho")) send({ sessionUpdate: "user_message_chunk", content: [{ type: "text", text }] });
  // The real CLI names this update; this build sends it only when asked.
  if (text.includes("context")) send({ sessionUpdate: "usage_update", used: 2200, size: 500000 });
  writeSummary();

  if (text.includes("unanswered")) {
    // The turn ends on the wire long before the prompt request is answered: the
    // shape that left a chat "running" for hours. turn_completed must settle it.
    send({ sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "done but unanswered" }] });
    send({ sessionUpdate: "turn_completed", usage: usage() });
    writeSummary();
    setTimeout(() => respond(id, { stopReason: "end_turn" }), 3000);
    return;
  }

  if (text.includes("fail")) {
    // Taken, then the turn errors: the send resolves, the run fails.
    fail(id, -32000, "boom");
    return;
  }

  if (text.includes("slow")) {
    for (const char of `grok says ${text}`) {
      if (cancelled) break;
      await sleep(5);
      send({ sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: char }] });
    }
    respond(id, { stopReason: cancelled ? "cancelled" : "end_turn" });
    return;
  }

  if (text.includes("think")) send({ sessionUpdate: "agent_thought_chunk", content: [{ type: "text", text: "hmm" }] });

  // "subagentbg" also contains "subagent", so it has to be told apart first.
  if (text.includes("subagent")) {
    const background = text.includes("subagentbg");
    const callId = `call-sub-${++toolSeq}`;
    const childId = "11111111-1111-4111-8111-111111111111";
    send({
      sessionUpdate: "tool_call",
      toolCallId: callId,
      title: "spawn_subagent",
      rawInput: { description: "Ping a subagent", prompt: "Reply with pong", background },
      _meta: { "x.ai/tool": { name: "spawn_subagent" } },
    });
    send({
      sessionUpdate: "subagent_spawned",
      subagent_id: childId,
      child_session_id: childId,
      parent_session_id: sessionId,
      subagent_type: "general-purpose",
      description: "Ping a subagent",
      model: "opencode-go",
    });
    const childDir = path.join(group, childId);
    mkdirSync(childDir, { recursive: true });
    const childUpdates = [
      { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Reply with pong" } },
      { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "pong" } },
    ];
    writeFileSync(
      path.join(childDir, "updates.jsonl"),
      `${childUpdates.map((update) => JSON.stringify({ timestamp: 1792245548, method: "session/update", params: { update } })).join("\n")}\n`,
    );
    writeFileSync(path.join(childDir, "summary.json"), `${JSON.stringify({ info: { id: childId, cwd }, generated_title: null }, null, 2)}\n`);
    const metaDir = path.join(sessionDir, "subagents", childId);
    mkdirSync(metaDir, { recursive: true });
    writeFileSync(path.join(metaDir, "meta.json"), `${JSON.stringify({ parent_session_id: sessionId, child_session_id: childId, subagent_type: "general-purpose" })}\n`);
    const finished = {
      sessionUpdate: "subagent_finished",
      subagent_id: childId,
      child_session_id: childId,
      status: "completed",
      tool_calls: 0,
      turns: 1,
      duration_ms: 4776,
      tokens_used: 11593,
      output: "pong",
      will_wake: false,
    };
    if (background) {
      // The tool returns while the child is still going; the finish comes after.
      send({ sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "text", text: "Subagent started in background." }] });
      send(finished);
    } else {
      send(finished);
      send({ sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "text", text: "pong" }] });
    }
    send({ sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "grok says pong" }] });
    endTurn(id);
    return;
  }

  if (text.includes("tool")) {
    send({ sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "grok says " }] });
    const callId = `call-tool-${++toolSeq}`;
    send({ sessionUpdate: "tool_call", toolCallId: callId, title: "Read file", rawInput: { target_file: "README.md" }, _meta: { "x.ai/tool": { name: "read_file" } } });
    await sleep(2);
    send({ sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "text", text: "file.txt" }] });
    await sleep(2);
    send({ sessionUpdate: "agent_message_chunk", content: [{ type: "text", text }] });
    endTurn(id);
    return;
  }

  if (text.includes("diff")) {
    const callId = `call-diff-${++toolSeq}`;
    send({ sessionUpdate: "tool_call", toolCallId: callId, title: "Edit file.txt", rawInput: { file_path: "file.txt" }, _meta: { "x.ai/tool": { name: "search_replace" } } });
    await sleep(2);
    send({ sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "diff", path: "file.txt", oldText: "a\n", newText: "b\n" }] });
    await sleep(2);
    send({ sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: `grok says ${text}` }] });
    endTurn(id);
    return;
  }

  if (text.includes("ask")) {
    const callId = `call-bash-${++toolSeq}`;
    send({ sessionUpdate: "tool_call", toolCallId: callId, title: "Bash", rawInput: { command: "touch made.txt" }, _meta: { "x.ai/tool": { name: "bash" } } });
    const answer = await askClient("session/request_permission", {
      sessionId,
      toolCall: { toolCallId: callId, title: "Bash", rawInput: { command: "touch made.txt" } },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "allow-always", name: "Always allow", kind: "allow_always" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    const outcome = answer?.result?.outcome ?? {};
    record("permissions", { outcome: outcome.outcome ?? "error", optionId: outcome.optionId ?? null });
    const allowed = outcome.outcome === "selected" && String(outcome.optionId ?? "").startsWith("allow");
    send({ sessionUpdate: "tool_call_update", toolCallId: callId, status: allowed ? "completed" : "failed", content: [{ type: "text", text: allowed ? "made" : "refused" }] });
    await sleep(2);
    send({ sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: `grok says ${text}` }] });
    endTurn(id);
    return;
  }

  send({ sessionUpdate: "agent_message_chunk", content: [{ type: "text", text: "grok says " }] });
  await sleep(2);
  send({ sessionUpdate: "agent_message_chunk", content: [{ type: "text", text }] });
  endTurn(id);
}

function setConfigOption(id, params) {
  const { configId, value } = params;
  if (typeof value !== "string") {
    fail(id, -32602, "value must be a string");
    return;
  }
  if (configId === "model") {
    if (!MODELS.some((m) => m.modelId === value)) {
      fail(id, -32602, `unknown model ${value}`);
      return;
    }
    record("setConfig", { configId, value });
    currentModelId = value;
    // A model whose list has not got the effort in force resets to its own default.
    if (!efforts(value).some((e) => e.value === effort)) effort = DEFAULT_EFFORT[value];
  } else if (configId === "reasoning_effort") {
    if (!efforts(currentModelId).some((e) => e.value === value)) {
      fail(id, -32602, `unknown reasoning effort ${value}`);
      return;
    }
    record("setConfig", { configId, value });
    effort = value;
  } else {
    fail(id, -32602, `unknown config option ${String(configId)}`);
    return;
  }
  writeSummary();
  respond(id, { configOptions: configOptions() });
}

// ---- the protocol loop --------------------------------------------------------

const promptText = (params) =>
  (Array.isArray(params?.prompt) ? params.prompt : [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  if (frame.method === undefined) {
    // The client's answer to a request of ours.
    const waiting = asked.get(frame.id);
    if (waiting) {
      asked.delete(frame.id);
      waiting(frame);
    }
    return;
  }
  if (frame.method === "session/cancel") {
    cancelled = true;
    record("cancels", frame.params?.sessionId ?? null);
    return;
  }
  const params = frame.params ?? {};
  if (!sessionId && frame.method !== "initialize" && frame.method !== "session/new" && frame.method !== "session/load") {
    fail(frame.id, -32000, "no session");
    return;
  }
  switch (frame.method) {
    case "initialize":
      // No session directory: a listing must not leave one behind.
      respond(frame.id, { protocolVersion: 1, promptCapabilities: { image: false }, modelState: modelState() });
      return;
    case "session/new":
      startSession(frame.id);
      return;
    case "session/load":
      loadSession(frame.id, params);
      return;
    case "session/prompt":
      void turn(frame.id, promptText(params));
      return;
    case "session/set_config_option":
      setConfigOption(frame.id, params);
      return;
    default:
      fail(frame.id, -32601, `unknown method ${frame.method}`);
  }
});
