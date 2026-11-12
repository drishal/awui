// What a delegated task is while it runs, as the state folder keeps it: the browser's
// wire view (protocol.ts) plus the fields only the server needs — the child's workspace
// path, the generation that drops late work from a cancel, and the wake ledger. No
// transcript is kept here: the child's conversation lives in its harness's own session
// file, and this record holds a bounded result and pointers, nothing else.
import { z } from "zod";
import type { DelegatedTaskView, HarnessId, SessionUsage } from "../../shared/protocol.js";
import { ChatError } from "../chats/chat.js";

/** A terminal row older than this is pruned at load and at each write. */
export const MAX_TASK_AGE_MS = 7 * 24 * 60 * 60_000;
/** Records in the file, and how much of a child's answer the record keeps. */
export const MAX_TASKS = 200;
export const MAX_RESULT_CHARS = 4_000;
export const MAX_TITLE_CHARS = 120;
export const MAX_ACTIVITY_CHARS = 300;
export const MAX_ERROR_CHARS = 500;
export const TASK_SCHEMA_VERSION = 1;

/**
 * The write scope a delegated task was held to (A5): the globs its tool writes must match
 * (empty: anywhere in the project), the private scratch dir it alone was given, and what the
 * guard saw while it ran — attempted (every out-of-scope write seen), how many were blocked
 * before they ran, and how many landed and could only be reported. The wording lives here so a
 * status row, a wake report, and thread_read all read the same counts.
 */
export interface TaskScope {
  globs: string[];
  scratchDir: string | null;
  attempted: number;
  blocked: number;
  landed: number;
  /** The newest out-of-scope writes, as the rows the child chat drew (scope.ts's wording). */
  recent: string[];
}

/** At-least-once finish delivery: `pendingSince` is written before the parent is woken. */
export interface TaskWake {
  pendingSince: number | null;
  deliveredAt: number | null;
  attempts: number;
  /** Why a wake was not delivered, when it was skipped on purpose. */
  skipped: string | null;
}

/** Server-only; never sent to the browser as such (viewOf strips it). */
export interface StoredTask extends DelegatedTaskView {
  workspacePath: string;
  /** The parent chat's title when it delegated: a resumed child's chip must still name it. */
  parentTitle: string | null;
  /**
   * The two chats' session ids, which outlive a chat object: a chat id is minted on every
   * open, so a reopened parent or child is found again by the harness session it carries.
   */
  parentSessionId: string | null;
  childSessionId: string | null;
  /** Cancel bumps it; work arriving from an older generation is dropped. */
  generation: number;
  cancelRequestedAt: number | null;
  /** One group whose result arrives together only when every member settles; server-only bookkeeping. */
  completionGroup?: string | null;
  /** Wake the parent with the result (`wake`, the default) or report only when asked. */
  notify: "wake" | "none";
  clientRequestId: string | null;
  wake: TaskWake;
  /**
   * The worktree the task's child worked in when it ran isolated (`isolation: "worktree"`):
   * the managed worktree's id, its branch, and the fork point. Null when it shared the
   * caller's tree. The review gates on these heads (review.ts), never on the chat.
   */
  isolation: { worktreeId: string; branch: string; fork: string } | null;
  /** The write scope the child was held to; null (or absent on a row that predates it) for a task that carries none — the scope's counts say what the guard saw. */
  scope?: TaskScope | null;
}

const usageSchema = z.custom<SessionUsage | null>((value) => value === null || (typeof value === "object" && !Array.isArray(value)));

const viewShape = {
  id: z.string().min(1).max(16),
  parentChatId: z.string().min(1).max(128),
  childChatId: z.string().min(1).max(128).nullable(),
  title: z.string().max(MAX_TITLE_CHARS),
  harnessId: z.custom<HarnessId>((value) => typeof value === "string" && value.length > 0 && value.length <= 64),
  model: z.string().max(512).nullable(),
  role: z.string().max(64),
  profile: z.string().max(128).nullable(),
  depth: z.number().int().min(0).max(8),
  state: z.enum(["working", "waiting_for_user", "waiting_for_children", "result_available"]),
  outcome: z.enum(["done", "failed", "cancelled", "interrupted"]).nullable(),
  createdAt: z.number(),
  endedAt: z.number().nullable(),
  activity: z.string().max(MAX_ACTIVITY_CHARS).nullable(),
  result: z
    .object({ finalText: z.string().max(MAX_RESULT_CHARS), error: z.string().max(MAX_ERROR_CHARS).nullable(), usage: usageSchema })
    .nullable(),
  asking: z.string().max(200).nullable(),
};

