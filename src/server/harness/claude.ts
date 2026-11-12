// Claude Code adapter: one `claude -p --input-format stream-json
// --output-format stream-json` child per live chat, the stdio protocol
// Anthropic's Agent SDK drives. The installed CLI stays the source of truth for
// models, login, settings, hooks, MCP servers, skills, permissions, and session
// files; this module translates its stream and control requests and reads its
// session files (never writing one, except a fork's new copy).
import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { execHarness, spawnHarness } from "../platform-win.js";
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";
import {
  asHarnessId,
  type ChatConfig,
  type ChatItem,
  type ConfigPatch,
  type ContextCategory,
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
import { historyToItems, isObj, textOf, type Obj } from "./agent-events.js";
import { PendingRequests, StderrTail, terminateChild } from "./child-process.js";
import {
  forkSessionText,
  latestTodos,
  parseEntries,
  projectDirName,
  sessionMeta,
  transcriptMessages,
  usageBaseline,
  usageOfEntries,
  type SessionMeta,
  type UsageBaseline,
} from "./claude-sessions.js";
import { claudeTaskReport } from "./jobs.js";
import { claudeLimits, claudeUsageLimits } from "./limits.js";
import { promptCacheExpiresAt, promptCacheTtlMs } from "./prompt-cache.js";
import { orchestrateMcpServer, ORCH_MCP_SERVER, renderHtmlMcpServer } from "./render-extension.js";
import { orchestrationMcpToolNames } from "./render-token.js";
import { HTML_RENDER_MCP_SERVER, HTML_RENDER_MCP_TOOL, splitRenderMarker } from "./render-token.js";
import { versionLabel } from "./version.js";
import { DialogTracker, EventHub } from "./event-hub.js";
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

/** How long the initialize handshake may take (hooks and MCP servers start first). */
const READY_TIMEOUT_MS = 60_000;
const MODEL_CACHE_MS = 5 * 60_000;
/** How long a fetched plan usage stands: each ask starts a claude child, and the plan's windows move slowly. */
const USAGE_CACHE_MS = 3 * 60_000;
/**
 * The usage probe's child: no session written, no MCP servers, and only
 * project settings (it runs in the home folder, so the user's hooks do not
 * fire). Its login is Claude Code's own; awui never sees the token.
 */
const USAGE_PROBE_ARGS = ["--no-session-persistence", "--strict-mcp-config", "--setting-sources", "project"];
/**
 * The SDK's transport: JSON lines both ways, partial messages for streaming,
 * user messages echoed when the CLI takes them (that is when a queued one
 * starts), and permission prompts answered over stdio by this host.
 */
/**
 * The CLI arguments that give a chat awui's tools: its MCP servers (render_html,
 * and the orchestration tools when the chat has a token), started with that
 * chat's endpoints (the user's own MCP servers still load), and those tools
 * allowed without a prompt, since they only publish a page into this chat or
 * delegate work from it. None without a server's file or its token.
 */
function toolsMcpArgs(toolEnv: NodeJS.ProcessEnv | undefined): string[] {
  // The CLI runs on Node; a compiled awui binary is not one, so then the Node on PATH runs the server.
  const node = process.versions.bun ? "node" : process.execPath;
  const servers: Record<string, unknown> = {};
  const allowed: string[] = [];
  const render = renderHtmlMcpServer();
  if (render && toolEnv?.AWUI_RENDER_URL && toolEnv.AWUI_RENDER_TOKEN) {
    servers[HTML_RENDER_MCP_SERVER] = { type: "stdio", command: node, args: [render], env: { AWUI_RENDER_URL: toolEnv.AWUI_RENDER_URL, AWUI_RENDER_TOKEN: toolEnv.AWUI_RENDER_TOKEN } };
    allowed.push(HTML_RENDER_MCP_TOOL);
  }
  const orchestrate = orchestrateMcpServer();
  if (orchestrate && toolEnv?.AWUI_ORCH_URL && toolEnv.AWUI_ORCH_TOKEN) {
    servers[ORCH_MCP_SERVER] = { type: "stdio", command: node, args: [orchestrate], env: { AWUI_ORCH_URL: toolEnv.AWUI_ORCH_URL, AWUI_ORCH_TOKEN: toolEnv.AWUI_ORCH_TOKEN } };
    allowed.push(...orchestrationMcpToolNames());
  }
  if (Object.keys(servers).length === 0) return [];
  // With tool search on, Claude Code defers these schemas and the model loads one by name through
  // ToolSearch; allow that call too, so loading awui's own tool never waits on an approval card.
  allowed.push(TOOL_SEARCH_TOOL);
  // Claude Code takes the list comma-separated in one argument (`--allowedTools <tools...>` is variadic,
  // and the flags after it must not be swallowed).
  return ["--mcp-config", JSON.stringify({ mcpServers: servers }), "--allowedTools", allowed.join(",")];
}

/** Claude Code's permission modes, in the order its own Shift+Tab cycle and docs give them. */
const PERMISSION_MODES: PermissionModeInfo[] = [
  { id: "default", label: "Ask first", description: "Asks before edits and commands your rules do not allow" },
  { id: "acceptEdits", label: "Accept edits", description: "Makes file edits without asking; still asks before most commands" },
  { id: "plan", label: "Plan", description: "Researches and plans; changes nothing" },
  { id: "auto", label: "Auto", description: "A safety check approves routine actions and stops risky ones" },
  { id: "dontAsk", label: "Don't ask", description: "Never asks: anything your rules do not allow is denied" },
];
/**
 * Offered only when config.yml's claude args launch the CLI able to switch to
 * it: without one of these flags it refuses the mode.
 */
const BYPASS_MODE: PermissionModeInfo = { id: "bypassPermissions", label: "Bypass", description: "Runs everything without asking or checking", caution: true };
const BYPASS_FLAGS = ["--allow-dangerously-skip-permissions", "--dangerously-skip-permissions"];

/** The models (by alias and by id) the CLI says can run in auto mode. */
function autoModeModels(raw: unknown[]): Set<string> {
  const keys = new Set<string>();
  for (const m of raw) {
    if (!isObj(m) || m.supportsAutoMode !== true) continue;
    if (str(m.value)) keys.add(str(m.value));
    if (str(m.resolvedModel)) keys.add(str(m.resolvedModel));
  }
  return keys;
}

/** The built-in tool that loads a deferred MCP tool's schema on demand (Claude Code's tool search). */
const TOOL_SEARCH_TOOL = "ToolSearch";

const STREAM_ARGS = [
  "-p",
  "--input-format",
  "stream-json",
  "--output-format",
  "stream-json",
  "--verbose",
  "--include-partial-messages",
  "--replay-user-messages",
  "--permission-prompt-tool",
  "stdio",
];

export interface ClaudeOptions {
  /** The executable (tests point this at a script). */
  command?: string;
  /** config.yml's extra arguments for every chat child (after the stream protocol's, which must stay). */
  args?: string[];
  home: string;
  env?: NodeJS.ProcessEnv;
}

// Every claude child this process spawned; killed on shutdown and on exit.
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

export function liveClaudeChildren(): number {
  return children.size;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One claude child: control requests out, everything else handed to `onFrame`. */
class ClaudeRpc {
  readonly child: ChildProcessWithoutNullStreams;
  exited = false;
  private readonly stderr: StderrTail;
  private exitListeners = new Set<(message: string) => void>();
  private readonly calls = new PendingRequests<string>(
    {
      formatId: (n) => `awui-${n}`,
      encode: (id, payload) => ({ type: "control_request", request_id: id, request: payload }),
      answeredId: (frame) => (frame.type === "control_response" && isObj(frame.response) && typeof frame.response.request_id === "string" ? frame.response.request_id : null),
      outcome: (frame) => {
        const r = frame.response as Obj;
        return r.subtype === "success" ? { value: r.response ?? null } : { error: new Error(str(r.error) || "claude refused the request") };
      },
    },
    (frame) => this.write(frame),
  );
  /** The initialize response: commands, models, account, permission mode. */
  readonly init: Promise<Obj>;

  constructor(command: string, args: string[], env: NodeJS.ProcessEnv, cwd: string, onFrame: (frame: Obj) => void) {
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
      onFrame(frame);
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
    this.child.once("error", (error) => onExit(`could not start claude (${error.message})`));
    this.child.once("exit", (code, signal) => onExit(`claude exited (${signal ?? `code ${code}`})`));
    this.init = this.request<Obj>({ subtype: "initialize" }, READY_TIMEOUT_MS).then((r) => (isObj(r) ? r : {}));
    this.init.catch(() => undefined);
  }

  onExit(listener: (message: string) => void): void {
    this.exitListeners.add(listener);
  }

  write(frame: Obj): void {
    if (this.exited) throw new Error("claude is not running");
    this.child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  request<T = unknown>(request: Obj, timeoutMs?: number | null): Promise<T> {
    return this.calls.send<T>(request, `claude did not answer ${String(request.subtype)}`, timeoutMs);
  }

  /** Answer one of the CLI's own control requests. */
  respond(requestId: string, response: Obj | null, error?: string): void {
    try {
      this.write({
        type: "control_response",
        response: error ? { subtype: "error", request_id: requestId, error } : { subtype: "success", request_id: requestId, ...(response ? { response } : {}) },
      });
    } catch {
      // The child is gone; so is its request.
    }
  }

  kill(): Promise<void> {
    return terminateChild(this.child);
  }
}

/** One sessionless child's answer for a project: the models, and the default a new chat there starts on. */
interface ModelProbe {
  at: number;
  models: ModelInfo[];
  defaultModel: { model: string; thinkingLevel: string | null };
}

function toModelInfo(m: unknown): ModelInfo | null {
  if (!isObj(m) || typeof m.value !== "string" || !m.value) return null;
  const levels = Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels.map(String) : [];
  const resolved = str(m.resolvedModel);
  return {
    key: m.value,
    provider: "anthropic",
    id: resolved || m.value,
    name: str(m.displayName) || m.value,
    ...(m.supportsEffort === true || levels.length > 0 ? { reasoning: true } : {}),
    ...(levels.length > 0 ? { levels } : {}),
  };
}

function toCommand(c: unknown): SlashCommand | null {
  if (!isObj(c) || typeof c.name !== "string" || !c.name) return null;
  return {
    name: c.name,
    ...(str(c.description) ? { description: str(c.description) } : {}),
    ...(str(c.argumentHint) ? { hint: str(c.argumentHint) } : {}),
    source: "command",
  };
}

function toTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t): TodoItem[] => (isObj(t) && str(t.content) ? [{ text: str(t.content), status: str(t.status) || "pending" }] : []));
}

