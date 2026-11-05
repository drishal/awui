// extensions/acp-flow.mjs without DSH: its `flow` core mounted on a stand-in
// Cordis context, a stand-in bridge that echoes what the real one would send,
// and two pipes for stdio. The real bridge and loop are checked by hand
// against an installed DSH (see the plugin's header); these pin the wiring:
// the bridge's traffic passes through untouched, the handshake gains the mark,
// and live frames go only for sessions this connection opened.
import { PassThrough } from "node:stream";
import path from "node:path";
import readline from "node:readline";
import { describe, expect, it } from "vitest";

type Message = Record<string, unknown>;
type Listener = (this: unknown, payload: unknown) => void;
interface FlowModule {
  name: string;
  FLOW_METHOD: string;
  slimFrame(frame: unknown): Message | null;
  flow(ctx: unknown, config: unknown, bridge: unknown, io: { input: NodeJS.ReadableStream; output: NodeJS.WritableStream }): void;
}

const pluginFile = path.join(import.meta.dirname, "..", "..", "extensions", "acp-flow.mjs");
const load = async () => (await import(pluginFile)) as FlowModule;

/** Mount the plugin with a bridge whose outgoing messages the test sends by hand. */
async function mount(config: Message = { provider: "deepseek-official", model: "deepseek-v4-flash" }) {
  const mod = await load();
  const listeners = new Map<string, Listener>();
  const child = { on: (event: string, fn: Listener) => listeners.set(event, fn) };
  const ctx = {
    plugin(plugin: { name: string; inject: unknown; apply: (c: unknown) => void }) {
      expect(plugin).toMatchObject({ name: "acp", inject: ["agents", "llm"] });
      plugin.apply(child);
    },
  };
  const received: Message[] = [];
  let bridgeConfig: Message = {};
  let writer: WritableStreamDefaultWriter<Message> | null = null;
  const bridge = {
    inject: ["agents", "llm"],
    apply(_child: unknown, cfg: Message) {
      bridgeConfig = cfg;
      const stream = cfg.stream as { readable: ReadableStream<Message>; writable: WritableStream<Message> };
      writer = stream.writable.getWriter();
      void (async () => {
        for await (const message of stream.readable as unknown as AsyncIterable<Message>) received.push(message);
      })();
    },
  };
  const input = new PassThrough();
  const output = new PassThrough();
  const lines: Message[] = [];
  readline.createInterface({ input: output }).on("line", (line) => lines.push(JSON.parse(line) as Message));
  mod.flow(ctx, config, bridge, { input, output });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  return {
    mod,
    lines,
    received,
    config: () => bridgeConfig,
    /** A client line in. */
    send: async (message: Message) => {
      input.write(`${JSON.stringify(message)}\n`);
      await tick();
    },
    /** The bridge writing one message out. */
    reply: async (message: Message) => {
      await writer?.write(message);
      await tick();
    },
    /** The loop publishing one frame for an agent, as Cordis would call the listener. */
    publish: async (agent: unknown, frame: unknown, bound?: unknown) => {
      listeners.get("agent/assistant-stream")?.call(bound, agent === undefined ? { frame } : { agent, frame });
      await tick();
    },
  };
}

const agent = (id: string) => ({ session: { id } });
const live = (lines: Message[]) => lines.filter((m) => m.method === "_acp-flow/assistant_stream").map((m) => m.params);

