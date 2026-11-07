#!/usr/bin/env node
// A scripted Hermes gateway for attach tests. It serves the two things a client needs
// to attach — the home's control socket (`identify`, `session-ticket`) and the
// `/api/ws` JSON-RPC transport, admitted by a ticket subprotocol — and puts one
// scripted `tui_gateway` child (fake-hermes.mjs, the same scripts) behind each
// connection. So a test drives the real client path without a real Hermes:
// identify → ticket → upgrade → frames.
//
// Usage: fake-hermes-gateway.mjs <home>   (prints "ready" on stdout once listening;
// FAKE_HERMES_STATE is passed to the child, as the stdio fake reads it.)
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

const home = process.argv[2];
if (!home) throw new Error("usage: fake-hermes-gateway.mjs <home>");

const instanceId = process.env.FAKE_HERMES_INSTANCE ?? "fake-instance";
const tickets = new Map();
const controlPath = path.join(home, "gateway.sock");

/**
 * What the client sent over the canonical wire, one array in `FAKE_HERMES_STATE.canonical.json`
 * (its own file: the stdio fake under this gateway rewrites the state file for its rows and
 * spawns, and sharing one would let either writer clobber the other's last entries).
 */
const record = (name, params) => {
  const stateFile = process.env.FAKE_HERMES_STATE;
  if (!stateFile) return;
  const file = `${stateFile}.canonical.json`;
  let calls = [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (Array.isArray(parsed)) calls = parsed;
  } catch {
    // No recording yet.
  }
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify([...calls, { name, params }]));
  renameSync(temp, file);
};

// ── WebSocket, server side (RFC 6455), text frames only ──────────────────────
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const acceptKey = (key) => createHash("sha1").update(`${key}${GUID}`).digest("base64");

function frame(text) {
  const payload = Buffer.from(text, "utf8");
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  if (payload.length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(payload.length), 2);
  return Buffer.concat([header, payload]);
}

/** Frames a client sends, one message at a time (masked, unfragmented). */
function readFrames(onMessage, onClose) {
  let buffer = Buffer.alloc(0);
  return (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      const maskLength = masked ? 4 : 0;
      if (buffer.length < offset + maskLength + length) return;
      const mask = buffer.subarray(offset, offset + maskLength);
      const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
      buffer = buffer.subarray(offset + maskLength + length);
      if (masked) for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      if (opcode === 0x8) return onClose();
      if (opcode === 0x9) continue; // ping: the client keeps its own time
      if (opcode !== 0x1) continue;
      onMessage(payload.toString("utf8"));
    }
  };
}

// ── The gateway ─────────────────────────────────────────────────────────────
const server = createServer((_req, res) => {
  res.writeHead(404);
  res.end();
});

