// One live chat: owns the adapter's LiveChat, folds normalized harness events
// into display state, and fans out a replayable, monotonic event stream. The
// fold (EventReducer), the stream (EventLog), and model-call timing (Timing)
// are collaborators; Chat itself keeps the LiveChat binding and the commands.
import type {
  BackgroundJob,
  AssistantItem,
  ChainStep,
  ChatConfig,
  ChatEvent,
  ChatItem,
  ChatSnapshot,
  ChatStatus,
  ConfigPatch,
  ContextPoint,
  ContextUsage,
  ImageAttachment,
  ImageRef,
  InteractionAnswer,
  InteractionRequest,
  LimitAccount,
  PushNote,
  QueueState,
  SendMode,
  SessionUsage,
  SlashCommand,
  SubagentRun,
  TodoItem,
  ToolItem,
  WorkspaceInfo,
} from "../../shared/protocol.js";
import { MAX_CONTEXT_HISTORY } from "../../shared/protocol.js";
import { promises as fs } from "node:fs";
import { boundText, editShape, exitCodeOf, historyToItems, NO_RESULT_TEXT, stringifyArgs, toolCategory, toolPaths, toolSummary } from "../harness/agent-events.js";
import { argsDiff, resultDiff } from "../harness/tool-diff.js";
import { applyReports, detailReports, hasAgentCells, runsFromArgs, runsFromDetails, settleRuns, transcriptFile, transcriptRecords, type AgentReport } from "../harness/subagents.js";
import { applyJobReports, jobsFromCall, mergeJob } from "../harness/jobs.js";
import { htmlRenderRef, isHtmlRenderCall } from "../harness/render-token.js";
import { planFromArgs } from "../harness/plans.js";
import { branchMessages } from "../harness/session-files.js";
import { rememberImage } from "../image-store.js";
import type { HarnessAdapter, HarnessEvent, HarnessUsage, LiveChat } from "../harness/types.js";
import type { ChatCheckpoints, CheckpointHost } from "../checkpoints.js";
import { REWIND_COMMAND } from "../harness/rewind-extension.js";
import { CONTINUE_TEXT } from "../../shared/limit-stop.js";
import { noteChat, noteSessionOfChat } from "../overview-events.js";

