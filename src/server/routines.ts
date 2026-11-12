// The routines this server keeps: a prompt on a cadence, in a project, on a
// harness, in $XDG_STATE_HOME/awui/routines.json. nextRunAt is stored rather than
// derived on read, because the timer asks what is due now; saving, editing, and
// running a routine recompute it from shared/routine-schedule.ts. The last
// outcome is stored too, so the list can say why a slot skipped without a chat.
// A routine can also stop for good — its expiry passed, or it reached maxRuns — and
// then says why ("halted"), so a routine nobody switched off does not look due again.
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { MAX_RUN_DETAIL_CHARS, type Routine, type RoutineInput, type RoutineOutcome, routineSchema } from "../shared/protocol.js";
import { cadenceProblem, nextRunAt } from "../shared/routine-schedule.js";
import { isObj, readJson, writeJson } from "./state-file.js";

export const MAX_ROUTINES = 50;

const OUTCOMES: readonly RoutineOutcome[] = ["launched", "skipped", "failed", "posted", "quiet"];

/** A stored outcome, or null for a file written before outcomes were kept (and for a hand-edited one). */
function outcomeOf(raw: unknown): RoutineOutcome | null {
  return OUTCOMES.includes(raw as RoutineOutcome) ? (raw as RoutineOutcome) : null;
}

/** Why a run skipped or failed, or what it posted: one bounded line, or null. Anything else is dropped. */
export function runDetail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().slice(0, MAX_RUN_DETAIL_CHARS);
  return text || null;
}

/** A stored routine, kept only when it still validates (a hand-edited file loses nothing else). */
function clean(raw: unknown): Routine | null {
  if (!isObj(raw)) return null;
  const parsed = routineSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { id, nextRunAt: at, lastRunAt, lastRunOutcome, lastRunDetail, runs, halted } = raw as {
    id?: unknown;
    nextRunAt?: unknown;
    lastRunAt?: unknown;
    lastRunOutcome?: unknown;
    lastRunDetail?: unknown;
    runs?: unknown;
    halted?: unknown;
  };
  if (typeof id !== "string" || !id) return null;
  if (at !== null && (typeof at !== "number" || !Number.isFinite(at))) return null;
  if (lastRunAt !== null && typeof lastRunAt !== "number") return null;
  return {
    ...parsed.data,
    id,
    nextRunAt: (at as number | null) ?? null,
    halted: typeof halted === "string" && halted.trim() ? halted.trim().slice(0, MAX_RUN_DETAIL_CHARS) : null,
    runs: typeof runs === "number" && Number.isInteger(runs) && runs >= 0 ? runs : 0,
    lastRunAt: (lastRunAt as number | null) ?? null,
    lastRunOutcome: outcomeOf(lastRunOutcome),
    lastRunDetail: runDetail(lastRunDetail),
  };
}

/**
 * Where a routine stands after the slot at `at`: its next one, or the reason it has none.
 * `runs` is how many it has had, this slot included.
 */
function advance(routine: Pick<Routine, "cadence" | "timezone" | "until" | "maxRuns">, runs: number, at: number): { nextRunAt: number | null; halted: string | null } {
  if (routine.maxRuns !== null && runs >= routine.maxRuns) return { nextRunAt: null, halted: `stopped after ${runs} run${runs === 1 ? "" : "s"} (its maxRuns)` };
  const next = nextRunAt(routine.cadence, at, routine.timezone);
  if (next === null) return { nextRunAt: null, halted: routine.cadence.kind === "once" ? "ran its one time" : "has no further run" };
  if (routine.until !== null && next > routine.until) return { nextRunAt: null, halted: `stopped at its expiry (${new Date(routine.until).toISOString()})` };
  return { nextRunAt: next, halted: null };
}

export class Routines {
  private readonly byId = new Map<string, Routine>();

  private constructor(private readonly file: string | null) {}

  static inMemory(): Routines {
    return new Routines(null);
  }

  static async open(stateDir: string): Promise<Routines> {
    const store = new Routines(path.join(stateDir, "routines.json"));
    const raw = await readJson(store.file);
    if (isObj(raw)) {
      for (const value of Object.values(raw)) {
        const routine = clean(value);
        if (routine) store.byId.set(routine.id, routine);
      }
    }
    return store;
  }

  /** The soonest first (one with no further run last), so the timer can stop at the first one not yet due. */
  all(): Routine[] {
    return [...this.byId.values()].sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.name.localeCompare(b.name));
  }

  get(id: string): Routine | undefined {
    return this.byId.get(id);
  }

  /** Create or replace one; a new routine gets an id and its first run time. */
  async save(input: RoutineInput, now = Date.now()): Promise<Routine> {
    // Parsed here as well as at the route: this is the last stop before disk, and
    // the schema is what supplies `enabled` and refuses a cadence that cannot run.
    const parsed = routineSchema.parse(input);
    // The route checks this first and says which field; here it is the last stop before disk.
    const problem = cadenceProblem(parsed.cadence, now, parsed.timezone);
    if (problem) throw new Error(problem);
    const existing = parsed.id === undefined ? undefined : this.byId.get(parsed.id);
    if (!existing && this.byId.size >= MAX_ROUTINES) throw new Error(`At most ${MAX_ROUTINES} routines`);
    // A hook with no secret yet is the dialog asking for one: minted here, never guessed.
    if (parsed.hook && !parsed.hook.secret) parsed.hook.secret = randomBytes(24).toString("hex");
    const runs = existing?.runs ?? 0;
    // A save is the owner saying "this is what I want now", so it also clears a halt: the
    // next slot is computed afresh from the new cadence, expiry, and cap.
    const standing = advance(parsed, runs, now);
    const routine: Routine = {
      ...parsed,
      id: existing?.id ?? randomUUID(),
      ...standing,
      runs,
      lastRunAt: existing?.lastRunAt ?? null,
      lastRunOutcome: existing?.lastRunOutcome ?? null,
      lastRunDetail: existing?.lastRunDetail ?? null,
    };
    this.byId.set(routine.id, routine);
    await this.persist();
    return routine;
  }

  async remove(id: string): Promise<boolean> {
    if (!this.byId.delete(id)) return false;
    await this.persist();
    return true;
  }

  /** A routine that just ran counts the time and moves to its next slot (or stops, and says why). */
  async markRan(id: string, at = Date.now()): Promise<Routine | undefined> {
    const routine = this.byId.get(id);
    if (!routine) return undefined;
    const runs = routine.runs + 1;
    const next: Routine = { ...routine, runs, lastRunAt: at, ...advance(routine, runs, at) };
    this.byId.set(id, next);
    await this.persist();
    return next;
  }

  /**
   * What the claimed slot came to. markRan already moved the times (a skip gets its
   * next slot too); this only says how it ended, so the list can show a skipped precheck.
   */
  async markOutcome(id: string, outcome: RoutineOutcome, detail: string | null = null): Promise<Routine | undefined> {
    const routine = this.byId.get(id);
    if (!routine) return undefined;
    const next: Routine = { ...routine, lastRunOutcome: outcome, lastRunDetail: runDetail(detail) };
    this.byId.set(id, next);
    await this.persist();
    return next;
  }

  /** What the timer should start now: enabled, not stopped for good, and its slot has come. */
  due(now = Date.now()): Routine[] {
    return this.all().filter((routine) => routine.enabled && routine.halted === null && routine.nextRunAt !== null && routine.nextRunAt <= now);
  }

  private persist(): Promise<void> {
    return writeJson(this.file, Object.fromEntries(this.byId));
  }
}
