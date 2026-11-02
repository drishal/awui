// Shared machinery for driving a harness child's stdio: graceful termination
// that cannot hang, the child's stderr kept for why it died, and the
// pending-request bookkeeping behind each adapter's JSON-RPC dialect
// (omp rpc-ui, omp acp, the hermes gateway).
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { killChildTree, terminateHarnessChild } from "../platform-win.js";
import type { Obj } from "./agent-events.js";

/** How long `terminateChild` waits between SIGTERM and SIGKILL. */
const KILL_TIMEOUT_MS = 3_000;
/** One request's default: long enough for a model call, short enough that a wedged child cannot hold a route forever. */
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Ask a child to exit: end stdin, SIGTERM, then SIGKILL after `timeoutMs`.
 * Settles on `exit`, `close`, or `error`, and a child that never spawned
 * (spawn failed, so no exit event will ever fire) counts as already gone.
 * A wedged child can leave even the SIGKILL timer's `exitCode`/`signalCode`
 * unset and its event hooks quiet, so settle on the timer too: the kill is
 * issued, and by then nothing more is ours to wait on.
 */
export function terminateChild(child: ChildProcessWithoutNullStreams, timeoutMs = KILL_TIMEOUT_MS): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return Promise.resolve();
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  let timer: NodeJS.Timeout | undefined;
  const done = () => {
    clearTimeout(timer);
    resolve();
  };
  child.once("exit", done);
  child.once("close", done);
  child.once("error", done);
  try {
    child.stdin.end();
  } catch {
    // The pipe is already gone; the kill below still settles this.
  }
  terminateHarnessChild(child);
  timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      killChildTree(child);
      // Settle regardless: if it is still alive past SIGKILL the process is
      // being torn down anyway (systemd reaps the cgroup on stop).
      done();
    }
  }, timeoutMs);
  return promise;
}

/**
 * Why a child died, as one line for a banner: the last few non-empty stderr
 * lines, ANSI escapes (a harness's spinner) taken out, bounded. Harnesses print
 * their refusals and tracebacks to stderr and leave stdout at the protocol, so
 * this is the only place the reason appears at all — the commonest one being a
 * Python entry point that exits 1 with nothing on stdout.
 */
export function stderrReason(text: string, lines = 3, width = 400): string | null {
  const tail = text
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-lines)
    .join(" ");
  return tail ? tail.slice(0, width) : null;
}

/**
 * One child's stderr, kept to its tail. Bounded because a chatty harness would
 * otherwise grow it for as long as the chat lives, and read through `reason()`
 * when the child exits (or never becomes ready).
 */
export class StderrTail {
  private text = "";
  constructor(child: ChildProcessWithoutNullStreams, private readonly limit = 8_000) {
    child.stderr.on("data", (chunk: Buffer) => {
      this.text = (this.text + chunk.toString("utf8")).slice(-limit);
    });
  }
  /** What to append to a failure message, or null when it said nothing. */
  reason(): string | null {
    return stderrReason(this.text);
  }
}

/** How one adapter frames requests and recognizes its responses. */
export interface FrameCodec<Id extends string | number> {
  /** A fresh id for the next request (string or number, as the dialect uses). */
  formatId(n: number): Id;
  /** The outbound frame for a payload (`{type,…}` or `{method,params}`) carrying `id`. */
  encode(id: Id, payload: Obj): Obj;
  /** The id of the request `frame` answers, or null when it answers none. */
  answeredId(frame: Obj): Id | null;
  /** A matched response frame as an outcome. */
  outcome(frame: Obj): { value: unknown } | { error: Error };
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

/**
 * In-flight requests over one child's stdio: id allocation, the pending map,
 * one timeout policy, and rejection of everything in flight when the child is
 * gone. Response matching goes through the dialect's `FrameCodec`, so a frame
 * this helper does not settle is left for the caller to handle.
 */
export class PendingRequests<Id extends string | number> {
  private counter = 1;
  private pending = new Map<Id, Pending>();

  constructor(
    private readonly codec: FrameCodec<Id>,
    private readonly write: (frame: Obj) => void,
  ) {}

  /** Send `payload` and wait for its response; `null` waits forever. */
  send<T = unknown>(payload: Obj, timeoutMessage: string, timeoutMs: number | null = REQUEST_TIMEOUT_MS): Promise<T> {
    const id = this.codec.formatId(this.counter++);
    let resolve!: (value: T) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: Pending = { resolve: resolve as (value: unknown) => void, reject };
    if (timeoutMs !== null) {
      entry.timer = setTimeout(() => this.settle(id, { error: new Error(timeoutMessage) }), timeoutMs);
    }
    this.pending.set(id, entry);
    try {
      this.write(this.codec.encode(id, payload));
    } catch (error) {
      this.settle(id, { error: error instanceof Error ? error : new Error(String(error)) });
    }
    return promise;
  }

  /** Settle the request `frame` answers; false when it answers none in flight. */
  accept(frame: Obj): boolean {
    const id = this.codec.answeredId(frame);
    if (id === null || !this.pending.has(id)) return false;
    this.settle(id, this.codec.outcome(frame));
    return true;
  }

  /** Reject everything in flight — the child is gone. */
  failAll(message: string): void {
    for (const id of [...this.pending.keys()]) this.settle(id, { error: new Error(message) });
  }

  private settle(id: Id, outcome: { value: unknown } | { error: Error }): void {
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if ("error" in outcome) entry.reject(outcome.error);
    else entry.resolve(outcome.value);
  }
}
