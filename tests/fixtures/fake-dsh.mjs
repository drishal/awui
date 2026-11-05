#!/usr/bin/env node
// Scripted `dsh --profile acp` for adapter tests: the ACP JSON-RPC lines the
// real 0.2.2-alpha.3 ACP app speaks on stdio, plus session logs in DSH's own
// v4 layout (`<home>/sessions/<project key>/<id>/session.v4.jsonl.zstd`, one
// zstd frame per append). Prompt text selects behaviour:
//   "tool"  a read call            "ask"  a bash call that needs approval
//   "diff"  an edit with a diff    "think" a thought before the answer
//   "slow"  many small chunks (cancellable)   "fail" accept the prompt, then error
// Every prompt, set_config value, permission answer, and cancel is recorded in
// $FAKE_DSH_STATE so a test can see what went out on the wire.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { constants, zstdCompressSync } from "node:zlib";
import path from "node:path";
import readline from "node:readline";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("0.2.2-alpha.3");
  process.exit(0);
}
if (process.env.FAKE_DSH_NO_ACP === "1") {
  // The missing bundle means no app ever claims --help; the launcher waits.
  process.stderr.write('dsh: skipping profile bundle "@deepseek-ai/dsh-acp-app": Error: dsh: cannot resolve profile bundle "@deepseek-ai/dsh-acp-app" from the dsh installation or profile; run \'dsh plugin --profile acp install\' if its dependency is not installed\n');
  setInterval(() => undefined, 1_000);
  await new Promise(() => undefined);
}
if (argv.includes("--help")) {
  console.log("Usage: dsh --profile acp [options]\n\nServe automation clients over Agent Client Protocol stdio.\n\nOptions:\n  -h, --help  show this help\n");
  process.exit(0);
}
if (process.env.FAKE_DSH_EXIT_1 === "1") process.exit(1);

const home = process.env.FAKE_DSH_HOME ?? process.env.DSH_HOME ?? path.join(process.env.HOME ?? "", ".dsh");
const cwd = path.resolve(process.cwd());
const statePath = process.env.FAKE_DSH_STATE;
const record = (key, value) => {
  if (!statePath) return;
  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {}
  state[key] = [...(state[key] ?? []), value];
  writeFileSync(statePath, JSON.stringify(state));
};

