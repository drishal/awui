// Codex adapter: one `codex app-server` child per live chat, speaking its own
// JSON-RPC dialect over stdio (JSON lines, `{id, method, params}` both ways).
// The installed CLI stays the source of truth for models, login, settings,
// sandbox and approval policy, MCP servers, and session files. Codex's app-server
// default sandbox is read-only, which makes a coding agent nearly useless, so a
// new thread starts in awui's "auto" mode (workspace-write, ask on request); the
// composer's permission pill switches it. Sessions are listed, forked, and read
// through the CLI's own API; transcripts and usage come from its rollout files,
// which awui never writes.
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { execHarness, spawnHarness } from "../platform-win.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
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
  type LimitAccount,
  type ModelInfo,
  type PermissionModeInfo,
  type QueueState,
  type SlashCommand,
  type TodoItem,
} from "../../shared/protocol.js";
import { embeddedVersion } from "../embedded.js";
import { isObj, type Obj } from "./agent-events.js";
import { PendingRequests, StderrTail, terminateChild } from "./child-process.js";
import {
  findRolloutFile,
  itemsToChatItems,
  parseRollout,
  readRolloutText,
  rolloutItems,
  rolloutMeta,
  rolloutUsage,
} from "./codex-transcript.js";
import { DialogTracker, EventHub } from "./event-hub.js";
import { HTML_RENDER_MCP_SERVER, splitRenderMarker } from "./render-token.js";
import { renderHtmlMcpServer } from "./render-extension.js";
import { codexLimits } from "./limits.js";
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

/** How long the initialize handshake may take (the app-server loads config, auth, and MCP servers first). */
const READY_TIMEOUT_MS = 60_000;
/** A metadata probe answers within this, or it is killed. */
const PROBE_TIMEOUT_MS = 20_000;
const MODEL_CACHE_MS = 5 * 60_000;
/** Each limits probe starts a child, and plan windows move slowly. */
const USAGE_CACHE_MS = 3 * 60_000;
/** How long a compaction may take before the caller is let go (the run itself continues). */
const COMPACT_WAIT_MS = 180_000;
const CLIENT_VERSION = embeddedVersion ?? "dev";
/** The earliest Codex with an app-server (`codex app-server`); older ones cannot drive a chat. */
const MIN_VERSION = [0, 40] as const;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A one-line title, the way Codex previews a thread. */
function oneLine(text: string, max = 100): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

/**
 * awui's permission modes as Codex's two dials: the approval policy (when it
 * asks) and the sandbox (what it may touch without asking). The names are
 * Codex's own, so the app-server's reply maps back onto them.
 */
interface CodexPolicy {
  approval: string;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  /** The thread/settings/update shape of the same sandbox. */
  policy: Obj;
}

const POLICIES: Record<string, CodexPolicy> = {
  "read-only": { approval: "on-request", sandbox: "read-only", policy: { type: "readOnly", networkAccess: false } },
  auto: {
    approval: "on-request",
    sandbox: "workspace-write",
    policy: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
  },
  "full-access": { approval: "never", sandbox: "danger-full-access", policy: { type: "dangerFullAccess" } },
};

const PERMISSION_MODES: PermissionModeInfo[] = [
  { id: "read-only", label: "Read only", description: "Reads and searches; asks before any command, and edits are refused" },
  { id: "auto", label: "Auto", description: "Edits files in the workspace and asks before commands or network access" },
  { id: "full-access", label: "Full access", description: "Runs anything without asking, anywhere on this machine", caution: true },
];

/** The mode a thread's own policy is in: Codex's reply, as one of the pills. */
function modeOf(approval: unknown, sandbox: unknown): string {
  const type = isObj(sandbox) ? str(sandbox.type) : "";
  if (str(approval) === "never" && type === "dangerFullAccess") return "full-access";
  if (type === "readOnly") return "read-only";
  if (type === "dangerFullAccess") return "full-access";
  return "auto";
}

/** The command line that gives a chat render_html: awui's MCP server, and only that. */
function renderMcpConfig(renderEnv: NodeJS.ProcessEnv | undefined): string[] {
  const server = renderHtmlMcpServer();
  if (!server || !renderEnv?.AWUI_RENDER_URL || !renderEnv.AWUI_RENDER_TOKEN) return [];
  // The CLI runs on Node; a compiled awui binary is not one, so then the Node on PATH runs the server.
  const node = process.versions.bun ? "node" : process.execPath;
  const base = `mcp_servers.${HTML_RENDER_MCP_SERVER}`;
  return [
    "-c",
    `${base}.command=${JSON.stringify(node)}`,
    "-c",
    `${base}.args=${JSON.stringify([server])}`,
    "-c",
    `${base}.env.AWUI_RENDER_URL=${JSON.stringify(renderEnv.AWUI_RENDER_URL)}`,
    "-c",
    `${base}.env.AWUI_RENDER_TOKEN=${JSON.stringify(renderEnv.AWUI_RENDER_TOKEN)}`,
  ];
}

/** The prompt's text and pictures as Codex's user input; an image travels as a data URL. */
function userInput(text: string, images?: ImageAttachment[]): Obj[] {
  const input: Obj[] = [];
  for (const image of images ?? []) input.push({ type: "image", url: `data:${image.mimeType};base64,${image.data}` });
  input.push({ type: "text", text, text_elements: [] });
  return input;
}

/** The ids a response frame answers, or null when it is a request or notification. */
function answeredId(frame: Obj): number | null {
  if (frame.method !== undefined) return null;
  if (frame.result === undefined && frame.error === undefined) return null;
  return typeof frame.id === "number" ? frame.id : null;
}

interface PendingServerRequest {
  id: number;
  method: string;
  params: Obj;
}

