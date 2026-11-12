// The OpenCode server awui drives: one private `opencode serve` (v2's HTTP
// API) for every OpenCode chat, sessions included, rather than a child per
// chat, since OpenCode's server is built to hold many sessions. It listens on
// a free loopback port with a password awui picks (OPENCODE_SERVER_PASSWORD;
// nothing secret is read from its output) and starts when first needed: a
// listing, a preview, or a chat. With no chat open it stops after a while, so a
// sidebar that lists OpenCode's sessions does not keep a server up for nothing.
// One event stream (/api/event) is read and handed to each chat by session id.
import { killChildTree, spawnHarness } from "../platform-win.js";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import readline from "node:readline";
import { isObj, type Obj } from "./agent-events.js";
import { StderrTail, terminateChild } from "./child-process.js";

/** How long `opencode serve` may take to listen (its plugins load after). */
const START_TIMEOUT_MS = 30_000;
/** A request's limit; prompts and replies return once accepted, so only a wedged server reaches it. */
const CALL_TIMEOUT_MS = 30_000;
/** OpenCode answers 503 while a project's plugins are still activating: asked again within this. */
const WARMUP_MS = 25_000;
/** A reply past this is no API answer awui reads (message pages are asked for in pieces). */
const MAX_REPLY_BYTES = 32 * 1024 * 1024;
/** With no chat open and no request, the server stops after this. */
const IDLE_STOP_MS = 10 * 60_000;

export class OpenCodeError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type OpenCodeEvent = Obj & { type: string; data: Obj };
type Listener = (event: OpenCodeEvent) => void;

interface Running {
  child: ChildProcessWithoutNullStreams;
  url: string;
  auth: string;
  events: AbortController;
}

// Every opencode server this process spawned; killed on exit.
const servers = new Set<ChildProcessWithoutNullStreams>();
let exitHookInstalled = false;

/** The session an event is about: most carry it in `data`, a form inside its form. */
export function eventSession(event: OpenCodeEvent): string {
  const d = event.data;
  if (typeof d.sessionID === "string") return d.sessionID;
  if (isObj(d.form) && typeof d.form.sessionID === "string") return d.form.sessionID;
  if (isObj(d.info) && isObj(d.info.metadata) && typeof d.info.metadata.sessionID === "string") return d.info.metadata.sessionID;
  return "";
}

/** SSE frames' `data:` lines as JSON objects; whatever else the stream carries is skipped. */
export function sseEvents(frame: string): OpenCodeEvent[] {
  const data = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).trimStart())
    .join("\n");
  if (!data) return [];
  try {
    const parsed = JSON.parse(data) as unknown;
    return isObj(parsed) && typeof parsed.type === "string" && isObj(parsed.data) ? [parsed as OpenCodeEvent] : [];
  } catch {
    return [];
  }
}

export class OpenCodeServer {
  private running: Running | null = null;
  private starting: Promise<Running> | null = null;
  private listeners = new Map<string, Set<Listener>>();
  /** Told when the server stops under open chats (their runs are gone with it). */
  private exitListeners = new Set<(message: string) => void>();
  private idleTimer: NodeJS.Timeout | null = null;
  /** The running server's stderr; one server serves every chat, so it is kept for the server's lifetime. */
  private stderr: StderrTail | null = null;

  constructor(
    private readonly command: string,
    private readonly env: () => NodeJS.ProcessEnv,
  ) {}

