// OpenCode adapter: OpenCode v2's HTTP API through one private server
// (opencode-server.ts). OpenCode stays the source of truth for models,
// providers and their keys, agents, plugins, permissions, and sessions (its own
// database, read and changed only through its API); this module turns its
// typed events into awui's and its messages into history (opencode-messages.ts).
//
// What maps where: a prompt, a steer, and a follow-up are prompts with
// OpenCode's delivery (none, steer, queue), and its inbox is awui's queue; a
// permission request is an approval card, a form a card per field; Edit and
// Retry revert the session to before the prompt (the files stay as they are:
// awui's own checkpoints undo those); fork copies the session before a prompt.
// A new chat's session is made on its first message, so an untouched chat
// leaves nothing in OpenCode's list.
import { execHarness } from "../platform-win.js";
import { homedir } from "node:os";
import path from "node:path";
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
  type QueueState,
  type SlashCommand,
  type SubagentRun,
  type TodoItem,
} from "../../shared/protocol.js";
import { historyToItems, isObj, toolSummary, type Obj } from "./agent-events.js";
import { isAgentTool } from "./subagents.js";
import { DialogTracker, EventHub } from "./event-hub.js";
import {
  childSession,
  contextWindow,
  delegateAgent,
  delegationResult,
  formQuestions,
  formValue,
  latestTodos,
  levelOf,
  modelKey,
  permissionCard,
  permissionReply,
  promptIds,
  todosOf,
  toModelInfo,
  toolResult,
  transcriptOf,
  usageOf,
} from "./opencode-messages.js";
import { locationQuery, OpenCodeServer, type OpenCodeEvent } from "./opencode-server.js";
import { AWUI_DENY_RULE, deniesAwui, isAwuiRule, openCodeTools, sameRules, type OpenCodeRule, type OpenCodeTools } from "./opencode-tools.js";
import { nodeForMcpServers, renderHtmlMcpServer } from "./render-extension.js";
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

const MODEL_CACHE_MS = 5 * 60_000;
/** Messages are read a page at a time, and no more than this many (history, previews, usage). */
const PAGE = 200;
const MAX_MESSAGES = 5000;
/** How long Stop waits for OpenCode to say the run ended. */
const ABORT_WAIT_MS = 10_000;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export interface OpenCodeOptions {
  /** The executable (tests point this at a script). */
  command?: string;
  env?: NodeJS.ProcessEnv;
}

interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

/** `provider/model` (and a level) as OpenCode's model reference; null for a key it cannot be. */
function refOf(key: string, level: string | null): ModelRef | null {
  const slash = key.indexOf("/");
  if (slash <= 0 || slash === key.length - 1) return null;
  return { providerID: key.slice(0, slash), id: key.slice(slash + 1), ...(level ? { variant: level } : {}) };
}

function filesOf(images: ImageAttachment[] | undefined): Obj[] {
  return (images ?? []).map((image, i) => ({ uri: `data:${image.mimeType};base64,${image.data}`, name: `image-${i + 1}.${image.mimeType.split("/")[1] ?? "png"}` }));
}

/** A subagent's child session, followed while it runs. */
interface Child {
  callId: string;
  agent: string;
  model: string | null;
  tools: Map<string, string>;
  toolCount: number;
  activity: string[];
  tokens: number;
  cost: number;
  started: number;
  ended: number | null;
  answer: string;
  status: "running" | "done" | "failed" | "stopped";
  error?: string;
  unsubscribe: () => void;
}

/** A delegation call (OpenCode's `task`, oh-my-opencode-slim's `subagent`) and the child it ran. */
interface Delegation {
  agent: string;
  input: unknown;
  child: string | null;
  /** The call's result text, once it returned (a background run goes on after). */
  output: string | null;
}

interface Step {
  model: string | null;
  text: string;
  thinking: string;
  /** The answer so far went out (assistant_end) when the step's first tool was called. */
  closed: boolean;
  /** Each ordinal's text so far, to fill in what an `ended` carries past the deltas. */
  texts: Map<number, string>;
  thoughts: Map<number, string>;
}

class OpenCodeChat implements LiveChat {
  private sessionId: string | null;
  private sessionTitle: string | null = null;
  private model: ModelRef | null = null;
  private readonly hub = new EventHub();
  private readonly dialogs = new DialogTracker(this.hub);
  /** Requests answered elsewhere (OpenCode's own TUI, another client): their cards close without a reply. */
  private readonly withdrawn = new Set<string>();
  /** Prompts OpenCode holds for later, by inbox id. */
  private readonly inbox = new Map<string, { text: string; delivery: string; images: number }>();
  private readonly tools = new Map<string, string>();
  private readonly delegations = new Map<string, Delegation>();
  private readonly children = new Map<string, Child>();
  private shownQueue = JSON.stringify({ steering: [], followUp: [] });
  private step: Step | null = null;
  private running = false;
  private usage = { turns: 0, steps: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: 0 };
  private lastTokens = 0;
  private todos: TodoItem[] = [];
  private commands: SlashCommand[] | null = null;
  private settledWaiters: Array<() => void> = [];
  private compactWaiter: ((error: string | null) => void) | null = null;
  private unsubscribe: (() => void) | null = null;
  private stopWatchingExit: (() => void) | null = null;
  private disposed = false;
  /** The last tools failure said aloud: OpenCode refusing them every turn is one problem, not one per turn. */
  private toolsWarning: string | null = null;

  constructor(
    private readonly adapter: OpenCodeAdapter,
    private readonly cwd: string,
    resumeId: string | null,
    /** awui's own tools for this chat, and the servers carrying them (opencode-tools.ts); null when it got none. */
    private readonly toolServers: OpenCodeTools | null = null,
  ) {
    this.sessionId = resumeId;
  }

  get nativeId(): string | null {
    return this.sessionId;
  }

  get title(): string | null {
    return this.sessionTitle;
  }

  private get server(): OpenCodeServer {
    return this.adapter.server;
  }

