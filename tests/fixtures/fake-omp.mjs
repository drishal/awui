#!/usr/bin/env node
// Scripted stand-in for the `omp` binary: speaks the rpc-ui JSON-lines
// protocol and ACP session/list closely enough to exercise the omp adapter.
// Prompt text selects behaviour — the same scenario set as the pi fake
// (src/server/harness/fake.ts):
//   "tool"  run a fake tool          "ask"   raise an approval request first
//   "ask twice"  two approval requests at once (stacked approvals)
//   "fail"  end the turn with an error "slow"  stream many chunks
//   "big"   oversized tool output         "edit"  edit a file (src/app.ts)
// State lives in $FAKE_OMP_STATE (JSON) so separate processes share sessions.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import readline from "node:readline";

const args = process.argv.slice(2);
const statePath = process.env.FAKE_OMP_STATE;

function load() {
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return { sessions: {}, spawns: [] };
  }
}
function save(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2));
}
// Like omp: protocol v1 caps a frame at 1 MiB (an oversized response fails);
// after negotiate_protocol 2, an oversized frame goes out as rpc_chunk slices.
let protocol = 1;
const MAX_FRAME_BYTES = 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;
const out = (frame) => {
  const json = JSON.stringify(frame);
  const bytes = Buffer.from(json, "utf8");
  if (bytes.length + 1 <= MAX_FRAME_BYTES) return process.stdout.write(`${json}\n`);
  if (protocol === 2) {
    const chunkId = randomUUID();
    const count = Math.ceil(bytes.length / CHUNK_BYTES);
    for (let index = 0; index < count; index++) {
      const data = bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64");
      process.stdout.write(`${JSON.stringify({ type: "rpc_chunk", chunkId, index, count, byteLength: bytes.length, data })}\n`);
    }
    return;
  }
  if (frame.type === "response") {
    process.stdout.write(`${JSON.stringify({ id: frame.id, type: "response", command: frame.command, success: false, error: "RPC response exceeded the transport limit" })}\n`);
  }
};
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args[0] === "--version") {
  console.log("omp/18.4.10");
  process.exit(0);
}

// `omp session lease --json -- <id>...`, as omp 18.18.6 prints it. $FAKE_OMP_HELD names the
// sessions "another omp" holds (comma-separated); every other id is simply not held.
if (args[0] === "session" && args[1] === "lease") {
  const held = new Set((process.env.FAKE_OMP_HELD ?? "").split(",").filter(Boolean));
  const ids = args.slice(args.indexOf("--") + 1);
  console.log(JSON.stringify({ held: ids.filter((id) => held.has(id)), unknown: [] }));
  process.exit(0);
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));