/** DSH's project directory key (the same algorithm as the adapter reads). */
function projectKey(project) {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < project.length; i += 1) {
    const code = project.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** DSH's injective session-id path segment. */
function sessionSegment(id) {
  if (id === ".") return "~002E";
  if (id === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

const MODELS = [
  { provider: "deepseek-official", model: "deepseek-v4-flash", name: "deepseek-v4-flash" },
  { provider: "deepseek-official", model: "deepseek-v4-pro", name: "deepseek-v4-pro" },
  { provider: "opencode-go", model: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" },
];
const EFFORTS = { "deepseek-v4-flash": ["off", "low", "high", "max"], "deepseek-v4-pro": ["high", "max"], "deepseek-v4.1-flash": ["low", "high", "max"] };
const DEFAULT_EFFORT = { "deepseek-v4-flash": "high", "deepseek-v4-pro": "high", "deepseek-v4.1-flash": "max" };
const routeValue = (model) => JSON.stringify([model.provider, model.model]);
const modelFor = (provider, model) => MODELS.find((entry) => entry.provider === provider && entry.model === model) ?? null;

let current = { provider: "deepseek-official", model: "deepseek-v4-flash" };
let effort = DEFAULT_EFFORT[current.model];

function configOptions() {
  const groups = [];
  for (const model of MODELS) {
    let group = groups.find((entry) => entry.group === model.provider);
    if (!group) {
      group = { group: model.provider, name: model.provider === "deepseek-official" ? "DeepSeek" : "OpenCode Go", options: [] };
      groups.push(group);
    }
    group.options.push({ value: routeValue(model), name: model.name });
  }
  return [
    { id: "model", name: "Model", category: "model", type: "select", currentValue: routeValue(current), options: groups },
    {
      id: "reasoning_effort",
      name: "Reasoning effort",
      category: "thought_level",
      type: "select",
      currentValue: effort,
      options: (EFFORTS[current.model] ?? []).map((value) => ({ value, name: value === "off" ? "Off" : value[0].toUpperCase() + value.slice(1) })),
    },
  ];
}

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const respond = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
const notify = (method, params) => out({ jsonrpc: "2.0", method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- the session's own log ----------------------------------------------------

const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
let sessionId = null;
let sessionDir = null;
let logFile = null;
let meta = null;
let seq = 0;
let cancelled = false;
let turn = 0;
let toolSeq = 0;

function sessionDirFor(id) {
  return path.join(home, "sessions", projectKey(cwd), sessionSegment(id));
}

function event(type, data, time = Date.now()) {
  const line = JSON.stringify({ type, seq: seq++, time, data });
  appendFileSync(logFile, zstdCompressSync(Buffer.from(`${line}\n`), CHECKSUM));
}

function saveMeta() {
  if (!sessionDir) return;
  meta.title = meta.title ?? null;
  meta.current = { ...current };
  meta.effort = effort;
  writeFileSync(path.join(sessionDir, "meta.json"), JSON.stringify(meta, null, 2));
}

function createSession() {
  sessionId = randomUUID();
  sessionDir = sessionDirFor(sessionId);
  mkdirSync(sessionDir, { recursive: true });
  logFile = path.join(sessionDir, "session.v4.jsonl.zstd");
  const createdAt = Date.now();
  const header = { type: "session", version: 4, id: sessionId, createdAt, cwd, isSeeded: false, delegationDepth: 0 };
  writeFileSync(logFile, zstdCompressSync(Buffer.from(`${JSON.stringify(header)}\n`), CHECKSUM));
  seq = 0;
  meta = { id: sessionId, cwd, createdAt, title: null, current: { ...current }, effort };
  event("permission/preset", { preset: "workspace-write" });
  event("sandbox/mode", { mode: "workspace-write" });
  event("approval/policy", { policy: "ask" });
  event("model/selection", { ...current, reasoningEffort: effort });
  saveMeta();
}

function resumeSession(id) {
  const wanted = String(id ?? "");
  const dir = sessionDirFor(wanted);
  if (!existsSync(path.join(dir, "session.v4.jsonl.zstd"))) return false;
  sessionId = wanted;
  sessionDir = dir;
  logFile = path.join(dir, "session.v4.jsonl.zstd");
  try {
    meta = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"));
  } catch {
    meta = { id: wanted, cwd, createdAt: Date.now(), title: null, current: { ...current }, effort };
  }
  current = meta.current ?? current;
  effort = meta.effort ?? DEFAULT_EFFORT[current.model];
  seq = 1_000_000;
  return meta.cwd === cwd;
}

// ---- turns -------------------------------------------------------------------

function usageUpdate() {
  notify("session/update", { sessionId, update: { sessionUpdate: "usage_update", used: 122, size: 1_000_000 } });
}

let stepNo = 1;

/** One committed model step; its text and tool calls share the message, as DSH writes them. */
function assistantEvent(text, reasoning, toolCalls, withUsage = true) {
  const step = stepNo++;
  const message = {
    role: "assistant",
    content: [
      ...(reasoning ? [{ type: "reasoning", text: reasoning }] : []),
      ...(text ? [{ type: "text", text }] : []),
      ...toolCalls.map((call) => ({ type: "tool-call", id: call.callId, name: call.name, arguments: JSON.stringify(call.args) })),
    ],
    source: { kind: "model", provider: current.provider, model: current.model },
    id: randomUUID(),
  };
  event("assistant/message", { turn, step, message, ...(withUsage ? { usage: { inputTokens: 10, outputTokens: 12, totalTokens: 122, cacheReadTokens: 100 } } : {}) });
  event("step/end", { turn, step });
}

/** Close the turn after its committed steps. */
function finishTurn(id) {
  event("turn/end", { turn, reason: { kind: "completed" } });
  usageUpdate();
  saveMeta();
  respond(id, { stopReason: "end_turn" });
}

/** A tool call as ACP sees it and as the session log records it, then its result. */
async function toolCall(callId, name, args, output, extra = {}) {
  notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: callId, title: name, kind: "other", status: "in_progress", rawInput: args } });
  event("tool/call", { turn, step: 1, callId, name, arguments: JSON.stringify(args) });
  await sleep(2);
  notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: callId, status: "completed", content: [{ type: "content", content: { type: "text", text: output } }] } });
  event("tool/result", {
    turn,
    step: 1,
    message: { role: "tool", source: { kind: "tool", callId }, toolCallId: callId, content: [{ type: "text", text: output }], isError: false, id: randomUUID() },
    ...(extra.meta ? { meta: extra.meta } : {}),
  });
}

