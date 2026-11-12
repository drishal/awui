#!/usr/bin/env node
// Scripted ACP agent for acp-adapter tests: the JSON-RPC lines a generic
// Agent Client Protocol app speaks on stdio. Every frame here is the shape the
// protocol documents (agentclientprotocol.com: initialization, session setup,
// prompt turn, tool calls) — the same session/update vocabulary Grok's real ACP
// surface sends, which tests/fixtures/fake-grok.mjs records; this file invents
// no fields of its own.
// Prompt text selects behaviour:
//   "tool"    a read call and its result        "diff"  an edit call with diff content
//   "ask"     an execute call needing approval  "think" a thought before the answer
//   "slow"    many small chunks (cancellable)   "fail"  accept the prompt, then error
//   "plan"    a plan update                     "usage" a usage_update
//   "title"   a session_info_update             "commands" available_commands_update
//   "config"  a config_option_update            "unknown" an update kind awui does not know
//   "crash"   exit mid-run
// Every prompt, session handshake, config value, auth method, permission answer,
// $FAKE_ACP_DIE_ON_INIT prints that text on stderr and exits 7 at `initialize`: an agent that
// says something on stderr and dies, which a failure message must not repeat.
// and cancel is recorded in $FAKE_ACP_STATE so a test can see what went out.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
// As a CLI answers it, so discovery finds a version.
if (argv.includes("--version")) {
  console.log("fake-acp 0.9.1");
  process.exit(0);
}

const statePath = process.env.FAKE_ACP_STATE;
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
  { value: "acp-pro", name: "ACP Pro" },
  { value: "acp-lite", name: "ACP Lite" },
];
let currentModel = "acp-pro";
let effort = "medium";

const configOptions = () => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: currentModel, options: MODELS },
  {
    id: "reasoning_effort",
    name: "Reasoning effort",
    category: "thought_level",
    type: "select",
    currentValue: effort,
    options: [
      { value: "low", name: "Low" },
      { value: "medium", name: "Medium" },
      { value: "high", name: "High" },
    ],
  },
];

// ---- the session -------------------------------------------------------------

let sessionId = null;
let cancelled = false;
let toolSeq = 0;
/** The last session/new (or load) params, so a test can read what awui mounted. */
let mounted = [];

function send(update) {
  notify("session/update", { sessionId, update });
}

/** A request of the client this script waits on (the permission prompt). */
const asked = new Map();
let askSeq = 500;
function askClient(method, params) {
  const id = askSeq++;
  return new Promise((resolve) => {
    asked.set(id, resolve);
    out({ jsonrpc: "2.0", id, method, params });
  });
}

async function turn(id, text) {
  record("prompts", text);
  if (text.includes("crash")) {
    // Died mid-run: the prompt request never answers, the child's stderr says why.
    process.stderr.write("fake-acp: the provider connection closed\n");
    process.exit(3);
  }
  if (text.includes("fail")) {
    fail(id, -32000, "the model refused");
    return;
  }
  if (text.includes("think")) send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking it over" } });

  if (text.includes("tool")) {
    const toolCallId = `call-${++toolSeq}`;
    send({ sessionUpdate: "tool_call", toolCallId, title: "Read the file", name: "read_file", kind: "read", status: "pending", rawInput: { path: "/tmp/notes.txt" }, locations: [{ path: "/tmp/notes.txt", line: 1 }] });
    send({ sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    send({ sessionUpdate: "tool_call_update", toolCallId, status: "completed", content: [{ type: "content", content: { type: "text", text: "hello from the file" } }] });
  }

  if (text.includes("diff")) {
    const toolCallId = `call-${++toolSeq}`;
    send({ sessionUpdate: "tool_call", toolCallId, title: "Edit the file", name: "edit_file", kind: "edit", status: "pending", rawInput: { path: "/tmp/notes.txt" } });
    send({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: "completed",
      content: [{ type: "diff", path: "/tmp/notes.txt", oldText: "before\n", newText: "after\n" }],
    });
  }

  if (text.includes("ask")) {
    const toolCallId = `call-${++toolSeq}`;
    send({ sessionUpdate: "tool_call", toolCallId, title: "Run the command", name: "run_command", kind: "execute", status: "pending", rawInput: { command: "rm -rf build" } });
    const answer = await askClient("session/request_permission", {
      sessionId,
      toolCall: { toolCallId },
      options: [
        { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject-once", name: "Reject", kind: "reject_once" },
      ],
    });
    record("permissionAnswers", answer?.result ?? answer);
    const chosen = answer?.result?.outcome?.outcome === "selected" ? answer.result.outcome.optionId : "cancelled";
    const allowed = chosen === "allow-once";
    send({
      sessionUpdate: "tool_call_update",
      toolCallId,
      status: allowed ? "completed" : "failed",
      content: [{ type: "content", content: { type: "text", text: allowed ? "build removed" : "not allowed" } }],
    });
    respond(id, { stopReason: "end_turn" });
    return;
  }

  if (text.includes("plan")) {
    send({
      sessionUpdate: "plan",
      entries: [
        { content: "Read the project", priority: "high", status: "completed" },
        { content: "Change one file", priority: "medium", status: "pending" },
      ],
    });
  }

  if (text.includes("usage")) send({ sessionUpdate: "usage_update", used: 12000, size: 200000, cost: { amount: 0.02, currency: "USD" } });
  if (text.includes("title")) send({ sessionUpdate: "session_info_update", title: "A named session" });
  if (text.includes("commands")) {
    send({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "/review", description: "Review the diff", input: { hint: "[path]" } }] });
  }
  if (text.includes("config")) {
    currentModel = "acp-lite";
    send({ sessionUpdate: "config_option_update", configOptions: configOptions() });
  }
  if (text.includes("unknown")) send({ sessionUpdate: "auto_approved", toolCallId: "none" });

  if (text.includes("slow")) {
    for (const char of `acp says ${text}`) {
      if (cancelled) break;
      await sleep(5);
      send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: char } });
    }
    respond(id, { stopReason: cancelled ? "cancelled" : "end_turn" });
    return;
  }

  send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "acp says ok" } });
  respond(id, { stopReason: "end_turn" });
}

