// acp-flow: live assistant text for DeepSeek Harness's ACP profile. DSH's
// stock bridge (@deepseek-ai/dsh-acp) sends only committed messages, one burst
// per model step, while the agent loop already publishes every provider delta
// in-process as `agent/assistant-stream`. This Cordis plugin takes the bridge's
// place in the profile and runs the stock bridge, unchanged, inside it: it hands
// the bridge its own message stream (the bridge's typed `config.stream`
// transport override) and owns the one stdout writer itself, so it can put the
// live frames on the same ordered wire as the bridge's own updates.
//
// awui loads it per child with a `--patch` overlay that disables the stock `acp`
// row and inserts this one with the row's own inject and config. Nothing in the
// profile is installed or changed, and the bridge is imported from the profile
// it would have been loaded from (Cordis's baseUrl is the profile folder).
//
// On the wire, standard updates stay exactly as the bridge sends them, so the
// stream is still valid ACP for any client. The live frames are an extension
// notification (ACP reserves `_`-prefixed methods; clients ignore ones they do
// not know):
//
//   {"method":"_acp-flow/assistant_stream","params":{"sessionId", "type", "attemptId", ...}}
//     type "start"            an attempt began (turn, step)
//     type "text"|"thinking"  one provider delta (text)
//     type "end"              outcome "message" (the committed assistant message follows),
//                             "attempt" (a failed try DSH recorded and may retry), or "abandoned"
//
// The initialize response gains `agentCapabilities._meta["acp-flow"]`, so a
// client knows from the handshake that the committed chunks it will also get
// repeat text it was already streamed. Frames go only for sessions this
// connection opened (learned from session/new and session/resume on the
// wire), never for a subagent's agent. Tool-call deltas stay off: tool rows
// come from the committed calls, as before.

import { createRequire } from "node:module";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

export const name = "acp-flow";

/** The extension notification carrying live frames. */
export const FLOW_METHOD = "_acp-flow/assistant_stream";
/** The initialize response's capability marker, under agentCapabilities._meta. */
export const FLOW_META = "acp-flow";
const FLOW_VERSION = 1;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** The stock bridge, resolved from the profile folder the loader anchors this plugin at. */
async function loadBridge(baseUrl) {
  const anchor = new URL("package.json", baseUrl ?? pathToFileURL(`${process.cwd()}/`));
  const file = createRequire(anchor).resolve("@deepseek-ai/dsh-acp");
  return import(pathToFileURL(file).href);
}

/**
 * One live frame as the wire carries it, or null for frames that stay off
 * (tool-call deltas, block markers, usage, finish).
 */
export function slimFrame(frame) {
  if (!isObj(frame) || typeof frame.attemptId !== "string") return null;
  const attemptId = frame.attemptId;
  if (frame.type === "start") return { type: "start", attemptId, turn: frame.turn, step: frame.step };
  if (frame.type === "chunk") {
    const chunk = isObj(frame.chunk) ? frame.chunk : {};
    if (typeof chunk.text !== "string" || chunk.text === "") return null;
    if (chunk.type === "text-delta") return { type: "text", attemptId, text: chunk.text };
    if (chunk.type === "reasoning-delta") return { type: "thinking", attemptId, text: chunk.text };
    return null;
  }
  if (frame.type === "end") {
    const outcome = isObj(frame.outcome) ? frame.outcome : {};
    if (outcome.kind === "committed") return { type: "end", attemptId, outcome: outcome.eventType === "assistant/message" ? "message" : "attempt" };
    return { type: "end", attemptId, outcome: "abandoned" };
  }
  return null;
}

/**
 * Mount the bridge on a message stream over `io` and add the live frames to it.
 * Split from `apply` so a test can drive it with its own ctx, bridge, and pipes.
 * @param ctx - the Cordis context the bridge and the stream listener mount on.
 * @param config - the stock row's config, passed through unchanged.
 * @param bridge - the @deepseek-ai/dsh-acp module (`apply`, `inject`).
 * @param io - `input` (JSON lines from the client) and `output` (JSON lines to it).
 */
export function flow(ctx, config, bridge, io) {
  ctx.plugin({
    name: "acp",
    inject: bridge.inject,
    apply(child) {
      const sessions = new Set();
      /** The client's requests the bridge has not answered yet, by id: method and the session they name. */
      const asked = new Map();
      const write = (message) => {
        io.output.write(`${JSON.stringify(message)}\n`);
      };

      const noteIncoming = (message) => {
        if (!isObj(message) || typeof message.method !== "string" || message.id === undefined) return;
        const params = isObj(message.params) ? message.params : {};
        const sessionId = typeof params.sessionId === "string" ? params.sessionId : null;
        if (asked.size > 1000) asked.clear();
        asked.set(message.id, { method: message.method, sessionId });
        // A resume can start autonomous work before its response goes out.
        if (message.method === "session/resume" && sessionId) sessions.add(sessionId);
      };

      const noteOutgoing = (message) => {
        if (!isObj(message) || message.method !== undefined || message.id === undefined) return message;
        const request = asked.get(message.id);
        if (!request) return message;
        asked.delete(message.id);
        if (message.error !== undefined) {
          if (request.method === "session/resume" && request.sessionId) sessions.delete(request.sessionId);
          return message;
        }
        const result = isObj(message.result) ? message.result : {};
        if (request.method === "session/new" && typeof result.sessionId === "string") sessions.add(result.sessionId);
        if (request.method === "session/close" && request.sessionId) sessions.delete(request.sessionId);
        if (request.method === "initialize") {
          const capabilities = isObj(result.agentCapabilities) ? result.agentCapabilities : {};
          const meta = isObj(capabilities._meta) ? capabilities._meta : {};
          return { ...message, result: { ...result, agentCapabilities: { ...capabilities, _meta: { ...meta, [FLOW_META]: { version: FLOW_VERSION } } } } };
        }
        return message;
      };

      let lines;
      const readable = new ReadableStream({
        start(controller) {
          lines = readline.createInterface({ input: io.input, crlfDelay: Infinity });
          lines.on("line", (line) => {
            if (!line.trim()) return;
            let message;
            try {
              message = JSON.parse(line);
            } catch {
              return;
            }
            noteIncoming(message);
            controller.enqueue(message);
          });
          lines.on("close", () => {
            try {
              controller.close();
            } catch {
              // Already closed by a cancel.
            }
          });
        },
        cancel() {
          lines?.close();
        },
      });
      // The bridge's writes and the live frames share one writer, so every line is whole and in order.
      const writable = new WritableStream({
        write(message) {
          write(noteOutgoing(message));
        },
      });

      // A regular function: Cordis binds the scoped Agent as `this`, and the payload names it too.
      child.on("agent/assistant-stream", function (payload) {
        const agent = payload?.agent ?? this;
        const sessionId = agent?.session?.id;
        if (typeof sessionId !== "string" || !sessions.has(sessionId)) return;
        const frame = slimFrame(payload?.frame);
        if (frame) write({ jsonrpc: "2.0", method: FLOW_METHOD, params: { sessionId, ...frame } });
      });

      bridge.apply(child, { ...config, stream: { readable, writable } });
    },
  });
}

export async function apply(ctx, config) {
  const bridge = await loadBridge(ctx.baseUrl);
  flow(ctx, config ?? {}, bridge, { input: process.stdin, output: process.stdout });
}