/** User message content for the API: image blocks first, then the text. */
function userContent(text: string, images?: ImageAttachment[]): unknown {
  if (!images?.length) return text;
  return [...images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mimeType, data: i.data } })), { type: "text", text }];
}

/** A short line for the approval card: the command, the file, or the input. */
function requestSummary(input: unknown): string {
  if (!isObj(input)) return "";
  for (const key of ["command", "file_path", "path", "url", "pattern", "notebook_path"]) {
    if (typeof input[key] === "string") return input[key] as string;
  }
  try {
    return JSON.stringify(input).slice(0, 400);
  } catch {
    return "";
  }
}

const ALLOW_ONCE = "Allow once";
const ALLOW_SESSION = "Allow for this session";
const DENY = "Deny";

interface QueuedMessage {
  uuid: string;
  text: string;
  mode: "steering" | "followUp";
}

/** The model call in progress, assembled from stream events. */
interface Step {
  model?: string;
  text: string;
  thinking: string;
  start: Obj;
  end: Obj;
  /**
   * When this call's stream opened. The cache's lifetime counts from the request and the wire
   * carries no earlier mark; message_start arrives within a round trip of it, which a 5-minute
   * or 1-hour window does not notice.
   */
  startedAt: number;
  tools: Array<{ id: string; name: string; input: unknown }>;
}

class ClaudeLiveChat implements LiveChat {
  private hub = new EventHub();
  private dialogs = new DialogTracker(this.hub);
  private rpc: ClaudeRpc | null = null;
  private disposed = false;
  private sessionId: string;
  private sessionTitle: string | null = null;
  private models: ModelInfo[] = [];
  private commands: SlashCommand[] = [];
  private model: string | null = null;
  private effort: string | null = null;
  private permissionMode: string | null = null;
  private autoModels = new Set<string>();
  private queued: QueuedMessage[] = [];
  private step: Step | null = null;
  private running = false;
  private todos: TodoItem[] = [];
  private usage: UsageBaseline = { turns: 0, steps: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: 0 };
  /** How long this session's prompt cache lives and when it runs out, from the newest call that said. */
  private cache: { ttlMs: number; expiresAt: number; requestedAt: number } | null = null;
  /** can_use_tool requests the CLI withdrew; their late answers go nowhere. */
  private withdrawn = new Set<string>();
  private compactWaiter: (() => void) | null = null;

