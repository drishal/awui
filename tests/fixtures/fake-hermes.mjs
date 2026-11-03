#!/usr/bin/env node
// Scripted `tui_gateway.entry` for adapter tests: newline-delimited JSON-RPC on
// stdio, the shapes the real gateway speaks. Prompt text selects behaviour —
// the same scenario set as the pi fake (src/server/harness/fake.ts):
//   "tool"  run a fake tool            "ask"    raise an approval request first
//   "ask twice"  two approval requests at once (stacked approvals)
//   "fail"  end the turn with an error "slow"   stream many chunks
//   "big"   oversized tool output          "edit"  edit a file (src/app.ts)
//   "vanish"  the turn stops on a fallback model with no message.complete
//   "wait"  a provider-wait line on the status line (thinking.delta)
//   "echoed"  the "💭 **Reasoning:**" block Hermes prepends when show_reasoning is on
//   "moa"  reference advice and an aggregator handoff, as a MoA turn emits
// Every turn starts with the gateway's spinner frame on the status line, as the real one does.
// Session rows for projects.tree/list come from FAKE_HERMES_STATE (JSON file).
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const stateFile = process.env.FAKE_HERMES_STATE;
const out = (frame) => process.stdout.write(`${JSON.stringify(frame)}\n`);
const ok = (id, result) => out({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => out({ jsonrpc: "2.0", id, error: { code, message } });
const event = (type, payload, sessionId = runtimeId) =>
  out({ jsonrpc: "2.0", method: "event", params: { type, session_id: sessionId, ...(payload === undefined ? {} : { payload }) } });

const storedId = "20261002_120000_fake1";
const RESUME_PARAMS = new Set(["session_id", "profile", "cols", "source", "lazy", "defer_history", "omit_messages", "eager_build", "close_on_disconnect", "inline_images"]);
let runtimeId = "4242";
let title = "Fake Hermes session";
let multimodel = false;
let proxied = false;
let moaTurn = false;
let model = "fake-model";
let provider = "fake";
let effort = "medium";
let aborted = false;
let turns = 0;
const messages = [];
let rowIds = 100;
const approvals = [];

const state = () => {
  try {
    const raw = JSON.parse(readFileSync(stateFile, "utf8"));
    return { rows: Array.isArray(raw?.rows) ? raw.rows : [], spawns: Array.isArray(raw?.spawns) ? raw.spawns : [], cwd: typeof raw?.cwd === "string" ? raw.cwd : "", moa: raw?.moa === true };
  } catch {
    return { rows: [], spawns: [], cwd: "" };
  }
};
// Written whole and renamed into place: a test (or another fake) reading it meanwhile sees the old state or the new, never an empty file.
const persist = (patch) => {
  if (!stateFile) return;
  const temp = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify({ ...state(), ...patch }));
  renameSync(temp, stateFile);
};

persist({ spawns: [...state().spawns, { cwd: process.cwd(), args: process.argv.slice(2) }] });

// FAKE_HERMES_REFUSE: the home it names is owned by a running gateway, so this
// entry point exits 1 with the refusal on stderr and nothing on stdout — the
// shape tui_gateway/entry.py's _claim_launch_home has (recorded from it).
if (process.env.FAKE_HERMES_REFUSE) {
  process.stderr.write(`[gateway-exit] refused: ${process.env.FAKE_HERMES_REFUSE} is owned by a running gateway; attach to it instead\n`);
  process.exit(1);
}

event("gateway.ready", { skin: { name: "fake" }, change_events: true, replay_epoch: "test-epoch" }, "");

function emitUsage() {
  return { model: "fake-model", input: 900, output: 12, reasoning: 3, total: 912, calls: turns, context_used: 1200, context_max: 200000, context_percent: 1, cache_read: 300, cache_write: 0 };
}

async function runPrompt(text) {
  aborted = false;
  const sessionId = runtimeId;
  event("session.info", { model, provider, reasoning_effort: effort, running: true, title, stored_session_id: storedId });
  event("message.start", undefined, sessionId);
  event("thinking.delta", { text: "(´･_･`) musing..." }, sessionId);
  if (moaTurn || provider === "moa") {
    // As the real gateway's MoA facade: two references advise, then the aggregator takes over.
    event("moa.progress", { label: "opencode-go:glm-5.3-flash", refs_done: 1, refs_total: 2 }, sessionId);
    event("moa.reference", { label: "opencode-go:glm-5.3-flash", index: 1, count: 2, text: "## Advice one\n\nUse `cache` for repeats." }, sessionId);
    event("moa.progress", { label: "opencode-go:deepseek-v4.1-flash", refs_done: 2, refs_total: 2 }, sessionId);
    event("moa.reference", { label: "opencode-go:deepseek-v4.1-flash", index: 2, count: 2, text: "- fast\n- cheap" }, sessionId);
    event("moa.phase", { phase: "aggregator", refs_done: 2, refs_total: 2, aggregator: "opencode-go:glm-5.3" }, sessionId);
    event("moa.aggregating", { aggregator: "opencode-go:glm-5.3" }, sessionId);
    moaTurn = false;
  }
  if (/\bwait\b/.test(text)) {
    event("thinking.delta", { text: "Waiting for the provider (5s)..." }, sessionId);
    await new Promise((r) => setTimeout(r, 150));
  }
  if (/\bask\b/.test(text)) {
    // "ask twice" raises both requests before awaiting (stacked approvals).
    const count = /\btwice\b/.test(text) ? 2 : 1;
    const answers = Array.from({ length: count }, (_, i) => {
      const requestId = `req-${approvals.length + 1}`;
      approvals.push(requestId);
      const { promise, resolve } = Promise.withResolvers();
      pendingApprovals.set(`srq-${requestId}`, resolve);
      out({
        jsonrpc: "2.0",
        id: `srq-${requestId}`,
        method: "approval",
        params: { session_id: sessionId, request_id: requestId, command: i === 0 ? "rm -rf /tmp/x" : "cat /etc/secrets", description: i === 0 ? "Delete a scratch tree" : "Read a secret file", choices: ["once", "session", "always", "deny"], tool_name: "terminal" },
      });
      return promise;
    });
    await Promise.all(answers);
    event("tool.start", { tool_id: "t-approval", name: "terminal", args: { command: "rm -rf /tmp/x" } });
    event("tool.complete", { tool_id: "t-approval", name: "terminal", result: "removed", summary: "rm -rf /tmp/x" });
  }
  if (/\btool\b|\bbig\b/.test(text)) {
    const big = /\bbig\b/.test(text);
    event("tool.start", { tool_id: "t1", name: "read", args: { path: "README.md" } });
    event("tool.complete", { tool_id: "t1", name: "read", result: { content: [{ type: "text", text: big ? "x".repeat(200_000) : "file.txt" }] } });
  }
  if (/\bedit\b/.test(text)) {
    event("tool.start", { tool_id: "t2", name: "edit", args: { path: `${process.cwd()}/src/app.ts`, oldText: "a", newText: "b" } });
    event("tool.complete", { tool_id: "t2", name: "edit", result: { content: [{ type: "text", text: "Edited src/app.ts (+1 -1)" }] } });
  }
  let body = "";
  // "whoami": say which provider the request went to (a model switch must move it).
  const chunks = /\bslow\b/.test(text) ? ["a", "b", "c", "d", "e"] : /\bwhoami\b/.test(text) ? [`on ${provider} as ${model}`] : [`hermes says ${text}`];
  for (const chunk of chunks) {
    if (aborted) break;
    await new Promise((r) => setTimeout(r, 5));
    body += chunk;
    event("reasoning.delta", { text: "hmm " }, sessionId);
    event("message.delta", { text: chunk }, sessionId);
  }
  if (/\bvanish\b/.test(text)) {
    // A reclaimed turn: only session.info says it stopped (and on which model).
    event("session.info", { model: "fake-fallback", provider: "fake", reasoning_effort: effort, running: false, title, stored_session_id: storedId });
    return;
  }
  if (/\bmultimodel\b/.test(text)) {
    // A gateway configured with several providers: model arrives already qualified
    // and the catalog lists two providers under the same slug (local + remote custom).
    multimodel = true;
    provider = "custom";
    model = "local/opencode-go-v4-flash";
    event("session.info", { model: "local/opencode-go-v4-flash", provider: "custom", reasoning_effort: effort, running: false, title, stored_session_id: storedId, usage: emitUsage() });
    const now = Date.now() / 1000;
    messages.push({ role: "user", text, timestamp: now, row_id: ++rowIds });
    messages.push({ role: "assistant", text: body, reasoning: "hmm", timestamp: now });
    return;
  }
  if (/\bproxied\b/.test(text)) {
    // A pick on a provider the gateway serves through a proxy: session info afterwards
    // names the proxy (the real Hermes answers "litellm/x" for a pick on opencode-go).
    proxied = true;
  }
  turns += 1;
  const failed = /\bfail\b/.test(text);
  // As the real gateway delivers a turn on a surface with show_reasoning on: the thought is
  // prepended to the text (gateway/run_turn_persistence.py's _hmwa_prepend_reasoning) and the
  // payload carries its own copy too. Stored rows stay clean.
  const delivered = /\bechoed\b/.test(text) ? `💭 **Reasoning:**\n\`\`\`\n${body}, thought about\n\`\`\`\n\n${body}` : body;
  event("message.complete", { text: delivered, status: aborted ? "interrupted" : failed ? "error" : "complete", ...(failed ? { error: "fake failure" } : {}), reasoning: "hmm ", usage: emitUsage() }, sessionId);
  event("session.info", { model, provider, reasoning_effort: effort, running: false, title, stored_session_id: storedId, usage: emitUsage() });
  const now = Date.now() / 1000;
  messages.push({ role: "user", text, timestamp: now, row_id: ++rowIds });
  // Stored tool rows: the shape session.history returns (no args here, so `context` names the target).
  if (/\btool\b/.test(text)) messages.push({ role: "tool", name: "read", tool_call_id: "t1", content: "file.txt", context: "README.md", timestamp: now });
  messages.push({ role: "assistant", text: body, reasoning: "hmm", timestamp: now });
}

const pendingApprovals = new Map();
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let frame;
  try {
    frame = JSON.parse(line);
  } catch {
    return;
  }
  // A response to one of our server→client requests (approval).
  if (frame.method === undefined && frame.id !== undefined && pendingApprovals.size > 0) {
    const resolve = pendingApprovals.get(String(frame.id)) ?? pendingApprovals.values().next().value;
    if (resolve) {
      for (const [key, done] of pendingApprovals) {
        if (done === resolve) {
          pendingApprovals.delete(key);
          break;
        }
      }
      approvals.push(`answered:${frame.result?.choice ?? "?"}`);
      resolve();
    }
    return;
  }
  const { id, method, params = {} } = frame;
  switch (method) {
    case "ping":
      return ok(id, { pong: true });
    case "gateway.capabilities":
      return ok(id, { per_session_exclusive_submit: true });
    case "client.capabilities":
      return ok(id, { server_requests: ["approval", "clarify"], declines_not_shown: true });
    case "session.create":
      runtimeId = "4242";
      title = params.title ?? title;
      // The row keeps the session's folder, as the store does: a later connection resumes it.
      persist({ cwd: params.cwd ?? process.cwd() });
      return ok(id, { session_id: runtimeId, stored_session_id: storedId, message_count: 0, messages: [], info: { model, provider: "fake", reasoning_effort: effort, title, cwd: params.cwd ?? process.cwd(), stored_session_id: storedId, running: false, lazy: true } });
    case "session.resume": {
      // 0.22.2's contract refuses any key it does not declare (tui_gateway/contracts/registry.py).
      const extra = Object.keys(params).find((key) => !RESUME_PARAMS.has(key));
      if (extra) return fail(id, 4000, `invalid params for session.resume: ${extra}: Extra inputs are not permitted`);
      runtimeId = "4242";
      if (params.session_id !== storedId && params.session_id !== title) return fail(id, 4006, "session not found");
      // As 0.22.2 answers a lazy resume: the stored id only as `resumed`, none in the reply or its info.
      return ok(id, { session_id: runtimeId, resumed: storedId, session_key: storedId, message_count: messages.length, messages, status: "idle", running: false, info: { model, provider: "fake", reasoning_effort: effort, title, cwd: state().cwd || process.cwd(), running: false, lazy: true } });
    }
    case "session.history":
      return ok(id, { count: messages.length, messages });
    case "session.title":
      if (params.title) {
        title = params.title;
        event("session.title", { session_id: storedId, title });
      }
      return ok(id, { title });
    case "session.interrupt":
      aborted = true;
      for (const resolve of pendingApprovals.values()) resolve();
      pendingApprovals.clear();
      return ok(id, { status: "interrupted", interrupted: true });
    case "session.compress":
      return ok(id, { status: "compressed", removed: 2, before_messages: 10, after_messages: 8 });
    case "session.close":
      runtimeId = "";
      return ok(id, { closed: true });
    // "/" commands as the gateway runs them: slash.exec answers built-ins, sends skills to command.dispatch.
    case "complete.slash":
      return ok(id, {
        items: [
          { text: "/status", display: "/status", meta: "Show session status", kind: "command" },
          { text: "/review", display: "/review", meta: "Review the work so far", kind: "skill" },
          { text: "/moa", display: "/moa", meta: "Run one prompt through the default Mixture of Agents preset, then restore your model (usage: /moa <prompt>)", kind: "command" },
        ],
      });
    case "slash.exec":
      if (String(params.command).startsWith("/status")) return ok(id, { output: "hermes status: fine" });
      // A pending-input built-in: the gateway answers with the prompt to submit, not output.
      const moa = /^\/moa(?:\s|$)/.exec(String(params.command));
      if (moa) {
        const arg = String(params.command).slice(4).trim();
        if (!arg) return fail(id, 4004, "MoA usage: /moa <prompt>");
        moaTurn = true;
        return ok(id, { type: "send", notice: "MoA one-shot queued with preset default; previous model will be restored after this turn.", message: arg });
      }
      return fail(id, 4018, "skill command: use command.dispatch");
    case "command.dispatch":
      if (params.name === "review") return ok(id, { type: "skill", name: "review", message: `Review: ${params.arg || "everything"}` });
      if (params.name === "moa") {
        const arg = String(params.arg || "").trim();
        if (!arg) return fail(id, 4004, "MoA usage: /moa <prompt>");
        moaTurn = true;
        return ok(id, { type: "send", notice: "MoA one-shot queued with preset default; previous model will be restored after this turn.", message: arg });
      }
      return fail(id, 4018, `not a quick/plugin/bundle/skill command: ${params.name}`);
    case "prompt.submit": {
      // Hermes Desktop's edit: cut before a stored user row, only when confirmed.
      const cutRow = params.truncate_before_row_id;
      if (cutRow !== undefined || params.truncate_before_user_ordinal !== undefined) {
        if (params.confirm_truncate !== true) return fail(id, 4029, "truncation parameters require confirm_truncate=true");
        const at = messages.findIndex((m) => m.role === "user" && m.row_id === cutRow);
        if (at < 0) return fail(id, 4018, "target row_id not found");
        if (at === 0 && params.confirm_empty_truncate !== true) return fail(id, 4028, "truncation would erase the entire session transcript");
        messages.splice(at);
      }
      ok(id, { status: "streaming" });
      void runPrompt(String(params.text ?? ""));
      return;
    }
    case "image.attach_bytes":
      return ok(id, { attached: true, count: 1, name: params.filename ?? "pasted.png" });
    case "config.set":
      if (params.key === "model") {
        // As the real gateway: `<model> --provider <slug>` switches both; without
        // --provider the provider stays and the whole value is the model's name.
        const [, name, slug] = /^(\S+)(?:\s+--provider\s+(\S+))?$/.exec(String(params.value).trim()) ?? [];
        model = name ?? String(params.value);
        // A proxied provider: the switch lands, but from here on session info names the proxy,
        // as the real Hermes does when opencode-go rides on its LiteLLM client.
        provider = proxied && slug === "opencode-go" ? "litellm" : (slug ?? provider);
        event("session.info", { model, provider, reasoning_effort: effort, running: false, stored_session_id: storedId, title });
        return ok(id, { key: "model", value: params.value });
      }
      if (params.key === "reasoning") {
        effort = String(params.value);
        // As tui_gateway's session info does: the level the route's clamp sends (no wire takes "ultra").
        const wire = effort === "none" ? "" : effort === "ultra" ? "max" : effort;
        event("session.info", { model, provider, reasoning_effort: effort, reasoning_effort_wire: wire, running: false, stored_session_id: storedId, title });
        return ok(id, { key: "reasoning", value: params.value });
      }
      // The owner's session flag (gateway/session_busy_controls.py): not an effort, and not a config write.
      if (params.key === "show_reasoning") {
        const on = ["1", "on", "true"].includes(String(params.value).trim().toLowerCase());
        return ok(id, { key: "show_reasoning", value: on ? "1" : "0", scope: "session" });
      }
      return fail(id, 4002, `unknown config key: ${params.key}`);
    case "model.options": {
      // Hermes's virtual MoA provider, when the config enables a preset (a test sets state().moa).
      const moaRow = state().moa
        ? [{ slug: "moa", name: "Mixture of Agents", models: ["default"], source: "virtual", authenticated: true, auth_type: "virtual", is_current: false, capabilities: { default: { reasoning: true } } }]
        : [];
      return ok(id, multimodel
        ? {
            providers: [
              ...moaRow,
              { slug: "local", name: "Local", models: ["opencode-go-v4-flash", "glm-local"], capabilities: { "opencode-go-v4-flash": { reasoning: true } }, authenticated: true, is_user_defined: true },
              { slug: "remote", name: "Remote", models: ["opencode-go-v4-flash", "opus-4-1"], capabilities: {}, authenticated: true, is_user_defined: true },
            ],
            model: "local/opencode-go-v4-flash",
          }
        : {
            providers: [
              ...moaRow,
              { slug: "fake", name: "Fake", models: ["fake-model", "fake-mini"], capabilities: { "fake-model": { reasoning: true, fast: false }, "fake-mini": { reasoning: false, fast: true } }, authenticated: true, is_current: true },
              ...(proxied ? [{ slug: "opencode-go", name: "OpenCode Go", models: ["deepseek-v4.1-flash"], capabilities: {}, authenticated: true }] : []),
            ],
            model: "fake-model",
            provider: "fake",
          });
    }
    case "projects.tree":
      return ok(id, {
        projects: [
          {
            id: "p1",
            label: "proj",
            path: process.cwd(),
            previewSessions: state().rows,
          },
        ],
        active_id: "p1",
      });
    default:
      return fail(id, -32601, `unknown method: ${method}`);
  }
});
process.stdin.on("end", () => process.exit(0));
