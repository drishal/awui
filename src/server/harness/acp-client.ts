// One Agent Client Protocol child over stdio: the JSON-RPC framing, request ids,
// pending-request bookkeeping, stderr tail, and termination that every ACP
// adapter needs. Grok, DeepSeek Harness, and each agent config.yml defines
// speak the same wire, so the transport lives here once; what differs (the
// command line, the app's own update vocabulary, its session files) stays in
// each adapter.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { spawnHarness } from "../platform-win.js";
import { isObj, type Obj } from "./agent-events.js";
import { PendingRequests, StderrTail, terminateChild } from "./child-process.js";


/**
 * One frame's longest allowed line: nothing ACP sends comes near it (a whole tool result rides in an
 * update), and an agent that writes more is failing, not reporting.
 */
const MAX_FRAME_CHARS = 4 * 1024 * 1024;

/**
 * The id a response frame answers, or null. A frame with `method` is a request
 * or a notification, never a response: an agent's permission requests carry
 * their own ids (often numbers) and must not settle the prompt in flight.
 */
export function answeredId(frame: Obj): string | null {
  if (frame.method !== undefined) return null;
  if (frame.result === undefined && frame.error === undefined) return null;
  return typeof frame.id === "string" ? frame.id : null;
}

export interface AcpClientOptions {
  /**
   * The tracking key this child is registered under: one per owner (a config.yml agent, grok, dsh),
   * never a display label. Two agents may share a display name, and a label-keyed list would let
   * one agent's shutdown or Test kill the other's live chats.
   */
  key: string;
  /** The name a failure message uses for a child that died, stopped answering, or is gone ("grok"). */
  label: string;
  /** The name "could not start …" uses; the label when omitted (a short name for a long-winded app). */
  startLabel?: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  onFrame(frame: Obj): void;
  /** Called synchronously inside the line handler for a frame that answers one of our requests. */
  onAnswered?(frame: Obj): void;
  /** The message of the agent's own JSON-RPC error object, when its shape says more than `message`. */
  errorText?(value: unknown): string;
}

/** Every ACP child this process spawned, with the tracking key of the owner that spawned it. */
const children = new Map<ChildProcessWithoutNullStreams, string>();
let exitHookInstalled = false;

function track(child: ChildProcessWithoutNullStreams, key: string): void {
  children.set(child, key);
  // `close` as well as `exit`: a child that never spawned (a wrong command) emits only error and close.
  child.once("exit", () => children.delete(child));
  child.once("close", () => children.delete(child));
  // A spawn that never produced a process emits only `error` (a wrong command), so it is gone too.
  child.once("error", () => children.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const c of children.keys()) c.kill("SIGKILL");
    });
  }
}

/** How many of one owner's children are alive (adapter tests assert it returns to zero). */
export function liveAcpChildren(key?: string): number {
  if (key === undefined) return children.size;
  let count = 0;
  for (const owner of children.values()) if (owner === key) count += 1;
  return count;
}

/** Stop every child of one owner (`shutdown()`); the whole process's when no key is given. */
export async function killAcpChildren(key?: string): Promise<void> {
  const targets = [...children].filter(([, owner]) => key === undefined || owner === key).map(([child]) => child);
  await Promise.allSettled(targets.map((child) => terminateChild(child)));
}

/** One ACP child: JSON-RPC requests out, everything else handed to `onFrame`. */
export class AcpClient {
  readonly child: ChildProcessWithoutNullStreams;
  exited = false;
  private readonly stderr: StderrTail;
  private readonly exitListeners = new Set<(message: string) => void>();
  private readonly label: string;
  private readonly startLabel: string;
  private status: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  /** The child wrote a line no message of this protocol can be: it was stopped, and its stream is ignored. */
  private tooLong = false;
  private readonly calls: PendingRequests<string>;