  constructor(
    private readonly adapter: ClaudeAdapter,
    private readonly cwd: string,
    private readonly resumeId: string | null,
    /** The chat's render endpoint (AWUI_RENDER_URL/TOKEN), for render_html's MCP server. */
    private readonly toolEnv?: NodeJS.ProcessEnv,
  ) {
    this.sessionId = resumeId ?? randomUUID();
  }

  get nativeId(): string | null {
    return this.sessionId;
  }

  get title(): string | null {
    return this.sessionTitle;
  }

  private get live(): ClaudeRpc {
    if (!this.rpc || this.rpc.exited) throw new Error("claude is not running for this chat");
    return this.rpc;
  }

  private emit(event: Parameters<HarnessEventListener>[0]): void {
    this.hub.emit(event);
  }

  async start(): Promise<void> {
    const args = [...STREAM_ARGS, ...toolsMcpArgs(this.toolEnv), ...this.adapter.extraArgs, ...(this.resumeId ? ["--resume", this.resumeId] : ["--session-id", this.sessionId])];
    const rpc = new ClaudeRpc(this.adapter.cliCommand, args, this.adapter.childEnv(), this.cwd, (frame) => this.onFrame(frame));
    this.rpc = rpc;
    rpc.onExit((message) => {
      if (this.disposed) return;
      this.dialogs.cancelAll();
      this.emit({ type: "fatal", message: `claude stopped unexpectedly (${message})` });
    });
    // The session file (hundreds of MB for a long one) is read while the child boots, not before it
    // is spawned: the two do not depend on each other.
    const resumed = this.resumeId ? this.readResumed(this.resumeId) : null;
    resumed?.catch(() => undefined);
    try {
      if (resumed) {
        const { entries, meta } = await resumed;
        this.sessionTitle = meta && meta.title !== meta.firstPrompt.slice(0, 80) ? meta.title : null;
        this.usage = usageBaseline(entries);
        // The file's own last cache write says when the prefix it holds stops being readable, so a
        // chat opened after a long gap knows at once rather than after its first prompt.
        for (const entry of entries) {
          if (entry.type !== "assistant" || !isObj(entry.message) || !isObj(entry.message.usage)) continue;
          const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
          if (Number.isFinite(at)) this.noteCache(entry.message.usage, at);
        }
        this.todos = toTodos(latestTodos(entries));
      }
      const init = await rpc.init;
      const models = Array.isArray(init.models) ? init.models : [];
      this.models = models.map(toModelInfo).filter((m): m is ModelInfo => m !== null);
      this.autoModels = autoModeModels(models);
      this.permissionMode = str(init.current_permission_mode) || null;
      this.commands = (Array.isArray(init.commands) ? init.commands : []).map(toCommand).filter((c): c is SlashCommand => c !== null);
      // Thinking is omitted from the stream unless asked for; summaries are what the TUI shows.
      const [settings] = await Promise.all([
        this.readSettings(rpc),
        rpc.request({ subtype: "set_max_thinking_tokens", max_thinking_tokens: null, thinking_display: "summarized" }).catch(() => undefined),
      ]);
      this.model = str(settings.effective.model) || "default";
      this.emit({ type: "session", nativeId: this.sessionId });
    } catch (error) {
      await rpc.kill().catch(() => undefined);
      throw error;
    }
  }

  /** A resumed session's own file: its title, usage so far, and last todo list. */
  private async readResumed(id: string): Promise<{ entries: Obj[]; meta: ReturnType<typeof sessionMeta> }> {
    const file = await this.adapter.sessionFile(this.cwd, id);
    if (!file) throw new Error("Session not found in Claude Code's project folder");
    const entries = parseEntries(await fs.readFile(file, "utf8"));
    return { entries, meta: sessionMeta(entries, id) };
  }

  // ---- the stream -------------------------------------------------------------

  private onFrame(frame: Obj): void {
    // Subagent work (Task) streams with a parent tool id; only its tool call shows.
    if (typeof frame.parent_tool_use_id === "string") return;
    switch (frame.type) {
      case "stream_event":
        if (isObj(frame.event)) this.onStreamEvent(frame.event);
        return;
      case "assistant":
        this.onAssistant(frame);
        return;
      case "user":
        this.onUser(frame);
        return;
      case "result":
        this.onResult(frame);
        return;
      case "system":
        this.onSystem(frame);
        return;
      case "control_request":
        this.onControlRequest(frame);
        return;
      case "control_cancel_request":
        this.onCancelRequest(str(frame.request_id));
        return;
      case "rate_limit_event": {
        const info = isObj(frame.rate_limit_info) ? frame.rate_limit_info : {};
        if (info.status === "rejected") {
          const resets = num(info.resetsAt) ? ` until ${new Date(num(info.resetsAt) * 1000).toLocaleTimeString()}` : "";
          this.emit({ type: "notice", level: "error", text: `Claude usage limit reached${resets}` });
        }
        this.emit({ type: "limits", account: claudeLimits(info) });
        return;
      }
      default:
        return;
    }
  }

  private onStreamEvent(event: Obj): void {
    switch (event.type) {
      case "message_start": {
        const message = isObj(event.message) ? event.message : {};
        this.step = { ...(str(message.model) ? { model: str(message.model) } : {}), text: "", thinking: "", start: isObj(message.usage) ? message.usage : {}, end: {}, startedAt: Date.now(), tools: [] };
        this.emit({ type: "assistant_start", ...(this.step.model ? { model: this.step.model } : {}) });
        return;
      }
      case "content_block_delta": {
        const delta = isObj(event.delta) ? event.delta : {};
        if (!this.step) return;
        if (delta.type === "text_delta" && str(delta.text)) {
          this.step.text += str(delta.text);
          this.emit({ type: "assistant_delta", field: "text", delta: str(delta.text) });
        } else if (delta.type === "thinking_delta" && str(delta.thinking)) {
          this.step.thinking += str(delta.thinking);
          this.emit({ type: "assistant_delta", field: "thinking", delta: str(delta.thinking) });
        }
        return;
      }
      case "message_delta":
        if (this.step && isObj(event.usage)) this.step.end = event.usage;
        return;
      case "message_stop":
        this.endStep();
        return;
      default:
        return;
    }
  }

