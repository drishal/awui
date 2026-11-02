// omp adapter. omp's SDK package requires Bun and ships raw .ts, so it cannot
// be imported into this Node server. Instead each live chat drives the
// installed `omp` binary in `--mode rpc-ui` (the mode with tool-approval and
// extension UI over the protocol) as one child process. omp's RPC mode has no
// session listing, so listing uses a short-lived `omp acp` process and ACP's
// `session/list`. Protocol types below are hand-written from omp 18.4.5's
// src/modes/rpc/rpc-types.ts and kept deliberately loose; 18.4.10 only adds
// commands and an opt-in `ask` dialog, so nothing used here changed. Newer
// minors are assumed additive and stay quiet; an older build or a new major
// line is reported by ompVersionWarning().
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { execHarness, spawnHarness } from "../platform-win.js";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import {
  asHarnessId,
  type ChatConfig,
  type ChatItem,
  type ContextCategory,
  type ContextUsage,
  type HarnessCapabilities,
  type ImageAttachment,
  type InteractionAnswer,
  type InteractionKind,
  type LimitAccount,
  type ModelInfo,
  type QueueState,
  type SlashCommand,
  type SubagentRun,
  type TodoItem,
} from "../../shared/protocol.js";
import { commandOutputEvents, historyToItems, isObj, normalizeAgentEvent, type Obj, todoPhaseItems, usageEntries } from "./agent-events.js";
import { PendingRequests, StderrTail, terminateChild } from "./child-process.js";
import { branchMessages, fileMessages, forkSessionText, seedSessionText, sessionFileTimestamp, uuidv7 } from "./session-files.js";
import { ompLimits } from "./limits.js";
import { rewindExtension, rewindExtensionArgs, rewindWithExtension } from "./rewind-extension.js";
import { renderHtmlExtension, renderHtmlExtensionArgs } from "./render-extension.js";
import { versionLabel } from "./version.js";
import { EventHub } from "./event-hub.js";
import { seedTranscript, type HandoffSeed } from "./handoff.js";
import type {
  HarnessAdapter,
  HarnessDiscovery,
  HarnessEventListener,
  HarnessUsage,
  LiveChat,
  NativeSessionSummary,
  OpenChatRequest,
  RecentNativeSession,
  UsageEntry,
} from "./types.js";

/**
 * What to warn about for a detected omp CLI, or null when its signature is
 * known to fit: equal to, or newer than, the checked version on the same major
 * line — omp adds, it has not changed what this adapter calls. An older build,
 * a different major line, or an unreadable version carries a warning.
 */
export function ompVersionWarning(version: string, writtenFor = "18.4.10"): string | null {
  const seen = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  const known = /^(\d+)\.(\d+)\.(\d+)/.exec(writtenFor);
  if (!seen || !known) return `omp ${version} is installed; this adapter's protocol types were written for ${writtenFor}`;
  const major = Number(seen[1]);
  const minor = Number(seen[2]);
  const patch = Number(seen[3]);
  const knownMajor = Number(known[1]);
  const knownMinor = Number(known[2]);
  const knownPatch = Number(known[3]);
  if (major !== knownMajor) return `omp ${version} is installed; this adapter's protocol types were written for ${writtenFor}, on a different major line`;
  if (minor < knownMinor || (minor === knownMinor && patch < knownPatch)) return `omp ${version} is older than ${writtenFor}, the version this adapter's protocol types were written for`;
  return null;
}
const READY_TIMEOUT_MS = 30_000;
const LISTER_IDLE_MS = 60_000;
const CONTEXT_REPORT_TIMEOUT_MS = 5_000;
/** omp's protocol v2 ceiling for one reassembled frame. */
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;
const FIRST_PROMPT_BYTES = 64 * 1024;
/** How much of a session file's end is read for its last message. */
const LAST_MESSAGE_BYTES = 64 * 1024;
/** omp's ACP `session/list` page size. */
const ACP_SESSION_PAGE = 50;

/** The session a session file was copied from (its header's `parentSession`: an id, or a path), or null. */
async function parentSessionOf(file: string): Promise<string | null> {
  const head = await fs
    .open(file, "r")
    .then(async (h) => {
      try {
        const buf = Buffer.alloc(16 * 1024);
        const { bytesRead } = await h.read(buf, 0, buf.length, 0);
        return buf.subarray(0, bytesRead).toString("utf8");
      } finally {
        await h.close();
      }
    })
    .catch(() => "");
  for (const line of head.split("\n").slice(0, 8)) {
    try {
      const entry = JSON.parse(line) as { type?: unknown; parentSession?: unknown };
      if (entry.type === "session") return typeof entry.parentSession === "string" && entry.parentSession ? entry.parentSession : null;
    } catch {
      // A line cut at the read's end, or not JSON.
    }
  }
  return null;
}

export interface OmpOptions {
  command?: string;
  /** config.yml's extra arguments for every chat child. */
  args?: string[];
  agentDir: string | null;
  sessionDir: string | null;
  home: string;
  env?: NodeJS.ProcessEnv;
}

/**
 * omp reads the same PI_* names as Pi. Values in the server's environment
 * belong to Pi and are stripped; omp overrides come from OMP_AGENT_DIR /
 * OMP_SESSION_DIR and are mapped onto omp's names for the child only.
 */
export function buildOmpEnv(base: NodeJS.ProcessEnv, agentDir: string | null, sessionDir: string | null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.PI_CODING_AGENT_DIR;
  delete env.PI_CODING_AGENT_SESSION_DIR;
  delete env.OMP_AGENT_DIR;
  delete env.OMP_SESSION_DIR;
  if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;
  if (sessionDir) env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  return env;
}

// Every omp child this process spawned; killed on shutdown and on exit.
const children = new Set<ChildProcessWithoutNullStreams>();
let exitHookInstalled = false;
function track(child: ChildProcessWithoutNullStreams): void {
  children.add(child);
  child.once("exit", () => children.delete(child));
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", () => {
      for (const c of children) c.kill("SIGKILL");
    });
  }
}

export function liveOmpChildren(): number {
  return children.size;
}