describe("acp-flow (the DSH plugin, without DSH)", () => {
  it("hands the bridge its row config and a message stream, and passes both directions through", async () => {
    const flow = await mount();
    expect(flow.config()).toMatchObject({ provider: "deepseek-official", model: "deepseek-v4-flash" });
    await flow.send({ jsonrpc: "2.0", id: 1, method: "session/list", params: {} });
    expect(flow.received).toEqual([{ jsonrpc: "2.0", id: 1, method: "session/list", params: {} }]);
    await flow.reply({ jsonrpc: "2.0", id: 1, result: { sessions: [] } });
    await flow.reply({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } });
    expect(flow.lines).toEqual([
      { jsonrpc: "2.0", id: 1, result: { sessions: [] } },
      { jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } } } },
    ]);
  });

  it("marks the initialize response, keeping what the bridge put in _meta", async () => {
    const flow = await mount();
    await flow.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: 1 } });
    await flow.reply({ jsonrpc: "2.0", id: 1, result: { protocolVersion: 1, agentCapabilities: { loadSession: false, _meta: { other: true } } } });
    expect(flow.lines[0]).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { protocolVersion: 1, agentCapabilities: { loadSession: false, _meta: { other: true, "acp-flow": { version: 1 } } } },
    });
  });

  it("streams only sessions this connection opened, and stops after a close or a failed resume", async () => {
    const flow = await mount();
    const chunk = (text: string) => ({ type: "chunk", attemptId: "a:1", revision: 1, index: 0, time: 0, chunk: { type: "text-delta", text } });
    // Before session/new answers, nothing is this connection's.
    await flow.publish(agent("s1"), chunk("early"));
    await flow.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: { cwd: "/p", mcpServers: [] } });
    await flow.reply({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1" } });
    await flow.publish(agent("s1"), chunk("one"));
    // A subagent runs its own Agent and Session: not on this wire.
    await flow.publish(agent("sub-1"), chunk("sub"));
    // A resume counts from the request (work can start before the answer), and is dropped if it fails.
    await flow.send({ jsonrpc: "2.0", id: 2, method: "session/resume", params: { sessionId: "s2", cwd: "/p" } });
    await flow.publish(agent("s2"), chunk("two"));
    await flow.reply({ jsonrpc: "2.0", id: 2, error: { code: -32602, message: "no" } });
    await flow.publish(agent("s2"), chunk("gone"));
    await flow.send({ jsonrpc: "2.0", id: 3, method: "session/close", params: { sessionId: "s1" } });
    await flow.reply({ jsonrpc: "2.0", id: 3, result: {} });
    await flow.publish(agent("s1"), chunk("closed"));
    expect(live(flow.lines)).toEqual([
      { sessionId: "s1", type: "text", attemptId: "a:1", text: "one" },
      { sessionId: "s2", type: "text", attemptId: "a:1", text: "two" },
    ]);
  });

  it("finds the agent on `this` when the payload does not name it", async () => {
    const flow = await mount();
    await flow.send({ jsonrpc: "2.0", id: 1, method: "session/new", params: {} });
    await flow.reply({ jsonrpc: "2.0", id: 1, result: { sessionId: "s1" } });
    await flow.publish(undefined, { type: "start", attemptId: "s1:1", revision: 1, turn: 1, step: 1 }, agent("s1"));
    expect(live(flow.lines)).toEqual([{ sessionId: "s1", type: "start", attemptId: "s1:1", turn: 1, step: 1 }]);
  });

  it("words each frame for the wire and leaves tool-call deltas and markers off", async () => {
    const { slimFrame } = await load();
    const chunk = (inner: Message) => ({ type: "chunk", attemptId: "a", revision: 2, index: 0, time: 0, chunk: inner });
    expect(slimFrame(chunk({ type: "text-delta", text: "x" }))).toEqual({ type: "text", attemptId: "a", text: "x" });
    expect(slimFrame(chunk({ type: "reasoning-delta", text: "y" }))).toEqual({ type: "thinking", attemptId: "a", text: "y" });
    expect(slimFrame(chunk({ type: "tool-call-delta", id: "c", argumentsDelta: "{" }))).toBeNull();
    expect(slimFrame(chunk({ type: "block-start" }))).toBeNull();
    expect(slimFrame(chunk({ type: "text-delta", text: "" }))).toBeNull();
    const end = (outcome: Message) => ({ type: "end", attemptId: "a", revision: 3, index: 1, outcome });
    expect(slimFrame(end({ kind: "committed", eventType: "assistant/message", seq: 9 }))).toEqual({ type: "end", attemptId: "a", outcome: "message" });
    expect(slimFrame(end({ kind: "committed", eventType: "assistant/attempt", seq: 9 }))).toEqual({ type: "end", attemptId: "a", outcome: "attempt" });
    expect(slimFrame(end({ kind: "abandoned" }))).toEqual({ type: "end", attemptId: "a", outcome: "abandoned" });
    expect(slimFrame({ type: "chunk" })).toBeNull();
  });
});