  /** Close the model call: its answer first, then the tools it called (the order the UI folds them in). */
  private endStep(): void {
    const step = this.step;
    if (!step) return;
    this.step = null;
    const usage: StepUsage = {
      input: num(step.start.input_tokens),
      cacheRead: num(step.start.cache_read_input_tokens),
      cacheWrite: num(step.start.cache_creation_input_tokens),
      output: num(step.end.output_tokens) || num(step.start.output_tokens),
    };
    this.usage.steps += 1;
    // The end frame carries the same breakdown when a call wrote the cache late; start has the counts.
    this.noteCache(step.start, step.startedAt);
    this.noteCache(step.end, step.startedAt);
    this.emit({ type: "assistant_end", text: step.text, thinking: step.thinking, usage });
    for (const tool of step.tools) this.emit({ type: "tool_start", toolCallId: tool.id, name: tool.name, args: tool.input });
  }

  /**
   * Remember how long the prompt cache the last call wrote stays readable, from its usage. Older
   * calls (a resumed file read after a live one) do not overwrite a newer reading.
   */
  private noteCache(usage: Obj, requestedAt: number): void {
    const ttlMs = promptCacheTtlMs(usage);
    if (ttlMs === undefined || (this.cache !== null && requestedAt < this.cache.requestedAt)) return;
    this.cache = { ttlMs, expiresAt: promptCacheExpiresAt(ttlMs, requestedAt), requestedAt };
  }