/** JSON-lines RPC over a child's stdio, used for both rpc-ui and acp. */
class LineProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly stderr: StderrTail;
  exited = false;
  private exitListeners = new Set<(message: string) => void>();

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, onLine: (frame: Obj) => void) {
    this.child = spawnHarness(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.stderr = new StderrTail(this.child);
    track(this.child);
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (isObj(frame)) onLine(frame);
    });
    this.child.stdin.on("error", () => undefined);
    const onExit = (detail: string) => {
      if (this.exited) return;
      this.exited = true;
      const reason = this.stderr.reason();
      for (const l of this.exitListeners) l(reason ? `${detail}: ${reason}` : detail);
    };
    this.child.once("error", (error) => onExit(`could not start omp (${error.message})`));
    this.child.once("exit", (code, signal) => onExit(`omp exited (${signal ?? `code ${code}`})`));
  }

  onExit(listener: (message: string) => void): void {
    this.exitListeners.add(listener);
  }

  write(frame: Obj): void {
    if (this.exited) throw new Error("omp is not running");
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  kill(): Promise<void> {
    return terminateChild(this.child);
  }
}

/**
 * omp's protocol v1 caps every stdout frame at 1 MiB: a bigger response fails
 * ("RPC response exceeded the transport limit"), so a long session's history
 * would not load, and a bigger event is trimmed. Protocol v2 sends such frames
 * as ordered `rpc_chunk` slices (base64, up to 64 MiB in all); this joins them.
 */
class ChunkJoiner {
  private pending: { id: string; count: number; byteLength: number; next: number; parts: Buffer[]; size: number } | null = null;

  /** The frame to handle, or null while a chunked one is incomplete (or turned out malformed). */
  push(frame: Obj): Obj | null {
    if (frame.type !== "rpc_chunk") {
      this.pending = null; // omp never interleaves; a broken sequence is dropped
      return frame;
    }
    const { chunkId, index, count, byteLength, data } = frame;
    const valid =
      typeof chunkId === "string" &&
      typeof data === "string" &&
      Number.isSafeInteger(index) &&
      Number.isSafeInteger(count) &&
      Number.isSafeInteger(byteLength) &&
      (byteLength as number) <= MAX_REASSEMBLED_BYTES;
    if (valid && index === 0) this.pending = { id: chunkId, count: count as number, byteLength: byteLength as number, next: 0, parts: [], size: 0 };
    const p = this.pending;
    if (!valid || !p || p.id !== chunkId || p.next !== index) {
      this.pending = null;
      return null;
    }
    const bytes = Buffer.from(data as string, "base64");
    p.parts.push(bytes);
    p.size += bytes.length;
    p.next += 1;
    if (p.next < p.count && p.size <= p.byteLength) return null;
    this.pending = null;
    if (p.next < p.count || p.size !== p.byteLength) return null;
    try {
      const whole: unknown = JSON.parse(Buffer.concat(p.parts).toString("utf8"));
      return isObj(whole) ? whole : null;
    } catch {
      return null;
    }
  }
}

/** One omp `--mode rpc-ui` process bound to one session. */
class OmpRpc {
  private proc: LineProcess;
  private readonly calls = new PendingRequests<string>(
    {
      formatId: (n) => String(n),
      encode: (id, payload) => ({ id, ...payload }),
      answeredId: (frame) => (frame.type === "response" && typeof frame.id === "string" ? frame.id : null),
      outcome: (frame) =>
        frame.success === true
          ? { value: frame.data }
          : { error: new Error(typeof frame.error === "string" ? frame.error : "omp command failed") },
    },
    (frame) => this.proc.write(frame),
  );
  private readyResolve!: () => void;
  private readyReject!: (e: Error) => void;
  readonly ready: Promise<void>;
  private chunks = new ChunkJoiner();

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, onEvent: (frame: Obj) => void, onExit: (m: string) => void) {
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.proc = new LineProcess(command, args, env, cwd, (line) => {
      const frame = this.chunks.push(line);
      if (!frame) return;
      if (frame.type === "ready") {
        const v2 = Array.isArray(frame.supportedProtocolVersions) && frame.supportedProtocolVersions.includes(2);
        if (!v2) return this.readyResolve();
        // Before anything else, so big responses and events arrive whole.
        void this.command("negotiate_protocol", { protocolVersion: 2 }, READY_TIMEOUT_MS).then(
          () => this.readyResolve(),
          () => this.readyResolve(),
        );
        return;
      }
      if (this.calls.accept(frame)) return;
      onEvent(frame);
    });
    const timer = setTimeout(() => this.readyReject(new Error("omp did not become ready")), READY_TIMEOUT_MS);
    void this.ready.then(() => clearTimeout(timer), () => clearTimeout(timer));
    this.proc.onExit((message) => {
      this.readyReject(new Error(message));
      this.calls.failAll(message);
      onExit(message);
    });
  }

  get exited(): boolean {
    return this.proc.exited;
  }

  command<T = unknown>(type: string, fields: Obj = {}, timeoutMs?: number | null): Promise<T> {
    return this.calls.send<T>({ type, ...fields }, `omp did not answer ${type}`, timeoutMs);
  }

  send(frame: Obj): void {
    this.proc.write(frame);
  }

  kill(): Promise<void> {
    return this.proc.kill();
  }
}

