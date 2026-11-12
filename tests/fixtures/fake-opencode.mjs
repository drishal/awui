#!/usr/bin/env node
// Scripted `opencode serve` (OpenCode 2's HTTP API) for adapter tests: the
// routes awui calls and the events and stored messages they produce, in the
// shapes recorded from OpenCode 2.0.27, plus the runtime MCP routes and the
// session permission rules recorded from 2.2.7 (add and remove a server, a
// session's rules checked the way OpenCode checks them: last match wins, else
// ask). Basic auth with $OPENCODE_SERVER_PASSWORD; sessions live in
// $FAKE_OPENCODE_STATE (JSON), so a restarted server still has them, and every
// permission or form reply, MCP registration, and removal is recorded there.
// Prompt text selects behaviour:
//   "tool"   read a file first           "ask"       a shell call that needs approval
//   "edit"   edit a file (with a patch)  "question"  a form with two options
//   "slow"   stream many chunks          "fail"      the step fails with an error
//   "todo"   write a todo list            "delegate"  a subagent call running a child session
//   "mcpcall <tool>"  call that MCP tool, allowed or refused by the session's rules
//   "render"  call this project's awui render server, with the page marker awui's bridge prints
//   "alwaysallow"  an "always" answer: a broad allow appended after the session's own rules
//   "stray"   a session another client of the server made, with no rules at all
// A prompt sent while a run goes is held in the inbox: "steer" runs at the
// next step, "queue" after the run. $FAKE_OPENCODE_MCP_FAIL=1 refuses every
// MCP registration, as a server the runtime set will not take. The process's
// own pid is kept in the state file, so a test can end the shared server and
// see what its chats do when one starts again.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import http from "node:http";

const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("opencode v2.0.27");
  process.exit(0);
}
if (argv[0] !== "serve") {
  console.error("fake-opencode: only `serve` and `--version`");
  process.exit(2);
}
const password = process.env.OPENCODE_SERVER_PASSWORD ?? "";
const statePath = process.env.FAKE_OPENCODE_STATE;
const delay = Number(process.env.FAKE_OPENCODE_DELAY_MS ?? 5);

const state = statePath && existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : { sessions: {}, replies: [] };
// The shared server's pid: a test ends this process to see a chat outlive its server.
state.pid = process.pid;
// Written and renamed, as the server writes its own state: a test reading it never sees half a file.
const save = () => statePath && (writeFileSync(`${statePath}.tmp`, JSON.stringify(state)), renameSync(`${statePath}.tmp`, statePath));
// Every MCP server registered at runtime, by directory and name: OpenCode keeps this set in
// memory, so a server that starts again has none of it until a chat registers them again.
const mcpServers = new Map();
const mcpKey = (directory, server) => `${directory}\n${server}`;
/** The awui render server this project has registered, for the "render" prompt. */
const renderServer = (directory) => [...mcpServers.keys()].filter((k) => k.startsWith(`${directory}\nawui-r-`)).map((k) => k.split("\n")[1]);
/** The registered server a tool name belongs to, longest match first (a server's tools are `<server>_<tool>`). */
const serverOfTool = (directory, name) =>
  [...mcpServers.keys()]
    .filter((k) => k.startsWith(`${directory}\n`))
    .map((k) => k.split("\n")[1])
    .filter((server) => name.startsWith(`${server}_`))
    .sort((a, b) => b.length - a.length)[0];
