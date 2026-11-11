// What a delegated task is while it runs, as the state folder keeps it: the browser's
// wire view (protocol.ts) plus the fields only the server needs — the child's workspace
// path, the generation that drops late work from a cancel, and the wake ledger. No
// transcript is kept here: the child's conversation lives in its harness's own session
// file, and this record holds a bounded result and pointers, nothing else.
import { z } from "zod";
import type { DelegatedTaskView, HarnessId, SessionUsage } from "../../shared/protocol.js";

/** A terminal row older than this is pruned at load and at each write. */
export const MAX_TASK_AGE_MS = 7 * 24 * 60 * 60_000;
/** Records in the file, and how much of a child's answer the record keeps. */
export const MAX_TASKS = 200;
export const MAX_RESULT_CHARS = 4_000;
export const MAX_TITLE_CHARS = 120;
export const MAX_ACTIVITY_CHARS = 300;
export const MAX_ERROR_CHARS = 500;
export const TASK_SCHEMA_VERSION = 1;

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
  /** Wake the parent with the result (`wake`, the default) or report only when asked. */
  notify: "wake" | "none";
  clientRequestId: string | null;
  wake: TaskWake;
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
  wake: z.object({
    pendingSince: z.number().nullable(),
    deliveredAt: z.number().nullable(),
    attempts: z.number().int().min(0).max(10),
    skipped: z.string().max(200).nullable(),
  }),
});

/** One row from the file, or null when it is malformed: the child's session is the truth, so a bad row is dropped. */
export function parseStoredTask(value: unknown): StoredTask | null {
  const parsed = storedTaskSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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

/** A single line from a child's text, cut to what an activity row shows. */
export function firstLine(text: string, limit = MAX_ACTIVITY_CHARS): string | null {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}