async function prompt(id, text) {
  record("prompts", text);
  cancelled = false;
  turn += 1;
  stepNo = 1;
  event("user/message", { content: [{ type: "text", text }], source: { kind: "user" }, role: "user", id: randomUUID() });
  event("turn/start", { turn });
  event("step/start", { turn, step: 1 });
  if (!meta.title) {
    meta.title = text.replace(/\s+/g, " ").trim().slice(0, 20);
    event("session/title", { title: meta.title, source: { kind: "fallback" } });
  }

  if (text.includes("fail")) {
    // Taken, then the turn errors: the send resolves, the run fails.
    fail(id, -32000, "boom");
    return;
  }

  if (text.includes("slow")) {
    let streamed = "";
    for (const char of `dsh says ${text}`) {
      if (cancelled) break;
      await sleep(5);
      streamed += char;
      notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: char } } });
    }
    assistantEvent(streamed, "", []);
    finishTurn(id);
    return;
  }

  if (text.includes("think")) notify("session/update", { sessionId, update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } } });

  if (text.includes("tool")) {
    const callId = `call-tool-${++toolSeq}`;
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "dsh says " } } });
    assistantEvent("dsh says ", "", [{ callId, name: "read", args: { file_path: "README.md" } }]);
    await toolCall(callId, "read", { file_path: "README.md" }, "file.txt");
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
    assistantEvent(text, "", [], false);
    finishTurn(id);
    return;
  }

  if (text.includes("diff")) {
    const callId = `call-diff-${++toolSeq}`;
    const args = { file_path: "file.txt", old_string: "a", new_string: "b" };
    assistantEvent("", "", [{ callId, name: "edit", args }]);
    await toolCall(callId, "edit", args, "The file file.txt has been updated successfully.", {
      meta: { path: "file.txt", diffs: [{ path: "file.txt", oldText: "a\n", newText: "b\n" }] },
    });
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `dsh says ${text}` } } });
    assistantEvent(`dsh says ${text}`, "", [], false);
    finishTurn(id);
    return;
  }

  if (text.includes("ask")) {
    const callId = `call-bash-${++toolSeq}`;
    const args = { command: "touch made.txt" };
    assistantEvent("", "", [{ callId, name: "bash", args }]);
    notify("session/update", { sessionId, update: { sessionUpdate: "tool_call", toolCallId: callId, title: "bash", kind: "other", status: "in_progress", rawInput: args } });
    event("tool/call", { turn, step: stepNo - 1, callId, name: "bash", arguments: JSON.stringify(args) });
    const answer = await askClient("session/request_permission", {
      sessionId,
      // The real app sends only the call id; the title and args must come from the earlier tool_call update.
      toolCall: { toolCallId: callId },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    const outcome = answer?.result?.outcome ?? {};
    record("permissions", { outcome: outcome.outcome ?? "error", optionId: outcome.optionId ?? null });
    const allowed = outcome.outcome === "selected" && String(outcome.optionId ?? "").startsWith("allow");
    notify("session/update", { sessionId, update: { sessionUpdate: "tool_call_update", toolCallId: callId, status: allowed ? "completed" : "failed", content: [{ type: "content", content: { type: "text", text: allowed ? "made" : "refused" } }] } });
    event("tool/result", {
      turn,
      step: 1,
      message: { role: "tool", source: { kind: "tool", callId }, toolCallId: callId, content: [{ type: "text", text: allowed ? "made" : "refused" }], isError: !allowed, id: randomUUID() },
    });
    notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: `dsh says ${text}` } } });
    assistantEvent(`dsh says ${text}`, "", [], false);
    finishTurn(id);
    return;
  }

  notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "dsh says " } } });
  await sleep(2);
  notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  assistantEvent(`dsh says ${text}`, "", []);
  finishTurn(id);
}

