#!/usr/bin/env node
// Scripted `codex app-server` for adapter tests: the JSON-RPC lines the real
// 0.167 app-server speaks on stdio, with a thread store and rollout files in
// Codex's own layout under <home>/sessions/YYYY/MM/DD/.
// Prompt text selects behaviour:
//   "tool"      a shell call, then the answer          "ask"   the same, but it needs approval
//   "diff"      a fileChange (one update, one add)     "question"  request_user_input
//   "think"     reasoning deltas first                 "slow"  many small deltas (cancellable)
//   "fail"      an error notification, then a failed turn
// Every method call, approval decision, and steer is recorded in
// $FAKE_CODEX_STATE so a test can see what went out on the wire.
import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

const argv = process.argv.slice(2);
// As the CLI answers it, so discovery finds a version.
if (argv.includes("--version")) {
  console.log("codex-cli 0.167.0");
  process.exit(0);
}
if (argv[0] !== "app-server") {
  console.error("fake-codex: only `app-server` is supported");
  process.exit(2);
}

const home = process.env.FAKE_CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(process.env.HOME ?? "", ".codex");
const threadsDir = path.join(home, "threads");
const sessionsDir = path.join(home, "sessions");
mkdirSync(threadsDir, { recursive: true });
mkdirSync(sessionsDir, { recursive: true });

const statePath = process.env.FAKE_CODEX_STATE;
const record = (key, value) => {
  if (!statePath) return;
  let state = {};
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {}
  state[key] = [...(state[key] ?? []), value];
  writeFileSync(statePath, JSON.stringify(state));
};

// What awui spawned this child with: the `-c` overrides a test asserts on.
record("args", argv);

const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const respond = (id, result) => out({ id, result });
const fail = (id, code, message) => out({ id, error: { code, message } });
const notify = (method, params) => out({ method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODEL = "fake-1";
const WINDOW = 200_000;
const now = () => Math.floor(Date.now() / 1000);

const MODELS = [
  {
    id: MODEL,
    model: MODEL,
    displayName: "Fake One",
    description: "A model for tests",
    hidden: false,
    supportedReasoningEfforts: [
      { reasoningEffort: "low", description: "Fast" },
      { reasoningEffort: "medium", description: "Balanced" },
      { reasoningEffort: "high", description: "Deep" },
    ],
    defaultReasoningEffort: "medium",
    inputModalities: ["text", "image"],
    isDefault: true,
  },
  {
    id: "fake-max",
    model: "fake-max",
    displayName: "Fake Max",
    description: "A bigger fake",
    hidden: false,
    supportedReasoningEfforts: [{ reasoningEffort: "low", description: "Fast" }],
    defaultReasoningEffort: "low",
    inputModalities: ["text"],
    isDefault: false,
  },
];

// ---- the thread store, on disk so a second probe process sees it -------------

const threadFile = (id) => path.join(threadsDir, `${id}.json`);
function loadThread(id) {
  try {
    return JSON.parse(readFileSync(threadFile(id), "utf8"));
  } catch {
    return null;
  }
}
function saveThread(thread) {
  thread.updatedAt = now();
  writeFileSync(threadFile(thread.id), JSON.stringify(thread));
}
function allThreads() {
  const out = [];
  let names = [];
  try {
    names = readdirSync(threadsDir);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(readFileSync(path.join(threadsDir, name), "utf8")));
    } catch {}
  }
  return out;
}