  private emit(event: Parameters<HarnessEventListener>[0]): void {
    this.hub.emit(event);
  }

  async start(): Promise<void> {
    this.stopWatchingExit = this.server.onExit((message) => {
      if (this.disposed || !this.unsubscribe) return;
      this.dialogs.cancelAll();
      this.emit({ type: "fatal", message });
    });
    if (!this.sessionId) return;
    const info = await this.adapter.sessionInfo(this.sessionId);
    if (!info || path.resolve(str(isObj(info.location) ? info.location.directory : "")) !== path.resolve(this.cwd)) {
      throw new Error("Session not found in this project's OpenCode sessions");
    }
    this.sessionTitle = str(info.title) || null;
    this.model = isObj(info.model) ? (info.model as unknown as ModelRef) : null;
    this.takeUsage(info);
    this.watch(this.sessionId);
    const messages = await this.adapter.messages(this.sessionId).catch(() => []);
    this.todos = latestTodos(messages);
    this.usage.turns = promptIds(messages).length;
    await this.wireTools(info);
    // A request that waits from before this chat opened (another client, a restart of the page).
    void this.reopenRequests();
  }

  /**
   * Give this chat awui's tools. Its servers are registered on the shared OpenCode server —
   * whose runtime set lives in that process's memory, so a restarted server has none, and
   * re-adding an unchanged config keeps its connection — and its session is scoped, so no
   * chat next door can call them. Registration happens when the chat opens and again before
   * each prompt; a failure is logged once and costs only the tools, never the chat.
   */
  private async wireTools(info?: Obj): Promise<void> {
    const tools = this.toolServers;
    if (!tools) return;
    for (const server of tools.servers) {
      await this.server.call("PUT", `/api/experimental/mcp/${encodeURIComponent(server.name)}?${locationQuery(this.cwd)}`, { config: server.config }).catch((error: unknown) => this.toolsFailed(error));
    }
    if (this.sessionId) await this.scope(this.sessionId, info).catch((error: unknown) => this.toolsFailed(error));
  }

  /**
   * Deny every awui tool server on this session, then allow this chat's own: the rule check is
   * last-match-wins, so the pair leaves another chat's tools refused while this chat's run without a
   * prompt. The session's other rules — the user's, OpenCode's own agent rules, a broad allow an
   * "always" answer appended — stay in front of that pair, which is why this is checked against the
   * stored rules on every turn instead of being written once: a rule added after ours would win the
   * match. The ones a previous open of this chat wrote are replaced.
   */
  private async scope(sessionId: string, info?: Obj): Promise<void> {
    const rules = this.toolServers?.rules;
    if (!rules) return;
    // The server's own record of the chat's session, for the adapter's guard on created sessions.
    this.adapter.noteSession(sessionId, rules);
    const session = info ?? (await this.adapter.sessionInfo(sessionId));
    if (!session) return;
    const current = Array.isArray(session.permissions) ? session.permissions : [];
    const wanted = [...current.filter((rule) => !isAwuiRule(rule)), ...rules];
    if (sameRules(current, wanted)) return;
    await this.server.call("PATCH", `/api/session/${sessionId}`, { permissions: wanted });
  }

  /** Say why the tools are missing, once: never the token, and never as a card over the chat. */
  private toolsFailed(error: unknown): void {
    const message = `OpenCode would not take awui's tools: ${error instanceof Error ? error.message : String(error)}`;
    if (this.toolsWarning === message) return;
    this.toolsWarning = message;
    console.error(`awui: ${message}`);
  }

  private watch(sessionId: string): void {
    this.unsubscribe?.();
    this.unsubscribe = this.server.subscribe(sessionId, (event) => this.onEvent(event));
  }

  private async reopenRequests(): Promise<void> {
    const id = this.sessionId;
    if (!id) return;
    const permissions = await this.server.call<{ data?: unknown[] }>("GET", `/api/session/${id}/permission`).catch(() => null);
    for (const p of permissions?.data ?? []) if (isObj(p)) this.askPermission(p);
    const forms = await this.server.call<{ data?: unknown[] }>("GET", `/api/session/${id}/form`).catch(() => null);
    for (const f of forms?.data ?? []) if (isObj(f)) void this.askForm(f);
  }

  /** The session, made on the first message with the model chosen before it. */
  private async ensureSession(): Promise<string> {
    if (this.sessionId) return this.sessionId;
    const created = await this.server.call<{ data?: Obj }>("POST", "/api/session", { location: { directory: this.cwd }, ...(this.model ? { model: this.model } : {}) });
    const id = str(created?.data?.id);
    if (!id) throw new Error("OpenCode made no session");
    this.sessionId = id;
    // Recorded before any rule is written: the adapter's guard on created sessions must know this
    // session belongs to a chat, so it never narrows the rules this chat is about to write.
    this.adapter.noteSession(id, this.toolServers?.rules ?? null);
    this.sessionTitle = str(created?.data?.title) || null;
    this.watch(id);
    this.emit({ type: "session", nativeId: id });
    return id;
  }

  private takeUsage(info: Obj): void {
    const t = isObj(info.tokens) ? info.tokens : {};
    const cache = isObj(t.cache) ? t.cache : {};
    this.usage.input = num(t.input);
    this.usage.output = num(t.output) + num(t.reasoning);
    this.usage.cachedInput = num(cache.read);
    this.usage.cacheWrite = num(cache.write);
    this.usage.cost = num(info.cost);
  }

  // ---- the event stream -----------------------------------------------------------

