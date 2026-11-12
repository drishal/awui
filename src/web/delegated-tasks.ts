// The words and numbers a delegated task's row carries: the chip's state, who runs it, its last
// line, its clock, and the group's count line. Pure, so the panel and its unit tests share them.
import type { DelegatedState, DelegatedTaskView } from "../shared/protocol.js";
import { formatSpan } from "./turn-time.js";

/** How much of "harness · model · role" a row carries: it is a line of small print, not the title. */
const META_CHARS = 42;

/** The agent behind a task: the harness's name, then its model, role, and profile when they say something. */
export function metaText(task: DelegatedTaskView, harnessName: (id: string) => string): string {
  const parts = [harnessName(task.harnessId), task.model, task.role, task.profile].filter((p): p is string => typeof p === "string" && p !== "");
  return bound(parts.join(" · "), META_CHARS);
}

/** The chip's class: how a finished task ended, else what it is doing (both are stylesheet words). */
export function stateClass(task: DelegatedTaskView): string {
  return task.state === "result_available" ? (task.outcome ?? "interrupted") : task.state;
}

/** Cut a line to what the row can carry, saying that it was cut. */
function bound(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** The chip's words: an outcome once a task has finished, else what it is doing. */
export function stateWords(task: DelegatedTaskView): string {
  if (task.state === "result_available") {
    if (task.outcome === "done") return "Done";
    if (task.outcome === "failed") return "Failed";
    if (task.outcome === "cancelled") return "Cancelled";
    return "Interrupted";
  }
  if (task.state === "working") return "Working";
  return "Waiting";
}

/** What the row says under its title: the child's own last line, its question, or its answer's first line. */
export function taskLine(task: DelegatedTaskView): string | null {
  if (task.asking) return `Asks: ${task.asking}`;
  if (task.activity) return task.activity;
  const result = task.result;
  if (!result) return null;
  if (result.error) return result.error;
  const first = result.finalText.split("\n").find((line) => line.trim() !== "");
  return first?.trim() ?? null;
}

/** How long a task has run, or how long it took. */
export function taskElapsed(task: DelegatedTaskView, now: number): string {
  return formatSpan((task.endedAt ?? now) - task.createdAt);
}

/** "1 working · 2 done": the group's meta line, or null when every row has ended. */
export function tasksMeta(tasks: DelegatedTaskView[]): string | null {
  const count = (states: DelegatedState[]) => tasks.filter((task) => states.includes(task.state)).length;
  const working = count(["working", "waiting_for_user", "waiting_for_children"]);
  const done = count(["result_available"]);
  const parts = [working > 0 ? `${working} working` : null, done > 0 ? `${done} finished` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}