function sandboxPolicy(mode) {
  if (mode && typeof mode === "object") return mode;
  if (mode === "read-only") return { type: "readOnly", networkAccess: false };
  if (mode === "danger-full-access") return { type: "dangerFullAccess" };
  return { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
}

function newThread({ cwd, model, approvalPolicy, sandbox, name = null, turns = [], preview = "", forkedFromId = null }) {
  const thread = {
    id: randomUUID(),
    sessionId: "",
    name,
    preview,
    cwd,
    model: model || MODEL,
    reasoningEffort: "medium",
    approvalPolicy: approvalPolicy || "on-request",
    sandbox: sandboxPolicy(sandbox),
    createdAt: now(),
    updatedAt: now(),
    forkedFromId,
    turns,
    path: null,
  };
  thread.sessionId = thread.id;
  thread.path = path.join(rolloutDir(), `rollout-${new Date().toISOString().replace(/[:.]/g, "-")}-${thread.id}.jsonl`);
  saveThread(thread);
  writeRollout(thread, [
    {
      timestamp: new Date().toISOString(),
      type: "session_meta",
      payload: { id: thread.id, timestamp: new Date().toISOString(), cwd, originator: "fake-codex", cli_version: "0.167.0", model_provider: "openai" },
    },
  ]);
  return thread;
}

function rolloutDir() {
  const d = new Date();
  const dir = path.join(sessionsDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(dir, { recursive: true });
  return dir;
}
/** A thread's rollout: its own file, named for the thread id so the adapter can find it. */
function writeRollout(thread, lines) {
  mkdirSync(path.dirname(thread.path), { recursive: true });
  appendFileSync(thread.path, lines.map((line) => JSON.stringify(line) + "\n").join(""));
}

/** The thread as the app-server reports it, with what its own fields name. */
function threadView(thread, { includeTurns = false } = {}) {
  return {
    id: thread.id,
    environments: [{ environmentId: "local", cwd: thread.cwd, runtimeWorkspaceRoots: [thread.cwd] }],
    extra: null,
    sessionId: thread.sessionId || thread.id,
    forkedFromId: thread.forkedFromId,
    parentThreadId: null,
    preview: thread.preview,
    ephemeral: false,
    section: null,
    projectId: null,
    historyMode: "paginated",
    modelProvider: "openai",
    model: thread.model,
    reasoningEffort: thread.reasoningEffort,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    recencyAt: thread.createdAt,
    status: { type: "idle" },
    path: thread.path,
    cwd: thread.cwd,
    cliVersion: "0.167.0",
    source: "cli",
    name: thread.name,
    ...(includeTurns ? { turns: thread.turns.map((turn) => ({ ...turn, itemsView: "full" })) } : {}),
  };
}

const state = { thread: null, producing: false, cancelled: false, pending: new Map(), requestId: 1000, queue: [] };

function serverRequest(method, params) {
  const id = state.requestId++;
  const promise = new Promise((resolve) => state.pending.set(id, resolve));
  out({ id, method, params });
  return promise;
}

function emit(event) {
  notify(event.method, event.params);
}

async function streamMessage(thread, turn, text, { chunk = 4, delay = 6 } = {}) {
  const item = { type: "agentMessage", id: `msg_${randomUUID()}`, text: "", phase: "final_answer", startedAtMs: Date.now(), completedAtMs: null };
  turn.items.push(item);
  emit({ method: "item/started", params: { item: { ...item }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() } });
  for (let i = 0; i < text.length; i += chunk) {
    if (state.cancelled || turn.status !== "inProgress") return;
    const delta = text.slice(i, i + chunk);
    item.text += delta;
    emit({ method: "item/agentMessage/delta", params: { threadId: thread.id, turnId: turn.id, itemId: item.id, delta } });
    await sleep(delay);
  }
  item.completedAtMs = Date.now();
  emit({ method: "item/completed", params: { item, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() } });
  writeRollout(thread, [
    { timestamp: new Date().toISOString(), type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }], phase: "final_answer" } },
    { timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "agent_message", message: text, phase: "final_answer" } },
  ]);
}