export class ChatError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A chat opened from a transcript still carrying background jobs marked running. Jobs whose
 * process died with the last harness generation do not resume; mark them stopped so the
 * status stack does not keep them ticking. Harnesses whose jobs live outside the process
 * (Claude Code's task files) pass `survivesRestart` and keep their stored state.
 */
function reconcileLoadedJobs(item: ChatItem, survivesRestart: boolean): ChatItem {
  if (survivesRestart || item.kind !== "tool" || !item.jobs) return item;
  let changed = false;
  const jobs = item.jobs.map((job) => {
    if (job.status !== "running") return job;
    changed = true;
    return { ...job, status: "stopped" as const, endedAt: job.endedAt ?? Date.now() };
  });
  return changed ? { ...item, jobs } : item;
}

export interface ChatSubscriber {
  send(id: number, event: ChatEvent): void;
  close(): void;
}

/**
 * Who owns a chat besides the user: Board's rooms drive harness sessions
 * through the manager like any chat, marked so ordinary surfaces (session
 * lists, search, usage, notifications, resume) can keep them out. Server-only;
 * it never reaches the browser.
 */
export interface ChatOwner {
  kind: "room";
  roomId: string;
  membershipId: string;
}

/** Past this, a subagent transcript is read as its first and last halves. */
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

async function readEnds(file: string, size: number): Promise<string> {
  const half = MAX_TRANSCRIPT_BYTES / 2;
  const handle = await fs.open(file, "r");
  try {
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    await handle.read(head, 0, half, 0);
    await handle.read(tail, 0, half, size - half);
    // Cut lines are dropped by the JSONL readers.
    return `${head.toString("utf8")}\n${tail.toString("utf8")}`;
  } finally {
    await handle.close();
  }
}

const MAX_LOG_EVENTS = 5000;
const DELTA_FLUSH_MS = 30;
/** A change in the number of attached streams is announced after this long, so a reconnect (one leaves, one arrives) does not flicker. */
const VIEWERS_DEBOUNCE_MS = 1000;

const SETTLE_TIMEOUT_MS = 20_000;

export function namespacedSessionId(harnessId: string, nativeId: string | null): string | null {
  return nativeId ? `${harnessId}:${nativeId}` : null;
}

function describeAnswer(request: InteractionRequest, answer: InteractionAnswer): string {
  switch (answer.kind) {
    case "cancel":
      return "Dismissed";
    case "confirm":
      return answer.confirmed ? "Approved" : "Denied";
    case "select":
      return `Chose “${answer.value}”`;
    default:
      return request.kind === "editor" ? "Edited" : "Answered";
  }
}

/**
 * Model timing, measured from the stream because no harness reports it: a
 * call's request starts at the prompt or the last tool result (the hand-off),
 * its first token is its first delta, and it ends at assistant_end.
 */
class Timing {
  private handoffAt = 0;
  private requestAt = 0;
  private firstTokenAt = 0;
  private llmMs = 0;
  private ttftMs = 0;
  private ttftCount = 0;
  private genMs = 0;
  private genTokens = 0;

  /** Close the previous hand-off: the next call's request starts here. */
  markHandoff(at = Date.now()): void {
    this.handoffAt = at;
  }

  /** A model call begins; time-to-first-token is measured once per call. */
  startRequest(at = Date.now()): void {
    this.requestAt = this.handoffAt || at;
    this.firstTokenAt = 0;
  }

  firstToken(at = Date.now()): void {
    if (!this.requestAt || this.firstTokenAt) return;
    this.firstTokenAt = at;
    this.ttftMs += at - this.requestAt;
    this.ttftCount += 1;
  }

  /** Close the current model call; `outputTokens` feeds tokens per second. */
  endStep(outputTokens: number, at = Date.now()): void {
    if (!this.requestAt) return;
    this.llmMs += at - this.requestAt;
    if (this.firstTokenAt && outputTokens > 0 && at > this.firstTokenAt) {
      this.genMs += at - this.firstTokenAt;
      this.genTokens += outputTokens;
    }
    this.requestAt = 0;
    this.firstTokenAt = 0;
    this.handoffAt = at;
  }

  /** The harness's usage plus the timing it never reports. */
  compose(harness: HarnessUsage | null): SessionUsage | null {
    if (!harness) return null;
    return {
      ...harness,
      llmMs: this.llmMs > 0 ? this.llmMs : null,
      ttftMs: this.ttftCount > 0 ? Math.round(this.ttftMs / this.ttftCount) : null,
      tokensPerSecond: this.genMs > 0 ? Math.round((this.genTokens / this.genMs) * 1000) : null,
    };
  }
}

/**
 * The replayable, monotonic ChatEvent stream: event ids, fan-out to
 * subscribers, and the replay window that lets a reconnecting stream catch up.
 */
export class EventLog {
  private entries: Array<{ id: number; event: ChatEvent }> = [];
  private nextEventId = 1;
  private subscribers = new Set<ChatSubscriber>();

  get lastEventId(): number {
    return this.nextEventId - 1;
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }

  record(event: ChatEvent): void {
    const id = this.nextEventId++;
    // A snapshot stands for everything before it, and each one copies every item:
    // keep only the newest, so the log holds at most one copy of the chat.
    // A stream further behind than it is sent a fresh snapshot, which is the same thing.
    if (event.type === "snapshot") this.entries = [];
    this.entries.push({ id, event });
    if (this.entries.length > MAX_LOG_EVENTS) this.entries.splice(0, this.entries.length - MAX_LOG_EVENTS);
    for (const s of this.subscribers) s.send(id, event);
  }

  /**
   * Subscribe a stream. With a lastEventId still inside the replay window the
   * missed events are replayed; otherwise the subscriber gets a fresh snapshot.
   */
  subscribe(subscriber: ChatSubscriber, lastEventId: number | undefined, snapshot: () => ChatSnapshot): () => void {
    const oldest = this.entries[0]?.id ?? this.nextEventId;
    const canReplay = lastEventId !== undefined && lastEventId >= oldest - 1 && lastEventId <= this.nextEventId - 1;
    if (canReplay) {
      for (const entry of this.entries) if (entry.id > lastEventId) subscriber.send(entry.id, entry.event);
    } else {
      subscriber.send(this.nextEventId - 1, { type: "snapshot", snapshot: snapshot() });
    }
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Close every subscriber; the chat is going away. */
  closeAll(): void {
    for (const s of this.subscribers) s.close();
    this.subscribers.clear();
  }
}

/** What the event fold asks of the Chat around it: its side effects. */
interface ReducerEffects {
  /** The chat's current status (guards status transitions and notice ambience). */
  status(): ChatStatus;
  /** Move to a new status; the Chat emits the event and wakes settle waiters. */
  setStatus(status: ChatStatus): void;
  /** Re-read a derived view from the harness (best-effort). */
  refreshContext(): void;
  refreshUsage(): void;
  refreshTodos(): void;
  /** A session id arrived from the harness: tell the manager. */
  sessionAssigned(): void;
}

/**
 * The event fold: normalized harness events into display state (items, queue,
 * pending requests, config, title, …) and the outbound ChatEvent stream, with
 * deltas coalesced per item/field and tool updates throttled to the next
 * flush. Side effects — status changes, refreshes, the manager hook — go
 * through `fx`; everything else lives and dies here.
 */
class EventReducer {
  items: ChatItem[] = [];
  queue: QueueState = { steering: [], followUp: [] };
  extensionStatus: Record<string, string> = {};
  title = "";
  nativeId: string | null;
  config: ChatConfig;

  private index = new Map<string, number>();
  private pending = new Map<string, InteractionRequest>();
  /** Running calls that are the render tool, decided from their raw args at tool_start. */
  private renderCalls = new Set<string>();
  /** Each running call's raw arguments: a background job's start is read from them with its result. */
  private toolArgs = new Map<string, unknown>();
  private counter = 0;
  private currentAssistant: string | null = null;
  private currentModel: string | undefined;
  private pendingDeltas: Array<{ itemId: string; field: "text" | "thinking" | "output"; append: string }> = [];
  private dirtyTools = new Set<string>();
  /** How many times the harness has said a run is going: a rejected prompt reads it to know the run is. */
  private busySignals = 0;
  /** A harness can compact the context inside a run and carry on; this remembers the run was going. */
  private ranBeforeCompact = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly log: EventLog,
    private readonly timing: Timing,
    private readonly harnessId: HarnessAdapter["id"],
    config: ChatConfig,
    nativeId: string | null,
    private readonly fx: ReducerEffects,
  ) {
    this.config = config;
    this.nativeId = nativeId;
  }

  get sessionId(): string | null {
    return namespacedSessionId(this.harnessId, this.nativeId);
  }

  /** Counts the harness saying a run is going (its `busy`), so a rejected prompt can tell. */
  busyCount(): number {
    return this.busySignals;
  }
  /** Drop user turn `turn` (1-based, commands not counted) and every item after it. */
  truncateBeforeUserTurn(turn: number): void {
    this.finishStreaming();
    let seen = 0;
    const cut = this.items.findIndex((i) => i.kind === "user" && !i.command && ++seen === turn);
    if (cut < 0) return;
    this.items = this.items.slice(0, cut);
    this.index = new Map(this.items.map((item, i) => [item.id, i]));
    this.currentAssistant = null;
    this.dirtyTools.clear();
  }

  /** Seed from the harness's stored history: its items and the title it knows. */
  load(items: ChatItem[], title: string | null): void {
    for (const item of items) {
      this.upsert(item);
      this.noteLoadedId(item.id);
    }
    this.title = title ?? this.firstUserText() ?? "";
  }

  /**
   * History rows use the same `u1` / `a2` / `n3` ids `nextId` mints, and the
   * counter starts at zero. A prompt sent after a resume would otherwise reuse
   * `u1` and overwrite the first message in place, and the new thought would
   * land in the first assistant row, above that turn's tool calls.
   */
  private noteLoadedId(id: string): void {
    const match = /^[uan](\d+)$/.exec(id);
    if (!match) return;
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > this.counter) this.counter = n;
  }

  apply(event: HarnessEvent): void {
    switch (event.type) {
      case "user_message":
        this.finishStreaming();
        this.put({
          kind: "user",
          id: this.nextId("u"),
          text: event.text,
          ...(event.imageCount ? { imageCount: event.imageCount } : {}),
          ...(event.images?.length ? { images: event.images } : {}),
          ...(event.command ? { command: true as const } : {}),
          at: Date.now(),
        });
        if (!this.title && !event.command) this.setTitle(event.text.slice(0, 80));
        break;
      case "assistant_start":
        this.finishStreaming();
        this.currentModel = event.model;
        this.timing.startRequest();
        break;
      case "assistant_delta": {
        this.timing.firstToken();
        const item = this.ensureAssistant();
        item[event.field] += event.delta;
        this.pendingDeltas.push({ itemId: item.id, field: event.field, append: event.delta });
        this.scheduleFlush();
        break;
      }
      case "assistant_end": {
        this.timing.endStep(event.usage?.output ?? 0);
        const existing = this.currentAssistant ? this.get(this.currentAssistant) : undefined;
        if (!existing && !event.text && !event.thinking && !event.error) {
          this.currentAssistant = null;
          break;
        }
        const item = existing && existing.kind === "assistant" ? existing : this.ensureAssistant();
        this.put({
          ...item,
          text: event.text || item.text,
          thinking: event.thinking || item.thinking,
          streaming: false,
          endedAt: Date.now(),
          ...(event.error ? { error: event.error } : {}),
        });
        this.currentAssistant = null;
        break;
      }
      case "tool_start": {
        this.finishStreaming();
        const category = toolCategory(event.name);
        const edits = category === "edit" || category === "write";
        const runs = category === "agent" ? runsFromArgs(event.args) : null;
        const plan = planFromArgs(event.name, event.args);
        const tool: ToolItem = {
          kind: "tool",
          id: `t:${event.toolCallId}`,
          name: event.name,
          args: stringifyArgs(event.args, category === "edit"),
          status: "running",
          output: "",
          truncated: false,
          category,
          summary: toolSummary(event.args, event.name),
          paths: toolPaths(event.args),
          ...(edits ? editShape(argsDiff(event.args), null) : {}),
          ...(runs ? { subagents: runs } : {}),
          ...(plan ? { plan } : {}),
          at: Date.now(),
        };
        if (isHtmlRenderCall(event.name, event.args)) this.renderCalls.add(event.toolCallId);
        this.toolArgs.set(event.toolCallId, event.args);
        this.put(tool);
        break;
      }
      case "tool_update": {
        const item = this.get(`t:${event.toolCallId}`);
        if (!item || item.kind !== "tool") break;
        // A subagent report after the call has returned must not wipe that result.
        const bounded = event.keepOutput ? null : boundText(event.output);
        // Subagent progress replaces the last snapshot (it is not a patch). An eval
        // call is not a delegation tool, but its cells carry the agents they spawned.
        const runs = event.details !== undefined && (item.category === "agent" || hasAgentCells(event.details)) ? runsFromDetails(event.toolCallId, event.details, item.subagents ?? null) : null;
        // A wait streams the jobs it waits on: their status, and omp's widget of their progress.
        const jobs = event.details !== undefined ? this.callJobs(item, event.details, event.keepOutput ? item.output : event.output) : null;
        this.upsert({ ...item, ...(bounded ? { output: bounded.text, truncated: bounded.truncated } : {}), ...(runs ? { subagents: runs } : {}), ...(jobs ? { jobs } : {}) });
        this.dirtyTools.add(item.id);
        this.scheduleFlush();
        break;
      }
      case "tool_end": {
        this.timing.markHandoff();
        const id = `t:${event.toolCallId}`;
        this.dirtyTools.delete(id);
        const item = this.get(id);
        const bounded = boundText(event.output);
        const base: ToolItem =
          item && item.kind === "tool"
            ? item
            : {
                kind: "tool",
                id,
                name: "tool",
                args: "",
                status: "running",
                output: "",
                truncated: false,
                category: "other",
                summary: "",
                paths: [],
              };
        const edits = base.category === "edit" || base.category === "write";
        // The harness's own diff beats the arguments' one; with neither, its output's own count.
        const reported = edits ? resultDiff(event.details, event.output) : null;
        const settled: ToolItem = { ...base, ...(!edits ? {} : reported ? editShape(reported, null) : base.diff ? {} : editShape(null, bounded.text)) };
        if (settled.category === "agent" || (event.details !== undefined && hasAgentCells(event.details))) {
          const runs = runsFromDetails(event.toolCallId, event.details, settled.subagents ?? null);
          if (runs) settled.subagents = settleRuns(runs, event.output, event.isError);
        }
        // A render call publishes a page; its result's details carry the reference.
        const page = this.renderCalls.delete(event.toolCallId) ? htmlRenderRef(event.details) : undefined;
        // A failed edit keeps the diff it tried, but changed nothing to count.
        const { diffStat: _attempted, ...uncounted } = settled;
        // A shell call's exit rides on the item when the harness reported one (OpenCode does).
        const exitCode = settled.category === "command" ? exitCodeOf(event.details) : null;
        const jobs = this.callJobs(base, event.details, event.output);
        this.toolArgs.delete(event.toolCallId);
        this.put({
          ...(event.isError ? uncounted : settled),
          output: bounded.text,
          truncated: bounded.truncated,
          status: event.isError ? "error" : "done",
          endedAt: Date.now(),
          ...(page ? { htmlRender: page } : {}),
          ...(exitCode !== null ? { exitCode } : {}),
          ...(jobs ? { jobs } : {}),
          ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
        });
        // A wait that saw a job end tells the call that started it too.
        if (jobs) this.applyJobReports(jobs.filter((j) => j.status !== "running"));
        if (base.name.toLowerCase().includes("todo")) this.fx.refreshTodos();
        // A wait or a proc read reports on background runs another call started.
        const reports = detailReports(event.details);
        if (reports.length > 0) this.applyReports(reports);
        break;
      }
      case "subagent_reports":
        this.applyReports(event.reports);
        break;
      case "job_reports":
        this.applyJobReports(event.jobs);
        break;
      case "busy":
        this.busySignals++;
        if (this.fx.status() !== "stopping") this.fx.setStatus("running");
        break;
      case "settled":
        this.finishStreaming();
        this.closeRunningTools();
        this.ranBeforeCompact = false;
        if (this.fx.status() !== "error") this.fx.setStatus("idle");
        this.fx.refreshContext();
        this.fx.refreshUsage();
        this.fx.refreshTodos();
        break;
      case "compacting":
        if (event.active) {
          // pi compacts the context inside a run and carries on with it: remember the run was going,
          // since it sends no second start when the compaction ends.
          const at = this.fx.status();
          if (at !== "compacting") this.ranBeforeCompact = at === "running";
          this.fx.setStatus("compacting");
        } else {
          if (this.fx.status() === "compacting") this.fx.setStatus(this.ranBeforeCompact ? "running" : "idle");
          this.ranBeforeCompact = false;
          this.fx.refreshContext();
        }
        break;
      case "queue":
        this.queue = { steering: [...event.queue.steering], followUp: [...event.queue.followUp] };
        this.emit({ type: "queue", queue: this.queue });
        break;
      case "notice":
        this.notice(event.level, event.text, event.ambient, { ...(event.title ? { title: event.title } : {}), ...(event.detail ? { detail: event.detail } : {}), ...(event.detailFormat ? { detailFormat: event.detailFormat } : {}) });
        break;
      case "config":
        this.config = { ...this.config, ...event.config };
        this.emit({ type: "config", config: this.config });
        break;
      case "title":
        this.setTitle(event.title);
        break;
      case "session":
        if (this.nativeId !== event.nativeId) {
          this.nativeId = event.nativeId;
          this.fx.sessionAssigned();
          this.emit({ type: "title", title: this.title, sessionId: this.sessionId });
        }
        break;
      case "request":
        this.pending.set(event.request.id, event.request);
        this.put({ kind: "request", id: `r:${event.request.id}`, request: event.request });
        this.emit({ type: "request", request: event.request });
        break;
      case "request_cancelled":
        this.resolveRequest(event.requestId, event.outcome === "cancelled" ? "Cancelled" : event.outcome);
        break;
      case "extension_status":
        if (event.text === null) delete this.extensionStatus[event.key];
        else this.extensionStatus[event.key] = event.text;
        this.emit({ type: "extension_status", key: event.key, text: event.text });
        break;
      case "fatal":
        this.finishStreaming();
        for (const id of [...this.pending.keys()]) this.resolveRequest(id, "Cancelled");
        this.notice("error", event.message);
        this.fx.setStatus("error");
        break;
    }
  }

  /** Coalesce deltas per item/field and throttled tool updates into few events. */
  flushNow(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const deltas = this.pendingDeltas;
    this.pendingDeltas = [];
    for (const d of deltas) this.log.record({ type: "delta", ...d });
    const tools = [...this.dirtyTools];
    this.dirtyTools.clear();
    for (const id of tools) {
      const item = this.get(id);
      if (item) this.log.record({ type: "item", item: { ...item } });
    }
  }

  emit(event: ChatEvent): void {
    if (event.type !== "delta") this.flushNow();
    this.log.record(event);
  }

  notice(level: "info" | "warning" | "error", text: string, ambient?: boolean, more: { title?: string; detail?: string; detailFormat?: "markdown" } = {}): void {
    const status = this.fx.status();
    const busy = status === "running" || status === "stopping" || status === "compacting";
    const between = ambient ?? !busy;
    this.put({
      kind: "notice",
      id: this.nextId("n"),
      level,
      text,
      ...(more.title ? { title: more.title } : {}),
      ...(more.detail ? { detail: more.detail } : {}),
      ...(more.detailFormat ? { detailFormat: more.detailFormat } : {}),
      at: Date.now(),
      ...(between ? { ambient: true } : {}),
    });
  }

  setTitle(title: string): void {
    this.title = title;
    this.emit({ type: "title", title, sessionId: this.sessionId });
  }

  replaceConfig(config: ChatConfig): void {
    this.config = config;
    this.emit({ type: "config", config });
  }

  /** The jobs a call started or looked at, a started one stamped with its call's time. */
  private callJobs(item: ToolItem, details: unknown, output: string): BackgroundJob[] | null {
    const id = item.id.slice(2);
    const jobs = jobsFromCall(item.name, this.toolArgs.get(id), details, output);
    if (!jobs) return null;
    return jobs.map((j) => {
      const prior = item.jobs?.find((p) => p.id === j.id);
      const merged = prior ? mergeJob(prior, j) : j;
      return merged.status === "running" && merged.startedAt === undefined && item.at !== undefined ? { ...merged, startedAt: item.at } : merged;
    });
  }

  /** Background jobs reporting in: every call holding one shows how it stands now. */
  private applyJobReports(reports: BackgroundJob[]): void {
    if (reports.length === 0) return;
    const at = Date.now();
    for (const item of this.items) {
      if (item.kind !== "tool" || !item.jobs) continue;
      const next = applyJobReports(item.jobs, reports, at);
      if (next) this.put({ ...item, jobs: next });
    }
  }

  /** Background runs reporting in: the call that started them shows it. */
  private applyReports(reports: AgentReport[]): void {
    for (const item of this.items) {
      if (item.kind !== "tool" || !item.subagents) continue;
      const next = applyReports(item.subagents, reports);
      if (next) this.put({ ...item, subagents: next });
    }
  }

  item(id: string): ChatItem | undefined {
    return this.get(id);
  }

  pendingIds(): string[] {
    return [...this.pending.keys()];
  }

  pendingRequest(requestId: string): InteractionRequest | undefined {
    return this.pending.get(requestId);
  }

  pendingRequests(): InteractionRequest[] {
    return [...this.pending.values()];
  }

  resolveRequest(requestId: string, outcome: string): void {
    const request = this.pending.get(requestId);
    if (!request) return;
    this.pending.delete(requestId);
    this.put({ kind: "request", id: `r:${requestId}`, request, outcome });
    this.emit({ type: "request_resolved", requestId, outcome });
  }

  private firstUserText(): string | null {
    const first = this.items.find((i) => i.kind === "user");
    return first && first.kind === "user" ? first.text.slice(0, 80) : null;
  }

  private scheduleFlush(): void {
    if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushNow(), DELTA_FLUSH_MS);
  }

  private get(id: string): ChatItem | undefined {
    const i = this.index.get(id);
    return i === undefined ? undefined : this.items[i];
  }

  private upsert(item: ChatItem): void {
    const i = this.index.get(item.id);
    if (i === undefined) {
      this.index.set(item.id, this.items.length);
      this.items.push(item);
    } else {
      this.items[i] = item;
    }
  }

  private put(item: ChatItem): void {
    this.upsert(item);
    this.emit({ type: "item", item: { ...item } });
  }

  private nextId(prefix: string): string {
    return `${prefix}${++this.counter}`;
  }

  private ensureAssistant(): AssistantItem {
    const current = this.currentAssistant ? this.get(this.currentAssistant) : undefined;
    if (current && current.kind === "assistant") return current;
    const item: AssistantItem = {
      kind: "assistant",
      id: this.nextId("a"),
      text: "",
      thinking: "",
      streaming: true,
      at: Date.now(),
      ...(this.currentModel ? { model: this.currentModel } : {}),
    };
    this.currentAssistant = item.id;
    this.put(item);
    return item;
  }

  private finishStreaming(): void {
    const current = this.currentAssistant ? this.get(this.currentAssistant) : undefined;
    if (current && current.kind === "assistant" && current.streaming) this.put({ ...current, streaming: false, endedAt: Date.now() });
    this.currentAssistant = null;
  }

  /**
   * A run that ends with calls still open leaves no spinner: a cancelled question, or a
   * harness that lost the result, must read as ended once it says the run is over.
   * The same for a task (subagent) a call reported running: its progress comes through the
   * run loop of the session that settled, so with the run over it can never report again.
   * A shell job is not touched: a backgrounded command can still be alive past the settle.
   */
  closeRunningTools(note = NO_RESULT_TEXT): void {
    const now = Date.now();
    for (const item of this.items) {
      if (item.kind !== "tool") continue;
      const orphanedJobs = item.jobs?.some((j) => j.kind === "task" && j.status === "running") ?? false;
      if (item.status !== "running" && !orphanedJobs) continue;
      this.put({
        ...item,
        ...(item.status === "running" ? { status: "done", output: item.output || note, endedAt: item.endedAt ?? now } : {}),
        ...(orphanedJobs ? { jobs: item.jobs!.map((j) => (j.kind === "task" && j.status === "running" ? { ...j, status: "stopped" as const, endedAt: now } : j)) } : {}),
      });
    }
  }
}