/** One app-server child: requests out, notifications and server requests to the handler. */
class CodexRpc {
  readonly child: ChildProcessWithoutNullStreams;
  exited = false;
  private readonly stderr: StderrTail;
  private exitListeners = new Set<(message: string) => void>();
  private readonly calls = new PendingRequests<number>(
    {
      formatId: (n) => n,
      encode: (id, payload) => ({ id, method: payload.method, ...(payload.params === undefined ? {} : { params: payload.params }) }),
      answeredId,
      outcome: (frame) => (frame.error !== undefined ? { error: new Error(isObj(frame.error) ? str(frame.error.message) || "codex refused the request" : "codex refused the request") } : { value: frame.result }),
    },
    (frame) => this.write(frame),
  );
  /** The initialize reply (userAgent, codexHome, platform). */
  readonly init: Promise<Obj>;

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
    const rl = readline.createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObj(frame) || this.calls.accept(frame)) return;
      this.onFrame(frame);
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
    this.child.once("error", (error) => onExit(`could not start codex (${error.message})`));
    this.child.once("exit", (code, signal) => onExit(`codex exited (${signal ?? `code ${code}`})`));
    this.init = this.request<Obj>("initialize", { clientInfo: { name: "awui", title: "awui", version: CLIENT_VERSION }, capabilities: { experimentalApi: true } }, READY_TIMEOUT_MS);
    this.init.catch(() => undefined);
    void this.init.then(() => this.notify("initialized", undefined)).catch(() => undefined);
  }

  onExit(listener: (message: string) => void): void {
    this.exitListeners.add(listener);
  }

  write(frame: Obj): void {
    if (this.exited) throw new Error("codex is not running");
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  request<T = unknown>(method: string, params: Obj | undefined, timeoutMs: number | null = PROBE_TIMEOUT_MS): Promise<T> {
    return this.calls.send<T>({ method, params }, `codex did not answer ${method}`, timeoutMs);
  }

  notify(method: string, params: Obj | undefined): void {
    try {
      this.write({ method, ...(params === undefined ? {} : { params }) });
    } catch {
      // The child is gone; so is the notification.
    }
  }

  respond(id: number, result: unknown): void {
    try {
      this.write({ id, result: result ?? {} });
    } catch {
      // The child is gone; so is its request.
    }
  }

  fail(id: number, message: string): void {
    try {
      this.write({ id, error: { code: -32601, message } });
    } catch {
      // The child is gone; so is its request.
    }
  }

  kill(): Promise<void> {
    return terminateChild(this.child);
  }
}

// Every codex child this process spawned; killed on shutdown and on exit.
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

export function liveCodexChildren(): number {
  return children.size;
}

export interface CodexOptions {
  /** The executable (tests point this at a script). */
  command?: string;
  /** config.yml's extra arguments for every chat child (after `app-server`). */
  args?: string[];
  home: string;
  env?: NodeJS.ProcessEnv;
}

interface UserInputQuestion {
  id: string;
  header: string;
  question: string;
  options: string[];
  details: string[];
}

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for this session";
const DENY = "Deny";

/** The model catalog and the default a new chat starts on, from one short-lived child. */
interface ModelProbe {
  at: number;
  models: ModelInfo[];
  /** The model the config names, whether or not the account's catalog lists it. */
  configuredModel: string;
  /** The model a new chat should start on: the configured one when the catalog has it, else the catalog's default. */
  defaultModel: { model: string; thinkingLevel: string | null };
}

function toModelInfo(model: Obj): ModelInfo | null {
  const id = str(model.model) || str(model.id);
  if (!id) return null;
  const efforts = Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts.filter(isObj).map((e) => str(e.reasoningEffort)).filter(Boolean) : [];
  const modalities = Array.isArray(model.inputModalities) ? model.inputModalities.map(String) : [];
  return {
    // Codex takes a bare model id in a config patch; its provider is openai's.
    key: id,
    provider: "openai",
    id,
    name: str(model.displayName) || id,
    ...(efforts.length > 0 ? { reasoning: true, levels: efforts } : {}),
    ...(modalities.includes("image") ? { vision: true } : {}),
  };
}

class CodexLiveChat implements LiveChat {
  private hub = new EventHub();
  private dialogs = new DialogTracker(this.hub);
  private rpc: CodexRpc | null = null;
  private disposed = false;
  private threadId: string;
  private sessionTitle: string | null = null;
  private models: ModelInfo[];
  private model: string | null;
  private effort: string | null;
  private permissionMode: string;
  private running = false;
  private turnId: string | null = null;
  private queue: Array<{ id: string; text: string }> = [];
  /** Assistant rows in flight, by Codex item id: its own text and thinking so far. */
  private drafts = new Map<string, { text: string; thinking: string; started: boolean }>();
  /** Shell rows in flight, by item id: its output so far. */
  private outputs = new Map<string, string>();
  /** Requests the app-server withdrew (its own answer, or a cancelled turn). */
  private withdrawn = new Set<string>();
  private compactWaiter: (() => void) | null = null;
  private usage = { turns: 0, steps: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0 };
  private context: { tokens: number; window: number } | null = null;

  constructor(
    private readonly adapter: CodexAdapter,
    private readonly cwd: string,
    private readonly resumeId: string | null,
    models: ModelInfo[],
    /** The chat's render endpoint (AWUI_RENDER_URL/TOKEN), for render_html's MCP server. */
    private readonly renderEnv?: NodeJS.ProcessEnv,
    /** The catalog's own default: what a thread or session naming an unusable model switches to. */
    private readonly catalogDefault: string | null = null,
    /** The model to start a new thread on, when the config's own is unusable here. */
    private readonly startModel: string | null = null,
  ) {
    this.threadId = resumeId ?? "";
    this.models = models;
    this.model = null;
    this.effort = null;
    this.permissionMode = "auto";
  }

  get nativeId(): string | null {
    return this.threadId || null;
  }

  get title(): string | null {
    return this.sessionTitle;
  }

  private get live(): CodexRpc {
    if (!this.rpc || this.rpc.exited) throw new Error("codex is not running for this chat");
    return this.rpc;
  }

  private emit(event: Parameters<HarnessEventListener>[0]): void {
    this.hub.emit(event);
  }