/** Lazily started `omp acp` used only for ACP `session/list`. */
class AcpLister {
  private proc: LineProcess | null = null;
  private initialized: Promise<void> | null = null;
  private readonly calls = new PendingRequests<number>(
    {
      formatId: (n) => n,
      encode: (id, payload) => ({ jsonrpc: "2.0", id, ...payload }),
      answeredId: (frame) => (typeof frame.id === "number" ? frame.id : null),
      outcome: (frame) =>
        isObj(frame.error) ? { error: new Error(String(frame.error.message ?? "ACP error")) } : { value: frame.result },
    },
    (frame) => this.proc?.write(frame),
  );
  private idleTimer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly command: string, private readonly env: () => NodeJS.ProcessEnv, private readonly cwd: string) {}

  private call(method: string, params: Obj): Promise<unknown> {
    if (!this.proc) return Promise.reject(new Error("omp acp is not running"));
    return this.calls.send({ method, params }, `omp acp did not answer ${method}`);
  }

  private start(): Promise<void> {
    if (this.proc && !this.proc.exited && this.initialized) return this.initialized;
    this.proc = new LineProcess(this.command, ["acp"], this.env(), this.cwd, (frame) => {
      this.calls.accept(frame);
    });
    this.proc.onExit((message) => {
      this.calls.failAll(message);
      this.proc = null;
      this.initialized = null;
    });
    this.initialized = this.call("initialize", { protocolVersion: 1, clientCapabilities: {} }).then(() => undefined);
    return this.initialized;
  }

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => void this.stop(), LISTER_IDLE_MS);
    this.idleTimer.unref();
  }

  /** Sessions in `cwd`, or across every project (newest first) when it is omitted. */
  list(cwd?: string, maxPages = 20): Promise<RecentNativeSession[]> {
    const job = this.chain.then(async () => {
      await this.start();
      this.touch();
      const out: RecentNativeSession[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < maxPages; page++) {
        const result = (await this.call("session/list", { ...(cwd ? { cwd } : {}), ...(cursor ? { cursor } : {}) })) as Obj;
        const sessions = Array.isArray(result?.sessions) ? result.sessions : [];
        for (const s of sessions) {
          if (!isObj(s) || typeof s.sessionId !== "string") continue;
          if (cwd && typeof s.cwd === "string" && s.cwd !== cwd) continue;
          const sessionCwd = typeof s.cwd === "string" ? s.cwd : "";
          const meta = isObj(s._meta) ? s._meta : {};
          out.push({
            nativeId: s.sessionId,
            cwd: sessionCwd,
            title: typeof s.title === "string" ? s.title.trim() : "",
            updatedAt: typeof s.updatedAt === "string" ? new Date(s.updatedAt) : null,
            ...(typeof meta.messageCount === "number" ? { messageCount: meta.messageCount } : {}),
          });
        }
        cursor = typeof result?.nextCursor === "string" ? result.nextCursor : undefined;
        if (!cursor) break;
      }
      this.touch();
      return out;
    });
    this.chain = job.catch(() => undefined);
    return job;
  }

  async stop(): Promise<void> {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    const proc = this.proc;
    this.proc = null;
    this.initialized = null;
    await proc?.kill();
  }
}

function toModelInfo(m: unknown): ModelInfo | null {
  if (!isObj(m) || typeof m.provider !== "string" || typeof m.id !== "string") return null;
  const efforts = isObj(m.thinking) && Array.isArray(m.thinking.efforts) ? m.thinking.efforts.filter((l): l is string => typeof l === "string") : [];
  return {
    key: `${m.provider}/${m.id}`,
    provider: m.provider,
    id: m.id,
    name: typeof m.name === "string" ? m.name : m.id,
    ...(typeof m.reasoning === "boolean" ? { reasoning: m.reasoning } : {}),
    ...(Array.isArray(m.input) ? { vision: m.input.includes("image") } : {}),
    ...(efforts.length > 0 ? { levels: efforts } : {}),
  };
}

/**
 * Categories from omp's own `/context` text (slash-commands/helpers/context-report.ts):
 * `  <label> [<bar>] <pct>%  <n> tokens`, the bar ANSI-coloured. Free space and the
 * auto-compact buffer are not usage.
 */
export function parseContextReport(text: string): ContextCategory[] | null {
  const plain = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (!/^Context window: \d+ tokens/m.test(plain)) return null;
  const categories: ContextCategory[] = [];
  for (const line of plain.split("\n")) {
    const m = /^ {2}(\S[^[]*?)\s+\[.*?\].*?\s(\d+) tokens$/.exec(line);
    if (!m?.[1] || !m[2]) continue;
    const label = m[1].trim();
    if (label === "Free" || label.startsWith("Auto-compact")) continue;
    categories.push({ id: label.toLowerCase().replace(/[^a-z]+/g, "-"), label, tokens: Number(m[2]) });
  }
  return categories.length > 0 ? categories : null;
}

/** omp's RPC takes pi-ai ImageContent on prompt, steer, and follow_up. */
function withImages(message: string, images: ImageAttachment[] | undefined): Obj {
  return images?.length ? { message, images: images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType })) } : { message };
}

/** The first user prompt in an omp session file (JSONL), on one line, or null. */
export function firstPrompt(jsonl: string): string | null {
  for (const line of jsonl.split("\n")) {
    if (!line.includes('"user"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the read window can cut the last line short
    }
    if (!isObj(entry) || entry.type !== "message" || !isObj(entry.message) || entry.message.role !== "user") continue;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.map((b) => (isObj(b) && b.type === "text" && typeof b.text === "string" ? b.text : "")).join(" ")
          : "";
    const clean = text.replace(/\s+/g, " ").trim();
    if (clean) return clean.length > 80 ? `${clean.slice(0, 79)}…` : clean;
  }
  return null;
}

/**
 * When the newest message in an omp session file's tail (JSONL) was written,
 * or null. Other entries do not count: omp appends a `session_exit` every time
 * its process ends, so merely opening a chat and closing it again would
 * otherwise make it the newest.
 */
export function lastMessageAt(jsonl: string): Date | null {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i] as string;
    if (!line.includes('"message"')) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // the read window can cut the first line short
    }
    if (!isObj(entry) || entry.type !== "message") continue;
    const at = typeof entry.timestamp === "number" ? entry.timestamp : Date.parse(String(entry.timestamp ?? ""));
    if (Number.isFinite(at)) return new Date(at);
  }
  return null;
}

/**
 * What ACP `session/list` gets wrong, read from the session files themselves.
 * Its title stays empty when omp's title generation never ran (a run that
 * ended on tool calls, say); omp's own picker then shows the first prompt, and
 * so does this. Its `updatedAt` moves whenever omp writes anything, including
 * the `session_exit` it records on every shutdown, so a chat only opened and
 * closed would jump to the top; recency is the last message instead.
 * Read-only: the first and last 64 kB of `<sessionDir>/<cwd>/<time>_<id>.jsonl`,
 * cached by file size.
 */
