// The mesh peer wire (P1): newline-delimited JSON-RPC 2.0 over any Node
// Readable/Writable pair — SSH or docker stdio in production, a PassThrough
// pair in tests. This module knows nothing about transports or policy: it
// frames lines through shell noise, bounds what one peer may send, and turns
// bytes into requests, notifications, and responses. Every rule here is a link
// rule, taken from the spec: a peer that sends malformed JSON, something that
// is not JSON-RPC 2.0, or a line over the bound closes the whole link — a
// stream that already misbehaved cannot be trusted to answer anything about
// itself. Nothing but protocol lines is ever written to the output.
import type { Readable, Writable } from "node:stream";

/** The one line a worker writes before any JSON: what a client waits for through shell MOTD noise. */
export const PREAMBLE = "AWUI-MESH/1 READY\n";

/** One wire line's biggest size, bytes: bounded like every payload the server carries. */
export const MAX_LINE_BYTES = 1024 * 1024;
/** Unwritten output one link may hold before it is closed (a peer that stopped reading). */
export const MAX_QUEUED_BYTES = 16 * 1024 * 1024;

/** How many bytes of shell MOTD / .bashrc noise a client skips while hunting the preamble. */
export const MAX_NOISE_BYTES = 64 * 1024;

/**
 * The protocol's error codes, snake_name -> number. The -32xxx range is
 * JSON-RPC 2.0's own; -33001..-33008 are the spec's mesh codes, and
 * `error.data` is always `{ code: "<snake_name>" }`. `link_closed` and
 * `timeout` never travel on the wire: they are how a local caller learns the
 * link died under a pending request, or that an answer never came, so they
 * sit outside every range a peer could mistake for a protocol answer.
 */
export const MeshErrorCode = {
  parse_error: -32700,
  invalid_request: -32600,
  method_not_found: -32601,
  invalid_params: -32602,
  internal_error: -32603,
  not_paired: -33001,
  denied: -33002,
  needs_approval: -33003,
  limit: -33004,
  not_found: -33005,
  mesh_off: -33006,
  hop_limit: -33007,
  pin_mismatch: -33008,
  link_closed: -34999,
  timeout: -34998,
} as const;

export type MeshErrorCodeName = keyof typeof MeshErrorCode;

/** A JSON-RPC id as it travels: an integer we chose, or whatever the peer chose for its own. */
type RpcId = number | string;

/** The snake_name for a code number, for error data when the peer sent none. */
function nameFor(code: number): string {
  const found = (Object.entries(MeshErrorCode) as [MeshErrorCodeName, number][]).find(([, n]) => n === code);
  return found === undefined ? "unknown" : found[0];
}

/** A JSON-RPC error as this protocol's callers see it: a number, a message, and the spec's `{code: "<snake_name>"}` data. */
export class MeshRpcError extends Error {
  readonly code: number;
  readonly data: { code: string };

  constructor(code: number, message: string, data?: { code: string }) {
    super(message);
    this.name = "MeshRpcError";
    this.code = code;
    this.data = data ?? { code: nameFor(code) };
  }
}

export interface LineReaderOpts {
  /** Discard bytes, up to MAX_NOISE_BYTES, until the exact preamble line arrives; JSON parsing starts after it. */
  awaitPreamble?: boolean;
  /** One complete line, UTF-8 decoded, without its newline. Noise lines are never delivered. */
  onLine: (line: string) => void;
}

/**
 * Incremental line splitting over arbitrary chunk boundaries. Bytes are held
 * raw and each line is decoded only once its newline has arrived, so a UTF-8
 * character split across two chunks still decodes: the separator is ASCII and
 * can never appear inside a multi-byte character, so scanning raw bytes for
 * 0x0a is always correct. Violations throw; the caller closes the link.
 */
export class LineReader {
  private buf: Buffer = Buffer.alloc(0);
  /** How far into `buf` was already searched, so re-scans stay linear as chunks arrive. */
  private searched = 0;
  private discarded = 0;
  private awaiting: boolean;

  constructor(private readonly opts: LineReaderOpts) {
    this.awaiting = opts.awaitPreamble === true;
  }

