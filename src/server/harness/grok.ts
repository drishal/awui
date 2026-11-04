// Grok adapter: one `grok agent --no-leader stdio` child per live chat, speaking
// the Agent Client Protocol (JSON-RPC over stdio). The installed CLI stays the
// source of truth for models, login, permissions, and session files; this module
// translates its frames into HarnessEvents and reads `~/.grok` read-only (a chat
// is a child of its own, never a second writer on the leader's session).
// Grok's `session/update` payloads are folded in grok-transcript.ts, shared with
// the file reader, so a resumed chat and a running one cannot drift.
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
  type ConfigPatch,
  type ContextUsage,
  type HarnessCapabilities,
  type ImageAttachment,
  type InteractionAnswer,
  type InteractionRequest,
  type ModelInfo,
  type SlashCommand,
  type TodoItem,
} from "../../shared/protocol.js";
import { embeddedVersion } from "../embedded.js";
import { boundText, isObj, type Obj } from "./agent-events.js";
import { PendingRequests, StderrTail, terminateChild } from "./child-process.js";
import { DialogTracker, EventHub } from "./event-hub.js";
import {
  addTurn,
  emptyUsage,
  encodedCwd,
  firstPrompt,
  foldSessionUpdate,
  foldsFromJsonl,
  isSessionId,
  itemsFromFolds,
  parseSummary,
  updateOf,
  usageFromFolds,
  type ParsedSummary,
  type UsageFold,
} from "./grok-transcript.js";
import { versionLabel } from "./version.js";
import type {
  HarnessAdapter,
  HarnessDiscovery,
  HarnessEventListener,
  HarnessUsage,
  LiveChat,
  NativeSessionSummary,
  OpenChatRequest,
  RecentNativeSession,
  StepUsage,
  UsageEntry,
} from "./types.js";

/** How long the initialize or session handshake may take. */
const READY_TIMEOUT_MS = 60_000;
const MODEL_CACHE_MS = 60_000;
/** How long abort waits for the cancelled turn's own result before settling it itself. */
const ABORT_WAIT_MS = 30_000;
/** Session files are read whole below this bound, as their first and last halves above it. */
const MAX_SESSION_BYTES = 8 * 1024 * 1024;
/** A session with no generated title takes its first prompt from this much of the jsonl head. */
const HEAD_BYTES = 64 * 1024;
/** `agent --no-leader`: a child of its own, so no other Grok surface shares this session's writer. */
const AGENT_ARGS = ["agent", "--no-leader"];
const MODE = "stdio";
const CLIENT_VERSION = embeddedVersion ?? "dev";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/** The tool input as one bounded line, for the approval card. */
function inputLine(raw: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(raw ?? {});
  } catch {
    text = "";
  }
  return oneLine(text ?? "", 500);
}

function errorText(value: unknown): string {
  if (isObj(value) && typeof value.message === "string") return value.message;
  return typeof value === "string" && value ? value : "grok reported an error";
}

/**
 * The id a response frame answers, or null. A frame with `method` is a request
 * or a notification, never a response: Grok's permission requests carry an id
 * (often a number) and must not settle the prompt that is in flight.
 */
function answeredId(frame: Obj): string | null {
  if (frame.method !== undefined) return null;
  if (frame.result === undefined && frame.error === undefined) return null;
  return typeof frame.id === "string" ? frame.id : null;
}

// Every grok child this process spawned; killed on shutdown and on exit.
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

export function liveGrokChildren(): number {
  return children.size;
}

/** One grok child: JSON-RPC requests out, everything else handed to `onFrame`. */
class GrokRpc {
  readonly child: ChildProcessWithoutNullStreams;
  exited = false;
  private readonly stderr: StderrTail;
  private exitListeners = new Set<(message: string) => void>();
  private readonly calls = new PendingRequests<string>(
    {
      // String ids: a numeric permission request's id must never settle ours.
      formatId: (n) => `c${n}`,
      encode: (id, payload) => ({ jsonrpc: "2.0", id, ...payload }),
      answeredId,
      outcome: (frame) => (frame.error !== undefined ? { error: new Error(errorText(frame.error)) } : { value: frame.result }),
    },
    (frame) => this.write(frame),
  );