class SessionFiles {
  private titles = new Map<string, { size: number; title: string | null }>();
  private recency = new Map<string, { size: number; at: Date | null }>();
  private files = new Map<string, string>();

  constructor(private readonly root: () => Promise<string>) {}

  /** Titles and recency corrected from the files, newest first. */
  async fill<T extends NativeSessionSummary>(sessions: T[]): Promise<T[]> {
    const files = await this.locate(new Set(sessions.map((s) => s.nativeId)));
    await Promise.all(
      sessions.map(async (s) => {
        const file = files.get(s.nativeId);
        if (!s.title) s.title = (file ? await this.title(s.nativeId, file) : null) ?? "Untitled";
        const at = file ? await this.lastMessage(s.nativeId, file) : null;
        if (at) s.updatedAt = at;
      }),
    );
    return sessions.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
  }

  private async locate(ids: Set<string>): Promise<Map<string, string>> {
    const missing = [...ids].filter((id) => !this.files.has(id));
    if (missing.length > 0) {
      const wanted = new Set(missing);
      const root = await this.root();
      const dirs = await fs.readdir(root).catch(() => [] as string[]);
      await Promise.all(
        dirs.map(async (dir) => {
          for (const name of await fs.readdir(path.join(root, dir)).catch(() => [] as string[])) {
            const id = name.endsWith(".jsonl") ? name.slice(name.lastIndexOf("_") + 1, -".jsonl".length) : "";
            if (wanted.has(id)) this.files.set(id, path.join(root, dir, name));
          }
        }),
      );
    }
    const found = new Map<string, string>();
    for (const id of ids) {
      const file = this.files.get(id);
      if (file) found.set(id, file);
    }
    return found;
  }

  /** `bytes` of the file from its start or its end, or null when unchanged since `cachedSize`. */
  private async readWindow(file: string, bytes: number, fromEnd: boolean, cachedSize: number | undefined): Promise<{ size: number; text: string | null } | null> {
    let handle: fs.FileHandle | undefined;
    try {
      handle = await fs.open(file, "r");
      const { size } = await handle.stat();
      if (cachedSize === size) return { size, text: null };
      const length = Math.min(size, bytes);
      const buf = Buffer.alloc(length);
      await handle.read(buf, 0, length, fromEnd ? size - length : 0);
      return { size, text: buf.toString("utf8") };
    } catch {
      // Moved or deleted: look it up again next time.
      for (const [id, f] of this.files) if (f === file) this.files.delete(id);
      return null;
    } finally {
      await handle?.close();
    }
  }

  private async title(id: string, file: string): Promise<string | null> {
    const cached = this.titles.get(id);
    const read = await this.readWindow(file, FIRST_PROMPT_BYTES, false, cached?.size);
    if (!read) return null;
    if (read.text === null) return cached?.title ?? null;
    const title = firstPrompt(read.text);
    this.titles.set(id, { size: read.size, title });
    return title;
  }

  private async lastMessage(id: string, file: string): Promise<Date | null> {
    const cached = this.recency.get(id);
    const read = await this.readWindow(file, LAST_MESSAGE_BYTES, true, cached?.size);
    if (!read) return null;
    if (read.text === null) return cached?.at ?? null;
    const at = lastMessageAt(read.text);
    this.recency.set(id, { size: read.size, at });
    return at;
  }
}

export class OmpAdapter implements HarnessAdapter {
  readonly id = asHarnessId("omp");
  readonly displayName = "omp";
  readonly accent = "thinking";
  readonly setupCommand = "omp";
  readonly cliCommand: string;
  readonly capabilities: HarnessCapabilities = {
    supportsSteer: true,
    supportsFollowUp: true,
    supportsThinkingLevel: true,
    supportsCompact: true,
    supportsExtensions: true,
    supportsInteractiveRequests: true,
    supportsRename: true,
    supportsModelSelection: true,
    supportsFork: true,
    supportsHandoff: true,
    supportsRewind: rewindExtension() !== null,
    supportsHtmlRender: renderHtmlExtension() !== null,
    supportsQueueEdit: true,
    supportsPermissionMode: false,
    supportsResumeCommand: false,
  };
  private lister: AcpLister;
  private sessionFiles = new SessionFiles(() => this.resolveSessionDir());
  private probeCache = new Map<string, { at: number; models: ModelInfo[]; levels: string[]; defaultModel: { model: string; thinkingLevel: string | null } | null }>();

  constructor(private readonly options: OmpOptions) {
    this.cliCommand = options.command ?? "omp";
    this.lister = new AcpLister(this.cliCommand, () => this.env(), options.home);
  }

  env(renderEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    return { ...buildOmpEnv(this.options.env ?? process.env, this.options.agentDir, this.options.sessionDir), ...renderEnv };
  }

  /** Every signed-in account's limits; omp asks each provider, which takes a few seconds. */
  async usageLimits(): Promise<LimitAccount[]> {
    const { stdout } = await execHarness(this.cliCommand, ["usage", "--json", "--redact"], { timeout: 30_000, env: this.env(), maxBuffer: 4 * 1024 * 1024 });
    return ompLimits(JSON.parse(stdout) as unknown);
  }

