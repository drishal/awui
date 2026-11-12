// The front door of the orchestration surface: it turns a tool call from a chat's harness
// child into a durable delegated task, watches the child chat to a terminal state, and
// keeps the record in the state folder. A child is an ordinary chat — openable, listed,
// resumable — so this module owns only the cross-chat bookkeeping (which task belongs to
// which chat, how it ended, what to tell the parent), never a transcript of its own.
//
// One watcher per running task subscribes to the child's stream and unsubscribes at
// settle, so an idle child can be reaped like any other chat. A cancel bumps the task's
// generation first, which drops late events from the run that was stopped.
import { randomBytes } from "node:crypto";
import { isApproval } from "../../shared/approval.js";
import { MAX_DELEGATED_TASKS, type ChatItem, type ChatLineage, type ChatStatus, type DelegatedTaskView, type InteractionRequest, type InteractionAnswer, type SendMode, type WorkspaceInfo } from "../../shared/protocol.js";
import type { BoardManager } from "../boards/types.js";
import { errorMessage, namespacedSessionId, type Chat } from "../chats/chat.js";
import { git } from "../git.js";
import { worktreeProblem } from "../worktrees.js";
import type { ChatManager } from "../chats/manager.js";
import type { HarnessRegistry } from "../harness/registry.js";
import type { HarnessAdapter } from "../harness/types.js";
import type { WorktreeService } from "../worktrees.js";
import type { Workspaces } from "../workspaces.js";
import type { AgentStatuses } from "../agent-status.js";
import { readPage } from "./read.js";
import { PlanStore, type PlanRecord } from "./plan-store.js";
import type { z } from "zod";
import type { Plan, PlanTask } from "./plans.js";
const planWaiters = new Map<string, { resolve: () => void; reject: (error: unknown) => void }>();
import { TaskStore } from "./store.js";
import {
  DEFAULT_WAIT_MS,
  delegateTaskSchema,
  findTool,
  listProfiles,
  listProfilesSchema,
  taskCancelSchema,
  taskReviewSchema,
  taskStatusSchema,
  planEditSchema,
  threadReadSchema,
  threadSendSchema,
  threadWaitSchema,
  requestDecisionSchema,
  setStatus,
  setStatusSchema,
  type ToolContext,
  type ToolOutput,
} from "./tools.js";
import type { OrchestrationLimits } from "./limits.js";
import type { AgentProfileConfig } from "../config.js";
import { denial, formatElapsed, firstLine, isReviewed, MAX_ERROR_CHARS, MAX_RESULT_CHARS, MAX_TITLE_CHARS, viewOf, type StoredTask, type TaskScope } from "./types.js";
import { GATE_REQUEST_PREFIX, DecisionStore, decisionViewOf, gateRequestOf, type StoredDecision } from "./decisions.js";
import { normalizeScope, scratchDirFor, makeGuard, judgeRequest, judgeSettled, wouldRefuse, blockedNotice, landedNotice, assignmentEnvelope, scopeNote, MAX_SCOPE_RECENT, type ScopeGuard, type ScopeViolation } from "./scope.js";
import { escapeEnvelopeMarkers } from "../envelope.js";
import { MAX_WAKE_ATTEMPTS, WAKE_COALESCE_MS, WAKE_RETRY_MS, wakeReport } from "./wake.js";
import type { IntegrationReview } from "./review.js";
import type { Heartbeats, StoredHeartbeat } from "../heartbeats.js";
import { viewOf as heartbeatViewOf } from "../heartbeats.js";
import { scheduleHeartbeatSchema } from "./tools.js";

/** How long a cancel waits for the child to settle before it says so. */
const CANCEL_SETTLE_MS = 5_000;
/** A task's last answer line is announced only when the line itself changes. */
const ACTIVITY_LINE = 300;

export interface OrchestratorDeps {
  chats: ChatManager;
  registry: HarnessRegistry;
  workspaces: Workspaces;
  boards?: BoardManager;
  /**
   * The projects' managed worktrees (worktrees.ts): `isolation: "worktree"` creates the
   * child's own checkout here. Absent leaves isolation saying it is not wired.
   */
  trees?: WorktreeService;
  /** `<stateDir>/orchestration/tasks.json`; null keeps the records in memory only (tests). */
  file: string | null;
  /** `<stateDir>/orchestration/decisions.json`; null keeps the records in memory only (tests). */
  decisionsFile?: string | null;
  /** Where `set_status` writes (agent-status.ts); absent leaves the tool saying it is not wired. */
  statuses?: AgentStatuses;
  /**
   * The review ledger (review.ts): finished isolated workers are recorded here for a
   * person's review, and a task's panel reads its decision. Absent leaves isolation
   * saying it is not wired.
   */
  review?: IntegrationReview;
  /**
   * The shared agent profiles (config.yml's `agent_profiles:`), read at each use so a
   * Settings change applies without a restart. Absent leaves only bots and harness defaults.
   */
  profiles?: () => AgentProfileConfig[];
  log: (message: string) => void;
  /**
   * The limits in force now: config.yml's `orchestration:` block, read at each use (index.ts), so a
   * changed number applies without a restart. Tests hand in a fixed set.
   */
  limits: () => OrchestrationLimits;
  /** The heartbeat store (heartbeats.ts); absent leaves the tool saying it is not wired. */
  heartbeats?: Heartbeats;
}

export class Orchestrator {
  private readonly store: TaskStore;
  private tasks: StoredTask[] = [];
  private loading: Promise<void> | null = null;
  readonly plans: PlanStore;
  /** One unsubscribe per running task, taken at settle so the child can be reaped. */
  private readonly watchers = new Map<string, () => void>();
  /** Callers parked in thread_wait, by task id. */
  private readonly waiters = new Map<string, Set<() => void>>();

  /** One coalescing timer per parent, so a burst of finishes arrives as one message. */
  private readonly wakeTimers = new Map<string, NodeJS.Timeout>();
  /** Parents whose report is being written right now: a second flush must not send it twice. */
  private readonly flushingWakes = new Set<string>();
  /** One wall-clock timer per running task: a run nobody stops must not run for days. */
  private readonly clocks = new Map<string, NodeJS.Timeout>();
  /** Each chat's recent call times, for the per-minute budget. */
  private readonly callTimes = new Map<string, number[]>();
  /** Each task's write-scope guard, taken at delegate and dropped at settle (scope.ts judges with it). */
  private readonly guards = new Map<string, ScopeGuard>();
  /** Out-of-scope paths already noted per task, so a preempt denial and its errored tool_end count once. */
  private readonly noted = new Map<string, Set<string>>();
  /** Wake prompts delivered per parent in the last hour, keyed as the ledger's pending reports are. */
  private readonly wakeTimes = new Map<string, number[]>();
  constructor(private readonly deps: OrchestratorDeps) {
    this.store = new TaskStore(deps.file);
    this.plans = new PlanStore(deps.file ? deps.file.replace(/tasks\.json$/, "plans.json") : null, (plan) => {
      const parent = this.deps.chats.peek(plan.parentChatId) ?? this.deps.chats.list().find((chat) => chat.sessionId !== null && chat.sessionId === plan.parentSessionId);
      parent?.announce({ type: "plan", plan: this.planView(plan) });
      if (parent && !parent.plan) parent.plan = () => this.planFor(parent) ?? null;
    });
    this.decisionStore = new DecisionStore(deps.decisionsFile ?? null);
  }

  /** The limits in force for this call: read every time, so a file change applies without a restart. */
  private get limits(): OrchestrationLimits {
    return this.deps.limits();
  }

  /** Run one tool call as `caller`. The tool's own schema validates the arguments first. */
  async run(name: string, rawArgs: unknown, caller: Chat): Promise<ToolOutput> {
    const tool = findTool(name);
    if (!tool) throw denial(400, "unknown_tool", `No such tool: ${name}`);
    if (!this.limits.enabled) throw denial(404, "orch_off", "Orchestration is turned off in config.yml (orchestration.enabled)");
    await this.ready();
    this.countCall(caller.chatId);
    const args = rawArgs ?? {};
    switch (name) {
      case "list_profiles":
        return this.listProfiles(caller, listProfilesSchema.parse(args));
      case "delegate_task":
        return this.delegate(caller, delegateTaskSchema.parse(args));
      case "plan_workers":
        return this.editPlan(caller, planEditSchema.parse(args));
      case "task_status":
        return this.status(caller, taskStatusSchema.parse(args));
      case "task_cancel":
        return this.cancel(caller, taskCancelSchema.parse(args));
      case "task_review":
        return this.reviewStatus(caller, taskReviewSchema.parse(args));
      case "thread_wait":
        return this.wait(caller, threadWaitSchema.parse(args));
      case "thread_send":
        return this.threadSend(caller, threadSendSchema.parse(args));
      case "thread_read":
        return this.threadRead(caller, threadReadSchema.parse(args));
      case "request_decision":
        return this.requestDecision(caller, requestDecisionSchema.parse(args));
      case "set_status":
        return setStatus(caller, setStatusSchema.parse(args), this.deps.statuses);
      case "schedule_heartbeat":
        return this.scheduleHeartbeat(caller, scheduleHeartbeatSchema.parse(args));
      default:
        throw denial(400, "unknown_tool", `${name} is not wired on this server yet`);
    }
  }

  // ---- the tools ----------------------------------------------------------

  /**
   * `schedule_heartbeat`: a prompt this chat receives on an interval, routed through the
   * heartbeat store. The owner is the calling chat's immutable identity (harness id plus
   * native session id) and the workspace is the one its validated token was bound to —
   * both spelled server-side, never taken from the arguments, so a schedule can only ever
   * prompt the chat that created it. A chat the harness has not named yet has no session
   * to key the owner on, and says so instead of scheduling an orphan.
   */
  private async scheduleHeartbeat(caller: Chat, args: { name: string; prompt: string; intervalMs: number; maxRuns?: number; cancelId?: string }): Promise<ToolOutput> {
    const heartbeats = this.deps.heartbeats;
    if (!heartbeats) throw denial(404, "orch_off", "Heartbeats are not wired on this server");
    if (!caller.sessionId || !caller.nativeId) throw denial(409, "no_session", "This chat has no session yet; schedule a heartbeat once the harness has named it");
    const prefix = `${caller.adapter.id}:`;
    if (!caller.sessionId.startsWith(prefix)) throw denial(409, "no_session", "This chat's session does not match its harness");
    const nativeId = caller.sessionId.slice(prefix.length);
    if (args.cancelId !== undefined) {
      const cancelled = await heartbeats.cancel(args.cancelId, caller.adapter.id, nativeId);
      if (!cancelled) throw denial(404, "unknown_task", `No heartbeat ${args.cancelId} belongs to this chat`);
      const heartbeat = heartbeats.get(args.cancelId);
      return { text: `Cancelled heartbeat ${args.cancelId}${heartbeat ? ` (${heartbeat.name})` : ""}. It will not beat again.`, data: heartbeat ? heartbeatViewOf(heartbeat) : null };
    }
    const saved = await heartbeats.save({ harnessId: caller.adapter.id, nativeId, workspacePath: caller.workspace.path }, { name: args.name, prompt: args.prompt, intervalMs: args.intervalMs, maxRuns: args.maxRuns }).catch((error: unknown) => {
      throw denial(409, "too_many_tasks", error instanceof Error ? error.message : String(error));
    });
    return {
      text: `Heartbeat ${saved.id} scheduled ("${saved.name}"): this chat is prompted every ${formatElapsed(saved.intervalMs)}, at most ${saved.maxRuns === 10_000 ? "the server cap" : `${saved.maxRuns} runs`}, first at ${new Date(saved.nextRunAt ?? 0).toISOString()}. Cancel with schedule_heartbeat({ cancelId: "${saved.id}" }).`,
      data: heartbeatViewOf(saved),
    };
  }