  constructor(
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    cwd: string,
    private readonly onFrame: (frame: Obj) => void,
    /** Called synchronously inside the line handler for a frame that answers one of our requests. */
    private readonly onAnswered: (frame: Obj) => void,
  ) {
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
      if (!isObj(frame)) return;
      // The hook runs before any later line of this chunk is read: a response can
      // change how the very next line must be handled.
      if (this.calls.accept(frame)) {
        this.onAnswered(frame);
        return;
      }
      this.onFrame(frame);
    });
    this.child.stdin.on("error", () => undefined);
    const onExit = (detail: string) => {
      if (this.exited) return;
      this.exited = true;
      const reason = this.stderr.reason();
      const message = reason ? `${detail}: ${reason}` : detail;
      this.calls.failAll(message);
      for (const l of this.exitListeners) l(message);
    };
    this.child.once("error", (error) => onExit(`could not start grok (${error.message})`));
    this.child.once("exit", (code, signal) => onExit(`grok exited (${signal ?? `code ${code}`})`));
  }

  onExit(listener: (message: string) => void): void {
    this.exitListeners.add(listener);
  }

  /** `null` timeout waits forever (a prompt's result comes when the turn ends). */
  request<T = unknown>(method: string, params: Obj, timeoutMs?: number | null): Promise<T> {
    return this.calls.send<T>({ method, params }, `grok did not answer ${method}`, timeoutMs);
  }

  /** A notification (no id): session/cancel. */
  notify(method: string, params: Obj): void {
    this.tryWrite({ jsonrpc: "2.0", method, params });
  }

  /** The result of a request Grok made of this host, with that request's own id. */
  respond(id: unknown, result: unknown): void {
    this.tryWrite({ jsonrpc: "2.0", id, result });
  }

  respondError(id: unknown, code: number, message: string): void {
    this.tryWrite({ jsonrpc: "2.0", id, error: { code, message } });
  }

  private tryWrite(frame: Obj): void {
    try {
      this.write(frame);
    } catch {
      // The child is gone; so is whatever it asked.
    }
  }

  private write(frame: Obj): void {
    if (this.exited) throw new Error("grok is not running");
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  kill(): Promise<void> {
    return terminateChild(this.child);
  }
}

interface ModelTable {
  models: ModelInfo[];
  /** Each model's own context window, from `_meta.totalContextTokens`. */
  windows: Map<string, number>;
  /** `_meta.contextWindows`, for a build that gives the window no model. */
  windowsList: number[];
  current: string | null;
}

/**
 * `models` on session/new and session/load, and `modelState` on initialize:
 * the same shape either way. The listed order is kept: Grok lists a model's
 * reasoning efforts strongest first, and the picker shows them as given.
 */
function modelsFrom(raw: Obj): ModelTable {
  const models: ModelInfo[] = [];
  const windows = new Map<string, number>();
  const windowsList: number[] = [];
  for (const entry of Array.isArray(raw.availableModels) ? raw.availableModels : []) {
    if (!isObj(entry)) continue;
    const id = str(entry.modelId) || str(entry.id);
    if (!id) continue;
    const meta = isObj(entry._meta) ? entry._meta : {};
    const levels = (Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : [])
      .map((effort) => (isObj(effort) ? str(effort.value) || str(effort.id) : ""))
      .filter(Boolean);
    if (typeof meta.totalContextTokens === "number" && Number.isFinite(meta.totalContextTokens)) windows.set(id, meta.totalContextTokens);
    for (const size of Array.isArray(meta.contextWindows) ? meta.contextWindows : []) {
      if (typeof size === "number" && Number.isFinite(size)) windowsList.push(size);
    }
    models.push({ key: id, provider: "grok", id, name: str(entry.name) || id, ...(levels.length > 0 ? { reasoning: true, levels } : {}) });
  }
  return { models, windows, windowsList, current: str(raw.currentModelId) || null };
}

/** One session config option Grok offered (model, reasoning_effort). */
interface ConfigOption {
  currentValue: string;
  options: Array<{ value: string; name: string; description?: string }>;
}

function optionsFrom(raw: unknown): Map<string, ConfigOption> {
  const out = new Map<string, ConfigOption>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isObj(entry) || entry.type !== "select") continue;
    const id = str(entry.id);
    if (!id) continue;
    const options = (Array.isArray(entry.options) ? entry.options : [])
      .filter(isObj)
      .map((option) => ({
        value: str(option.value),
        name: str(option.name) || str(option.value),
        ...(str(option.description) ? { description: str(option.description) } : {}),
      }))
      .filter((option) => option.value);
    out.set(id, { currentValue: str(entry.currentValue), options });
  }
  return out;
}

interface SessionMeta {
  id: string;
  cwd: string;
  /** What Grok generated, or null: the first prompt is a fallback, not a title. */
  generatedTitle: string | null;
  title: string;
  updatedAt: Date;
  messageCount?: number;
}

async function realpathOr(target: string): Promise<string> {
  return fs.realpath(target).catch(() => path.resolve(target));
}