  /** Whether the preamble has been seen (always true when it was never awaited). */
  get sawPreamble(): boolean {
    return !this.awaiting;
  }

  /** Feed one chunk; throws on a size or noise violation. */
  push(chunk: Buffer): void {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    for (;;) {
      const nl = this.buf.indexOf(0x0a, this.searched);
      if (nl < 0) {
        // Only the final byte so far could begin the newline we have not seen.
        this.searched = Math.max(0, this.buf.length - 1);
        this.checkBounds();
        return;
      }
      const line = this.buf.subarray(0, nl);
      this.buf = this.buf.subarray(nl + 1);
      this.searched = 0;
      if (this.awaiting) {
        if (preambleLine().equals(line)) this.awaiting = false;
        else {
          this.discarded += line.length + 1;
          this.checkBounds();
        }
      } else {
        this.opts.onLine(line.toString("utf8"));
      }
    }
  }

  /** The bounds, checked on whatever is buffered: a too-long line, or (before the preamble) too much noise. */
  private checkBounds(): void {
    if (this.awaiting) {
      // A buffered prefix of the preamble itself is not noise yet; anything else buffered is.
      const pending = this.couldBePreamble() ? 0 : this.buf.length;
      if (this.discarded + pending > MAX_NOISE_BYTES) throw new Error(`more than ${MAX_NOISE_BYTES} bytes of noise before the mesh preamble`);
    } else if (this.buf.length > MAX_LINE_BYTES) {
      throw new Error(`a mesh line longer than ${MAX_LINE_BYTES} bytes`);
    }
  }

  /** Whether the bytes buffered so far could still become the preamble line. */
  private couldBePreamble(): boolean {
    const full = preambleLine();
    return this.buf.length <= full.length && full.subarray(0, this.buf.length).equals(this.buf);
  }
}

/** The preamble without its newline, for byte-exact comparison against a line. */
function preambleLine(): Buffer {
  return Buffer.from(PREAMBLE, "utf8").subarray(0, -1);
}

export interface RpcPeerOpts {
  /** "server" writes the preamble on start(); "client" skips noise until it sees it. */
  role: "client" | "server";
  /** Where local-only observations go (never the wire): unknown ids, handler failures. */
  log?: (message: string) => void;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: MeshRpcError) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * One end of a mesh link. Requests we send carry our own increasing integer
 * ids; the peer's ids are its own and only ever echoed back. A response to an
 * id we never asked is logged and dropped (a reply can race a timeout). On
 * close — EOF, a write error like EPIPE, a protocol violation, or an explicit
 * close — every pending request rejects with link_closed and `closed`
 * resolves once with the reason.
 */
export class RpcPeer {
  readonly closed: Promise<string>;

  private readonly reader: LineReader;
  private readonly log: (message: string) => void;
  private readonly pending = new Map<RpcId, Pending>();
  /** Lines written but not yet past backpressure, in order. */
  private readonly queue: string[] = [];
  private queuedBytes = 0;
  private requestHandler: ((method: string, params: unknown) => Promise<unknown>) | null = null;
  private notificationHandler: ((method: string, params: unknown) => void) | null = null;
  private nextId = 0;
  private started = false;
  private draining = false;
  private closeReason: string | null = null;
  /** Whether this link has closed (either side). */
  get isClosed(): boolean {
    return this.closeReason !== null;
  }
  private resolveClosed!: (reason: string) => void;