/** OpenCode's rule match: a glob on the action, last match wins, and "ask" when nothing matches. */
const glob = (pattern, value) =>
  new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`, "s").test(value);
const ruleEffect = (action, s) => [...(Array.isArray(s.permissions) ? s.permissions : [])].reverse().find((rule) => glob(rule.action, action))?.effect ?? "ask";
let counter = 0;
const id = (prefix) => `${prefix}_${Date.now().toString(16)}${(counter++).toString(36).padStart(4, "0")}${randomBytes(4).toString("hex")}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MODELS = [
  {
    id: "fast-free",
    providerID: "opencode",
    name: "Fast Free",
    capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
    variants: [{ id: "none" }, { id: "low" }, { id: "high" }],
    limit: { context: 100000, output: 8000 },
    enabled: true,
    // Real entries carry provider settings; awui must never pass these on.
    settings: { apiKey: "sk-fake-never-shown", baseURL: "https://example.invalid" },
  },
  { id: "plain", providerID: "acme", name: "Plain", capabilities: { tools: true, input: ["text"], output: ["text"] }, variants: [], limit: { context: 32000 }, enabled: true },
];
const COMMANDS = [{ name: "review", description: "review changes" }];
// The page a "render" prompt publishes: awui's render tool ids are 32 hex characters.
const RENDER_PAGE_ID = "0123456789abcdef0123456789abcdef";