/** The first complete lines of a cut text (a bounded read's head). */
const cutHead = (text: string): string => {
  const at = text.lastIndexOf("\n");
  return at >= 0 ? text.slice(0, at) : "";
};
/** The lines after the first cut (a bounded read's tail). */
const cutTail = (text: string): string => {
  const at = text.indexOf("\n");
  return at >= 0 ? text.slice(at + 1) : text;
};

/** A session file's text: whole below the bound, else its first and last halves with the cut lines dropped. */
async function readSessionText(file: string): Promise<string | null> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  if (stat.size <= MAX_SESSION_BYTES) return fs.readFile(file, "utf8").catch(() => null);
  const half = MAX_SESSION_BYTES / 2;
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    const headRead = await handle.read(head, 0, half, 0);
    const tailRead = await handle.read(tail, 0, half, stat.size - half);
    return `${cutHead(head.subarray(0, headRead.bytesRead).toString("utf8"))}\n${cutTail(tail.subarray(0, tailRead.bytesRead).toString("utf8"))}`;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

class GrokLiveChat implements LiveChat {
  private hub = new EventHub();
  private dialogs = new DialogTracker(this.hub);
  private rpc: GrokRpc | null = null;
  private disposed = false;
  private sessionId: string | null = null;
  /** Set in the line handler when the session response lands; until then every update is a replay. */
  private accepting = false;
  private awaitingSession = false;
  private model: string | null = null;
  private level: string | null = null;
  private models: ModelInfo[] = [];
  private windows = new Map<string, number>();
  private windowsList: number[] = [];
  private options = new Map<string, ConfigOption>();
  /** A build that does not say `promptCapabilities.image === true` cannot take one. */
  private imageCapable = false;
  private usage: HarnessUsage = emptyUsage();
  /** One unpriced turn makes the session total unpriced from then on. */
  private incomplete = { value: false };
  private lastTurn: UsageFold | null = null;
  /** The finished turn's tokens, for the empty assistant_end that closes it. */
  private turnStep: StepUsage | null = null;
  private turnOpen = false;
  private promptRpc: Promise<unknown> | null = null;
  private assistantOpen = false;
  private readonly openTools = new Set<string>();
  private readonly permissionOptions = new Map<string, string[]>();

  constructor(
    private readonly adapter: GrokAdapter,
    private readonly cwd: string,
    private readonly resumeId: string | null,
  ) {}

  get nativeId(): string | null {
    return this.sessionId;
  }

  get title(): string | null {
    return null;
  }

  private get live(): GrokRpc {
    if (!this.rpc || this.rpc.exited) throw new Error("grok is not running for this chat");
    return this.rpc;
  }

  private emit(event: Parameters<HarnessEventListener>[0]): void {
    this.hub.emit(event);
  }