// ---- frames ------------------------------------------------------------------

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let at;
  while ((at = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, at);
    buffer = buffer.slice(at + 1);
    if (!line.trim()) continue;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    void handle(frame);
  }
});

async function handle(frame) {
  const method = frame.method;
  // A response to a request this script made (the permission answer).
  if (method === undefined) {
    const resolve = asked.get(frame.id);
    if (resolve) {
      asked.delete(frame.id);
      resolve(frame);
    }
    return;
  }
  if (method === "initialize") {
    record("initialize", { clientCapabilities: frame.params?.clientCapabilities ?? null, clientInfo: frame.params?.clientInfo ?? null });
    // FAKE_ACP_DIE_ON_INIT: an agent that says something on stderr and dies before it answers.
    if (process.env.FAKE_ACP_DIE_ON_INIT) {
      process.stderr.write(`fake-acp: ${process.env.FAKE_ACP_DIE_ON_INIT}\n`);
      process.exit(7);
    }
    respond(frame.id, {
      // FAKE_ACP_NO_LOAD: a build that advertises neither loadSession nor resume (an app with no session history surface).
      agentCapabilities: process.env.FAKE_ACP_NO_LOAD ? { promptCapabilities: {} } : { loadSession: true, promptCapabilities: { image: true, embeddedContext: false }, mcpCapabilities: { http: true, sse: false } },
      agentInfo: { name: "fake-acp", title: "Fake ACP", version: "0.9.1" },
      authMethods: [
        { id: "agent-login", name: "Sign in with the agent", description: "Runs the agent's own login" },
        { id: "api-key", name: "API key" },
      ],
    });
    return;
  }
  if (method === "authenticate") {
    record("authenticate", frame.params ?? null);
    respond(frame.id, {});
    return;
  }
  if (method === "session/new" || method === "session/load" || method === "session/resume") {
    sessionId = method === "session/new" ? `sess-${randomUUID()}` : String(frame.params?.sessionId ?? "");
    mounted = frame.params?.mcpServers ?? [];
    record("mcpServers", { method, servers: mounted });
    if (method === "session/load") {
      // The replay, before the response: the conversation as it was.
      send({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "first question" } });
      send({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "first answer" } });
    }
    respond(frame.id, { sessionId, configOptions: configOptions() });
    return;
  }
  if (method === "session/set_config_option") {
    const { configId, value } = frame.params ?? {};
    record("configValues", { configId, value });
    if (configId === "model") currentModel = String(value);
    if (configId === "reasoning_effort") effort = String(value);
    respond(frame.id, { configOptions: configOptions() });
    return;
  }
  if (method === "session/cancel") {
    cancelled = true;
    record("cancels", frame.params ?? null);
    return;
  }
  if (method === "session/prompt") {
    cancelled = false;
    const text = (frame.params?.prompt ?? []).map((block) => block?.text ?? "").join(" ");
    await turn(frame.id, text);
    return;
  }
  if (frame.id !== undefined) fail(frame.id, -32601, `fake-acp does not implement ${method}`);
}
