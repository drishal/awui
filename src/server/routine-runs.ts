// A routine's run history, in $XDG_STATE_HOME/awui/routine-runs.json: what each run
// came to (an answer worth posting, a quiet run, a failure, or a precheck's skip) so
// the list can say it after the chat it opened is gone. One entry is written when the
// run starts and rewritten when it ends, so a server killed mid-run leaves a record
// that says "launched"; a run's session is also how the session list knows a session
// belongs to a routine rather than to the user (it is not shown among the user's). The
// sessions are kept after their run is pruned or its routine deleted, so a deleted
// routine does not pour a year of nights back into the sidebar.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { Routine, RoutineOutcome, RoutineRun } from "../shared/protocol.js";
import { runDetail } from "./routines.js";
import { isObj, readJson, writeJson } from "./state-file.js";

/** A routine's own history: enough to read back the last few nights, not a log. */
export const MAX_RUNS_PER_ROUTINE = 20;
/** Everything together, so the file stays small however many routines there are. */
export const MAX_RUNS = 200;
/** Sessions remembered as a routine's own, after their run record went: the hidden-session list. */
export const MAX_HIDDEN = 500;

const OUTCOMES: readonly RoutineOutcome[] = ["launched", "skipped", "failed", "posted", "quiet"];
const outcomeOf = (raw: unknown): RoutineOutcome | null => (OUTCOMES.includes(raw as RoutineOutcome) ? (raw as RoutineOutcome) : null);
const sessionOf = (raw: unknown): string | null => (typeof raw === "string" && raw.length > 0 && raw.length <= 200 ? raw : null);

/** A stored run, kept only when it still reads (a hand-edited file loses nothing else). */
function clean(raw: unknown): RoutineRun | null {
  if (!isObj(raw)) return null;
  const { id, routineId, name, startedAt, endedAt, outcome, detail, chatId, sessionId } = raw;
  const kind = outcomeOf(outcome);
  if (typeof id !== "string" || !id) return null;
  if (typeof routineId !== "string" || !routineId) return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  if (!kind) return null;
  return {
    id,
    routineId,
    name: typeof name === "string" ? name.slice(0, 80) : "",
    startedAt,
    endedAt: typeof endedAt === "number" && Number.isFinite(endedAt) ? endedAt : null,
    outcome: kind,
    detail: runDetail(detail),
    chatId: typeof chatId === "string" && chatId ? chatId : null,
    sessionId: sessionOf(sessionId),
  };
}

export class RoutineRuns {
  /** Oldest first, so dropping from the front is dropping the oldest. */
  private runs: RoutineRun[] = [];
  /** Sessions a routine opened, oldest first: hidden even after their run record is gone. */
  private hidden = new Map<string, number>();

  private constructor(private readonly file: string | null) {}

  static inMemory(): RoutineRuns {
    return new RoutineRuns(null);
  }

  static async open(stateDir: string): Promise<RoutineRuns> {
    const store = new RoutineRuns(path.join(stateDir, "routine-runs.json"));
    const raw = await readJson(store.file);
    // A bare array is what this file held before the hidden sessions were kept beside the runs.
    const runs = Array.isArray(raw) ? raw : isObj(raw) ? raw.runs : null;
    if (Array.isArray(runs)) store.runs = runs.map(clean).filter((r): r is RoutineRun => r !== null);
    store.runs = store.runs.slice(-MAX_RUNS);
    if (isObj(raw) && Array.isArray(raw.hidden)) {
      for (const value of raw.hidden) if (typeof value === "string" && value) store.remember(value, 0);
    }
    for (const run of store.runs) if (run.sessionId) store.remember(run.sessionId, run.startedAt);
    return store;
  }

  /** A run that just started: its chat is not open yet, and its outcome is not known. */
  async start(routine: Routine, at = Date.now()): Promise<RoutineRun> {
    const run: RoutineRun = { id: randomUUID(), routineId: routine.id, name: routine.name, startedAt: at, endedAt: null, outcome: "launched", detail: null, chatId: null, sessionId: null };
    this.runs.push(run);
    await this.trim(routine.id);
    await this.persist();
    return run;
  }

  /** The chat a going run opened, recorded while it runs so the list can offer to open it. */
  async attach(id: string, chatId: string): Promise<void> {
    const run = this.runs.find((r) => r.id === id);
    if (!run || run.chatId === chatId) return;
    run.chatId = chatId;
    await this.persist();
  }

  /** What the run came to; a missing record (pruned, or a hand-edited file) is not an error. */
  async finish(id: string, result: { outcome: RoutineOutcome; detail: string | null; chatId?: string | null; sessionId?: string | null; at?: number }): Promise<RoutineRun | undefined> {
    const run = this.runs.find((r) => r.id === id);
    if (!run) return undefined;
    run.outcome = result.outcome;
    run.endedAt = result.at ?? Date.now();
    run.detail = runDetail(result.detail);
    if (result.chatId !== undefined) run.chatId = result.chatId;
    if (result.sessionId !== undefined) run.sessionId = sessionOf(result.sessionId);
    if (run.sessionId) this.remember(run.sessionId, run.startedAt);
    await this.persist();
    return { ...run };
  }

  /** A routine's runs, newest first, or every routine's when none is named. */
  list(routineId?: string, limit = MAX_RUNS_PER_ROUTINE): RoutineRun[] {
    const out: RoutineRun[] = [];
    for (let i = this.runs.length - 1; i >= 0 && out.length < limit; i--) {
      const run = this.runs[i];
      if (!run) continue;
      if (routineId !== undefined && run.routineId !== routineId) continue;
      out.push({ ...run });
    }
    return out;
  }

  /** Whether this session was opened by a routine: such a session is not listed among the user's own. */
  ownsSession(sessionId: string): boolean {
    return this.hidden.has(sessionId) || this.runs.some((run) => run.sessionId === sessionId);
  }

  /** The same for a chat still starting, before its harness assigned a session. */
  ownsChat(chatId: string): boolean {
    return this.runs.some((run) => run.chatId === chatId);
  }

  /**
   * A deleted routine leaves no run records behind, but the sessions it opened stay known:
   * un-hiding them would pour every night it ran back into the sidebar at once.
   */
  async forget(routineId: string): Promise<void> {
    const before = this.runs.length;
    this.runs = this.runs.filter((run) => run.routineId !== routineId);
    if (this.runs.length !== before) await this.persist();
  }

  /** Remember a session as a routine's own, keeping the newest MAX_HIDDEN. */
  private remember(sessionId: string, at: number): void {
    if (!this.hidden.has(sessionId)) this.hidden.set(sessionId, at);
    while (this.hidden.size > MAX_HIDDEN) {
      const oldest = this.hidden.keys().next().value;
      if (oldest === undefined) break;
      this.hidden.delete(oldest);
    }
  }

  /** Keep the newest few per routine and the newest few overall. */
  private async trim(routineId: string): Promise<void> {
    const mine = this.runs.filter((run) => run.routineId === routineId);
    if (mine.length > MAX_RUNS_PER_ROUTINE) {
      const drop = new Set(mine.slice(0, mine.length - MAX_RUNS_PER_ROUTINE).map((run) => run.id));
      this.runs = this.runs.filter((run) => !drop.has(run.id));
    }
    if (this.runs.length > MAX_RUNS) this.runs = this.runs.slice(-MAX_RUNS);
  }

  private persist(): Promise<void> {
    return writeJson(this.file, { runs: this.runs, hidden: [...this.hidden.keys()] });
  }
}