export class Chat implements CheckpointHost {
  readonly createdAt = Date.now();
  status: ChatStatus = "idle";
  generation = 0;
  /** Last real conversation (a prompt sent, a turn finished): sidebar order. */
  lastActivity = Date.now();
  /** When someone last talked in it here (a prompt sent, a turn finished); null until then. */
  talkedAt: number | null = null;
  /** Last sign of use of any kind (events, sends, a viewer leaving): what the reaper's idle clock reads. */
  lastSeen = Date.now();
  onSession?: (chat: Chat) => void;
  onDisposed?: (chat: Chat) => void;
  /** The harness reported its subscription limits. */
  onLimits?: (account: LimitAccount) => void;
  /** A run finished or failed, or the agent asks for an answer: news for devices that want it. */
  onNews?: (chat: Chat, kind: PushNote["kind"], body: string, request?: InteractionRequest) => void;
  /** A run started. */
  onRunStart?: (chat: Chat) => void;
  /** A chain's handoff step: the app moves this chat to another harness, `rest` of the chain with it. */
  onChainHandoff?: (chat: Chat, step: Extract<ChainStep, { kind: "handoff" }>, rest: ChainStep[]) => Promise<void>;
  /** Set while a status change is not news (a prompt the harness refused). */
  private quiet = false;
  /** File checkpoints before each prompt, where the project is in a git repository. */
  checkpoints?: ChatCheckpoints;
  private checkpointTurns: number[] = [];
  /** What runs after this run settles on its own, step by step; kept here, so it goes on with no browser open (not across a restart). */
  private chain: ChainStep[] = [];
  /** Why the chain waits: a run was stopped, or failed, or a step could not start. */
  private chainPaused: string | null = null;
  /** When the user asked this chat to carry on after a usage limit resets; the timer is the server's, so it fires with no browser open. */
  continueAt: number | null = null;
  private continueTimer?: NodeJS.Timeout;
  /**
   * Where this chat's render_html/MCP tool publishes pages. Set by the manager once,
   * before the harness child is spawned; carries the random token this chat's child
   * posts back as `renderToken`, minted here so the child env and the lookup agree.
   */
  render?: { token: string; baseUrl: string };
  /**
   * Where this chat's child calls its orchestration tools, and the token that names this
   * chat. Minted with the spawn and stamped by the manager; it expires (a resume mints a
   * new one) and is never persisted, so a restart drops it.
   */
  orchestration?: { token: string; baseUrl: string; expiresAt: number };