  async discover(): Promise<HarnessDiscovery> {
    const overrides = {
      OMP_AGENT_DIR: this.options.agentDir ? "set" : "unset",
      OMP_SESSION_DIR: this.options.sessionDir ? "set" : "unset",
    } as const;
    const warnings: string[] = [];
    try {
      const { stdout } = await execHarness(this.cliCommand, ["--version"], { timeout: 15_000, env: this.env() });
      const label = versionLabel(stdout.trim().replace(/^omp\//, ""));
      const warning = ompVersionWarning(label.version);
      if (warning) warnings.push(warning);
      return { available: true, ...label, warnings, overrides };
    } catch {
      return {
        available: false,
        reason: "The omp CLI is not installed. Install omp, run it once, and log in.",
        warnings,
        overrides,
      };
    }
  }

  workspaceProblem(cwd: string): string | null {
    if (path.resolve(cwd) === path.resolve(this.options.home)) {
      return "omp refuses to work in the home directory itself (it would switch to a temp dir). Pick a project folder.";
    }
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    return this.options.agentDir ?? path.join(this.options.home, ".omp", "agent");
  }

  async resolveSessionDir(): Promise<string> {
    return this.options.sessionDir ?? path.join(await this.resolveAgentDir(), "sessions");
  }

  async listSessions(cwd: string): Promise<NativeSessionSummary[]> {
    return this.sessionFiles.fill(await this.lister.list(cwd));
  }

  async listRecentSessions(limit: number): Promise<RecentNativeSession[]> {
    const pages = Math.max(1, Math.ceil(limit / ACP_SESSION_PAGE));
    return (await this.sessionFiles.fill((await this.lister.list(undefined, pages)).filter((s) => s.cwd))).slice(0, limit);
  }

  /**
   * omp keeps each subagent's transcript beside its parent session:
   * `<session>/<id>.jsonl`, and a nested agent's as `<session>/<parent>/<parent>.<id>.jsonl`.
   */
  async subagentTranscriptFile(chat: { nativeId: string; cwd: string }, run: SubagentRun): Promise<string | null> {
    const runId = run.id;
    if (!/^[\w.-]{1,128}$/.test(runId)) return null;
    let file = await this.sessionFile(chat.nativeId);
    if (!file) return null;
    const search = async (dir: string, depth: number): Promise<string | null> => {
      const names = await fs.readdir(dir).catch(() => [] as string[]);
      const hit = names.find((n) => n === `${runId}.jsonl` || n.endsWith(`.${runId}.jsonl`));
      if (hit) return path.join(dir, hit);
      if (depth === 0) return null;
      for (const name of names) {
        if (name.includes(".")) continue;
        const found = await search(path.join(dir, name), depth - 1);
        if (found) return found;
      }
      return null;
    };
    // A session omp copied (its parentSession) keeps the delegation calls but not their
    // transcripts, which stay in the original's folder: follow the copies back a few steps.
    for (let hop = 0; file && hop < 4; hop += 1) {
      const found = await search(file.slice(0, -".jsonl".length), 3);
      if (found) return found;
      const parent = await parentSessionOf(file);
      file = parent ? ((path.isAbsolute(parent) ? parent : await this.sessionFile(parent)) ?? null) : null;
    }
    return null;
  }

  /** The .jsonl of a session, across the store's per-project buckets. */
  private async sessionFile(nativeId: string): Promise<string | null> {
    const root = await this.resolveSessionDir();
    for (const dir of await fs.readdir(root).catch(() => [] as string[])) {
      for (const name of await fs.readdir(path.join(root, dir)).catch(() => [] as string[])) {
        if (name.endsWith(".jsonl") && name.slice(name.lastIndexOf("_") + 1, -".jsonl".length) === nativeId) return path.join(root, dir, name);
      }
    }
    return null;
  }

  /**
   * omp has no entry-indexed fork (its CLI only copies whole sessions and its RPC
   * branch moves the leaf in place), so the copy is written here: same branch,
   * cut after the Nth user turn, fresh id in the header and file name.
   */
  async forkSession(req: { cwd: string; nativeId: string; throughTurns: number }): Promise<{ nativeId: string }> {
    const file = await this.sessionFile(req.nativeId);
    if (!file) throw new Error(`omp session ${req.nativeId} is not on disk`);
    const source = await fs.readFile(file, "utf8");
    const id = uuidv7();
    const now = new Date();
    const body = forkSessionText(source, { throughTurns: req.throughTurns, id, now, cwd: req.cwd, parentSession: req.nativeId });
    const target = path.join(path.dirname(file), `${sessionFileTimestamp(now)}_${id}.jsonl`);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body, { mode: 0o600 });
    await fs.rename(tmp, target);
    return { nativeId: id };
  }

  /**
   * The transcript from the session's file, as omp's get_messages lists it:
   * omp leaves out model calls that failed or were aborted, so they are left
   * out here too (checked against omp on real sessions, item for item).
   */
  async readUsage(req: { cwd: string; nativeId: string }): Promise<UsageEntry[] | null> {
    const file = await this.sessionFile(req.nativeId);
    const text = file ? await fs.readFile(file, "utf8").catch(() => null) : null;
    if (text === null) return null;
    const head = text.slice(0, text.indexOf("\n") >= 0 ? text.indexOf("\n") : text.length);
    try {
      const parsed: unknown = JSON.parse(head);
      if (isObj(parsed) && typeof parsed.cwd === "string" && path.resolve(parsed.cwd) !== path.resolve(req.cwd)) return null;
    } catch {
      // no header line
    }
    return usageEntries(fileMessages(text));
  }

  async readTranscript(req: { cwd: string; nativeId: string }): Promise<{ items: ChatItem[]; title: string | null } | null> {
    const file = await this.sessionFile(req.nativeId);
    const text = file ? await fs.readFile(file, "utf8").catch(() => null) : null;
    if (text === null) return null;
    let title: string | null = null;
    let cwd: string | null = null;
    for (const line of text.split("\n", 2)) {
      try {
        const head: unknown = JSON.parse(line);
        if (!isObj(head)) continue;
        if (typeof head.title === "string" && head.title.trim()) title = head.title.trim();
        if (head.type === "session" && typeof head.cwd === "string") cwd = head.cwd;
      } catch {
        // not a header line
      }
    }
    if (cwd && path.resolve(cwd) !== path.resolve(req.cwd)) return null;
    const messages = branchMessages(text).filter((m) => !(isObj(m) && m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted")));
    return { items: historyToItems(messages), title };
  }

  /**
   * A new session file holding the seed, then resumed like any other. Where
   * that file goes (per-project bucket, or flat under a session-dir override)
   * is omp's call, so a fresh child names the path and id it would use; it
   * writes nothing before a first prompt, so the file is ours to create.
   */
  async seedChat(req: { cwd: string; seed: HandoffSeed }): Promise<LiveChat> {
    const fresh = new OmpRpc(this.cliCommand, ["--mode", "rpc-ui", ...rewindExtensionArgs(), "--cwd", req.cwd], this.env(), req.cwd, () => undefined, () => undefined);
    let state: Obj | null;
    try {
      await fresh.ready;
      state = await fresh.command<Obj>("get_state");
    } finally {
      await fresh.kill();
    }
    const id = typeof state?.sessionId === "string" ? state.sessionId : "";
    const file = typeof state?.sessionFile === "string" ? state.sessionFile : "";
    if (!id || !file.endsWith(`_${id}.jsonl`)) throw new Error("omp did not say where a new session goes");
    const body = seedSessionText({ id, cwd: path.resolve(req.cwd), now: new Date(), entries: seedTranscript(req.seed) });
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body, { mode: 0o600, flag: "wx" });
    await fs.link(tmp, file).finally(() => fs.unlink(tmp).catch(() => undefined));
    const chat = new OmpLiveChat(this.cliCommand, () => this.env(), req.cwd, undefined, this.options.args);
    await chat.start(id);
    if (req.seed.title) await chat.rename(req.seed.title).catch(() => undefined);
    return chat;
  }

  /** One throwaway `--no-session` child per workspace (cached) for models and thinking levels. */
  private async probe(cwd: string): Promise<{ models: ModelInfo[]; levels: string[]; defaultModel: { model: string; thinkingLevel: string | null } | null }> {
    const cached = this.probeCache.get(cwd);
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached;
    const rpc = new OmpRpc(this.cliCommand, ["--mode", "rpc-ui", "--no-session", "--cwd", cwd], this.env(), cwd, () => undefined, () => undefined);
    try {
      await rpc.ready;
      const models = await rpc.command<Obj>("get_available_models");
      const levels = await rpc.command<Obj>("get_available_thinking_levels");
      // A sessionless child still answers get_state with the model and thinking level a new session
      // would start on; that is the default the start screen names instead of "Default model".
      const state = await rpc.command<Obj>("get_state").catch(() => null);
      const defModel = state ? toModelInfo(state.model) : null;
      const result = {
        at: Date.now(),
        models: (Array.isArray(models?.models) ? models.models : []).map(toModelInfo).filter((m): m is ModelInfo => m !== null),
        levels: Array.isArray(levels?.levels) ? levels.levels.map(String) : [],
        defaultModel: defModel ? { model: defModel.key, thinkingLevel: typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null } : null,
      };
      this.probeCache.set(cwd, result);
      return result;
    } finally {
      await rpc.kill();
    }
  }

  async listModels(cwd: string): Promise<ModelInfo[]> {
    return (await this.probe(cwd)).models;
  }

  async listThinkingLevels(cwd: string): Promise<string[]> {
    return (await this.probe(cwd)).levels;
  }

  async defaultModel(cwd: string): Promise<{ model: string; thinkingLevel: string | null } | null> {
    return (await this.probe(cwd)).defaultModel;
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    const problem = this.workspaceProblem(req.cwd);
    if (problem) throw new Error(problem);
    const chat = new OmpLiveChat(this.cliCommand, () => this.env(), req.cwd, req.renderEnv, this.options.args);
    await chat.start(req.resumeNativeId ?? null);
    return chat;
  }

  async shutdown(): Promise<void> {
    await this.lister.stop();
  }
}

interface OpenDialog {
  kind: InteractionKind;
}

class OmpLiveChat implements LiveChat {
  private hub = new EventHub();
  private rpc: OmpRpc | null = null;
  private generation = 0;
  private dialogs = new Map<string, OpenDialog>();
  private queue: QueueState = { steering: [], followUp: [] };
  /** Whether /context is an omp builtin (checked once), the pending probe, and their queue. */
  private contextBuiltin: Promise<boolean> | null = null;
  private contextProbe: ((text: string) => void) | null = null;
  /** Output of a "/" command in flight, held until omp says whether it ran locally. */
  private commandOutput: string[] | null = null;
  private contextChain: Promise<unknown> = Promise.resolve();
  private models: ModelInfo[] | null = null;
  private sessionId: string | null = null;
  private sessionName: string | null = null;
  private disposed = false;

  constructor(
    private readonly command: string,
    private readonly env: () => NodeJS.ProcessEnv,
    private readonly cwd: string,
    private readonly renderEnv?: NodeJS.ProcessEnv,
    private readonly extraArgs: string[] = [],
  ) {}

  get nativeId(): string | null {
    return this.sessionId;
  }

  get title(): string | null {
    return this.sessionName;
  }

  private get live(): OmpRpc {
    if (!this.rpc || this.rpc.exited) throw new Error("omp is not running for this chat");
    return this.rpc;
  }

  /** Spawn the omp child with its normal tool set (no --tools); stale-child events are ignored. */
  async start(resumeId: string | null): Promise<void> {
    const generation = ++this.generation;
    const args = ["--mode", "rpc-ui", ...rewindExtensionArgs(), ...renderHtmlExtensionArgs(), ...this.extraArgs, "--cwd", this.cwd];
    if (resumeId) args.push("--resume", resumeId);
    const rpc = new OmpRpc(
      this.command,
      args,
      { ...this.env(), ...this.renderEnv },
      this.cwd,
      (frame) => {
        if (generation === this.generation) this.onFrame(frame);
      },
      (message) => {
        if (generation !== this.generation || this.disposed) return;
        this.cancelDialogs();
        this.hub.emit({ type: "fatal", message: `omp stopped unexpectedly (${message})` });
      },
    );
    this.rpc = rpc;
    try {
      await rpc.ready;
      const state = await rpc.command<Obj>("get_state");
      const sessionId = typeof state?.sessionId === "string" ? state.sessionId : null;
      if (resumeId && sessionId !== resumeId) throw new Error("omp opened a different session than requested");
      this.sessionId = sessionId;
      this.sessionName = typeof state?.sessionName === "string" && state.sessionName ? state.sessionName : null;
      if (sessionId) this.hub.emit({ type: "session", nativeId: sessionId });
    } catch (error) {
      await rpc.kill();
      throw error;
    }
  }

  private onFrame(frame: Obj): void {
    switch (frame.type) {
      case "extension_ui_request":
        this.onUiRequest(frame);
        return;
      case "prompt_result": {
        if (frame.status === "error" && isObj(frame.error) && typeof frame.error.message === "string") {
          this.hub.emit({ type: "notice", level: "error", text: frame.error.message });
        }
        if (frame.sessionSettled === true) this.hub.emit({ type: "settled" });
        return;
      }
      case "extension_error":
        this.hub.emit({ type: "notice", level: "error", text: `Extension error: ${String(frame.error ?? "unknown")}` });
        return;
      case "command_output":
        // Output of a builtin slash command: the context probe's, or one the user typed.
        if (this.contextProbe) this.contextProbe(String(frame.text ?? ""));
        else if (typeof frame.text === "string" && frame.text.trim()) {
          if (this.commandOutput) this.commandOutput.push(frame.text);
          else this.hub.emit({ type: "notice", level: "info", text: frame.text });
        }
        return;
      case "queue_update":
        this.queue = {
          steering: Array.isArray(frame.steering) ? frame.steering.map(String) : [],
          followUp: Array.isArray(frame.followUp) ? frame.followUp.map(String) : [],
        };
        break;
      case "session_info_changed":
        if (typeof frame.name === "string") this.sessionName = frame.name;
        break;
      default:
        break;
    }
    for (const event of normalizeAgentEvent(frame, "session_settled")) this.hub.emit(event);
  }

  private onUiRequest(frame: Obj): void {
    const id = typeof frame.id === "string" ? frame.id : null;
    if (!id) return;
    const method = frame.method;
    if (method === "select" || method === "confirm" || method === "input" || method === "editor") {
      const timeout = typeof frame.timeout === "number" ? frame.timeout : undefined;
      this.dialogs.set(id, { kind: method });
      this.hub.emit({
        type: "request",
        request: {
          id,
          kind: method,
          title: String(frame.title ?? ""),
          createdAt: Date.now(),
          ...(typeof frame.message === "string" ? { message: frame.message } : {}),
          ...(Array.isArray(frame.options) ? { options: frame.options.map(String) } : {}),
          ...(typeof frame.placeholder === "string" ? { placeholder: frame.placeholder } : {}),
          ...(typeof frame.prefill === "string" ? { prefill: frame.prefill } : {}),
          ...(timeout ? { expiresAt: Date.now() + timeout } : {}),
        },
      });
      return;
    }
    switch (method) {
      case "cancel": {
        const target = String(frame.targetId ?? "");
        if (this.dialogs.delete(target)) this.hub.emit({ type: "request_cancelled", requestId: target, outcome: "cancelled" });
        return;
      }
      case "notify": {
        const level = frame.notifyType === "error" || frame.notifyType === "warning" ? frame.notifyType : "info";
        this.hub.emit({ type: "notice", level, text: String(frame.message ?? "") });
        return;
      }
      case "setStatus":
        this.hub.emit({
          type: "extension_status",
          key: String(frame.statusKey ?? "status"),
          text: typeof frame.statusText === "string" ? frame.statusText : null,
        });
        return;
      case "setWidget":
        this.hub.emit({
          type: "extension_status",
          key: `widget:${String(frame.widgetKey ?? "widget")}`,
          text: Array.isArray(frame.widgetLines) ? frame.widgetLines.map(String).join("\n") : null,
        });
        return;
      case "open_url":
        this.hub.emit({
          type: "notice",
          level: "info",
          text: `omp asks to open ${String(frame.url ?? "a URL")}${frame.instructions ? ` — ${String(frame.instructions)}` : ""}`,
        });
        return;
      default:
        return;
    }
  }

  private respond(id: string, fields: Obj): void {
    try {
      this.rpc?.send({ type: "extension_ui_response", id, ...fields });
    } catch {
      // The child is gone; its dialogs died with it.
    }
  }

  private cancelDialogs(): void {
    for (const id of [...this.dialogs.keys()]) {
      this.dialogs.delete(id);
      this.respond(id, { cancelled: true });
      this.hub.emit({ type: "request_cancelled", requestId: id, outcome: "cancelled" });
    }
  }

  subscribe(listener: HarnessEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async history(): Promise<ChatItem[]> {
    const data = await this.live.command<Obj>("get_messages");
    return historyToItems(Array.isArray(data?.messages) ? data.messages : []);
  }

  /** omp has no refresh command; get_available_models waits for its own background refresh. */
  async refreshModels(): Promise<void> {
    this.models = null;
  }

  async getConfig(): Promise<ChatConfig> {
    const rpc = this.live;
    const state = await rpc.command<Obj>("get_state");
    if (!this.models) {
      const data = await rpc.command<Obj>("get_available_models");
      this.models = (Array.isArray(data?.models) ? data.models : []).map(toModelInfo).filter((m): m is ModelInfo => m !== null);
    }
    const levels = await rpc.command<Obj>("get_available_thinking_levels");
    const model = toModelInfo(state?.model);
    return {
      model: model?.key ?? null,
      thinkingLevel: typeof state?.thinkingLevel === "string" ? state.thinkingLevel : null,
      models: this.models,
      thinkingLevels: Array.isArray(levels?.levels) ? levels.levels.map(String) : [],
    };
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const state = await this.live.command<Obj>("get_state");
    const usage = state?.contextUsage;
    if (!isObj(usage) || typeof usage.contextWindow !== "number") return null;
    // Only while settled, so the probe can never land inside a run.
    const categories = state?.isSettled === true ? await this.contextReport() : null;
    return {
      tokens: typeof usage.tokens === "number" ? usage.tokens : null,
      window: usage.contextWindow,
      percent: typeof usage.percent === "number" ? usage.percent : null,
      ...(categories ? { categories } : {}),
    };
  }

  /**
   * omp's `/context` breakdown. RPC runs that builtin locally and answers with
   * `command_output` (agentInvoked: false), so no model is called; it is only
   * sent once get_available_commands confirms /context is a builtin.
   */
  private contextReport(): Promise<ContextCategory[] | null> {
    const job = this.contextChain.then(async () => {
      this.contextBuiltin ??= this.live.command<Obj>("get_available_commands").then(
        (data) => Array.isArray(data?.commands) && data.commands.some((c) => isObj(c) && c.name === "context" && c.source === "builtin"),
        () => false,
      );
      if (!(await this.contextBuiltin)) return null;
      const output = new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => resolve(null), CONTEXT_REPORT_TIMEOUT_MS);
        this.contextProbe = (text) => {
          clearTimeout(timer);
          resolve(text);
        };
      });
      try {
        await this.live.command("prompt", { message: "/context" });
        return parseContextReport((await output) ?? "");
      } finally {
        this.contextProbe = null;
      }
    });
    this.contextChain = job.catch(() => undefined);
    return job.catch(() => null);
  }

