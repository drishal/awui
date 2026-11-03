// Hermes adapter: the profile gateway is the agent. Every Hermes surface — its Ink
// TUI, the desktop app, the dashboard — runs chats through the one gateway that owns
// the profile home (`~/.hermes/gateway.lock`), and so does awui: it attaches over that
// gateway's canonical WebSocket (hermes-gateway.ts, with hermes-canonical.ts speaking
// its session dialect), starting one with `hermes gateway ensure` when none runs.
// The stdio `python -m tui_gateway.entry` child this used to start per chat remains
// only as the fallback for a home no gateway runs against (Hermes retired that entry
// point as a product surface in 2026.9.24 and it refuses to start beside a live
// owner); probes share the same two paths.
//
// On the wire: client→server requests with an id, `event` notifications from
// the gateway, and server→client requests for human decisions (approval,
// clarify) that arrive as ordinary JSON-RPC requests with `srq-…` ids and are
// answered with ordinary JSON-RPC responses.
import { DatabaseSync } from "node:sqlite";
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { execHarness, spawnHarness } from "../platform-win.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import {
  asHarnessId,
  type ChatConfig,
  type ChatItem,
  type ContextUsage,
  type HarnessCapabilities,
  type ImageAttachment,
  type InteractionAnswer,
  type ModelInfo,
  type SlashCommand,
  type TodoItem,
} from "../../shared/protocol.js";
import { boundText, commandOutputEvents, historyToItems, isObj, type Obj } from "./agent-events.js";
import { PendingRequests, StderrTail, terminateChild } from "./child-process.js";
import {
  GatewaySocket,
  HermesRpcError,
  gatewayEndpoint,
  gatewayTicket,
  hermesCodec,
  type GatewayEndpoint,
  type GatewayFrame,
  type GatewayLink,
} from "./hermes-gateway.js";
import { CanonicalChatLink } from "./hermes-canonical.js";
import { versionLabel } from "./version.js";
import { EventHub } from "./event-hub.js";
import type {
  HarnessAdapter,
  HarnessDiscovery,
  HarnessEvent,
  HarnessEventListener,
  HarnessUsage,
  LiveChat,
  NativeSessionSummary,
  OpenChatRequest,
  RecentNativeSession,
  StepUsage,
} from "./types.js";

const run = execHarness;
const READY_TIMEOUT_MS = 30_000;
const PROBE_TTL_MS = 60_000;
/** How long a discovered gateway endpoint is trusted: its port and instance change only on a restart. */
const ENDPOINT_TTL_MS = 15_000;
/** Hermes's effort ladder (agent/reasoning_effort.py); the route clamps to what it accepts. */
const REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** The level the route sends for the session's effort, when its clamp changes it (session.info's reasoning_effort_wire). */
function sentEffort(info: Obj): string | null {
  const wire = str(info.reasoning_effort_wire);
  return wire && wire !== str(info.reasoning_effort) ? wire : null;
}


/**
 * A turn's reasoning, when Hermes put it in the answer itself: a surface whose `show_reasoning` is
 * on gets the thought prepended to the final text (`gateway/run_turn_persistence.py::
 * _hmwa_prepend_reasoning`) — `💭 **Reasoning:**` with a fenced block by default, a blockquote, or
 * Discord's `-# ` subtext. awui shows reasoning where omp's goes, on the item's own `thinking`, so
 * the block comes off the answer here; the payload's own (fuller) `reasoning` wins when the gateway
 * names one. Anything that is not one of those shapes is left alone.
 */
