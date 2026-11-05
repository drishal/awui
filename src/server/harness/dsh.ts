// DeepSeek Harness (dsh) adapter: one `dsh --profile acp` child per live chat,
// speaking the Agent Client Protocol over stdio. DSH's ACP surface is the
// supported automation path: sessions, models and reasoning effort, prompts,
// cancellation, approvals, and standard semantic updates. It replays no
// history, so listing, resume-without-waiting, and usage are read from DSH's
// own session logs (`~/.dsh/sessions/<project>/<id>/session.v4.jsonl.zstd`),
// never written. The installed profile stays the source of truth for models,
// login, permissions, and session files.
//
// The stock bridge sends only committed messages, so text would land a step at
// a time. awui's acp-flow plugin (extensions/acp-flow.mjs) streams it live: each
// child gets a `--patch` overlay, written in awui's state folder, that swaps
// the bridge row for the plugin, which runs the same bridge inside it and adds
// DSH's own provider deltas as an extension notification. The committed
// chunks then repeat what streamed; they are held and only replace the bubble
// when DSH kept something else (a cancel keeps a safe prefix).
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { execHarness, spawnHarness } from "../platform-win.js";
import { embeddedVersion, extractedExtensionPath } from "../embedded.js";
import { writeJson } from "../state-file.js";
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
import { boundText, isObj, type Obj } from "./agent-events.js";
import { PendingRequests, StderrTail, terminateChild } from "./child-process.js";
import { DialogTracker, EventHub } from "./event-hub.js";
import {
  decodeSessionLog,
  eventsFromText,
  firstPrompt,
  foldAcpUpdate,
  headerFrom,
  isSessionId,
  itemsFromEvents,
  MAX_SESSION_TEXT_BYTES,
  messageCount,
  projectKey,
  resyncZstd,
  sessionSegment,
  titleFromEvents,
  updateOf,
  usageFromEvents,
  type DshEvent,
  type DshHeader,
  type DshUsage,
} from "./dsh-transcript.js";
import { HTML_RENDER_MCP_SERVER, htmlRenderRef, splitRenderMarker } from "./render-token.js";
import { renderHtmlMcpServer } from "./render-extension.js";
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
  UsageEntry,
} from "./types.js";

/** How long the initialize or session handshake may take. */
const READY_TIMEOUT_MS = 60_000;
/** How long the ACP profile's help probe may take before it is called broken. */
const PROBE_TIMEOUT_MS = 20_000;
/** How long a discovery probe's answer is reused (the registry asks more than once). */
const PROBE_CACHE_MS = 60_000;
/** How long abort waits for the cancelled turn's own result before settling it itself. */
const ABORT_WAIT_MS = 30_000;
/** The profile DSH exposes for automation clients; the bundle must be installed once. */
const PROFILE = "acp";
/** The whole log is read below this compressed size; above it, its head and tail. */
const MAX_LOG_BYTES = 32 * 1024 * 1024;
/** A listing reads only this much of a log to find its header and title. */
const HEAD_BYTES = 128 * 1024;
/** The head read's plaintext budget; the title is within the first few frames. */
const HEAD_TEXT_BYTES = 512 * 1024;
const CLIENT_VERSION = embeddedVersion ?? "dev";
/** The acp-flow plugin's extension notification: one live frame (extensions/acp-flow.mjs). */
const FLOW_METHOD = "_acp-flow/assistant_stream";
/** The plugin's mark on the initialize response, under `agentCapabilities._meta`. */
const FLOW_META = "acp-flow";
/** The stock bridge row the plugin stands in for: its id in the profile tree, and its package. */
const BRIDGE_ROW = "acp";
const BRIDGE_PACKAGE = "@deepseek-ai/dsh-acp";
/** DSH's boot report of a plugin row that did not activate; the profile then has no ACP server at all. */
const FLOW_FAILED = /^acp-flow \(/m;
/** How long committed chunks wait for more of their message when no boundary (a tool, a turn end) comes. */
const COMMIT_SETTLE_MS = 120;

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

/** An ACP error's message, with `data.details` when the app put the real reason there. */
function errorText(value: unknown): string {
  if (isObj(value)) {
    const message = typeof value.message === "string" ? value.message : "";
    const data = isObj(value.data) ? value.data : {};
    const details = typeof data.details === "string" ? data.details : "";
    if (message && details && details !== message) return `${message}: ${details}`;
    if (message) return message;
    if (details) return details;
  }
  return typeof value === "string" && value ? value : "DeepSeek Harness reported an error";
}

/**
 * The id a response frame answers, or null. A frame with `method` is a request
 * or a notification, never a response: the agent's permission requests carry
 * their own ids and must not settle ours.
 */
function answeredId(frame: Obj): string | null {
  if (frame.method !== undefined) return null;
  if (frame.result === undefined && frame.error === undefined) return null;
  return typeof frame.id === "string" ? frame.id : null;
}

// Every DSH child this process spawned; killed on shutdown and on exit.
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

export function liveDshChildren(): number {
  return children.size;
}

/** One dsh child: JSON-RPC requests out, everything else handed to `onFrame`. */
class DshRpc {
  readonly child: ChildProcessWithoutNullStreams;
  exited = false;
  /** The acp-flow row did not activate: the child has no ACP server, so it was stopped. */
  flowFailed = false;
  private readonly stderr: StderrTail;
  private exitListeners = new Set<(message: string) => void>();
  private readonly calls = new PendingRequests<string>(
    {
      // String ids: the agent's numeric permission request ids must never settle ours.
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
  ) {
    this.child = spawnHarness(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.stderr = new StderrTail(this.child);
    track(this.child);
    if (args.includes("--patch")) {
      // A plugin row that fails leaves DSH booted with no ACP server, silent until the handshake times out.
      let said = "";
      this.child.stderr.on("data", (chunk: Buffer) => {
        if (this.flowFailed) return;
        said = (said + chunk.toString("utf8")).slice(-4_000);
        if (!FLOW_FAILED.test(said)) return;
        this.flowFailed = true;
        this.child.kill("SIGKILL");
      });
    }
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
      if (this.calls.accept(frame)) return;
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
    this.child.once("error", (error) => onExit(`could not start DSH (${error.message})`));
    this.child.once("exit", (code, signal) => onExit(`DeepSeek Harness exited (${signal ?? `code ${code}`})`));
  }

  onExit(listener: (message: string) => void): void {
    this.exitListeners.add(listener);
  }

  /** `null` timeout waits forever (a prompt's result comes when the turn ends). */
  request<T = unknown>(method: string, params: Obj, timeoutMs?: number | null): Promise<T> {
    return this.calls.send<T>({ method, params }, `DeepSeek Harness did not answer ${method}`, timeoutMs);
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

  private tryWrite(frame: Obj): void {
    try {
      this.write(frame);
    } catch {
      // The child is gone; so is whatever it asked.
    }
  }

  private write(frame: Obj): void {
    if (this.exited) throw new Error("DeepSeek Harness is not running");
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  kill(): Promise<void> {
    return terminateChild(this.child);
  }
}

// ---- the session config options ------------------------------------------------

interface OptionChoice {
  value: string;
  name: string;
  description?: string;
  group?: string;
  /** The group's display name, when it says more than its id (DSH's "DeepSeek"). */
  groupName?: string;
}

interface ConfigOption {
  currentValue: string;
  choices: OptionChoice[];
}

function choicesFrom(raw: unknown, group?: string, groupName?: string): OptionChoice[] {
  const out: OptionChoice[] = [];
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isObj(entry)) continue;
    // A grouped model option nests its provider's choices one level down.
    if (Array.isArray(entry.options)) {
      const id = str(entry.group) || str(entry.name) || group;
      const label = str(entry.name) || groupName;
      out.push(...choicesFrom(entry.options, id, label));
      continue;
    }
    const value = str(entry.value);
    if (!value) continue;
    out.push({
      value,
      name: str(entry.name) || value,
      ...(str(entry.description) ? { description: str(entry.description) } : {}),
      ...(group ? { group } : {}),
      ...(groupName ? { groupName } : {}),
    });
  }
  return out;
}

function optionsFrom(raw: unknown): Map<string, ConfigOption> {
  const out = new Map<string, ConfigOption>();
  for (const entry of Array.isArray(raw) ? raw : []) {
    if (!isObj(entry) || entry.type !== "select") continue;
    const id = str(entry.id);
    if (!id) continue;
    const choices = choicesFrom(entry.options);
    out.set(id, { currentValue: str(entry.currentValue), choices });
  }
  return out;
}

/** DSH's empty reasoning value is its provider-default choice; name it in the picker. */
const levelName = (value: string): string => (value === "" ? "default" : value);

/** A model choice's provider/model, from ACP's `["provider","model"]` opaque value. */
function routeOf(value: string): { provider: string; model: string } | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === "string" && typeof parsed[1] === "string") {
      return { provider: parsed[0], model: parsed[1] };
    }
  } catch {
    // Not a route value; the caller falls back to the provider group and raw value.
  }
  return null;
}