  async start(): Promise<void> {
    const args = ["app-server", ...renderMcpConfig(this.renderEnv), ...this.adapter.extraArgs];
    const rpc = new CodexRpc(this.adapter.cliCommand, args, this.adapter.childEnv(), this.cwd, (frame) => this.onFrame(frame));
    this.rpc = rpc;
    rpc.onExit((message) => {
      if (this.disposed) return;
      this.dialogs.cancelAll();
      this.emit({ type: "fatal", message: `codex stopped unexpectedly (${message})` });
    });
    try {
      await rpc.init;
      if (this.resumeId) {
        const resumed = await rpc.request<Obj>("thread/resume", { threadId: this.resumeId, cwd: this.cwd }, READY_TIMEOUT_MS);
        this.threadId = str(isObj(resumed.thread) ? resumed.thread.id : "") || this.resumeId;
        this.sessionTitle = str(isObj(resumed.thread) ? resumed.thread.name : "") || null;
        this.setUsableModel(str(resumed.model) || null);
        this.effort = str(resumed.reasoningEffort) || null;
        this.permissionMode = modeOf(resumed.approvalPolicy, resumed.sandbox);
        // The file's own counts, while the app-server only reports its totals from here on.
        const seeded = await this.adapter.readUsage({ cwd: this.cwd, nativeId: this.threadId }).catch(() => null);
        if (seeded) this.seedUsage(seeded);
      } else {
        const policy = POLICIES[this.permissionMode] as CodexPolicy;
        const started = await rpc.request<Obj>(
          "thread/start",
          { cwd: this.cwd, approvalPolicy: policy.approval, sandbox: policy.sandbox, ...(this.startModel ? { model: this.startModel } : {}) },
          READY_TIMEOUT_MS,
        );
        this.threadId = str(isObj(started.thread) ? started.thread.id : "");
        if (!this.threadId) throw new Error("codex did not name the thread it started");
        this.sessionTitle = str(isObj(started.thread) ? started.thread.name : "") || null;
        this.setUsableModel(str(started.model) || null);
        this.effort = str(started.reasoningEffort) || null;
        this.permissionMode = modeOf(started.approvalPolicy, started.sandbox);
      }
      this.emit({ type: "session", nativeId: this.threadId });
      if (this.sessionTitle) this.emit({ type: "title", title: this.sessionTitle });
    } catch (error) {
      await rpc.kill().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Codex records the model a session ran on, and a session from another login
   * (a paid one, a TUI with a different account) can name a model this account
   * cannot run: every turn then fails with modelNotFound. Switch it to the
   * catalog's default, on the thread too, so the session keeps working.
   */
  private setUsableModel(model: string | null): void {
    const usable = model && this.catalogDefault && this.models.length > 0 && !this.models.some((m) => m.key === model) ? this.catalogDefault : model;
    this.model = usable;
    if (usable && model && usable !== model) {
      void this.rpc?.request("thread/settings/update", { threadId: this.threadId, model: usable }).catch(() => undefined);
    }
  }

  /** A resumed session's calls, as the composer's stats line counts them. */
  private seedUsage(entries: UsageEntry[]): void {
    this.usage.steps += entries.length;
    for (const entry of entries) {
      this.usage.input += entry.input;
      this.usage.cachedInput += entry.cachedInput;
      this.usage.cacheWrite += entry.cacheWrite;
      this.usage.output += entry.output;
    }
  }

  // ---- the stream -------------------------------------------------------------

  private onFrame(frame: Obj): void {
    const method = str(frame.method);
    if (!method) return;
    const params = isObj(frame.params) ? frame.params : {};
    if (typeof frame.id === "number") {
      this.onServerRequest({ id: frame.id, method, params });
      return;
    }
    switch (method) {
      case "turn/started": {
        const turn = isObj(params.turn) ? params.turn : {};
        this.turnId = str(turn.id) || this.turnId;
        if (!this.running) {
          this.running = true;
          this.emit({ type: "busy" });
        }
        return;
      }
      case "turn/completed": {
        const turn = isObj(params.turn) ? params.turn : {};
        const status = str(turn.status);
        const error = isObj(turn.error) ? turn.error : null;
        this.turnId = null;
        this.running = false;
        this.drafts.clear();
        this.outputs.clear();
        if (status === "failed") this.emit({ type: "notice", level: "error", text: error ? str(error.message) || "Codex failed the run" : "Codex failed the run" });
        else if (status === "interrupted") this.emit({ type: "notice", level: "info", text: "Run stopped" });
        this.usage.turns += 1;
        this.emit({ type: "settled" });
        return;
      }
      case "item/started":
        if (isObj(params.item)) this.onItemStarted(params.item);
        return;
      case "item/completed":
        if (isObj(params.item)) this.onItemCompleted(params.item);
        return;
      case "item/agentMessage/delta": {
        const id = str(params.itemId);
        const draft = this.drafts.get(id);
        const delta = str(params.delta);
        if (!draft || !delta) return;
        draft.text += delta;
        this.startAssistant(draft);
        this.emit({ type: "assistant_delta", field: "text", delta });
        return;
      }
      case "item/reasoning/summaryTextDelta":
      case "item/reasoning/textDelta": {
        const id = str(params.itemId);
        const draft = this.drafts.get(id);
        const delta = str(params.delta);
        if (!draft || !delta) return;
        draft.thinking += delta;
        this.startAssistant(draft);
        this.emit({ type: "assistant_delta", field: "thinking", delta });
        return;
      }
      case "item/commandExecution/outputDelta": {
        const id = str(params.itemId);
        const delta = str(params.delta);
        if (!id || !delta) return;
        const output = (this.outputs.get(id) ?? "") + delta;
        this.outputs.set(id, output);
        this.emit({ type: "tool_update", toolCallId: id, output });
        return;
      }
      case "thread/tokenUsage/updated":
        this.onTokenUsage(isObj(params.tokenUsage) ? params.tokenUsage : {});
        return;
      case "account/rateLimits/updated":
        if (isObj(params.rateLimits)) this.emit({ type: "limits", account: codexLimits(params.rateLimits) });
        return;
      case "thread/name/updated": {
        const name = str(params.threadName);
        if (!name) return;
        this.sessionTitle = name;
        this.emit({ type: "title", title: name });
        return;
      }
      case "thread/queue/changed":
        void this.refreshQueue();
        return;
      case "error": {
        const error = isObj(params.error) ? params.error : {};
        const text = str(error.message) || "Codex reported an error";
        this.emit({ type: "notice", level: params.willRetry === true ? "warning" : "error", text });
        return;
      }
      case "configWarning": {
        const text = str(params.summary);
        if (text) this.emit({ type: "notice", level: "warning", text });
        return;
      }
      case "serverRequest/resolved": {
        // The app-server answered a request itself (an approved plan, a stopped
        // turn): a card still open for it is stale.
        const id = String(params.requestId ?? "");
        if (!id) return;
        this.withdrawn.add(id);
        if (this.dialogs.answer(id, { kind: "cancel" })) this.emit({ type: "request_cancelled", requestId: id, outcome: "cancelled" });
        return;
      }
      default:
        return;
    }
  }

  private onItemStarted(item: Obj): void {
    const id = str(item.id);
    switch (item.type) {
      case "userMessage": {
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content.map((c) => (isObj(c) && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n");
        const images = content.filter((c) => isObj(c) && (c.type === "image" || c.type === "localImage")).length;
        if (!this.running) {
          this.running = true;
          this.emit({ type: "busy" });
        }
        this.emit({ type: "user_message", text, ...(images > 0 ? { imageCount: images } : {}) });
        return;
      }
      // A message's row starts with its first visible piece: Codex's reasoning
      // is often encrypted, and an empty row is noise.
      case "reasoning":
        if (!id) return;
        this.drafts.set(id, { text: "", thinking: "", started: false });
        return;
      case "agentMessage":
        if (!id) return;
        this.drafts.set(id, { text: "", thinking: "", started: false });
        return;
      case "commandExecution": {
        if (!id) return;
        this.outputs.set(id, "");
        this.emit({ type: "tool_start", toolCallId: id, name: "shell", args: { command: shellCommand(str(item.command)), cwd: str(item.cwd) } });
        return;
      }
      case "fileChange": {
        if (!id) return;
        const files = (Array.isArray(item.changes) ? item.changes : []).filter(isObj).map((c) => str(c.path)).filter(Boolean);
        this.emit({ type: "tool_start", toolCallId: id, name: "apply_patch", args: { files } });
        return;
      }
      case "mcpToolCall": {
        if (!id) return;
        this.emit({ type: "tool_start", toolCallId: id, name: `${str(item.server) || "mcp"}.${str(item.tool) || "tool"}`, args: item.arguments ?? {} });
        return;
      }
      case "dynamicToolCall": {
        if (!id) return;
        this.emit({ type: "tool_start", toolCallId: id, name: str(item.tool) || "tool", args: item.arguments ?? {} });
        return;
      }
      case "webSearch": {
        if (!id) return;
        this.emit({ type: "tool_start", toolCallId: id, name: "web_search", args: { query: searchQuery(item) } });
        return;
      }
      case "imageView": {
        if (!id) return;
        this.emit({ type: "tool_start", toolCallId: id, name: "view_image", args: { path: str(item.path) } });
        return;
      }
      case "plan": {
        if (!id) return;
        this.emit({ type: "tool_start", toolCallId: id, name: "update_plan", args: {} });
        return;
      }
      case "contextCompaction":
        this.emit({ type: "compacting", active: true });
        return;
      default:
        return;
    }
  }

  private onItemCompleted(item: Obj): void {
    const id = str(item.id);
    switch (item.type) {
      case "reasoning": {
        const draft = this.drafts.get(id) ?? { text: "", thinking: "", started: false };
        this.drafts.delete(id);
        const thinking = draft.thinking || reasoningText(item);
        if (!draft.started && !thinking) return;
        this.startAssistant(draft);
        this.emit({ type: "assistant_end", text: draft.text, thinking });
        return;
      }
      case "agentMessage": {
        const draft = this.drafts.get(id) ?? { text: "", thinking: "", started: false };
        this.drafts.delete(id);
        const text = draft.text || str(item.text);
        if (!draft.started && !text) return;
        this.startAssistant(draft);
        this.emit({ type: "assistant_end", text, thinking: draft.thinking });
        this.usage.steps += 1;
        return;
      }
      case "commandExecution": {
        this.outputs.delete(id);
        const status = str(item.status);
        const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
        this.emit({
          type: "tool_end",
          toolCallId: id,
          output: str(item.aggregatedOutput),
          isError: status === "failed" || status === "declined" || (exitCode !== null && exitCode !== 0),
          details: { exit: exitCode },
        });
        return;
      }
      case "fileChange": {
        const status = str(item.status);
        const changes = Array.isArray(item.changes) ? item.changes : [];
        this.emit({
          type: "tool_end",
          toolCallId: id,
          output: status === "completed" ? "Applied" : status === "declined" ? "Declined" : status === "failed" ? "The patch did not apply" : "",
          isError: status === "failed" || status === "declined",
          details: { changes },
        });
        return;
      }
      case "mcpToolCall": {
        const result = isObj(item.result) ? item.result : null;
        const content = result && Array.isArray(result.content) ? result.content : [];
        const output = content.map((c) => (isObj(c) && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n");
        const failure = isObj(item.error) || str(item.status) === "failed" || result?.isError === true;
        const marked = splitRenderMarkerYielding(output);
        this.emit({
          type: "tool_end",
          toolCallId: id,
          output: marked.text,
          isError: failure,
          ...(marked.details ? { details: marked.details } : {}),
        });
        return;
      }
      case "dynamicToolCall": {
        const content = Array.isArray(item.contentItems) ? item.contentItems : [];
        const output = content.map((c) => (isObj(c) && typeof c.text === "string" ? c.text : "")).filter(Boolean).join("\n");
        this.emit({ type: "tool_end", toolCallId: id, output, isError: item.success === false });
        return;
      }
      case "webSearch":
        this.emit({ type: "tool_end", toolCallId: id, output: str(item.status) || "completed", isError: false });
        return;
      case "imageView":
        this.emit({ type: "tool_end", toolCallId: id, output: "", isError: false });
        return;
      case "plan":
        this.emit({ type: "tool_end", toolCallId: id, output: str(item.text), isError: false });
        return;
      case "contextCompaction":
        this.emit({ type: "compacting", active: false });
        this.emit({ type: "notice", level: "info", text: "Compacted conversation" });
        this.compactWaiter?.();
        this.compactWaiter = null;
        return;
      default:
        return;
    }
  }

  /** A row's opening event, once it has something to show. */
  private startAssistant(draft: { started: boolean }): void {
    if (draft.started) return;
    draft.started = true;
    this.emit({ type: "assistant_start", ...(this.model ? { model: this.model } : {}) });
  }

  private onTokenUsage(usage: Obj): void {
    const total = isObj(usage.total) ? usage.total : {};
    const last = isObj(usage.last) ? usage.last : {};
    this.usage.input = Math.max(0, num(total.inputTokens) - num(total.cachedInputTokens) - num(total.cacheWriteInputTokens));
    this.usage.cachedInput = num(total.cachedInputTokens);
    this.usage.cacheWrite = num(total.cacheWriteInputTokens);
    this.usage.output = num(total.outputTokens);
    const window = num(usage.modelContextWindow);
    const tokens = num(last.totalTokens) || num(last.inputTokens);
    if (window > 0 && tokens > 0) this.context = { tokens, window };
  }

  // ---- the CLI's requests -------------------------------------------------------

  private onServerRequest(request: PendingServerRequest): void {
    const { id, method, params } = request;
    switch (method) {
      case "item/commandExecution/requestApproval":
        this.askCommand(String(id), params);
        return;
      case "item/fileChange/requestApproval":
        this.askFiles(String(id), params);
        return;
      case "item/tool/requestUserInput":
        void this.askUserInput(String(id), params);
        return;
      case "applyPatchApproval":
        this.askFiles(String(id), params, true);
        return;
      case "execCommandApproval":
        this.askCommand(String(id), params, true);
        return;
      case "currentTime/read":
        this.rpc?.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
        return;
      case "item/permissions/requestApproval":
      case "mcpServer/elicitation/request":
        this.rpc?.fail(id, "Denied in awui");
        return;
      case "attestation/generate":
      case "account/chatgptAuthTokens/refresh":
        this.rpc?.fail(id, "awui does not manage Codex accounts; run `codex login` in a terminal");
        return;
      default:
        this.rpc?.fail(id, `${method} is not supported by awui`);
        return;
    }
  }

  private askCommand(dialogId: string, params: Obj, legacy = false): void {
    const command = Array.isArray(params.command) ? params.command.map(String).join(" ") : str(params.command);
    const cwd = str(params.cwd);
    const reason = str(params.reason);
    const decisions = approvalOptions(params.availableDecisions);
    const card: InteractionRequest = {
      id: dialogId,
      kind: "select",
      title: "Run this command?",
      message: [command, cwd && cwd !== command ? cwd : "", reason].filter(Boolean).join("\n"),
      options: decisions.options,
      createdAt: Date.now(),
    };
    void this.dialogs.open(card).then((answer) => {
      if (this.withdrawn.delete(dialogId)) return;
      const value = answer && answer.kind === "select" ? answer.value : null;
      if (legacy) {
        const decision = value === ALLOW_ONCE || value === ALLOW_SESSION ? "approved" : value === null ? "abort" : "denied";
        this.rpc?.respond(Number(dialogId), { decision: value === ALLOW_SESSION ? "approved_for_session" : decision });
        return;
      }
      if (value === ALLOW_ONCE) this.rpc?.respond(Number(dialogId), { decision: "accept" });
      else if (value === ALLOW_SESSION) this.rpc?.respond(Number(dialogId), { decision: "acceptForSession" });
      else this.rpc?.respond(Number(dialogId), { decision: decisions.deny });
    });
  }

  private askFiles(dialogId: string, params: Obj, legacy = false): void {
    const reason = str(params.reason);
    const root = str(params.grantRoot);
    const card: InteractionRequest = {
      id: dialogId,
      kind: "select",
      title: "Apply these file changes?",
      message: [reason || "Codex wants to change files in this workspace", root ? `Under ${root}` : ""].filter(Boolean).join("\n"),
      options: [ALLOW_ONCE, ALLOW_SESSION, DENY],
      createdAt: Date.now(),
    };
    void this.dialogs.open(card).then((answer) => {
      if (this.withdrawn.delete(dialogId)) return;
      const value = answer && answer.kind === "select" ? answer.value : null;
      if (legacy) {
        this.rpc?.respond(Number(dialogId), { decision: value === ALLOW_ONCE ? "approved" : value === ALLOW_SESSION ? "approved_for_session" : value === null ? "abort" : "denied" });
        return;
      }
      this.rpc?.respond(Number(dialogId), { decision: value === ALLOW_ONCE ? "accept" : value === ALLOW_SESSION ? "acceptForSession" : "decline" });
    });
  }

  /** request_user_input: one card per question, the answers handed back by question id. */
  private async askUserInput(requestId: string, params: Obj): Promise<void> {
    const questions: UserInputQuestion[] = (Array.isArray(params.questions) ? params.questions : []).filter(isObj).map((q) => {
      const options = Array.isArray(q.options) ? q.options.filter(isObj) : [];
      return {
        id: str(q.id),
        header: str(q.header),
        question: str(q.question),
        options: options.map((o) => str(o.label)).filter(Boolean),
        details: options.map((o) => str(o.description)),
      };
    });
    const answers: Record<string, { answers: string[] }> = {};
    for (const [i, question] of questions.entries()) {
      if (!question.id) continue;
      const dialogId = `${requestId}:${i}`;
      const answer = await this.dialogs.open({
        id: dialogId,
        kind: question.options.length > 0 ? "select" : "input",
        title: question.header || "Codex asks",
        message: question.question,
        ...(question.options.length > 0 ? { options: question.options } : {}),
        ...(question.details.some(Boolean) ? { optionDetails: question.details } : {}),
        createdAt: Date.now(),
      });
      if (this.withdrawn.has(requestId)) {
        this.withdrawn.delete(requestId);
        return;
      }
      if (!answer || (answer.kind !== "select" && answer.kind !== "input")) {
        this.rpc?.respond(Number(requestId), { answers: {} });
        return;
      }
      answers[question.id] = { answers: [answer.value] };
    }
    this.rpc?.respond(Number(requestId), { answers });
  }

  // ---- LiveChat -----------------------------------------------------------------

  subscribe(listener: HarnessEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async history(): Promise<ChatItem[]> {
    // A thread with no turns yet (a brand-new one) makes 0.167 fail
    // `thread/read includeTurns` with "list_turns is not supported yet", so a
    // throw here falls back to the rollout file — empty for a new thread, and
    // still the whole conversation if a version cannot page turns at all.
    const read = await this.live.request<Obj>("thread/read", { threadId: this.threadId, includeTurns: true }, READY_TIMEOUT_MS).catch(() => null);
    if (!read) return (await this.adapter.readTranscript({ cwd: this.cwd, nativeId: this.threadId }).catch(() => null))?.items ?? [];
    const thread = isObj(read.thread) ? read.thread : {};
    const turns = Array.isArray(thread.turns) ? thread.turns.filter(isObj) : [];
    const items: Obj[] = [];
    // A long thread's turns may arrive without their items; fetch the turns that
    // need it, oldest first, bounded so a huge history cannot hold the route.
    for (const turn of turns.slice(-40)) {
      const turnId = str(turn.id);
      const own = Array.isArray(turn.items) ? turn.items.filter(isObj) : [];
      if (!turnId) {
        items.push(...own);
        continue;
      }
      const full = str(turn.itemsView) === "full" ? null : await this.turnItems(turnId);
      items.push(...(full && full.length > 0 ? full : own));
    }
    return itemsToChatItems(items);
  }

  /** One turn's items, paged, bounded at 1000. */
  private async turnItems(turnId: string): Promise<Obj[]> {
    const out: Obj[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10 && out.length < 1000; page += 1) {
      const listed: Obj | null = await this.live.request<Obj>("thread/items/list", { threadId: this.threadId, turnId, limit: 100, ...(cursor ? { cursor } : {}) }).catch(() => null);
      if (!listed) break;
      const data = Array.isArray(listed.data) ? listed.data.filter(isObj) : [];
      out.push(...data.map((entry) => (isObj(entry.item) ? entry.item : entry)));
      cursor = str(listed.nextCursor) || null;
      if (!cursor) break;
    }
    return out;
  }

  async getConfig(): Promise<ChatConfig> {
    this.models = await this.adapter.modelsFor(this.cwd).catch(() => this.models);
    return {
      model: this.model,
      thinkingLevel: this.effort,
      models: this.models,
      thinkingLevels: this.levels(),
      permissionMode: this.permissionMode,
      permissionModes: PERMISSION_MODES,
    };
  }

  /** The chosen model's own effort levels; all of them when it is not in the catalog. */
  private levels(): string[] {
    const model = this.models.find((m) => m.key === this.model) ?? this.models.find((m) => m.id === this.model);
    if (model?.levels?.length) return model.levels;
    const levels = new Set<string>();
    for (const m of this.models) for (const level of m.levels ?? []) levels.add(level);
    return [...levels];
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    if (!this.context) return null;
    const { tokens, window } = this.context;
    return { tokens, window, percent: window > 0 ? (tokens / window) * 100 : null };
  }

  async getUsage(): Promise<HarnessUsage | null> {
    const u = this.usage;
    return { turns: u.turns, steps: u.steps, input: u.input, cachedInput: u.cachedInput, cacheWrite: u.cacheWrite, output: u.output, cost: null };
  }

  async getTodos(): Promise<TodoItem[]> {
    return [];
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [];
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    const rpc = this.live;
    await rpc.request("turn/start", { threadId: this.threadId, input: userInput(text, images), ...(this.model ? { model: this.model } : {}), ...(this.effort ? { effort: this.effort } : {}) }, READY_TIMEOUT_MS);
  }

  async steer(text: string, images?: ImageAttachment[]): Promise<void> {
    const rpc = this.live;
    const turnId = this.turnId;
    if (!turnId) throw new Error("Nothing is running to steer");
    await rpc.request("turn/steer", { threadId: this.threadId, expectedTurnId: turnId, input: userInput(text, images) });
  }

  /** Codex's own queue runs the message as the next turn once this one settles. */
  async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
    const rpc = this.live;
    await rpc.request("thread/queue/add", { threadId: this.threadId, input: userInput(text, images), clientUserMessageId: randomUUID() });
    await this.refreshQueue();
  }

  private async refreshQueue(): Promise<void> {
    if (!this.rpc || this.rpc.exited) return;
    const listed = await this.rpc.request<Obj>("thread/queue/list", { threadId: this.threadId }).catch(() => null);
    const data = listed && Array.isArray(listed.data) ? listed.data.filter(isObj) : [];
    this.queue = data.map((entry) => ({
      id: str(entry.id),
      text: (Array.isArray(entry.input) ? entry.input : []).map((i) => (isObj(i) ? str(i.text) : "")).filter(Boolean).join("\n"),
    }));
    const queue: QueueState = { steering: [], followUp: this.queue.map((q) => q.text) };
    this.emit({ type: "queue", queue });
  }

  /** Take back every queued message and add these in order (Codex's queue has no edit). */
  async replaceQueue(queue: QueueState): Promise<void> {
    const rpc = this.live;
    const listed = await rpc.request<Obj>("thread/queue/list", { threadId: this.threadId }).catch(() => null);
    const ids = (listed && Array.isArray(listed.data) ? listed.data.filter(isObj) : []).map((entry) => str(entry.id)).filter(Boolean);
    for (const id of ids) await rpc.request("thread/queue/delete", { threadId: this.threadId, queuedSubmissionId: id }).catch(() => undefined);
    for (const text of [...queue.steering, ...queue.followUp]) {
      await rpc.request("thread/queue/add", { threadId: this.threadId, input: userInput(text), clientUserMessageId: randomUUID() });
    }
    await this.refreshQueue();
  }

  async abort(): Promise<void> {
    const rpc = this.live;
    this.dialogs.cancelAll();
    const listed = await rpc.request<Obj>("thread/queue/list", { threadId: this.threadId }).catch(() => null);
    const ids = (listed && Array.isArray(listed.data) ? listed.data.filter(isObj) : []).map((entry) => str(entry.id)).filter(Boolean);
    for (const id of ids) await rpc.request("thread/queue/delete", { threadId: this.threadId, queuedSubmissionId: id }).catch(() => undefined);
    if (ids.length > 0) this.emit({ type: "queue", queue: { steering: [], followUp: [] } });
    const turnId = this.turnId;
    if (turnId) await rpc.request("turn/interrupt", { threadId: this.threadId, turnId }).catch(() => undefined);
    if (!this.running) this.emit({ type: "settled" });
  }

  async setConfig(patch: ConfigPatch): Promise<void> {
    const rpc = this.live;
    if (patch.permissionMode !== undefined) {
      const policy = POLICIES[patch.permissionMode];
      if (!policy) throw new Error(`${patch.permissionMode} is not a permission mode this chat can switch to`);
      // Applies to the turns after this one; approvals already asked are still ours to answer.
      await rpc.request("thread/settings/update", { threadId: this.threadId, approvalPolicy: policy.approval, sandboxPolicy: policy.policy });
      this.permissionMode = patch.permissionMode;
      this.emit({ type: "config", config: { permissionMode: this.permissionMode, permissionModes: PERMISSION_MODES } });
    }
    if (patch.model !== undefined) {
      this.model = patch.model;
      this.emit({ type: "config", config: { model: patch.model } });
      await rpc.request("thread/settings/update", { threadId: this.threadId, model: patch.model }).catch(() => undefined);
    }
    if (patch.thinkingLevel !== undefined) {
      if (!this.levels().includes(patch.thinkingLevel)) throw new Error(`${patch.thinkingLevel} is not an effort level of this model`);
      this.effort = patch.thinkingLevel;
      this.emit({ type: "config", config: { thinkingLevel: patch.thinkingLevel } });
    }
  }

  async refreshModels(): Promise<void> {
    this.adapter.dropModelCache();
    const listed = await this.live.request<Obj>("model/list", { includeHidden: false }).catch(() => null);
    const data = listed && Array.isArray(listed.data) ? listed.data.filter(isObj) : [];
    const models = data.map(toModelInfo).filter((m): m is ModelInfo => m !== null);
    if (models.length > 0) this.models = models;
  }

  async rename(name: string): Promise<void> {
    await this.live.request("thread/name/set", { threadId: this.threadId, name });
    this.sessionTitle = name;
  }

  async compact(): Promise<void> {
    const rpc = this.live;
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const timer = setTimeout(() => {
      if (this.compactWaiter === waiter) this.compactWaiter = null;
      finish();
    }, COMPACT_WAIT_MS);
    const waiter = () => {
      clearTimeout(timer);
      if (this.compactWaiter === waiter) this.compactWaiter = null;
      finish();
    };
    this.compactWaiter = waiter;
    try {
      await rpc.request("thread/compact/start", { threadId: this.threadId });
    } catch (error) {
      waiter();
      throw error;
    }
    await done;
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    if (!this.rpc || this.rpc.exited) return false;
    return this.dialogs.answer(requestId, answer);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.dialogs.cancelAll();
    this.hub.clear();
    this.compactWaiter?.();
    const rpc = this.rpc;
    this.rpc = null;
    await rpc?.kill().catch(() => undefined);
  }
}

/** The shell line a command item really ran (`/bin/bash -lc 'ls'` → `ls`). */
function shellCommand(command: string): string {
  const wrapped = /^\S*bash\S*\s+-l?c\s+([\s\S]+)$/.exec(command.trim());
  if (!wrapped?.[1]) return command.trim();
  const body = wrapped[1].trim();
  if ((body.startsWith("'") && body.endsWith("'")) || (body.startsWith('"') && body.endsWith('"'))) return body.slice(1, -1);
  return body;
}

function searchQuery(item: Obj): string {
  const action = isObj(item.action) ? item.action : {};
  return str(action.query) || str(action.url);
}

function reasoningText(item: Obj): string {
  const parts: string[] = [];
  for (const key of ["summary", "content"]) {
    const value = item[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) if (typeof entry === "string") parts.push(entry);
  }
  return parts.join("\n\n");
}

function splitRenderMarkerYielding(output: string): { text: string; details?: Obj } {
  const marked = splitRenderMarker(output);
  return { text: marked.text, ...(marked.details ? { details: marked.details } : {}) };
}

/** The approval card's choices, from the decisions Codex says it accepts. */
function approvalOptions(available: unknown): { options: string[]; deny: string } {
  const decisions = Array.isArray(available) ? available : [];
  const names = new Set(decisions.map((d) => (isObj(d) ? Object.keys(d)[0] ?? "" : String(d))));
  const accept = names.size === 0 || names.has("accept") || names.has("acceptWithExecpolicyAmendment");
  const session = names.size === 0 || names.has("acceptForSession");
  const deny = names.size === 0 || names.has("decline") ? "decline" : "cancel";
  return { options: [...(accept ? [ALLOW_ONCE] : []), ...(session ? [ALLOW_SESSION] : []), DENY], deny };
}

/** The CLI's environment, minus markers a parent Codex session sets. */
function codexChildEnv(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const out = { ...(env ?? process.env) };
  for (const key of ["CODEX_THREAD_ID", "CODEX_SANDBOX", "CODEX_SANDBOX_NETWORK_DISABLED"]) delete out[key];
  out.CODEX_INTERNAL_ORIGINATOR_OVERRIDE = "awui";
  return out;
}

export class CodexAdapter implements HarnessAdapter {
  readonly id = asHarnessId("codex");
  readonly displayName = "Codex";
  readonly cliCommand: string;
  readonly setupCommand = "codex login";
  readonly capabilities: HarnessCapabilities = {
    supportsSteer: true,
    supportsFollowUp: true,
    supportsThinkingLevel: true,
    supportsCompact: true,
    supportsExtensions: false,
    supportsInteractiveRequests: true,
    supportsRename: true,
    supportsModelSelection: true,
    supportsFork: true,
    // A handoff seeds a session with a portable transcript; Codex's only
    // transcript writer is its own rollout format, and awui does not write one.
    supportsHandoff: false,
    // `thread/revert` rewrites the thread's persisted history; it does not bring
    // the work tree back, so "Edit and retry" would leave files as they were.
    supportsRewind: false,
    supportsHtmlRender: renderHtmlMcpServer() !== null,
    supportsQueueEdit: true,
    supportsPermissionMode: true,
    supportsResumeCommand: true,
    jobsSurviveRestart: false,
  };
  private modelCache: ModelProbe | null = null;
  private modelRead: Promise<ModelProbe> | null = null;
  private usageCache: { at: number; accounts: LimitAccount[] } | null = null;
  /** One app-server child for metadata (models, listings, forks, limits): short-lived probes would spawn one per sidebar refresh. */
  private probeRpc: CodexRpc | null = null;
  private probeReady: Promise<CodexRpc> | null = null;
  private fileCache = new Map<string, string | null>();

  constructor(private readonly options: CodexOptions) {
    this.cliCommand = options.command ?? (process.env.CODEX_BIN?.trim() || "codex");
  }

  get extraArgs(): string[] {
    return this.options.args ?? [];
  }

  childEnv(): NodeJS.ProcessEnv {
    return codexChildEnv(this.options.env);
  }

  /** The metadata child, started on first use and replaced when it dies. */
  private ensureProbe(): Promise<CodexRpc> {
    if (this.probeRpc && !this.probeRpc.exited) return Promise.resolve(this.probeRpc);
    if (this.probeReady) return this.probeReady;
    const ready = (async () => {
      const rpc: CodexRpc = new CodexRpc(this.cliCommand, ["app-server", ...this.extraArgs], this.childEnv(), this.options.home, (frame) => {
        const id = typeof frame.id === "number" ? frame.id : null;
        if (id === null || !frame.method) return;
        if (frame.method === "currentTime/read") rpc.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
        else rpc.fail(id, `${str(frame.method)} is not supported by this probe`);
      });
      try {
        await rpc.init;
      } catch (error) {
        await rpc.kill().catch(() => undefined);
        throw error;
      }
      rpc.onExit(() => {
        if (this.probeRpc === rpc) this.probeRpc = null;
      });
      this.probeRpc = rpc;
      return rpc;
    })().finally(() => {
      this.probeReady = null;
    });
    this.probeReady = ready;
    return ready;
  }

  private async probe<T>(method: string, params: Obj): Promise<T> {
    return (await this.ensureProbe()).request<T>(method, params, PROBE_TIMEOUT_MS);
  }

  async discover(): Promise<HarnessDiscovery> {
    const overrides = { CODEX_HOME: this.childEnv().CODEX_HOME ? "set" : "unset" } as const;
    try {
      const { stdout } = await execHarness(this.cliCommand, ["--version"], { timeout: 15_000, env: this.childEnv() });
      const label = versionLabel(stdout);
      const [major = 0, minor = 0] = label.version.split(/[.-]/).map((part) => Number.parseInt(part, 10) || 0);
      if (major < MIN_VERSION[0] || (major === MIN_VERSION[0] && minor < MIN_VERSION[1])) {
        return { available: false, ...label, reason: `Codex ${MIN_VERSION[0]}.${MIN_VERSION[1]} or newer is needed (its app-server mode); run \`codex update\``, warnings: [], overrides };
      }
      return { available: true, ...label, warnings: [], overrides };
    } catch {
      return { available: false, reason: "The codex CLI is not installed. Install Codex, run `codex login`, and try again.", warnings: [], overrides };
    }
  }

  workspaceProblem(): string | null {
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    return this.childEnv().CODEX_HOME || path.join(this.options.home, ".codex");
  }

  async resolveSessionDir(): Promise<string> {
    return path.join(await this.resolveAgentDir(), "sessions");
  }

  /** The rollout file for a thread, remembered after the first found (ids never move). */
  private async sessionFile(nativeId: string): Promise<string | null> {
    const cached = this.fileCache.get(nativeId);
    if (cached !== undefined) return cached;
    const file = await findRolloutFile(await this.resolveSessionDir(), nativeId);
    if (file) {
      if (this.fileCache.size >= 500) this.fileCache.clear();
      this.fileCache.set(nativeId, file);
    }
    return file;
  }

  async resumeCommand(req: { cwd: string; nativeId: string }): Promise<string[] | null> {
    return (await this.sessionFile(req.nativeId)) ? ["codex", "resume", req.nativeId] : null;
  }

  async readTranscript(req: { cwd: string; nativeId: string }): Promise<{ items: ChatItem[]; title: string | null } | null> {
    const file = await this.sessionFile(req.nativeId);
    const text = file ? await readRolloutText(file) : null;
    if (text === null) return null;
    const lines = parseRollout(text);
    const meta = rolloutMeta(lines);
    if (!meta) return null;
    // A rollout records the folder it ran in; another project's file is not this chat's.
    if (meta.cwd && path.resolve(meta.cwd) !== path.resolve(req.cwd)) return null;
    return { items: itemsToChatItems(rolloutItems(lines)), title: null };
  }

  async readUsage(req: { cwd: string; nativeId: string }): Promise<UsageEntry[] | null> {
    const file = await this.sessionFile(req.nativeId);
    const text = file ? await readRolloutText(file) : null;
    if (text === null) return null;
    const lines = parseRollout(text);
    const meta = rolloutMeta(lines);
    if (!meta || (meta.cwd && path.resolve(meta.cwd) !== path.resolve(req.cwd))) return null;
    return rolloutUsage(lines);
  }

  async listSessions(cwd: string): Promise<NativeSessionSummary[]> {
    const listed = await this.probe<Obj>("thread/list", { cwd: path.resolve(cwd), limit: 60, sortKey: "updated_at" }).catch(() => null);
    return (listed && Array.isArray(listed.data) ? listed.data.filter(isObj) : []).flatMap((thread) => {
      const nativeId = str(thread.id);
      if (!nativeId) return [];
      return [{ nativeId, title: threadTitle(thread), updatedAt: updatedAtOf(thread) }];
    });
  }

  async listRecentSessions(limit: number): Promise<RecentNativeSession[]> {
    const listed = await this.probe<Obj>("thread/list", { limit, sortKey: "updated_at" }).catch(() => null);
    const threads = listed && Array.isArray(listed.data) ? listed.data.filter(isObj) : [];
    return threads.flatMap((thread) => {
      const nativeId = str(thread.id);
      const cwd = threadCwd(thread);
      if (!nativeId || !cwd) return [];
      return [{ nativeId, cwd, title: threadTitle(thread), updatedAt: updatedAtOf(thread) }];
    });
  }

  private probeModels(cwd: string): Promise<ModelProbe> {
    if (this.modelCache && Date.now() - this.modelCache.at < MODEL_CACHE_MS) return Promise.resolve(this.modelCache);
    if (this.modelRead) return this.modelRead;
    const read = this.fetchModels(cwd).finally(() => {
      this.modelRead = null;
    });
    this.modelRead = read;
    return read;
  }

  private async fetchModels(cwd: string): Promise<ModelProbe> {
    const listed = await this.probe<Obj>("model/list", { includeHidden: false });
    const raw = Array.isArray(listed.data) ? listed.data.filter(isObj) : [];
    const models = raw.map(toModelInfo).filter((m): m is ModelInfo => m !== null);
    const config = await this.probe<Obj>("config/read", {}).catch(() => null);
    const effective = config && isObj(config.config) ? config.config : {};
    const configuredModel = str(effective.model);
    const catalogDefault = raw.find((m) => m.isDefault === true);
    const fallbackModel = catalogDefault ? str(catalogDefault.model) || str(catalogDefault.id) : (models[0]?.key ?? "");
    // A config can name a model this account cannot run (a paid model on a free
    // ChatGPT plan, say): Codex fails every turn with "modelNotFound", so the
    // catalog's own default is what a new chat and a resumed broken one use.
    const model = configuredModel && models.some((m) => m.key === configuredModel) ? configuredModel : fallbackModel;
    const effort = str(effective.model_reasoning_effort) || null;
    const probe: ModelProbe = { at: Date.now(), models, configuredModel, defaultModel: { model, thinkingLevel: effort } };
    this.modelCache = probe;
    return probe;
  }

  async modelsFor(cwd: string): Promise<ModelInfo[]> {
    return (await this.probeModels(cwd)).models;
  }

  async listModels(cwd: string): Promise<ModelInfo[]> {
    return this.modelsFor(cwd);
  }

  async defaultModel(cwd: string): Promise<{ model: string; thinkingLevel: string | null } | null> {
    const probe = await this.probeModels(cwd);
    return probe.defaultModel.model ? probe.defaultModel : null;
  }

  forgetModels(): void {
    this.modelCache = null;
  }

  dropModelCache(): void {
    this.modelCache = null;
  }

  async listThinkingLevels(): Promise<string[]> {
    return [];
  }

  async forkSession(req: { cwd: string; nativeId: string; throughTurns: number }): Promise<{ nativeId: string }> {
    const read = await this.probe<Obj>("thread/read", { threadId: req.nativeId, includeTurns: true });
    const thread = isObj(read.thread) ? read.thread : {};
    const turns = Array.isArray(thread.turns) ? thread.turns.filter(isObj) : [];
    const through = turns[Math.max(0, Math.min(req.throughTurns, turns.length) - 1)];
    const lastTurnId = through && req.throughTurns < turns.length ? str(through.id) : null;
    const forked = await this.probe<Obj>("thread/fork", { threadId: req.nativeId, ...(lastTurnId ? { lastTurnId } : {}) });
    const id = str(isObj(forked.thread) ? forked.thread.id : "");
    if (!id) throw new Error("codex did not name the forked thread");
    return { nativeId: id };
  }

  async seedChat(): Promise<LiveChat> {
    throw new Error("Codex cannot take a handoff: awui does not write its rollout files");
  }

  /** The plan's windows, asked of Codex itself (`account/rateLimits/read`), at most every few minutes. */
  async usageLimits(): Promise<LimitAccount[]> {
    if (this.usageCache && Date.now() - this.usageCache.at < USAGE_CACHE_MS) return this.usageCache.accounts;
    const accounts = await this.probe<Obj>("account/rateLimits/read", {})
      .then((read) => (isObj(read.rateLimits) ? [codexLimits(read.rateLimits)] : []))
      .catch(() => [] as LimitAccount[]);
    this.usageCache = { at: Date.now(), accounts };
    return accounts;
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    // One cached catalog read tells whether the config's model is runnable here;
    // a chat that started on an unusable one would fail every turn.
    const probe = await this.probeModels(req.cwd).catch(() => null);
    const configured = probe?.configuredModel ?? "";
    const usable = probe && configured && !probe.models.some((m) => m.key === configured) ? probe.defaultModel.model : null;
    const chat = new CodexLiveChat(this, req.cwd, req.resumeNativeId ?? null, probe?.models ?? [], req.renderEnv, probe?.defaultModel.model ?? null, usable);
    await chat.start();
    return chat;
  }

  async shutdown(): Promise<void> {
    this.probeRpc = null;
    await Promise.allSettled([...children].map((c) => terminateChild(c)));
  }
}

function threadTitle(thread: Obj): string {
  const name = str(thread.name);
  if (name) return oneLine(name);
  const preview = oneLine(str(thread.preview));
  return preview || "Untitled";
}

function updatedAtOf(thread: Obj): Date | null {
  const seconds = num(thread.updatedAt) || num(thread.recencyAt) || num(thread.createdAt);
  return seconds > 0 ? new Date(seconds * 1000) : null;
}

function threadCwd(thread: Obj): string | null {
  const direct = str(thread.cwd);
  if (direct) return direct;
  const environments = Array.isArray(thread.environments) ? thread.environments : [];
  const first = environments.find(isObj);
  return first ? str(first.cwd) || null : null;
}