// ---- events ----------------------------------------------------------------------------
const streams = new Set();
function emit(type, data, location) {
  const event = { id: id("evt"), created: Date.now(), type, ...(location ? { location: { directory: location } } : {}), data };
  for (const res of streams) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// ---- sessions ----------------------------------------------------------------------------
const runs = new Map(); // sessionID -> { inbox: [], stop: bool, waiters }
function session(sid) {
  return state.sessions[sid] ?? null;
}
function info(s) {
  const { messages: _m, ...rest } = s;
  return rest;
}
function runOf(sid) {
  let r = runs.get(sid);
  if (!r) {
    r = { active: false, inbox: [], stop: false, pending: new Map() };
    runs.set(sid, r);
  }
  return r;
}

function enqueue(s, text, delivery) {
  const r = runOf(s.id);
  const item = { id: id("msg"), sessionID: s.id, time: { created: Date.now() }, type: "user", payload: { text }, delivery };
  r.inbox.push(item);
  emit("session.inbox.enqueued", { inboxID: item.id, sessionID: s.id, item: { type: "user", payload: { text }, delivery } }, s.location.directory);
  if (!r.active) void drive(s);
  return item;
}

async function drive(s) {
  const r = runOf(s.id);
  r.active = true;
  r.stop = false;
  emit("session.execution.started", { sessionID: s.id });
  let interrupted = false;
  while (r.inbox.length > 0 && !interrupted) {
    const item = r.inbox.shift();
    deliver(s, item);
    interrupted = await turn(s, item.payload.text);
  }
  r.active = false;
  if (interrupted) {
    s.messages.push({ id: id("msg"), type: "idle", time: { created: Date.now() }, outcome: "interrupted" });
    emit("session.execution.interrupted", { sessionID: s.id, reason: "user" });
  } else {
    s.messages.push({ id: id("msg"), type: "idle", time: { created: Date.now() }, outcome: "succeeded" });
    emit("session.execution.succeeded", { sessionID: s.id });
  }
  s.time.updated = Date.now();
  save();
}

function deliver(s, item) {
  s.messages.push({ id: item.id, type: "user", time: { created: Date.now() }, text: item.payload.text });
  emit("session.inbox.delivered", { sessionID: s.id, inboxID: item.id }, s.location.directory);
  if (s.title.startsWith("New session")) {
    s.title = item.payload.text.slice(0, 40);
    emit("session.renamed", { sessionID: s.id, title: s.title }, s.location.directory);
  }
}

/** One prompt's steps; true when it was interrupted. */
async function turn(s, text) {
  const r = runOf(s.id);
  const loc = s.location.directory;
  const step = async (parts) => {
    const mid = id("msg");
    const message = { id: mid, type: "assistant", time: { created: Date.now() }, agent: "build", model: s.model, content: [] };
    s.messages.push(message);
    emit("session.step.started", { sessionID: s.id, agent: "build", model: s.model, assistantMessageID: mid, started: Date.now() }, loc);
    for (const part of parts) {
      if (r.stop) break;
      if (part.reasoning) {
        emit("session.reasoning.started", { sessionID: s.id, assistantMessageID: mid, ordinal: 0 }, loc);
        emit("session.reasoning.delta", { sessionID: s.id, assistantMessageID: mid, ordinal: 0, delta: part.reasoning }, loc);
        emit("session.reasoning.ended", { sessionID: s.id, assistantMessageID: mid, ordinal: 0, text: part.reasoning }, loc);
        message.content.push({ type: "reasoning", text: part.reasoning });
      }
      if (part.text !== undefined) {
        const chunks = part.chunks ?? [part.text];
        emit("session.text.started", { sessionID: s.id, assistantMessageID: mid, ordinal: part.ordinal ?? 0 }, loc);
        let written = "";
        // A short reply arrives whole in `ended`, with no deltas (as OpenCode sends one).
        for (const chunk of part.wholeOnly ? [] : chunks) {
          if (r.stop) break;
          written += chunk;
          emit("session.text.delta", { sessionID: s.id, assistantMessageID: mid, ordinal: part.ordinal ?? 0, delta: chunk }, loc);
          await sleep(part.chunks ? Math.max(delay, 40) : delay);
        }
        const final = r.stop ? written : part.text;
        emit("session.text.ended", { sessionID: s.id, assistantMessageID: mid, ordinal: part.ordinal ?? 0, text: final }, loc);
        message.content.push({ type: "text", text: final });
      }
      if (part.tool) await tool(s, message, part.tool);
    }
    const tokens = { input: 100, output: 20, reasoning: 5, cache: { read: 1000, write: 0 } };
    if (r.stop) {
      message.finish = "error";
      message.error = { type: "aborted", message: "Step interrupted" };
      emit("session.step.failed", { sessionID: s.id, assistantMessageID: mid, error: message.error }, loc);
      return;
    }
    if (part0(parts).fail) {
      message.finish = "error";
      message.error = { type: "provider", message: "The provider refused the request" };
      emit("session.step.failed", { sessionID: s.id, assistantMessageID: mid, error: message.error }, loc);
      return;
    }
    Object.assign(message, { finish: "stop", cost: 0.002, tokens });
    message.time.completed = Date.now();
    s.tokens = { input: s.tokens.input + 100, output: s.tokens.output + 20, reasoning: s.tokens.reasoning + 5, cache: { read: s.tokens.cache.read + 1000, write: 0 } };
    s.cost += 0.002;
    emit("session.step.ended", { sessionID: s.id, assistantMessageID: mid, finish: "stop", cost: 0.002, tokens }, loc);
    emit("session.usage.updated", { sessionID: s.id, cost: s.cost, tokens: s.tokens });
  };
  const part0 = (parts) => parts[0] ?? {};

  if (/fail/.test(text)) {
    await step([{ fail: true, text: "" }]);
    emit("session.execution.failed", { sessionID: s.id, error: { message: "The provider refused the request" } });
    return false;
  }
  if (/tool/.test(text)) await step([{ reasoning: "read it first", tool: { name: "read", input: { path: "README.md" }, output: "Read file README.md\n1: # Fake" } }]);
  if (/edit/.test(text))
    await step([
      {
        tool: {
          name: "edit",
          input: { path: "note.txt", oldString: "hello", newString: "hello world" },
          output: "Edited note.txt (1 replacement)",
          metadata: { files: [{ file: "note.txt", patch: "Index: note.txt\n===\n--- note.txt\n+++ note.txt\n@@ -1,1 +1,1 @@\n-hello\n+hello world\n", additions: 1, deletions: 1 }] },
        },
      },
    ]);
  if (/delegate/.test(text))
    await step([{ tool: { name: "subagent", input: { agent: "explorer", description: "Look around", background: false, prompt: "List the files and read README.md" }, delegate: true } }]);
  if (/todo/.test(text)) await step([{ tool: { name: "todowrite", input: { todos: [{ content: "write tests", status: "in_progress" }, { content: "ship", status: "pending" }] }, output: "2 todos" } }]);
  if (/ask/.test(text)) await step([{ tool: { name: "shell", input: { command: "echo hi" }, output: "hi\n", metadata: { exit: 0 }, permission: true } }]);
  const mcpCall = /mcpcall\s+(\S+)/.exec(text)?.[1];
  if (mcpCall) {
    await step([{ tool: { name: mcpCall, input: { probe: true }, mcp: mcpCall } }]);
    return r.stop;
  }
  if (/render/.test(text)) {
    const server = renderServer(loc)[0];
    if (server) {
      const page = { id: RENDER_PAGE_ID, title: "Probe page", height: 240 };
      await step([{ tool: { name: `${server}_render_html`, input: { html: "<p>hi</p>", title: page.title, height: page.height }, output: `Rendered "${page.title}" into the chat. The page is above; do not describe or restate it in your reply.\nawui-html-render: ${JSON.stringify(page)}` } }]);
      return r.stop;
    }
  }
  // What OpenCode does when a card is answered "always": a broad allow lands after awui's rules and
  // wins the last-match check until the chat puts its pair back in front of it.
  if (/alwaysallow/.test(text)) s.permissions = [...(Array.isArray(s.permissions) ? s.permissions : []), { action: "*", resource: "*", effect: "allow" }];
  // A session another client of the server made: no parent, no rules of awui's, and by OpenCode's
  // own default nothing is refused in it.
  if (/stray/.test(text)) {
    const stray = id("ses");
    const now = Date.now();
    const other = { id: stray, title: "Made elsewhere", location: s.location, model: s.model, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now, updated: now }, messages: [] };
    state.sessions[stray] = other;
    save();
    emit("session.created", { sessionID: stray, title: other.title, location: other.location });
  }
  if (/question/.test(text)) {
    const chosen = await form(s);
    if (r.stop) return true;
    await step([{ text: `You chose ${chosen}` }]);
    return r.stop;
  }
  if (/slow/.test(text)) {
    await step([{ text: Array.from({ length: 30 }, (_, i) => `${i + 1} `).join(""), chunks: Array.from({ length: 30 }, (_, i) => `${i + 1} `) }]);
    // A steer waits for the step's end, as OpenCode's does.
    while (r.inbox.some((i) => i.delivery === "steer") && !r.stop) {
      const item = r.inbox.splice(
        r.inbox.findIndex((i) => i.delivery === "steer"),
        1,
      )[0];
      deliver(s, item);
      await step([{ text: `Steered: ${item.payload.text}`, wholeOnly: true }]);
    }
    return r.stop;
  }
  if (r.stop) return true;
  await step([{ reasoning: "thinking about it", text: `Echo: ${text}`, wholeOnly: /short/.test(text) }]);
  return r.stop;
}