  private readonly log = new EventLog();
  private readonly timing = new Timing();
  private readonly reducer: EventReducer;
  private context: ContextUsage | null = null;
  private contextHistory: ContextPoint[] = [];
  /** The viewer count last announced to clients, and the timer that will announce a newer one. */
  private viewers = 0;
  private viewersTimer: ReturnType<typeof setTimeout> | null = null;
  private usage: SessionUsage | null = null;
  private todos: TodoItem[] = [];
  private settleWaiters: Array<() => void> = [];
  private unsubscribe: (() => void) | null = null;
  private readonly live: LiveChat;

  private constructor(
    readonly chatId: string,
    readonly adapter: HarnessAdapter,
    readonly workspace: WorkspaceInfo,
    live: LiveChat,
    config: ChatConfig,
    /** Set for internally owned chats (Board rooms): server-only, never serialized. */
    readonly owner?: ChatOwner,
  ) {
    this.live = live;
    this.reducer = new EventReducer(this.log, this.timing, adapter.id, config, live.nativeId, {
      status: () => this.status,
      setStatus: (status) => this.setStatus(status),
      refreshContext: () => void this.refreshContext(),
      refreshUsage: () => void this.refreshUsage(),
      refreshTodos: () => void this.refreshTodos(),
      sessionAssigned: () => {
        this.onSession?.(this);
        this.checkpoints?.sessionAssigned();
      },
    });
  }