async function streamThinking(thread, turn) {
  const item = { type: "reasoning", id: `rs_${randomUUID()}`, summary: [], content: [], startedAtMs: Date.now(), completedAtMs: null };
  turn.items.push(item);
  emit({ method: "item/started", params: { item: { ...item }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() } });
  for (const delta of ["Checking ", "the workspace."]) {
    if (state.cancelled || turn.status !== "inProgress") return;
    item.summary.push(delta);
    emit({ method: "item/reasoning/summaryTextDelta", params: { threadId: thread.id, turnId: turn.id, itemId: item.id, delta, summaryIndex: 0 } });
    await sleep(8);
  }
  item.completedAtMs = Date.now();
  emit({ method: "item/completed", params: { item, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() } });
}

async function shellCall(thread, turn, command, { approval = false } = {}) {
  const id = `exec-${randomUUID()}`;
  const item = {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: `/bin/bash -lc '${command}'`,
    cwd: thread.cwd,
    processId: null,
    source: "agent",
    status: "inProgress",
    commandActions: [{ type: "unknown", command }],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    startedAtMs: Date.now(),
    completedAtMs: null,
  };
  turn.items.push(item);
  emit({ method: "item/started", params: { item: { ...item }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() } });
  let accepted = true;
  if (approval) {
    notify("thread/status/changed", { threadId: thread.id, status: { type: "active", activeFlags: ["waitingOnApproval"] } });
    const answer = await serverRequest("item/commandExecution/requestApproval", {
      kind: "command",
      threadId: thread.id,
      turnId: turn.id,
      itemId: id,
      startedAtMs: Date.now(),
      environmentId: "local",
      command: item.command,
      cwd: thread.cwd,
      commandActions: item.commandActions,
      availableDecisions: ["accept", "acceptForSession", "cancel"],
    });
    const decision = answer && typeof answer === "object" ? answer.decision : "cancel";
    record("decisions", { itemId: id, decision });
    accepted = decision === "accept" || decision === "acceptForSession";
    notify("thread/status/changed", { threadId: thread.id, status: { type: "active", activeFlags: [] } });
  }
  if (state.cancelled || turn.status !== "inProgress") return;
  item.status = accepted ? "completed" : "declined";
  item.aggregatedOutput = accepted ? "fake output\n" : "";
  item.exitCode = accepted ? 0 : null;
  item.durationMs = 1;
  item.completedAtMs = Date.now();
  emit({ method: "item/completed", params: { item, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() } });
  writeRollout(thread, [
    { timestamp: new Date().toISOString(), type: "response_item", payload: { type: "function_call", name: "exec_command", call_id: id, arguments: JSON.stringify({ cmd: command }) } },
    { timestamp: new Date().toISOString(), type: "response_item", payload: { type: "function_call_output", call_id: id, output: item.aggregatedOutput } },
  ]);
}

