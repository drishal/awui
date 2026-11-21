// The leader's relay of one remote task (P1): a PeerLiveChat over a hand-built
// PeerConnection, whose far side is a canned in-process worker — a real RpcPeer
// answering the task.* methods and pushing task.event notifications. What is
// under test is the relay's own contract with the Chat and the Orchestrator:
// events arrive in sequence order (a reconnecting stream can never fold the
// same answer twice), a request is answerable exactly while it is pending, a
// lost link ends an open run with fatal + settled, and the methods map to the
// wire calls the worker promises.
import { describe, expect, it } from "vitest";
import type { ChatConfig, InteractionAnswer } from "../../src/shared/protocol.js";
import type { HarnessEvent } from "../../src/server/harness/types.js";
import { PeerConnection } from "../../src/server/mesh/manager.js";
import { PeerLiveChat } from "../../src/server/mesh/peer-adapter.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { memoryLink } from "../../src/server/mesh/transport.js";

const CONFIG: ChatConfig = { model: null, thinkingLevel: null, models: [], thinkingLevels: [] };

/**
 * The far side of one task, scripted: task.open answers a remote id, task.prompt
 * records what it was handed, task.answer records the id it was asked to resolve,
 * and `emit` is how the test plays the worker's event stream.
 */
function cannedWorker() {
  const pair = memoryLink();
  const rpc = new RpcPeer(pair.server.input, pair.server.output, { role: "server" });
  const prompts: Array<{ text: string; mode: string }> = [];
  const answers: Array<{ requestId: string }> = [];
  const configPatches: Array<Record<string, unknown>> = [];
  let aborts = 0;
  let closes = 0;
  rpc.onRequest(async (method, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "task.open") return { remoteTaskId: "rt_1", config: CONFIG };
    if (method === "task.prompt") {
      if (p.text === "deny me") throw new MeshRpcError(MeshErrorCode.denied, "the policy refuses this prompt", { code: "denied" });
      prompts.push({ text: String(p.text), mode: String(p.mode) });
      return {};
    }
    if (method === "task.answer") {
      answers.push({ requestId: String(p.requestId) });
      return {};
    }
    if (method === "task.abort") {
      aborts += 1;
      return {};
    }
    if (method === "task.close") {
      closes += 1;
      return {};
    }
    if (method === "task.config") {
      if (p.patch !== undefined) configPatches.push(p.patch as Record<string, unknown>);
      return CONFIG;
    }
    if (method === "task.history") return [];
    throw new MeshRpcError(MeshErrorCode.method_not_found, `no handler answers "${method}"`, { code: "method_not_found" });
  });
  rpc.start();

  let seq = 0;
  return {
    rpc,
    /** The leader's side of the same pipes, for the connection built over this worker. */
    link: pair.client,
    /** One task.event notification for the open task, at the sequence number given. */
    emit: (event: HarnessEvent, at?: number) => {
      seq += 1;
      rpc.notify("task.event", { remoteTaskId: "rt_1", seq: at ?? seq, event });
    },
    prompts,
    answers,
    configPatches,
    get aborts() {
      return aborts;
    },
    get closes() {
      return closes;
    },
  };
}

/**
 * A live connection whose far side is the canned worker, without a PeerManager (the
 * relay under test is the connection, not the cache). The client RpcPeer is real, so
 * requests and notifications cross the memory link exactly as they cross ssh stdio.
 */
function connection(worker: ReturnType<typeof cannedWorker>): { conn: PeerConnection; client: RpcPeer } {
  const client = new RpcPeer(worker.link.input, worker.link.output, { role: "client" });
  client.start();
  const conn = new PeerConnection(
    () => undefined,
    "lab-vm",
    Buffer.alloc(32),
    "123 456",
    true,
    "worker",
    client,
    () => {
      client.close("killed by the test");
      worker.rpc.close("killed by the test");
    },
  );
  return { conn, client };
}

/** A request event the worker might raise, with the id and title the card shows. */
const requestEvent = (id: string): HarnessEvent => ({
  type: "request",
  request: { id, kind: "select", title: "Pick one", options: ["a", "b"], createdAt: Date.now() },
});

async function openLive(worker = cannedWorker()) {
  const { conn } = connection(worker);
  const live = new PeerLiveChat(conn, "lab-vm", "rt_1", CONFIG);
  return { worker, conn, live };
}