  static async open(chatId: string, adapter: HarnessAdapter, workspace: WorkspaceInfo, live: LiveChat, owner?: ChatOwner): Promise<Chat> {
    const [items, config, context, usage, todos] = await Promise.all([
      live.history(),
      live.getConfig(),
      live.getContextUsage().catch(() => null),
      live.getUsage().catch(() => null),
      live.getTodos().catch(() => []),
    ]);
    const chat = new Chat(chatId, adapter, workspace, live, config, owner);
    if (live.starting) chat.status = "starting";
    chat.context = context;
    chat.noteContext(context);
    chat.usage = chat.timing.compose(usage);
    chat.todos = todos;
    chat.reducer.load(items.map((item) => reconcileLoadedJobs(item, adapter.capabilities.jobsSurviveRestart)), live.title);
    // A resumed old chat keeps its stored recency until someone talks in it;
    // only a brand-new (empty) history starts at now.
    let latest: number | null = null;
    for (const i of items) {
      const at = i.at ?? (i.kind === "assistant" || i.kind === "tool" ? i.endedAt : undefined) ?? null;
      if (at !== null && (latest === null || at > latest)) latest = at;
    }
    chat.lastActivity = latest ?? Date.now();
    chat.attach();
    return chat;
  }

  get harnessId() {
    return this.adapter.id;
  }

  get sessionId(): string | null {
    return this.reducer.sessionId;
  }

  get nativeId(): string | null {
    return this.reducer.nativeId;
  }

  get title(): string {
    return this.reducer.title;
  }

  /** Requests waiting on an answer. */
  get pendingCount(): number {
    return this.reducer.pendingIds().length;
  }

  get subscriberCount(): number {
    return this.log.subscriberCount;
  }

  /** Bind to the LiveChat; events from a previous binding are dropped. */
  private attach(): void {
    this.unsubscribe?.();
    const generation = ++this.generation;
    this.unsubscribe = this.live.subscribe((event) => {
      if (generation !== this.generation) return;
      this.apply(event);
    });
  }

  /** Whether one of this chat's tool calls published the page `id`: what lets the chat serve it. */
  ownsHtmlRender(id: string): boolean {
    return this.reducer.items.some((i) => i.kind === "tool" && i.htmlRender?.id === id);
  }

  snapshot(): ChatSnapshot {
    this.reducer.flushNow();
    return {
      chatId: this.chatId,
      harnessId: this.adapter.id,
      sessionId: this.sessionId,
      workspace: this.workspace,
      title: this.title,
      status: this.status,
      items: this.reducer.items.map((i) => ({ ...i })),
      queue: { steering: [...this.reducer.queue.steering], followUp: [...this.reducer.queue.followUp] },
      pending: this.reducer.pendingRequests(),
      config: this.reducer.config,
      capabilities: this.adapter.capabilities,
      extensionStatus: { ...this.reducer.extensionStatus },
      context: this.context,
      usage: this.usage,
      todos: [...this.todos],
      checkpoints: [...this.checkpointTurns],
      chain: this.chain.map((s) => ({ ...s })),
      chainPaused: this.chainPaused,
      continueAt: this.continueAt,
      viewers: this.viewers,
      contextHistory: [...this.contextHistory],
      generation: this.generation,
      lastEventId: this.log.lastEventId,
    };
  }

  /**
   * Subscribe a stream. With a lastEventId still inside the replay window the
   * missed events are replayed; otherwise the subscriber gets a fresh snapshot.
   */
  subscribe(subscriber: ChatSubscriber, lastEventId?: number): () => void {
    this.reducer.flushNow();
    this.lastSeen = Date.now();
    const unsubscribe = this.log.subscribe(subscriber, lastEventId, () => this.snapshot());
    this.noteViewers();
    return () => {
      // The idle clock starts when the last viewer leaves, not at the last message.
      this.lastSeen = Date.now();
      unsubscribe();
      this.noteViewers();
    };
  }

  /** Announce the subscriber count a second after it last changed, and only if it ended up different from what clients were told. */
  private noteViewers(): void {
    if (this.viewersTimer || this.status === "disposed") return;
    this.viewersTimer = setTimeout(() => {
      this.viewersTimer = null;
      const count = this.log.subscriberCount;
      if (count === this.viewers || this.status === "disposed") return;
      this.viewers = count;
      this.reducer.emit({ type: "viewers", viewers: count });
    }, VIEWERS_DEBOUNCE_MS);
    this.viewersTimer.unref();
  }

  /** Remember a context reading for the sparkline, keeping the newest MAX_CONTEXT_HISTORY. */
  private noteContext(context: ContextUsage | null): void {
    if (!context || (context.percent === null && context.tokens === null)) return;
    this.contextHistory.push({ percent: context.percent, tokens: context.tokens });
    if (this.contextHistory.length > MAX_CONTEXT_HISTORY) this.contextHistory.splice(0, this.contextHistory.length - MAX_CONTEXT_HISTORY);
  }