// ---- the client's answers to our requests ------------------------------------

const asked = new Map();
let askSeq = 50;
function askClient(method, params) {
  const id = askSeq++;
  return new Promise((resolve) => {
    asked.set(id, resolve);
    out({ jsonrpc: "2.0", id, method, params });
  });
}

function setConfigOption(id, params) {
  const { configId, value } = params;
  if (typeof value !== "string") {
    fail(id, -32602, "value must be a string");
    return;
  }
  if (configId === "model") {
    let route = null;
    try {
      route = JSON.parse(value);
    } catch {}
    const found = Array.isArray(route) ? modelFor(route[0], route[1]) : null;
    if (!found) {
      fail(id, -32602, `unknown model ${value}`);
      return;
    }
    record("setConfig", { configId, value });
    current = { provider: found.provider, model: found.model };
    if (!(EFFORTS[current.model] ?? []).includes(effort)) effort = DEFAULT_EFFORT[current.model];
  } else if (configId === "reasoning_effort") {
    if (!(EFFORTS[current.model] ?? []).includes(value)) {
      fail(id, -32602, `unknown reasoning effort ${value}`);
      return;
    }
    record("setConfig", { configId, value });
    effort = value;
  } else {
    fail(id, -32602, `unknown config option ${String(configId)}`);
    return;
  }
  event("model/selection", { ...current, reasoningEffort: effort });
  saveMeta();
  respond(id, { configOptions: configOptions() });
}

const promptText = (params) =>
  (Array.isArray(params?.prompt) ? params.prompt : [])
    .filter((block) => block?.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");

// ---- the protocol loop --------------------------------------------------------

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
  if (!sessionId && frame.method !== "initialize" && frame.method !== "session/new" && frame.method !== "session/resume" && frame.method !== "session/list") {
    fail(frame.id, -32000, "no session");
    return;
  }
  switch (frame.method) {
    case "initialize":
      respond(frame.id, {
        protocolVersion: 1,
        agentInfo: { name: "deepseek-harness-acp", version: "0.0.1" },
        agentCapabilities: {
          mcpCapabilities: { http: true },
          promptCapabilities: { image: process.env.FAKE_DSH_IMAGES === "1", audio: false, embeddedContext: false },
          sessionCapabilities: { close: {}, list: {}, resume: {} },
        },
        authMethods: [],
      });
      return;
    case "session/new":
      createSession();
      record("mcps", params.mcpServers ?? []);
      respond(frame.id, { sessionId, configOptions: configOptions() });
      return;
    case "session/resume":
      if (!resumeSession(params.sessionId)) {
        fail(frame.id, -32602, `session is not resumable: ${String(params.sessionId)}`);
        return;
      }
      record("mcps", params.mcpServers ?? []);
      respond(frame.id, { configOptions: configOptions() });
      return;
    case "session/list": {
      const dir = path.join(home, "sessions", projectKey(cwd));
      const sessions = [];
      for (const name of readdirSync(dir).sort()) {
        let found;
        try {
          found = JSON.parse(readFileSync(path.join(dir, name, "meta.json"), "utf8"));
        } catch {
          continue;
        }
        sessions.push({ sessionId: found.id, cwd: found.cwd });
      }
      respond(frame.id, { sessions });
      return;
    }
    case "session/set_config_option":
      setConfigOption(frame.id, params);
      return;
    case "session/prompt":
      void prompt(frame.id, promptText(params));
      return;
    case "session/close":
      respond(frame.id, {});
      return;
    default:
      fail(frame.id, -32601, `unknown method ${frame.method}`);
  }
});