async function fileChange(thread, turn, { approval = false } = {}) {
  const id = `exec-${randomUUID()}`;
  const changes = [
    { path: path.join(thread.cwd, "a.txt"), kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new\n" },
    { path: path.join(thread.cwd, "b.txt"), kind: { type: "add" }, diff: "fresh\n" },
  ];
  const item = { type: "fileChange", id, changes, status: "inProgress", startedAtMs: Date.now(), completedAtMs: null };
  turn.items.push(item);
  emit({ method: "item/started", params: { item: { ...item }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() } });
  if (approval) {
    const answer = await serverRequest("item/fileChange/requestApproval", { threadId: thread.id, turnId: turn.id, itemId: id, startedAtMs: Date.now(), reason: "Wants to write two files" });
    record("decisions", { itemId: id, decision: answer && typeof answer === "object" ? answer.decision : "cancel" });
  }
  if (state.cancelled) return;
  item.status = "completed";
  item.completedAtMs = Date.now();
  emit({ method: "item/completed", params: { item, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() } });
  writeRollout(thread, [
    { timestamp: new Date().toISOString(), type: "response_item", payload: { type: "custom_tool_call", name: "apply_patch", call_id: id, input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Add File: b.txt\n+fresh\n*** End Patch" } },
    { timestamp: new Date().toISOString(), type: "response_item", payload: { type: "custom_tool_call_output", call_id: id, output: "Success" } },
  ]);
}

function finishTurn(thread, turn, status, error = null) {
  turn.status = status;
  turn.completedAtMs = Date.now();
  turn.startedAt = turn.startedAt ?? now() - 1;
  turn.completedAt = now();
  turn.durationMs = 10;
  turn.error = error ? { message: error } : null;
  saveThread(thread);
  if (error) {
    notify("error", { threadId: thread.id, turnId: turn.id, error: { message: error }, willRetry: false });
  }
  notify("thread/status/changed", { threadId: thread.id, status: { type: "idle" } });
  emit({ method: "turn/completed", params: { threadId: thread.id, turn: { ...turn, itemsView: "summary" } } });
  state.producing = false;
  state.cancelled = false;
  if (state.queue.length > 0 && status === "completed") {
    const queued = state.queue.shift();
    notify("thread/queue/changed", { threadId: thread.id });
    void runTurn(thread, queued.input, { queued });
  }
}

function usage(thread) {
  const last = { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 600, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 0 };
  const total = { totalTokens: 2400, inputTokens: 2000, cachedInputTokens: 1000, cacheWriteInputTokens: 0, outputTokens: 400, reasoningOutputTokens: 0 };
  notify("thread/tokenUsage/updated", { threadId: thread.id, turnId: thread.turns.at(-1)?.id ?? "", tokenUsage: { total, last, modelContextWindow: WINDOW } });
  notify("account/rateLimits/updated", { rateLimits: { limitId: "codex", planType: "plus", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: now() + 3600 }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: null } } });
  writeRollout(thread, [{ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 2000, cached_input_tokens: 1000, cache_write_input_tokens: 0, output_tokens: 400, total_tokens: 2400 }, last_token_usage: { input_tokens: 1000, cached_input_tokens: 600, cache_write_input_tokens: 0, output_tokens: 200, total_tokens: 1200 } } } }]);
}

async function runTurn(thread, input, { queued = false } = {}) {
  const text = input.filter((i) => i && i.type === "text").map((i) => i.text).join("\n");
  record("prompts", text);
  const turn = { id: randomUUID(), rootTurnId: null, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: now(), completedAt: null, durationMs: null, startedAtMs: Date.now() };
  turn.rootTurnId = turn.id;
  thread.turns.push(turn);
  if (!thread.preview && !queued) thread.preview = text.slice(0, 120);
  state.producing = true;
  state.cancelled = false;
  emit({ method: "turn/started", params: { threadId: thread.id, turn: { ...turn, itemsView: "notLoaded" } } });
  notify("thread/status/changed", { threadId: thread.id, status: { type: "active", activeFlags: [] } });
  writeRollout(thread, [
    { timestamp: new Date().toISOString(), type: "turn_context", payload: { turn_id: turn.id, cwd: thread.cwd, model: thread.model } },
    { timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "task_started", turn_id: turn.id } },
    { timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "user_message", message: text } },
  ]);
  const user = { type: "userMessage", id: randomUUID(), clientId: null, content: input, startedAtMs: Date.now(), completedAtMs: Date.now() };
  turn.items.push(user);
  emit({ method: "item/started", params: { item: { ...user, completedAtMs: null }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() } });
  emit({ method: "item/completed", params: { item: user, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() } });

  try {
    if (text.includes("fail")) {
      await sleep(20);
      finishTurn(thread, turn, "failed", "the fake model refused");
      return;
    }
    if (text.includes("think")) await streamThinking(thread, turn);
    if (text.includes("question")) {
      const answer = await serverRequest("item/tool/requestUserInput", {
        threadId: thread.id,
        turnId: turn.id,
        itemId: `ask_${randomUUID()}`,
        isBlocking: true,
        questions: [{ id: "q1", header: "Color", question: "Which color?", isOther: true, isSecret: false, options: [{ label: "Blue", description: "Calm" }, { label: "Green", description: "Fresh" }] }],
      });
      record("answers", answer && typeof answer === "object" ? answer.answers : null);
      await streamMessage(thread, turn, "Got the answer.");
    } else if (text.includes("diff")) {
      await fileChange(thread, turn, { approval: text.includes("ask") });
      await streamMessage(thread, turn, "Changed two files.");
    } else if (text.includes("ask")) {
      await shellCall(thread, turn, "rm -rf build", { approval: true });
      await streamMessage(thread, turn, "Ran the command.");
    } else if (text.includes("tool")) {
      await shellCall(thread, turn, "ls");
      await streamMessage(thread, turn, "Listed the folder.");
    } else if (text.includes("slow")) {
      await streamMessage(thread, turn, "A slow reply that a stop can interrupt, word by word. ".repeat(6), { chunk: 3, delay: 12 });
    } else {
      await streamMessage(thread, turn, `Fake reply: ${text.slice(0, 60)}`);
    }
    if (state.cancelled) return;
    usage(thread);
    finishTurn(thread, turn, "completed");
  } catch (error) {
    finishTurn(thread, turn, "failed", error instanceof Error ? error.message : String(error));
  }
}