export function splitReasoningBlock(text: string, reasoning = ""): { text: string; thinking: string } {
  const shapes: [RegExp, (body: string) => string][] = [
    // display.reasoning_style "code": the thought in a fence, a blank line, then the answer.
    [/^💭 \*\*Reasoning:\*\*\n```[^\n]*\n([\s\S]*?)\n```\n*/, (body) => body],
    // "blockquote": the label and the thought quoted line by line.
    [/^> 💭 \*\*Reasoning:\*\*\n((?:>.*\n)+)/, (body) => body.replace(/^> ?/gm, "").trimEnd()],
    // "subtext" (Discord): the label and the thought as "-" lines.
    [/^-# 💭 Reasoning\n((?:-#.*\n)+)/, (body) => body.replace(/^-# ?/gm, "").trimEnd()],
  ];
  // The payload's own copy is kept verbatim; only the block taken out of the text is trimmed.
  const named = reasoning.trim() ? reasoning : "";
  for (const [shape, unquote] of shapes) {
    const match = shape.exec(text);
    if (!match) continue;
    const block = unquote(match[1] ?? "").trim();
    return { text: text.slice(match[0].length).replace(/^\n+/, ""), thinking: named || block };
  }
  return { text, thinking: named };
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Epoch seconds (gateway) to epoch ms. */
const atMs = (v: unknown): number | undefined => {
  const seconds = num(v);
  return seconds === null ? undefined : Math.round(seconds * 1000);
};

interface GatewayRuntime {
  /** The interpreter that can import tui_gateway. */
  python: string;
  /** The launcher's own launch command, when it answered for itself (see printedRuntime). */
  argv?: string[];
  /** The environment the gateway runs in. */
  env: NodeJS.ProcessEnv;
  /** How it was found, for discovery warnings. */
  source: "HERMES_PYTHON" | "launcher" | "PATH";
}

/**
 * The Hermes TUI starts its gateway with `{ ...process.env }`, and it runs
 * under the `hermes` launcher, so the gateway inherits what that launcher sets
 * up: on Nix, HERMES_PYTHON, HERMES_BUNDLED_PLUGINS/SKILLS/LOCALES,
 * HERMES_INSTALL_ROOT, and a PYTHONPATH carrying plugin deps (mnemosyne). This
 * server is not started by the launcher, so it replays the launcher's setup
 * (everything before its final `exec`) once and captures the environment, the
 * way the dotfiles' hermes-python wrapper does at build time. An explicit
 * HERMES_PYTHON wins while it can import the gateway; the installer exports a
 * bare tool Python that only finds the checkout through the launcher's own
 * bootstrap, and then the launcher is asked to name the command instead.
 * Anything that is not a shell wrapper falls back to python3, unless the
 * launcher answers `--print-runtime-command` (see printedRuntime).
 */
const runtimeCache = new Map<string, Promise<GatewayRuntime>>();
function gatewayRuntime(cliCommand: string): Promise<GatewayRuntime> {
  // The environment is part of the answer, so HERMES_PYTHON is part of the key.
  const key = `${cliCommand}\0${process.env.HERMES_PYTHON?.trim() ?? ""}`;
  let cached = runtimeCache.get(key);
  if (!cached) {
    cached = launcherRuntime(cliCommand);
    runtimeCache.set(key, cached);
  }
  return cached;
}

/**
 * The interpreter a Python console script runs with (Hermes's own installer,
 * pip, pipx, and uv install `hermes` this way): its shebang, or the line pip
 * writes instead when that path is too long for one (`'''exec' "/…/python"`).
 * Null for anything else (a shell wrapper, a binary).
 */
export function scriptPython(text: string): string | null {
  const lines = text.split("\n", 3);
  const shebang = /^#!\s*(\S+)(?:\s+(\S+))?/.exec(lines[0] ?? "");
  if (!shebang) return null;
  const [, program = "", arg] = shebang;
  const isPython = (p: string) => /(^|\/)python[\d.]*$/.test(p);
  if (isPython(program)) return program;
  if (/(^|\/)env$/.test(program) && arg && isPython(arg)) return arg;
  const pipLong = /^'''exec' "([^"]+)" "\$0"/.exec(lines[1] ?? "");
  if (/(^|\/)sh$/.test(program) && pipLong?.[1] && isPython(pipLong[1])) return pipLong[1];
  return null;
}

/** A `gateway.pid` record's identifying fields, as far as this server needs them. */
export function gatewayRecord(text: string): { pid: number; startTime: number | null } | null {
  try {
    const record = JSON.parse(text) as Obj;
    const pid = num(record.pid);
    if (pid === null || pid <= 0) return null;
    return { pid, startTime: num(record.start_time) };
  } catch {
    return null;
  }
}

/**
 * A process's start-time fingerprint (field 22 of `/proc/<pid>/stat`, in clock
 * ticks since boot), or null where there is no `/proc`. Hermes records the same
 * number in `gateway.pid`, so the pair survives pid reuse.
 */
export async function processStartTime(pid: number): Promise<number | null> {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  if (stat === null) return null;
  // The comm field is parenthesized and may hold spaces, so the fields count from after it: field 3 (state) is index 0, field 22 (starttime) is index 19.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const started = Number(fields[19]);
  return Number.isInteger(started) ? started : null;
}

/**
 * The pid of the gateway that owns `home`, when one is running. Hermes's own
 * `hermes gateway` (the dotfiles' systemd service, the desktop app, a TUI)
 * holds the home's `gateway.lock` for as long as it lives, and the stdio
 * session server awui starts refuses to run beside it — so this is what lets
 * discovery say why a Hermes chat will not start, instead of leaving "exited
 * (code 1)" to speak for itself.
 */
export async function gatewayOwner(home: string): Promise<number | null> {
  const text = await fs.readFile(path.join(home, "gateway.pid"), "utf8").catch(() => null);
  const record = text === null ? null : gatewayRecord(text);
  if (!record) return null;
  try {
    process.kill(record.pid, 0);
  } catch (error) {
    // EPERM is a live process this user does not own; anything else means the pid is gone.
    if ((error as NodeJS.ErrnoException).code !== "EPERM") return null;
  }
  const started = await processStartTime(record.pid);
  // A recycled pid is not the gateway: the recorded start time must still match, where both are known.
  if (record.startTime !== null && started !== null && record.startTime !== started) return null;
  return record.pid;
}

/**
 * The launch command the launcher publishes for itself: `--print-runtime-command`
 * prints a JSON argv that starts a module in the install. The installer's launcher is
 * a shell script with an inline Python bootstrap, so its interpreter sits past `-c` and
 * its `exec` is not the last line — neither shape above can read that. Null for a
 * launcher that does not answer (an old build, or a console script).
 */
async function printedRuntime(bin: string): Promise<GatewayRuntime | null> {
  try {
    const { stdout } = await run(bin, ["--print-runtime-command", "--module", "tui_gateway.entry"], { timeout: 15_000 });
    const parsed: unknown = JSON.parse(stdout);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((arg) => typeof arg === "string")) return null;
    const [command, ...args] = parsed as string[];
    return command ? { python: command, argv: [command, ...args], env: { ...process.env }, source: "launcher" } : null;
  } catch {
    return null;
  }
}

async function launcherRuntime(cliCommand: string): Promise<GatewayRuntime> {
  const fallback: GatewayRuntime = { python: process.platform === "win32" ? "python" : "python3", env: { ...process.env }, source: "PATH" };
  // The launcher is read as a POSIX shell script (shebang, inline Python,
  // trailing `exec`); there is no such shape to parse on Windows, so the
  // runtime is whatever Python the launcher itself answers with, else PATH's.
  if (process.platform === "win32") {
    const explicit = process.env.HERMES_PYTHON?.trim();
    if (explicit) return { python: explicit, env: { ...process.env }, source: "HERMES_PYTHON" };
    return (await printedRuntime(cliCommand)) ?? fallback;
  }
  try {
    const { stdout } = await run("sh", ["-c", `command -v -- "$1"`, "sh", cliCommand], { timeout: 5_000 });
    const bin = stdout.trim().split("\n")[0];
    if (!bin) return fallback;
    // HERMES_PYTHON wins while that interpreter can import the gateway. The installer
    // exports its bare tool Python, which only finds tui_gateway through the launcher's
    // `-I -c` bootstrap, so there the launcher names the command instead.
    const explicit = process.env.HERMES_PYTHON?.trim();
    if (explicit) {
      const env = { ...process.env };
      const imports = await run(explicit, ["-c", "import tui_gateway.entry"], { env, timeout: 15_000 }).then(
        () => true,
        () => false,
      );
      if (imports) return { python: explicit, env, source: "HERMES_PYTHON" };
      return (await printedRuntime(bin)) ?? { python: explicit, env, source: "HERMES_PYTHON" };
    }
    const text = await fs.readFile(bin, "utf8");
    const python = scriptPython(text);
    if (python) return { python, env: { ...process.env }, source: "launcher" };
    const lines = text.trimEnd().split("\n");
    const shell = /^#!\s*(\S+)/.exec(lines[0] ?? "")?.[1];
    const last = lines[lines.length - 1] ?? "";
    if (!shell || !/^exec\s/.test(last.trim())) return (await printedRuntime(bin)) ?? fallback;
    const prelude = lines.slice(1, -1).join("\n");
    const { stdout: dump } = await run(shell, ["-c", `${prelude}\nenv -0`], { env: process.env, timeout: 5_000, maxBuffer: 4 * 1024 * 1024 });
    const env: NodeJS.ProcessEnv = {};
    for (const entry of dump.split("\0")) {
      const eq = entry.indexOf("=");
      if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
    }
    const exported = env.HERMES_PYTHON?.trim();
    if (exported) return { python: exported, env, source: "launcher" };
    return (await printedRuntime(bin)) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Every gateway connection this process holds — a child of ours or an attachment — closed on shutdown. */
const liveLinks = new Set<GatewayLink>();
function track<L extends GatewayLink>(link: L): L {
  liveLinks.add(link);
  link.onExit(() => liveLinks.delete(link));
  return link;
}
/** Test seam: how many gateway connections are alive. */
export function liveHermesLinks(): number {
  return liveLinks.size;
}

/** JSON-RPC over one child's stdio: requests we send, events and server requests we receive. */
class HermesRpc implements GatewayLink {
  readonly child: ChildProcessWithoutNullStreams;
  /** A child of our own: the session lives and dies with it. */
  readonly attached = false;
  private readonly calls = new PendingRequests<string>(hermesCodec(), (frame) => this.child.stdin.write(`${JSON.stringify(frame)}\n`));
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  readonly ready: Promise<void>;
  exited = false;
  private readonly stderr: StderrTail;
  private exitListeners = new Set<(message: string) => void>();

  constructor(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    private readonly onEvent: (params: Obj) => void,
    private readonly onRequest: (frame: GatewayFrame) => void,
  ) {
    this.child = spawnHarness(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.stderr = new StderrTail(this.child);
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    // `detail`, then Hermes's own last words on stderr: it exits 1 with the reason
    // there (a refusal, a traceback) and nothing but protocol on stdout, so without
    // this every failed start reads as a bare exit code.
    const why = (detail: string) => {
      const reason = this.stderr.reason();
      return reason ? `${detail}: ${reason}` : detail;
    };
    const readyTimer = setTimeout(() => this.readyReject(new Error(why("hermes gateway did not become ready"))), READY_TIMEOUT_MS);
    void this.ready.then(() => clearTimeout(readyTimer), () => clearTimeout(readyTimer));

    const lines = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      let frame: GatewayFrame;
      try {
        frame = JSON.parse(line) as GatewayFrame;
      } catch {
        return;
      }
      if (frame.method === "event") {
        if (isObj(frame.params) && frame.params.type === "gateway.ready") {
          this.readyResolve();
          return;
        }
        if (isObj(frame.params)) this.onEvent(frame.params);
        return;
      }
      if (this.calls.accept(frame)) return;
      // No pending request matches: a server→client request (approval, clarify, …).
      if (frame.method && frame.id !== undefined) this.onRequest(frame);
    });
    this.child.stdin.on("error", () => undefined);
    const failed = (detail: string) => {
      if (this.exited) return;
      this.exited = true;
      const message = why(detail);
      this.readyReject(new Error(message));
      this.calls.failAll(message);
      for (const listener of this.exitListeners) listener(message);
    };
    this.child.once("error", (error) => failed(`could not start hermes (${error.message})`));
    this.child.once("exit", (code, signal) => failed(`hermes exited (${signal ?? `code ${code}`})`));
  }

  onExit(listener: (message: string) => void): void {
    this.exitListeners.add(listener);
  }

  request<T = unknown>(method: string, params: Obj = {}): Promise<T> {
    if (this.exited) return Promise.reject(new Error("hermes is not running"));
    return this.calls.send<T>({ method, params }, `hermes did not answer ${method}`);
  }

  /** Answer a server→client request (its id is the `srq-…` frame id). */
  respond(id: string | number, result: unknown): void {
    if (this.exited) return;
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  }

  async kill(): Promise<void> {
    if (this.exited) return;
    await terminateChild(this.child);
  }
}

/** One stored session row, as `projects.tree` reports it. */
interface StoredRow {
  id: string;
  title: string;
  cwd: string;
  lastActive: number | null;
  messageCount: number | null;
}

function toSummary(row: StoredRow): NativeSessionSummary {
  return {
    nativeId: row.id,
    title: row.title || "Untitled",
    updatedAt: row.lastActive === null ? null : new Date(row.lastActive * 1000),
    ...(row.messageCount !== null ? { messageCount: row.messageCount } : {}),
  };
}

function usageOf(raw: unknown): StepUsage | null {
  if (!isObj(raw)) return null;
  return {
    input: num(raw.input) ?? 0,
    output: num(raw.output) ?? 0,
    cacheRead: num(raw.cache_read) ?? 0,
    cacheWrite: num(raw.cache_write) ?? 0,
  };
}

/** Tool output as hermes stores it: a string, a `{content: […]}` block list, or JSON. */
function toolOutput(result: unknown): string {
  if (typeof result === "string") return result;
  if (Array.isArray(result)) return result.map((part) => (isObj(part) ? str(part.text) : String(part))).join("\n");
  if (isObj(result)) {
    const content = result.content;
    if (Array.isArray(content)) return content.map((part) => (isObj(part) ? str(part.text) : String(part))).join("\n");
    if (typeof content === "string") return content;
    return JSON.stringify(result, null, 2);
  }
  if (result !== undefined && result !== null) return String(result);
  return "";
}

/**
 * One stored row as the shared transcript reconstruction (`historyToItems`)
 * expects: user/assistant rows become messages, a tool row becomes a tool call
 * plus its result. Hermes's other roles are not displayable and stay dropped.
 */
function rowToMessages(row: Obj): unknown[] {
  const at = atMs(row.timestamp);
  const stamp = at === undefined ? {} : { timestamp: at };
  switch (str(row.role)) {
    case "user": {
      const text = str(row.text);
      return text ? [{ role: "user", content: text, ...stamp }] : [];
    }
    case "assistant": {
      const text = str(row.text);
      const thinking = str(row.reasoning);
      if (!text && !thinking) return [];
      const content: unknown[] = [];
      if (thinking) content.push({ type: "thinking", thinking });
      if (text) content.push({ type: "text", text });
      return [{ role: "assistant", content, ...stamp }];
    }
    case "tool": {
      const id = str(row.tool_call_id) || randomUUID();
      return [
        { role: "assistant", content: [{ type: "toolCall", id, name: str(row.name) || "tool", arguments: row.args }], ...stamp },
        { role: "toolResult", toolCallId: id, content: [{ type: "text", text: toolOutput(row.content ?? row.result) }], isError: false, ...stamp },
      ];
    }
    default:
      return [];
  }
}

/** Stored transcript rows (role/text/reasoning/tool) as display items. */
function transcriptItems(messages: unknown[]): ChatItem[] {
  const rows: unknown[] = [];
  // A tool row's `context` names what it touched when its args say nothing.
  const contexts = new Map<string, string>();
  for (const raw of messages) {
    if (!isObj(raw)) continue;
    const converted = rowToMessages(raw);
    rows.push(...converted);
    const call = converted[1];
    if (str(raw.role) === "tool" && isObj(call) && str(raw.context)) contexts.set(`t:${str(call.toolCallId)}`, str(raw.context));
  }
  return historyToItems(rows).map((item) =>
    item.kind === "tool" && !item.summary && contexts.has(item.id) ? { ...item, summary: contexts.get(item.id) as string } : item,
  );
}

/** A dangerous-command approval the gateway is waiting on. */
interface PendingApproval {
  kind: "approval";
  requestId: string | number;
  choices: string[];
}
/** A clarify question set; answered once every question is resolved. */
interface PendingClarify {
  kind: "clarify";
  requestId: string | number;
  answers: Map<string, string | null>;
  open: Set<string>;
}
type PendingRequest = PendingApproval | PendingClarify;

class HermesLiveChat implements LiveChat {
  /** Buffered until the first subscriber, so events raised while starting survive. */
  private hub = new EventHub();
  private rpc: GatewayLink | null = null;
  private runtimeId: string | null = null;
  private storedId: string | null = null;
  private sessionTitle: string | null = null;
  private info: Obj = {};
  private usage: Obj = {};
  private todos: TodoItem[] = [];
  private models: ModelInfo[] | null = null;
  /** The catalog key a config.set asked for. A proxied pick can read back as the proxy ("litellm/x"),
      outside the catalog; the picker keeps naming what was picked until the catalog resolves it. */
  private pickedKey: string | null = null;
  private turns = 0;
  private running = false;
  private disposed = false;
  private pending = new Map<string, PendingRequest>();

  constructor(
    private readonly adapter: HermesAdapter,
    private readonly cwd: string,
  ) {}

  get nativeId(): string | null {
    return this.storedId;
  }

  get title(): string | null {
    return this.sessionTitle;
  }

  subscribe(listener: HarnessEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  private emit(event: HarnessEvent): void {
    if (this.disposed) return;
    this.hub.emit(event);
  }

  private get live(): GatewayLink {
    if (!this.rpc || this.rpc.exited) throw new Error("hermes is not running for this chat");
    return this.rpc;
  }

  async start(resumeNativeId: string | null): Promise<void> {
    const rpc = await this.adapter.openChatLink(this.cwd, (params) => this.onEvent(params), (frame) => this.onRequest(frame));
    this.rpc = rpc;
    rpc.onExit((message) => {
      if (!this.disposed) this.emit({ type: "fatal", message });
    });
    await rpc.ready;
    // An attached client must say it can answer approvals and questions, or the gateway
    // parks them for some later client instead of asking this one.
    await rpc.request("client.capabilities", { server_requests: true });
    let result: Obj;
    try {
      result = resumeNativeId
        ? // The attached shim asks for display rows itself; a stdio gateway refuses keys it does not declare.
          await rpc.request<Obj>("session.resume", { session_id: resumeNativeId, source: "webui" })
        : await rpc.request<Obj>("session.create", { cwd: this.cwd, source: "webui" });
    } catch (error) {
      // Older awui chats are stored as source `webui`. The gateway lists them and then
      // refuses to mount that source (`not_found`); a bare code is not a reason.
      if (error instanceof HermesRpcError && error.message === "not_found") {
        throw new Error("Hermes refused to reopen this session (not_found). The gateway will not mount chats an older awui saved (source webui). Open it from the Hermes TUI, or start a new chat.");
      }
      throw error;
    }
    // 0.22.2 names no stored id on a lazy resume (only `resumed`) until a turn builds the agent.
    if (resumeNativeId) this.storedId = resumeNativeId;
    this.applySnapshot(result);
    await this.requestLiveReasoning(rpc);
  }

  /**
   * Ask the owner to stream this session's reasoning, as the CLI and the ACP editor do.
   *
   * The gateway publishes `reasoning.delta` only when the session's `show_reasoning` flag
   * is on, and a session starts with it off: a reasoning sink changes what the provider
   * is asked for, so a viewer has to ask. `config.set` of that key is the session's own
   * flag, not a write to config.yaml. The stdio child already defaults the flag on and
   * does not have this key. A refusal leaves the chat up, just without the live stream.
   */
  private async requestLiveReasoning(rpc: GatewayLink): Promise<void> {
    if (!rpc.attached || !this.runtimeId) return;
    await rpc.request("config.set", { session_id: this.runtimeId, key: "show_reasoning", value: "1" }).catch(() => undefined);
  }

  private applySnapshot(result: Obj): void {
    this.runtimeId = str(result.session_id) || this.runtimeId;
    this.storedId = str(result.stored_session_id) || str(isObj(result.info) ? result.info.stored_session_id : "") || this.storedId;
    this.applyInfo(isObj(result.info) ? result.info : {});
    if (isObj(result.todo_state)) this.todos = toTodos(result.todo_state.todos);
    if (this.storedId) this.emit({ type: "session", nativeId: this.storedId });
  }

  private applyInfo(info: Obj): void {
    this.info = { ...this.info, ...info };
    const title = str(info.title);
    if (title && title !== this.sessionTitle) {
      this.sessionTitle = title;
      this.emit({ type: "title", title });
    }
    if (isObj(info.usage)) this.usage = info.usage;
    const model = str(info.model);
    const provider = str(info.provider);
    if (model || provider) {
      const qualified = this.modelKey();
      this.emit({
        type: "config",
        config: {
          ...(qualified ? { model: qualified } : {}),
          ...(str(info.reasoning_effort) ? { thinkingLevel: str(info.reasoning_effort), thinkingSent: sentEffort(info) } : {}),
        },
      });
      // The key needs the catalog to tell a real pick from a stranded name; once it is read, say it again.
      if (!this.models) void this.modelList().then(() => this.emit({ type: "config", config: { model: this.modelKey() || null } }), () => undefined);
    }
    const wasRunning = this.running;
    this.running = info.running === true;
    if (this.running && !wasRunning) this.emit({ type: "busy" });
    // A turn that ends without `message.complete` (reclaimed session, crash) still settles the UI.
    if (!this.running && wasRunning) {
      this.statusLine("");
      this.emit({ type: "settled" });
    }
  }

  private statusText: string | null = null;

  /**
   * Hermes's live status line: each `thinking.delta` replaces it and "" clears
   * it. Its spinner frames ("(´･_･`) musing...": a face and one verb) say only
   * that the model is thinking, which the turn's own spinner already shows, so
   * they are dropped, as Pi and omp show nothing of the kind; anything else (a
   * provider wait, a retry) is a status chip until the turn ends.
   */
  private statusLine(text: string): void {
    const line = text.trim();
    const spinner = /^[^A-Za-z]+?\s+\p{L}+(?:\.\.\.|…)$/u.test(line);
    const next = line && !spinner ? line : null;
    if (next === this.statusText) return;
    this.statusText = next;
    this.emit({ type: "extension_status", key: "hermes:status", text: next });
  }

  /**
   * Lifetime metered totals from per-turn message.complete usage. Snapshots
   * repeat the just-finished turn (or omit cache_read on some proxies), so
   * they cannot reconstruct lifetime counters; summing the per-turn deltas —
   * the same shape state.db accumulates — can. getUsage prefers these once
   * any turn has landed.
   */
  private metered: StepUsage | null = null;

  private accumulateUsage(step: StepUsage): void {
    const m = this.metered ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    m.input += step.input;
    m.output += step.output;
    m.cacheRead += step.cacheRead;
    m.cacheWrite += step.cacheWrite;
    this.metered = m;
  }

  // ---- gateway events ---------------------------------------------------------

  private onEvent(params: Obj): void {
    const type = str(params.type);
    const p = isObj(params.payload) ? params.payload : {};
    switch (type) {
      case "message.start":
        this.emit({ type: "busy" });
        this.emit({ type: "assistant_start", ...(str(this.info.model) ? { model: str(this.info.model) } : {}) });
        break;
      case "message.delta": {
        const text = str(p.text);
        if (text) this.emit({ type: "assistant_delta", field: "text", delta: text });
        break;
      }
      case "reasoning.delta": {
        const text = str(p.text);
        if (text) this.emit({ type: "assistant_delta", field: "thinking", delta: text });
        break;
      }
      case "thinking.delta":
        // Not reasoning: the gateway's live status line (spinner, wait notices).
        this.statusLine(str(p.text));
        break;
      // MoA (Hermes's Mixture of Agents): each reference model's advice is the turn's reasoning,
      // so it opens as its own fold with the model's label. The fan-out and the hand to the
      // aggregator read on the status line, as Hermes's own status bar shows them.
      case "moa.reference": {
        const text = str(p.text).trim();
        const label = str(p.label) || "reference";
        const index = num(p.index);
        const count = num(p.count);
        if (text) {
          this.emit({
            type: "notice",
            level: "info",
            title: `MoA · ${label}${index !== null && count !== null ? ` (${index}/${count})` : ""}`,
            text: `MoA reference advice from ${label}`,
            detail: boundText(text).text,
            detailFormat: "markdown",
          });
        }
        break;
      }
      case "moa.progress": {
        const done = num(p.refs_done);
        const total = num(p.refs_total);
        if (done !== null && total !== null) this.statusLine(`MoA · ${done}/${total} references done`);
        break;
      }
      case "moa.phase":
      case "moa.aggregating": {
        const aggregator = str(p.aggregator);
        this.statusLine(aggregator ? `MoA · aggregating with ${aggregator}` : "MoA · aggregating");
        break;
      }
      case "message.interim": {
        // An interim carries the same display text, reasoning block and all.
        const text = splitReasoningBlock(str(p.text)).text;
        if (text && p.already_streamed !== true) this.emit({ type: "assistant_delta", field: "text", delta: text });
        break;
      }
      case "message.complete": {
        this.turns += 1;
        const status = str(p.status);
        const error = status === "error" ? str(p.error) || str(p.failure_reason) || "The run failed" : undefined;
        const step = usageOf(p.usage);
        if (step) this.accumulateUsage(step);
        // The gateway may have written the thought into the text itself (see splitReasoningBlock):
        // it belongs on the item's thinking, where this UI renders it as its own row.
        const answer = splitReasoningBlock(str(p.text), str(p.reasoning));
        this.emit({
          type: "assistant_end",
          text: answer.text,
          thinking: answer.thinking,
          ...(error ? { error } : {}),
          ...(step ? { usage: step } : {}),
        });
        this.statusLine("");
        this.emit({ type: "settled" });
        break;
      }
      case "tool.start": {
        const args = p.args ?? p.args_text ?? {};
        this.emit({ type: "tool_start", toolCallId: str(p.tool_id) || randomUUID(), name: str(p.name) || "tool", args });
        break;
      }
      case "tool.complete": {
        this.emit({
          type: "tool_end",
          toolCallId: str(p.tool_id) || randomUUID(),
          output: toolOutput(p.result_text ?? p.result ?? p.summary),
          isError: p.is_error === true || (isObj(p.result) && p.result.is_error === true),
        });
        break;
      }
      case "todo.updated":
        this.todos = toTodos(p.todos);
        break;
      case "session.info":
        this.applyInfo(p);
        break;
      case "session.usage":
        if (isObj(p.usage)) this.usage = p.usage;
        break;
      case "session.title": {
        const title = str(p.title);
        if (title && title !== this.sessionTitle) {
          this.sessionTitle = title;
          this.emit({ type: "title", title });
        }
        break;
      }
      case "status.update": {
        const kind = str(p.kind);
        if (kind === "compacting" || kind === "compressing") this.emit({ type: "compacting", active: true });
        else if (kind === "compacted" || kind === "ready") this.emit({ type: "compacting", active: false });
        else if (kind === "status" && str(p.text)) this.emit({ type: "notice", level: "info", text: str(p.text) });
        break;
      }
      case "error":
        if (str(p.message)) this.emit({ type: "notice", level: "error", text: str(p.message) });
        break;
      case "notice":
        if (str(p.message)) this.emit({ type: "notice", level: "info", text: str(p.message) });
        break;
      case "notification.show":
        if (str(p.text)) this.emit({ type: "notice", level: p.level === "error" ? "error" : p.level === "warn" ? "warning" : "info", text: str(p.text) });
        break;
      case "approval.cancelled": {
        for (const id of Array.isArray(p.request_ids) ? p.request_ids.map(String) : []) {
          const request = this.pending.get(id);
          if (request) {
            this.pending.delete(id);
            this.emit({ type: "request_cancelled", requestId: id, outcome: str(p.reason) || "cancelled" });
          }
        }
        break;
      }
      case "request.cancel": {
        const id = str(p.id);
        const group = this.pending.get(id);
        if (group?.kind === "clarify") {
          // The cards a clarify group raised are keyed `${id}:${qid}`; clear them all.
          this.pending.delete(id);
          for (const qid of group.open) this.emit({ type: "request_cancelled", requestId: `${id}:${qid}`, outcome: str(p.reason) || "cancelled" });
          break;
        }
        if (this.pending.delete(id)) this.emit({ type: "request_cancelled", requestId: id, outcome: str(p.reason) || "cancelled" });
        break;
      }
      case "session.reclaimed":
        this.emit({ type: "notice", level: "warning", text: `Hermes reclaimed this session (${str(p.reason) || "idle"})` });
        break;
      default:
        break;
    }
  }

  // ---- server→client requests -------------------------------------------------

  private onRequest(frame: GatewayFrame): void {
    const id = frame.id as string | number;
    const params = isObj(frame.params) ? frame.params : {};
    switch (frame.method) {
      case "approval": {
        const requestId = str(params.request_id) || String(id);
        const choices = (Array.isArray(params.choices) ? params.choices : ["once", "deny"]).map(String);
        this.pending.set(requestId, { kind: "approval", requestId: id, choices });
        const command = str(params.command);
        const description = str(params.description);
        this.emit({
          type: "request",
          request: {
            id: requestId,
            kind: "select",
            title: `Approve ${str(params.tool_name) || "a command"}?`,
            ...(description || command ? { message: [description, command].filter(Boolean).join("\n\n") } : {}),
            options: choices,
            createdAt: Date.now(),
          },
        });
        break;
      }
      case "clarify": {
        const questions = Array.isArray(params.questions) ? params.questions.filter(isObj) : [];
        const group: PendingClarify = { kind: "clarify", requestId: id, answers: new Map(), open: new Set() };
        for (const question of questions) {
          const qid = str(question.qid);
          if (!qid) continue;
          group.open.add(qid);
          const choices = Array.isArray(question.choices) ? question.choices.map(String) : [];
          this.emit({
            type: "request",
            request: {
              id: `${String(id)}:${qid}`,
              kind: choices.length > 0 ? "select" : "input",
              title: str(question.question) || "Hermes needs an answer",
              ...(choices.length > 0 ? { options: choices } : {}),
              createdAt: Date.now(),
            },
          });
        }
        this.pending.set(String(id), group);
        break;
      }
      default: {
        // sudo, secret, vault prompts, previews, … — this client declines.
        this.live.respond(id, { value: "" });
        this.emit({ type: "notice", level: "warning", text: `Hermes asked for ${frame.method}; the web UI declined` });
        break;
      }
    }
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    const direct = this.pending.get(requestId);
    if (direct?.kind === "approval") {
      this.pending.delete(requestId);
      this.live.respond(direct.requestId, { choice: approvalChoice(answer, direct.choices) });
      return true;
    }
    const [frameId, qid] = requestId.split(":");
    const group = frameId ? this.pending.get(frameId) : undefined;
    if (group?.kind === "clarify" && qid) {
      group.answers.set(qid, answer.kind === "select" || answer.kind === "input" || answer.kind === "editor" ? answer.value : null);
      group.open.delete(qid);
      if (group.open.size === 0) {
        this.pending.delete(frameId as string);
        this.live.respond(group.requestId, { answers: Object.fromEntries(group.answers) });
      }
      return true;
    }
    return false;
  }

  // ---- LiveChat ---------------------------------------------------------------

  async history(): Promise<ChatItem[]> {
    const id = this.runtimeId;
    if (!id) return [];
    const result = await this.live.request<Obj>("session.history", { session_id: id });
    return transcriptItems(Array.isArray(result?.messages) ? result.messages : []);
  }

  async getConfig(): Promise<ChatConfig> {
    const models = await this.modelList();
    return {
      model: this.modelKey() || null,
      thinkingLevel: str(this.info.reasoning_effort) || null,
      models,
      thinkingLevels: REASONING_LEVELS,
      thinkingSent: sentEffort(this.info),
    };
  }

  /** The picker's key for the model this session is on (see hermesModelKey). */
  private modelKey(): string {
    const models = this.models ?? [];
    const key = hermesModelKey(str(this.info.model), str(this.info.provider), models, this.adapter.userDefinedProviders(this.cwd));
    // Hermes reports the proxy over the pick (a pick on "opencode-go/x" comes back "litellm/x"): when the
    // reconstructed key is not in the catalog, name the pick instead, as long as it still ends in the id.
    if (this.pickedKey && !models.some((m) => m.key === key)) {
      const id = this.pickedKey.split("/").pop() ?? "";
      const bare = key.split("/").pop() ?? "";
      if (id && bare === id) return this.pickedKey;
      this.pickedKey = null; // the session moved on
    }
    return key;
  }

  /** Asked of this chat's own gateway: a probe child would cost a second gateway start (~2 s). */
  private async modelList(): Promise<ModelInfo[]> {
    this.models ??= await this.adapter.listModels(this.cwd, false, (params) => this.live.request<Obj>("model.options", params));
    return this.models;
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const used = num(this.usage.context_used);
    const max = num(this.usage.context_max);
    if (used === null || max === null || max <= 0) return null;
    return { tokens: used, window: max, percent: num(this.usage.context_percent) ?? Math.min(100, (used / max) * 100) };
  }

  async getUsage(): Promise<HarnessUsage | null> {
    const calls = num(this.usage.calls);
    if (calls === null && num(this.usage.input) === null && !this.metered) return null;
    const m = this.metered;
    return {
      turns: this.turns,
      steps: calls ?? 0,
      input: m ? m.input : (num(this.usage.input) ?? 0),
      cachedInput: m ? m.cacheRead : (num(this.usage.cache_read) ?? 0),
      cacheWrite: m ? m.cacheWrite : (num(this.usage.cache_write) ?? 0),
      output: m ? m.output : (num(this.usage.output) ?? 0),
      cost: null,
    };
  }

  async getTodos(): Promise<TodoItem[]> {
    return this.todos;
  }

  async prompt(text: string, images: ImageAttachment[] = []): Promise<void> {
    const id = this.requireSession();
    if (images.length === 0 && /^\/\S/.test(text.trim())) return this.slash(id, text.trim());
    for (const image of images) {
      await this.live.request("image.attach_bytes", { session_id: id, content_base64: image.data, filename: `pasted.${image.mimeType.split("/")[1] ?? "png"}` });
    }
    await this.live.request("prompt.submit", { session_id: id, text });
    // The gateway never echoes the user row, so the manager learns about it here.
    this.emit({ type: "user_message", text, ...(images.length > 0 ? { imageCount: images.length } : {}) });
  }

  /**
   * Hermes Desktop's edit: prompt.submit cuts the session before a user
   * message (by its durable row id; Hermes soft-archives what it drops) and
   * runs the new prompt in its place.
   */
  async rewind(turn: number, text: string, images: ImageAttachment[] = []): Promise<void> {
    const id = this.requireSession();
    const result = await this.live.request<Obj>("session.history", { session_id: id });
    const users = (Array.isArray(result?.messages) ? result.messages : []).filter((m): m is Obj => isObj(m) && m.role === "user");
    const target = users[turn - 1];
    if (!target) throw new Error("That message is no longer in the session");
    for (const image of images) {
      await this.live.request("image.attach_bytes", { session_id: id, content_base64: image.data, filename: `pasted.${image.mimeType.split("/")[1] ?? "png"}` });
    }
    const rowId = num(target.row_id);
    await this.live.request("prompt.submit", {
      session_id: id,
      text,
      confirm_truncate: true,
      ...(rowId !== null ? { truncate_before_row_id: rowId } : { truncate_before_user_ordinal: turn - 1 }),
      ...(turn === 1 ? { confirm_empty_truncate: true } : {}),
    });
    this.emit({ type: "user_message", text, ...(images.length > 0 ? { imageCount: images.length } : {}) });
  }

  /**
   * "/" commands never go through prompt.submit; the Hermes TUI runs them as
   * slash.exec (built-ins answer with output), which sends skills and plugins
   * on to command.dispatch (error 4018). A dispatch that returns a message
   * (send, skill) submits it as a normal turn; anything else is output.
   */
  private async slash(id: string, text: string): Promise<void> {
    try {
      const done = await this.live.request<Obj>("slash.exec", { session_id: id, command: text });
      // A pending-input built-in (/moa, /init, /goal) answers with a send directive, not
      // output: the gateway wants its message submitted, and does not return 4018 for a retry.
      if (await this.runDirective(id, done)) return;
      return this.commandOutput(text, str(done?.output));
    } catch (error) {
      if (!(error instanceof HermesRpcError) || error.code !== 4018) throw error;
    }
    const name = text.slice(1).split(/\s+/)[0] ?? "";
    const arg = text.slice(1 + name.length).trim();
    const result = await this.live.request<Obj>("command.dispatch", { session_id: id, name, arg });
    if (await this.runDirective(id, result)) return;
    this.commandOutput(text, str(result?.output) || (result?.type === "prefill" ? str(result?.text) : ""));
  }

  /**
   * A command that becomes a prompt (Hermes's `type: "send"` or `"skill"`: /moa, /init, a
   * skill): submit the message it hands back, and put its notice in the turn. The user row
   * is that message, which is the row the harness stores; the slash itself would vanish on
   * reload. `ambient: false` because the notice is said before the turn's first event, when
   * the chat still reads idle.
   */
  private async runDirective(id: string, result: Obj): Promise<boolean> {
    const type = str(result?.type);
    const message = str(result?.message);
    if ((type !== "send" && type !== "skill") || !message) return false;
    await this.live.request("prompt.submit", { session_id: id, text: message });
    this.emit({ type: "user_message", text: message });
    const notice = str(result?.notice);
    if (notice) this.emit({ type: "notice", level: "info", text: notice, ambient: false });
    return true;
  }

  /** A command that ran without a model turn: the command as the prompt, its output, then idle. */
  private commandOutput(command: string, output: string): void {
    for (const event of commandOutputEvents(command, output)) this.emit(event);
    this.emit({ type: "settled" });
  }

  /** Hermes's own completion list for "/", the one its TUI shows. */
  async listCommands(): Promise<SlashCommand[]> {
    const result = await this.live.request<Obj>("complete.slash", { text: "/", session_id: this.runtimeId ?? "" });
    const items = Array.isArray(result?.items) ? result.items : [];
    return items.flatMap((item): SlashCommand[] => {
      if (!isObj(item)) return [];
      const name = str(item.text).trim().replace(/^\//, "");
      if (!name) return [];
      const meta = str(item.meta);
      return [{ name, ...(meta ? { description: meta } : {}), source: str(item.kind) || "command" }];
    });
  }

  async steer(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.prompt(text, images ?? []);
  }

  async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.prompt(text, images ?? []);
  }

  async abort(): Promise<void> {
    const id = this.runtimeId;
    if (!id) return;
    await this.live.request("session.interrupt", { session_id: id });
  }

  async setConfig(patch: { model?: string; thinkingLevel?: string }): Promise<void> {
    const id = this.requireSession();
    if (patch.model !== undefined) {
      const value = await this.switchTarget(patch.model);
      const result = await this.live.request<Obj>("config.set", { session_id: id, key: "model", value, confirm_expensive_model: false });
      if (result?.confirm_required === true) throw new Error(str(result.confirm_message) || "That model needs confirmation");
      this.pickedKey = patch.model;
      this.models = null;
    }
    if (patch.thinkingLevel !== undefined) {
      await this.live.request("config.set", { session_id: id, key: "reasoning", value: patch.thinkingLevel });
    }
  }

  /**
   * What config.set's model takes for a picked key ("provider/model"): the
   * model and `--provider`, as Hermes's own picker sends it. Given the bare key,
   * Hermes keeps the provider it is on and takes the whole key as the model's
   * name, so a pick from another provider goes to the old endpoint (a local
   * server, say) under a name it does not know, and the turn retries until it
   * gives up.
   */
  private async switchTarget(key: string): Promise<string> {
    const ask = (params: Obj) => this.live.request<Obj>("model.options", params);
    this.models ??= await this.adapter.listModels(this.cwd, false, ask);
    let picked = this.models.find((m) => m.key === key);
    // A list read before the gateway's providers changed: read it again once.
    if (!picked) {
      this.models = await this.adapter.listModels(this.cwd, true, ask);
      picked = this.models.find((m) => m.key === key);
    }
    return picked?.provider ? `${picked.id} --provider ${picked.provider}` : key;
  }

  async refreshModels(): Promise<void> {
    this.models = await this.adapter.listModels(this.cwd, true, (params) => this.live.request<Obj>("model.options", params));
  }

  async rename(name: string): Promise<void> {
    const id = this.requireSession();
    await this.live.request("session.title", { session_id: id, title: name });
    this.sessionTitle = name;
  }

  async compact(instructions?: string): Promise<void> {
    const id = this.requireSession();
    await this.live.request("session.compress", { session_id: id, ...(instructions ? { focus_topic: instructions } : {}) });
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.hub.clear();
    const rpc = this.rpc;
    this.rpc = null;
    if (!rpc) return;
    // A child of ours holds a session nobody else can see, so it is ended with the chat.
    // An attached one serves a gateway that keeps the session (another client may hold it
    // too, and its lifetime is the gateway's business): detaching is all this is.
    if (!rpc.attached && this.runtimeId) await rpc.request("session.close", { session_id: this.runtimeId }).catch(() => undefined);
    await rpc.kill().catch(() => undefined);
  }

  private requireSession(): string {
    if (!this.runtimeId) throw new Error("This chat has no hermes session yet");
    return this.runtimeId;
  }
}

/**
 * The catalog key for the model a session is on. Hermes reports the model and
 * its provider apart, and the model may already read "vendor/model" (an
 * endpoint group's models, or a name carried over by a bare switch). A catalog
 * entry counts only when its provider is the one reported, or, for "custom",
 * one of the user-defined endpoints. A name sent to the wrong provider (a
 * "opencode-go/deepseek-v4.1-flash" that went to the local endpoint) gets a key
 * outside the catalog, so the picker shows nothing picked instead of claiming
 * the model the requests are not going to.
 */
export function hermesModelKey(model: string, provider: string, models: readonly ModelInfo[], userDefined: ReadonlySet<string>): string {
  if (!model) return "";
  const plain = model.includes("/") || !provider ? model : `${provider}/${model}`;
  if (!provider) return plain;
  const fits = (m: ModelInfo) => m.provider === provider || (provider === "custom" && m.provider !== undefined && userDefined.has(m.provider));
  const byId = models.filter((m) => m.id === model && fits(m));
  const exact = byId.find((m) => m.provider === provider) ?? byId[0];
  if (exact) return exact.key;
  const byKey = models.find((m) => m.key === model && fits(m));
  if (byKey) return byKey.key;
  return models.some((m) => m.key === plain) ? `${provider}/${model}` : plain;
}

function approvalChoice(answer: InteractionAnswer, choices: string[]): string {
  if (answer.kind === "select") {
    const picked = choices.find((choice) => choice.toLowerCase() === answer.value.trim().toLowerCase());
    if (picked) return picked;
    if (choices.includes("once")) return "once";
    return "deny";
  }
  if (answer.kind === "confirm") return answer.confirmed ? (choices.includes("once") ? "once" : choices[0] ?? "once") : "deny";
  return "deny";
}

function toTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (!isObj(entry)) continue;
    const text = str(entry.text) || str(entry.content) || str(entry.task);
    if (!text) continue;
    const status = str(entry.status);
    items.push({
      text,
      status: status === "completed" || status === "done" ? "completed" : status === "in_progress" || status === "running" ? "in_progress" : "pending",
    });
  }
  return items;
}

export class HermesAdapter implements HarnessAdapter {
  readonly id = asHarnessId("hermes");
  readonly displayName = "Hermes";
  readonly accent = "orange";
  readonly setupCommand = "hermes model";
  readonly cliCommand: string;
  readonly capabilities: HarnessCapabilities = {
    supportsSteer: true,
    supportsFollowUp: true,
    supportsThinkingLevel: true,
    supportsCompact: true,
    supportsExtensions: false,
    supportsInteractiveRequests: true,
    supportsRename: true,
    supportsModelSelection: true,
    supportsFork: false,
    supportsHandoff: false,
    supportsRewind: true,
    supportsHtmlRender: false,
    // Its steer and follow-up are prompts sent at once: nothing waits in a queue.
    supportsQueueEdit: false,
    supportsPermissionMode: false,
    supportsResumeCommand: false,
  };
  private probes = new Map<string, { at: number; models: ModelInfo[]; userDefined: Set<string> }>();
  private rowCache: { at: number; rows: StoredRow[] } | null = null;

  /**
   * `launcher`: the hermes command (config's, after HERMES_BIN). `command` and
   * `args` start a gateway directly instead of finding it through the
   * launcher (tests point them at a script).
   */
  constructor(private readonly options: { launcher?: string; command?: string; args?: string[] } = {}) {
    this.cliCommand = options.launcher ?? (process.env.HERMES_BIN?.trim() || "hermes");
  }

  /** Hermes has no session-fork API; the capability is false and the UI hides it. */
  async forkSession(): Promise<{ nativeId: string }> {
    throw new Error("Hermes sessions cannot be forked");
  }

  /**
   * The gateway has no way to record turns without running them: every
   * `prompt.submit` is a live agent turn with tools, so replaying a transcript
   * would re-run it. Its importer reads Claude Code and Codex stores only.
   */
  async seedChat(): Promise<LiveChat> {
    throw new Error("Hermes cannot take a handoff: it can only record turns by running them");
  }

  /** The home's owner, cached for a moment: every chat and probe would otherwise identify afresh. */
  private endpointCache: { at: number; home: string; endpoint: GatewayEndpoint | null } | null = null;

  private async endpoint(home: string, fresh = false): Promise<GatewayEndpoint | null> {
    const cached = this.endpointCache;
    if (!fresh && cached && cached.home === home && Date.now() - cached.at < ENDPOINT_TTL_MS) return cached.endpoint;
    const endpoint = await gatewayEndpoint(home);
    this.endpointCache = { at: Date.now(), home, endpoint };
    return endpoint;
  }

  /**
   * The connection a probe uses: an attachment to the gateway that owns the home, else a
   * gateway child of our own. Probes are reads (`projects.tree`, `model.options`) and a
   * running owner can serve them, which is also far cheaper than starting a child for each.
   */
  async openProbe(cwd: string, onRequest: (frame: GatewayFrame) => void): Promise<GatewayLink> {
    if (!this.options.command) {
      const home = await this.resolveAgentDir();
      const link = await this.attach(home, (endpoint, ticket) => GatewaySocket.open(endpoint, ticket, () => undefined, onRequest));
      if (link) return link;
    }
    const { command, args, env } = await this.spawnSpec();
    return track(new HermesRpc(command, args, env, cwd, () => undefined, onRequest));
  }

  /**
   * The connection one chat runs on: the home's gateway, which is where its sessions
   * live and what every other Hermes surface sees. When none answers, the bootstrap
   * upstream's own clients use starts one (`hermes gateway ensure`: an unmanaged daemon
   * that idles out), so a chat never needs the stdio entry point Hermes 2026.9.24
   * retired — a wire change lands in the canonical shim (hermes-canonical.ts), not in
   * every call site. The stdio child remains only for a home no gateway can run
   * against at all.
   */
  async openChatLink(cwd: string, onEvent: (params: Obj) => void, onRequest: (frame: GatewayFrame) => void): Promise<GatewayLink> {
    if (!this.options.command) {
      const home = await this.resolveAgentDir();
      if (!(await this.endpoint(home))) await this.ensureGateway();
      const link = await this.attach(home, (endpoint, ticket) => CanonicalChatLink.open(endpoint, ticket, onEvent, onRequest));
      if (link) return link;
      const owner = await gatewayOwner(home);
      if (owner !== null) throw new Error(`a Hermes gateway (pid ${owner}) owns this Hermes home but is not answering on its control socket yet; awui cannot run a chat against it`);
    }
    const { command, args, env } = await this.spawnSpec();
    return track(new HermesRpc(command, args, env, cwd, onEvent, onRequest));
  }

  /** `hermes gateway ensure`: this home's gateway, started when none answers (it idles out on its own). */
  private async ensureGateway(): Promise<void> {
    await run(this.cliCommand, ["gateway", "ensure", "--json", "--timeout", "60"], { timeout: 75_000 }).catch(() => undefined);
    // A new owner may be serving now; the cached "nobody answers" is stale.
    this.endpointCache = null;
  }

  /** Attach to the home's owner through `dial`, or null when there is none (or it went away mid-handshake). */
  private async attach(home: string, dial: (endpoint: GatewayEndpoint, ticket: string) => Promise<GatewayLink>): Promise<GatewayLink | null> {
    // Twice, because an owner can be replaced between its identify answer and the dial
    // (an update, a restart) and the old endpoint then points at a closed port.
    for (let attempt = 0; attempt < 2; attempt++) {
      const endpoint = await this.endpoint(home);
      if (!endpoint) return null;
      try {
        const ticket = await gatewayTicket(home, endpoint);
        return track(await dial(endpoint, ticket));
      } catch (error) {
        this.endpointCache = null;
        if (attempt === 1) throw error;
      }
    }
    return null;
  }

  async spawnSpec(): Promise<{ command: string; args: string[]; env: NodeJS.ProcessEnv }> {
    if (this.options.command) return { command: this.options.command, args: this.options.args ?? [], env: { ...process.env } };
    const runtime = await gatewayRuntime(this.cliCommand);
    // A launcher that answered for itself hands over the whole argv: the installer's Python
    // needs its `-I -c` bootstrap to put the checkout on sys.path and find tui_gateway.
    if (runtime.argv) {
      const [command = runtime.python, ...args] = runtime.argv;
      return { command, args, env: runtime.env };
    }
    return { command: runtime.python, args: ["-m", "tui_gateway.entry"], env: runtime.env };
  }

  async discover(): Promise<HarnessDiscovery> {
    const warnings: string[] = [];
    const overrides = { HERMES_HOME: process.env.HERMES_HOME ? ("set" as const) : ("unset" as const) };
    const home = await this.resolveAgentDir();
    // A gateway that owns the home is the authority: chats and session rows both come
    // from it, and it is what upstream's clients attach to (see hermes-gateway.ts).
    const endpoint = await this.endpoint(home, true);
    if (endpoint) {
      // Attached: its version is the one serving this home, and the CLI on PATH may be older,
      // newer, or absent. Session rows, models, and chats all come from the gateway —
      // the canonical wire is what upstream's own surfaces run on (see hermes-canonical.ts).
      const label = versionLabel(endpoint.version ?? "unknown");
      const detail = endpoint.version && endpoint.codeSha ? `${endpoint.version} · gateway ${endpoint.codeSha.slice(0, 8)}` : undefined;
      return { available: true, ...label, ...(detail ? { versionDetail: detail } : {}), warnings, overrides };
    }
    const owner = await gatewayOwner(home);
    if (owner !== null) {
      // Someone holds the home but does not answer on its control socket (still starting,
      // or wedged). A gateway child of ours would be refused, so name what is wrong.
      return {
        available: false,
        reason: `a Hermes gateway (pid ${owner}) owns the Hermes home but is not answering on its control socket yet`,
        warnings,
        overrides,
      };
    }
    try {
      const { stdout } = await run(this.cliCommand, ["--version"], { timeout: 15_000 });
      const label = versionLabel(stdout.trim().split("\n")[0]?.replace(/^Hermes Agent\s*/i, "") || "unknown");
      const runtime = await gatewayRuntime(this.cliCommand);
      // What matters is that the gateway module imports, wherever the interpreter came from.
      // A launcher that printed its own launch command has already resolved that for us.
      const imports =
        runtime.argv !== undefined ||
        (await run(runtime.python, ["-c", "import tui_gateway.entry"], { env: runtime.env, timeout: 15_000 }).then(
          () => true,
          () => false,
        ));
      if (!imports) {
        const from = runtime.source === "PATH" ? "on PATH (the hermes launcher names no Python)" : runtime.source === "HERMES_PYTHON" ? "from HERMES_PYTHON" : "from the hermes launcher";
        warnings.push(`${runtime.python} ${from} cannot import Hermes's tui_gateway; set HERMES_PYTHON to the Python of the Hermes install`);
      }
      return { available: true, ...label, warnings, overrides };
    } catch (error) {
      return {
        available: false,
        reason: `Cannot run ${this.cliCommand}: ${error instanceof Error ? error.message : String(error)}`,
        warnings,
        overrides: {},
      };
    }
  }

  workspaceProblem(): string | null {
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    return process.env.HERMES_HOME?.trim() || path.join(homedir(), ".hermes");
  }

  async resolveSessionDir(): Promise<string> {
    return path.join(await this.resolveAgentDir(), "sessions");
  }

  /** A throwaway connection — attached when the home has an owner — that touches no chat's session. */
  private async withProbe<T>(cwd: string, fn: (rpc: GatewayLink) => Promise<T>): Promise<T> {
    let link!: GatewayLink;
    link = await this.openProbe(cwd, (frame) => {
      link.respond(frame.id as string | number, { value: "" });
    });
    try {
      await link.ready;
      await link.request("client.capabilities", { server_requests: true });
      return await fn(link);
    } finally {
      await link.kill().catch(() => undefined);
    }
  }

  /**
   * The gateway's model.options, cached per project. `ask` sends it through a
   * gateway that is already running (a live chat's); without one a probe
   * child is started for it.
   */
  async listModels(cwd: string, refresh = false, ask?: (params: Obj) => Promise<Obj>): Promise<ModelInfo[]> {
    const cached = this.probes.get(cwd);
    if (!refresh && cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.models;
    const params = refresh ? { refresh: true } : {};
    const result = ask ? await ask(params) : await this.withProbe(cwd, (rpc) => rpc.request<Obj>("model.options", params));
    const models: ModelInfo[] = [];
    const seen = new Set<string>();
    const userDefined = new Set<string>();
    for (const provider of Array.isArray(result?.providers) ? result.providers : []) {
      if (!isObj(provider)) continue;
      const slug = str(provider.slug);
      // A virtual provider (MoA) names itself to the user; a normal one is its slug.
      const providerName = str(provider.source) === "virtual" ? str(provider.name) || undefined : undefined;
      if (provider.is_user_defined === true) userDefined.add(slug);
      const capabilities = isObj(provider.capabilities) ? provider.capabilities : {};
      for (const model of Array.isArray(provider.models) ? provider.models : []) {
        const id = String(model);
        const capability = capabilities[id];
        const key = `${slug}/${id}`;
        if (seen.has(key)) continue; // several endpoints can expose the same provider/model id
        seen.add(key);
        models.push({ key, provider: slug, ...(providerName ? { providerName } : {}), id, name: id, ...(isObj(capability) && capability.reasoning === true ? { reasoning: true } : {}) });
      }
    }
    this.probes.set(cwd, { at: Date.now(), models, userDefined });
    return models;
  }

  /** The providers in the last catalog read for `cwd` that are the user's own endpoints (Hermes's "custom"). */
  userDefinedProviders(cwd: string): ReadonlySet<string> {
    return this.probes.get(cwd)?.userDefined ?? new Set();
  }

  async listThinkingLevels(): Promise<string[]> {
    return REASONING_LEVELS;
  }

  /** Stored session rows across every project (one probe, cached briefly). */
  private rowRefresh: Promise<StoredRow[]> | null = null;

  /**
   * Stored session rows, stale-while-revalidate: a probe gateway takes ~2.4 s
   * to start, and the sidebar list waits for every harness, so once rows are
   * cached an expired cache is served as is while one refresh runs behind it.
   * Only the first listing waits. Live chats reach the list separately, so a
   * session started here shows before the refresh lands.
   */
  private async rows(cwd: string): Promise<StoredRow[]> {
    const cached = this.rowCache;
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.rows;
    this.rowRefresh ??= this.fetchRows(cwd).finally(() => {
      this.rowRefresh = null;
    });
    if (cached) {
      this.rowRefresh.catch(() => undefined);
      return cached.rows;
    }
    return this.rowRefresh;
  }

  private async fetchRows(cwd: string): Promise<StoredRow[]> {
    const tree = await this.withProbe(cwd, (rpc) => rpc.request<Obj>("projects.tree", { preview_limit: 200 }));
    const rows: StoredRow[] = [];
    for (const project of Array.isArray(tree?.projects) ? tree.projects : []) {
      if (!isObj(project)) continue;
      for (const row of Array.isArray(project.previewSessions) ? project.previewSessions : []) {
        if (!isObj(row) || !str(row.id)) continue;
        const lastActive = num(row.last_active) ?? num(row.started_at);
        rows.push({
          id: str(row.id),
          title: str(row.title),
          cwd: str(row.cwd),
          lastActive,
          messageCount: num(row.message_count),
        });
      }
    }
    this.rowCache = { at: Date.now(), rows };
    return rows;
  }

  async listSessions(cwd: string): Promise<NativeSessionSummary[]> {
    const rows = await this.rows(cwd);
    return rows
      .filter((row) => row.cwd === cwd)
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
      .map(toSummary);
  }

  /**
   * A session's rows, for a chat that opens before its gateway does (the manager's deferred
   * resume: the transcript shows at once and the harness starts behind it). The gateway resolves
   * a session by id alone, so the folder is checked here — a session that belongs to another
   * project is not this workspace's to open, and null sends the manager to its session-list guard,
   * which says exactly that. A session with nothing in it yet answers with no rows, which is what
   * makes a chat opened and left unused reopenable.
   */
  async readTranscript(req: { cwd: string; nativeId: string }): Promise<{ items: ChatItem[]; title: string | null } | null> {
    if (this.options.command) return null;
    const home = await this.resolveAgentDir();
    const link = await this.attach(home, (endpoint, ticket) => CanonicalChatLink.open(endpoint, ticket, () => undefined, () => undefined));
    if (!link) return null;
    try {
      const result = await link.request<Obj>("session.history", { session_id: req.nativeId });
      const info = isObj(result?.info) ? result.info : {};
      const folder = str(info.cwd);
      if (folder && path.resolve(folder) !== path.resolve(req.cwd)) return null;
      return { items: transcriptItems(Array.isArray(result?.messages) ? result.messages : []), title: str(info.title) || null };
    } catch (error) {
      // The gateway lists these and then refuses to mount them (older awui chats, source
      // `webui`). The rows are still in state.db; show them, and let openChat say why a
      // new turn cannot run here.
      if (!(error instanceof HermesRpcError) || error.message !== "not_found") throw error;
      return this.storedTranscript(req);
    } finally {
      await link.kill().catch(() => undefined);
    }
  }

  /**
   * A session the gateway will not mount, read from the home's state.db. Read-only, and
   * only the columns the transcript needs: this is the harness's own store, not a second
   * one. Null when the row is missing or belongs to another folder, so the manager's
   * session-list guard still says that.
   */
  private async storedTranscript(req: { cwd: string; nativeId: string }): Promise<{ items: ChatItem[]; title: string | null } | null> {
    const file = path.join(await this.resolveAgentDir(), "state.db");
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(file, { readOnly: true });
    } catch {
      return null;
    }
    try {
      const session = db.prepare("SELECT cwd, title FROM sessions WHERE id = ?").get(req.nativeId) as { cwd?: unknown; title?: unknown } | undefined;
      if (!session) return null;
      const folder = str(session.cwd);
      if (folder && path.resolve(folder) !== path.resolve(req.cwd)) return null;
      // Indexed on (session_id, id). Enough for a chat; a longer one is cut, as every other transcript read is.
      const rows = db.prepare("SELECT id, role, content, tool_name, tool_call_id, reasoning, timestamp FROM messages WHERE session_id = ? AND active = 1 ORDER BY id LIMIT 4000").all(req.nativeId) as Array<Record<string, unknown>>;
      const messages = rows.map((row) => ({
        role: str(row.role),
        ...(row.content !== undefined ? { content: row.content } : {}),
        ...(typeof row.content === "string" && row.content ? { text: row.content } : {}),
        ...(str(row.tool_name) ? { name: str(row.tool_name) } : {}),
        ...(str(row.tool_call_id) ? { tool_call_id: str(row.tool_call_id) } : {}),
        ...(str(row.reasoning) ? { reasoning: str(row.reasoning) } : {}),
        ...(typeof row.timestamp === "number" ? { timestamp: row.timestamp } : {}),
        ...(typeof row.id === "number" ? { row_id: row.id } : {}),
      }));
      return { items: transcriptItems(messages), title: str(session.title) || null };
    } catch {
      return null;
    } finally {
      db.close();
    }
  }

  async listRecentSessions(limit: number): Promise<RecentNativeSession[]> {
    const rows = await this.rows(homedir());
    return rows
      .filter((row) => row.cwd)
      .sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0))
      .slice(0, limit)
      .map((row) => ({ ...toSummary(row), cwd: row.cwd }));
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    const chat = new HermesLiveChat(this, req.cwd);
    try {
      await chat.start(req.resumeNativeId ?? null);
    } catch (error) {
      await chat.dispose().catch(() => undefined);
      throw error;
    }
    return chat;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...liveLinks].map((link) => link.kill()));
  }
}