  // ---- the store ----------------------------------------------------------

  private ready(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  /**
   * Read the records once. A task the last process was still running cannot be resumed —
   * its child chat died with that process — so it is marked interrupted with the reason.
   * Nothing is restarted: the child's session file is still there, resumable as an
   * ordinary chat by whoever wants the work to go on.
   */
  private async load(): Promise<void> {
    const { tasks, dropped } = await this.store.read();
    if (dropped > 0) this.deps.log(`orchestration: dropped ${dropped} malformed task record(s)`);
    const now = Date.now();
    let interrupted = false;
    for (const task of tasks) {
      // Waiting for a user, the children, or its own run: none of it survives the restart.
      if (task.state === "result_available") continue;
      task.state = "result_available";
      task.outcome = "interrupted";
      task.endedAt = now;
      task.asking = null;
      task.activity = null;
      task.result = { finalText: task.result?.finalText ?? "", error: "the server restarted before this task settled", usage: task.result?.usage ?? null };
      // The parent never learned how this ended, so a wake-notified task is queued again — written
      // here, before anything is sent — and delivered when the parent is next open.
      if (task.notify === "wake") {
        task.wake.pendingSince = now;
        task.wake.skipped = null;
        task.wake.attempts = 0;
      }
      interrupted = true;
    }
    this.tasks = tasks;
    if (interrupted) await this.store.write(this.tasks).catch((error: unknown) => this.deps.log(`orchestration: could not record interrupted tasks: ${errorMessage(error)}`));
  }

  /**
   * The lineage a stored record gives the chat it started: a resumed or reaped child keeps
   * its chip, which is why the manager asks on every registration.
   */
  lineageOf(chat: Chat): ChatLineage | undefined {
    const task = this.tasks.find((t) => this.startedFrom(t, chat));
    if (!task) return undefined;
    return { kind: "delegate", taskId: task.id, parentChatId: task.parentChatId, parentTitle: task.parentTitle, depth: task.depth };
  }

  /**
   * Whether this session started as a delegated child (a resumed child is still one). The manager
   * asks before a respawn, when there is no chat yet to read a lineage from.
   */
  isDelegatedSession(harnessId: string, nativeId: string): boolean {
    const sessionId = namespacedSessionId(harnessId, nativeId);
    return this.tasks.some((task) => task.childSessionId === sessionId);
  }

  /** This chat's delegated tasks, for a chat the manager is registering (a reopened parent). */
  tasksFor(chat: Chat): DelegatedTaskView[] {
    return this.viewsFor(chat.chatId, chat.sessionId);
  }

  /** Load the records and mark what the last process left running: called once at startup. */
  async start(): Promise<void> {
    await this.ready();
    await this.plans.ready();
    await this.readyDecisions();
  }

  private async persist(): Promise<void> {
    await this.store.write(this.tasks);
  }

  /**
   * A chat was registered: opened, created, or resumed. A parent with reports still undelivered —
   * because it was closed when they were written, or because the last process died — gets them now.
   * The manager calls this for every chat, so a reopened parent never misses a result. A resumed
   * worker gets the decision gate installed here, so its `dc-` answers record through the gate too.
   */
  async registered(chat: Chat): Promise<void> {
    await this.ready();
    this.installGate(chat);
    // A pending decision on this chat is re-raised when its record has no request on the chat yet
    // (a restart between the record's write and the question, or a chat opened after one).
    await this.readyDecisions();
    for (const decision of this.decisions) {
      if (decision.state !== "pending") continue;
      // Matched by the harness session too: a resumed worker's chat id is minted per open.
      const sameChild = decision.childChatId === chat.chatId || (decision.childSessionId !== null && chat.sessionId === decision.childSessionId);
      if (!sameChild) continue;
      if (chat.pendingDecision(`${GATE_REQUEST_PREFIX}${decision.id}`)) continue;
      try {
        chat.addPendingDecision(gateRequestOf(decision));
      } catch {
        // A chat mid-shutdown refuses the item; the record keeps the question either way.
      }
    }
    const waiting = this.tasks.filter((task) => task.state === "result_available" && task.wake.pendingSince !== null && task.wake.skipped === null && this.ownTaskOf(task, chat));
    if (waiting.length === 0) return;
    // Nothing to coalesce with: the wait already happened, so the window is over.
    this.scheduleFlush(this.wakeKeyOf(waiting[0] as StoredTask), 0);
  }

  // ---- the tools ----------------------------------------------------------

  private async listProfiles(caller: Chat, args: { workspaceId?: string }): Promise<ToolOutput> {
    return listProfiles(this.context(caller), args, { remainingDepth: this.remainingDepth(caller), remainingTasks: this.remainingTasks(caller) });
  }

  private async status(caller: Chat, args: { taskId?: string }): Promise<ToolOutput> {
    if (args.taskId) {
      const task = this.ownTask(caller, args.taskId);
      this.consume([task]);
      return { text: this.describe([task]), data: { tasks: [viewOf(task)] } };
    }
    const mine = this.viewsFor(caller.chatId, caller.sessionId).slice(0, 50);
    if (mine.length === 0) return { text: "This chat has not delegated any tasks.", data: { tasks: [] } };
    const tasks = mine.map((view) => this.tasks.find((task) => task.id === view.id)).filter((task): task is StoredTask => task !== undefined);
    this.consume(tasks);
    return { text: this.describe(tasks), data: { tasks: mine } };
  }

  private async cancel(caller: Chat, args: { taskId: string }): Promise<ToolOutput> {
    const { task, settled, already } = await this.cancelOne(caller, args.taskId);
    // Idempotent: a finished task is returned as it stands, and asking is reading it.
    if (already) return { text: `Task ${task.id} already finished (${task.outcome}).`, data: { task: viewOf(task) } };
    const text = `Cancelled task ${task.id} (${task.title}). Its chat is ${settled ? "stopped" : "still stopping"}.`;
    if (!settled) throw denial(504, "cancel_timeout", `${text} It did not settle within ${CANCEL_SETTLE_MS / 1000}s`);
    return { text, data: { task: viewOf(task) } };
  }

  /** Whether this task's finished work has a person's review decision (review.ts's one rule). */
  private reviewDecisionOf(task: StoredTask): boolean {
    const record = task.isolation === null || !this.deps.review ? undefined : this.deps.review.get(task.id);
    return isReviewed(task, record?.review !== null && record !== undefined);
  }

  /**
   * `task_review`: how the caller's finished isolated work stands with a person — unreviewed
   * (waiting), applied, discarded, or stale (the heads moved, so the apply is guarded). The
   * words are the model's answer; the record is the truth behind them.
   */
  private async reviewStatus(caller: Chat, args: { taskId: string }): Promise<ToolOutput> {
    const task = this.ownTask(caller, args.taskId);
    if (task.isolation === null) {
      const where = task.state === "result_available" && task.outcome === "done" ? "its edits landed in this chat's own working tree, where you already see them" : `it is ${task.state}${task.outcome ? ` (${task.outcome})` : ""}`;
      return { text: `Task ${task.id} shared this chat's working tree, so there is nothing to review: ${where}.`, data: { taskId: task.id, review: null, state: task.state } };
    }
    const review = this.deps.review;
    if (!review) throw denial(501, "unsupported", "Reviews are not wired on this server");
    const record = review.get(task.id);
    if (!record) {
      if (task.state === "result_available" && task.outcome === "done") {
        return {
          text: `Task ${task.id} finished ${task.isolation !== null ? "but its review is not recorded yet" : "into this chat's own working tree, where you already see its edits"}; there is nothing to review.`,
          data: { taskId: task.id, review: null, state: task.state },
        };
      }
      return { text: `Task ${task.id} is ${task.state}${task.outcome ? ` (${task.outcome})` : ""}; it is not awaiting a review.`, data: { taskId: task.id, review: null, state: task.state } };
    }
    const verdict = record.review;
    const heads = this.deps.trees
      ? await review.headsMatch(record, { root: task.workspacePath, ws: { id: task.parentChatId, path: task.workspacePath }, trees: this.deps.trees }).catch(() => null)
      : null;
    if (record.appliedAt !== null) {
      return { text: `Task ${task.id}'s work was reviewed and applied into the lead checkout${verdict?.note ? `: ${verdict.note}` : ""}.`, data: { taskId: task.id, review: verdict, appliedAt: record.appliedAt } };
    }
    if (record.discardedAt !== null) {
      return { text: `Task ${task.id}'s work was reviewed and discarded${verdict?.note ? `: ${verdict.note}` : ""}. Run cleanup to take its worktree.`, data: { taskId: task.id, review: verdict, discardedAt: record.discardedAt } };
    }
    const stale = heads !== null && !heads.match;
    const why = stale ? staleWords(heads.reason) : null;
    return {
      text: `Task ${task.id} is finished and waiting for review${why ? `, but the recorded heads no longer match (${why}), so the apply is guarded` : ""}. The person applies or discards it from the chat's task panel.`,
      data: { taskId: task.id, review: null, headsMatch: heads?.match ?? null, reason: heads?.reason ?? null },
    };
  }

  /** Verify this browser chat owns a delegated task before exposing or mutating its review record. */
  taskFor(chat: Chat, taskId: string): DelegatedTaskView {
    return viewOf(this.ownTask(chat, taskId));
  }

  /**
   * The user stopping a child its chat's agent started.
   * by the model. A chat that did not settle is not an error here — the record already says
   * cancelled, and the panel would only turn a successful stop into a red banner.
   */
  async cancelFor(chat: Chat, taskId: string): Promise<DelegatedTaskView> {
    await this.ready();
    const { task } = await this.cancelOne(chat, taskId);
    return viewOf(task);
  }

  /** Stop one task's whole subtree and report it; `already` is a task that had finished. */
  private async cancelOne(caller: Chat, taskId: string): Promise<{ task: StoredTask; settled: boolean; already: boolean }> {
    const task = this.ownTask(caller, taskId);
    if (task.state === "result_available") {
      this.consume([task]);
      return { task, settled: true, already: true };
    }
    task.cancelRequestedAt = Date.now();
    task.generation += 1;
    // Depth first: everything the task's chat started stops before the chat itself.
    const belowSettled = await this.stopSubtree(task, 0);
    const settled = (await this.stopTask(task)) && belowSettled;
    return { task, settled, already: false };
  }

  private async wait(caller: Chat, args: { taskIds: string[]; waitMs?: number }): Promise<ToolOutput> {
    const tasks = args.taskIds.map((id) => this.ownTask(caller, id));
    await this.waitFor(tasks, args.waitMs ?? DEFAULT_WAIT_MS);
    const pendingRequest = this.pendingQuestion(tasks);
    // The parent has the results now: no wake would still be news.
    this.consume(tasks);
    return {
      text: this.describe(tasks, pendingRequest),
      data: { tasks: tasks.map(viewOf), ...(pendingRequest ? { pendingRequest } : {}) },
    };
  }

  /**
   * Talk to the child's chat: steered into the run it is in, or as a prompt when it is idle. A task
   * that had finished goes back to work — a new generation, so nothing from the old run can answer
   * for it — and is watched again: one result per settle.
   */
  private async threadSend(caller: Chat, args: { taskId: string; text: string }): Promise<ToolOutput> {
    const task = this.ownTask(caller, args.taskId);
    const child = this.childChat(task);
    if (!child || child.status === "disposed") {
      throw denial(409, "task_not_running", `Task ${task.id}'s chat is closed; its session can be resumed as an ordinary chat, but nothing is listening now`);
    }
    const caps = child.adapter.capabilities;
    const busy = child.status === "running" || child.status === "stopping" || child.status === "compacting";
    const mode: SendMode = !busy ? "normal" : caps.supportsSteer ? "steer" : "followUp";
    if (busy && !caps.supportsSteer && !caps.supportsFollowUp) throw denial(409, "cannot_send", `${child.adapter.displayName} cannot take a message mid-run`);
    const revived = task.state === "result_available";
    if (revived) {
      this.stopWatching(task.id);
      task.generation += 1;
      task.state = "working";
      task.outcome = null;
      task.endedAt = null;
      task.asking = null;
      task.activity = null;
      task.result = null;
      task.cancelRequestedAt = null;
      task.wake = { pendingSince: null, deliveredAt: null, attempts: 0, skipped: null };
      task.childSessionId = child.sessionId ?? task.childSessionId;
      // Watch before the prompt: a quick run can settle before send() returns.
      this.watch(task, child);
    }
    try {
      await child.send(args.text, mode, [], { origin: "agent" });
    } catch (error) {
      throw denial(409, "cannot_send", `Task ${task.id}'s chat refused the message: ${errorMessage(error)}`);
    }
    if (revived) this.changed(task);
    const queued = mode === "steer" ? "steered" : "sent";
    const text =
      mode === "steer"
        ? `Steered into task ${task.id}'s run (${child.status}).`
        : `Sent to task ${task.id}; it is ${task.state} again. Wait with thread_wait(["${task.id}"]), read with thread_read("${task.id}").`;
    return { text, data: { queued, state: task.state } };
  }

  /** The child's chat as the parent reads it: a bounded page of what it said and did. */
  private async threadRead(caller: Chat, args: { taskId: string; before?: number; limit?: number }): Promise<ToolOutput> {
    const task = this.ownTask(caller, args.taskId);
    const items = await this.childItems(task);
    const note = scopeNote(task.scope);
    const head = `Task ${task.id} · ${task.state}${task.outcome ? ` (${task.outcome})` : ""} · ${task.harnessId} — "${task.title}"${note ? `\n[${note}]` : ""}`;
    if (items === null) {
      // The chat is gone and its harness keeps no file to read: what the record holds is all there is.
      const result = task.result?.finalText ? `\n\nIts last answer:\n${task.result.finalText}` : "";
      const error = task.result?.error ? `\n\nIts error: ${task.result.error}` : "";
      return {
        text: `${head}\n\nThis chat is closed and its transcript cannot be read without opening it. Resume the session to see it.${result}${error}`,
        data: { task: viewOf(task), items: [], truncated: true },
      };
    }
    const page = readPage(items, args);
    return { text: `${head}\n\n${page.text}`, data: { task: viewOf(task), items: page.items, truncated: page.truncated } };
  }

  // ---- the decision gate ---------------------------------------------------

  /** The decision records' one store, and the ledger in memory once `ready` has run. */
  private readonly decisionStore: DecisionStore;
  private decisions: StoredDecision[] = [];
  private decisionsReady: Promise<void> | null = null;
  /** Callers parked in request_decision, by server record id. */
  private readonly decisionWaiters = new Map<string, Set<() => void>>();

  /**
   * `request_decision`: a delegated worker parks until the person answers an explicit decision.
   * The question goes on the worker's own chat as a regular request item — the same approval card
   * and answer route as any harness question — and the recorded answer is what the parked call
   * returns. Only a live delegated caller may ask: the tool binds to its task, and a caller that
   * is not a delegation's child has no decision to bind. A retry with the caller's own stable
   * decisionId finds the record already asked for (a pending one parks again; an answered one
   * returns its recorded answer without asking twice).
   */
  private async requestDecision(caller: Chat, args: { question: string; message?: string; kind: "confirm" | "select"; options?: string[]; decisionId: string; waitMs?: number }): Promise<ToolOutput> {
    // The caller must be a delegation's child, and its task must still be live: a finished task
    // has no work to gate, and an ordinary chat has no task to bind the decision to.
    const task = this.tasks.find((candidate) => candidate.state !== "result_available" && this.startedFrom(candidate, caller));
    if (!task) throw denial(403, "not_delegated", "Only a live delegated task's worker may ask for a decision");
    await this.readyDecisions();
    // A repeat is the same decision, never a second question.
    const repeat = this.decisions.find((decision) => decision.taskId === task.id && decision.decisionId === args.decisionId);
    if (repeat) {
      // An answered repeat returns its recorded answer at once; a pending one parks again on it.
      await this.waitForDecision(repeat, args.waitMs ?? DEFAULT_WAIT_MS);
      const settled = this.decisions.find((d) => d.id === repeat.id);
      if (!settled || settled.state !== "answered") {
        return {
          text: `Decision "${repeat.question}" is still waiting for the person (decisionId "${repeat.decisionId}"). Ask again with the same decisionId, or let the person answer on this chat.`,
          data: { decision: decisionViewOf(settled ?? repeat), state: "pending" },
        };
      }
      return this.decisionOutput(task, settled);
    }
    const options = args.kind === "select" ? (args.options ?? []).slice(0, 6) : [];
    if (args.kind === "select" && options.length < 2) throw denial(400, "invalid_request", "A select decision needs at least two options");
    const decision: StoredDecision = {
      id: this.newDecisionId(),
      decisionId: args.decisionId,
      taskId: task.id,
      parentChatId: task.parentChatId,
      childChatId: task.childChatId,
      childSessionId: task.childSessionId,
      question: args.question,
      message: args.message ?? null,
      kind: args.kind,
      options,
      state: "pending",
      answer: null,
      outcome: null,
      denialReason: null,
      createdAt: Date.now(),
      answeredAt: null,
    };
    const child = this.childChat(task);
    if (!child || child.status === "disposed") throw denial(409, "task_not_running", `Task ${task.id}'s chat is closed; there is no one left to answer for it`);
    // The record lands before the question is raised, so a crash in between leaves a pending
    // decision the person can still answer — its request is re-raised on the next start.
    this.decisions.unshift(decision);
    try {
      await this.persistDecisions();
    } catch (error) {
      this.decisions = this.decisions.filter((d) => d !== decision);
      throw denial(500, "store_failed", `Could not record the decision: ${errorMessage(error)}`);
    }
    // Surfaced before the wait: the person sees the question while the worker parks, and the
    // worker's wait ends on the answer, never on the harness's own settle.
    child.addPendingDecision(gateRequestOf(decision));
    task.state = "waiting_for_user";
    task.asking = decision.question.slice(0, 200);
    this.changed(task);
    // Bounded park: the answer, a cancel, or the cap ends it. The original call stays this one
    // turn — no second worker turn is spawned, and the answer is recorded either way.
    await this.waitForDecision(decision, args.waitMs ?? DEFAULT_WAIT_MS);
    const settled = this.decisions.find((d) => d.id === decision.id);
    if (!settled || settled.state !== "answered") {
      // Still pending after the cap: the record keeps the question, the person can still answer
      // it, and the caller reads that it is waiting rather than an answer nobody gave.
      return {
        text: `Decision "${decision.question}" is still waiting for the person (decisionId "${decision.decisionId}"). Ask again with the same decisionId, or let the person answer on this chat.`,
        data: { decision: settled ? decisionViewOf(settled) : decisionViewOf(decision), state: "pending" },
      };
    }
    return this.decisionOutput(task, settled);
  }

  /** One decision's answer to its caller: the recorded verdict, a denial's reason beside it. */
  private decisionOutput(task: StoredTask, decision: StoredDecision): ToolOutput {
    const answer = decision.answer;
    const said =
      answer === null
        ? "no answer recorded"
        : answer.kind === "confirm"
          ? answer.confirmed
            ? "approved"
            : "denied"
          : answer.kind === "cancel"
            ? "dismissed"
            : `answered "${answer.value}"`;
    const lines = [`The person ${said} decision "${decision.question}" (decisionId "${decision.decisionId}").`];
    if (decision.denialReason) lines.push(`Their correction: ${decision.denialReason}`);
    lines.push(`Recorded outcome: ${decision.outcome ?? said}.`);
    return { text: lines.join("\n"), data: { decision: decisionViewOf(decision), state: decision.state } };
  }

  /**
   * The gate one worker's chat hands its `dc-` answers to: the person's answer through the
   * ordinary route is recorded here, the transcript item is resolved, and the parked call is
   * woken. Only the chat the decision was raised on may answer it — a cross-agent answer is
   * denied, and a second answer sees the first.
   */
  private answerGate(chat: Chat, requestId: string, outcome: string, answer: InteractionAnswer, denialReason?: string): boolean {
    if (!requestId.startsWith(GATE_REQUEST_PREFIX)) return false;
    const decision = this.decisions.find((d) => `${GATE_REQUEST_PREFIX}${d.id}` === requestId);
    // An already-answered decision is the first answer's: a later one sees 409, as any request does.
    if (!decision || decision.state === "answered") return false;
    // Only the chat the question was raised on answers it, matched by its harness session too (a
    // resumed worker's chat id is minted per open): another agent's chat is denied.
    const child = this.deps.chats.list().find((c) => c.chatId === decision.childChatId || (decision.childSessionId !== null && c.sessionId === decision.childSessionId));
    if (!child || child.chatId !== chat.chatId) return false;
    decision.state = "answered";
    decision.answer = answer;
    decision.outcome = outcome;
    decision.denialReason = denialReason ?? null;
    decision.answeredAt = Date.now();
    void this.persistDecisions().catch((error: unknown) => this.deps.log(`orchestration: could not record decision ${decision.id}: ${errorMessage(error)}`));
    // The transcript item is resolved by the chat itself (Chat.answer's gate path).
    this.wakeDecisionWaiters(decision.id);
    const task = this.tasks.find((t) => t.id === decision.taskId);
    if (task) {
      // The task moves back to work only when the worker's harness is idle with nothing pending;
      // the watcher's own status events settle it, so this only tells the parent the record moved.
      this.announce(task);
    }
    return true;
  }

  /** Park until the decision is answered, or the cap passes. No timer per decision. */
  private waitForDecision(decision: StoredDecision, waitMs: number): Promise<void> {
    if (decision.state === "answered") return Promise.resolve();
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.decisionWaiters.get(decision.id)?.delete(wake);
        resolve();
      };
      const wake = () => {
        if (decision.state === "answered") done();
      };
      const timer = setTimeout(done, Math.max(0, waitMs));
      timer.unref?.();
      const set = this.decisionWaiters.get(decision.id) ?? new Set<() => void>();
      set.add(wake);
      this.decisionWaiters.set(decision.id, set);
      // The decision can have been answered between the first check and this registration.
      wake();
    });
  }

  private wakeDecisionWaiters(decisionId: string): void {
    for (const wake of [...(this.decisionWaiters.get(decisionId) ?? [])]) wake();
  }

  private async readyDecisions(): Promise<void> {
    this.decisionsReady ??= this.loadDecisions();
    return this.decisionsReady;
  }

  /**
   * Read the records once. A decision still pending when the last process stopped stays pending —
   * only the person may answer it, so nothing is auto-answered — and its request is re-raised on
   * the worker's chat if that chat is open again, so the question never goes quiet.
   */
  private async loadDecisions(): Promise<void> {
    const { decisions, dropped } = await this.decisionStore.read();
    if (dropped > 0) this.deps.log(`orchestration: dropped ${dropped} malformed decision record(s)`);
    this.decisions = decisions;
    // A pending decision whose worker chat is open again gets its question back.
    for (const decision of decisions) {
      if (decision.state !== "pending" || decision.childChatId === null) continue;
      const child = this.deps.chats.list().find((chat) => chat.chatId === decision.childChatId);
      if (child && child.status !== "disposed" && !child.pendingDecision(`${GATE_REQUEST_PREFIX}${decision.id}`)) {
        try {
          child.addPendingDecision(gateRequestOf(decision));
        } catch {
          // A chat mid-shutdown refuses the item; the record keeps the question either way.
        }
      }
    }
  }

  /** Called by app.ts at startup: the decision records load with the task records (start()). */

  private async persistDecisions(): Promise<void> {
    await this.decisionStore.write(this.decisions);
  }

  /** Install the decision gate on a chat the manager registered (a resumed worker answers through it too). */
  private installGate(chat: Chat): void {
    chat.decisionGate = (requestId, outcome, answer, reason) => this.answerGate(chat, requestId, outcome, answer, reason);
  }

  /** A decision id no live record carries. */
  private newDecisionId(): string {
    for (;;) {
      const id = randomBytes(8).toString("hex");
      if (!this.decisions.some((decision) => decision.id === id)) return id;
    }
  }

  /** The task an earlier call with this request id already started, when there is one. */
  private repeatOf(caller: Chat, clientRequestId: string | undefined): StoredTask | undefined {
    if (!clientRequestId) return undefined;
    return this.tasks.find((task) => task.parentChatId === caller.chatId && task.clientRequestId === clientRequestId);
  }

  /**
   * A chat's tool calls in the last minute: a loop that spins must be answered with a wait, not
   * with an unbounded run of delegations. A sliding window, so a burst cannot outrun it.
   */
  private countCall(chatId: string): void {
    const now = Date.now();
    const limit = this.limits.callsPerMinute;
    const recent = (this.callTimes.get(chatId) ?? []).filter((at) => now - at < 60_000);
    const oldest = recent[0];
    if (recent.length >= limit && oldest !== undefined) {
      this.callTimes.set(chatId, recent);
      const wait = Math.max(1, Math.ceil((oldest + 60_000 - now) / 1000));
      throw denial(429, "too_many_calls", `This chat has made ${limit} tool calls in the last minute; try again in ${wait}s`);
    }
    recent.push(now);
    this.callTimes.set(chatId, recent);
    // Chat ids are minted per open, so a long-lived server would otherwise keep one row per chat ever opened.
    if (this.callTimes.size > 200) for (const [id, times] of this.callTimes) if (!times.some((at) => now - at < 60_000)) this.callTimes.delete(id);
  }

  /** Depth and count limits for a new task from `caller`; throws the 429 that names the limit hit. */
  private checkRoom(caller: Chat, depth: number): void {
    const limits = this.limits;
    if (depth > limits.maxDepth) throw denial(429, "max_depth", `Delegation stops at ${limits.maxDepth} levels; this chat is already at its limit`);
    if (this.liveTasks() >= limits.maxLiveTasks) throw denial(429, "too_many_tasks", `This server already runs ${limits.maxLiveTasks} delegated tasks`);
    const mine = this.tasks.filter((task) => task.parentChatId === caller.chatId);
    if (mine.filter((task) => task.state !== "result_available").length >= limits.maxChildrenPerChat) {
      throw denial(429, "too_many_tasks", `A chat may run ${limits.maxChildrenPerChat} delegated tasks at once`);
    }
    if (mine.length >= limits.maxTasksPerChat) throw denial(429, "too_many_tasks", `A chat may start ${limits.maxTasksPerChat} delegated tasks`);
  }

  private planView(plan: PlanRecord): Plan & { note: string | null; taskIds: Record<string, string> } {
    const { parentChatId: _owner, parentSessionId: _session, ...view } = plan;
    return view;
  }

  /** The current plan this chat owns; attached at registration with no worker started. */
  planFor(chat: Chat): Plan | null {
    const record = this.plans.latestFor(chat);
    return record ? this.planView(record) : null;
  }

  /** The browser's plan lifecycle uses the same real worker delegate path as the tool; no duplicate execution. */
  editPlanFor(caller: Chat, args: z.input<typeof planEditSchema>): Promise<ToolOutput> {
    return this.editPlan(caller, args);
  }

  private async editPlan(caller: Chat, args: z.input<typeof planEditSchema>): Promise<ToolOutput> {
    if (caller.adapter.capabilities.readOnlyHarness) throw denial(403, "caller_read_only", `${caller.adapter.displayName} cannot coordinate workers`);
    let record: PlanRecord;
    if (args.action === "save") {
      record = args.planId ? await this.plans.edit(caller, args.planId, { title: args.title, tasks: args.tasks, maxParallel: args.maxParallel }) : await this.plans.create(caller, { title: args.title, tasks: args.tasks, maxParallel: args.maxParallel });
    } else if (args.action === "cancel") {
      record = await this.plans.cancel(caller, args.planId);
    } else {
      record = await this.plans.confirm(caller, args.planId, (_brief, task) => this.planWorker(caller, args.planId, task));
    }
    return { text: `Plan ${record.id} is ${record.status}${record.note ? `: ${record.note}` : ""}.`, data: { plan: this.planView(record) } };
  }

  private async planWorker(caller: Chat, planId: string, task: PlanTask): Promise<{ task: StoredTask; done: Promise<void> }> {
    const harness = task.harness ?? caller.adapter.id;
    const adapter = this.deps.registry.get(harness);
    if (!adapter) throw denial(422, "unknown_harness", `Task ${task.id} names unknown harness ${harness}`);
    if (task.model && !(await adapter.listModels(caller.workspace.path)).some((model) => model.key === task.model || model.id === task.model)) {
      throw denial(422, "invalid_plan", `Model ${task.model} is not offered by ${harness} here`);
    }
    const out = await this.delegate(caller, { brief: task.prompt, harness, ...(task.model ? { model: task.model } : {}), title: task.title ?? task.id, ...(task.isolation ? { isolation: task.isolation } : {}), ...(task.writeScope.length > 0 ? { writeScope: task.writeScope } : {}), notify: "none", clientRequestId: `plan:${planId}:${task.id}` });
    const taskId = (out.data as { taskId: string }).taskId;
    const started = this.ownTask(caller, taskId);
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    planWaiters.set(taskId, { resolve, reject });
    if (started.state === "result_available") {
      planWaiters.delete(taskId);
      if (started.outcome === "done") resolve();
      else reject(new Error(started.result?.error ?? `Task ${taskId} failed to start`));
    }
    return { task: started, done: promise };
  }

  private async delegate(
    caller: Chat,
    args: {
      brief: string;
      harness?: string;
      profile?: string;
      model?: string;
      thinkingLevel?: string;
      permissionMode?: string;
      role?: string;
      title?: string;
      workspaceId?: string;
      isolation?: "worktree";
      notify?: "wake" | "none";
      clientRequestId?: string;
      writeScope?: string[];
    },
  ): Promise<ToolOutput> {
    if (caller.adapter.capabilities.readOnlyHarness) {
      throw denial(403, "caller_read_only", `${caller.adapter.displayName} is a read-only surface and cannot delegate work`);
    }
    // A repeated request is the same task, never a second child.
    const repeat = this.repeatOf(caller, args.clientRequestId);
    if (repeat) return this.delegateOutput(repeat);
    const depth = (caller.lineage?.depth ?? 0) + 1;
    this.checkRoom(caller, depth);

    const bot = args.profile === undefined ? undefined : await this.findProfile(args.profile);
    const harnessId = args.harness ?? bot?.harnessId ?? caller.adapter.id;
    const adapter = this.deps.registry.get(harnessId);
    if (!adapter) throw denial(422, "unknown_harness", `No harness called ${harnessId}`);
    if (adapter.capabilities.readOnlyHarness) throw denial(422, "harness_unavailable", `${adapter.displayName} is a read-only surface and cannot host a delegated task`);
    if (!(await this.deps.registry.available(adapter.id))) throw denial(422, "harness_unavailable", `${adapter.displayName} is not available right now`);
    // An open project by id, never a path: the caller's own unless it names another.
    const workspace = args.workspaceId === undefined ? caller.workspace : await this.deps.workspaces.get(args.workspaceId);
    const problem = adapter.workspaceProblem(workspace.path);
    if (problem) throw denial(422, "workspace_unsupported", problem);
    const permissionMode = this.permissionModeFor(caller, adapter, args.permissionMode ?? bot?.permissionMode ?? undefined);
    // The write scope a delegated child is held to (A5): normalized here, before any work starts,
    // so a bad pattern answers the 400 that names it instead of a child that trusts dead weight.
    const scope = normalizeScope(args.writeScope);
    if (!scope.ok) throw denial(400, "bad_scope", scope.why);
    const model = args.model ?? bot?.model ?? undefined;
    const thinkingLevel = args.thinkingLevel ?? bot?.thinkingLevel ?? undefined;
    const title = (args.title ?? firstLine(args.brief, MAX_TITLE_CHARS) ?? `Task in ${workspace.name}`).slice(0, MAX_TITLE_CHARS);
    // Worktree isolation: the child works in its own managed checkout of the project, so its
    // edits cannot collide with the caller's. The review gates on the fork point, so it is
    // resolved here, before anything is created, and a base git cannot resolve is refused.
    const isolated = args.isolation === "worktree";
    if (isolated && !this.deps.review) throw denial(501, "unsupported", "Worktree isolation is not wired on this server");
    let iso: { worktreeId: string; branch: string; fork: string; ws: WorkspaceInfo } | null = null;
    if (isolated) {
      const trees = this.deps.trees;
      if (!trees) throw denial(501, "unsupported", "Managed worktrees are not wired on this server");
      // The fork point is the project's current HEAD, resolved in the project itself.
      const head = (await git(["rev-parse", "--verify", "--end-of-options", "HEAD"], { cwd: workspace.path }).catch(() => "")).trim();
      if (!head) throw denial(422, "workspace_unsupported", `This project has no commits to fork a worktree from`);
      const name = `task-${Date.now().toString(36)}`.slice(0, 64);
      const tree = await trees.create(workspace, name, "HEAD").catch((error: unknown) => {
        throw worktreeProblem(error) ?? denial(422, "workspace_unsupported", errorMessage(error));
      });
      iso = { worktreeId: tree.id, branch: tree.branch, fork: head, ws: await this.deps.workspaces.open(tree.path) };
    }
    // The guard (scope.ts) judges with this; the scratch dir is control data under `.awui/`,
    // which the agent's own file listings skip, so it is the worker's private area alone.
    const taskScope: TaskScope = { globs: scope.globs, scratchDir: null, attempted: 0, blocked: 0, landed: 0, recent: [] };
    // Minted before the record, so the scratch dir names it; the checks above ran before several
    // awaits, and the re-check below still guards the double-spawn.
    const taskId = this.newTaskId();
    taskScope.scratchDir = scratchDirFor(workspace.path, taskId);

    const task: StoredTask = {
      id: taskId,
      parentChatId: caller.chatId,
      childChatId: null,
      title,
      harnessId: adapter.id,
      model: model ?? null,
      role: args.role ?? bot?.role ?? "",
      profile: bot?.id ?? null,
      depth,
      state: "working",
      outcome: null,
      createdAt: Date.now(),
      endedAt: null,
      activity: null,
      result: null,
      asking: null,
      workspacePath: workspace.path,
      parentTitle: caller.title || null,
      parentSessionId: caller.sessionId,
      childSessionId: null,
      generation: 0,
      cancelRequestedAt: null,
      notify: args.notify ?? "wake",
      clientRequestId: args.clientRequestId ?? null,
      wake: { pendingSince: null, deliveredAt: null, attempts: 0, skipped: null },
      isolation: iso === null ? null : { worktreeId: iso.worktreeId, branch: iso.branch, fork: iso.fork },
      reviewable: iso !== null,
      ...(scope.globs.length > 0 ? { scope: taskScope } : {}),
    };
    // The checks above ran before several awaits, so two calls in flight could both pass them:
    // ask again here, where nothing can interleave before the record is added.
    const again = this.repeatOf(caller, args.clientRequestId);
    if (again) return this.delegateOutput(again);
    this.checkRoom(caller, depth);
    // The record lands before anything is spawned, so a crash mid-spawn leaves a row the
    // next load marks interrupted instead of work nobody knows about.
    this.tasks.unshift(task);
    try {
      await this.persist();
    } catch (error) {
      this.tasks = this.tasks.filter((t) => t !== task);
      throw denial(500, "store_failed", `Could not record the task: ${errorMessage(error)}`);
    }

    // The parent lists its tasks from here on, so even a spawn that fails is a row it can see.
    this.attach(caller);
    let child: Chat;
    try {
      // Marked delegated: the child's own harness treats its subagents differently (Claude Code's
      // prompt-cache lifetime), and it is spawned before the lineage record reaches the chat.
      // Isolated: the child's own checkout of the project, seeded like any managed worktree.
      child = await this.deps.chats.create(adapter, iso === null ? workspace : iso.ws, undefined, { delegated: true });
    } catch (error) {
      // A worktree created for a child that never started is this call's own to undo:
      // git's registration and the project's record both go, so no orphan tree is left.
      if (iso !== null) await this.dropWorktree(iso.worktreeId, task.workspacePath);
      await this.finish(task, "failed", errorMessage(error));
      return this.delegateOutput(task);
    }
    task.childChatId = child.chatId;
    task.childSessionId = child.sessionId;
    child.lineage = { kind: "delegate", taskId: task.id, parentChatId: caller.chatId, parentTitle: caller.title || null, depth };
    // The boundary judges writes with the task's guard; a task with no scope gets none (the common case).
    const guard = task.scope ? makeGuard(task.scope, (iso?.ws ?? workspace).path, this.guardFields(child)) : null;
    if (guard) this.guards.set(task.id, guard);
    try {
      if (model !== undefined || thinkingLevel !== undefined || permissionMode !== undefined) {
        await child.setConfig({
          ...(model !== undefined ? { model } : {}),
          ...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
          ...(permissionMode !== undefined ? { permissionMode } : {}),
        });
      }
      // Watch before the prompt: the run can settle before send() returns.
      this.watch(task, child);
      // The brief carries the assignment contract inside the hidden envelope when the task
      // carries a scope (the markers are broken in the brief first, so a quoted contract is
      // The brief carries a scoped assignment in its hidden envelope, with employee text escaped: markers in it are quoted, never executed.
      const brief = task.scope && task.scope.globs.length > 0 ? `${escapeEnvelopeMarkers(args.brief)}\n\n${assignmentEnvelope(task.scope)}` : args.brief;
      await child.send(brief, "normal", [], { origin: "agent" });
    } catch (error) {
      if (iso !== null) await this.dropWorktree(iso.worktreeId, task.workspacePath);
      await this.finish(task, "failed", errorMessage(error));
      return this.delegateOutput(task);
    }
    this.announce(task);
    return this.delegateOutput(task);
  }

  /** Remove a managed worktree this process created and nothing depends on (a failed spawn's own). */
  private async dropWorktree(worktreeId: string, workspacePath: string): Promise<void> {
    const trees = this.deps.trees;
    if (!trees) return;
    const ws = await this.deps.workspaces.open(workspacePath).catch(() => undefined);
    if (!ws) return;
    await trees.prune(ws, worktreeId).catch((error: unknown) => this.deps.log(`orchestration: could not drop an unused worktree: ${errorMessage(error)}`));
  }

  /** Which worker is being stopped and re-prompted for a denial; its intermediate idle is not a result. */
  private readonly correcting = new Set<string>();

  /** An explained denial becomes a fresh worker turn, never an edit to the harness's request or transcript. */
  denied(chat: Chat, request: InteractionRequest, reason: string): void {
    const task = this.tasks.find((candidate) => candidate.state !== "result_available" && this.startedFrom(candidate, chat));
    // An explanation is always kept on the request's record; only live workers get an automatic corrective run.
    if (!task || task.state === "result_available") return;
    const title = request.title.split("\n")[0]?.slice(0, 200) ?? "this request";
    const text = `The person denied “${title}” with this correction. Re-plan and retry only within the approved scope; otherwise explain what blocks you.\n\n${reason}`;
    this.correcting.add(task.id);
    task.state = "working";
    task.asking = null;
    this.changed(task);
    void Promise.resolve().then(async () => {
      // Outside the answer event: a harness may finish synchronously and finish the old task otherwise.
      let sent = false;
      try {
        // Waits for the harness's settled event, then prompts. The marker keeps that intermediate idle internal.
        await chat.send(text, "stopAndSend", [], { origin: "agent" });
        sent = true;
      } catch (error) {
        chat.apply({ type: "notice", level: "error", text: `Could not deliver the denial correction: ${errorMessage(error)}`, ambient: true });
        this.deps.log(`orchestration: could not deliver a denial correction: ${errorMessage(error)}`);
      } finally {
        this.correcting.delete(task.id);
        // A failure leaves the worker readable, not spinning for ever or claiming the requested re-plan happened.
        if (!sent && chat.status === "idle" && task.state !== "result_available") void this.finish(task, "failed", "The denial correction could not be delivered to the worker");
        // A quick harness can emit settled before send's promise resolves; reconcile that settle now.
        if (sent && chat.status === "idle" && task.state !== "result_available") {
          await this.onStatus(task, chat, "idle").catch((error: unknown) => this.deps.log(`orchestration: could not settle corrected task: ${errorMessage(error)}`));
        }
      }
    });
  }

  private watch(task: StoredTask, child: Chat): void {
    // The wall clock starts with the watch and restarts with a revived task: the child is at work.
    this.clearWallClock(task.id);
    this.armWallClock(task);
    const generation = task.generation;
    const unsubscribe = child.subscribe({
      send: (_id, event) => {
        // Work from a run the caller has since cancelled arrives late; it must not move the task.
        if (task.generation !== generation) return;
        switch (event.type) {
          case "status":
            if (event.status === "idle" && this.correcting.has(task.id)) return;
            void this.onStatus(task, child, event.status);
            return;
          case "request":
            // The decision gate's own question (`dc-`) is the watcher's doing: it already moved
            // the task to waiting_for_user, and the harness never raised a request here.
            if (event.request.id.startsWith(GATE_REQUEST_PREFIX)) return;
            // An approval reaches the user already; only a real question ends the parent's wait.
            if (isApproval(event.request)) {
              // Pre-emption where the harness preserves the answer: an ask the scope refuses is
              // denied before the tool runs, and the child is told what to fix (scope.ts).
              const guard = this.guards.get(task.id) ?? null;
              if (wouldRefuse(event.request, guard)) {
                const verdict = judgeRequest(event.request, guard as ScopeGuard);
                if (!verdict.ok) {
                  this.noteViolation(task, { path: verdict.path, why: verdict.why, kind: "blocked" });
                  this.childDeny(task, event.request);
                }
              }
              return;
            }
            task.state = "waiting_for_user";
            task.asking = event.request.title.slice(0, 200);
            this.changed(task);
            return;
          // Resolved or cancelled: either way the child is no longer asking, and carries on.
          case "request_resolved":
            // The gate's own decision is resolved by the gate (answerGate), which records the
            // verdict and leaves the task waiting until the worker's caller reads the answer.
            if (event.requestId.startsWith(GATE_REQUEST_PREFIX)) return;
            if (task.state !== "waiting_for_user") return;
            task.state = "working";
            task.asking = null;
            this.changed(task);
            return;
          case "disposed":
            void this.finish(task, "cancelled", "The chat was closed");
            return;
          case "item":
            this.noteActivity(task, event.item);
            // Detect: a write that landed (or failed) outside the scope, seen from the tool
            // events — the honest half for a harness the guard cannot preempt in (scope.ts).
            this.detectWrites(task, event.item);
            return;
          default:
            return;
        }
      },
      close: () => undefined,
    });
    this.watchers.set(task.id, unsubscribe);
  }

  /**
   * A task nobody stops must not run for ever. Past the configured wall clock it is stopped the way
   * a cancel stops it — the same abort, the same cap — but recorded `failed` with the reason, so
   * the parent can tell it apart from its own cancel. Unref'd: a pending clock never keeps the
   * process alive. A task a restart marked interrupted is never armed, because it is not running.
   */
  private armWallClock(task: StoredTask): void {
    const ms = this.limits.taskWallClockMs;
    const timer = setTimeout(() => {
      this.clocks.delete(task.id);
      // Only a task at work: one waiting on the user, or on its own delegates, is not the wall clock's business.
      if (task.state !== "working") return;
      task.cancelRequestedAt = Date.now();
      task.generation += 1;
      const error = `wall clock exceeded (${formatElapsed(ms)})`;
      void (async () => {
        const belowSettled = await this.stopSubtree(task, 0);
        const settled = (await this.stopTask(task, { outcome: "failed", error })) && belowSettled;
        if (!settled) this.deps.log(`orchestration: task ${task.id} passed its wall clock and its chat is still stopping`);
      })().catch((problem: unknown) => this.deps.log(`orchestration: could not stop task ${task.id} at its wall clock: ${errorMessage(problem)}`));
    }, ms);
    timer.unref?.();
    this.clocks.set(task.id, timer);
  }

  private clearWallClock(taskId: string): void {
    const timer = this.clocks.get(taskId);
    if (timer) clearTimeout(timer);
    this.clocks.delete(taskId);
  }

  private async onStatus(task: StoredTask, child: Chat, status: ChatStatus): Promise<void> {
    if (status === "disposed") {
      await this.finish(task, "cancelled", "The chat was closed");
      return;
    }
    if (status === "idle" || status === "error") {
      // A child still asking is not finished; neither is one whose own delegates are running.
      if (child.pendingCount > 0) return;
      const running = this.tasks.filter((t) => t !== task && t.state !== "result_available" && this.ownTaskOf(t, child));
      if (running.length > 0) {
        if (task.state !== "waiting_for_children") {
          task.state = "waiting_for_children";
          this.changed(task);
        }
        return;
      }
      const correcting = this.correcting.delete(task.id);
    if (correcting) return;
    const failed = status === "error" || child.snapshot().items.some((item) => item.kind === "assistant" && Boolean(item.error));
      await this.finish(task, failed ? "failed" : "done", failed ? this.errorOf(child) : null);
      return;
    }
    // running, compacting, stopping, starting: the child is at work.
    if (task.state !== "working") {
      task.state = "working";
      task.asking = null;
      this.changed(task);
    }
  }

  /** The child's latest answer line, announced only when it changes: the panel's activity row. */
  private noteActivity(task: StoredTask, item: ChatItem): void {
    if (task.state === "result_available" || item.kind !== "assistant") return;
    const line = firstLine(item.text, ACTIVITY_LINE);
    if (!line || line === task.activity) return;
    task.activity = line;
    this.announce(task);
  }

  // ---- the write-scope guard (A5) -----------------------------------------

  /** What the boundary needs to judge with: the harness's capabilities decide the honest half. */
  private guardFields(child: Chat): { prevent: boolean; detect: boolean } {
    const caps = child.adapter.capabilities;
    return {
      // Pre-empt needs an interactive ask awui may answer; detect needs the tool events, which every live chat's watcher already sees.
      prevent: caps.supportsInteractiveRequests,
      detect: true,
    };
  }

  /** One out-of-scope write onto the record, newest first and bounded; the counts are the parent's report's numbers. A path is counted once: a preempt denial and its errored tool_end are one write, not two. */
  private noteViolation(task: StoredTask, violation: ScopeViolation): void {
    if (!task.scope) return;
    const seen = this.noted.get(task.id) ?? new Set<string>();
    if (seen.has(violation.path)) return;
    seen.add(violation.path);
    this.noted.set(task.id, seen);
    task.scope.attempted += 1;
    if (violation.kind === "blocked") task.scope.blocked += 1;
    else if (violation.kind === "landed") task.scope.landed += 1;
    const line = (violation.kind === "blocked" ? blockedNotice(violation.path, violation.why) : landedNotice(violation.path, violation.why)).slice(0, 400);
    task.scope.recent = [...task.scope.recent, line].slice(-MAX_SCOPE_RECENT);
    this.deps.log(`orchestration: task ${task.id} ${violation.kind} an out-of-scope write: ${violation.path}`);
    this.changed(task);
  }

  /** The ask the guard refused, denied with what to fix: the harness's own answer carries the correction (A8's denial-with-reason delivers it as the next message; this one only refuses). */
  private childDeny(task: StoredTask, request: InteractionRequest): void {
    const child = this.childChat(task);
    if (!child || child.status === "disposed") return;
    try {
      child.answer(request.id, { kind: "confirm", confirmed: false });
    } catch {
      // A harness that resolves its own asks before the deny lands is fine: the refusal is already on the record.
    }
  }

  /**
   * A settled tool call against the guard: an edit/write outside the scope that landed (or
   * errored) is seen and reported, never claimed blocked — the guard already denied the asks it
   * could preempt, so a landed one is the harness's own doing and the record says so.
   */
  private detectWrites(task: StoredTask, item: ChatItem): void {
    if (item.kind !== "tool" || item.status === "running") return;
    const guard = this.guards.get(task.id);
    if (!guard || !guard.detect) return;
    const verdict = judgeSettled(item.name, item.args, guard);
    if (verdict.ok) return;
    this.noteViolation(task, { path: verdict.path, why: verdict.why, kind: item.status === "error" ? "failed" : "landed" });
  }

  // ---- state changes ------------------------------------------------------

  /**
   * A task reached a terminal state. `outcome` says how; `error` is what a caller reads
   * when it failed. The record is written before the parent is told, so a crash in
   * between leaves a task the parent can still ask about.
   */
  /** A task reached its one terminal result: plan runners listen here instead of inventing another settle path. */
  onTaskSettled?: (task: StoredTask) => void;
  private async finish(task: StoredTask, outcome: "done" | "failed" | "cancelled" | "interrupted", error: string | null = null): Promise<void> {
    if (task.state === "result_available") return;
    const child = this.childChat(task);
    task.childSessionId = child?.sessionId ?? task.childSessionId;
    // An isolated worker's finished work becomes a review record (A6): completed is not
    // reviewed, and the record gates the apply on the heads as they stand now. Recorded
    // before the task turns terminal, so a snapshot that says done implies the review
    // record is on disk. A failed or cancelled run has no work to review, and a
    // shared-tree task lands in the caller's own tree, where the caller already sees it.
    if (task.isolation !== null && outcome === "done" && this.deps.review) {
      await this.deps.review
        .track({
          taskId: task.id,
          workspaceId: await this.workspaceIdOf(task),
          workspacePath: task.workspacePath,
          worktreeId: task.isolation.worktreeId,
          branch: task.isolation.branch,
          fork: task.isolation.fork,
        })
        .catch((problem: unknown) => this.deps.log(`orchestration: could not record task ${task.id} for review: ${errorMessage(problem)}`));
    }
    task.state = "result_available";
    task.outcome = outcome;
    task.endedAt = Date.now();
    task.asking = null;
    task.activity = null;
    task.result = {
      finalText: child ? (this.lastAnswer(child)?.slice(0, MAX_RESULT_CHARS) ?? "") : "",
      error: error === null ? null : error.slice(0, MAX_ERROR_CHARS),
      usage: child?.snapshot().usage ?? null,
    };
    this.stopWatching(task.id);
    // Queued before the write, so the record says a report is owed even if this process dies now.
    this.queueWake(task);
    await this.persist().catch((problem: unknown) => this.deps.log(`orchestration: could not record task ${task.id}: ${errorMessage(problem)}`));
    this.announce(task);
    this.wakeWaiters(task.id);
    // A parent whose last delegate just finished has half-finished work until it runs again.
    await this.settleParent(task);
    this.onTaskSettled?.(task);
    if (task.state === "result_available") {
      const waiter = planWaiters.get(task.id);
      planWaiters.delete(task.id);
      if (task.outcome === "done") waiter?.resolve();
      else waiter?.reject(new Error(task.result?.error ?? `Task ${task.id} did not finish (${task.outcome})`));
    }
  }

  /**
   * A task that was still waiting for its own delegates may be finished now: the child
   * chat is idle and nothing under it is live. One level here, the walk generalizes.
   */
  private async settleParent(childTask: StoredTask): Promise<void> {
    const parent = this.tasks.find((task) => this.startedFrom(task, { chatId: childTask.parentChatId, sessionId: childTask.parentSessionId }));
    // A parent whose cancel (or wall clock) is already under way is being recorded by that, not here:
    // the last delegate settling under it must not turn a requested cancel into a "done".
    if (!parent || parent.state === "result_available" || parent.cancelRequestedAt !== null) return;
    const chat = this.childChat(parent);
    if (!chat || chat.status !== "idle") return;
    const running = this.tasks.filter((task) => this.ownTaskOf(task, chat) && task.state !== "result_available");
    if (running.length > 0) return;
    await this.finish(parent, "done", null);
  }

  // ---- delivery -----------------------------------------------------------

  /**
   * Queue the report a finished task owes its parent, before anything is sent: the record is
   * durable, so a crash between the write and the send retries on the next start (at-least-once).
   * A cancel is the parent's own doing and a `notify: "none"` task is not news, so neither queues.
   */
  private queueWake(task: StoredTask): void {
    if (task.notify !== "wake" || task.wake.pendingSince !== null || task.wake.skipped !== null) return;
    if (task.outcome === "cancelled") {
      task.wake.skipped = "cancelled by the parent";
      return;
    }
    // Wakes turned off in config.yml: the task still finishes and stays readable, it is just quiet.
    if (!this.limits.wakeParents) {
      task.wake.skipped = "wakes are off";
      return;
    }
    task.wake.pendingSince = Date.now();
    task.wake.deliveredAt = null;
    task.wake.attempts = 0;
    this.scheduleFlush(this.wakeKeyOf(task), WAKE_COALESCE_MS);
  }

  /** One timer per parent: reports queued inside its window flush together, and a second timer would only wait. */
  private scheduleFlush(key: string, delayMs: number): void {
    if (this.wakeTimers.has(key)) return;
    const timer = setTimeout(() => {
      void this.flushWakes(key);
    }, delayMs);
    timer.unref?.();
    this.wakeTimers.set(key, timer);
  }

  /** A task's parent, keyed by the session that outlives the chat: a reopened parent is still the same one. */
  private wakeKeyOf(task: StoredTask): string {
    return task.parentSessionId !== null ? `s:${task.parentSessionId}` : `c:${task.parentChatId}`;
  }

  private parentChatOf(task: StoredTask): Chat | undefined {
    return this.deps.chats.list().find((chat) => chat.chatId === task.parentChatId || (task.parentSessionId !== null && chat.sessionId === task.parentSessionId));
  }

  /**
   * Send every report queued for one parent as one bounded prompt. A parent that is not open keeps
   * its reports: they are delivered when it next registers, never twice from here.
   */
  private async flushWakes(key: string): Promise<void> {
    this.wakeTimers.delete(key);
    if (this.flushingWakes.has(key)) return;
    this.flushingWakes.add(key);
    try {
      const pending = this.tasks.filter((task) => task.state === "result_available" && task.wake.pendingSince !== null && task.wake.skipped === null && this.wakeKeyOf(task) === key);
      const first = pending[0];
      if (!first) return;
      const limits = this.limits;
      // The switch and the budget are checked here, at the one place a report leaves: a task queued
      // while wakes were on is not sent after they are turned off.
      if (!limits.wakeParents) {
        this.skipWakes(pending, "wakes are off");
        return;
      }
      const recent = this.wakeTimesIn(key, Date.now());
      if (recent.length >= limits.maxWakesPerHour) {
        this.wakeTimes.set(key, recent);
        this.skipWakes(pending, "wake budget used up");
        return;
      }
      const parent = this.parentChatOf(first);
      if (!parent || parent.status === "disposed") return;
      const mode = this.wakeMode(parent);
      if (mode === null) {
        this.failWakes(pending, `${parent.adapter.displayName} cannot take a message while it runs`);
        return;
      }
      try {
        await parent.send(wakeReport(pending), mode, [], { origin: "agent" });
      } catch (error) {
        this.failWakes(pending, errorMessage(error));
        return;
      }
      const now = Date.now();
      for (const task of pending) {
        task.wake.pendingSince = null;
        task.wake.deliveredAt = now;
        task.wake.skipped = null;
      }
      // The budget's window counts the prompts actually sent, not the reports they carried.
      recent.push(now);
      this.wakeTimes.set(key, recent);
      await this.persist().catch((error: unknown) => this.deps.log(`orchestration: could not record delivered reports: ${errorMessage(error)}`));
    } finally {
      this.flushingWakes.delete(key);
    }
  }

  /** A report the parent would not take: retried twice, then marked skipped so it never spins. */
  private failWakes(tasks: StoredTask[], why: string): void {
    let retry = false;
    for (const task of tasks) {
      task.wake.attempts += 1;
      if (task.wake.attempts >= MAX_WAKE_ATTEMPTS) {
        task.wake.pendingSince = null;
        task.wake.skipped = why.slice(0, 200);
      } else retry = true;
    }
    this.deps.log(`orchestration: could not deliver ${tasks.length} report(s): ${why}`);
    void this.persist().catch((error: unknown) => this.deps.log(`orchestration: could not record undelivered reports: ${errorMessage(error)}`));
    const first = tasks[0];
    if (retry && first) this.scheduleFlush(this.wakeKeyOf(first), WAKE_RETRY_MS);
  }

  /** The wake prompts one parent received in the last hour: the budget's sliding window. */
  private wakeTimesIn(key: string, now: number): number[] {
    return (this.wakeTimes.get(key) ?? []).filter((at) => now - at < 3_600_000);
  }

  /**
   * Reports that will not be delivered, with the reason the record keeps. The result is not lost:
   * the parent's own task_status or thread_wait still answers, and the ledger says why it was quiet.
   */
  private skipWakes(tasks: StoredTask[], why: string): void {
    for (const task of tasks) {
      task.wake.pendingSince = null;
      task.wake.skipped = why.slice(0, 200);
    }
    this.deps.log(`orchestration: did not deliver ${tasks.length} report(s): ${why}`);
    void this.persist().catch((error: unknown) => this.deps.log(`orchestration: could not record skipped reports: ${errorMessage(error)}`));
  }

  /**
   * How the parent can take a report now: a steer into its run, a follow-up when it holds a request
   * of its own (a steer would be lost), or an ordinary prompt when it is idle. Null when its
   * harness offers neither queue and it is busy.
   */
  private wakeMode(chat: Chat): SendMode | null {
    const busy = chat.status === "running" || chat.status === "stopping" || chat.status === "compacting";
    if (!busy) return "normal";
    const caps = chat.adapter.capabilities;
    if (chat.pendingCount > 0) return caps.supportsFollowUp ? "followUp" : null;
    if (caps.supportsSteer) return "steer";
    return caps.supportsFollowUp ? "followUp" : null;
  }

  /**
   * A result the parent has just read (thread_wait, task_status, task_cancel): a wake would tell it
   * what it already knows, so the ledger records the read instead of a delivery.
   */
  private consume(tasks: StoredTask[]): void {
    let changed = false;
    for (const task of tasks) {
      if (task.state !== "result_available" || task.wake.pendingSince === null || task.wake.skipped !== null) continue;
      task.wake.pendingSince = null;
      task.wake.skipped = "read by the parent";
      changed = true;
    }
    if (changed) void this.persist().catch((error: unknown) => this.deps.log(`orchestration: could not record read results: ${errorMessage(error)}`));
  }

  /**
   * Stop every live task the given task's chat started, deepest first, each awaited with the same
   * five-second cap a cancel uses. The walk stops at the delegation cap, where no delegate can
   * exist, so a corrupted record cannot make it recurse for ever.
   */
  private async stopSubtree(task: StoredTask, depth: number): Promise<boolean> {
    const chat = this.childChat(task);
    if (!chat || depth >= this.limits.maxDepth) return true;
    let settled = true;
    for (const below of this.tasks.filter((t) => this.ownTaskOf(t, chat) && t.state !== "result_available")) {
      if (!(await this.stopSubtree(below, depth + 1))) settled = false;
      if (!(await this.stopTask(below))) settled = false;
    }
    return settled;
  }

  /**
   * Stop one task's child chat: abort, then close it when nobody is watching, then record how it
   * ended. `ending` is how the caller wants it recorded: a cancel by the parent, or (the wall
   * clock) a failure with the reason, which the parent reads as any other error.
   */
  private async stopTask(task: StoredTask, ending: { outcome: "cancelled" | "failed"; error: string } = { outcome: "cancelled", error: "Cancelled by the parent" }): Promise<boolean> {
    // Our own watcher counts as a viewer, so it goes first: the count below is the user's.
    this.stopWatching(task.id);
    const chat = this.childChat(task);
    let settled = true;
    if (chat) {
      settled = await Promise.race([chat.abort().then(() => true), sleep(CANCEL_SETTLE_MS).then(() => false)]);
      // A user watching the child keeps it open: closing it would take the page away.
      if (settled && chat.subscriberCount === 0) await chat.dispose(ending.outcome === "failed" ? "Delegated task stopped" : "Delegated task cancelled").catch((error: unknown) => this.deps.log(`orchestration: could not close ${chat.chatId}: ${errorMessage(error)}`));
    }
    await this.finish(task, ending.outcome, ending.error);
    return settled;
  }

  /** Remember a rare state change (not an activity tick), tell the parent, and write it. */
  private changed(task: StoredTask): void {
    void this.persist().catch((error: unknown) => this.deps.log(`orchestration: could not record task ${task.id}: ${errorMessage(error)}`));
    this.announce(task);
    this.wakeWaiters(task.id);
  }

  private announce(task: StoredTask): void {
    const parent = this.parentChatOf(task);
    if (!parent) return;
    this.attach(parent);
    parent.announce({ type: "task", task: viewOf(task) });
  }

  /** Install the snapshot's task list on a parent the first time it delegates (or is first seen). */
  private attach(chat: Chat): void {
    if (!chat.delegated) chat.delegated = () => this.viewsFor(chat.chatId, chat.sessionId);
  }

  /** A chat id is minted per open, so a reopened chat is matched by its harness session too. */
  private ownTaskOf(task: StoredTask, chat: Chat): boolean {
    return task.parentChatId === chat.chatId || (task.parentSessionId !== null && task.parentSessionId === chat.sessionId);
  }

  private startedFrom(task: StoredTask, chat: { chatId: string; sessionId: string | null }): boolean {
    return task.childChatId === chat.chatId || (task.childSessionId !== null && task.childSessionId === chat.sessionId);
  }

  private viewsFor(chatId: string, sessionId: string | null): DelegatedTaskView[] {
    return this.tasks
      .filter((task) => task.parentChatId === chatId || (sessionId !== null && task.parentSessionId === sessionId))
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_DELEGATED_TASKS)
      .map(viewOf);
  }

  // ---- waiting ------------------------------------------------------------

  private static reports(task: StoredTask): boolean {
    return task.state === "result_available" || task.state === "waiting_for_user";
  }

  /** Park until every task is finished or asking, or the cap passes. No timer per task. */
  private waitFor(tasks: StoredTask[], waitMs: number): Promise<void> {
    if (tasks.every((task) => Orchestrator.reports(task))) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const ids = tasks.map((task) => task.id);
      const done = () => {
        clearTimeout(timer);
        for (const id of ids) this.waiters.get(id)?.delete(wake);
        resolve();
      };
      const wake = () => {
        if (tasks.every((task) => Orchestrator.reports(task))) done();
      };
      const timer = setTimeout(done, Math.max(0, waitMs));
      timer.unref?.();
      for (const id of ids) {
        const set = this.waiters.get(id) ?? new Set<() => void>();
        set.add(wake);
        this.waiters.set(id, set);
      }
      // A task can have moved between the first check and this registration.
      wake();
    });
  }

  private wakeWaiters(taskId: string): void {
    for (const wake of [...(this.waiters.get(taskId) ?? [])]) wake();
  }

  /** The question a waiting child raised, by title only: a request body is not the parent's business. */
  private pendingQuestion(tasks: StoredTask[]): { taskId: string; requestId: string | null; title: string } | null {
    const task = tasks.find((t) => t.state === "waiting_for_user");
    if (!task) return null;
    const request: InteractionRequest | undefined = this.childChat(task)
      ?.snapshot()
      .pending.find((r) => !isApproval(r));
    return { taskId: task.id, requestId: request?.id ?? null, title: request?.title ?? task.asking ?? "A question" };
  }

  // ---- helpers ------------------------------------------------------------

  private context(caller: Chat): ToolContext {
    return { chat: caller, registry: this.deps.registry, workspaces: this.deps.workspaces, boards: this.deps.boards, profiles: this.deps.profiles };
  }

  private remainingDepth(caller: Chat): number {
    return Math.max(0, this.limits.maxDepth - (caller.lineage?.depth ?? 0));
  }

  private remainingTasks(caller: Chat): number {
    const limits = this.limits;
    const mine = this.tasks.filter((task) => this.ownTaskOf(task, caller));
    const live = mine.filter((task) => task.state !== "result_available").length;
    return Math.max(0, Math.min(limits.maxChildrenPerChat - live, limits.maxTasksPerChat - mine.length, limits.maxLiveTasks - this.liveTasks()));
  }

  private liveTasks(): number {
    return this.tasks.filter((task) => task.state !== "result_available").length;
  }

  private ownTask(caller: Chat, taskId: string): StoredTask {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) throw denial(404, "unknown_task", `No task ${taskId}`);
    if (!this.ownTaskOf(task, caller)) throw denial(403, "not_your_task", `Task ${taskId} belongs to another chat`);
    return task;
  }

  private childChat(task: StoredTask): Chat | undefined {
    if (task.childChatId === null) return undefined;
    return this.deps.chats.list().find((chat) => chat.chatId === task.childChatId);
  }

  /**
   * A child's items: the live chat's when it is open, else the harness's own session file (the way a
   * resumed chat shows itself before its harness is up, read only, never started). Null when the
   * chat is gone and its harness keeps nothing readable, which is all a caller can be told.
   */
  private async childItems(task: StoredTask): Promise<ChatItem[] | null> {
    const child = this.childChat(task);
    if (child && child.status !== "disposed") return child.snapshot().items;
    const session = task.childSessionId;
    const prefix = `${task.harnessId}:`;
    const adapter = this.deps.registry.get(task.harnessId);
    if (session === null || !session.startsWith(prefix) || !adapter?.readTranscript) return null;
    const read = await adapter.readTranscript({ cwd: task.workspacePath, nativeId: session.slice(prefix.length) }).catch(() => null);
    return read?.items ?? null;
  }

  /** Stop watching a task: it settled, or was cancelled. Its wall clock goes with the watcher. */
  private stopWatching(taskId: string): void {
    this.watchers.get(taskId)?.();
    this.watchers.delete(taskId);
    this.clearWallClock(taskId);
    // The counts stay on the record; only the guard goes, so a revived task is re-armed by its thread_send.
    this.guards.delete(taskId);
    this.noted.delete(taskId);
  }

  private newTaskId(): string {
    for (;;) {
      const id = randomBytes(2).toString("hex");
      if (!this.tasks.some((task) => task.id === id)) return id;
    }
  }

  /**
   * The workspace record a review route can revalidate, by the project path the task
   * already carries: `workspaces.open` hashes the realpath to the same id every open
   * mints, and refreshes the record, so a route's `workspaces.get(id)` finds it.
   */
  private async workspaceIdOf(task: StoredTask): Promise<string> {
    const ws = await this.deps.workspaces.open(task.workspacePath).catch(() => undefined);
    return ws?.id ?? task.parentChatId;
  }

  private async findProfile(idOrName: string) {
    // A shared profile wins its `shared:<name>` handle and its bare name; bots keep theirs.
    const shared = this.deps.profiles ? this.deps.profiles() : [];
    if (idOrName.startsWith("shared:")) {
      const name = idOrName.slice("shared:".length).toLowerCase();
      const seat = shared.find((p) => p.name.toLowerCase() === name);
      if (!seat) throw denial(422, "unknown_profile", `No shared agent profile called ${idOrName.slice("shared:".length)}`);
      return { id: `shared:${seat.name}`, harnessId: seat.harness, model: seat.model, thinkingLevel: seat.thinking, permissionMode: seat.permissionMode, role: "", note: seat.note };
    }
    const bots = this.deps.boards ? await this.deps.boards.listBots() : [];
    const bot = bots.find((b) => b.id === idOrName) ?? bots.find((b) => b.name.toLowerCase() === idOrName.toLowerCase());
    if (bot) return { id: bot.id, harnessId: bot.harnessId, model: bot.model, thinkingLevel: bot.thinkingLevel, permissionMode: bot.permissionMode, role: bot.role, note: firstLine(bot.instructions) };
    const seat = shared.find((p) => p.name.toLowerCase() === idOrName.toLowerCase());
    if (!seat) throw denial(422, "unknown_profile", `No saved bot profile called ${idOrName}`);
    return { id: `shared:${seat.name}`, harnessId: seat.harness, model: seat.model, thinkingLevel: seat.thinking, permissionMode: seat.permissionMode, role: "", note: seat.note };
  }

  /**
   * A child inherits the caller's permission mode; an explicit one must rank at or below
   * the caller's own, by the order the caller's harness lists its modes (broadest last).
   * A mode the caller does not have cannot be ranked, and is never granted.
   */
  private permissionModeFor(caller: Chat, adapter: HarnessAdapter, requested: string | undefined): string | undefined {
    const config = caller.snapshot().config;
    const parentMode = config.permissionMode ?? null;
    const modes = config.permissionModes ?? [];
    const rank = (id: string) => modes.findIndex((mode) => mode.id === id);
    // A harness without permission modes cannot be held to the caller's: only a caller already in
    // its broadest mode (or with none to speak of) may hand work to one, or the child would be freer.
    if (!adapter.capabilities.supportsPermissionMode) {
      if (parentMode !== null && modes.length > 1 && rank(parentMode) < modes.length - 1) {
        throw denial(403, "mode_escalation_denied", `${adapter.displayName} has no permission modes, so it cannot be held to this chat's ${parentMode} mode`);
      }
      if (requested !== undefined) throw denial(400, "unsupported", `${adapter.displayName} has no permission modes`);
      return undefined;
    }
    if (requested === undefined) return parentMode ?? undefined;
    const parentRank = parentMode === null ? -1 : rank(parentMode);
    const wantedRank = rank(requested);
    if (parentRank < 0 || wantedRank < 0 || wantedRank > parentRank) {
      throw denial(403, "mode_escalation_denied", `${requested} is not at or below this chat's own ${parentMode ?? "no"} permission mode`);
    }
    return requested;
  }

  /** The child's error notice, or a plain line when it only set its status. */
  private errorOf(child: Chat): string {
    const items = child.snapshot().items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.kind === "assistant" && item.error) return item.error;
      if (item?.kind === "notice" && item.level === "error") return item.text;
    }
    return "The harness reported an error";
  }

  private lastAnswer(child: Chat): string | null {
    const items = child.snapshot().items;
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item?.kind === "assistant" && item.text.trim() !== "") return item.text;
      if (item?.kind === "user") return null;
    }
    return null;
  }

  private delegateOutput(task: StoredTask): ToolOutput {
    const data = { taskId: task.id, childChatId: task.childChatId, state: task.state, outcome: task.outcome, ...(task.result ? { result: task.result } : {}) };
    if (task.state === "result_available") return { text: `Task ${task.id} did not start.\n${this.describe([task])}`, data };
    return {
      text:
        `Delegated task ${task.id} is ${task.state} in a fresh ${task.harnessId} chat${task.model ? ` (${task.model})` : ""}: "${task.title}". ` +
        `Wait with thread_wait(["${task.id}"]) or check task_status; thread_read("${task.id}") shows its transcript.`,
      data,
    };
  }

  private describe(tasks: StoredTask[], pending?: { taskId: string; title: string } | null): string {
    const lines = tasks.map((task) => this.describeOne(task));
    if (pending) lines.push(`Task ${pending.taskId} is asking: "${pending.title}". The user sees the question too; relay it or answer through the child chat.`);
    return lines.join("\n\n");
  }

  private describeOne(task: StoredTask): string {
    const head = `Task ${task.id} · ${task.state}${task.outcome ? ` (${task.outcome})` : ""} · ${task.harnessId}${task.model ? ` ${task.model}` : ""}${task.role ? ` · ${task.role}` : ""} · ${formatElapsed((task.endedAt ?? Date.now()) - task.createdAt)}${task.isolation !== null && !this.reviewDecisionOf(task) ? " · unreviewed" : ""}`;
    const body = [`"${task.title}"`];
    if (task.result) {
      if (task.result.finalText) body.push(task.result.finalText);
      if (task.result.error) body.push(`Error: ${task.result.error}`);
      if (task.state === "result_available") body.push(`thread_read("${task.id}") for more; thread_send("${task.id}", …) to continue it.`);
    } else if (task.activity) {
      body.push(task.activity);
    }
    return [head, ...body].join("\n");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** The words a stale review record names: what moved, by the reason the heads check kept. */
function staleWords(reason: string | null): string {
  if (reason === "lead_moved") return "the lead checkout moved";
  if (reason === "worker_changed") return "the worker's branch moved";
  if (reason === "workspace_gone") return "the workspace is gone";
  return "the heads moved";
}