async function tool(s, message, spec) {
  const r = runOf(s.id);
  const loc = s.location.directory;
  const callId = id("call");
  const part = { type: "tool", id: callId, name: spec.name, state: { status: "running", input: spec.input }, time: { created: Date.now() } };
  message.content.push(part);
  emit("session.tool.input.started", { sessionID: s.id, assistantMessageID: message.id, id: callId, name: spec.name }, loc);
  emit("session.tool.input.ended", { sessionID: s.id, assistantMessageID: message.id, id: callId, text: JSON.stringify(spec.input) }, loc);
  emit("session.tool.called", { sessionID: s.id, assistantMessageID: message.id, id: callId, input: spec.input, executed: false }, loc);
  if (spec.delegate) {
    const output = await subagent(s, callId, spec.input);
    part.state = { status: "completed", input: spec.input, content: [{ type: "text", text: output.text }], metadata: { sessionID: output.child, status: "completed", truncated: false } };
    part.time.completed = Date.now();
    emit("session.tool.success", { sessionID: s.id, assistantMessageID: message.id, id: callId, content: part.state.content, metadata: part.state.metadata, executed: false }, loc);
    return;
  }
  // An MCP tool: it exists only while its server is registered for this directory, and the
  // session's rules decide whether this chat may call it (another chat's server answers deny).
  if (spec.mcp) {
    const server = serverOfTool(loc, spec.mcp);
    const effect = server ? ruleEffect(spec.mcp, s) : "deny";
    if (!server || effect !== "allow") {
      part.state = { status: "error", input: spec.input, error: { type: server ? "permission.rejected" : "mcp.not_found", message: server ? "Denied" : `MCP server not found: ${spec.mcp}` } };
      part.time.completed = Date.now();
      emit("session.tool.failed", { sessionID: s.id, assistantMessageID: message.id, id: callId, error: part.state.error, executed: false }, loc);
      return;
    }
  }
  if (spec.permission) {
    const pid = id("per");
    const request = { id: pid, sessionID: s.id, action: "shell", resources: [spec.input.command], save: ["echo *"], source: { type: "tool", messageID: message.id, id: callId } };
    const reply = await new Promise((resolve) => {
      r.pending.set(pid, { request, resolve });
      emit("permission.asked", request, loc);
    });
    if (reply === "reject" || r.stop) {
      part.state = { status: "error", input: spec.input, error: { type: "permission.rejected", message: "Denied" } };
      emit("session.tool.failed", { sessionID: s.id, assistantMessageID: message.id, id: callId, error: part.state.error, executed: false }, loc);
      return;
    }
  }
  await sleep(delay);
  part.state = { status: "completed", input: spec.input, content: [{ type: "text", text: spec.output }], metadata: { truncated: false, ...(spec.metadata ?? {}) } };
  part.time.completed = Date.now();
  emit("session.tool.success", { sessionID: s.id, assistantMessageID: message.id, id: callId, content: part.state.content, metadata: part.state.metadata, executed: false }, loc);
}

