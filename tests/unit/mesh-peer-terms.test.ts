// The leader's end of remote terminals (P3 §1): a PeerTerminals hook and its
// PeerTerminal proxies, whose far side is a canned in-process worker — a real
// RpcPeer answering the term.* methods and pushing term.output / term.exit
// notifications, exactly as mesh-peer-adapter.test.ts scripts a task worker.
// What is under test is the proxy's contract with the routes that use it:
// create maps to term.open with the caller's cwd and dims, writes and resizes
// cross as term.input / term.resize, output and exit reach the subscriber with
// a replay for a late one, the last subscriber's leaving closes the terminal,
// and a dropped link reconnects with term.attach at the last seq seen —
// replaying what was missed once, and ending the stream as an exit when the
// terminal is gone. The TerminalManager hook gets its own block: a peer
// terminal is created, routed, and forgotten by id like a local one.
import { describe, expect, it } from "vitest";
import { ChatError } from "../../src/server/chats/chat.js";
import { PeerConnection } from "../../src/server/mesh/manager.js";
import { PeerTerminal, PeerTerminals } from "../../src/server/mesh/peer-terms.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { memoryLink } from "../../src/server/mesh/transport.js";
import type { PeerTerminalHandle, TerminalSubscriber } from "../../src/server/terminal.js";
import { TerminalManager } from "../../src/server/terminal.js";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";

const WS: WorkspaceInfo = { id: "ws-1", path: "/workspace/project", name: "project" };

/**
 * The far side of one terminal, scripted: term.open answers a term id,
 * term.input / term.resize / term.close record what they were handed, and
 * term.attach records the seq the leader had reached. `emit` and `exit` are
 * how the test plays the worker's output stream.
 */
function cannedWorker(over: { attach?: "ok" | "not-found"; termId?: string } = {}) {
  const termId = over.termId ?? "t_1";
  const pair = memoryLink();
  const rpc = new RpcPeer(pair.server.input, pair.server.output, { role: "server" });
  const opens: Array<{ cwd: string; cols: number; rows: number }> = [];
  const inputs: string[] = [];
  const resizes: Array<{ cols: number; rows: number }> = [];
  let closes = 0;
  let attachAfterSeq: number | null = null;
  rpc.onRequest(async (method, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "term.open") {
      opens.push({ cwd: String(p.cwd), cols: p.cols as number, rows: p.rows as number });
      return { termId };
    }
    if (method === "term.input") {
      inputs.push(Buffer.from(String(p.data), "base64").toString("utf8"));
      return {};
    }
    if (method === "term.resize") {
      resizes.push({ cols: p.cols as number, rows: p.rows as number });
      return {};
    }
    if (method === "term.close") {
      closes += 1;
      return {};
    }
    if (method === "term.attach") {
      if (over.attach === "not-found") throw new MeshRpcError(MeshErrorCode.not_found, `no terminal "${termId}" is open for this peer`, { code: "not_found" });
      attachAfterSeq = p.afterSeq as number;
      return { replayed: 0, gap: false };
    }
    throw new MeshRpcError(MeshErrorCode.method_not_found, `no handler answers "${method}"`, { code: "method_not_found" });
  });
  rpc.start();
  let seq = 0;
  return {
    rpc,
    /** The leader's side of the same pipes, for the connection built over this worker. */
    link: pair.client,
    /** One term.output for the open terminal, at the next (or given) sequence number. */
    emit: (data: string, at?: number) => {
      seq += 1;
      rpc.notify("term.output", { termId, seq: at ?? seq, data: Buffer.from(data, "utf8").toString("base64") });
    },
    /** The terminal's exit, as the worker reports it. */
    exit: (code: number, signal?: number) => rpc.notify("term.exit", { termId, code, ...(signal !== undefined ? { signal } : {}) }),
    opens,
    inputs,
    resizes,
    get closes() {
      return closes;
    },
    get attachAfterSeq() {
      return attachAfterSeq;
    },
  };
}