  private onEvent(event: OpenCodeEvent): void {
    const d = event.data;
    switch (event.type) {
      case "session.inbox.enqueued": {
        const item = isObj(d.item) ? d.item : {};
        if (item.type !== "user") return;
        const payload = isObj(item.payload) ? item.payload : {};
        this.inbox.set(str(d.inboxID), { text: str(payload.text), delivery: str(item.delivery), images: Array.isArray(payload.files) ? payload.files.length : 0 });
        if (this.running) this.emitQueue();
        return;
      }
      case "session.inbox.delivered": {
        const item = this.inbox.get(str(d.inboxID));
        if (!item) return;
        this.inbox.delete(str(d.inboxID));
        this.usage.turns += 1;
        this.emitQueue();
        this.emit({ type: "user_message", text: item.text, ...(item.images ? { imageCount: item.images } : {}) });
        if (!this.running) {
          this.running = true;
          this.emit({ type: "busy" });
        }
        return;
      }
      case "session.step.started": {
        this.endStep(null);
        const model = isObj(d.model) ? modelKey(d.model) : null;
        this.step = { model, text: "", thinking: "", closed: false, texts: new Map(), thoughts: new Map() };
        this.emit({ type: "assistant_start", ...(model ? { model } : {}) });
        return;
      }
      case "session.text.delta":
        return this.delta("text", num(d.ordinal), str(d.delta));
      case "session.text.ended":
        return this.ended("text", num(d.ordinal), str(d.text));
      case "session.reasoning.delta":
        return this.delta("thinking", num(d.ordinal), str(d.delta));
      case "session.reasoning.ended":
        return this.ended("thinking", num(d.ordinal), str(d.text));
      case "session.tool.input.started":
        this.tools.set(str(d.id), str(d.name) || "tool");
        return;
      case "session.tool.called": {
        // The step's words so far are its answer; the call folds under them, as each harness's do.
        this.closeStep(null);
        const name = this.tools.get(str(d.id)) ?? "tool";
        if (/todo/i.test(name) && isObj(d.input) && Array.isArray(d.input.todos)) this.todos = todosOf(d.input.todos);
        this.emit({ type: "tool_start", toolCallId: str(d.id), name, args: d.input ?? {} });
        if (isAgentTool(name)) this.delegations.set(str(d.id), { agent: delegateAgent(d.input), input: d.input, child: null, output: null });
        return;
      }
      case "session.tool.progress": {
        // A delegation's call names its child session as soon as it starts.
        const child = childSession(d.metadata);
        if (child && this.delegations.has(str(d.id))) this.adopt(str(d.id), child);
        return;
      }
      case "session.created": {
        // A child session of this one: a subagent. Its call names it too; this covers a call that does not.
        if (str(d.parentID) !== this.sessionId) return;
        const waiting = [...this.delegations].filter(([, x]) => x.child === null);
        const only = waiting.length === 1 ? waiting[0] : undefined;
        if (only) this.adopt(only[0], str(d.sessionID));
        return;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const failed = event.type === "session.tool.failed";
        const result = toolResult(d, failed, this.tools.get(str(d.id)) ?? "tool");
        const delegation = this.delegations.get(str(d.id));
        let details = result.details;
        if (delegation) {
          delegation.output = result.output;
          const child = childSession(d.metadata) ?? delegation.child;
          if (child && !delegation.child) this.adopt(str(d.id), child);
          const known = child ? this.children.get(child) : undefined;
          const row = delegationResult(delegation.input, { ...(isObj(d.metadata) ? d.metadata : {}), ...(child ? { sessionID: child } : {}) }, result.output, failed);
          // A background run goes on after its call returns: it is still running, and reports on.
          const background = isObj(delegation.input) && delegation.input.background === true;
          if (row) details = { ...(details ?? {}), results: [{ ...(known ? this.runRow(known) : {}), ...row, ...(background && known?.status === "running" ? { status: "running" } : {}) }] };
          if (!background || known?.status !== "running") {
            this.delegations.delete(str(d.id));
            if (child && known?.status !== "running") this.children.delete(child);
          }
        }
        this.emit({ type: "tool_end", toolCallId: str(d.id), output: result.output, isError: result.isError, ...(details ? { details } : {}) });
        return;
      }
      case "session.step.ended": {
        const t = isObj(d.tokens) ? d.tokens : {};
        const cache = isObj(t.cache) ? t.cache : {};
        const usage: StepUsage = { input: num(t.input), output: num(t.output) + num(t.reasoning), cacheRead: num(cache.read), cacheWrite: num(cache.write) };
        this.lastTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
        this.usage.steps += 1;
        this.endStep(usage);
        return;
      }
      case "session.step.failed": {
        const error = isObj(d.error) ? d.error : {};
        this.endStep(null, error.type === "aborted" ? null : str(error.message) || "Request failed");
        return;
      }
      case "session.usage.updated":
        this.takeUsage(d);
        return;
      case "session.execution.failed":
        this.emit({ type: "notice", level: "error", text: str(isObj(d.error) ? d.error.message : d.error) || "OpenCode's run failed" });
        return this.executionEnded(true);
      case "session.execution.succeeded":
        return this.executionEnded(false);
      case "session.execution.interrupted":
        return this.executionEnded(true);
      case "session.compaction.started":
        this.emit({ type: "compacting", active: true });
        return;
      case "session.compaction.ended":
        this.emit({ type: "compacting", active: false });
        this.emit({ type: "notice", level: "info", text: d.reason === "manual" ? "Compacted conversation" : "Compacted conversation automatically" });
        this.compactWaiter?.(null);
        this.compactWaiter = null;
        return;
      case "session.compaction.failed":
        this.emit({ type: "compacting", active: false });
        this.emit({ type: "notice", level: "error", text: `Compaction failed${isObj(d.error) && str(d.error.message) ? `: ${str(d.error.message)}` : ""}` });
        this.compactWaiter?.("Compaction failed");
        this.compactWaiter = null;
        return;
      case "session.renamed":
        if (str(d.title)) {
          this.sessionTitle = str(d.title);
          this.emit({ type: "title", title: this.sessionTitle });
        }
        return;
      case "session.model.selected":
        if (isObj(d.model)) {
          this.model = d.model as unknown as ModelRef;
          this.emit({ type: "config", config: { model: modelKey(d.model), thinkingLevel: levelOf(d.model) } });
        }
        return;
      case "permission.asked":
        this.askPermission(d);
        return;
      case "permission.replied":
        this.withdraw(str(d.requestID));
        return;
      case "form.created":
        if (isObj(d.form)) void this.askForm(d.form);
        return;
      case "form.replied":
      case "form.cancelled":
        this.withdraw(str(d.id));
        return;
      default:
        return;
    }
  }