  async getUsage(): Promise<HarnessUsage | null> {
    const stats = await this.live.command<Obj>("get_session_stats");
    const tokens = isObj(stats?.tokens) ? stats.tokens : null;
    if (!stats || !tokens) return null;
    const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    return {
      turns: n(stats.userMessages),
      steps: n(stats.assistantMessages),
      input: n(tokens.input),
      cachedInput: n(tokens.cacheRead),
      cacheWrite: n(tokens.cacheWrite),
      output: n(tokens.output),
      cost: n(stats.cost) > 0 ? n(stats.cost) : null,
    };
  }

  /** omp lists only commands that run over RPC: builtins with a text handler, skills, extensions, files, MCP prompts. */
  async listCommands(): Promise<SlashCommand[]> {
    const data = await this.live.command<Obj>("get_available_commands");
    return (Array.isArray(data?.commands) ? data.commands : []).flatMap((c): SlashCommand[] => {
      if (!isObj(c) || typeof c.name !== "string") return [];
      const hint = isObj(c.input) && typeof c.input.hint === "string" ? c.input.hint : "";
      return [
        {
          name: c.name,
          ...(typeof c.description === "string" && c.description ? { description: c.description } : {}),
          ...(hint ? { hint } : {}),
          source: typeof c.source === "string" ? c.source : "builtin",
        },
      ];
    });
  }