  /** The context readings kept so far (a copy). */
  get contextReadings(): ContextPoint[] {
    return [...this.contextHistory];
  }

  apply(event: HarnessEvent): void {
    if (event.type === "limits") {
      this.onLimits?.(event.account);
      return;
    }
    if (event.type === "request") this.onNews?.(this, "ask", event.request.title, event.request);
    // Viewing must not promote the chat: only real conversation (a prompt sent
    // or a turn finished) counts as activity for sidebar ordering. Replay on
    // open, status flaps, config/title/usage refreshes all stay quiet.
    if (event.type === "user_message" || event.type === "assistant_end") this.lastActivity = this.talkedAt = Date.now();
    this.lastSeen = Date.now();
    this.reducer.apply(event.type === "user_message" ? this.withSentImages(event) : event);
    if (event.type === "user_message" || event.type === "session" || event.type === "title" || event.type === "request" || event.type === "request_cancelled") noteChat(this);
    if (event.type === "session") noteSessionOfChat(this);
    if (event.type === "user_message") this.checkpoints?.onUserTurn(event.text, event.command === true);
  }

  /**
   * Images sent from here, oldest first, until the harness echoes their prompt.
   * Most harnesses echo only a count; the prompt then gets the images it was sent with.
   */
  private sentImages: ImageRef[][] = [];

  private withSentImages(event: Extract<HarnessEvent, { type: "user_message" }>): HarnessEvent {
    if (!event.imageCount) return event;
    const at = this.sentImages.findIndex((refs) => refs.length === event.imageCount);
    const sent = at >= 0 ? this.sentImages.splice(at, 1)[0] : undefined;
    return event.images?.length || !sent ? event : { ...event, images: sent };
  }

  userTurns(): string[] {
    return this.reducer.items.flatMap((i) => (i.kind === "user" && !i.command ? [i.text] : []));
  }

  setCheckpointTurns(turns: number[]): void {
    if (turns.length === this.checkpointTurns.length && turns.every((t, i) => t === this.checkpointTurns[i])) return;
    this.checkpointTurns = turns;
    this.reducer.emit({ type: "checkpoints", turns: [...turns] });
  }

  private setStatus(status: ChatStatus): void {
    if (this.status === status || this.status === "disposed") return;
    const before = this.status;
    this.status = status;
    this.reducer.emit({ type: "status", status });
    noteChat(this);
    if (status === "running") this.onRunStart?.(this);
    // A run that ends on its own moves the chain on; one that fails stops it until you say.
    if (!this.quiet && before === "running" && status === "idle") this.chainSoon();
    else if (status === "error" && before !== "starting") this.pauseChain("The run failed");
    // A run that ends on its own is news; one stopped from here is not.
    if (!this.quiet && before === "running" && status === "idle") this.onNews?.(this, "done", this.lastLine("assistant") ?? "Finished");
    else if (!this.quiet && status === "error" && before !== "starting") this.onNews?.(this, "error", this.lastLine("notice") ?? "Failed");
    if (status === "idle" || status === "error") {
      const waiters = this.settleWaiters;
      this.settleWaiters = [];
      for (const w of waiters) w();
    }
  }