/** A live connection whose far side is the canned worker, without a PeerManager (the relay under test is the connection). */
function connection(worker: ReturnType<typeof cannedWorker>): PeerConnection {
  const client = new RpcPeer(worker.link.input, worker.link.output, { role: "client" });
  client.start();
  return new PeerConnection(
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
}

/** A reconnect plan that never sleeps and never gives up on its own, so a test drives the attempts. */
const FAST_PLAN = { schedule: [0], giveUpMs: 60_000, now: () => Date.now(), sleep: async () => undefined };

/** One subscriber that records what a proxy streamed to it. */
function subscriber(): TerminalSubscriber & { output: string[]; exits: { code: number; signal?: number }[] } {
  const made = {
    output: [] as string[],
    exits: [] as { code: number; signal?: number }[],
    onOutput: (data: string) => made.output.push(data),
    onExit: (code: number, signal?: number) => made.exits.push({ code, ...(signal !== undefined ? { signal } : {}) }),
  };
  return made;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("PeerTerminals (the hook)", () => {
  it("opens a terminal through the shared link and answers the peer-prefixed id", async () => {
    const worker = cannedWorker();
    const conn = connection(worker);
    const hook = new PeerTerminals({ manager: { connect: async () => conn, reconnectPlan: FAST_PLAN } });
    const opened = await hook.open("lab-vm", "/home/dev/project", 100, 30);
    expect(opened.id).toBe("peer:lab-vm:t_1");
    expect(worker.opens).toEqual([{ cwd: "/home/dev/project", cols: 100, rows: 30 }]);
    expect(typeof opened.createdAt).toBe("number");
  });

  it("refuses a worker that opens a terminal without an id", async () => {
    const pair = memoryLink();
    const rpc = new RpcPeer(pair.server.input, pair.server.output, { role: "server" });
    rpc.onRequest(async (method) => (method === "term.open" ? {} : { method }));
    rpc.start();
    const client = new RpcPeer(pair.client.input, pair.client.output, { role: "client" });
    client.start();
    const conn = new PeerConnection(() => undefined, "lab-vm", Buffer.alloc(32), "123 456", true, "worker", client, () => undefined);
    const hook = new PeerTerminals({ manager: { connect: async () => conn, reconnectPlan: FAST_PLAN } });
    await expect(hook.open("lab-vm", "/x", 100, 30)).rejects.toThrow(/without an id/);
  });
});

describe("PeerTerminal (the proxy)", () => {
  /** One proxy over one canned worker, whose reconnect target is whatever the test stages before the link drops. */
  function openTerminal(worker = cannedWorker()) {
    const conn = connection(worker);
    let next: ReturnType<typeof cannedWorker> | null = null;
    const terminal = new PeerTerminal(conn, "lab-vm", "t_1", {
      reconnect: async () => connection(next ?? worker),
      plan: FAST_PLAN,
    });
    return { worker, conn, terminal, stage: (replacement: ReturnType<typeof cannedWorker>) => void (next = replacement) };
  }

  it("carries writes and resizes, and streams output and exit to its subscriber", async () => {
    const { worker, terminal } = await openTerminal();
    const seen = subscriber();
    const off = terminal.subscribe(seen);
    worker.emit("chunk one");
    worker.emit("chunk two");
    await sleep(10);
    expect(seen.output).toEqual(["chunk one", "chunk two"]);
    terminal.write("typed");
    terminal.resize(120, 40);
    await sleep(10);
    expect(worker.inputs).toEqual(["typed"]);
    expect(worker.resizes).toEqual([{ cols: 120, rows: 40 }]);
    worker.exit(0);
    await sleep(10);
    expect(seen.exits).toEqual([{ code: 0 }]);
    off();
    // The exit already ended it: nothing is sent to a dead terminal.
    terminal.write("after the exit");
    await sleep(10);
    expect(worker.inputs).toEqual(["typed"]);
    expect(worker.closes).toBe(0);
  });

  it("replays its buffered output to a subscriber that arrives late, and closes when the last one leaves", async () => {
    const { worker, terminal } = await openTerminal();
    worker.emit("early frame");
    await sleep(10);
    const late = subscriber();
    const off = terminal.subscribe(late);
    expect(late.output).toEqual(["early frame"]);
    // The last watcher's leaving closes the terminal, exactly as a local one does.
    off();
    await sleep(10);
    expect(worker.closes).toBe(1);
  });

  it("closes on request, and when its last subscriber leaves", async () => {
    const a = await openTerminal();
    a.terminal.close();
    await sleep(10);
    expect(a.worker.closes).toBe(1);
    const gone: string[] = [];
    a.terminal.onGone(() => gone.push("gone"));
    expect(gone).toEqual(["gone"]);

    const b = await openTerminal();
    b.terminal.onGone(() => gone.push("gone-b"));
    const off = b.terminal.subscribe(subscriber());
    off();
    await sleep(10);
    expect(b.worker.closes).toBe(1);
    expect(gone).toEqual(["gone", "gone-b"]);
  });

  it("reconnects after a dropped link, attaches at the last seq, and never streams a frame twice", async () => {
    const { worker, terminal, stage } = await openTerminal();
    const seen = subscriber();
    terminal.subscribe(seen);
    worker.emit("first");
    await sleep(10);
    // The worker restarts its side of the world but keeps the terminal: its replay
    // re-sends the frame the leader already saw, then the stream goes live again.
    const second = cannedWorker();
    stage(second);
    worker.rpc.close("the ssh session ended");
    await sleep(30);
    expect(second.attachAfterSeq).toBe(1);
    second.emit("first", 1);
    second.emit("second", 2);
    await sleep(10);
    expect(seen.output).toEqual(["first", "second"]);
    terminal.write("over the fresh link");
    await sleep(10);
    expect(second.inputs).toEqual(["over the fresh link"]);
  });

  it("ends the stream as an exit when the reattached terminal is gone", async () => {
    const worker = cannedWorker();
    const conn = connection(worker);
    const seen = subscriber();
    const gone: string[] = [];
    const terminal = new PeerTerminal(conn, "lab-vm", "t_1", {
      reconnect: async () => connection(cannedWorker({ attach: "not-found" })),
      plan: FAST_PLAN,
    });
    terminal.subscribe(seen);
    terminal.onGone(() => gone.push("gone"));
    worker.emit("before the drop");
    await sleep(10);
    worker.rpc.close("the ssh session ended");
    await sleep(30);
    expect(seen.output).toEqual(["before the drop"]);
    expect(seen.exits).toEqual([{ code: -1 }]);
    expect(gone).toEqual(["gone"]);
  });

  it("ends the stream as an exit when no reconnect was wired", async () => {
    const worker = cannedWorker();
    const terminal = new PeerTerminal(connection(worker), "lab-vm", "t_1");
    const seen = subscriber();
    terminal.subscribe(seen);
    worker.rpc.close("no reconnect wiring");
    await sleep(10);
    expect(seen.exits).toEqual([{ code: -1 }]);
  });
});

describe("TerminalManager's peer hook", () => {
  /** A handle that records what the routes did to it, with subscribe semantics the proxy mirrors. */
  class RecordingHandle implements PeerTerminalHandle {
    readonly written: string[] = [];
    readonly resized: Array<{ cols: number; rows: number }> = [];
    closed = 0;
    private readonly goneListeners = new Set<() => void>();
    private readonly subscribers = new Set<TerminalSubscriber>();
    private replayText = "";
    private exitInfo: { code: number; signal?: number } | null = null;

    write(data: string): void {
      this.written.push(data);
    }

    resize(cols: number, rows: number): void {
      this.resized.push({ cols, rows });
    }

    close(): void {
      this.closed += 1;
      for (const listener of [...this.goneListeners]) listener();
    }

    subscribe(subscriber: TerminalSubscriber): () => void {
      this.subscribers.add(subscriber);
      if (this.replayText !== "") subscriber.onOutput(this.replayText);
      if (this.exitInfo !== null) subscriber.onExit(this.exitInfo.code, this.exitInfo.signal);
      return () => {
        this.subscribers.delete(subscriber);
        if (this.subscribers.size === 0) this.close();
      };
    }

    onGone(listener: () => void): void {
      this.goneListeners.add(listener);
    }

    /** The test plays the terminal. */
    emit(data: string): void {
      this.replayText += data;
      for (const subscriber of [...this.subscribers]) subscriber.onOutput(data);
    }

    exit(code: number, signal?: number): void {
      this.exitInfo = { code, ...(signal !== undefined ? { signal } : {}) };
      for (const subscriber of [...this.subscribers]) subscriber.onExit(code, signal);
      this.subscribers.clear();
      for (const listener of [...this.goneListeners]) listener();
    }
  }

  function managerWithPeer(handleOut?: (peer: string, cwd: string) => RecordingHandle) {
    const handles: RecordingHandle[] = [];
    const manager = new TerminalManager({
      peerTerms: {
        open: async (peer, peerCwd, cols, rows) => {
          const handle = handleOut !== undefined ? handleOut(peer, peerCwd) : new RecordingHandle();
          handles.push(handle);
          return { id: `peer:${peer}:t_${handles.length}`, createdAt: 1234, handle };
        },
      },
    });
    return { manager, handles };
  }

  it("creates through the hook, routes by id, and answers the same 404 for the wrong workspace", async () => {
    const { manager, handles } = managerWithPeer();
    const made = await manager.create(WS, 100, 30, { peer: "lab-vm", peerCwd: "/home/dev/project" });
    expect(made.id).toBe("peer:lab-vm:t_1");
    manager.write(WS, made.id, "typed");
    manager.resize(WS, made.id, 120, 40);
    expect(handles[0]!.written).toEqual(["typed"]);
    expect(handles[0]!.resized).toEqual([{ cols: 120, rows: 40 }]);
    const other: WorkspaceInfo = { id: "ws-2", path: "/other", name: "other" };
    expect(() => manager.write(other, made.id, "x")).toThrow(ChatError);
    expect(() => manager.write(WS, "peer:lab-vm:nope", "x")).toThrow(ChatError);
  });

  it("streams through the handle's own replay and exit, and forgets the id when the handle ends", async () => {
    const { manager, handles } = managerWithPeer();
    const made = await manager.create(WS, 100, 30, { peer: "lab-vm", peerCwd: "/x" });
    const seen = subscriber();
    manager.subscribe(WS, made.id, seen);
    handles[0]!.emit("live frame");
    expect(seen.output).toEqual(["live frame"]);
    handles[0]!.exit(0);
    expect(seen.exits).toEqual([{ code: 0 }]);
    // The handle ended itself: the id must stop resolving, like a local terminal evicted.
    expect(() => manager.write(WS, made.id, "x")).toThrow(ChatError);
  });

  it("closes through the route and bounds a write exactly as a local one", async () => {
    const { manager, handles } = managerWithPeer();
    const made = await manager.create(WS, 100, 30, { peer: "lab-vm", peerCwd: "/x" });
    expect(() => manager.write(WS, made.id, "y".repeat(64 * 1024 + 1))).toThrow(ChatError);
    manager.close(WS, made.id);
    expect(handles[0]!.closed).toBe(1);
    expect(() => manager.write(WS, made.id, "x")).toThrow(ChatError);
  });

  it("refuses a peer create when no hook is wired", async () => {
    const manager = new TerminalManager();
    await expect(manager.create(WS, 100, 30, { peer: "lab-vm", peerCwd: "/x" })).rejects.toThrow(ChatError);
  });
});