  /** Whole content blocks: tool calls (held until the call ends) and the TodoWrite list. */
  private onAssistant(frame: Obj): void {
    const message = isObj(frame.message) ? frame.message : {};
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (!isObj(block) || block.type !== "tool_use") continue;
      const tool = { id: str(block.id), name: str(block.name) || "tool", input: block.input ?? {} };
      if (tool.name === "TodoWrite" && isObj(tool.input)) this.todos = toTodos(tool.input.todos);
      if (this.step) this.step.tools.push(tool);
      else this.emit({ type: "tool_start", toolCallId: tool.id, name: tool.name, args: tool.input });
    }
  }

  private onUser(frame: Obj): void {
    const message = isObj(frame.message) ? frame.message : {};
    if (frame.isReplay === true) {
      // The CLI took this prompt: now it starts (queued ones included).
      const text = textOf(message.content);
      const images = Array.isArray(message.content) ? message.content.filter((b) => isObj(b) && b.type === "image").length : 0;
      const index = this.queued.findIndex((q) => q.uuid === frame.uuid);
      const fallback = index >= 0 ? index : this.queued.findIndex((q) => q.text === text);
      if (fallback >= 0) {
        this.queued.splice(fallback, 1);
        this.emitQueue();
      }
      this.running = true;
      this.emit({ type: "user_message", text, ...(images ? { imageCount: images } : {}) });
      this.emit({ type: "busy" });
      return;
    }
    const results = (Array.isArray(message.content) ? message.content : []).filter((b): b is Obj => isObj(b) && b.type === "tool_result");
    for (const block of results) {
      const content = block.content;
      // render_html's MCP result carries its page on its last line: into the details (read only for that tool).
      const marked = splitRenderMarker(typeof content === "string" ? content : textOf(content));
      const output = marked.text;
      // The CLI's structured result (an edit's structuredPatch) belongs to the frame; it carries one result per frame.
      const details = marked.details ? { details: marked.details } : results.length === 1 && frame.tool_use_result !== undefined ? { details: frame.tool_use_result } : {};
      this.emit({ type: "tool_end", toolCallId: str(block.tool_use_id), output, isError: block.is_error === true, ...details });
    }
  }

  private onResult(frame: Obj): void {
    this.endStep();
    const usage = isObj(frame.usage) ? frame.usage : {};
    this.usage.turns += 1;
    this.usage.input += num(usage.input_tokens);
    this.usage.cachedInput += num(usage.cache_read_input_tokens);
    this.usage.cacheWrite += num(usage.cache_creation_input_tokens);
    this.usage.output += num(usage.output_tokens);
    this.usage.cost += num(frame.total_cost_usd);
    const aborted = /^aborted/.test(str(frame.terminal_reason));
    if (frame.is_error === true && !aborted) {
      const errors = Array.isArray(frame.errors) ? frame.errors.map(String).join("; ") : "";
      this.emit({ type: "notice", level: "error", text: errors || str(frame.result) || `Claude Code stopped (${str(frame.subtype)})` });
    }
    this.compactWaiter?.();
    this.compactWaiter = null;
    // A queued message starts right after; settling now would flash Idle between them.
    if (this.queued.length === 0 || aborted) {
      this.running = false;
      this.emit({ type: "settled" });
    }
  }

  private onSystem(frame: Obj): void {
    switch (frame.subtype) {
      case "init": {
        const id = str(frame.session_id);
        if (id && id !== this.sessionId) {
          this.sessionId = id;
          this.emit({ type: "session", nativeId: id });
        }
        this.notePermissionMode(str(frame.permissionMode));
        return;
      }
      case "status":
        if (frame.status === "compacting") this.emit({ type: "compacting", active: true });
        // Every mode change is announced here, the CLI's own too (an approved plan leaves plan mode).
        this.notePermissionMode(str(frame.permissionMode));
        return;
      case "compact_boundary":
        this.emit({ type: "compacting", active: false });
        this.emit({ type: "notice", level: "info", text: "Compacted conversation" });
        return;
      case "session_title_changed":
        if (str(frame.title)) {
          this.sessionTitle = str(frame.title);
          this.emit({ type: "title", title: this.sessionTitle });
        }
        return;
      case "api_retry": {
        const attempt = num(frame.attempt);
        const max = num(frame.max_retries);
        this.emit({ type: "notice", level: "warning", text: `Retrying the API call${attempt ? ` (attempt ${attempt}${max ? `/${max}` : ""})` : ""}` });
        return;
      }
      case "notification":
        if (str(frame.message) || str(frame.text)) this.emit({ type: "notice", level: "info", text: str(frame.message) || str(frame.text) });
        return;
      // A background task (a run_in_background Bash) ending, or its state changing: the call that started it shows it.
      case "task_notification":
      case "task_updated": {
        const id = str(frame.task_id);
        const state = frame.subtype === "task_notification" ? str(frame.status) : isObj(frame.patch) ? str(frame.patch.status) : "";
        if (!id || !state) return;
        this.emit({ type: "job_reports", jobs: [claudeTaskReport(id, state, str(frame.summary))] });
        return;
      }
      default:
        return;
    }
  }

  // ---- the CLI's requests -------------------------------------------------------

  private onControlRequest(frame: Obj): void {
    const id = str(frame.request_id);
    const request = isObj(frame.request) ? frame.request : {};
    if (!id) return;
    if (request.subtype !== "can_use_tool") {
      // Hook callbacks, MCP messages, elicitations: nothing here registered for them.
      this.rpc?.respond(id, null, `${str(request.subtype) || "this request"} is not supported by awui`);
      return;
    }
    if (request.tool_name === "AskUserQuestion" && isObj(request.input) && Array.isArray(request.input.questions)) {
      void this.askQuestions(id, request.input);
      return;
    }
    const sessionRules = (Array.isArray(request.permission_suggestions) ? request.permission_suggestions : []).filter(
      (s): s is Obj => isObj(s) && s.type === "addRules" && s.behavior === "allow",
    );
    const name = str(request.display_name) || str(request.tool_name) || "Tool";
    const summary = requestSummary(request.input);
    const card: InteractionRequest = {
      id,
      kind: "select",
      title: `Allow ${name}?`,
      message: [str(request.description), summary && summary !== str(request.description) ? summary : "", str(request.decision_reason)].filter(Boolean).join("\n"),
      options: [ALLOW_ONCE, ...(sessionRules.length > 0 ? [ALLOW_SESSION] : []), DENY],
      createdAt: Date.now(),
    };
    void this.dialogs.open(card).then((answer) => {
      if (this.withdrawn.delete(id)) return;
      const value = answer && answer.kind === "select" ? answer.value : null;
      if (value === ALLOW_ONCE || value === ALLOW_SESSION) {
        this.rpc?.respond(id, {
          behavior: "allow",
          updatedInput: request.input ?? {},
          // Session scope only: the web UI never writes your Claude Code settings files.
          ...(value === ALLOW_SESSION ? { updatedPermissions: sessionRules.map((s) => ({ ...s, destination: "session" })) } : {}),
        });
      } else {
        this.rpc?.respond(id, { behavior: "deny", message: answer ? "Denied in awui" : "Cancelled in awui", ...(answer ? {} : { interrupt: true }) });
      }
    });
  }

  /** AskUserQuestion: one select card per question, the answers handed back as the tool's input. */
  private async askQuestions(id: string, input: Obj): Promise<void> {
    const answers: Record<string, string> = {};
    const questions = (input.questions as unknown[]).filter(isObj);
    for (const [i, q] of questions.entries()) {
      const raw = (Array.isArray(q.options) ? q.options : []).filter((o) => (isObj(o) ? str(o.label) : String(o)));
      const options = raw.map((o) => (isObj(o) ? str(o.label) : String(o)));
      const details = raw.map((o) => (isObj(o) ? str(o.description) : ""));
      const answer = await this.dialogs.open({
        id: `${id}:${i}`,
        kind: options.length > 0 ? "select" : "input",
        title: str(q.header) || "Claude Code asks",
        message: str(q.question),
        ...(options.length > 0 ? { options } : {}),
        ...(details.some(Boolean) ? { optionDetails: details } : {}),
        createdAt: Date.now(),
      });
      if (this.withdrawn.has(id)) return void this.withdrawn.delete(id);
      if (!answer || (answer.kind !== "select" && answer.kind !== "input")) {
        this.rpc?.respond(id, { behavior: "deny", message: "The user dismissed the question", interrupt: true });
        return;
      }
      answers[str(q.question)] = answer.value;
    }
    this.rpc?.respond(id, { behavior: "allow", updatedInput: { ...input, answers } });
  }

  private onCancelRequest(id: string): void {
    if (!id) return;
    this.withdrawn.add(id);
    for (const requestId of [id, ...Array.from({ length: 8 }, (_, i) => `${id}:${i}`)]) {
      if (this.dialogs.answer(requestId, { kind: "cancel" })) this.emit({ type: "request_cancelled", requestId, outcome: "cancelled" });
    }
  }

  // ---- LiveChat -----------------------------------------------------------------

  subscribe(listener: HarnessEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async history(): Promise<ChatItem[]> {
    const file = await this.adapter.sessionFile(this.cwd, this.sessionId);
    if (!file) return [];
    return historyToItems(transcriptMessages(parseEntries(await fs.readFile(file, "utf8"))));
  }

  async getConfig(): Promise<ChatConfig> {
    return {
      model: this.model,
      thinkingLevel: this.effort,
      models: this.models,
      thinkingLevels: this.levels(),
      permissionMode: this.permissionMode,
      permissionModes: this.permissionModes(),
    };
  }

  private notePermissionMode(mode: string): void {
    if (!mode || mode === this.permissionMode) return;
    this.permissionMode = mode;
    this.emit({ type: "config", config: { permissionMode: mode, permissionModes: this.permissionModes() } });
  }

  /** The modes this chat can switch to: auto only on a model that runs it, bypass only when the CLI was launched able to. */
  private permissionModes(): PermissionModeInfo[] {
    const auto = this.autoModels.has(this.baseModel) || this.permissionMode === "auto";
    const modes = PERMISSION_MODES.filter((m) => m.id !== "auto" || auto);
    if (this.adapter.allowsBypass || this.permissionMode === BYPASS_MODE.id) modes.push(BYPASS_MODE);
    // A mode this list does not know (a newer CLI's) still shows as the one in force.
    if (this.permissionMode && !modes.some((m) => m.id === this.permissionMode)) modes.push({ id: this.permissionMode, label: this.permissionMode, description: "Set by Claude Code" });
    return modes;
  }

  /** The chosen model without a context variant: "opus[1m]" has what "opus" has. */
  private get baseModel(): string {
    return this.model?.replace(/\[[^\]]*\]$/, "") ?? "";
  }

  /** The chosen model's effort levels, as the CLI lists them per model (some have fewer, some none). */
  private levels(): string[] {
    const key = this.baseModel;
    return (this.models.find((m) => m.key === key) ?? this.models.find((m) => m.id === key))?.levels ?? [];
  }

  /**
   * The settings in force. `applied.effort` is the effort the model really
   * runs at (its default when no settings file names one, null on a model
   * without levels); `effective.effortLevel` only says what a file or flag set.
   */
  private async readSettings(rpc: ClaudeRpc): Promise<{ effective: Obj }> {
    const settings = await rpc.request<Obj>({ subtype: "get_settings" }).catch(() => null);
    const effective = settings && isObj(settings.effective) ? settings.effective : {};
    const applied = settings && isObj(settings.applied) ? settings.applied : null;
    this.effort = (applied ? str(applied.effort) : str(effective.effortLevel)) || null;
    return { effective };
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const usage = await this.live.request<Obj>({ subtype: "get_context_usage", detail: "summary" }).catch(() => null);
    if (!usage) return null;
    const window = num(usage.maxTokens);
    const tokens = num(usage.totalTokens);
    // Deferred tools, the autocompact buffer, and free space take no room yet.
    const categories: ContextCategory[] = (Array.isArray(usage.categories) ? usage.categories : [])
      .filter((c): c is Obj => isObj(c) && c.kind === "used" && num(c.tokens) > 0)
      .map((c) => ({ id: str(c.name).toLowerCase().replace(/[^a-z0-9]+/g, "-"), label: str(c.name), tokens: num(c.tokens) }));
    return { tokens: tokens || null, window, percent: window > 0 ? (tokens / window) * 100 : null, categories };
  }

  async getUsage(): Promise<HarnessUsage | null> {
    const u = this.usage;
    const cache = this.cache;
    return {
      turns: u.turns,
      steps: u.steps,
      input: u.input,
      cachedInput: u.cachedInput,
      cacheWrite: u.cacheWrite,
      output: u.output,
      cost: u.cost > 0 ? u.cost : null,
      ...(cache ? { promptCacheTtlMs: cache.ttlMs, promptCacheExpiresAt: cache.expiresAt } : {}),
    };
  }

  async getTodos(): Promise<TodoItem[]> {
    return [...this.todos];
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [...this.commands];
  }

  private send(text: string, images: ImageAttachment[] | undefined, priority?: "next"): string {
    const uuid = randomUUID();
    this.live.write({
      type: "user",
      message: { role: "user", content: userContent(text, images) },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      uuid,
      ...(priority ? { priority } : {}),
    });
    return uuid;
  }

  private emitQueue(): void {
    const queue: QueueState = {
      steering: this.queued.filter((q) => q.mode === "steering").map((q) => q.text),
      followUp: this.queued.filter((q) => q.mode === "followUp").map((q) => q.text),
    };
    this.emit({ type: "queue", queue });
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    this.send(text, images);
  }

  /** Lands after the running tool call, inside the same turn. */
  async steer(text: string, images?: ImageAttachment[]): Promise<void> {
    this.queued.push({ uuid: this.send(text, images, "next"), text, mode: "steering" });
    this.emitQueue();
  }

  /** Waits in the CLI's queue and runs as the next turn. */
  async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
    this.queued.push({ uuid: this.send(text, images), text, mode: "followUp" });
    this.emitQueue();
  }

  /**
   * Claude Code cancels a queued message by its uuid; the new ones are sent
   * again in order. One the CLI already took runs anyway (its echo removes it).
   */
  async replaceQueue(queue: QueueState): Promise<void> {
    const rpc = this.live;
    const queued = this.queued.splice(0);
    await Promise.all(queued.map((q) => rpc.request({ subtype: "cancel_async_message", message_uuid: q.uuid }).catch(() => undefined)));
    for (const text of queue.steering) this.queued.push({ uuid: this.send(text, undefined, "next"), text, mode: "steering" });
    for (const text of queue.followUp) this.queued.push({ uuid: this.send(text, undefined), text, mode: "followUp" });
    this.emitQueue();
  }

  async abort(): Promise<void> {
    const rpc = this.live;
    const queued = this.queued.splice(0);
    if (queued.length > 0) this.emitQueue();
    await Promise.all(queued.map((q) => rpc.request({ subtype: "cancel_async_message", message_uuid: q.uuid }).catch(() => undefined)));
    this.dialogs.cancelAll();
    await rpc.request({ subtype: "interrupt" }).catch(() => undefined);
    if (!this.running) this.emit({ type: "settled" });
  }

  async setConfig(patch: ConfigPatch): Promise<void> {
    const rpc = this.live;
    if (patch.permissionMode !== undefined) {
      if (!this.permissionModes().some((m) => m.id === patch.permissionMode)) throw new Error(`${patch.permissionMode} is not a permission mode this chat can switch to`);
      const answer = await rpc.request<Obj>({ subtype: "set_permission_mode", mode: patch.permissionMode });
      this.notePermissionMode((isObj(answer) && str(answer.mode)) || patch.permissionMode);
    }
    if (patch.model !== undefined) {
      await rpc.request({ subtype: "set_model", model: patch.model });
      this.model = patch.model;
    }
    if (patch.thinkingLevel !== undefined) {
      // The CLI takes any word here without complaint, so only a level the model lists goes through.
      if (!this.levels().includes(patch.thinkingLevel)) throw new Error(`${patch.thinkingLevel} is not an effort level of this model`);
      // The flag layer: this session only, never your settings.json.
      await rpc.request({ subtype: "apply_flag_settings", settings: { effortLevel: patch.thinkingLevel } });
    }
    // A model has its own default effort, so either change can move it.
    if (patch.model !== undefined || patch.thinkingLevel !== undefined) await this.readSettings(rpc);
  }

  async refreshModels(): Promise<void> {
    this.adapter.dropModelCache();
    const listed = await this.live.request<Obj>({ subtype: "list_models" }).catch(() => null);
    const raw = Array.isArray(listed) ? listed : listed && Array.isArray(listed.models) ? listed.models : null;
    if (raw) {
      this.models = raw.map(toModelInfo).filter((m): m is ModelInfo => m !== null);
      this.autoModels = autoModeModels(raw);
    }
  }

  async rename(name: string): Promise<void> {
    await this.live.request({ subtype: "rename_session", title: name });
    this.sessionTitle = name;
  }

  async compact(instructions?: string): Promise<void> {
    const done = new Promise<void>((resolve) => {
      this.compactWaiter = resolve;
    });
    this.send(`/compact${instructions ? ` ${instructions}` : ""}`, undefined);
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

export class ClaudeAdapter implements HarnessAdapter {
  readonly id = asHarnessId("claude");
  readonly displayName = "Claude Code";
  readonly accent = "rare";
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
    supportsFork: true,
    supportsHandoff: false,
    supportsRewind: false,
    // Through awui's MCP server (extensions/render-html-mcp.mjs), which the CLI is given per chat.
    supportsHtmlRender: renderHtmlMcpServer() !== null,
    supportsQueueEdit: true,
    supportsPermissionMode: true,
    supportsResumeCommand: true,
    // Backgrounded Bash lives in a task file the CLI keeps across restarts; the file is the truth.
    readOnlyHarness: false,
    jobsSurviveRestart: true,
  };
  /** Per project: the models are the account's, but the default comes from the project's own settings too. */
  private modelCache = new Map<string, ModelProbe>();
  private modelReads = new Map<string, Promise<ModelProbe>>();
  private usageCache: { at: number; accounts: LimitAccount[] } | null = null;
  private metaCache = new Map<string, { mtimeMs: number; size: number; meta: SessionMeta | null }>();

  constructor(private readonly options: ClaudeOptions) {
    this.cliCommand = options.command ?? (process.env.CLAUDE_BIN?.trim() || "claude");
  }

  get extraArgs(): string[] {
    return this.options.args ?? [];
  }

  /** config.yml's claude args let the CLI switch to bypassPermissions. */
  get allowsBypass(): boolean {
    return this.extraArgs.some((a) => BYPASS_FLAGS.includes(a));
  }

  /**
   * The CLI's environment, minus the markers a parent Claude Code session sets. Tool search is
   * forced on: left at its default, Claude Code sends every MCP tool's schema in full on every
   * turn while they fit under a share of the context window, which is what this chat's two
   * servers (render_html and the orchestration tools) would cost. Deferred, the model loads the
   * one it needs through ToolSearch. A value the user set — in their own environment, config.yml,
   * or Claude's settings, whose `env` beats this one — is never replaced.
   */
  childEnv(): NodeJS.ProcessEnv {
    const env = { ...(this.options.env ?? process.env) };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;
    if (!env.ENABLE_TOOL_SEARCH?.trim()) env.ENABLE_TOOL_SEARCH = "true";
    return env;
  }

  async discover(): Promise<HarnessDiscovery> {
    const overrides = { CLAUDE_CONFIG_DIR: this.childEnv().CLAUDE_CONFIG_DIR ? "set" : "unset" } as const;
    try {
      const { stdout } = await execHarness(this.cliCommand, ["--version"], { timeout: 15_000, env: this.childEnv() });
      const label = versionLabel(stdout);
      return { available: true, ...(label.version ? label : {}), warnings: [], overrides };
    } catch {
      return { available: false, reason: "The claude CLI is not installed. Install Claude Code, run `claude` once, and log in.", warnings: [], overrides };
    }
  }

  workspaceProblem(): string | null {
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    return this.childEnv().CLAUDE_CONFIG_DIR || path.join(this.options.home, ".claude");
  }

  async resolveSessionDir(cwd: string): Promise<string> {
    return path.join(await this.resolveAgentDir(), "projects", projectDirName(path.resolve(cwd)));
  }

  /** The session's .jsonl in the project's folder, if it exists yet. */
  async sessionFile(cwd: string, nativeId: string): Promise<string | null> {
    if (!/^[0-9a-f-]{36}$/i.test(nativeId)) return null;
    const file = path.join(await this.resolveSessionDir(cwd), `${nativeId}.jsonl`);
    return (await fs.stat(file).catch(() => null))?.isFile() ? file : null;
  }

  /**
   * The terminal's own `claude`, not cliCommand: that may be a path from
   * CLAUDE_BIN or config.yml, which clients are not told. A session awui made
   * is resumable there by id even though Claude Code's picker leaves it out
   * (it hides sessions started through `claude -p`).
   */
  async resumeCommand(req: { cwd: string; nativeId: string }): Promise<string[] | null> {
    return (await this.sessionFile(req.cwd, req.nativeId)) ? ["claude", "--resume", req.nativeId] : null;
  }

  /** Listing metadata per file, reparsed only when its size or mtime changes. */
  private async meta(file: string): Promise<{ meta: SessionMeta | null; mtimeMs: number }> {
    const stat = await fs.stat(file).catch(() => null);
    if (!stat) {
      this.metaCache.delete(file);
      return { meta: null, mtimeMs: 0 };
    }
    const cached = this.metaCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return { meta: cached.meta, mtimeMs: stat.mtimeMs };
    const text = await fs.readFile(file, "utf8").catch(() => "");
    const meta = sessionMeta(parseEntries(text), path.basename(file, ".jsonl"));
    if (this.metaCache.size >= 5000) this.metaCache.clear();
    this.metaCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, meta });
    return { meta, mtimeMs: stat.mtimeMs };
  }

  private summary(meta: SessionMeta, mtimeMs: number): NativeSessionSummary {
    return { nativeId: meta.sessionId, title: meta.title, updatedAt: meta.updatedAt ?? new Date(mtimeMs), messageCount: meta.prompts };
  }

  async listSessions(cwd: string): Promise<NativeSessionSummary[]> {
    const dir = await this.resolveSessionDir(cwd);
    const resolved = path.resolve(cwd);
    const names = await fs.readdir(dir).catch(() => [] as string[]);
    const out: NativeSessionSummary[] = [];
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const { meta, mtimeMs } = await this.meta(path.join(dir, name));
      // Folder names are lossy (every symbol is "-"), so the file's own cwd decides.
      if (meta && (!meta.cwd || path.resolve(meta.cwd) === resolved)) out.push(this.summary(meta, mtimeMs));
    }
    return out.sort((a, b) => (b.updatedAt?.getTime() ?? 0) - (a.updatedAt?.getTime() ?? 0));
  }

  async listRecentSessions(limit: number): Promise<RecentNativeSession[]> {
    const root = path.join(await this.resolveAgentDir(), "projects");
    const dirs = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const files: Array<{ file: string; mtimeMs: number }> = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      for (const name of await fs.readdir(path.join(root, dir.name)).catch(() => [] as string[])) {
        if (!name.endsWith(".jsonl")) continue;
        const file = path.join(root, dir.name, name);
        const stat = await fs.stat(file).catch(() => null);
        if (stat?.isFile()) files.push({ file, mtimeMs: stat.mtimeMs });
      }
    }
    // Newest files first; only those are parsed (sessions with no prompt are skipped).
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const out: RecentNativeSession[] = [];
    for (const { file } of files) {
      if (out.length >= limit) break;
      const { meta, mtimeMs } = await this.meta(file);
      if (meta?.cwd) out.push({ ...this.summary(meta, mtimeMs), cwd: meta.cwd });
    }
    return out;
  }

  async listModels(cwd: string): Promise<ModelInfo[]> {
    return (await this.probeModels(cwd)).models;
  }

  /** The model and effort a new chat in `cwd` starts on: what Claude Code's own settings resolve to, as a chat reads them. */
  async defaultModel(cwd: string): Promise<{ model: string; thinkingLevel: string | null } | null> {
    return (await this.probeModels(cwd)).defaultModel;
  }

  forgetModels(cwd: string): void {
    this.modelCache.delete(cwd);
  }

  /** One sessionless child answers both the list and the default; a second caller joins the one on its way. */
  private probeModels(cwd: string): Promise<ModelProbe> {
    const cached = this.modelCache.get(cwd);
    if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return Promise.resolve(cached);
    const running = this.modelReads.get(cwd);
    if (running) return running;
    const read = this.fetchModels(cwd).finally(() => this.modelReads.delete(cwd));
    this.modelReads.set(cwd, read);
    return read;
  }

  private async fetchModels(cwd: string): Promise<ModelProbe> {
    const rpc = new ClaudeRpc(this.cliCommand, [...STREAM_ARGS, "--no-session-persistence"], this.childEnv(), cwd, () => undefined);
    try {
      const init = await rpc.init;
      const models = (Array.isArray(init.models) ? init.models : []).map(toModelInfo).filter((m): m is ModelInfo => m !== null);
      // The same get_settings a chat reads its model and effort from (readSettings): the user's, the project's, and the local layer resolved.
      const settings = await rpc.request<Obj>({ subtype: "get_settings" }).catch(() => null);
      const effective = settings && isObj(settings.effective) ? settings.effective : {};
      const applied = settings && isObj(settings.applied) ? settings.applied : null;
      const named = str(effective.model) || "default";
      // Settings may name a model by its full id; the picker knows it by its key.
      const model = models.find((m) => m.key === named)?.key ?? models.find((m) => m.id === named)?.key ?? named;
      const effort = (applied ? str(applied.effort) : str(effective.effortLevel)) || null;
      const probe: ModelProbe = { at: Date.now(), models, defaultModel: { model, thinkingLevel: effort } };
      if (this.modelCache.size > 50) this.modelCache.clear();
      this.modelCache.set(cwd, probe);
      return probe;
    } finally {
      await rpc.kill().catch(() => undefined);
    }
  }

  /** The plan's limits, asked of Claude Code itself (its get_usage control request), at most every few minutes. */
  async usageLimits(): Promise<LimitAccount[]> {
    if (this.usageCache && Date.now() - this.usageCache.at < USAGE_CACHE_MS) return this.usageCache.accounts;
    const rpc = new ClaudeRpc(this.cliCommand, [...STREAM_ARGS, ...USAGE_PROBE_ARGS], this.childEnv(), this.options.home, () => undefined);
    try {
      await rpc.init;
      const usage = await rpc.request<unknown>({ subtype: "get_usage", skip_behaviors: true }, 30_000);
      const account = claudeUsageLimits(usage);
      const accounts = account ? [account] : [];
      this.usageCache = { at: Date.now(), accounts };
      return accounts;
    } finally {
      await rpc.kill().catch(() => undefined);
    }
  }

  dropModelCache(): void {
    this.modelCache.clear();
  }

  /** Effort levels are per model (ModelInfo.levels). */
  async listThinkingLevels(): Promise<string[]> {
    return [];
  }

  async forkSession(req: { cwd: string; nativeId: string; throughTurns: number }): Promise<{ nativeId: string }> {
    const file = await this.sessionFile(req.cwd, req.nativeId);
    if (!file) throw new Error("Session not found in Claude Code's project folder");
    const id = randomUUID();
    const body = forkSessionText(parseEntries(await fs.readFile(file, "utf8")), req.throughTurns, id);
    const target = path.join(path.dirname(file), `${id}.jsonl`);
    const tmp = `${target}.${process.pid}.tmp`;
    await fs.writeFile(tmp, body, { mode: 0o600 });
    await fs.rename(tmp, target);
    return { nativeId: id };
  }

  async seedChat(): Promise<LiveChat> {
    throw new Error("Claude Code cannot take a handoff yet");
  }

  async readUsage(req: { cwd: string; nativeId: string }): Promise<UsageEntry[] | null> {
    const file = await this.sessionFile(req.cwd, req.nativeId);
    const text = file ? await fs.readFile(file, "utf8").catch(() => null) : null;
    if (text === null) return null;
    const entries = parseEntries(text);
    const meta = sessionMeta(entries, req.nativeId);
    if (!meta || (meta.cwd && path.resolve(meta.cwd) !== path.resolve(req.cwd))) return null;
    return usageOfEntries(entries);
  }

  async readTranscript(req: { cwd: string; nativeId: string }): Promise<{ items: ChatItem[]; title: string | null } | null> {
    const file = await this.sessionFile(req.cwd, req.nativeId);
    const text = file ? await fs.readFile(file, "utf8").catch(() => null) : null;
    if (text === null) return null;
    const entries = parseEntries(text);
    const meta = sessionMeta(entries, req.nativeId);
    // Folder names are lossy, so the file's own cwd decides which project it is.
    if (!meta || (meta.cwd && path.resolve(meta.cwd) !== path.resolve(req.cwd))) return null;
    return { items: historyToItems(transcriptMessages(entries)), title: meta.title !== meta.firstPrompt.slice(0, 80) ? meta.title : null };
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    const chat = new ClaudeLiveChat(this, req.cwd, req.resumeNativeId ?? null, req.toolEnv);
    await chat.start();
    return chat;
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...children].map((c) => terminateChild(c)));
  }
}