  async start(): Promise<void> {
    // Before the child starts: its load replay repeats the file's turn_completed
    // lines, and those must not be counted on top of the ones seeded here.
    if (this.resumeId) await this.seedUsage(this.resumeId);
    const rpc = new GrokRpc(this.adapter.cliCommand, this.adapter.chatArgs, this.adapter.childEnv(), this.cwd, (frame) => this.onFrame(frame), (frame) => this.onSessionFrame(frame));
    this.rpc = rpc;
    rpc.onExit((message) => {
      if (this.disposed) return;
      this.dialogs.cancelAll();
      this.emit({ type: "fatal", message: `grok stopped unexpectedly (${message})` });
    });
    try {
      const init = await rpc.request<Obj>("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "awui", version: CLIENT_VERSION } }, READY_TIMEOUT_MS);
      this.readInitialize(init);
      this.awaitingSession = true;
      const result = this.resumeId
        ? await rpc.request<Obj>("session/load", { sessionId: this.resumeId, cwd: this.cwd, mcpServers: [] }, READY_TIMEOUT_MS)
        : await rpc.request<Obj>("session/new", { cwd: this.cwd, mcpServers: [] }, READY_TIMEOUT_MS);
      // A load answers without an id: the one asked for is the session's.
      const nativeId = this.applySession(result, this.resumeId ?? str(result.sessionId));
      this.emit({ type: "session", nativeId });
      this.emit({ type: "config", config: await this.getConfig() });
    } catch (error) {
      await rpc.kill().catch(() => undefined);
      throw error;
    }
  }

  private readInitialize(init: Obj): void {
    const version = init.protocolVersion;
    if (typeof version === "number" && version !== 1) this.emit({ type: "notice", level: "warning", text: `Grok spoke ACP protocol ${version}; awui expects 1.` });
    this.imageCapable = isObj(init.promptCapabilities) && init.promptCapabilities.image === true;
  }

  private applySession(result: Obj, sessionId: string): string {
    if (!isSessionId(sessionId)) throw new Error("Grok did not name a session");
    this.sessionId = sessionId;
    const table = isObj(result.models) ? modelsFrom(result.models) : null;
    if (table) this.applyModels(table);
    this.options = optionsFrom(result.configOptions);
    this.model = this.options.get("model")?.currentValue || table?.current || null;
    this.level = this.options.get("reasoning_effort")?.currentValue || null;
    return sessionId;
  }

  private applyModels(table: ModelTable): void {
    this.models = table.models;
    this.windows = table.windows;
    this.windowsList = table.windowsList;
  }

  /** Runs synchronously in the stdout line handler; the session response makes updates live. */
  private onSessionFrame(frame: Obj): void {
    if (!this.awaitingSession || !isObj(frame.result)) return;
    this.awaitingSession = false;
    this.accepting = true;
  }

  /** The session's own jsonl file, with everything before the first prompt dropped as history. */
  private async seedUsage(nativeId: string): Promise<void> {
    const file = await this.adapter.sessionUpdates(this.cwd, nativeId);
    const text = file ? await readSessionText(file) : null;
    if (text === null) return;
    const seeded = usageFromFolds(foldsFromJsonl(text));
    this.usage = seeded.usage;
    this.incomplete = { value: seeded.usage.cost === null };
    this.lastTurn = seeded.last;
  }

  // ---- the child's frames -------------------------------------------------------

  private onFrame(frame: Obj): void {
    const method = typeof frame.method === "string" ? frame.method : null;
    if (method === null) return;
    if (method === "_x.ai/session/setup" || method === "_x.ai/mcp/servers_updated") return;
    const update = updateOf(frame);
    if (update) {
      // During session/load Grok replays the conversation; history() already read it.
      if (this.accepting) this.onUpdate(update);
      return;
    }
    if (method === "session/request_permission") {
      this.onPermission(frame);
      return;
    }
    if (frame.id !== undefined) {
      // An unanswered request leaves the agent waiting forever.
      this.rpc?.respondError(frame.id, -32601, `awui does not implement ${method}`);
    }
  }

  private onUpdate(update: Obj): void {
    const fold = foldSessionUpdate(update, Date.now());
    switch (fold.type) {
      case "user":
        // Grok does not echo the prompt (the documented updates start at the
        // agent's own chunks). The user row is emitted when the request is
        // written, so a chunk here would paint it a second time.
        return;
      case "delta": {
        if (!this.assistantOpen) {
          this.assistantOpen = true;
          this.emit({ type: "assistant_start", ...(this.model ? { model: this.model } : {}) });
        }
        this.emit({ type: "assistant_delta", field: fold.field, delta: fold.delta });
        return;
      }
      case "tool_start": {
        // The tool call closes the text bubble; later words start a new one.
        this.assistantOpen = false;
        this.openTools.add(fold.toolCallId);
        this.emit({ type: "tool_start", toolCallId: fold.toolCallId, name: fold.name, args: fold.args });
        return;
      }
      case "tool_update":
        this.emit({ type: "tool_update", toolCallId: fold.toolCallId, output: boundText(fold.output).text });
        return;
      case "tool_end": {
        this.openTools.delete(fold.toolCallId);
        this.emit({ type: "tool_end", toolCallId: fold.toolCallId, output: boundText(fold.output).text, isError: fold.isError, ...(fold.details ? { details: fold.details } : {}) });
        return;
      }
      case "usage":
        this.lastTurn = fold.usage;
        this.turnStep = fold.usage.step;
        this.usage = addTurn(this.usage, fold.usage, this.incomplete);
        return;
      case "notice":
        this.emit({ type: "notice", level: "info", text: fold.text });
        return;
      default:
        return;
    }
  }

  // ---- permissions --------------------------------------------------------------

  private onPermission(frame: Obj): void {
    const rpc = this.rpc;
    const id = frame.id;
    if (!rpc || id === undefined || id === null) return;
    const params = isObj(frame.params) ? frame.params : {};
    const toolCall = isObj(params.toolCall) ? params.toolCall : {};
    const options = (Array.isArray(params.options) ? params.options : [])
      .filter(isObj)
      .map((option) => ({ optionId: str(option.optionId), name: str(option.name) || str(option.optionId) }))
      .filter((option) => option.optionId);
    const requestId = `perm:${String(id)}`;
    if (options.length === 0) {
      // Nothing to pick from: Grok's own refusal is the only honest answer.
      rpc.respond(id, { outcome: { outcome: "cancelled" } });
      return;
    }
    this.permissionOptions.set(requestId, options.map((option) => option.name));
    const request: InteractionRequest = {
      id: requestId,
      kind: "select",
      title: str(toolCall.title) || "Allow this?",
      message: inputLine(toolCall.rawInput),
      // Grok's own words for its options; awui never renames them Approve/Deny.
      options: options.map((option) => option.name),
      createdAt: Date.now(),
    };
    void this.dialogs.open(request).then((answer) => {
      this.permissionOptions.delete(requestId);
      const name = answer && answer.kind === "select" ? answer.value : null;
      const chosen = name === null ? undefined : options.find((option) => option.name === name);
      if (chosen) rpc.respond(id, { outcome: { outcome: "selected", optionId: chosen.optionId } });
      else rpc.respond(id, { outcome: { outcome: "cancelled" } });
    });
  }

  // ---- LiveChat -----------------------------------------------------------------

  subscribe(listener: HarnessEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async history(): Promise<ChatItem[]> {
    if (!this.sessionId) return [];
    const file = await this.adapter.sessionUpdates(this.cwd, this.sessionId);
    const text = file ? await readSessionText(file) : null;
    return text === null ? [] : itemsFromFolds(foldsFromJsonl(text));
  }

  async getConfig(): Promise<ChatConfig> {
    return { model: this.model, thinkingLevel: this.level, models: this.models, thinkingLevels: this.levelsFor(this.model) };
  }

  /** Grok lists thinking levels on each model, not once for the harness. */
  private levelsFor(model: string | null): string[] {
    return this.models.find((entry) => entry.key === model)?.levels ?? [];
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const own = this.model === null ? undefined : this.windows.get(this.model);
    const window = own ?? (this.windowsList.length > 0 ? Math.max(...this.windowsList) : null);
    if (window === null || window <= 0) return null;
    const turn = this.lastTurn;
    const tokens = turn === null ? null : turn.step.input + turn.step.cacheRead + turn.step.cacheWrite;
    return { tokens, window, percent: tokens === null ? null : Math.round((100 * tokens) / window) };
  }

  async getUsage(): Promise<HarnessUsage | null> {
    return { ...this.usage };
  }

  async getTodos(): Promise<TodoItem[]> {
    return [];
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [];
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    const rpc = this.live;
    if (images?.length && !this.imageCapable) throw new Error("This Grok build cannot take images");
    const blocks: unknown[] = [];
    for (const image of images ?? []) blocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
    blocks.push({ type: "text", text });
    this.turnOpen = true;
    this.turnStep = null;
    // session/prompt returns when the turn ends, so writing it is the acceptance.
    let result: Promise<Obj>;
    try {
      result = rpc.request<Obj>("session/prompt", { sessionId: this.sessionId, prompt: blocks }, null);
    } catch (error) {
      this.turnOpen = false;
      throw error instanceof Error ? error : new Error(String(error));
    }
    this.promptRpc = result;
    void result.then(
      () => this.completeTurn(),
      (error: unknown) => this.failTurn(error),
    );
    this.emit({ type: "user_message", text, ...(images?.length ? { imageCount: images.length } : {}) });
    this.emit({ type: "busy" });
  }

  private failTurn(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.promptRpc = null;
    // The chat is gone, or this turn was already closed (a late error after Stop).
    if (this.disposed || !this.turnOpen) return;
    this.emit({ type: "notice", level: "error", text: message });
    this.completeTurn();
  }

  /** The prompt RPC's result: one settled per turn, whichever path gets here first. */
  private completeTurn(): void {
    this.promptRpc = null;
    if (!this.turnOpen) return;
    this.turnOpen = false;
    const step = this.turnStep;
    this.turnStep = null;
    for (const id of [...this.openTools]) this.emit({ type: "tool_end", toolCallId: id, output: "", isError: true });
    this.openTools.clear();
    this.assistantOpen = false;
    // Empty text: the streamed bubble stays; this only closes the turn and counts it.
    this.emit({ type: "assistant_end", text: "", thinking: "", ...(step ? { usage: step } : {}) });
    this.emit({ type: "settled" });
  }

  async abort(): Promise<void> {
    const rpc = this.rpc;
    if (!rpc || rpc.exited) return;
    rpc.notify("session/cancel", { sessionId: this.sessionId ?? "" });
    // Every open approval goes back cancelled, on the wire, before the child is torn down.
    this.dialogs.cancelAll();
    if (!this.turnOpen) return;
    const prompt = this.promptRpc;
    const settled = prompt ? await Promise.race([prompt.then(() => true, () => true), delay(ABORT_WAIT_MS).then(() => false)]) : false;
    if (!settled && this.turnOpen) {
      this.emit({ type: "notice", level: "warning", text: "Grok is still stopping; the chat is idle." });
      this.completeTurn();
    }
  }

  async setConfig(patch: ConfigPatch): Promise<void> {
    const rpc = this.live;
    // Checked against the model the change lands on, and before either request: a refused
    // level must not leave the model already switched.
    const nextModel = patch.model ?? this.model;
    if (patch.thinkingLevel !== undefined && !this.levelsFor(nextModel).includes(patch.thinkingLevel)) {
      throw new Error(`${patch.thinkingLevel} is not a reasoning level of ${nextModel ?? "this model"}`);
    }
    if (patch.model !== undefined) await this.setOption(rpc, "model", patch.model);
    if (patch.thinkingLevel !== undefined) await this.setOption(rpc, "reasoning_effort", patch.thinkingLevel);
  }

  private async setOption(rpc: GrokRpc, configId: string, value: string): Promise<void> {
    // A bare string: a `{value:{value}}` wrapper is an invalid option to Grok.
    const result = await rpc.request<Obj>("session/set_config_option", { sessionId: this.sessionId, configId, value });
    const options = optionsFrom(isObj(result) ? result.configOptions : undefined);
    if (options.size > 0) {
      this.options = options;
      const model = options.get("model")?.currentValue;
      const effort = options.get("reasoning_effort")?.currentValue;
      if (model) this.model = model;
      if (effort) this.level = effort;
    } else if (configId === "model") this.model = value;
    else this.level = value;
    this.emit({ type: "config", config: await this.getConfig() });
  }

  async refreshModels(): Promise<void> {
    this.adapter.dropModelCache();
    this.applyModels(await this.adapter.fetchModels(this.cwd));
    this.emit({ type: "config", config: await this.getConfig() });
  }

  async steer(): Promise<void> {
    throw new Error("Grok cannot do that");
  }

  async followUp(): Promise<void> {
    throw new Error("Grok cannot do that");
  }

  async rename(): Promise<void> {
    throw new Error("Grok cannot do that");
  }

  async compact(): Promise<void> {
    throw new Error("Grok cannot do that");
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    if (!this.rpc || this.rpc.exited) return false;
    if (answer.kind === "select") {
      const names = this.permissionOptions.get(requestId);
      if (!names || !names.includes(answer.value)) return false;
    }
    return this.dialogs.answer(requestId, answer);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.dialogs.cancelAll();
    this.hub.clear();
    const rpc = this.rpc;
    this.rpc = null;
    await rpc?.kill().catch(() => undefined);
  }
}

export interface GrokOptions {
  /** The executable (tests point this at a script). */
  command?: string;
  /** config.yml's extra arguments, before the mode name `stdio`. */
  args?: string[];
  /** The user's home directory; the agent dir is GROK_HOME when set, else `<home>/.grok`. */
  home: string;
  env?: NodeJS.ProcessEnv;
}

export class GrokAdapter implements HarnessAdapter {
  readonly id = asHarnessId("grok");
  readonly displayName = "Grok";
  readonly accent = "info";
  readonly setupCommand = "grok login";
  readonly cliCommand: string;
  readonly capabilities: HarnessCapabilities = {
    // ACP has no steer or follow-up; Grok neither renames nor compacts a session here.
    supportsSteer: false,
    supportsFollowUp: false,
    supportsThinkingLevel: true,
    supportsCompact: false,
    supportsExtensions: false,
    supportsInteractiveRequests: true,
    supportsRename: false,
    supportsModelSelection: true,
    supportsFork: false,
    supportsHandoff: false,
    supportsRewind: false,
    supportsHtmlRender: false,
    supportsQueueEdit: false,
    // Grok's permission mode is its own config, which awui never writes.
    supportsPermissionMode: false,
    supportsResumeCommand: true,
    jobsSurviveRestart: false,
  };
  private modelCache: { at: number; models: ModelInfo[] } | null = null;
  private metaCache = new Map<string, { mtimeMs: number; size: number; meta: SessionMeta | null }>();

  constructor(private readonly options: GrokOptions) {
    this.cliCommand = options.command ?? (process.env.GROK_BIN?.trim() || "grok");
  }

  get extraArgs(): string[] {
    return this.options.args ?? [];
  }

  /** The child's command line: the agent, no leader, config.yml's arguments, then the mode. */
  get chatArgs(): string[] {
    return [...AGENT_ARGS, ...this.extraArgs, MODE];
  }

  /** The child's environment: the user's own, so their `~/.grok` login applies, minus the self-updater. */
  childEnv(): NodeJS.ProcessEnv {
    return { ...(this.options.env ?? process.env), GROK_DISABLE_AUTOUPDATER: "1" };
  }

  private agentDir(): string {
    return this.childEnv().GROK_HOME || path.join(this.options.home, ".grok");
  }

  async discover(): Promise<HarnessDiscovery> {
    const overrides = { GROK_HOME: this.childEnv().GROK_HOME ? "set" : "unset" } as const;
    try {
      const { stdout } = await execHarness(this.cliCommand, ["--version"], { timeout: 15_000, env: this.childEnv() });
      const label = versionLabel(stdout);
      return { available: true, ...(label.version ? label : {}), warnings: [], overrides };
    } catch {
      return { available: false, reason: "The grok CLI is not installed. Install Grok Build, run `grok` once, and log in.", warnings: [], overrides };
    }
  }

  workspaceProblem(): string | null {
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    return this.agentDir();
  }

  async resolveSessionDir(cwd: string): Promise<string> {
    return path.join(this.agentDir(), "sessions", encodedCwd(cwd));
  }

  /**
   * The group directories holding a project's sessions: the one named for the
   * encoded cwd, and any sibling whose `.cwd` file names the project — Grok
   * falls back to a slug and hash when that encoded name is too long.
   */
  private async groups(cwd: string): Promise<string[]> {
    const root = path.join(this.agentDir(), "sessions");
    const resolved = await realpathOr(cwd);
    const out = new Set<string>([path.join(root, encodedCwd(cwd))]);
    for (const entry of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      const marker = await fs.readFile(path.join(dir, ".cwd"), "utf8").catch(() => null);
      if (marker && (await realpathOr(marker.trim())) === resolved) out.add(dir);
    }
    return [...out];
  }

  /** The session's own folder, or null when the id is not one of Grok's or not this project's. */
  private async findSession(cwd: string, nativeId: string): Promise<string | null> {
    if (!isSessionId(nativeId)) return null;
    for (const group of await this.groups(cwd)) {
      const dir = path.join(group, nativeId);
      if ((await fs.stat(dir).catch(() => null))?.isDirectory()) return dir;
    }
    return null;
  }

  /** The session's updates.jsonl, for the live chat's history and its usage seeding. */
  async sessionUpdates(cwd: string, nativeId: string): Promise<string | null> {
    const dir = await this.findSession(cwd, nativeId);
    if (!dir) return null;
    const file = path.join(dir, "updates.jsonl");
    return (await fs.stat(file).catch(() => null))?.isFile() ? file : null;
  }

  /** The first prompt of a session with no generated title, from the jsonl head only. */
  private async promptHead(dir: string): Promise<string | null> {
    const handle = await fs.open(path.join(dir, "updates.jsonl"), "r").catch(() => null);
    if (!handle) return null;
    try {
      const buffer = Buffer.alloc(HEAD_BYTES);
      const read = await handle.read(buffer, 0, HEAD_BYTES, 0);
      return firstPrompt(buffer.subarray(0, read.bytesRead).toString("utf8"));
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  /** summary.json's metadata, reparsed only when the file's size or mtime changes. */
  private async meta(dir: string): Promise<SessionMeta | null> {
    const file = path.join(dir, "summary.json");
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) return null;
    const cached = this.metaCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.meta;
    const meta = await this.readMeta(dir, stat.mtimeMs);
    if (this.metaCache.size >= 5000) this.metaCache.clear();
    this.metaCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
    return meta;
  }

  private async readMeta(dir: string, mtimeMs: number): Promise<SessionMeta | null> {
    const text = await fs.readFile(path.join(dir, "summary.json"), "utf8").catch(() => null);
    if (text === null) return null;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return null;
    }
    const parsed: ParsedSummary | null = parseSummary(raw);
    if (!parsed) return null;
    const title = parsed.generatedTitle ?? (await this.promptHead(dir)) ?? "New chat";
    const at = parsed.updatedAt ? Date.parse(parsed.updatedAt) : NaN;
    return {
      id: parsed.id,
      cwd: parsed.cwd,
      generatedTitle: parsed.generatedTitle,
      title,
      updatedAt: Number.isFinite(at) ? new Date(at) : new Date(mtimeMs),
      ...(parsed.messageCount !== undefined ? { messageCount: parsed.messageCount } : {}),
    };
  }

  private summary(meta: SessionMeta): NativeSessionSummary {
    return { nativeId: meta.id, title: meta.title, updatedAt: meta.updatedAt, ...(meta.messageCount !== undefined ? { messageCount: meta.messageCount } : {}) };
  }

  async listSessions(cwd: string): Promise<NativeSessionSummary[]> {
    const resolved = await realpathOr(cwd);
    const out: NativeSessionSummary[] = [];
    for (const group of await this.groups(cwd)) {
      for (const name of await fs.readdir(group).catch(() => [] as string[])) {
        if (!isSessionId(name)) continue;
        const meta = await this.meta(path.join(group, name));
        // A group directory can hold another project's session (Grok's own moves), so the summary's cwd decides.
        if (meta && (await realpathOr(meta.cwd)) === resolved) out.push(this.summary(meta));
      }
    }
    return out.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
  }

  async listRecentSessions(limit: number): Promise<RecentNativeSession[]> {
    const root = path.join(this.agentDir(), "sessions");
    const found: Array<{ dir: string; mtimeMs: number }> = [];
    for (const group of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!group.isDirectory()) continue;
      for (const name of await fs.readdir(path.join(root, group.name)).catch(() => [] as string[])) {
        if (!isSessionId(name)) continue;
        const dir = path.join(root, group.name, name);
        const stat = await fs.stat(path.join(dir, "summary.json")).catch(() => null);
        if (stat?.isFile()) found.push({ dir, mtimeMs: stat.mtimeMs });
      }
    }
    // Newest first; only that many summaries are parsed.
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: RecentNativeSession[] = [];
    for (const entry of found) {
      if (out.length >= limit) break;
      const meta = await this.meta(entry.dir);
      if (meta) out.push({ ...this.summary(meta), cwd: meta.cwd });
    }
    return out;
  }

  async readTranscript(req: { cwd: string; nativeId: string }): Promise<{ items: ChatItem[]; title: string | null } | null> {
    const dir = await this.findSession(req.cwd, req.nativeId);
    if (!dir) return null;
    const meta = await this.meta(dir);
    if (!meta || (await realpathOr(meta.cwd)) !== (await realpathOr(req.cwd))) return null;
    const text = await readSessionText(path.join(dir, "updates.jsonl"));
    if (text === null) return null;
    // The named title only: Chat falls back to the first user text, never to a first prompt here.
    return { items: itemsFromFolds(foldsFromJsonl(text)), title: meta.generatedTitle };
  }

  async readUsage(req: { cwd: string; nativeId: string }): Promise<UsageEntry[] | null> {
    const dir = await this.findSession(req.cwd, req.nativeId);
    if (!dir) return null;
    const meta = await this.meta(dir);
    if (!meta || (await realpathOr(meta.cwd)) !== (await realpathOr(req.cwd))) return null;
    const text = await readSessionText(path.join(dir, "updates.jsonl"));
    if (text === null) return null;
    return usageFromFolds(foldsFromJsonl(text)).entries;
  }

  /** The terminal's own `grok`, never cliCommand: that may be a path clients are not told. */
  async resumeCommand(req: { cwd: string; nativeId: string }): Promise<string[] | null> {
    return (await this.findSession(req.cwd, req.nativeId)) ? ["grok", "--resume", req.nativeId] : null;
  }

  /** The listed models and their context windows, from a short-lived child's handshake. */
  async fetchModels(cwd: string): Promise<ModelTable> {
    // Listings stay on the plain agent command: config.yml's args are for chat children only.
    const rpc = new GrokRpc(this.cliCommand, [...AGENT_ARGS, MODE], this.childEnv(), cwd, () => undefined, () => undefined);
    try {
      const init = await rpc.request<Obj>("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "awui", version: CLIENT_VERSION } }, READY_TIMEOUT_MS);
      return modelsFrom(isObj(init.modelState) ? init.modelState : {});
    } finally {
      await rpc.kill().catch(() => undefined);
    }
  }

  async listModels(cwd: string): Promise<ModelInfo[]> {
    if (this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_MS) return this.modelCache.models;
    // initialize alone: session/new would create a session directory for a model list.
    const table = await this.fetchModels(cwd);
    this.modelCache = { at: Date.now(), models: table.models };
    return table.models;
  }

  dropModelCache(): void {
    this.modelCache = null;
  }

  /** Reasoning levels are per model (ModelInfo.levels). */
  async listThinkingLevels(): Promise<string[]> {
    return [];
  }

  async forkSession(): Promise<{ nativeId: string }> {
    throw new Error("Grok cannot do that");
  }

  async seedChat(): Promise<LiveChat> {
    throw new Error("Grok cannot do that");
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    const chat = new GrokLiveChat(this, req.cwd, req.resumeNativeId ?? null);
    await chat.start();
    return chat;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...children].map((child) => terminateChild(child)));
  }
}
