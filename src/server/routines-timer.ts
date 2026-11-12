// The routines timer's one decision, kept out of the wiring so it can be tested:
// which due routines to start now. Each is marked as run *before* it starts, so a
// start that throws (or a tick that overlaps) cannot run the same routine twice;
// the next slot is its retry. How the slot ended is recorded after: a precheck can
// skip it, and a start can fail. A failure does not stop the others.
//
// A routine with a grace window spends a missed slot without starting: a laptop that
// was asleep through the night must not start an agent on last night's work at noon,
// and the list says the slot was missed rather than run.
import type { Routine, RoutineOutcome } from "../shared/protocol.js";

/** What a started routine came to: a chat (launched), or a precheck's reason for skipping it. */
export interface StartOutcome {
  outcome: "launched" | "skipped";
  detail?: string | null;
}

/** How late a missed slot is, in the list's words: "12 min", "5 h", "2 days". */
export function lateWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} days`;
}

/** The store's part of the timer: what is due, marking one as run, and how it ended. */
export interface RoutineDue {
  due(now: number): Routine[];
  markRan(id: string, at: number): Promise<Routine | undefined>;
  markOutcome(id: string, outcome: RoutineOutcome, detail: string | null): Promise<Routine | undefined>;
}

/** Starts every routine due at `now`; answers the ids it launched (a skip started no chat). */
export async function startDue(
  store: RoutineDue,
  start: (routine: Routine) => Promise<StartOutcome | void>,
  now = Date.now(),
  report: (routine: Routine, error: unknown) => void = () => undefined,
): Promise<string[]> {
  const started: string[] = [];
  for (const routine of store.due(now)) {
    const late = routine.nextRunAt === null ? 0 : now - routine.nextRunAt;
    if (routine.graceMinutes > 0 && late > routine.graceMinutes * 60_000) {
      // Claimed like any slot (so it is spent either way), then recorded as missed.
      if (!(await store.markRan(routine.id, now))) continue;
      await store.markOutcome(routine.id, "skipped", `missed its slot by ${lateWords(late)} (grace ${routine.graceMinutes} min)`);
      continue;
    }
    // Claimed before the work: a throw must not leave it due for the next tick.
    const claimed = await store.markRan(routine.id, now);
    if (!claimed) continue;
    try {
      const result = await start(routine);
      const outcome = result?.outcome ?? "launched";
      await store.markOutcome(routine.id, outcome, outcome === "skipped" ? (result?.detail ?? null) : null);
      if (outcome !== "skipped") started.push(routine.id);
    } catch (error) {
      report(routine, error);
      await store.markOutcome(routine.id, "failed", error instanceof Error ? error.message : String(error));
    }
  }
  return started;
}