  /** The first line of the latest answer (or error notice), without Markdown marks. */
  private lastLine(kind: "assistant" | "notice"): string | null {
    const items = this.reducer.items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i] as ChatItem;
      if (item.kind === "user") return null;
      const text = item.kind === "assistant" && kind === "assistant" ? item.text : item.kind === "notice" && kind === "notice" && item.level === "error" ? item.text : "";
      const line = text
        .split("\n")
        .map((l) => l.replace(/^[\s>#*+-]+|[*_`]/g, "").trim())
        .find(Boolean);
      if (line) return line.length > 140 ? `${line.slice(0, 139)}…` : line;
    }
    return null;
  }

  private async refreshContext(): Promise<void> {
    const generation = this.generation;
    try {
      const context = await this.live.getContextUsage();
      if (generation !== this.generation || this.status === "disposed") return;
      if (JSON.stringify(context) === JSON.stringify(this.context)) return;
      this.context = context;
      this.noteContext(context);
      this.reducer.emit({ type: "context", context });
    } catch {
      // usage is best-effort
    }
  }

  private async refreshUsage(): Promise<void> {
    const generation = this.generation;
    try {
      const usage = this.timing.compose(await this.live.getUsage());
      if (generation !== this.generation || this.status === "disposed") return;
      if (JSON.stringify(usage) === JSON.stringify(this.usage)) return;
      this.usage = usage;
      this.reducer.emit({ type: "usage", usage });
    } catch {
      // usage is best-effort
    }
  }

  private async refreshTodos(): Promise<void> {
    const generation = this.generation;
    try {
      const todos = await this.live.getTodos();
      if (generation !== this.generation || this.status === "disposed") return;
      if (JSON.stringify(todos) === JSON.stringify(this.todos)) return;
      this.todos = todos;
      this.reducer.emit({ type: "todos", todos });
    } catch {
      // todos are best-effort
    }
  }

  /** Wait until the run settles on its own (idle, error, disposed) or the cap passes — what internal callers (Board's bot sessions) wait on, never assistant_end. */
  waitSettled(): Promise<void> {
    if (this.status === "idle" || this.status === "error" || this.status === "disposed") return Promise.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>((r) => {
      resolve = r;
    });
    const timer = setTimeout(resolve, SETTLE_TIMEOUT_MS);
    this.settleWaiters.push(() => {
      clearTimeout(timer);
      resolve();
    });
    return promise;
  }

  private assertOpen(): void {
    if (this.status === "disposed") throw new ChatError(410, "chat_closed", "This chat was closed");
  }

  // ---- commands -------------------------------------------------------------

  async send(text: string, mode: SendMode, images: ImageAttachment[] = [], options: { compactFirst?: boolean } = {}): Promise<void> {
    this.assertOpen();
    // A prompt of the user's own takes the place of a scheduled continuation.
    this.clearContinue(true);
    if (options.compactFirst && mode === "normal" && this.adapter.capabilities.supportsCompact && this.status === "idle") {
      // Compaction reports its own failure as a notice; the message goes either way.
      await this.compact();
    }
    if (images.length > 0) {
      const refs = images.map((i) => rememberImage(i.mimeType, i.data)).filter((r): r is ImageRef => r !== null);
      // A handful at most: a prompt the harness never echoes must not pin images forever.
      this.sentImages = [...this.sentImages, refs].slice(-8);
    }
    this.lastActivity = Date.now();
    this.lastSeen = this.lastActivity;
    const caps = this.adapter.capabilities;
    const busy = this.status === "running" || this.status === "stopping" || this.status === "compacting";
    switch (mode) {
      case "steer":
        if (!caps.supportsSteer) throw new ChatError(400, "unsupported", "This harness cannot steer");
        if (this.status !== "running") throw new ChatError(409, "not_running", "Nothing is running to steer");
        await this.checkpoints?.beforePrompt(text);
        await this.live.steer(text, images);
        return;
      case "followUp":
        if (!caps.supportsFollowUp) throw new ChatError(400, "unsupported", "This harness has no follow-up queue");
        if (this.status !== "running") throw new ChatError(409, "not_running", "Nothing is running to follow");
        await this.checkpoints?.beforePrompt(text);
        await this.live.followUp(text, images);
        return;
      case "stopAndSend":
        if (busy) await this.abort();
        break;
      case "normal":
        if (busy) throw new ChatError(409, "busy", "The agent is busy; steer, queue a follow-up, or stop it first");
        break;
    }
    if (this.status === "error") this.status = "idle";
    this.setStatus("running");
    // The files as they are before this prompt; the status already says busy, so nothing else starts meanwhile.
    await this.checkpoints?.beforePrompt(text);
    if (this.status !== "running") return;
    this.timing.markHandoff();
    const busyBefore = this.reducer.busyCount();
    try {
      await this.live.prompt(text, images);
    } catch (error) {
      this.reducer.notice("error", `Prompt rejected: ${errorMessage(error)}`, true);
      this.quiet = true;
      // A harness that answered "already processing" says the run is going (its adapter sends the
      // busy event with that answer), so the chat stays running instead of inviting another send.
      if (this.reducer.busyCount() === busyBefore) this.setStatus("idle");
      this.quiet = false;
      throw new ChatError(422, "prompt_rejected", errorMessage(error));
    }
  }

  // ---- the chain: what runs after this run, kept by the server ------------------------

  /** Replace the chain; `resume` lets a paused one go on. On an idle chat its first step runs at once. */
  setChain(steps: ChainStep[], resume = false): void {
    this.assertOpen();
    this.chain = steps;
    if (resume || steps.length === 0) this.chainPaused = null;
    this.emitChain();
    this.chainSoon();
  }

  private emitChain(): void {
    this.reducer.emit({ type: "chain", chain: this.chain.map((s) => ({ ...s })), paused: this.chainPaused });
  }

  private pauseChain(reason: string): void {
    if (this.chain.length === 0 || this.chainPaused) return;
    this.chainPaused = reason;
    this.emitChain();
  }

  /** setTimeout's ceiling; a longer wait re-arms when it fires. */
  private static readonly MAX_TIMER_MS = 2 ** 31 - 1;

  /**
   * Carry this chat on once a usage limit resets (and once the limit's own window
   * has passed, in the caller's read of it). The timer lives here, so it fires with
   * every browser closed; any prompt of the user's own, a stop, or null calls it off.
   */
  scheduleContinue(at: number | null): void {
    this.assertOpen();
    this.clearContinue(false);
    if (at === null) {
      this.reducer.emit({ type: "snapshot", snapshot: this.snapshot() });
      return;
    }
    if (at <= Date.now()) throw new ChatError(400, "bad_continue", "That time has passed");
    this.continueAt = at;
    const wait = Math.min(at - Date.now(), Chat.MAX_TIMER_MS);
    this.continueTimer = setTimeout(() => void this.runContinue(at), wait);
    // A service that outlives its last browser must not be held open by this timer.
    this.continueTimer.unref?.();
    this.reducer.emit({ type: "snapshot", snapshot: this.snapshot() });
  }

  private async runContinue(at: number): Promise<void> {
    this.continueTimer = undefined;
    if (this.status === "disposed") return;
    // setTimeout's ceiling, or a clock that moved: wait again rather than continue early.
    if (Date.now() < at) {
      this.scheduleContinue(at);
      return;
    }
    this.continueAt = null;
    this.reducer.emit({ type: "snapshot", snapshot: this.snapshot() });
    if (this.status !== "idle" && this.status !== "error") return;
    try {
      await this.send(CONTINUE_TEXT, "normal");
    } catch (error) {
      this.reducer.notice("error", `Could not continue: ${errorMessage(error)}`, true);
    }
  }

  /** Drop a scheduled continuation, telling the clients when one was pending. */
  private clearContinue(notify: boolean): void {
    const pending = this.continueAt !== null || this.continueTimer !== undefined;
    if (this.continueTimer) clearTimeout(this.continueTimer);
    this.continueTimer = undefined;
    this.continueAt = null;
    if (pending && notify) this.reducer.emit({ type: "snapshot", snapshot: this.snapshot() });
  }

  /** The next step, once the events of the run that ended have gone out. */
  private chainSoon(): void {
    setTimeout(() => void this.advanceChain(), 0);
  }

  private async advanceChain(): Promise<void> {
    if (this.chainPaused || this.status !== "idle") return;
    const [step, ...rest] = this.chain;
    if (!step) return;
    if (step.kind === "send") {
      this.chain = rest;
      this.emitChain();
      try {
        await this.send(step.text, "normal");
      } catch (error) {
        this.chain = [step, ...this.chain];
        this.chainPaused = `Could not send the next message: ${errorMessage(error)}`;
        this.emitChain();
      }
      return;
    }
    // A handoff ends the chain here: the rest goes with the chat to the other harness.
    this.chain = [];
    this.emitChain();
    try {
      if (!this.onChainHandoff) throw new Error("Handoffs cannot run here");
      await this.onChainHandoff(this, step, rest);
      this.reducer.notice("info", `The chain handed this chat off to ${step.harness}`);
    } catch (error) {
      this.chain = [step, ...rest];
      this.chainPaused = `Could not hand off: ${errorMessage(error)}`;
      this.emitChain();
    }
  }

  /** Replace user turn `turn` and everything after it with `text`, in this same session (capabilities.supportsRewind). */
  async rewind(turn: number, text: string, images: ImageAttachment[] = []): Promise<void> {
    this.assertOpen();
    if (!this.adapter.capabilities.supportsRewind || !this.live.rewind) throw new ChatError(400, "unsupported", `${this.adapter.displayName} cannot replace a past message`);
    if (this.status !== "idle" && this.status !== "error") throw new ChatError(409, "busy", "Wait until the agent is idle");
    if (turn > this.userTurns().length) throw new ChatError(400, "bad_turn", "There is no such message");
    if (images.length > 0) {
      const refs = images.map((i) => rememberImage(i.mimeType, i.data)).filter((r): r is ImageRef => r !== null);
      this.sentImages = [...this.sentImages, refs].slice(-8);
    }
    this.lastActivity = Date.now();
    this.lastSeen = this.lastActivity;
    if (this.status === "error") this.status = "idle";
    this.setStatus("running");
    await this.checkpoints?.beforePrompt(text);
    if ((this.status as ChatStatus) !== "running") return;
    // The cut shows everywhere at once; the new turn then streams in after it.
    this.reducer.truncateBeforeUserTurn(turn);
    this.checkpoints?.forgetFrom(turn);
    this.reducer.emit({ type: "snapshot", snapshot: this.snapshot() });
    this.timing.markHandoff();
    try {
      await this.live.rewind(turn, text, images);
    } catch (error) {
      // The harness kept its history: show that again.
      const items = await this.live.history().catch(() => null);
      if (items) {
        this.reducer.truncateBeforeUserTurn(1);
        this.reducer.load(items, this.title || null);
      }
      this.reducer.notice("error", `Could not replace the message: ${errorMessage(error)}`, true);
      this.quiet = true;
      this.setStatus("idle");
      this.quiet = false;
      this.reducer.emit({ type: "snapshot", snapshot: this.snapshot() });
      throw new ChatError(422, "rewind_failed", errorMessage(error));
    }
  }

  async abort(): Promise<void> {
    this.assertOpen();
    // A stop calls off a continuation the user scheduled.
    this.clearContinue(true);
    if (this.status !== "running" && this.status !== "compacting" && this.status !== "stopping") return;
    this.pauseChain("Stopped");
    this.setStatus("stopping");
    for (const id of this.reducer.pendingIds()) this.reducer.resolveRequest(id, "Cancelled");
    try {
      await this.live.abort();
    } catch (error) {
      this.reducer.notice("error", `Stop failed: ${errorMessage(error)}`);
    }
    await this.waitSettled();
    if (this.status === "stopping") this.setStatus("idle");
  }

  async setConfig(patch: ConfigPatch): Promise<void> {
    this.assertOpen();
    // While starting the change waits for the harness, which applies it before any run.
    const idle = this.status === "idle" || this.status === "error" || this.status === "starting";
    // A permission mode is the exception: it can change mid-run, as Claude Code's own Shift+Tab does.
    if (!idle && (patch.model !== undefined || patch.thinkingLevel !== undefined)) {
      throw new ChatError(409, "busy", "Settings can only change while the agent is idle");
    }
    const caps = this.adapter.capabilities;
    if (patch.permissionMode !== undefined && !caps.supportsPermissionMode) {
      throw new ChatError(400, "unsupported", "This harness has no permission modes");
    }
    if (patch.model !== undefined && !caps.supportsModelSelection) {
      throw new ChatError(400, "unsupported", "This harness cannot change models");
    }
    if (patch.thinkingLevel !== undefined && !caps.supportsThinkingLevel) {
      throw new ChatError(400, "unsupported", "This harness has no thinking levels");
    }
    try {
      await this.live.setConfig(patch);
    } catch (error) {
      throw new ChatError(422, "config_rejected", errorMessage(error));
    }
    this.reducer.replaceConfig(await this.live.getConfig());
  }

  /** The harness's "/" commands; an empty list when it cannot say (the menu then offers the app's own). */
  async commands(): Promise<SlashCommand[]> {
    this.assertOpen();
    // /rewind-to is Edit's and Retry's: run by hand it would move the session without this chat knowing.
    return (await this.live.listCommands().catch(() => [])).filter((c) => c.name !== REWIND_COMMAND);
  }

  async refreshModels(): Promise<void> {
    this.assertOpen();
    await this.live.refreshModels();
    this.reducer.replaceConfig(await this.live.getConfig());
  }

  /**
   * Put this queue in place of the one the harness holds: a queued message
   * edited or removed before it ran. Only while a run is going (nothing waits
   * otherwise); the harness's own queue event then updates every viewer.
   */
  async replaceQueue(queue: QueueState): Promise<void> {
    this.assertOpen();
    if (!this.adapter.capabilities.supportsQueueEdit || !this.live.replaceQueue) throw new ChatError(400, "unsupported", "This harness cannot change its queue");
    if (this.status !== "running") throw new ChatError(409, "not_running", "Nothing is queued: the run has ended");
    await this.live.replaceQueue(queue);
  }

  async rename(name: string): Promise<void> {
    this.assertOpen();
    if (!this.adapter.capabilities.supportsRename) throw new ChatError(400, "unsupported", "Rename is not supported");
    await this.live.rename(name);
    this.reducer.setTitle(name);
  }

  async compact(instructions?: string): Promise<void> {
    this.assertOpen();
    if (!this.adapter.capabilities.supportsCompact) throw new ChatError(400, "unsupported", "Compact is not supported");
    if (this.status !== "idle") throw new ChatError(409, "busy", "Compact only while idle");
    this.setStatus("compacting");
    try {
      await this.live.compact(instructions);
    } catch (error) {
      this.reducer.notice("error", `Compaction failed: ${errorMessage(error)}`);
    } finally {
      // Re-read: events during the await may have moved the status on.
      if ((this.status as ChatStatus) === "compacting") this.setStatus("idle");
    }
  }

  /** A subagent's own transcript, as display items: read from the file its harness wrote. */
  async subagentTranscript(toolId: string, runId: string): Promise<{ run: SubagentRun; items: ChatItem[] }> {
    const tool = this.reducer.item(toolId);
    const run = tool?.kind === "tool" ? tool.subagents?.runs.find((r) => r.id === runId) : undefined;
    if (!tool || tool.kind !== "tool" || !run) throw new ChatError(404, "no_subagent", "No such subagent in this chat");
    const callId = toolId.replace(/^t:/, "");
    if (this.nativeId && this.adapter.subagentTranscript) {
      const items = await this.adapter.subagentTranscript({ nativeId: this.nativeId, cwd: this.workspace.path }, run).catch(() => null);
      if (items) return { run, items };
    }
    const file =
      transcriptFile(callId, runId) ??
      (this.nativeId && this.adapter.subagentTranscriptFile ? await this.adapter.subagentTranscriptFile({ nativeId: this.nativeId, cwd: this.workspace.path }, run) : null);
    if (!file) return { run, items: [] };
    let text: string;
    try {
      const { size } = await fs.stat(file);
      // Head and tail of an enormous one: its brief and how it ended.
      text = size > MAX_TRANSCRIPT_BYTES ? await readEnds(file, size) : await fs.readFile(file, "utf8");
    } catch {
      return { run, items: [] };
    }
    const messages = transcriptRecords(text) ?? branchMessages(text);
    return { run, items: historyToItems(messages) };
  }

  answer(requestId: string, answer: InteractionAnswer): string {
    this.assertOpen();
    const request = this.reducer.pendingRequest(requestId);
    if (!request) throw new ChatError(409, "request_resolved", "This request was already answered or cancelled");
    const outcome = describeAnswer(request, answer);
    // Synchronous check-deliver-resolve: the first answer wins, later ones see 409.
    const delivered = this.live.answer(requestId, answer);
    if (!delivered) {
      this.reducer.resolveRequest(requestId, "Cancelled");
      throw new ChatError(409, "request_resolved", "The harness no longer waits for this request");
    }
    this.reducer.resolveRequest(requestId, outcome);
    return outcome;
  }

  async dispose(reason: string): Promise<void> {
    if (this.status === "disposed") return;
    // A closed chat keeps no timer.
    this.clearContinue(false);
    if (this.viewersTimer) clearTimeout(this.viewersTimer);
    for (const id of this.reducer.pendingIds()) this.reducer.resolveRequest(id, "Cancelled");
    this.reducer.flushNow();
    this.status = "disposed";
    this.log.record({ type: "status", status: "disposed" });
    this.log.record({ type: "disposed", reason });
    this.unsubscribe?.();
    this.unsubscribe = null;
    const waiters = this.settleWaiters;
    this.settleWaiters = [];
    for (const w of waiters) w();
    this.log.closeAll();
    try {
      await this.live.dispose();
    } finally {
      // The checkpoint list is written without waiting, and onDisposed is what lets the session be resumed: the
      // resume must read this chat's list. Awaited only here, after the status above, so a second dispose that
      // comes in meanwhile returns at the guard instead of running all of this again.
      await this.checkpoints?.flush().catch(() => undefined);
      this.onDisposed?.(this);
    }
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