  /** omp's todo phases (`get_state.todoPhases`), flattened. */
  async getTodos(): Promise<TodoItem[]> {
    const state = await this.live.command<Obj>("get_state");
    return todoPhaseItems(state?.todoPhases);
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    // A "/" command may run locally; its output comes before the response that says so.
    this.commandOutput = text.trim().startsWith("/") ? [] : null;
    let result: Obj | undefined;
    try {
      result = await this.live.command<Obj>("prompt", withImages(text, images));
    } finally {
      const outputs = this.commandOutput ?? [];
      this.commandOutput = null;
      // A builtin (/context, /usage...) runs locally: no turn and no prompt_result, so show the
      // command as the prompt, then its output, and settle here.
      if (isObj(result) && result.agentInvoked === false) {
        for (const event of commandOutputEvents(text.trim(), outputs.join("\n\n"))) this.hub.emit(event);
        this.hub.emit({ type: "settled" });
      } else for (const output of outputs) this.hub.emit({ type: "notice", level: "info", text: output });
    }
  }

  /** In place, through the /rewind-to extension this child was started with. */
  async rewind(turn: number, text: string, images?: ImageAttachment[]): Promise<void> {
    await rewindWithExtension("omp", turn, {
      commandNames: async () => (await this.listCommands()).map((c) => c.name),
      runCommand: async (command) => {
        // An extension command answers with a bare success; the history check below says whether it worked.
        const result = await this.live.command<Obj>("prompt", { message: command });
        return !(isObj(result) && result.agentInvoked === true);
      },
      history: () => this.history(),
    });
    await this.prompt(text, images);
  }