  constructor(
    private readonly input: Readable,
    private readonly output: Writable,
    private readonly opts: RpcPeerOpts,
  ) {
    this.log = opts.log ?? (() => undefined);
    this.reader = new LineReader({ awaitPreamble: opts.role === "client", onLine: (line) => this.onLine(line) });
    this.closed = new Promise<string>((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  /** Begins the link: the server writes the preamble, both roles start reading. Idempotent. */
  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.opts.role === "server") this.enqueueRaw(PREAMBLE);
    this.input.on("data", (chunk: Buffer) => this.onData(chunk));
    this.input.on("end", () => this.close("eof"));
    this.input.on("close", () => this.close("eof"));
    // A stream error (EPIPE on write, a broken transport on read) ends the link, never the process.
    this.input.on("error", (error: Error) => this.close(`input error: ${error.message}`));
    this.output.on("error", (error: Error) => this.close(`output error: ${error.message}`));
  }

  /** One request; rejects with the peer's error, a timeout, or link_closed if the link dies first. */
  request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.closeReason !== null) return Promise.reject(this.linkClosed());
    const id = ++this.nextId;
    return new Promise<unknown>((resolve, reject) => {
      // Bounded: a peer that never answers must not hold this caller forever.
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new MeshRpcError(MeshErrorCode.timeout, `no answer to "${method}" within ${timeoutMs} ms`, { code: "timeout" }));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    }) as Promise<T>;
  }

  /** One fire-and-forget message. */
  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  /** Answers every incoming request. A thrown MeshRpcError becomes that error response; any other throw becomes a generic -32603. */
  onRequest(handler: (method: string, params: unknown) => Promise<unknown>): void {
    this.requestHandler = handler;
  }

  /** Answers incoming notifications; a throw is logged and swallowed, never fatal to the link. */
  onNotification(handler: (method: string, params: unknown) => void): void {
    this.notificationHandler = handler;
  }

  /** Ends the link. Pending requests reject with link_closed; the reason reaches `closed` once. */
  close(reason?: string): void {
    if (this.closeReason !== null) return;
    this.closeReason = reason ?? "closed";
    // Every caller holding a pending answer learns the link died under it.
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(this.linkClosed());
    }
    this.pending.clear();
    this.input.removeAllListeners("data");
    this.input.destroy();
    try {
      this.output.end();
    } catch {
      // The link is down; finishing a dead stream is best-effort.
    }
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.resolveClosed(this.closeReason);
  }

  private linkClosed(): MeshRpcError {
    return new MeshRpcError(MeshErrorCode.link_closed, "the mesh link closed before an answer arrived", { code: "link_closed" });
  }

  private onData(chunk: Buffer): void {
    try {
      this.reader.push(chunk);
    } catch (error) {
      this.close(`protocol: ${(error as Error).message}`);
    }
  }

  /** One already-complete wire write (the preamble carries its own newline). */
  private enqueueRaw(text: string): void {
    if (this.closeReason !== null) return;
    this.queuedBytes += text.length;
    if (this.queuedBytes > MAX_QUEUED_BYTES) {
      // The other side stopped reading: drop the link instead of buffering forever.
      this.close(`backpressure: more than ${MAX_QUEUED_BYTES} bytes waiting to be written`);
      return;
    }
    this.queue.push(text);
    this.pump();
  }

  private send(message: unknown): void {
    const line = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
      // The far side would refuse the line and drop the whole link; answer this one call
      // with an error instead (a request or notification that big is simply not sent).
      const id = (message as { id?: unknown; result?: unknown; error?: unknown }).id;
      const isResponse = message !== null && typeof message === "object" && ("result" in message || "error" in message);
      if (isResponse && (typeof id === "number" || typeof id === "string")) {
        this.enqueueRaw(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code: MeshErrorCode.limit, message: `the answer is larger than ${MAX_LINE_BYTES} bytes`, data: { code: "limit" } } })}\n`);
      } else {
        this.close(`protocol: an outgoing line longer than ${MAX_LINE_BYTES} bytes`);
      }
      return;
    }
    this.enqueueRaw(line);
  }

  /** Writes queued lines in order, pausing for backpressure and resuming on drain. */
  private pump(): void {
    while (!this.draining && this.closeReason === null && this.queue.length > 0) {
      const text = this.queue[0]!;
      let ok: boolean;
      try {
        ok = this.output.write(text);
      } catch (error) {
        this.close(`output error: ${(error as Error).message}`);
        return;
      }
      this.queue.shift();
      this.queuedBytes -= text.length;
      if (!ok) {
        this.draining = true;
        this.output.once("drain", () => {
          this.draining = false;
          this.pump();
        });
        return;
      }
    }
  }

  private onLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.protocolFailure("malformed JSON");
      return;
    }
    if (typeof message !== "object" || message === null || Array.isArray(message)) {
      this.protocolFailure("a line that is not a JSON object");
      return;
    }
    const msg = message as Record<string, unknown>;
    if (msg.jsonrpc !== "2.0") {
      this.protocolFailure('no jsonrpc "2.0" marker');
      return;
    }
    if (typeof msg.method === "string") {
      if (msg.params !== undefined && (typeof msg.params !== "object" || msg.params === null)) {
        this.protocolFailure("params that is not an object or array");
        return;
      }
      if ("id" in msg) {
        if (typeof msg.id !== "number" && typeof msg.id !== "string") {
          this.protocolFailure("a request id that is neither number nor string");
          return;
        }
        this.dispatch(msg.method, msg.params, msg.id);
      } else {
        this.deliverNotification(msg.method, msg.params);
      }
      return;
    }
    if ("id" in msg) {
      if (typeof msg.id !== "number" && typeof msg.id !== "string") {
        this.protocolFailure("a response id that is neither number nor string");
        return;
      }
      if ("result" in msg === "error" in msg) {
        this.protocolFailure("a response with neither or both of result and error");
        return;
      }
      if ("error" in msg) this.deliverError(msg.id, msg.error);
      else this.settle(msg.id, { ok: true, value: msg.result });
      return;
    }
    this.protocolFailure("neither a request, a notification, nor a response");
  }

  private protocolFailure(reason: string): void {
    this.close(`protocol: ${reason}`);
  }

  private async dispatch(method: string, params: unknown, id: RpcId): Promise<void> {
    const handler = this.requestHandler;
    if (handler === null) {
      this.replyError(id, new MeshRpcError(MeshErrorCode.method_not_found, `no handler answers "${method}"`, { code: "method_not_found" }));
      return;
    }
    let result: unknown;
    try {
      result = await handler(method, params);
    } catch (error) {
      if (error instanceof MeshRpcError) this.replyError(id, error);
      else {
        // The failure is ours to read locally, never the peer's: a stack or a local path in a reply is a leak.
        this.log(`mesh rpc: the handler for "${method}" failed: ${error instanceof Error ? error.message : String(error)}`);
        this.replyError(id, new MeshRpcError(MeshErrorCode.internal_error, "internal error", { code: "internal_error" }));
      }
      return;
    }
    this.replyResult(id, result);
  }

  private deliverNotification(method: string, params: unknown): void {
    const handler = this.notificationHandler;
    if (handler === null) {
      this.log(`mesh rpc: a notification "${method}" arrived with no handler`);
      return;
    }
    try {
      handler(method, params);
    } catch (error) {
      this.log(`mesh rpc: the notification handler for "${method}" failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private deliverError(id: RpcId, error: unknown): void {
    if (typeof error !== "object" || error === null || Array.isArray(error)) {
      this.protocolFailure("an error that is not an object");
      return;
    }
    const err = error as Record<string, unknown>;
    if (typeof err.code !== "number" || typeof err.message !== "string") {
      this.protocolFailure("an error without a numeric code and a string message");
      return;
    }
    this.settle(id, { ok: false, code: err.code, message: err.message, data: err.data });
  }

  private settle(id: RpcId, outcome: { ok: true; value: unknown } | { ok: false; code: number; message: string; data: unknown }): void {
    const pending = this.pending.get(id);
    if (pending === undefined) {
      // A reply can race a timeout, or a peer misroutes; the link itself owes us nothing here.
      this.log(`mesh rpc: a response arrived for unknown request id ${JSON.stringify(id)}`);
      return;
    }
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (outcome.ok) {
      pending.resolve(outcome.value);
      return;
    }
    const data =
      typeof outcome.data === "object" && outcome.data !== null && !Array.isArray(outcome.data) && typeof (outcome.data as Record<string, unknown>).code === "string"
        ? (outcome.data as { code: string })
        : { code: nameFor(outcome.code) };
    pending.reject(new MeshRpcError(outcome.code, outcome.message, data));
  }

  private replyResult(id: RpcId, result: unknown): void {
    // `undefined` would be dropped by JSON.stringify and leave the response invalid; null is the honest empty answer.
    this.send({ jsonrpc: "2.0", id, result: result === undefined ? null : result });
  }

  private replyError(id: RpcId, error: MeshRpcError): void {
    this.send({ jsonrpc: "2.0", id, error: { code: error.code, message: error.message, data: error.data } });
  }
}