/** A child session run by a subagent call, as oh-my-opencode-slim's `subagent` does. */
async function subagent(parent, callId, input) {
  const loc = parent.location.directory;
  const child = id("ses");
  const now = Date.now();
  const model = { providerID: "opencode-go", id: "mini", variant: "default" };
  const s = { id: child, parentID: parent.id, agent: input.agent, title: input.description, location: parent.location, model, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: now, updated: now }, messages: [] };
  state.sessions[child] = s;
  emit("session.created", { sessionID: child, parentID: parent.id, title: s.title, location: s.location });
  emit("session.tool.progress", { sessionID: parent.id, id: callId, metadata: { sessionID: child, status: "running" } }, loc);
  emit("session.execution.started", { sessionID: child });
  s.messages.push({ id: id("msg"), type: "user", time: { created: Date.now() }, text: input.prompt });
  const mid = id("msg");
  emit("session.step.started", { sessionID: child, agent: input.agent, model, assistantMessageID: mid, started: Date.now() }, loc);
  const readId = id("call");
  emit("session.tool.input.started", { sessionID: child, assistantMessageID: mid, id: readId, name: "read" }, loc);
  emit("session.tool.called", { sessionID: child, assistantMessageID: mid, id: readId, input: { path: "README.md" }, executed: false }, loc);
  await sleep(delay * 4);
  emit("session.tool.success", { sessionID: child, assistantMessageID: mid, id: readId, content: [{ type: "text", text: "1: # Fake" }], metadata: { truncated: false } }, loc);
  const text = "Found README.md, a fake project.";
  emit("session.text.started", { sessionID: child, assistantMessageID: mid, ordinal: 0 }, loc);
  emit("session.text.ended", { sessionID: child, assistantMessageID: mid, ordinal: 0, text }, loc);
  // Its tools in one step, its answer in the next, as OpenCode stores them.
  const tokens = { input: 250, output: 20, reasoning: 0, cache: { read: 0, write: 0 } };
  s.messages.push(
    { id: mid, type: "assistant", time: { created: Date.now(), completed: Date.now() }, agent: input.agent, model, content: [{ type: "tool", id: readId, name: "read", state: { status: "completed", input: { path: "README.md" }, content: [{ type: "text", text: "1: # Fake" }] } }], tokens, cost: 0.0015 },
    { id: id("msg"), type: "assistant", time: { created: Date.now(), completed: Date.now() }, agent: input.agent, model, content: [{ type: "text", text }], tokens, cost: 0.0015 },
  );
  emit("session.step.ended", { sessionID: child, assistantMessageID: mid, finish: "stop", cost: 0.003, tokens: { input: 500, output: 40, reasoning: 0, cache: { read: 0, write: 0 } } }, loc);
  emit("session.usage.updated", { sessionID: child, cost: 0.003, tokens: { input: 500, output: 40, reasoning: 0, cache: { read: 0, write: 0 } } });
  s.messages.push({ id: id("msg"), type: "idle", time: { created: Date.now() }, outcome: "succeeded" });
  Object.assign(s, { cost: 0.003, tokens: { input: 500, output: 40, reasoning: 0, cache: { read: 0, write: 0 } } });
  s.time.idle = Date.now();
  emit("session.execution.succeeded", { sessionID: child });
  save();
  return { child, text };
}