server.on("upgrade", (req, socket) => {
  const protocols = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const ticket = protocols.find((value) => value.startsWith("hermes-gateway-ticket."))?.slice("hermes-gateway-ticket.".length);
  const grant = ticket ? tickets.get(ticket) : undefined;
  if (req.url !== "/api/ws" || !protocols.includes("hermes-gateway-v1") || !grant) {
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
    return;
  }
  tickets.delete(ticket); // single use, as the real one is
  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(String(req.headers["sec-websocket-key"] ?? ""))}`,
      "Sec-WebSocket-Protocol: hermes-gateway-v1",
      "",
      "",
    ].join("\r\n"),
  );

  // The session RPC behind this connection: the stdio fake, with the canonical
  // session wire translated onto its stdio dialect both ways — the inverse of
  // src/server/harness/hermes-canonical.ts, in the shapes gateway/session_contract.py
  // declares. What the client sends is recorded in FAKE_HERMES_STATE under
  // `canonical`, so a test can assert exactly what went over the wire.
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "fake-hermes.mjs")], { env: { ...process.env }, stdio: ["pipe", "pipe", "pipe"] });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    lines.close();
    child.kill("SIGTERM");
    try {
      socket.destroy();
    } catch {
      // Already gone.
    }
  };
  const send = (obj) => {
    if (open) socket.write(frame(JSON.stringify(obj)));
  };
  const calls = new Map(); // child request id -> { clientId, wrap }
  const prompts = new Map(); // canonical prompt_id -> { legacyId, kind, qid, need, answers }
  const session = { sessionId: "", cwd: "", revision: 0, generation: 0, next: 0 };
  const callChild = (clientId, method, params, wrap = (result) => result) => {
    const childId = `c${++session.next}`;
    calls.set(childId, { clientId, wrap });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: childId, method, params })}\n`);
  };
  const mutateResult = (params, result) => {
    session.revision += 1;
    return { session_id: params.session_id, operation: params.operation, revision: session.revision, execution_generation: session.generation, ...(result ?? {}) };
  };
  // The real gateway's resume: stored rows keep text in `content` (tools as `tool_name`),
  // and `display_messages` is the TUI projection (`text`/`name`/`args`, no tool output).
  // The stdio child speaks the old shape; rewrite when the client asked for the projection,
  // which is what a chat's resume does.
  const canonicalHistory = (rows) => ({
    messages: rows.map((row) => ({
      role: row.role,
      content: row.content !== undefined ? row.content : (row.text ?? ""),
      ...(row.tool_call_id ? { tool_call_id: row.tool_call_id, tool_name: row.name } : {}),
      ...(row.reasoning ? { reasoning: row.reasoning } : {}),
      ...(row.row_id != null ? { row_id: row.row_id } : {}),
      ...(row.timestamp != null ? { timestamp: row.timestamp } : {}),
    })),
    display_messages: rows.map((row) => ({
      role: row.role,
      ...(row.timestamp != null ? { timestamp: row.timestamp } : {}),
      ...(row.row_id != null ? { row_id: row.row_id } : {}),
      ...(row.role === "tool"
        ? { name: row.name, context: row.context, tool_call_id: row.tool_call_id, args: row.args ?? {} }
        : { text: row.text ?? "", ...(row.reasoning ? { reasoning: row.reasoning } : {}) }),
    })),
  });
  const snapshot = (legacy, params = {}) => {
    session.sessionId = legacy.session_id ?? session.sessionId;
    session.revision += 1;
    const history = params.display_projection ? canonicalHistory(legacy.messages ?? []) : { messages: legacy.messages ?? [] };
    return {
      session_id: session.sessionId,
      stored_session_id: legacy.stored_session_id ?? legacy.resumed ?? session.sessionId,
      ...history,
      message_count: legacy.message_count ?? (legacy.messages ?? []).length,
      running: legacy.running === true || legacy.info?.running === true,
      authority_epoch: 1,
      replay_epoch: "fake-epoch",
      last_sequence: 0,
      subscription_id: `sub-${session.next}`,
      revision: session.revision,
      execution_generation: session.generation,
      pending: [],
      prompts: [],
      // The owner reports the session's own folder (the child only knows its process cwd).
      info: { desktop_protocol: "hermes-gateway-v1", ...(legacy.info ?? {}), ...(session.cwd ? { cwd: session.cwd } : {}) },
    };
  };
  // As the real owner: the receipt answers while the prompt is queued, so it names the generation as it is; the
  // generation moves when the prompt starts running (hermes_state_runtime.py), which its events then carry.
  const admission = (params) => {
    return { admission_id: params.input_id ?? `adm-${session.generation}`, ref: { profile_id: home, session_id: session.sessionId }, sequence: session.generation, status: "queued", outcome: null, authority_epoch: 1, execution_generation: session.generation };
  };
  const handleResult = () => ({ ref: { profile_id: home, session_id: session.sessionId }, instance_id: instanceId, authority_epoch: 1, revision: session.revision, execution_generation: session.generation, execution_state: "idle" });

  const handle = (msg) => {
    const { id, method, params = {} } = msg;
    record(method, params);
    switch (method) {
      case "runtime.describe":
        return send({
          jsonrpc: "2.0",
          id,
          result: {
            instance_id: instanceId,
            profile_id: home,
            authority_epoch: 1,
            capabilities: ["session-authority-v1", "event-replay-v1"],
            session_create: { sources: ["cli", "tui", "gui"], parameters: ["request_id", "source", "cwd", "title", "model", "provider", "reasoning", "toolsets", "skills", "max_turns", "client_env"] },
          },
        });
      case "session.create":
        session.cwd = params.cwd ?? session.cwd;
        return callChild(id, "session.create", { cwd: params.cwd, title: params.title }, snapshot);
      case "session.resume":
        // The real gateway's refusal for a session it lists but will not mount (source webui).
        if (params.session_id === "refused-webui") return send({ jsonrpc: "2.0", id, error: { code: 4001, message: "not_found", data: { reason: "not_found" } } });
        return callChild(id, "session.resume", { session_id: params.session_id, source: params.source }, (legacy) => snapshot(legacy, params));
      case "prompt.submit":
        // "silentrename": another viewer renames the session and its session.updated never reaches this client,
        // so the revision this client holds is stale without it knowing.
        if (/\bsilentrename\b/.test(String(params.text ?? ""))) session.revision += 1;
        return callChild(id, "prompt.submit", { session_id: params.session_id, text: params.text, queued: params.queued }, () => admission(params));
      // gateway/session_busy_controls.py::correct: a closed parameter set (no input id) and an integer
      // generation fence, which must be the running execution's. Anything else is refused.
      case "session.steer": {
        const closed = new Set(["session_id", "profile", "text", "execution_generation"]);
        if (Object.keys(params).some((key) => !closed.has(key)) || typeof params.text !== "string" || !params.text.trim() || !Number.isInteger(params.execution_generation)) {
          return send({ jsonrpc: "2.0", id, error: { code: 4002, message: "invalid_params", data: { reason: "invalid_params" } } });
        }
        if (params.execution_generation !== session.generation) {
          return send({ jsonrpc: "2.0", id, error: { code: 4009, message: "stale_generation", data: { reason: "stale_generation", execution_generation: session.generation } } });
        }
        return callChild(id, "session.steer", { session_id: params.session_id, text: params.text }, (result) => ({ ...result, execution_generation: session.generation, authority_epoch: 1 }));
      }
      case "session.interrupt":
        return callChild(id, "session.interrupt", { session_id: params.session_id }, handleResult);
      case "session.detach":
        return send({ jsonrpc: "2.0", id, result: { session_id: params.session_id, subscription_id: params.subscription_id, detached: true } });
      case "approval.respond": {
        const prompt = prompts.get(params.prompt_id);
        if (prompt) settle(prompt, { choice: params.choice });
        return send({ jsonrpc: "2.0", id, result: { status: "resolved", prompt_id: params.prompt_id } });
      }
      case "clarify.respond": {
        const prompt = prompts.get(params.prompt_id);
        if (prompt) settle(prompt, { [prompt.qid]: params.answer });
        return send({ jsonrpc: "2.0", id, result: { status: "resolved", prompt_id: params.prompt_id } });
      }
      case "session.mutate": {
        const payload = params.payload ?? {};
        // The owner's fences (hermes_state_runtime.mutate_runtime_session): a stale revision or generation is refused,
        // and the refusal names the current ones.
        const stale = params.expected_revision !== session.revision ? "revision_conflict" : params.expected_generation !== undefined && params.expected_generation !== session.generation ? "stale_generation" : null;
        if (stale) return send({ jsonrpc: "2.0", id, error: { code: 4009, message: stale, data: { reason: stale, revision: session.revision, execution_generation: session.generation } } });
        const wrapped = (result) => mutateResult(params, result);
        if (params.operation === "rename") return callChild(id, "session.title", { session_id: params.session_id, title: payload.title }, wrapped);
        if (params.operation === "model") {
          const value = payload.provider ? `${payload.model} --provider ${payload.provider}` : payload.model;
          // The real reply projects the route now in force (gateway/session_mutation_model.py).
          return callChild(id, "config.set", { session_id: params.session_id, key: "model", value }, (result) => mutateResult(params, { ...result, model: payload.model, ...(payload.provider ? { provider: payload.provider } : {}) }));
        }
        if (params.operation === "reasoning") return callChild(id, "config.set", { session_id: params.session_id, key: "reasoning", value: payload.effort }, wrapped);
        if (params.operation === "compress") return callChild(id, "session.compress", { session_id: params.session_id, ...(payload.focus ? { focus_topic: payload.focus } : {}) }, wrapped);
        // rewind is a receipt here; the child cuts its transcript through its own
        // truncate path, which the stdio adapter tests already cover.
        return send({ jsonrpc: "2.0", id, result: mutateResult(params, {}) });
      }
      default:
        return callChild(id, method, params);
    }
  };

  const settle = (prompt, answer) => {
    if (prompt.kind === "approval") {
      prompts.delete([...prompts].find(([key, value]) => value === prompt)?.[0] ?? "");
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: prompt.legacyId, result: answer })}\n`);
      return;
    }
    Object.assign(prompt.answers, answer);
    if (Object.keys(prompt.answers).length < prompt.need) return;
    for (const [key, value] of prompts) if (value === prompt) prompts.delete(key);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: prompt.legacyId, result: { answers: prompt.answers } })}\n`);
  };

  // The scripts' server→client requests become the canonical wire's prompt events.
  const promptEvent = (msg) => {
    const params = msg.params ?? {};
    if (msg.method === "approval") {
      const promptId = `p-${++session.next}`;
      prompts.set(promptId, { legacyId: msg.id, kind: "approval" });
      send({ jsonrpc: "2.0", method: "event", params: { type: "approval.request", session_id: session.sessionId, payload: { prompt_id: promptId, execution_generation: session.generation, choices: params.choices, command: params.command, description: params.description, tool_name: params.tool_name } } });
      return;
    }
    const questions = Array.isArray(params.questions) ? params.questions : [];
    for (const question of questions) {
      const qid = String(question.qid ?? "q");
      const promptId = `p-${++session.next}:${qid}`;
      prompts.set(promptId, { legacyId: msg.id, kind: "clarify", qid, need: questions.length, answers: {} });
      send({ jsonrpc: "2.0", method: "event", params: { type: "clarify.request", session_id: session.sessionId, payload: { prompt_id: promptId, execution_generation: session.generation, question: question.question, choices: question.choices, multi_select: question.multi_select } } });
    }
  };

  lines.on("line", (line) => {
    if (!open || !line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.method && msg.id !== undefined && (msg.method === "approval" || msg.method === "clarify")) return promptEvent(msg);
    const pending = msg.id !== undefined ? calls.get(String(msg.id)) : undefined;
    if (pending) {
      calls.delete(String(msg.id));
      send(msg.error ? { jsonrpc: "2.0", id: pending.clientId, error: msg.error } : { jsonrpc: "2.0", id: pending.clientId, result: pending.wrap(msg.result ?? {}) });
      return;
    }
    // A turn starting is the queued prompt starting to run: the generation moves, and the execution's events carry it.
    if (msg.method === "event" && msg.params) {
      if (msg.params.type === "message.start") session.generation += 1;
      msg.params.execution_generation = session.generation;
    }
    send(msg);
  });
  child.once("exit", () => {
    if (!open) return;
    open = false;
    try {
      socket.end(Buffer.from([0x88, 0x00])); // a close frame, then the socket
    } catch {
      // Already gone.
    }
  });
  socket.on("data", readFrames((text) => {
    try {
      handle(JSON.parse(text));
    } catch {
      // Not a frame we understand; the real owner would answer invalid_params.
    }
  }, close));
});