  private delta(field: "text" | "thinking", ordinal: number, delta: string): void {
    const step = this.step;
    if (!step || step.closed || !delta) return;
    const parts = field === "text" ? step.texts : step.thoughts;
    // A second block of the same kind in one step reads as a new paragraph.
    const lead = !parts.has(ordinal) && (field === "text" ? step.text : step.thinking) ? "\n\n" : "";
    parts.set(ordinal, (parts.get(ordinal) ?? "") + delta);
    if (field === "text") step.text += lead + delta;
    else step.thinking += lead + delta;
    this.emit({ type: "assistant_delta", field, delta: lead + delta });
  }

  /** A block's whole text: a short one arrives only here, with no deltas before it. */
  private ended(field: "text" | "thinking", ordinal: number, text: string): void {
    const so = (field === "text" ? this.step?.texts : this.step?.thoughts)?.get(ordinal) ?? "";
    if (text.startsWith(so) && text.length > so.length) this.delta(field, ordinal, text.slice(so.length));
  }

  /** Close the step's answer (its first tool call, or its end). */
  private closeStep(usage: StepUsage | null, error?: string): void {
    const step = this.step;
    if (!step || step.closed) return;
    step.closed = true;
    this.emit({ type: "assistant_end", text: step.text, thinking: step.thinking, ...(usage ? { usage } : {}), ...(error ? { error } : {}) });
  }

  private endStep(usage: StepUsage | null, error?: string | null): void {
    this.closeStep(usage, error ?? undefined);
    this.step = null;
  }

  private executionEnded(stopped: boolean): void {
    this.endStep(null);
    // A queued prompt starts right after; settling now would flash Idle between them.
    if (!stopped && this.inbox.size > 0) return;
    if (this.running) {
      this.running = false;
      this.emit({ type: "settled" });
    }
    for (const resolve of this.settledWaiters.splice(0)) resolve();
  }

  private emitQueue(): void {
    const queue: QueueState = { steering: [], followUp: [] };
    for (const item of this.inbox.values()) (item.delivery === "queue" ? queue.followUp : queue.steering).push(item.text);
    // An idle prompt passes through the inbox in a moment: an empty queue that stays empty is no news.
    const shape = JSON.stringify(queue);
    if (shape === this.shownQueue) return;
    this.shownQueue = shape;
    this.emit({ type: "queue", queue });
  }

  // ---- subagents (child sessions) -----------------------------------------------------

  /** Follow the child session a delegation call runs, reporting it as the call's run. */
  private adopt(callId: string, childId: string): void {
    const delegation = this.delegations.get(callId);
    if (!delegation || !childId || this.children.has(childId)) return;
    delegation.child = childId;
    const child: Child = {
      callId,
      agent: delegation.agent,
      model: null,
      tools: new Map(),
      toolCount: 0,
      activity: [],
      tokens: 0,
      cost: 0,
      started: Date.now(),
      ended: null,
      answer: "",
      status: "running",
      unsubscribe: () => undefined,
    };
    child.unsubscribe = this.server.subscribe(childId, (event) => this.onChild(childId, event));
    this.children.set(childId, child);
    this.report(childId);
  }

  private onChild(childId: string, event: OpenCodeEvent): void {
    const child = this.children.get(childId);
    if (!child) return;
    const d = event.data;
    switch (event.type) {
      case "session.step.started":
        child.model = modelKey(d.model) ?? child.model;
        return;
      case "session.tool.input.started":
        child.tools.set(str(d.id), str(d.name) || "tool");
        return;
      case "session.tool.called": {
        const name = child.tools.get(str(d.id)) ?? "tool";
        child.toolCount += 1;
        const summary = toolSummary(d.input, name);
        child.activity = [...child.activity, `${name}${summary ? ` ${summary}` : ""}`].slice(-4);
        return this.report(childId);
      }
      case "session.text.ended":
        if (str(d.text).trim()) child.answer = str(d.text);
        return;
      case "session.usage.updated": {
        const t = isObj(d.tokens) ? d.tokens : {};
        child.tokens = num(t.input) + num(t.output) + num(t.reasoning);
        child.cost = num(d.cost);
        return this.report(childId);
      }
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        child.status = event.type === "session.execution.succeeded" ? "done" : event.type === "session.execution.failed" ? "failed" : "stopped";
        if (event.type === "session.execution.failed") child.error = str(isObj(d.error) ? d.error.message : d.error) || "The subagent failed";
        child.ended = Date.now();
        child.unsubscribe();
        this.report(childId);
        // Kept for its call's result (its totals), unless that call returned already (a background run).
        if (this.delegations.get(child.callId)?.output !== null) {
          this.children.delete(childId);
          this.delegations.delete(child.callId);
        }
        return;
      default:
        return;
    }
  }

  /** The child as a progress row (subagents.ts reads these). */
  private runRow(child: Child): Obj {
    return {
      index: 0,
      agent: child.agent,
      status: child.status,
      ...(child.model ? { model: child.model } : {}),
      toolCount: child.toolCount,
      ...(child.tokens ? { tokens: child.tokens } : {}),
      ...(child.cost ? { cost: child.cost } : {}),
      durationMs: (child.ended ?? Date.now()) - child.started,
      ...(child.status === "running" && child.activity.length > 0 ? { recentTools: child.activity } : {}),
      ...(child.answer && child.status !== "running" ? { output: child.answer } : {}),
      ...(child.error ? { error: child.error } : {}),
    };
  }

