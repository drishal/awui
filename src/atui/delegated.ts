// Delegated work in a terminal, apart from the drawing: each worker's row (its status, who runs
// it, its clock, its scope and what the guard saw), where the cursor may stand, the window a list
// shows, and the key that runs each review action. The words are the web UI's
// (web/delegated-tasks.ts, web/context-panel.ts), so a row reads the same in both clients; this
// file only decides what a terminal draws of it.
import type { DelegatedTaskView } from "../shared/protocol.js";
import type { StatusReadout } from "../web/context-panel.js";
import { taskReadout } from "../web/context-panel.js";
import { guardWords, metaText, scopeWords, taskElapsed, taskLine, stateWords } from "../web/delegated-tasks.js";

/** One worker as the panel's list draws it: what it is doing, who runs it, and how long it has run. */
export interface TaskRow {
  key: string;
  task: DelegatedTaskView;
  title: string;
  /** Harness · model · role, as the web UI's small print. */
  meta: string;
  status: StatusReadout;
  /** The same word the status pill carries, for a terminal that draws no pill. */
  word: string;
  elapsed: string;
  /** The child's question, its last line, or the first line of its answer. */
  line: string | null;
  /** The write scope it was held to, when it carries one. */
  scope: string | null;
  /** What the scope guard saw, when it saw anything. */
  guard: string | null;
  /** Whether the worker has finished (nothing is left to cancel). */
  finished: boolean;
  /** Whether its finished work can be reviewed from here (it ran in a managed checkout). */
  reviewable: boolean;
}

export function taskRows(tasks: DelegatedTaskView[], now: number, harnessName: (id: string) => string): TaskRow[] {
  return tasks.map((task) => ({
    key: task.id,
    task,
    title: task.title || task.id,
    meta: metaText(task, harnessName),
    status: taskReadout(task),
    word: stateWords(task),
    elapsed: taskElapsed(task, now),
    line: taskLine(task),
    scope: scopeWords(task),
    guard: guardWords(task),
    finished: task.state === "result_available",
    reviewable: task.reviewable && task.state === "result_available",
  }));
}

/** The cursor `by` rows from `at`, held at the ends (a list never wraps: the ends are the ends). */
export function moveRow(count: number, at: number, by: number): number {
  if (count === 0) return 0;
  return Math.max(0, Math.min(count - 1, at + by));
}

/** The first row of a `height`-row window holding row `at`, held inside the list. */
export function rowWindow(total: number, at: number, height: number): number {
  return Math.max(0, Math.min(at - Math.floor(height / 2), total - height));
}

/** The key that runs each review action, the same in both terminal clients (shown in their footers). */
export const ACTION_KEYS: Record<"apply" | "discard" | "unreview" | "cleanup", string> = { apply: "a", discard: "k", unreview: "u", cleanup: "d" };

/** A count as the panel writes it: "1 worker", "3 workers". */
export const workerCount = (n: number): string => `${n} ${n === 1 ? "worker" : "workers"}`;

/**
 * How a task's clock reads at the right of its row: how long it has run, or how long it took,
 * and never a figure it does not have.
 */
export function clockNote(row: TaskRow): string {
  return row.finished ? `took ${row.elapsed}` : `running ${row.elapsed}`;
}