// ── The control socket: identify, session-ticket ─────────────────────────────
const control = net.createServer((peer) => {
  let data = "";
  peer.on("data", (chunk) => {
    data += chunk.toString("utf8");
    const end = data.indexOf("\n");
    if (end < 0) return;
    let request = {};
    try {
      request = JSON.parse(data.slice(0, end));
    } catch {
      // Answered below as an unknown verb.
    }
    const reply = (result, error) =>
      peer.end(`${JSON.stringify({ ok: error === undefined, protocol: 1, id: request.id ?? 1, ...(error === undefined ? { result } : { error }) })}\n`);
    if (request.verb === "identify") reply(identify());
    else if (request.verb === "session-ticket") {
      const params = request.params ?? {};
      if (params.instance_id !== instanceId || params.purpose !== "interactive" || params.profile_id !== home) reply(undefined, "invalid bootstrap parameters");
      else {
        const ticket = randomBytes(32).toString("base64url");
        tickets.set(ticket, { profileId: params.profile_id, instanceId });
        reply({ ticket, expires_in_seconds: 30, instance_id: instanceId, profile_id: params.profile_id, runtime_protocol: 1 });
      }
    } else reply(undefined, `unknown verb: ${String(request.verb)}`);
  });
  peer.on("error", () => undefined);
});

function identify() {
  const port = server.address()?.port ?? 0;
  return {
    runtime_protocol: 1,
    state: "ready",
    served_profiles: [{ profile_id: home, home }],
    capabilities: ["session-authority-v1", "event-replay-v1"],
    authority_epoch: 1,
    instance_id: instanceId,
    api_origin: `http://127.0.0.1:${port}`,
    supervisor: "none",
    code_version: "1.2.3",
    code_sha: "fakesha1234",
  };
}

server.listen(0, "127.0.0.1", () => {
  try {
    unlinkSync(controlPath);
  } catch {
    // Nothing stale there.
  }
  control.listen(controlPath, () => {
    process.on("exit", () => {
      try {
        unlinkSync(controlPath);
      } catch {
        // Already gone.
      }
    });
    console.log("ready");
  });
});