  private report(childId: string): void {
    const child = this.children.get(childId);
    // A call that has settled keeps its result; a late word from its child changes nothing.
    const delegation = child ? this.delegations.get(child.callId) : undefined;
    if (!child || !delegation) return;
    const output = delegation.output ?? "";
    this.emit({ type: "tool_update", toolCallId: child.callId, output, details: { progress: [{ id: childId, ...this.runRow(child) }] } });
  }

  // ---- OpenCode's requests -----------------------------------------------------------

  private withdraw(id: string): void {
    if (!id) return;
    for (const requestId of [id, ...Array.from({ length: 16 }, (_, i) => `${id}:q${i}`)]) {
      this.withdrawn.add(requestId);
      if (this.dialogs.answer(requestId, { kind: "cancel" })) this.emit({ type: "request_cancelled", requestId, outcome: "answered elsewhere" });
    }
  }

  private askPermission(p: Obj): void {
    const sessionId = this.sessionId;
    const id = str(p.id);
    if (!sessionId || !id) return;
    void this.dialogs.open(permissionCard(p)).then(async (answer) => {
      if (this.withdrawn.delete(id) || this.disposed) return;
      const decision = permissionReply(answer && answer.kind === "select" ? answer.value : null);
      await this.server
        .call("POST", `/api/session/${sessionId}/permission/${id}/reply`, { decision, ...(decision === "reject" ? { message: answer ? "Denied in awui" : "Cancelled in awui" } : {}) })
        .catch((error: unknown) => this.emit({ type: "notice", level: "error", text: `Could not answer OpenCode: ${error instanceof Error ? error.message : String(error)}` }));
    });
  }

  /** A form: one card per field, in turn; the answers go back together. */
  private async askForm(form: Obj): Promise<void> {
    const sessionId = this.sessionId;
    const id = str(form.id);
    if (!sessionId || !id) return;
    const answer: Record<string, unknown> = {};
    for (const q of formQuestions(form)) {
      const reply = await this.dialogs.open(q.request);
      if (this.withdrawn.has(id) || this.withdrawn.has(q.request.id) || this.disposed) return;
      if (!reply || reply.kind === "cancel") {
        await this.server.call("DELETE", `/api/session/${sessionId}/form/${id}`).catch(() => undefined);
        return;
      }
      const value = reply.kind === "confirm" ? reply.confirmed : reply.kind === "select" || reply.kind === "input" || reply.kind === "editor" ? reply.value : "";
      answer[q.key] = formValue(q, form, value);
    }
    await this.server
      .call("POST", `/api/session/${sessionId}/form/${id}/reply`, { answer })
      .catch((error: unknown) => this.emit({ type: "notice", level: "error", text: `Could not answer OpenCode: ${error instanceof Error ? error.message : String(error)}` }));
  }

  // ---- LiveChat -------------------------------------------------------------------------

  subscribe(listener: HarnessEventListener): () => void {
    return this.hub.subscribe(listener);
  }

  async history(): Promise<ChatItem[]> {
    if (!this.sessionId) return [];
    return this.adapter.items(await this.adapter.messages(this.sessionId));
  }

  private async currentModel(): Promise<ModelRef | null> {
    if (this.model) return this.model;
    const found = await this.server.call<{ data?: Obj }>("GET", `/api/model/default?${locationQuery(this.cwd)}`).catch(() => null);
    const data = found?.data;
    return isObj(data) && str(data.providerID) && str(data.id) ? { providerID: str(data.providerID), id: str(data.id) } : null;
  }

  async getConfig(): Promise<ChatConfig> {
    const [models, model] = await Promise.all([this.adapter.listModels(this.cwd).catch(() => [] as ModelInfo[]), this.currentModel()]);
    const key = model ? modelKey(model) : null;
    const levels = models.find((m) => m.key === key)?.levels ?? [];
    return { model: key, thinkingLevel: levelOf(model), models, thinkingLevels: levels };
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    const model = await this.currentModel();
    const window = model ? await this.adapter.contextWindow(this.cwd, `${model.providerID}/${model.id}`) : 0;
    if (!window) return null;
    return { tokens: this.lastTokens || null, window, percent: this.lastTokens ? (this.lastTokens / window) * 100 : null };
  }

  async getUsage(): Promise<HarnessUsage | null> {
    const u = this.usage;
    return { turns: u.turns, steps: u.steps, input: u.input, cachedInput: u.cachedInput, cacheWrite: u.cacheWrite, output: u.output, cost: u.cost > 0 ? u.cost : null };
  }

  async getTodos(): Promise<TodoItem[]> {
    return [...this.todos];
  }

  async listCommands(): Promise<SlashCommand[]> {
    if (this.commands) return this.commands;
    const found = await this.server.call<{ data?: unknown[] }>("GET", `/api/command?${locationQuery(this.cwd)}`).catch(() => null);
    this.commands = (found?.data ?? []).filter(isObj).flatMap((c) => (str(c.name) ? [{ name: str(c.name), ...(str(c.description) ? { description: str(c.description) } : {}), source: "command" }] : []));
    return this.commands;
  }

  /** A prompt into OpenCode's inbox; "/name args" runs a command OpenCode knows. */
  private async send(text: string, images: ImageAttachment[] | undefined, delivery: "steer" | "queue" | null): Promise<void> {
    const id = await this.ensureSession();
    // Before the turn, so the tools are in the session's set even after the server restarted.
    await this.wireTools();
    const files = filesOf(images);
    const slash = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
    const command = slash && (await this.listCommands()).some((c) => c.name === slash[1]) ? slash : null;
    if (command) {
      await this.server.call("POST", `/api/session/${id}/command`, { name: command[1], text: command[2] ?? "", ...(files.length ? { files } : {}), ...(delivery ? { delivery } : {}) });
      return;
    }
    await this.server.call("POST", `/api/session/${id}/prompt`, { text, ...(files.length ? { files } : {}), ...(delivery ? { delivery } : {}) });
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.send(text, images, null);
  }

  async steer(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.send(text, images, "steer");
  }