  constructor(private readonly options: AcpClientOptions) {
    this.label = options.label;
    this.startLabel = options.startLabel ?? options.label;
    this.calls = new PendingRequests<string>(
      {
        // String ids: an agent's numeric permission request id must never settle ours.
        formatId: (n) => `c${n}`,
        encode: (id, payload) => ({ jsonrpc: "2.0", id, ...payload }),
        answeredId,
        outcome: (frame) => (frame.error !== undefined ? { error: new Error(this.errorText(frame.error)) } : { value: frame.result }),
      },
      (frame) => this.write(frame),
    );
    this.child = spawnHarness(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    this.stderr = new StderrTail(this.child);
    track(this.child, options.key);
    // Split by hand rather than through `readline`, which buffers a line of any length: a frame past
    // MAX_FRAME_CHARS is no ACP message, and buffering it would be the whole cost of reading it.
    this.child.stdout.setEncoding("utf8");
    let pending = "";
    this.child.stdout.on("data", (chunk: string) => {
      if (this.tooLong) return;
      let start = 0;
      for (;;) {
        const at = chunk.indexOf("\n", start);
        pending += chunk.slice(start, at < 0 ? chunk.length : at);
        // Checked before the line is used: a chunk can carry the whole of one.
        if (pending.length > MAX_FRAME_CHARS) {
          this.failOnLongFrame();
          return;
        }
        if (at < 0) return;
        const line = pending;
        pending = "";
        start = at + 1;
        if (line.trim()) this.readFrame(line);
      }
    });
    this.child.stdin.on("error", () => undefined);
    const onExit = (detail: string) => {
      if (this.exited) return;
      this.exited = true;
      const reason = this.stderr.reason();
      const message = reason ? `${detail}: ${reason}` : detail;
      this.calls.failAll(message);
      for (const listener of this.exitListeners) listener(message);
    };
    this.child.once("error", (error) => onExit(`could not start ${this.startLabel} (${error.message})`));
    this.child.once("exit", (code, signal) => {
      // Kept apart from the message: a caller that answers a user (the Settings Test) may say this
      // and nothing else, since the stderr tail above can hold a secret.
      this.status = { code, signal };
      onExit(`${this.label} exited (${signal ?? `code ${code}`})`);
    });
  }

  /** One line of the child's stdout: the response it answers, or a frame the adapter reads. */
  private readFrame(line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      return;
    }
    if (!isObj(frame)) return;
    // The hook runs before any later line of this chunk is read: a response can
    // change how the very next line must be handled.
    if (this.calls.accept(frame)) {
      this.options.onAnswered?.(frame);
      return;
    }
    this.options.onFrame(frame);
  }

  /**
   * A child that writes a line past the bound is failing: its requests fail with a sentence naming
   * the bound, and it is stopped. Nothing of the line is kept or repeated — the point of the bound
   * is not to hold output that no protocol message could be.
   */
  private failOnLongFrame(): void {
    if (this.tooLong) return;
    this.tooLong = true;
    this.calls.failAll(`${this.label} wrote a line longer than ${MAX_FRAME_CHARS} characters, which is no ACP message`);
    void terminateChild(this.child).catch(() => undefined);
  }

  /**
   * How the child ended, as a code or a signal, or null when it never got that far (a command that
   * could not start, or a child that is still running).
   */
  exitStatus(): { code: number | null; signal: NodeJS.Signals | null } | null {
    return this.status;
  }

  onExit(listener: (message: string) => void): void {
    this.exitListeners.add(listener);
  }

  /** `null` timeout waits forever (a prompt's result comes when the turn ends). */
  request<T = unknown>(method: string, params: Obj, timeoutMs?: number | null): Promise<T> {
    return this.calls.send<T>({ method, params }, `${this.label} did not answer ${method}`, timeoutMs);
  }

  /** A notification (no id): session/cancel. */
  notify(method: string, params: Obj): void {
    this.tryWrite({ jsonrpc: "2.0", method, params });
  }

  /** The result of a request the agent made of this host, with that request's own id. */
  respond(id: unknown, result: unknown): void {
    this.tryWrite({ jsonrpc: "2.0", id, result });
  }

  respondError(id: unknown, code: number, message: string): void {
    this.tryWrite({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private errorText(value: unknown): string {
    if (this.options.errorText) return this.options.errorText(value);
    if (isObj(value) && typeof value.message === "string" && value.message) return value.message;
    return typeof value === "string" && value ? value : `${this.label} reported an error`;
  }

  private tryWrite(frame: Obj): void {
    try {
      this.write(frame);
    } catch {
      // The child is gone; so is whatever it asked.
    }
  }

  private write(frame: Obj): void {
    if (this.exited) throw new Error(`${this.label} is not running`);
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  kill(): Promise<void> {
    return terminateChild(this.child);
  }
}
