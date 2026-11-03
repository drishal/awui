// The todo list as a tree, the way omp's TUI draws it: phases in order, each
// with a numeral and its done/total, the tasks hanging under it. A list with no
// phases (Claude's TodoWrite, Pi's todo) stays one flat branch. Pure: the
// status stack draws it.
import type { TodoItem } from "../shared/protocol.js";

export interface TodoPhase {
  /** The phase's name, or null for tasks that belong to none. */
  name: string | null;
  /** "I.", "II.", …: only when the list has phases at all. */
  numeral: string | null;
  items: TodoItem[];
  done: number;
  /** A task in it is under way. */
  active: boolean;
}

export const isDone = (status: string): boolean => /done|complete/.test(status);
export const isActive = (status: string): boolean => /progress|active|doing/.test(status);

const ROMAN: Array<[number, string]> = [
  [10, "X"],
  [9, "IX"],
  [5, "V"],
  [4, "IV"],
  [1, "I"],
];

/** 1 → "I", 14 → "XIV" (a list of phases is never long). */
export function roman(n: number): string {
  let out = "";
  let left = n;
  for (const [value, letters] of ROMAN) {
    while (left >= value) {
      out += letters;
      left -= value;
    }
  }
  return out;
}

/** Consecutive tasks of one phase become that phase; the order is the harness's. */
export function todoTree(todos: readonly TodoItem[]): TodoPhase[] {
  const phases: TodoPhase[] = [];
  for (const todo of todos) {
    const name = todo.phase?.trim() || null;
    let phase = phases[phases.length - 1];
    if (!phase || phase.name !== name) {
      phase = { name, numeral: null, items: [], done: 0, active: false };
      phases.push(phase);
    }
    phase.items.push(todo);
    if (isDone(todo.status)) phase.done += 1;
    if (isActive(todo.status)) phase.active = true;
  }
  const named = phases.some((p) => p.name !== null);
  let n = 0;
  for (const phase of phases) if (named && phase.name !== null) phase.numeral = `${roman(++n)}.`;
  return phases;
}

/** The job ids a task names ("run e2e as bg_19", "waiting on bg-2"), so its row can show the job's state. */
export function jobIdsIn(text: string, known: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\b(bg[_-]\d+)\b/g)) if (known.has(m[1] as string) && !out.includes(m[1] as string)) out.push(m[1] as string);
  return out;
}
