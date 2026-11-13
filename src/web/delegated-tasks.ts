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

/**
 * The write scope a worker was held to, in one line: its globs (or "anywhere in the project"
 * when it was given none) and, when it has one, the private scratch folder it may also write.
 */
export function scopeWords(task: DelegatedTaskView): string | null {
  const scope = task.scope;
  if (!scope) return null;
  const where = scope.globs.length > 0 ? scope.globs.join(", ") : "anywhere in the project";
  return scope.scratchDir ? `Scope ${where} · scratch ${scope.scratchDir}` : `Scope ${where}`;
}

/**
 * What the scope guard saw: how many out-of-scope writes it stopped before they ran, and how
 * many landed anyway (a harness that cannot pre-empt a write can only report it). Null when
 * the guard saw nothing, so a clean task says nothing at all.
 */
export function guardWords(task: DelegatedTaskView): string | null {
  const scope = task.scope;
  if (!scope || scope.attempted === 0) return null;
  const parts: string[] = [];
  if (scope.blocked > 0) parts.push(`${scope.blocked} blocked before it ran`);
  if (scope.landed > 0) parts.push(`${scope.landed} landed and reported`);
  if (parts.length === 0) parts.push(`${scope.attempted} seen`);
  return `Out of scope: ${parts.join(" · ")}${scope.recent[0] ? ` · ${scope.recent[0]}` : ""}`;
}

/** The two writes a review record can carry: applied into the lead checkout, or kept without applying. */
export interface ReviewRecordFacts {
  decision: "apply" | "discard";
  note: string;
  by: string;
  at: number;
}

/** A task's integration as its review screen needs it: the record's decision, the heads, and why they do not match. */
export interface ReviewFacts {
  review: ReviewRecordFacts | null;
  appliedAt: number | null;
  discardedAt: number | null;
  /** Whether the recorded heads still stand; null when they could not be read. */
  headsMatch: boolean | null;
  reason: string | null;
}

/**
 * What the review screen says before it offers anything, in the browser's own words: an applied
 * patch (and what undoing it does), a kept one, a moved head, or the choice still to be made.
 */
export function reviewWords(facts: ReviewFacts): string {
  if (facts.appliedAt) return "Approved and applied into the lead checkout. The lead's files changed; no further automatic integration runs here. Undo apply reverses that patch while the checkout still holds exactly it.";
  if (facts.discardedAt) return "Reviewed without applying. The managed worktree stays until you clean it up.";
  if (facts.headsMatch === false) return `Cannot apply yet: ${facts.reason ?? "a recorded head moved"}. Open the worktree to inspect it.`;
  return "The worker finished in its own checkout. Choose whether to apply its patch, or keep it without applying. Nothing starts until you choose.";
}

/** One thing a review screen can do, and whether it may right now (with the reason it may not). */
export interface ReviewAction {
  id: "apply" | "discard" | "unreview" | "cleanup";
  label: string;
  enabled: boolean;
  /** Why the action is off, when it is. */
  why: string | null;
  /** A destructive action asks first (it removes a worktree). */
  confirms: boolean;
}

/**
 * The actions a review screen offers, in order: apply or keep it while nothing is decided,
 * then the inverse of the decision (and, for a kept patch, the cleanup that removes the tree).
 * Apply writes the lead checkout, so a moved head or an unreachable one turns it off.
 */
export function reviewActions(facts: ReviewFacts): ReviewAction[] {
  if (!facts.review) {
    return [
      { id: "apply", label: "Apply patch into lead", enabled: facts.headsMatch !== false, why: facts.headsMatch === false ? (facts.reason ?? "a recorded head moved") : null, confirms: true },
      { id: "discard", label: "Keep it unapplied", enabled: true, why: null, confirms: false },
    ];
  }
  const undo: ReviewAction = { id: "unreview", label: facts.appliedAt ? "Undo apply" : "Back to review", enabled: true, why: null, confirms: false };
  if (facts.appliedAt) return [undo];
  return [undo, { id: "cleanup", label: "Remove managed worktree", enabled: true, why: null, confirms: true }];
}