  async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.send(text, images, "queue");
  }

  /** Revert the session to before prompt `turn` (the conversation only), then run `text` in its place. */
  async rewind(turn: number, text: string, images?: ImageAttachment[]): Promise<void> {
    const id = await this.ensureSession();
    const target = promptIds(await this.adapter.messages(id))[turn - 1];
    if (!target) throw new Error("That message is no longer in the session");
    await this.server.call("POST", `/api/session/${id}/revert/stage`, { messageID: target, files: false });
    await this.server.call("POST", `/api/session/${id}/revert/commit`, {});
    this.usage.turns = Math.max(0, turn - 1);
    await this.send(text, images, null);
  }

  async abort(): Promise<void> {
    if (!this.sessionId) return;
    const settled = new Promise<void>((resolve) => {
      if (!this.running) return resolve();
      this.settledWaiters.push(resolve);
      setTimeout(resolve, ABORT_WAIT_MS).unref?.();
    });
    await this.server.call("POST", `/api/session/${this.sessionId}/interrupt`);
    await settled;
  }

  /** Take back every queued prompt and queue these instead (text only). */
  async replaceQueue(queue: QueueState): Promise<void> {
    const id = this.sessionId;
    if (!id) return;
    for (const inboxId of [...this.inbox.keys()]) {
      await this.server.call("DELETE", `/api/session/${id}/inbox/${inboxId}`).catch(() => undefined);
      this.inbox.delete(inboxId);
    }
    this.emitQueue();
    for (const text of queue.steering) await this.send(text, undefined, "steer");
    for (const text of queue.followUp) await this.send(text, undefined, "queue");
  }

  async setConfig(patch: { model?: string; thinkingLevel?: string }): Promise<void> {
    const current = await this.currentModel();
    const key = patch.model ?? (current ? `${current.providerID}/${current.id}` : null);
    if (!key) throw new Error("Choose a model first");
    // A new model starts at its default level unless one is asked for.
    const level = patch.thinkingLevel !== undefined ? patch.thinkingLevel || null : patch.model ? null : levelOf(current);
    const ref = refOf(key, level);
    if (!ref) throw new Error(`Unknown model ${key}`);
    if (this.sessionId) await this.server.call("POST", `/api/session/${this.sessionId}/model`, { model: ref });
    this.model = ref;
    this.emit({ type: "config", config: { model: key, thinkingLevel: level } });
  }

  async refreshModels(): Promise<void> {
    this.adapter.dropModelCache();
    this.commands = null;
  }

  async rename(name: string): Promise<void> {
    const id = await this.ensureSession();
    await this.server.call("PATCH", `/api/session/${id}`, { title: name });
    this.sessionTitle = name;
  }

  async compact(): Promise<void> {
    const id = await this.ensureSession();
    const done = new Promise<string | null>((resolve) => {
      this.compactWaiter = resolve;
    });
    await this.server.call("POST", `/api/session/${id}/compact`, {});
    const error = await done;
    if (error) throw new Error(error);
  }

  answer(requestId: string, answer: InteractionAnswer): boolean {
    return this.dialogs.answer(requestId, answer);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.dialogs.cancelAll();
    this.compactWaiter?.("Closed");
    this.compactWaiter = null;
    // As the other harnesses' children do when their chat closes: the run stops with it.
    if (this.running && this.sessionId) await this.server.call("POST", `/api/session/${this.sessionId}/interrupt`).catch(() => undefined);
    for (const resolve of this.settledWaiters.splice(0)) resolve();
    for (const child of this.children.values()) child.unsubscribe();
    this.children.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.stopWatchingExit?.();
    // Its rules stay on the session (an "always" answer does too); only our note of it goes.
    if (this.sessionId) this.adapter.forgetSession(this.sessionId);
    // awui's servers come off the shared one too, unless it is already gone: asking would
    // start a server just to delete from it, and a stopped server dropped them with its memory.
    if (this.toolServers && this.server.active()) {
      for (const server of this.toolServers.servers) {
        await this.server.call("DELETE", `/api/experimental/mcp/${encodeURIComponent(server.name)}?${locationQuery(this.cwd)}`).catch(() => undefined);
      }
    }
    this.hub.clear();
  }
}