  async steer(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.live.command("steer", withImages(text, images));
  }

  async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.live.command("follow_up", withImages(text, images));
  }

  /** omp takes queued messages back one at a time, by text; the new ones go back in order. */
  async replaceQueue(queue: QueueState): Promise<void> {
    const rpc = this.live;
    for (const message of this.queue.steering) await rpc.command("remove_queued_message", { message, queue: "steering" }).catch(() => undefined);
    for (const message of this.queue.followUp) await rpc.command("remove_queued_message", { message, queue: "followUp" }).catch(() => undefined);
    for (const text of queue.steering) await rpc.command("steer", withImages(text, undefined));
    for (const text of queue.followUp) await rpc.command("follow_up", withImages(text, undefined));
  }

  async abort(): Promise<void> {
    this.cancelDialogs();
    const rpc = this.live;
    for (const message of this.queue.steering) await rpc.command("remove_queued_message", { message, queue: "steering" }).catch(() => undefined);
    for (const message of this.queue.followUp) await rpc.command("remove_queued_message", { message, queue: "followUp" }).catch(() => undefined);
    await rpc.command("abort");
  }

  async setConfig(patch: { model?: string; thinkingLevel?: string }): Promise<void> {
    if (patch.model !== undefined) {
      const slash = patch.model.indexOf("/");
      if (slash <= 0) throw new Error("Model must be provider/id");
      await this.live.command("set_model", { provider: patch.model.slice(0, slash), modelId: patch.model.slice(slash + 1) });
    }
    if (patch.thinkingLevel !== undefined) {
      await this.live.command("set_thinking_level", { level: patch.thinkingLevel });
    }
  }

  async rename(name: string): Promise<void> {
    await this.live.command("set_session_name", { name });
    this.sessionName = name;
  }

  async compact(instructions?: string): Promise<void> {
    await this.live.command("compact", instructions ? { customInstructions: instructions } : {}, null);
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    const dialog = this.dialogs.get(requestId);
    if (!dialog || !this.rpc || this.rpc.exited) return false;
    this.dialogs.delete(requestId);
    switch (answer.kind) {
      case "cancel":
        this.respond(requestId, { cancelled: true });
        break;
      case "confirm":
        this.respond(requestId, { confirmed: answer.confirmed });
        break;
      default:
        this.respond(requestId, { value: answer.value });
        break;
    }
    return true;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelDialogs();
    this.hub.clear();
    const rpc = this.rpc;
    this.rpc = null;
    await rpc?.kill();
  }
}