  /** The running server, started if need be. */
  private async ready(): Promise<Running> {
    this.touch();
    if (this.running && this.running.child.exitCode === null) return this.running;
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async start(): Promise<Running> {
    const password = randomBytes(24).toString("base64url");
    // The home folder: the server serves every project by its location, so it belongs to none.
    const child = spawnHarness(this.command, ["serve", "--hostname", "127.0.0.1", "--port", "0"], {
      cwd: homedir(),
      env: { ...this.env(), OPENCODE_SERVER_PASSWORD: password },
      stdio: ["pipe", "pipe", "pipe"],
    });
    servers.add(child);
    child.once("exit", () => servers.delete(child));
    if (!exitHookInstalled) {
      exitHookInstalled = true;
      process.once("exit", () => {
        for (const c of servers) killChildTree(c);
      });
    }
    const stderr = new StderrTail(child);
    this.stderr = stderr;
    const url = await new Promise<string>((resolve, reject) => {
      const lines = readline.createInterface({ input: child.stdout });
      const timer = setTimeout(() => fail(new Error(`opencode serve did not start listening${this.tail(stderr)}`)), START_TIMEOUT_MS);
      const fail = (error: Error) => {
        clearTimeout(timer);
        lines.close();
        void terminateChild(child);
        reject(error);
      };
      lines.on("line", (line) => {
        const found = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(line)?.[1];
        if (!found) return;
        clearTimeout(timer);
        lines.close();
        // Its stdout is not read after this; drained so a chatty server never blocks on a full pipe.
        child.stdout.resume();
        resolve(found);
      });
      child.once("error", (error) => fail(new Error(`opencode could not start: ${error.message}`)));
      child.once("exit", (code, signal) => fail(new Error(`opencode serve exited (${signal ?? code})${this.tail(stderr)}`)));
    });
    const running: Running = { child, url, auth: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`, events: new AbortController() };
    this.running = running;
    child.once("exit", (code, signal) => {
      if (this.running !== running) return;
      this.running = null;
      running.events.abort();
      const message = `opencode serve stopped (${signal ?? code})${this.tail()}`;
      for (const listener of this.exitListeners) listener(message);
    });
    void this.readEvents(running);
    return running;
  }

  private tail(stderr = this.stderr): string {
    const reason = stderr?.reason();
    return reason ? `: ${reason}` : "";
  }

  /** The event stream, read until the server goes; a dropped stream is opened again. */
  private async readEvents(running: Running): Promise<void> {
    while (this.running === running && !running.events.signal.aborted) {
      try {
        const res = await fetch(`${running.url}/api/event`, { headers: { authorization: running.auth, accept: "text/event-stream" }, signal: running.events.signal });
        if (!res.ok || !res.body) throw new Error(`event stream: HTTP ${res.status}`);
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          // A frame past this is no event OpenCode sends; dropped rather than buffered forever.
          if (buf.length > 4 * 1024 * 1024) buf = "";
          let end: number;
          while ((end = buf.indexOf("\n\n")) >= 0) {
            const frame = buf.slice(0, end);
            buf = buf.slice(end + 2);
            for (const event of sseEvents(frame)) this.dispatch(event);
          }
        }
      } catch {
        // Aborted (the server is going) or dropped: the loop decides.
      }
      if (this.running === running && !running.events.signal.aborted) await new Promise((r) => setTimeout(r, 1000));
    }
  }

  private dispatch(event: OpenCodeEvent): void {
    const session = eventSession(event);
    for (const listener of this.listeners.get(session) ?? []) listener(event);
    // A subagent's session is born under its parent: the parent's chat hears of it.
    const parent = event.type === "session.created" && typeof event.data.parentID === "string" ? event.data.parentID : "";
    if (parent && parent !== session) for (const listener of this.listeners.get(parent) ?? []) listener(event);
  }

  /** Events about `sessionId`, until the returned function is called. */
  subscribe(sessionId: string, listener: Listener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(listener);
    this.touch();
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(sessionId);
      this.touch();
    };
  }

  /** Told once when the server stops under the chats. */
  onExit(listener: (message: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Keep the server while chats are open; stop it once nothing has used it for a while. */
  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.listeners.size === 0) void this.stop();
      else this.touch();
    }, IDLE_STOP_MS);
    this.idleTimer.unref?.();
  }

  /** An API call: its JSON reply (null for an empty one), or an OpenCodeError with OpenCode's message. */
  async call<T = unknown>(method: string, path: string, body?: unknown, timeoutMs = CALL_TIMEOUT_MS): Promise<T> {
    const deadline = Date.now() + WARMUP_MS;
    for (;;) {
      const running = await this.ready();
      const res = await fetch(`${running.url}${path}`, {
        method,
        headers: { authorization: running.auth, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(timeoutMs),
      }).catch((error: unknown) => {
        throw new OpenCodeError(0, `OpenCode did not answer: ${error instanceof Error ? error.message : String(error)}`);
      });
      const length = Number(res.headers.get("content-length") ?? 0);
      if (length > MAX_REPLY_BYTES) throw new OpenCodeError(res.status, "OpenCode's reply is too large");
      const text = await res.text();
      if (text.length > MAX_REPLY_BYTES) throw new OpenCodeError(res.status, "OpenCode's reply is too large");
      let json: unknown = null;
      try {
        json = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        json = null;
      }
      if (res.ok) return json as T;
      // The project's plugins are still activating: the same call works shortly.
      if (res.status === 503 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }
      const message = isObj(json) && typeof json.message === "string" ? json.message : `HTTP ${res.status}`;
      throw new OpenCodeError(res.status, `OpenCode: ${message}`);
    }
  }

  /** Whether a server is up right now: a call would start one, so a closing chat asks before it tidies up. */
  active(): boolean {
    return this.running !== null && this.running.child.exitCode === null;
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const running = this.running ?? (this.starting ? await this.starting.catch(() => null) : null);
    this.running = null;
    if (!running) return;
    running.events.abort();
    await terminateChild(running.child);
  }
}

/** `location[directory]=<cwd>`: OpenCode's project-scoped routes take the folder this way. */
export function locationQuery(cwd: string): string {
  return `location%5Bdirectory%5D=${encodeURIComponent(cwd)}`;
}

export function liveOpenCodeServers(): number {
  return servers.size;
}