// ---- the protocol -------------------------------------------------------------

const HANDLERS = {
  initialize: (_params) => ({ userAgent: `fake-codex/0.167.0 (test) unknown (awui; 0.0.0)`, codexHome: home, platformFamily: "unix", platformOs: "linux" }),
  "model/list": () => ({ data: MODELS, nextCursor: null }),
  "config/read": () => ({ config: { model: process.env.FAKE_CODEX_CONFIG_MODEL || MODEL, model_reasoning_effort: "medium", model_provider: "openai", approval_policy: "on-request", sandbox_mode: "workspace-write" }, origins: {}, layers: [] }),
  "account/read": () => ({ account: { type: "chatgpt", email: "fake@example.com", planType: "plus", workspaceName: null }, requiresOpenaiAuth: true }),
  "account/rateLimits/read": () => ({
    ordinaryUsageAllowed: true,
    rateLimits: { limitId: "codex", limitName: null, planType: "plus", primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: now() + 3600 }, secondary: null, credits: { hasCredits: false, unlimited: false, balance: null }, rateLimitReachedType: null, spendControlReached: false },
  }),
  "thread/start": (params) => {
    const thread = newThread({ cwd: params.cwd ?? process.cwd(), model: params.model, approvalPolicy: params.approvalPolicy, sandbox: params.sandbox });
    state.thread = thread;
    notify("thread/started", { thread: threadView(thread) });
    notify("mcpServer/startupStatus/updated", { threadId: thread.id, name: "fake", status: "ready", error: null, failureReason: null });
    return {
      thread: threadView(thread),
      model: thread.model,
      modelProvider: "openai",
      serviceTier: null,
      cwd: thread.cwd,
      runtimeWorkspaceRoots: [thread.cwd],
      approvalPolicy: thread.approvalPolicy,
      sandbox: thread.sandbox,
      reasoningEffort: thread.reasoningEffort,
      instructionSources: [],
      activePermissionProfile: null,
      multiAgentMode: "explicitRequestOnly",
      disabledPluginIds: [],
    };
  },
  "thread/resume": (params) => {
    const thread = loadThread(params.threadId);
    if (!thread) throw { code: -32602, message: `no such thread ${params.threadId}` };
    state.thread = thread;
    state.queue = thread.queue ?? [];
    notify("thread/status/changed", { threadId: thread.id, status: { type: "idle" } });
    usage(thread);
    return { thread: threadView(thread), model: thread.model, modelProvider: "openai", cwd: thread.cwd, approvalPolicy: thread.approvalPolicy, sandbox: thread.sandbox, reasoningEffort: thread.reasoningEffort, runtimeWorkspaceRoots: [thread.cwd], serviceTier: null, disabledPluginIds: [], instructionSources: [], activePermissionProfile: null, multiAgentMode: "explicitRequestOnly" };
  },
  "thread/list": (params) => {
    const wanted = params.cwd ? (Array.isArray(params.cwd) ? params.cwd : [params.cwd]) : null;
    const threads = allThreads()
      .filter((t) => !wanted || wanted.includes(t.cwd))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, params.limit ?? 50);
    return { data: threads.map((t) => threadView(t)), readStates: null, nextCursor: null, backwardsCursor: null };
  },
  "thread/read": (params) => {
    const thread = loadThread(params.threadId);
    if (!thread) throw { code: -32602, message: `no such thread ${params.threadId}` };
    // As 0.167 answers a thread with nothing in it yet.
    if (params.includeTurns === true && thread.turns.length === 0) throw { code: -32603, message: "thread/read: list_turns is not supported yet" };
    return { thread: threadView(thread, { includeTurns: params.includeTurns === true }) };
  },
  "thread/turns/list": (params) => {
    const thread = loadThread(params.threadId);
    if (!thread || thread.turns.length === 0) throw { code: -32603, message: "thread/turns/list: list_turns is not supported yet" };
    return { data: thread.turns.map((t) => ({ ...t, itemsView: "summary" })), nextCursor: null };
  },
  "thread/items/list": (params) => {
    const thread = loadThread(params.threadId);
    const turn = thread?.turns.find((t) => t.id === params.turnId);
    return { data: (turn?.items ?? []).map((item) => ({ turnId: turn.id, item, startedAtMs: item.startedAtMs, completedAtMs: item.completedAtMs })), nextCursor: null };
  },
  "thread/name/set": (params) => {
    const thread = loadThread(params.threadId);
    if (thread) {
      thread.name = params.name;
      saveThread(thread);
    }
    notify("thread/name/updated", { threadId: params.threadId, threadName: params.name });
    return {};
  },
  "thread/fork": (params) => {
    const source = loadThread(params.threadId);
    if (!source) throw { code: -32602, message: "no such thread" };
    const until = params.lastTurnId ? source.turns.findIndex((t) => t.id === params.lastTurnId) + 1 : source.turns.length;
    const turns = structuredClone(source.turns.slice(0, until));
    const forked = newThread({ cwd: source.cwd, model: source.model, approvalPolicy: source.approvalPolicy, sandbox: source.sandbox, turns, preview: source.preview, forkedFromId: source.id, name: source.name });
    return { thread: threadView(forked, { includeTurns: true }) };
  },
  "thread/compact/start": (params) => {
    const thread = loadThread(params.threadId);
    if (!thread) throw { code: -32602, message: "no such thread" };
    void (async () => {
      const turn = { id: randomUUID(), rootTurnId: null, items: [], itemsView: "full", status: "inProgress", error: null, startedAt: now(), completedAt: null, durationMs: null };
      turn.rootTurnId = turn.id;
      thread.turns.push(turn);
      emit({ method: "turn/started", params: { threadId: thread.id, turn: { ...turn, itemsView: "notLoaded" } } });
      const item = { type: "contextCompaction", id: randomUUID(), startedAtMs: Date.now(), completedAtMs: null };
      emit({ method: "item/started", params: { item: { ...item }, threadId: thread.id, turnId: turn.id, startedAtMs: Date.now() } });
      await sleep(10);
      item.completedAtMs = Date.now();
      emit({ method: "item/completed", params: { item, threadId: thread.id, turnId: turn.id, completedAtMs: Date.now() } });
      writeRollout(thread, [{ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "context_compacted" } }]);
      finishTurn(thread, turn, "completed");
    })();
    return {};
  },
  "thread/settings/update": (params) => {
    const thread = loadThread(params.threadId);
    if (thread) {
      if (params.approvalPolicy !== undefined) thread.approvalPolicy = params.approvalPolicy;
      if (params.sandboxPolicy !== undefined) thread.sandbox = params.sandboxPolicy;
      if (params.model !== undefined) thread.model = params.model;
      if (params.effort !== undefined) thread.reasoningEffort = params.effort;
      saveThread(thread);
    }
    return {};
  },
  "turn/start": (params) => {
    const thread = state.thread ?? loadThread(params.threadId);
    if (!thread) throw { code: -32602, message: "no such thread" };
    if (state.producing) throw { code: -32600, message: "a turn is already running" };
    state.thread = thread;
    const turn = { id: randomUUID(), rootTurnId: null, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: now(), completedAt: null, durationMs: null, startedAtMs: Date.now() };
    turn.rootTurnId = turn.id;
    notify("turn/started", { threadId: thread.id, turn });
    void runTurn(thread, params.input ?? []);
    return { turn };
  },
  "turn/steer": (params) => {
    const thread = state.thread ?? loadThread(params.threadId);
    if (!thread) throw { code: -32602, message: "no such thread" };
    const active = thread.turns.at(-1);
    if (!active || active.status !== "inProgress" || active.id !== params.expectedTurnId) throw { code: -32600, message: `expected active turn id \`${params.expectedTurnId}\`` };
    const text = (params.input ?? []).filter((i) => i && i.type === "text").map((i) => i.text).join("\n");
    record("steers", { turnId: params.expectedTurnId, text });
    const item = { type: "userMessage", id: randomUUID(), clientId: null, content: [{ type: "text", text, text_elements: [] }], startedAtMs: Date.now(), completedAtMs: Date.now() };
    active.items.push(item);
    emit({ method: "item/started", params: { item: { ...item, completedAtMs: null }, threadId: thread.id, turnId: active.id, startedAtMs: Date.now() } });
    emit({ method: "item/completed", params: { item, threadId: thread.id, turnId: active.id, completedAtMs: Date.now() } });
    return { turnId: active.id };
  },
  "turn/interrupt": (params) => {
    const thread = state.thread ?? loadThread(params.threadId);
    const turn = thread?.turns.find((t) => t.id === params.turnId);
    state.cancelled = true;
    if (turn && turn.status === "inProgress") finishTurn(thread, turn, "interrupted");
    return {};
  },
  "thread/queue/add": (params) => {
    const submission = { id: randomUUID(), input: params.input ?? [], clientUserMessageId: params.clientUserMessageId ?? null };
    state.queue.push(submission);
    const thread = state.thread ?? loadThread(params.threadId);
    if (thread) {
      thread.queue = state.queue;
      saveThread(thread);
    }
    notify("thread/queue/changed", { threadId: params.threadId });
    return { queuedSubmission: submission };
  },
  "thread/queue/list": () => ({ data: state.queue, nextCursor: null }),
  "thread/queue/delete": (params) => {
    state.queue = state.queue.filter((q) => q.id !== params.queuedSubmissionId);
    notify("thread/queue/changed", { threadId: params.threadId });
    return {};
  },
  "thread/queue/update": (params) => {
    const queued = state.queue.find((q) => q.id === params.queuedSubmissionId);
    if (queued) queued.input = params.input ?? [];
    notify("thread/queue/changed", { threadId: params.threadId });
    return {};
  },
  "thread/queue/start": () => ({}),
  "currentTime/read": () => ({ currentTimeAt: now() }),
};

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = frame;
  // A response to one of our own requests (an approval, a question).
  if (method === undefined && id !== undefined) {
    const resolve = state.pending.get(id);
    if (resolve) {
      state.pending.delete(id);
      resolve(frame.error ? { error: frame.error } : frame.result);
    }
    return;
  }
  if (method === "initialized") return;
  record("calls", { method, params });
  const handler = HANDLERS[method];
  if (!handler) {
    if (id !== undefined) fail(id, -32601, `unsupported method ${method}`);
    return;
  }
  if (id === undefined) {
    try {
      handler(params);
    } catch {}
    return;
  }
  try {
    respond(id, handler(params));
  } catch (error) {
    fail(id, error?.code ?? -32603, error?.message ?? "fake codex failed");
  }
});
process.stdin.on("end", () => process.exit(0));
