// The routines timer's one decision, kept out of the wiring so it can be tested:
// which due routines to start now. Each is marked as run *before* it starts, so a
// start that throws (or a tick that overlaps) cannot run the same routine twice;
// the next slot is its retry. How the slot ended is recorded after: a precheck can
// skip it, and a start can fail. A failure does not stop the others.
import type { Routine, RoutineOutcome } from "../shared/protocol.js";

/** What a started routine came to: a chat (launched), or a precheck's reason for skipping it. */
export interface StartOutcome {
  outcome: "launched" | "skipped";
  detail?: string | null;
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