if (args[0] === "acp") {
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") out({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1, agentCapabilities: {} } });
    else if (msg.method === "session/list") {
      const state = load();
      const sessions = Object.entries(state.sessions)
        .filter(([, s]) => (!msg.params.cwd || s.cwd === msg.params.cwd) && s.messages.length > 0)
        // Like omp: no title field at all when the session never got one.
        .map(([id, s]) => ({ sessionId: id, cwd: s.cwd, ...(s.title ? { title: s.title } : {}), updatedAt: new Date().toISOString(), _meta: { messageCount: s.messages.length } }));
      out({ jsonrpc: "2.0", id: msg.id, result: { sessions } });
    } else out({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } });
  });
} else {
  const cwd = flag("--cwd");
  const known = ["read", "grep", "glob", "bash", "edit", "ask"];
  const toolsFlag = flag("--tools");
  for (const tool of toolsFlag ? toolsFlag.split(",") : []) {
    if (!known.includes(tool)) {
      console.error(`Error: Unknown tool in --tools: ${tool}.\nRun \`omp --help\` for available flags.`);
      process.exit(2);
    }
  }
  const resume = flag("--resume");
  const state = load();
  state.spawns.push({ args, envPiDir: process.env.PI_CODING_AGENT_DIR ?? null });
  let sessionId = resume;
  if (resume && !state.sessions[resume]) {
    console.error(`Session "${resume}" not found.`);
    process.exit(1);
  }
  if (!sessionId) sessionId = randomUUID();
  if (!state.sessions[sessionId]) state.sessions[sessionId] = { cwd, title: "", messages: [] };
  save(state);
  if (process.env.FAKE_OMP_CRASH_ON_START) process.exit(3);

  const session = () => load().sessions[sessionId];
  const persist = (message) => {
    const s = load();
    s.sessions[sessionId].messages.push(message);
    if (!s.sessions[sessionId].title && message.role === "user") s.sessions[sessionId].title = String(message.content).slice(0, 40);
    save(s);
  };
  const pendingUi = new Map();
  let aborted = false;
  let running = false;
  const ok = (id, command, data) => out({ id, type: "response", command, success: true, ...(data !== undefined ? { data } : {}) });
  const delay = (ms) => new Promise((r) => setTimeout(r, ms));

  async function runPrompt(id, message) {
    running = true;
    aborted = false;
    out({ type: "agent_start" });
    persist({ role: "user", content: message });
    out({ type: "message_start", messageId: "u", message: { role: "user", content: message } });
    if (/\bask\b/.test(message)) {
      // "ask twice" raises both requests before awaiting (stacked approvals).
      const count = /\btwice\b/.test(message) ? 2 : 1;
      const answers = await Promise.all(
        Array.from({ length: count }, (_, i) => {
          const uiId = randomUUID();
          const { promise, resolve } = Promise.withResolvers();
          pendingUi.set(uiId, resolve);
          out({ type: "extension_ui_request", id: uiId, method: "select", title: i === 0 ? "Allow tool: bash" : "Allow tool: read", options: ["Approve", "Deny"] });
          return promise;
        }),
      );
      if (answers.some((a) => a.value !== "Approve")) out({ type: "extension_ui_request", id: randomUUID(), method: "notify", message: "denied", notifyType: "warning" });
    }
    if (/\btool\b|\bbig\b/.test(message)) {
      const big = /\bbig\b/.test(message);
      out({ type: "tool_execution_start", toolCallId: "tc1", toolName: big ? "read" : "bash", args: big ? { path: "README.md" } : { command: "ls" } });
      out({ type: "tool_execution_end", toolCallId: "tc1", toolName: big ? "read" : "bash", result: { content: [{ type: "text", text: big ? "x".repeat(200_000) : "file.txt" }] }, isError: false });
    }
    if (/\bedit\b/.test(message)) {
      out({ type: "tool_execution_start", toolCallId: "tc2", toolName: "edit", args: { path: `${cwd ?? process.cwd()}/src/app.ts`, oldText: "a", newText: "b" } });
      out({ type: "tool_execution_end", toolCallId: "tc2", toolName: "edit", result: { content: [{ type: "text", text: "Edited src/app.ts (+1 -1)" }] }, isError: false });
    }
    out({ type: "message_start", messageId: "a", message: { role: "assistant", content: [], model: "m1" } });
    // "fail" ends the turn with an error instead of an answer.
    const failed = /\bfail\b/.test(message);
    let text = "";
    for (const chunk of failed ? [] : ["omp ", "says ", message]) {
      if (aborted) break;
      await delay(/\bslow\b/.test(message) ? 80 : 5);
      text += chunk;
      out({ type: "message_update", messageId: "a", message: {}, assistantMessageEvent: { type: "text_delta", delta: chunk } });
    }
    const usage = { input: 900, output: 12, cacheRead: 300, cacheWrite: 0 };
    const final = failed
      ? { role: "assistant", content: [], stopReason: "error", errorMessage: "Fake failure", model: "m1", usage }
      : { role: "assistant", content: [{ type: "text", text }], stopReason: aborted ? "aborted" : "stop", model: "m1", usage };
    persist(final);
    out({ type: "message_end", messageId: "a", message: final });
    out({ type: "prompt_result", id, agentInvoked: true, status: aborted ? "aborted" : "completed", sessionSettled: true });
    out({ type: "session_settled" });
    running = false;
  }

  rl.on("line", (line) => {
    const cmd = JSON.parse(line);
    switch (cmd.type) {
      case "negotiate_protocol":
        ok(cmd.id, cmd.type, { protocolVersion: 2 });
        protocol = 2;
        return;
      case "get_state": {
        const s = session();
        return ok(cmd.id, "get_state", {
          sessionId,
          sessionName: s.title || undefined,
          messageCount: s.messages.length,
          model: { provider: "fakeomp", id: "m1", name: "M1", reasoning: true },
          thinkingLevel: "low",
          isStreaming: running,
          isSettled: !running,
          dumpTools: (toolsFlag ? toolsFlag.split(",") : known).map((name) => ({ name, description: "" })),
          contextUsage: { tokens: 1200, contextWindow: 200000, percent: 0.6 },
          todoPhases: [{ name: "Plan", tasks: [{ content: "Inspect", status: "completed" }, { content: "Fix", status: "in_progress" }] }],
        });
      }
      case "get_available_models":
        return ok(cmd.id, "get_available_models", {
          models: [
            { provider: "fakeomp", id: "m1", name: "M1", reasoning: true, baseUrl: "http://secret", thinking: { mode: "effort", efforts: ["low", "high", "max"] } },
            { provider: "fakeomp", id: "org/m2", name: "M2" },
          ],
        });
      case "get_available_thinking_levels":
        return ok(cmd.id, "get_available_thinking_levels", { levels: ["off", "low", "high", "max"] });
      case "get_messages":
        return ok(cmd.id, "get_messages", { messages: session().messages });
      case "get_available_commands":
        // FAKE_OMP_CONTEXT=extension makes /context look like an extension command (not run locally).
        return ok(cmd.id, cmd.type, {
          commands: [
            { name: "context", description: "Show estimated context usage breakdown", source: process.env.FAKE_OMP_CONTEXT ?? "builtin" },
            { name: "usage", source: "builtin" },
            // Loaded with -e, as the adapter starts omp.
            ...(args.some((a) => a.endsWith("rewind-to.ts")) ? [{ name: "rewind-to", source: "extension" }] : []),
          ],
        });
      case "get_session_stats": {
        const m = session().messages;
        const count = (role) => m.filter((x) => x.role === role).length;
        const steps = count("assistant");
        return ok(cmd.id, cmd.type, {
          sessionId,
          userMessages: count("user"),
          assistantMessages: steps,
          tokens: { input: steps * 900, output: steps * 12, reasoning: 0, cacheRead: steps * 300, cacheWrite: 0, total: steps * 1212 },
          cost: 0.0042 * steps,
        });
      }
      case "prompt":
        if (cmd.message === "/context" && (process.env.FAKE_OMP_CONTEXT ?? "builtin") === "builtin") {
          out({
            type: "command_output",
            // Verbatim shape of omp 18.4.10's output, ANSI-coloured bars and all.
            text: [
              "Context window: 200000 tokens (1% used)",
              "  System prompt    [\x1b[38;2;124;111;100m░░░░░░░░░░░░░░░░░░░░░░░░\x1b[39m] 0%  1500 tokens",
              "  System tools     [\x1b[38;2;124;111;100m░░░░░░░░░░░░░░░░░░░░░░░░\x1b[39m] 2%  5200 tokens",
              "  Skills           [\x1b[38;2;124;111;100m░░░░░░░░░░░░░░░░░░░░░░░░\x1b[39m] 0%  300 tokens",
              "  Messages         [\x1b[38;2;124;111;100m░░░░░░░░░░░░░░░░░░░░░░░░\x1b[39m] 0%  527 tokens",
              "  Auto-compact buf [\x1b[38;2;124;111;100m████░░░░░░░░░░░░░░░░░░░░\x1b[39m] 15%  30000 tokens",
              "  Free             [\x1b[38;2;124;111;100m████████████████████░░░░\x1b[39m] 81%  162473 tokens",
            ].join("\n"),
          });
          return ok(cmd.id, "prompt", { agentInvoked: false });
        }
        // The rewind-to extension: back to just before the nth prompt; omp answers with a bare success.
        if (/^\/rewind-to \d+$/.test(cmd.message) && args.some((a) => a.endsWith("rewind-to.ts"))) {
          const n = Number(cmd.message.split(" ")[1]);
          const s = load();
          const m = s.sessions[sessionId].messages;
          let seen = 0;
          const at = m.findIndex((x) => x.role === "user" && ++seen === n);
          if (at >= 0) m.splice(at);
          save(s);
          return out({ id: cmd.id, type: "response", command: "prompt", success: true });
        }
        if (running) return out({ id: cmd.id, type: "response", command: "prompt", success: false, error: "busy" });
        ok(cmd.id, "prompt", { agentInvoked: true });
        void runPrompt(cmd.id, cmd.message);
        return;
      case "steer":
      case "follow_up":
        ok(cmd.id, cmd.type);
        return out({ type: "queue_update", steering: cmd.type === "steer" ? [cmd.message] : [], followUp: cmd.type === "follow_up" ? [cmd.message] : [] });
      case "remove_queued_message":
        return ok(cmd.id, cmd.type, { removed: true });
      case "abort":
        aborted = true;
        for (const [uiId, resolve] of pendingUi) {
          pendingUi.delete(uiId);
          out({ type: "extension_ui_request", id: randomUUID(), method: "cancel", targetId: uiId });
          resolve({ cancelled: true });
        }
        return ok(cmd.id, "abort");
      case "set_model": {
        const s = load();
        s.lastModel = `${cmd.provider}|${cmd.modelId}`;
        save(s);
        return ok(cmd.id, cmd.type);
      }
      case "set_thinking_level":
      case "set_session_name":
        return ok(cmd.id, cmd.type);
      case "compact":
        return ok(cmd.id, cmd.type, {});
      case "extension_ui_response": {
        const resolve = pendingUi.get(cmd.id);
        if (resolve) {
          pendingUi.delete(cmd.id);
          resolve(cmd);
        }
        return;
      }
      default:
        return out({ id: cmd.id, type: "response", command: cmd.type, success: false, error: `unknown ${cmd.type}` });
    }
  });
  out({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: "plan", statusText: "ready" });
  out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: process.env.FAKE_OMP_V1 ? [1] : [1, 2], maxFrameBytes: 1048576, maxReassembledFrameBytes: 67108864 });
}