export const storedTaskSchema = z.object({
  ...viewShape,
  workspacePath: z.string().min(1).max(4096),
  parentTitle: z.string().max(200).nullable(),
  parentSessionId: z.string().max(512).nullable(),
  childSessionId: z.string().max(512).nullable(),
  generation: z.number().int().min(0),
  cancelRequestedAt: z.number().nullable(),
  notify: z.enum(["wake", "none"]),
  clientRequestId: z.string().max(128).nullable(),
  completionGroup: z.string().max(128).nullable().optional(),
  wake: z.object({
    pendingSince: z.number().nullable(),
    deliveredAt: z.number().nullable(),
    attempts: z.number().int().min(0).max(10),
    skipped: z.string().max(200).nullable(),
  }),
  isolation: z
    .object({ worktreeId: z.string().min(1).max(64), branch: z.string().min(1).max(256), fork: z.string().regex(/^[0-9a-f]{40}$/) })
    .nullable()
    .optional(),
  scope: z
    .object({
      globs: z.array(z.string().min(1).max(128)).max(8),
      scratchDir: z.string().max(4096).nullable(),
      attempted: z.number().int().min(0),
      blocked: z.number().int().min(0),
      landed: z.number().int().min(0),
      recent: z.array(z.string().max(400)).max(8),
    })
    .nullable()
    .optional(),
});

/** One row from the file, or null when it is malformed: the child's session is the truth, so a bad row is dropped. */
export function parseStoredTask(value: unknown): StoredTask | null {
  const parsed = storedTaskSchema.safeParse(value);
  // Records written before worktree isolation carry no `isolation` field: normalized to
  // null, so an old shared-tree task is never read as an isolated one.
  return parsed.success ? { ...parsed.data, isolation: parsed.data.isolation ?? null, reviewable: (parsed.data.isolation ?? null) !== null } : null;
}

/** What the browser and a tool call see: the stored record without its server-only fields. */
export function viewOf(task: StoredTask): DelegatedTaskView {
  return {
    id: task.id,
    parentChatId: task.parentChatId,
    childChatId: task.childChatId,
    title: task.title,
    harnessId: task.harnessId,
    model: task.model,
    role: task.role,
    profile: task.profile,
    depth: task.depth,
    state: task.state,
    outcome: task.outcome,
    createdAt: task.createdAt,
    endedAt: task.endedAt,
    activity: task.activity,
    result: task.result,
    asking: task.asking,
    scope: task.scope,
    reviewable: task.isolation !== null,
  };
}

/** Newest first, terminal rows older than a week pruned, then the oldest terminal rows past the cap. */
export function pruneTasks(tasks: StoredTask[], now: number): StoredTask[] {
  const live = tasks.filter((task) => task.state !== "result_available" || (task.endedAt ?? task.createdAt) >= now - MAX_TASK_AGE_MS);
  live.sort((a, b) => b.createdAt - a.createdAt);
  while (live.length > MAX_TASKS) {
    // Drop the oldest terminal row; a live one is never dropped.
    let victim = -1;
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i]?.state === "result_available") {
        victim = i;
        break;
      }
    }
    if (victim < 0) break;
    live.splice(victim, 1);
  }
  return live;
}

/**
 * Whether a task's work has been through a person's review (A6: "completed" is not
 * "reviewed"). A task that ran isolated is reviewed only when its integration record
 * carries a decision; one that shared the caller's tree has nothing to review — its
 * edits landed in the caller's own working tree, where the caller already sees them.
 * Pure, so the orchestrator, the panel, and the tests share the one rule.
 */
export function isReviewed(task: Pick<StoredTask, "isolation">, reviewed: boolean): boolean {
  return task.isolation === null || reviewed;
}

/** A single line from a child's text, cut to what an activity row shows. */
export function firstLine(text: string, limit = MAX_ACTIVITY_CHARS): string | null {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** "4m12s", "38s", "1h04m": how long a task has run, short enough for a status row or a wake envelope. */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** Every denial an orchestration call can answer with, as the REST envelope, the HTTP MCP
 * result's `structuredContent`, and the bridges all name it. The human sentence rides beside
 * the code; the code is the half an agent tests against. */
export const ORCH_DENIAL_CODES = [
  "unknown_tool",
  "orch_off",
  "bad_orch_token",
  "orch_token_expired",
  "invalid_request",
  "too_many_calls",
  "max_depth",
  "too_many_tasks",
  "caller_read_only",
  "unknown_harness",
  "harness_unavailable",
  "workspace_unsupported",
  "store_failed",
  "unknown_workspace",
  "unknown_task",
  "not_your_task",
  "not_delegated",
  "task_not_running",
  "cannot_send",
  "cancel_timeout",
  "unknown_profile",
  "mode_escalation_denied",
  "invalid_plan",
  "plan_not_draft",
  "plan_running",
  "plan_dependency_failed",
  "unknown_plan",
  "scope_collision",
  "bad_scope",
  "no_session",
  "unsupported",
] as const;
export type OrchDenialCode = (typeof ORCH_DENIAL_CODES)[number];

/** A refusal with its typed code: thrown as the ChatError the routes map, never losing the sentence. */
export function denial(status: number, code: OrchDenialCode, message: string): ChatError {
  return new ChatError(status, code, message);
}