interface ModelTable {
  models: ModelInfo[];
  /** Each model key → the opaque value set_config_option takes. */
  values: Map<string, string>;
  current: string | null;
}

/**
 * Models from the ACP `model` config option. The option's own opaque value is
 * the wire identity; awui shows `provider/id` as the key and keeps the wire
 * value beside it. Reasoning levels are known only for the selected model,
 * because DSH reruns that option for the route in force.
 */
function modelsFrom(options: Map<string, ConfigOption>): ModelTable {
  const modelOption = options.get("model");
  const reasoning = options.get("reasoning_effort");
  const levels = reasoning ? reasoning.choices.map((choice) => levelName(choice.value)) : [];
  const models: ModelInfo[] = [];
  const values = new Map<string, string>();
  const seen = new Set<string>();
  const currentValue = modelOption?.currentValue ?? "";
  for (const choice of modelOption?.choices ?? []) {
    const route = routeOf(choice.value);
    const provider = route?.provider ?? choice.group ?? "dsh";
    const id = route?.model ?? choice.value;
    const key = `${provider}/${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    values.set(key, choice.value);
    const current = choice.value === currentValue;
    models.push({
      key,
      provider,
      ...(choice.groupName && choice.groupName !== provider ? { providerName: choice.groupName } : {}),
      id,
      name: choice.name,
      ...(reasoning ? { reasoning: true } : {}),
      ...(current && levels.length > 0 ? { levels } : {}),
    });
  }
  let current: string | null = null;
  for (const [key, value] of values) {
    if (value !== currentValue) continue;
    current = key;
    break;
  }
  return { models, values, current: current && models.some((model) => model.key === current) ? current : (models[0]?.key ?? null) };
}

// ---- session files -------------------------------------------------------------

async function realpathOr(target: string): Promise<string> {
  return fs.realpath(target).catch(() => path.resolve(target));
}

interface LogFile {
  file: string;
  version: number;
  zstd: boolean;
}

/** The current log (`session.v4.jsonl.zstd`) in a session folder, or an older generation. */
async function logFileIn(dir: string): Promise<LogFile | null> {
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  let best: LogFile | null = null;
  for (const name of names) {
    const match = /^session\.v(\d+)\.jsonl(\.zstd)?$/.exec(name);
    if (!match) continue;
    const version = Number(match[1]);
    const zstd = match[2] === ".zstd";
    // Prefer the newest generation; within one, the compressed artifact is what DSH writes.
    if (!best || version > best.version || (version === best.version && zstd && !best.zstd)) best = { file: path.join(dir, name), version, zstd };
  }
  return best;
}

function cutHead(text: string): string {
  const at = text.lastIndexOf("\n");
  return at >= 0 ? text.slice(0, at + 1) : "";
}

function cutTail(text: string): string {
  const at = text.indexOf("\n");
  return at >= 0 ? text.slice(at + 1) : text;
}

/** A log's plaintext, whole below the bound, else its head and tail with the middle dropped. */
async function readLogText(log: LogFile, size: number): Promise<string | null> {
  const readWhole = async (): Promise<string | null> => {
    const buffer = await fs.readFile(log.file).catch(() => null);
    if (!buffer) return null;
    return log.zstd ? decodeSessionLog(buffer) : buffer.toString("utf8");
  };
  if (size <= MAX_LOG_BYTES) return readWhole();
  const handle = await fs.open(log.file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const half = Math.floor(MAX_LOG_BYTES / 2);
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    const headRead = await handle.read(head, 0, half, 0);
    const tailRead = await handle.read(tail, 0, half, size - half);
    const headBuffer = head.subarray(0, headRead.bytesRead);
    const tailBuffer = tail.subarray(0, tailRead.bytesRead);
    if (!log.zstd) return `${cutHead(headBuffer.toString("utf8"))}${cutTail(tailBuffer.toString("utf8"))}`;
    const halfText = Math.floor(MAX_SESSION_TEXT_BYTES / 2);
    const headText = decodeSessionLog(headBuffer, halfText);
    const tailText = decodeSessionLog(resyncZstd(tailBuffer), halfText);
    // The resynced tail starts at a frame boundary, so its first line is whole.
    return `${cutHead(headText)}${tailText}`;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** A log's first frames: enough for the header, the title, and the first prompt. */
async function readLogHead(log: LogFile): Promise<string | null> {
  const handle = await fs.open(log.file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const read = await handle.read(buffer, 0, HEAD_BYTES, 0);
    const bytes = buffer.subarray(0, read.bytesRead);
    return log.zstd ? decodeSessionLog(bytes, HEAD_TEXT_BYTES) : bytes.toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

interface SessionHead {
  header: DshHeader;
  title: string | null;
  prompt: string | null;
  count: number | null;
}

// ---- the live chat -------------------------------------------------------------

class DshLiveChat implements LiveChat {
  private hub = new EventHub();
  private dialogs = new DialogTracker(this.hub);
  private rpc: DshRpc | null = null;
  private disposed = false;
  private sessionId: string | null = null;
  /** Updates before the session response: DSH replays none, but autonomous work may start during a resume. */
  private accepting = false;
  private readonly pendingUpdates: Array<{ update: Obj } | { flow: Obj }> = [];
  private model: string | null = null;
  private level: string | null = null;
  private models: ModelInfo[] = [];
  private modelValues = new Map<string, string>();
  private options = new Map<string, ConfigOption>();
  /** A build that does not say `promptCapabilities.image === true` cannot take one. */
  private imageCapable = false;
  private contextUsage: { used: number; size: number } | null = null;
  private turnOpen = false;
  private promptRpc: Promise<unknown> | null = null;
  private assistantOpen = false;
  /** The acp-flow plugin marked the handshake: text streams live, and committed chunks repeat it. */
  private flowing = false;
  /** What the open assistant bubble has streamed live. */
  private streamed = { text: "", thinking: "" };
  /** The step's committed text and thinking, held until a boundary compares them with what streamed. */
  private committed: { text: string; thinking: string } | null = null;
  private commitTimer: NodeJS.Timeout | null = null;
  private readonly openTools = new Map<string, { name: string; args: unknown }>();
  private readonly permissionOptions = new Map<string, string[]>();
  private readonly mcpServers: unknown[];
  private readonly resumeId: string | null;

  constructor(
    private readonly adapter: DshAdapter,
    private readonly cwd: string,
    resumeId: string | null,
    renderEnv: NodeJS.ProcessEnv | undefined,
  ) {
    this.resumeId = resumeId;
    this.mcpServers = adapter.mcpServers(renderEnv);
  }

  get nativeId(): string | null {
    return this.sessionId;
  }

  get title(): string | null {
    return null;
  }

  private get live(): DshRpc {
    if (!this.rpc || this.rpc.exited) throw new Error("DeepSeek Harness is not running for this chat");
    return this.rpc;
  }

  private emit(event: Parameters<HarnessEventListener>[0]): void {
    this.hub.emit(event);
  }

  private emitConfig(): void {
    this.emit({ type: "config", config: { model: this.model, thinkingLevel: this.level, models: this.models, thinkingLevels: this.levels() } });
  }

  async start(): Promise<void> {
    const patch = await this.adapter.flowPatch();
    if ((await this.launch(patch)) === "ok") return;
    // The plugin did not load (a DSH that moved the bridge's API, say): the stock bridge still works, without live text.
    this.adapter.disableFlow();
    await this.launch(null);
  }

  private async launch(patch: string | null): Promise<"ok" | "flow failed"> {
    const rpc = new DshRpc(this.adapter.cliCommand, this.adapter.chatArgs(patch), this.adapter.childEnv(), this.cwd, (frame) => this.onFrame(frame));
    this.rpc = rpc;
    rpc.onExit((message) => {
      if (this.disposed || this.rpc !== rpc || rpc.flowFailed) return;
      this.dialogs.cancelAll();
      this.emit({ type: "fatal", message: `DeepSeek Harness stopped unexpectedly (${message})` });
    });
    try {
      const init = await rpc.request<Obj>("initialize", { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: "awui", version: CLIENT_VERSION } }, READY_TIMEOUT_MS);
      this.readInitialize(init);
      const params: Obj = { cwd: this.cwd, mcpServers: this.mcpServers };
      const result = this.resumeId
        ? await rpc.request<Obj>("session/resume", { ...params, sessionId: this.resumeId }, READY_TIMEOUT_MS)
        : await rpc.request<Obj>("session/new", params, READY_TIMEOUT_MS);
      const nativeId = this.applySession(result, this.resumeId ?? str(result.sessionId));
      this.accepting = true;
      this.emit({ type: "session", nativeId });
      this.emitConfig();
      // Work that started while the resume handshake ran arrives after its session event.
      for (const pending of this.pendingUpdates.splice(0)) {
        if ("flow" in pending) this.onFlow(pending.flow);
        else this.onUpdate(pending.update);
      }
      return "ok";
    } catch (error) {
      this.rpc = null;
      await rpc.kill().catch(() => undefined);
      if (patch && rpc.flowFailed) {
        this.pendingUpdates.length = 0;
        return "flow failed";
      }
      throw error;
    }
  }

  private readInitialize(init: Obj): void {
    const version = init.protocolVersion;
    if (typeof version === "number" && version !== 1) this.emit({ type: "notice", level: "warning", text: `DeepSeek Harness spoke ACP protocol ${version}; awui expects 1.` });
    const capabilities = isObj(init.agentCapabilities) ? init.agentCapabilities : {};
    const prompt = isObj(capabilities.promptCapabilities) ? capabilities.promptCapabilities : {};
    this.imageCapable = prompt.image === true;
    const sessions = isObj(capabilities.sessionCapabilities) ? capabilities.sessionCapabilities : {};
    if (this.resumeId && sessions.resume === undefined) throw new Error("This DeepSeek Harness build cannot resume ACP sessions");
    const meta = isObj(capabilities._meta) ? capabilities._meta : {};
    this.flowing = isObj(meta[FLOW_META]);
  }

  private applySession(result: Obj, sessionId: string): string {
    if (!isSessionId(sessionId)) throw new Error("DeepSeek Harness did not name a session");
    this.sessionId = sessionId;
    this.applyOptions(result.configOptions);
    return sessionId;
  }

  private applyOptions(raw: unknown): void {
    this.options = optionsFrom(raw);
    const table = modelsFrom(this.options);
    this.models = table.models;
    this.modelValues = table.values;
    this.model = table.current;
    const reasoning = this.options.get("reasoning_effort");
    this.level = reasoning ? levelName(reasoning.currentValue) : null;
    this.adapter.rememberModels(this.models);
  }

  private levels(): string[] {
    return this.options.get("reasoning_effort")?.choices.map((choice) => levelName(choice.value)) ?? [];
  }

  // ---- the child's frames -------------------------------------------------------

  private onFrame(frame: Obj): void {
    const method = typeof frame.method === "string" ? frame.method : null;
    if (method === null) return;
    if (method === FLOW_METHOD) {
      const flow = isObj(frame.params) ? frame.params : null;
      // Before the handshake's mark nothing says the committed chunks repeat these, so they would show twice.
      if (!flow || !this.flowing) return;
      if (this.accepting) this.onFlow(flow);
      else if (this.pendingUpdates.length < 1000) this.pendingUpdates.push({ flow });
      return;
    }
    const update = updateOf(frame);
    if (update) {
      if (this.accepting) this.onUpdate(update);
      else if (this.pendingUpdates.length < 1000) this.pendingUpdates.push({ update });
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
    const fold = foldAcpUpdate(update, Date.now());
    switch (fold.type) {
      case "delta": {
        if (this.flowing) {
          this.holdCommitted(fold.field, fold.delta);
          return;
        }
        this.openAssistant();
        this.emit({ type: "assistant_delta", field: fold.field, delta: fold.delta });
        return;
      }
      case "tool_start": {
        // The step's committed message comes before its calls, so this is where it is complete.
        this.settleCommitted();
        this.closeAssistant();
        this.openTools.set(fold.toolCallId, { name: fold.name, args: fold.args });
        this.emit({ type: "tool_start", toolCallId: fold.toolCallId, name: fold.name, args: fold.args });
        if (update.status === "completed" || update.status === "failed") this.finishTool(update);
        return;
      }
      case "tool_update":
        this.emit({ type: "tool_update", toolCallId: fold.toolCallId, output: boundText(fold.output).text });
        return;
      case "tool_end":
        this.finishTool(update, fold.output, fold.isError);
        return;
      case "usage":
        this.contextUsage = { used: fold.used, size: fold.size };
        return;
      case "config":
        if (Array.isArray(fold.options)) {
          this.applyOptions(fold.options);
          this.emitConfig();
        }
        return;
      default:
        return;
    }
  }

  private openAssistant(): void {
    if (this.assistantOpen) return;
    this.assistantOpen = true;
    this.streamed = { text: "", thinking: "" };
    this.emit({ type: "assistant_start", ...(this.model ? { model: this.model } : {}) });
  }

  private closeAssistant(): void {
    this.assistantOpen = false;
    this.streamed = { text: "", thinking: "" };
  }

  /** One live frame from acp-flow: an attempt's start, a provider delta, or its end. */
  private onFlow(flow: Obj): void {
    if (this.sessionId && str(flow.sessionId) !== this.sessionId) return;
    if (flow.type === "start") {
      this.settleCommitted();
      return;
    }
    if (flow.type === "text" || flow.type === "thinking") {
      const delta = str(flow.text);
      if (!delta) return;
      this.openAssistant();
      this.streamed[flow.type] += delta;
      this.emit({ type: "assistant_delta", field: flow.type, delta });
      return;
    }
    if (flow.type !== "end" || flow.outcome === "message") return;
    // A failed or dropped attempt never becomes a message; keep what it showed, marked, so a retry starts a clean bubble.
    if (this.assistantOpen && (this.streamed.text || this.streamed.thinking)) {
      this.emit({ type: "assistant_end", text: this.streamed.text, thinking: this.streamed.thinking, error: "This attempt failed; DeepSeek Harness dropped it." });
    }
    this.closeAssistant();
  }

  /** A committed chunk while flowing: held, because it repeats what streamed unless DSH kept something else. */
  private holdCommitted(field: "text" | "thinking", delta: string): void {
    this.committed ??= { text: "", thinking: "" };
    this.committed[field] += delta;
    // Autonomous work has no prompt result to settle at; the chunks of one message come back to back.
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = setTimeout(() => this.settleCommitted(), COMMIT_SETTLE_MS);
  }

  /**
   * Compare the held committed message with what streamed. Equal (the usual
   * case: DSH builds the message from the same deltas) changes nothing; a
   * message that never streamed shows whole; a different one replaces the
   * bubble. A field the message leaves empty keeps what streamed, which is
   * how the chat folds an `assistant_end`.
   */
  private settleCommitted(): void {
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
    const committed = this.committed;
    this.committed = null;
    if (!committed || (!committed.text && !committed.thinking)) return;
    if (!this.assistantOpen) {
      this.openAssistant();
      if (committed.thinking) this.emit({ type: "assistant_delta", field: "thinking", delta: committed.thinking });
      if (committed.text) this.emit({ type: "assistant_delta", field: "text", delta: committed.text });
      this.streamed = { ...committed };
      return;
    }
    const differs = (committed.text && committed.text !== this.streamed.text) || (committed.thinking && committed.thinking !== this.streamed.thinking);
    if (!differs) return;
    this.emit({ type: "assistant_end", text: committed.text, thinking: committed.thinking });
    this.closeAssistant();
  }

  /** A tool's final frame, including a page the render tool published. */
  private finishTool(update: Obj, output?: string, isError?: boolean): void {
    const toolCallId = str(update.toolCallId);
    if (!toolCallId) return;
    this.openTools.delete(toolCallId);
    const raw = output ?? (typeof update.rawOutput === "string" ? update.rawOutput : "");
    const marked = splitRenderMarker(raw);
    const bounded = boundText(marked.text);
    const page = marked.details ? htmlRenderRef(marked.details) : undefined;
    this.emit({
      type: "tool_end",
      toolCallId,
      output: bounded.text,
      isError: isError ?? update.status === "failed",
      ...(page ? { details: { htmlRender: page } } : {}),
    });
  }

  // ---- permissions --------------------------------------------------------------

  private onPermission(frame: Obj): void {
    const rpc = this.rpc;
    const id = frame.id;
    if (!rpc || id === undefined || id === null) return;
    const params = isObj(frame.params) ? frame.params : {};
    const toolCall = isObj(params.toolCall) ? params.toolCall : {};
    const callId = str(toolCall.toolCallId);
    const options = (Array.isArray(params.options) ? params.options : [])
      .filter(isObj)
      .map((option) => ({ optionId: str(option.optionId), name: str(option.name) || str(option.optionId) }))
      .filter((option) => option.optionId);
    const requestId = `perm:${String(id)}`;
    if (options.length === 0) {
      // Nothing to pick from: the agent's own refusal is the only honest answer.
      rpc.respond(id, { outcome: { outcome: "cancelled" } });
      return;
    }
    this.permissionOptions.set(requestId, options.map((option) => option.name));
    const known = callId ? this.openTools.get(callId) : undefined;
    const request: InteractionRequest = {
      id: requestId,
      kind: "select",
      title: known?.name ?? "Allow this?",
      message: inputLine(known?.args),
      // DSH's own words for its one-shot options; awui never renames them.
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
    const read = await this.adapter.readTranscript({ cwd: this.cwd, nativeId: this.sessionId });
    return read?.items ?? [];
  }

  async getConfig(): Promise<ChatConfig> {
    return { model: this.model, thinkingLevel: this.level, models: this.models, thinkingLevels: this.levels() };
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    if (this.contextUsage && this.contextUsage.size > 0) {
      const { used, size } = this.contextUsage;
      return { tokens: used, window: size, percent: Math.round((100 * used) / size) };
    }
    if (!this.sessionId) return null;
    const usage = await this.adapter.usageFor(this.cwd, this.sessionId);
    if (!usage || usage.lastTokens === null || usage.contextWindow === null || usage.contextWindow <= 0) return null;
    return { tokens: usage.lastTokens, window: usage.contextWindow, percent: Math.round((100 * usage.lastTokens) / usage.contextWindow) };
  }

  async getUsage(): Promise<HarnessUsage | null> {
    if (!this.sessionId) return { turns: 0, steps: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: null };
    const usage = await this.adapter.usageFor(this.cwd, this.sessionId);
    return usage?.usage ?? null;
  }

  async getTodos(): Promise<TodoItem[]> {
    return [];
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [];
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    const rpc = this.live;
    if (images?.length && !this.imageCapable) throw new Error("This DeepSeek Harness build cannot take images");
    const blocks: unknown[] = [];
    for (const image of images ?? []) blocks.push({ type: "image", mimeType: image.mimeType, data: image.data });
    blocks.push({ type: "text", text });
    this.turnOpen = true;
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
    for (const id of [...this.openTools.keys()]) this.emit({ type: "tool_end", toolCallId: id, output: "", isError: true });
    this.openTools.clear();
    // The bridge drains its updates before the prompt result, so the last message's chunks are all here.
    this.settleCommitted();
    this.closeAssistant();
    // Empty text: the streamed bubble stays; this only closes the turn.
    this.emit({ type: "assistant_end", text: "", thinking: "" });
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
      this.emit({ type: "notice", level: "warning", text: "DeepSeek Harness is still stopping; the chat is idle." });
      this.completeTurn();
    }
  }

  async setConfig(patch: ConfigPatch): Promise<void> {
    const rpc = this.live;
    if (patch.model !== undefined) {
      const value = this.modelValues.get(patch.model) ?? ([...this.modelValues.values()].includes(patch.model) ? patch.model : undefined);
      if (value === undefined) throw new Error(`${patch.model} is not a model this DeepSeek Harness session lists`);
      await this.setOption(rpc, "model", value);
    }
    if (patch.thinkingLevel !== undefined) {
      if (!this.levels().includes(patch.thinkingLevel)) {
        throw new Error(`${patch.thinkingLevel} is not a reasoning level of ${this.model ?? "this model"}`);
      }
      await this.setOption(rpc, "reasoning_effort", patch.thinkingLevel === "default" ? "" : patch.thinkingLevel);
    }
  }

  private async setOption(rpc: DshRpc, configId: string, value: string): Promise<void> {
    const result = await rpc.request<Obj>("session/set_config_option", { sessionId: this.sessionId, configId, value });
    this.applyOptions(isObj(result) ? result.configOptions : undefined);
    this.emitConfig();
  }

  async refreshModels(): Promise<void> {
    this.adapter.forgetModels();
    const rpc = this.rpc;
    if (!rpc || rpc.exited || !this.sessionId || !this.model) return;
    // Re-selecting the current model asks DSH for its catalog again without changing the route.
    const value = this.modelValues.get(this.model);
    if (value === undefined) return;
    await this.setOption(rpc, "model", value);
  }

  async steer(): Promise<void> {
    throw new Error("DeepSeek Harness cannot do that");
  }

  async followUp(): Promise<void> {
    throw new Error("DeepSeek Harness cannot do that");
  }

  async rename(): Promise<void> {
    throw new Error("DeepSeek Harness cannot do that");
  }

  async compact(): Promise<void> {
    throw new Error("DeepSeek Harness cannot do that");
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
    if (this.commitTimer) clearTimeout(this.commitTimer);
    this.commitTimer = null;
    this.dialogs.cancelAll();
    this.hub.clear();
    const rpc = this.rpc;
    this.rpc = null;
    await rpc?.kill().catch(() => undefined);
  }
}

// ---- the adapter ---------------------------------------------------------------

export interface DshOptions {
  /** The executable (tests point this at a script). */
  command?: string;
  /** config.yml's extra launch arguments, after `--profile acp`. */
  args?: string[];
  /** The user's home directory; the DSH home is DSH_HOME when set, else `<home>/.dsh`. */
  home: string;
  env?: NodeJS.ProcessEnv;
  /** awui's state folder, where the acp-flow overlay is written; without one, text arrives a step at a time. */
  stateDir?: string;
}

interface ProbeResult {
  ok: boolean;
  reason?: string;
}

/** The discovery probe's answer, keyed by command and home; the registry asks more than once. */
const probes = new Map<string, { at: number; result: ProbeResult }>();

let flowPluginFile: string | null | undefined;

/** extensions/acp-flow.mjs: the materialized embedded copy in the binary, else the repo path found by walking up. */
function acpFlowPlugin(): string | null {
  if (flowPluginFile !== undefined) return flowPluginFile;
  const embedded = extractedExtensionPath("acp-flow.mjs");
  if (embedded !== null) return (flowPluginFile = embedded);
  flowPluginFile = null;
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "extensions", "acp-flow.mjs");
    if (existsSync(file)) return (flowPluginFile = file);
    if (path.dirname(dir) === dir) return flowPluginFile;
  }
}

/** What a `!!js` value (a Cordis expression, evaluated at boot) parses to here: kept apart from plain strings. */
const EXPRESSION = Symbol("dsh expression");

/** A composed profile tree from `dsh --dump-config`, its `!!js` expressions marked rather than read as text. */
export function parseProfileTree(text: string): unknown {
  return parseYaml(text, {
    logLevel: "error",
    customTags: [{ tag: "tag:yaml.org,2002:js", resolve: (source: string) => ({ [EXPRESSION]: source }) }],
  });
}

function hasExpression(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasExpression);
  if (typeof value !== "object" || value === null) return false;
  return EXPRESSION in value || Object.values(value).some(hasExpression);
}

/**
 * The stock bridge row in a composed profile tree, or null when it is
 * missing, off, not the stock package, or carries an expression (which the
 * overlay could only copy as its text, changing what it means).
 */
export function bridgeRow(tree: unknown): Obj | null {
  const visit = (node: unknown): Obj | null => {
    if (Array.isArray(node)) {
      for (const entry of node) {
        const found = visit(entry);
        if (found) return found;
      }
      return null;
    }
    if (!isObj(node)) return null;
    if (node.id === BRIDGE_ROW) return node;
    // A group row nests its entries in its config.
    return Array.isArray(node.config) ? visit(node.config) : null;
  };
  const row = visit(tree);
  if (!row || row.name !== BRIDGE_PACKAGE || row.disabled === true || hasExpression(row)) return null;
  return row;
}

/**
 * The `--patch` overlay that swaps the bridge row for acp-flow: the stock row
 * turned off, and the plugin inserted with everything else the row carries
 * (its inject list and its provider/model config), so the bridge inside the
 * plugin runs as it would have. JSON is YAML, which DSH's patch reader takes.
 */
export function flowOverlay(row: Obj, plugin: string): unknown[] {
  const { id: _id, name: _name, disabled: _disabled, ...rest } = row;
  return [{ id: BRIDGE_ROW, disabled: true }, { insert: [{ ...rest, id: "acp-flow", name: plugin }] }];
}

/** An absolute Node to run awui's render MCP server, or null when there is none. */
function nodeForMcp(): string | null {
  // A compiled awui binary is Bun, not Node; the MCP server needs a real Node.
  if (!process.versions.bun) return process.execPath;
  const names = process.platform === "win32" ? ["node.exe", "node"] : ["node"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

export class DshAdapter implements HarnessAdapter {
  readonly id = asHarnessId("dsh");
  readonly displayName = "DeepSeek Harness";
  readonly accent = "ok";
  readonly cliCommand: string;
  readonly capabilities: HarnessCapabilities = {
    // ACP has one prompt at a time; DSH neither queues follow-ups nor edits them here.
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
    // awui's render_html MCP server is mounted on the ACP session when a Node can run it.
    supportsHtmlRender: renderHtmlMcpServer() !== null && nodeForMcp() !== null,
    supportsQueueEdit: false,
    // DSH's permission presets are its own config, which awui never writes.
    supportsPermissionMode: false,
    supportsResumeCommand: false,
    jobsSurviveRestart: false,
  };
  private modelCache: ModelInfo[] = [];
  private version: string | null = null;
  private readonly metaCache = new Map<string, { mtimeMs: number; size: number; head: SessionHead | null }>();
  private readonly usageCache = new Map<string, { mtimeMs: number; size: number; usage: DshUsage }>();

  constructor(private readonly options: DshOptions) {
    this.cliCommand = options.command ?? (process.env.DSH_BIN?.trim() || "dsh");
  }

  get extraArgs(): string[] {
    return this.options.args ?? [];
  }

  /** The child's command line: the ACP profile, the acp-flow overlay when there is one, then config.yml's arguments. */
  chatArgs(patch: string | null): string[] {
    return ["--profile", PROFILE, ...(patch ? ["--patch", patch] : []), ...this.extraArgs];
  }

  private flowCache: { at: number; patch: Promise<string | null> } | null = null;
  private flowOff = false;

  /**
   * The overlay file that loads acp-flow, written once a minute at most, or
   * null when live text is off: no state folder, `AWUI_DSH_FLOW=0`, a profile
   * whose bridge row is not the stock one, or a plugin that failed to load.
   */
  flowPatch(): Promise<string | null> {
    if (this.flowOff || !this.options.stateDir || (this.options.env ?? process.env).AWUI_DSH_FLOW === "0") return Promise.resolve(null);
    if (this.flowCache && Date.now() - this.flowCache.at < PROBE_CACHE_MS) return this.flowCache.patch;
    const stateDir = this.options.stateDir;
    const patch = (async (): Promise<string | null> => {
      const plugin = acpFlowPlugin();
      if (!plugin) return null;
      let tree: unknown;
      try {
        // The composed tree, read without mounting it: the row's config is whatever the profile's layers made it.
        const { stdout } = await execHarness(this.cliCommand, ["--profile", PROFILE, "--dump-config"], { timeout: 15_000, env: this.childEnv() });
        tree = parseProfileTree(stdout);
      } catch {
        return null;
      }
      const row = bridgeRow(tree);
      if (!row) return null;
      const file = path.join(stateDir, "dsh", "acp-flow.patch.yml");
      await writeJson(file, flowOverlay(row, plugin));
      return existsSync(file) ? file : null;
    })();
    this.flowCache = { at: Date.now(), patch };
    return patch;
  }

  /** A chat found the plugin broken: the rest of this process's chats use the stock bridge. */
  disableFlow(): void {
    this.flowOff = true;
  }

  /** The child's environment: the user's own, so their DSH_HOME and login apply. */
  childEnv(): NodeJS.ProcessEnv {
    return { ...(this.options.env ?? process.env) };
  }

  private dshHome(): string {
    const configured = this.childEnv().DSH_HOME?.trim();
    if (!configured) return path.join(this.options.home, ".dsh");
    // DSH expands a leading `~` itself; resolve the same way so the reader follows the child.
    const expanded = configured === "~" ? this.options.home : configured.startsWith("~/") || configured.startsWith("~\\") ? path.join(this.options.home, configured.slice(2)) : configured;
    return path.resolve(expanded);
  }

  private sessionsRoot(): string {
    return path.join(this.dshHome(), "sessions");
  }

  /** The install command for the ACP profile's bundle, pinned to this installation's version. */
  get setupCommand(): string {
    const version = this.version ? `@${this.version}` : "";
    return `${this.cliCommand} plugin --profile ${PROFILE} add @deepseek-ai/dsh-acp-app${version}`;
  }

  async discover(): Promise<HarnessDiscovery> {
    const overrides = { DSH_HOME: this.childEnv().DSH_HOME ? "set" : "unset" } as const;
    let label: { version: string; versionDetail?: string } = { version: "" };
    try {
      const { stdout } = await execHarness(this.cliCommand, ["--version"], { timeout: 15_000, env: this.childEnv() });
      label = versionLabel(stdout);
      if (label.version) this.version = label.version;
    } catch {
      return { available: false, reason: "The dsh CLI is not installed. Install DeepSeek Harness, then run it once and sign in.", warnings: [], overrides };
    }
    const probe = await this.probeAcp();
    const warnings: string[] = [];
    if (probe.ok && label.version) {
      const bundle = await this.acpBundleVersion();
      if (bundle && bundle !== label.version) {
        warnings.push(`The ACP profile's bundle is ${bundle} but dsh is ${label.version}; reinstall it with \`${this.setupCommand}\`.`);
      }
    }
    return {
      available: probe.ok,
      ...(label.version ? { version: label.version } : {}),
      ...(label.versionDetail ? { versionDetail: label.versionDetail } : {}),
      ...(probe.ok ? {} : { reason: probe.reason ?? "The DeepSeek Harness ACP profile is not usable." }),
      warnings,
      overrides,
    };
  }

  /** The ACP bundle's version in the profile, when it is installed there (a Nix update can leave it stale). */
  private async acpBundleVersion(): Promise<string | null> {
    const file = path.join(this.dshHome(), "profiles", PROFILE, "node_modules", "@deepseek-ai", "dsh-acp-app", "package.json");
    const text = await fs.readFile(file, "utf8").catch(() => null);
    if (text === null) return null;
    try {
      const parsed: unknown = JSON.parse(text);
      return isObj(parsed) && typeof parsed.version === "string" ? parsed.version : null;
    } catch {
      return null;
    }
  }

  /**
   * `dsh --profile acp --help` proves the profile boots without claiming stdio.
   * A missing bundle prints one line and then waits for an app that never
   * comes, so that line ends the probe immediately instead of at the timeout.
   */
  private async probeAcp(): Promise<ProbeResult> {
    const key = `${this.cliCommand}\u0000${this.dshHome()}`;
    const cached = probes.get(key);
    if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.result;
    const missingReason = `DeepSeek Harness's ACP profile is not installed. Run \`${this.setupCommand}\` once.`;
    const brokenReason = "The DeepSeek Harness ACP profile did not start. Run `dsh --profile acp --help` in a terminal to see why.";
    const result = await new Promise<ProbeResult>((resolve) => {
      let done = false;
      let stderr = "";
      let child: ChildProcessWithoutNullStreams | undefined;
      let timer: NodeJS.Timeout | undefined;
      const finish = (value: ProbeResult) => {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        child?.stdin.end();
        if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        resolve(value);
      };
      timer = setTimeout(() => finish({ ok: false, reason: brokenReason }), PROBE_TIMEOUT_MS);
      try {
        child = spawnHarness(this.cliCommand, ["--profile", PROFILE, "--help"], { cwd: this.options.home, env: this.childEnv(), stdio: ["pipe", "pipe", "pipe"] });
      } catch {
        if (timer) clearTimeout(timer);
        resolve({ ok: false, reason: brokenReason });
        return;
      }
      child.stdout.on("data", () => undefined);
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-8_000);
        if (/cannot resolve profile bundle|skipping profile bundle/.test(stderr)) finish({ ok: false, reason: missingReason });
      });
      child.once("error", () => finish({ ok: false, reason: brokenReason }));
      child.once("exit", (code) => finish(code === 0 ? { ok: true } : { ok: false, reason: brokenReason }));
    });
    if (probes.size > 100) probes.clear();
    probes.set(key, { at: Date.now(), result });
    return result;
  }

  workspaceProblem(): string | null {
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    return this.dshHome();
  }

  async resolveSessionDir(cwd: string): Promise<string> {
    return path.join(this.sessionsRoot(), projectKey(cwd));
  }

  /** The MCP servers a chat's ACP session mounts: awui's render_html, when it was given a token. */
  mcpServers(renderEnv: NodeJS.ProcessEnv | undefined): unknown[] {
    const server = renderHtmlMcpServer();
    const node = nodeForMcp();
    if (!server || !node || !renderEnv?.AWUI_RENDER_URL || !renderEnv.AWUI_RENDER_TOKEN) return [];
    return [
      {
        name: HTML_RENDER_MCP_SERVER,
        command: node,
        args: [server],
        env: [
          { name: "AWUI_RENDER_URL", value: renderEnv.AWUI_RENDER_URL },
          { name: "AWUI_RENDER_TOKEN", value: renderEnv.AWUI_RENDER_TOKEN },
        ],
      },
    ];
  }

  rememberModels(models: ModelInfo[]): void {
    if (models.length > 0) this.modelCache = models;
  }

  /**
   * ACP has no session-less model call, so the catalog comes from the last
   * live chat; a chat's Refresh asks that chat to re-select its route and
   * learns a new one. Clearing here would empty the start screen's picker
   * until another chat, so this deliberately keeps the last known list.
   */
  forgetModels(): void {
    // Intentionally empty; see the comment above.
  }

  /**
   * The catalog is per session over ACP (it has no session-less model call), so
   * this returns what live chats have learned. A brand-new workspace's start
   * screen shows no picker until its first chat opens; that chat's config does.
   */
  async listModels(): Promise<ModelInfo[]> {
    return this.modelCache;
  }

  /** Reasoning levels are per route (ModelInfo.levels). */
  async listThinkingLevels(): Promise<string[]> {
    return [];
  }

  /** The log file and parsed head of one session in this project, or null. */
  private async findSession(cwd: string, nativeId: string): Promise<{ file: LogFile; head: SessionHead } | null> {
    if (!isSessionId(nativeId)) return null;
    const dir = path.join(this.sessionsRoot(), projectKey(cwd), sessionSegment(nativeId));
    const log = await logFileIn(dir);
    if (!log) return null;
    const head = await this.headOf(log);
    if (!head || head.header.id !== nativeId || head.header.origin === "subagent") return null;
    if ((await realpathOr(head.header.cwd)) !== (await realpathOr(cwd))) return null;
    return { file: log, head };
  }

  /** A session's header, title, and first prompt, cached by the log's mtime and size. */
  private async headOf(log: LogFile): Promise<SessionHead | null> {
    const stat = await fs.stat(log.file).catch(() => null);
    if (!stat?.isFile()) return null;
    const cached = this.metaCache.get(log.file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.head;
    const text = await readLogHead(log);
    let head: SessionHead | null = null;
    if (text !== null) {
      const events = eventsFromText(text);
      const header = headerFrom(events);
      if (header) {
        head = {
          header,
          title: titleFromEvents(events),
          prompt: firstPrompt(events),
          count: stat.size <= HEAD_BYTES ? messageCount(events) : null,
        };
      }
    }
    if (this.metaCache.size >= 5000) this.metaCache.clear();
    this.metaCache.set(log.file, { mtimeMs: stat.mtimeMs, size: stat.size, head });
    return head;
  }

  private async sessionHeadFor(file: LogFile): Promise<SessionHead | null> {
    return this.headOf(file);
  }

  private summary(head: SessionHead): NativeSessionSummary {
    return {
      nativeId: head.header.id,
      title: head.title ?? head.prompt ?? "New chat",
      updatedAt: null,
      ...(head.count !== null ? { messageCount: head.count } : {}),
    };
  }

  async listSessions(cwd: string): Promise<NativeSessionSummary[]> {
    const dir = path.join(this.sessionsRoot(), projectKey(cwd));
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    const out: NativeSessionSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !isSessionId(entry.name)) continue;
      const log = await logFileIn(path.join(dir, entry.name));
      if (!log) continue;
      const head = await this.headOf(log);
      if (!head || head.header.origin === "subagent") continue;
      if ((await realpathOr(head.header.cwd)) !== (await realpathOr(cwd))) continue;
      const stat = await fs.stat(log.file).catch(() => null);
      out.push({ ...this.summary(head), updatedAt: stat ? stat.mtime : null });
    }
    return out.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
  }

  async listRecentSessions(limit: number): Promise<RecentNativeSession[]> {
    const root = this.sessionsRoot();
    const found: Array<{ file: LogFile; mtimeMs: number }> = [];
    for (const group of await fs.readdir(root, { withFileTypes: true }).catch(() => [])) {
      if (!group.isDirectory()) continue;
      for (const entry of await fs.readdir(path.join(root, group.name), { withFileTypes: true }).catch(() => [])) {
        if (!entry.isDirectory() || !isSessionId(entry.name)) continue;
        const log = await logFileIn(path.join(root, group.name, entry.name));
        if (!log) continue;
        const stat = await fs.stat(log.file).catch(() => null);
        if (stat?.isFile()) found.push({ file: log, mtimeMs: stat.mtimeMs });
      }
    }
    found.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: RecentNativeSession[] = [];
    for (const entry of found) {
      if (out.length >= limit) break;
      const head = await this.sessionHeadFor(entry.file);
      if (!head || head.header.origin === "subagent") continue;
      out.push({ ...this.summary(head), updatedAt: new Date(entry.mtimeMs), cwd: head.header.cwd });
    }
    return out;
  }

  /** A session's events, read from its own log; null when it is not this project's or is an old format. */
  private async eventsFor(cwd: string, nativeId: string): Promise<{ events: DshEvent[]; head: SessionHead } | null> {
    const found = await this.findSession(cwd, nativeId);
    if (!found) return null;
    if (found.head.header.version !== 4) return null;
    const stat = await fs.stat(found.file.file).catch(() => null);
    if (!stat?.isFile()) return null;
    const text = await readLogText(found.file, stat.size);
    if (text === null) return null;
    return { events: eventsFromText(text), head: found.head };
  }

  async readTranscript(req: { cwd: string; nativeId: string }): Promise<{ items: ChatItem[]; title: string | null } | null> {
    const read = await this.eventsFor(req.cwd, req.nativeId);
    if (!read) return null;
    return { items: itemsFromEvents(read.events), title: titleFromEvents(read.events) };
  }

  async readUsage(req: { cwd: string; nativeId: string }): Promise<UsageEntry[] | null> {
    const usage = await this.usageOf(req.cwd, req.nativeId);
    return usage ? usage.entries : null;
  }

  /** Usage totals and context facts for a live chat (not part of the adapter contract). */
  async usageFor(cwd: string, nativeId: string): Promise<DshUsage | null> {
    return this.usageOf(cwd, nativeId);
  }

  /** A session's totals, decoded once per log generation: a settled turn asks for usage and context. */
  private async usageOf(cwd: string, nativeId: string): Promise<DshUsage | null> {
    const found = await this.findSession(cwd, nativeId);
    if (!found || found.head.header.version !== 4) return null;
    const stat = await fs.stat(found.file.file).catch(() => null);
    if (!stat?.isFile()) return null;
    const cached = this.usageCache.get(found.file.file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.usage;
    const text = await readLogText(found.file, stat.size);
    if (text === null) return null;
    const usage = usageFromEvents(eventsFromText(text));
    if (this.usageCache.size >= 5000) this.usageCache.clear();
    this.usageCache.set(found.file.file, { mtimeMs: stat.mtimeMs, size: stat.size, usage });
    return usage;
  }

  async forkSession(): Promise<{ nativeId: string }> {
    throw new Error("DeepSeek Harness cannot fork a session here");
  }

  async seedChat(): Promise<LiveChat> {
    throw new Error("DeepSeek Harness cannot take a handoff here");
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    const chat = new DshLiveChat(this, req.cwd, req.resumeNativeId ?? null, req.renderEnv);
    await chat.start();
    return chat;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...children].map((child) => terminateChild(child)));
  }
}