async function form(s) {
  const r = runOf(s.id);
  const fid = id("frm");
  const created = {
    id: fid,
    sessionID: s.id,
    title: "Questions",
    metadata: { kind: "question" },
    fields: [
      {
        key: "q0",
        title: "Indentation",
        description: "Tabs or spaces?",
        type: "string",
        options: [
          { value: "Tabs", label: "Tabs", description: "Indent with tabs" },
          { value: "Spaces", label: "Spaces", description: "Indent with spaces" },
        ],
      },
    ],
  };
  const answer = await new Promise((resolve) => {
    r.pending.set(fid, { form: created, resolve });
    emit("form.created", { form: created }, s.location.directory);
  });
  return answer?.q0 ?? "nothing";
}

// ---- routes ----------------------------------------------------------------------------
function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(body === undefined ? "" : JSON.stringify(body));
}
async function readBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  if (req.headers.authorization !== expected) return send(res, 401, { _tag: "UnauthorizedError", message: "Authentication required" });
  const url = new URL(req.url, "http://x");
  const p = url.pathname;
  const q = url.searchParams;
  const m = req.method;
  try {
    if (p === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: id("evt"), type: "server.connected", data: {} })}\n\n`);
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }
    if (p === "/api/model" && m === "GET") return send(res, 200, { location: { directory: q.get("location[directory]") }, data: MODELS });
    if (p === "/api/model/default") return send(res, 200, { data: MODELS[0] });
    if (p === "/api/command") return send(res, 200, { data: COMMANDS });
    if (p === "/api/session/active") return send(res, 200, { data: [...runs].filter(([, r]) => r.active).map(([sid]) => ({ sessionID: sid })) });
    // awui's MCP servers: runtime-only, per directory, as OpenCode's own are (the answer is 204).
    const mcpRoute = /^\/api\/experimental\/mcp\/([^/]+)$/.exec(p);
    if (mcpRoute) {
      const server = decodeURIComponent(mcpRoute[1]);
      const directory = q.get("location[directory]") ?? "";
      if (m === "PUT") {
        const body = await readBody(req);
        if (process.env.FAKE_OPENCODE_MCP_FAIL) return send(res, 500, { message: "MCP servers are unavailable" });
        if (!Array.isArray(body.config?.command)) return send(res, 400, { message: 'Expected array\n  at ["config"]["command"]' });
        mcpServers.set(mcpKey(directory, server), body.config);
        state.mcpAdds = [...(state.mcpAdds ?? []), { directory, server, config: body.config }];
        save();
        return send(res, 204);
      }
      if (m === "DELETE") {
        mcpServers.delete(mcpKey(directory, server));
        state.mcpRemoves = [...(state.mcpRemoves ?? []), { directory, server }];
        save();
        return send(res, 204);
      }
    }
    if (p === "/api/session" && m === "POST") {
      const body = await readBody(req);
      const sid = id("ses");
      const now = Date.now();
      const s = {
        id: sid,
        title: body.title ?? `New session - ${new Date(now).toISOString()}`,
        location: body.location,
        model: { ...(body.model ?? { providerID: "opencode", id: "fast-free" }), variant: body.model?.variant ?? "default" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: now, updated: now },
        messages: [],
      };
      state.sessions[sid] = s;
      save();
      emit("session.created", { sessionID: sid, title: s.title, location: s.location });
      return send(res, 200, { data: info(s) });
    }
    if (p === "/api/session" && m === "GET") {
      const dir = q.get("location[directory]");
      const limit = Number(q.get("limit") ?? 100);
      const all = Object.values(state.sessions)
        .filter((s) => !dir || s.location.directory === dir)
        .filter((s) => q.get("parentID") !== "null" || !s.parentID)
        .sort((a, b) => b.time.updated - a.time.updated)
        .slice(0, limit)
        .map(info);
      return send(res, 200, { data: all });
    }
    const sm = /^\/api\/session\/(ses_[A-Za-z0-9]+)(?:\/(.+))?$/.exec(p);
    if (!sm) return send(res, 404, { message: "no route" });
    const s = session(sm[1]);
    if (!s) return send(res, 404, { _tag: "SessionNotFoundError", message: "Session not found" });
    const rest = sm[2] ?? "";
    const r = runOf(s.id);
    if (rest === "" && m === "GET") return send(res, 200, { data: info(s) });
    if (rest === "" && m === "PATCH") {
      const body = await readBody(req);
      if (body.title) {
        s.title = body.title;
        emit("session.renamed", { sessionID: s.id, title: s.title }, s.location.directory);
      }
      // A session's own permission rules: awui scopes its chats with a deny and two allows.
      if (Array.isArray(body.permissions)) s.permissions = body.permissions;
      save();
      return send(res, 200, { data: info(s) });
    }
    if (rest === "" && m === "DELETE") {
      delete state.sessions[s.id];
      save();
      return send(res, 204);
    }
    if (rest === "prompt" || rest === "command") {
      const body = await readBody(req);
      const text = rest === "command" ? `/${body.name}${body.text ? ` ${body.text}` : ""}` : body.text;
      if (body.files?.length) state.replies.push({ kind: "files", files: body.files.map((f) => ({ name: f.name, uri: String(f.uri).slice(0, 30) })) });
      save();
      const item = enqueue(s, text, body.delivery ?? (r.active ? "steer" : "steer"));
      return send(res, 200, { data: item });
    }
    if (rest === "interrupt") {
      const was = r.active;
      r.stop = true;
      r.inbox.length = 0;
      for (const [pid, pending] of r.pending) {
        r.pending.delete(pid);
        pending.resolve(pending.form ? null : "reject");
      }
      return send(res, 200, { interrupted: was });
    }
    if (rest === "inbox" && m === "GET") return send(res, 200, { data: r.inbox });
    const inboxDel = /^inbox\/(.+)$/.exec(rest);
    if (inboxDel && m === "DELETE") {
      const i = r.inbox.findIndex((x) => x.id === inboxDel[1]);
      if (i >= 0) r.inbox.splice(i, 1);
      return send(res, 204);
    }
    if (rest.startsWith("message")) {
      const order = q.get("order") ?? "asc";
      const list = order === "asc" ? s.messages : [...s.messages].reverse();
      const start = Number(q.get("cursor") ?? 0);
      const limit = Number(q.get("limit") ?? 100);
      const page = list.slice(start, start + limit);
      return send(res, 200, { data: page, cursor: start + limit < list.length ? { next: String(start + limit) } : {} });
    }
    if (rest === "permission" && m === "GET") return send(res, 200, { data: [...r.pending.values()].filter((x) => x.request).map((x) => x.request) });
    const perm = /^permission\/(.+)\/reply$/.exec(rest);
    if (perm) {
      const body = await readBody(req);
      const pending = r.pending.get(perm[1]);
      if (!pending) return send(res, 404, { message: "Permission not found" });
      r.pending.delete(perm[1]);
      state.replies.push({ kind: "permission", decision: body.decision, message: body.message ?? null });
      save();
      emit("permission.replied", { sessionID: s.id, requestID: perm[1], reply: body.decision }, s.location.directory);
      pending.resolve(body.decision);
      return send(res, 204);
    }
    if (rest === "form" && m === "GET") return send(res, 200, { data: [...r.pending.values()].filter((x) => x.form).map((x) => x.form) });
    const formReply = /^form\/(.+?)(\/reply)?$/.exec(rest);
    if (formReply) {
      const pending = r.pending.get(formReply[1]);
      if (!pending) return send(res, 404, { message: "Form not found" });
      r.pending.delete(formReply[1]);
      if (formReply[2]) {
        const body = await readBody(req);
        state.replies.push({ kind: "form", answer: body.answer });
        save();
        emit("form.replied", { id: formReply[1], sessionID: s.id, answer: body.answer }, s.location.directory);
        pending.resolve(body.answer);
      } else {
        state.replies.push({ kind: "form", cancelled: true });
        save();
        emit("form.cancelled", { id: formReply[1], sessionID: s.id }, s.location.directory);
        pending.resolve(null);
      }
      return send(res, 204);
    }
    if (rest === "model") {
      const body = await readBody(req);
      const previous = s.model;
      s.model = { variant: "default", ...body.model };
      save();
      emit("session.model.selected", { sessionID: s.id, model: s.model, previous }, s.location.directory);
      return send(res, 204);
    }
    if (rest === "fork") {
      const body = await readBody(req);
      const cut = body.before ? s.messages.findIndex((x) => x.id === body.before) : s.messages.length;
      const fid = id("ses");
      const now = Date.now();
      state.sessions[fid] = { ...info(s), id: fid, title: `${s.title} (fork)`, time: { created: now, updated: now }, messages: s.messages.slice(0, cut < 0 ? s.messages.length : cut) };
      save();
      return send(res, 200, { data: info(state.sessions[fid]) });
    }
    if (rest === "revert/stage") {
      const body = await readBody(req);
      s.revert = { messageID: body.messageID, files: [] };
      return send(res, 200, { data: s.revert });
    }
    if (rest === "revert/commit") {
      const cut = s.messages.findIndex((x) => x.id === s.revert?.messageID);
      if (cut >= 0) s.messages = s.messages.slice(0, cut);
      emit("session.revert.committed", { sessionID: s.id, to: s.revert?.messageID }, s.location.directory);
      delete s.revert;
      save();
      return send(res, 204);
    }
    if (rest === "compact") {
      void (async () => {
        emit("session.execution.started", { sessionID: s.id });
        emit("session.compaction.started", { sessionID: s.id, reason: "manual" }, s.location.directory);
        await sleep(delay * 4);
        s.messages.push({ id: id("msg"), type: "compaction", time: { created: Date.now() }, status: "completed", reason: "manual", summary: "## Objective\n- tests" });
        save();
        emit("session.compaction.ended", { sessionID: s.id, reason: "manual", text: "## Objective" }, s.location.directory);
        emit("session.execution.succeeded", { sessionID: s.id });
      })();
      return send(res, 200, { data: {} });
    }
    return send(res, 404, { message: `no route ${m} ${p}` });
  } catch (error) {
    return send(res, 500, { message: String(error) });
  }
});

server.listen(0, "127.0.0.1", () => {
  console.log(`server listening on http://127.0.0.1:${server.address().port}`);
});
process.on("SIGTERM", () => {
  for (const res of streams) res.end();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
});