describe("PeerLiveChat", () => {
  it("relays the worker's events in order and keeps the session and title", async () => {
    const { worker, live } = await openLive();
    const seen: HarnessEvent[] = [];
    live.subscribe((event) => seen.push(event));
    worker.emit({ type: "session", nativeId: "native-9" });
    worker.emit({ type: "title", title: "A remote title" });
    worker.emit({ type: "busy" });
    worker.emit({ type: "assistant_start" });
    worker.emit({ type: "settled" });
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.map((e) => e.type)).toEqual(["session", "title", "busy", "assistant_start", "settled"]);
    expect(live.nativeId).toBe("native-9");
    expect(live.title).toBe("A remote title");
    await live.dispose();
  });

  it("drops duplicate and out-of-order sequence numbers", async () => {
    const { worker, live } = await openLive();
    const seen: string[] = [];
    live.subscribe((event) => seen.push(event.type));
    worker.emit({ type: "session", nativeId: "s1" }); // seq 1
    worker.emit({ type: "busy" }, 2);
    worker.emit({ type: "assistant_start" }, 2); // duplicate: dropped
    worker.emit({ type: "assistant_delta", field: "text", delta: "x" }, 1); // late: dropped
    worker.emit({ type: "settled" }, 3);
    await new Promise((r) => setTimeout(r, 5));
    expect(seen).toEqual(["session", "busy", "settled"]);
    await live.dispose();
  });

  it("answers a request exactly while its id is pending", async () => {
    const { worker, live } = await openLive();
    const answer: InteractionAnswer = { kind: "select", value: "a" };
    // Nobody asked yet: an answer for an unknown id is false, and nothing crosses the link.
    expect(live.answer("r1", answer)).toBe(false);
    expect(worker.answers).toEqual([]);
    worker.emit(requestEvent("r1"));
    worker.emit(requestEvent("r2"));
    await new Promise((r) => setTimeout(r, 5));
    expect(live.answer("r2", answer)).toBe(true);
    expect(live.answer("r2", answer)).toBe(false); // already being answered
    expect(live.answer("nope", answer)).toBe(false);
    await new Promise((r) => setTimeout(r, 5));
    expect(worker.answers).toEqual([{ requestId: "r2" }]);
    // A cancelled request is no longer pending either.
    worker.emit({ type: "request_cancelled", requestId: "r1", outcome: "cancelled" });
    await new Promise((r) => setTimeout(r, 5));
    expect(live.answer("r1", answer)).toBe(false);
    await live.dispose();
  });

  it("ends an open run with fatal and settled when the link is lost", async () => {
    const { worker, live } = await openLive();
    const seen: HarnessEvent[] = [];
    live.subscribe((event) => seen.push(event));
    worker.rpc.close("the worker went away");
    await new Promise((r) => setTimeout(r, 5));
    expect(seen.map((e) => e.type)).toEqual(["fatal", "settled"]);
    expect(seen[0]).toMatchObject({ type: "fatal", message: "link to lab-vm lost" });
  });

  it("maps the chat's calls to the worker's task methods", async () => {
    const { worker, live } = await openLive();
    await live.prompt("do the work");
    await live.steer("actually, this");
    await live.followUp("and then that");
    await live.abort();
    await live.setConfig({ model: "fake/slow" });
    const history = await live.history();
    expect(worker.prompts).toEqual([
      { text: "do the work", mode: "prompt" },
      { text: "actually, this", mode: "steer" },
      { text: "and then that", mode: "followUp" },
    ]);
    expect(worker.aborts).toBe(1);
    // Model and thinking cross the wire; a permission mode never does (the worker's policy is the ceiling).
    expect(worker.configPatches).toEqual([{ model: "fake/slow" }]);
    await live.setConfig({ model: "fake/slow", thinkingLevel: "high" });
    expect(worker.configPatches[1]).toEqual({ model: "fake/slow", thinkingLevel: "high" });
    expect(history).toEqual([]);
    expect(await live.getContextUsage()).toBeNull();
    expect(await live.getUsage()).toBeNull();
    expect(await live.getTodos()).toEqual([]);
    expect(await live.listCommands()).toEqual([]);
    await live.dispose();
    expect(worker.closes).toBe(1);
  });

  it("surfaces the far side's errors with their message, and a dead link does not fail dispose", async () => {
    const { worker, live } = await openLive();
    await expect(live.prompt("deny me")).rejects.toThrow(/the policy refuses this prompt/);
    // A prompt with images is refused here rather than silently dropped on the worker.
    await expect(live.prompt("with a picture", [{ mimeType: "image/png", data: "AAAA" }])).rejects.toThrow(/cannot take image attachments/);
    worker.rpc.close("gone");
    await new Promise((r) => setTimeout(r, 5));
    await expect(live.dispose()).resolves.toBeUndefined();
  });

  it("refuses image attachments the wire has no channel for", async () => {
    const { live } = await openLive();
    await expect(live.prompt("x", [{ mimeType: "image/png", data: "AAAA" }])).rejects.toThrow(/cannot take image attachments/);
    await live.dispose();
  });
});