export class OpenCodeAdapter implements HarnessAdapter {
  readonly id = asHarnessId("opencode");
  readonly displayName = "OpenCode";
  readonly setupCommand = "opencode auth login";
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
    supportsRewind: true,
    // awui's render_html MCP server is registered on the shared server for each chat, when a Node can run it.
    supportsHtmlRender: renderHtmlMcpServer() !== null && nodeForMcpServers() !== null,
    supportsQueueEdit: true,
    supportsPermissionMode: false,
    supportsResumeCommand: false,
    readOnlyHarness: false,
    supportsAccountSelection: false,
    jobsSurviveRestart: false,
    supportsProjectFolders: true,
    webOnly: false,
  };
  readonly server: OpenCodeServer;
  private modelCache = new Map<string, { at: number; models: ModelInfo[]; windows: Map<string, number>; defaultModel: { model: string; thinkingLevel: string | null } | null }>();
  /** Each live chat's session, with the tool rules its chat wrote there (null: it was given no tools). */
  private readonly chatSessions = new Map<string, OpenCodeRule[] | null>();
  private watchingSessions = false;

  constructor(private readonly options: OpenCodeOptions = {}) {
    this.cliCommand = options.command ?? (process.env.OPENCODE_BIN?.trim() || "opencode");
    this.server = new OpenCodeServer(this.cliCommand, () => ({ ...(this.options.env ?? process.env) }));
  }

  async discover(): Promise<HarnessDiscovery> {
    const overrides = { OPENCODE_CONFIG: (this.options.env ?? process.env).OPENCODE_CONFIG ? "set" : "unset" } as const;
    try {
      const { stdout } = await execHarness(this.cliCommand, ["--version"], { timeout: 15_000, env: this.options.env ?? process.env });
      const label = versionLabel(stdout);
      const major = Number(/(\d+)\./.exec(label.version)?.[1] ?? 0);
      if (major < 2) return { available: false, reason: `awui drives OpenCode 2's HTTP API; this is ${label.version}. Update OpenCode.`, warnings: [], overrides };
      return { available: true, ...label, warnings: [], overrides };
    } catch {
      return { available: false, reason: "The opencode CLI is not installed. Install OpenCode 2 and sign in to a provider with `opencode auth`.", warnings: [], overrides };
    }
  }

  workspaceProblem(): string | null {
    return null;
  }

  async resolveAgentDir(): Promise<string> {
    const env = this.options.env ?? process.env;
    return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode");
  }

  /** OpenCode keeps sessions in its own database, not per-project files. */
  async resolveSessionDir(): Promise<string> {
    const env = this.options.env ?? process.env;
    return path.join(env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"), "opencode");
  }

  async sessionInfo(id: string): Promise<Obj | null> {
    if (!/^ses_[A-Za-z0-9]+$/.test(id)) return null;
    const found = await this.server.call<{ data?: Obj }>("GET", `/api/session/${id}`).catch(() => null);
    return isObj(found?.data) ? found.data : null;
  }

  /** The session's messages, oldest first, a page at a time. */
  async messages(id: string): Promise<unknown[]> {
    const out: unknown[] = [];
    let cursor: string | null = null;
    while (out.length < MAX_MESSAGES) {
      const page: { data?: unknown[]; cursor?: { next?: unknown } } | null = await this.server.call("GET", `/api/session/${id}/message?order=asc&limit=${PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      const data = page?.data ?? [];
      out.push(...data);
      const next: unknown = isObj(page?.cursor) ? page.cursor.next : null;
      if (data.length < PAGE || typeof next !== "string" || !next) break;
      cursor = next;
    }
    return out;
  }

  private modelReads = new Map<string, Promise<{ models: ModelInfo[]; windows: Map<string, number>; defaultModel: { model: string; thinkingLevel: string | null } | null }>>();

  /** The list and the default are asked together (the start screen), so a read on its way is shared. */
  private models(cwd: string): Promise<{ models: ModelInfo[]; windows: Map<string, number>; defaultModel: { model: string; thinkingLevel: string | null } | null }> {
    const cached = this.modelCache.get(cwd);
    if (cached && Date.now() - cached.at < MODEL_CACHE_MS) return Promise.resolve(cached);
    const running = this.modelReads.get(cwd);
    if (running) return running;
    const read = this.readModels(cwd).finally(() => this.modelReads.delete(cwd));
    this.modelReads.set(cwd, read);
    return read;
  }

  private async readModels(cwd: string): Promise<{ models: ModelInfo[]; windows: Map<string, number>; defaultModel: { model: string; thinkingLevel: string | null } | null }> {
    // The default a new session there starts on is the server's own answer (a chat's currentModel asks the same).
    const [found, fallback] = await Promise.all([
      this.server.call<{ data?: unknown[] }>("GET", `/api/model?${locationQuery(cwd)}`),
      this.server.call<{ data?: unknown }>("GET", `/api/model/default?${locationQuery(cwd)}`).catch(() => null),
    ]);
    const key = modelKey(fallback?.data);
    const defaultModel = key ? { model: key, thinkingLevel: levelOf(fallback?.data) } : null;
    const models: ModelInfo[] = [];
    const windows = new Map<string, number>();
    for (const raw of found?.data ?? []) {
      const info = toModelInfo(raw);
      if (!info) continue;
      models.push(info);
      windows.set(info.key, contextWindow(raw));
    }
    if (this.modelCache.size > 50) this.modelCache.clear();
    const entry = { at: Date.now(), models, windows, defaultModel };
    this.modelCache.set(cwd, entry);
    return entry;
  }

  async listModels(cwd: string): Promise<ModelInfo[]> {
    return (await this.models(cwd)).models;
  }

  async defaultModel(cwd: string): Promise<{ model: string; thinkingLevel: string | null } | null> {
    return (await this.models(cwd)).defaultModel;
  }

  forgetModels(cwd: string): void {
    this.modelCache.delete(cwd);
  }

  async contextWindow(cwd: string, key: string): Promise<number> {
    return (await this.models(cwd).catch(() => null))?.windows.get(key) ?? 0;
  }

  dropModelCache(): void {
    this.modelCache.clear();
  }

  /** Levels are per model (its variants). */
  async listThinkingLevels(): Promise<string[]> {
    return [];
  }

  private summary(s: Obj): NativeSessionSummary {
    const time = isObj(s.time) ? s.time : {};
    const at = num(time.updated) || num(time.created);
    return { nativeId: str(s.id), title: str(s.title) || "Untitled", updatedAt: at ? new Date(at) : null };
  }

  async listSessions(cwd: string): Promise<NativeSessionSummary[]> {
    const found = await this.server.call<{ data?: unknown[] }>("GET", `/api/session?${locationQuery(cwd)}&parentID=null&limit=200`);
    const here = path.resolve(cwd);
    return (found?.data ?? [])
      .filter((s): s is Obj => isObj(s) && isObj(s.location) && path.resolve(str(s.location.directory)) === here && !str(s.parentID))
      .map((s) => this.summary(s));
  }

  async listRecentSessions(limit: number): Promise<RecentNativeSession[]> {
    const found = await this.server.call<{ data?: unknown[] }>("GET", `/api/session?parentID=null&limit=${Math.max(1, Math.min(limit, 200))}`);
    return (found?.data ?? [])
      .filter((s): s is Obj => isObj(s) && isObj(s.location) && Boolean(str(s.location.directory)) && !str(s.parentID))
      .map((s) => ({ ...this.summary(s), cwd: str((s.location as Obj).directory) }));
  }

  /** OpenCode's own fork, before the prompt after `throughTurns` (the whole session when there is none). */
  async forkSession(req: { cwd: string; nativeId: string; throughTurns: number }): Promise<{ nativeId: string }> {
    const info = await this.sessionInfo(req.nativeId);
    if (!info || path.resolve(str(isObj(info.location) ? info.location.directory : "")) !== path.resolve(req.cwd)) throw new Error("Session not found in this project's OpenCode sessions");
    const before = promptIds(await this.messages(req.nativeId))[req.throughTurns];
    const forked = await this.server.call<{ data?: Obj }>("POST", `/api/session/${req.nativeId}/fork`, before ? { before } : {});
    const id = str(forked?.data?.id);
    if (!id) throw new Error("OpenCode made no copy");
    return { nativeId: id };
  }

  async seedChat(): Promise<LiveChat> {
    throw new Error("OpenCode cannot take a handoff yet");
  }

  /** A subagent's conversation: its child session, when it is this chat's own. */
  async subagentTranscript(chat: { nativeId: string; cwd: string }, run: SubagentRun): Promise<ChatItem[] | null> {
    const info = await this.sessionInfo(run.id);
    if (!info || str(info.parentID) !== chat.nativeId) return null;
    return historyToItems(transcriptOf(await this.messages(run.id)));
  }

  /** The session's messages for this project, or null when it is another project's (or gone). */
  private async projectMessages(req: { cwd: string; nativeId: string }): Promise<{ info: Obj; messages: unknown[] } | null> {
    const info = await this.sessionInfo(req.nativeId);
    if (!info || path.resolve(str(isObj(info.location) ? info.location.directory : "")) !== path.resolve(req.cwd)) return null;
    return { info, messages: await this.messages(req.nativeId) };
  }

  async readTranscript(req: { cwd: string; nativeId: string }): Promise<{ items: ChatItem[]; title: string | null } | null> {
    const found = await this.projectMessages(req);
    return found ? { items: await this.items(found.messages), title: str(found.info.title) || null } : null;
  }

  /**
   * A session's messages as items, each subagent run filled in from its child
   * session (model, tokens, cost, time), which the call's own result does not
   * keep. At most 50 children are asked about, all at once.
   */
  async items(messages: unknown[]): Promise<ChatItem[]> {
    const transcript = transcriptOf(messages);
    const rows = transcript.flatMap((m) => (m.role === "toolResult" && isObj(m.details) && Array.isArray(m.details.results) ? m.details.results.filter(isObj) : [])).slice(0, 50);
    await Promise.all(
      rows.map(async (row) => {
        const info = await this.sessionInfo(str(row.id));
        if (!info) return;
        const t = isObj(info.tokens) ? info.tokens : {};
        const time = isObj(info.time) ? info.time : {};
        const model = modelKey(info.model);
        if (model && !row.model) row.model = model;
        const tokens = num(t.input) + num(t.output) + num(t.reasoning);
        if (tokens) row.tokens = tokens;
        if (num(info.cost)) row.cost = num(info.cost);
        if (num(time.created) && (num(time.idle) || num(time.updated))) row.durationMs = (num(time.idle) || num(time.updated)) - num(time.created);
      }),
    );
    return historyToItems(transcript);
  }

  async readUsage(req: { cwd: string; nativeId: string }): Promise<UsageEntry[] | null> {
    const found = await this.projectMessages(req);
    return found ? usageOf(found.messages) : null;
  }

  /**
   * A chat's session, and the rules its chat writes there. Recorded before the rules go on the wire,
   * so the guard below can tell a chat's own session from one OpenCode made by itself.
   */
  noteSession(sessionId: string, rules: OpenCodeRule[] | null): void {
    this.chatSessions.set(sessionId, rules);
    if (rules) this.watchCreatedSessions();
  }

  forgetSession(sessionId: string): void {
    this.chatSessions.delete(sessionId);
  }

  /**
   * One observer for the whole server. OpenCode's own task tool creates child sessions, and a client
   * of the server can make one too; a session with no permission rule allows every tool, so one awui
   * did not scope could call a chat's `awui-o-<id>_delegate_task` with that chat's token. Registered
   * the first time a chat is given awui's tools: with none on the server there is nothing to refuse.
   */
  private watchCreatedSessions(): void {
    if (this.watchingSessions) return;
    this.watchingSessions = true;
    this.server.onSessionCreated((sessionId, parentId) => void this.scopeCreatedSession(sessionId, parentId).catch(() => undefined));
  }

  /**
   * Scope a session no chat of ours opened. A child session keeps its parent's rules (OpenCode copies
   * them when it creates it, checked against 2.2.7), so a child of a chat gets that chat's pair —
   * its own tools still run — and anything else gets the bare deny.
   */
  private async scopeCreatedSession(sessionId: string, parentId: string): Promise<void> {
    // A chat that has awui's tools writes its own pair; its session is never touched here.
    if (this.chatSessions.get(sessionId)) return;
    const info = await this.sessionInfo(sessionId);
    // The chat may have registered its session while this read was on its way: its rules win.
    if (!info || this.chatSessions.get(sessionId)) return;
    const current = Array.isArray(info.permissions) ? info.permissions : [];
    // Already refusing awui's servers: a chat's pair, or a copy of its parent's (a grandchild inherits
    // through its own parent). Never narrowed here — an allow in there is a chat's own tools.
    if (deniesAwui(current)) return;
    // A chat opened without awui's tools is in the map with nothing: it still gets the bare deny, since
    // the servers another chat registered are on the same server for it too.
    const rules = (parentId ? this.chatSessions.get(parentId) : null) ?? [AWUI_DENY_RULE];
    const kept = current.filter((rule) => !isAwuiRule(rule));
    const wanted = [...kept, ...rules];
    if (sameRules(current, wanted)) return;
    await this.server.call("PATCH", `/api/session/${sessionId}`, { permissions: wanted });
  }

  async openChat(req: OpenChatRequest): Promise<LiveChat> {
    const chat = new OpenCodeChat(this, req.cwd, req.resumeNativeId ?? null, openCodeTools(req.toolEnv));
    await chat.start();
    return chat;
  }

  async shutdown(): Promise<void> {
    await this.server.stop();
  }
}
