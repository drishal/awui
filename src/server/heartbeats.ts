// The heartbeats this server keeps: an agent-scoped schedule whose due runs prompt the
// exact chat session that scheduled it, in $XDG_STATE_HOME/awui/heartbeats.json. The
// owner is kept server-side only — the harness id and the native session id of the chat
// that called schedule_heartbeat — never a token: tokens expire and are never persisted,
// while a schedule is. The timer asks what is due (the same 30 s tick the routines
// timer runs on) and the runner revives the owner chat by its harness session, the way
// a user's resume does; a heartbeat without a target to deliver to logs the skip and
// its next slot is spent, never respawning a scheduler nobody asked for.
//
// One writer per native session is ChatManager's rule: a heartbeat resumes the same
// session the chat carried, so an open target is reused and a closed one revived, and
// two live instances can never write one session file.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { HeartbeatView, RoutineOutcome, ScheduleHeartbeatInput } from "../shared/protocol.js";
import { isObj, readJson, writeJson } from "./state-file.js";

/** Heartbeats this server keeps in the store, and one chat may schedule. */
export const MAX_HEARTBEATS = 50;
export const MAX_HEARTBEATS_PER_CHAT = 8;

/** Why a heartbeat's run was skipped or how it ended: one bounded line, or null. */
export const MAX_DETAIL_CHARS = 300;

export interface StoredHeartbeat {
  id: string;
  name: string;
  prompt: string;
  intervalMs: number;
  maxRuns: number;
  /** The chat that scheduled this, by its harness identity: the target of every run. */
  ownerHarnessId: string;
  /** The owner's native session id, without the namespace: `pi:abc` carries `abc`. */
  ownerNativeId: string;
  /** The workspace the validated token was bound to: a run never opens another. */
  workspacePath: string;
  createdAt: number;
  /** Null while the heartbeat runs; the timer's "stop at the first not yet due" needs it. */
  nextRunAt: number | null;
  /** How many runs it has had (a skipped one counts: its slot was used). */
  runs: number;
  /** Epoch ms of the last attempt, or null before the first. */
  lastRunAt: number | null;
  /** What the last attempt came to: "launched", "skipped", or "failed". */
  lastRunOutcome: RoutineOutcome | null;
  lastRunDetail: string | null;
  /** Set when it reached its cap and says why, so a due slot is not looked for again. */
  halted: string | null;
  cancelledAt: number | null;
}

const OUTCOMES = ["launched", "skipped", "failed"] as const;
type Outcome = (typeof OUTCOMES)[number];

function outcomeOf(raw: unknown): Outcome | null {
  return OUTCOMES.includes(raw as Outcome) ? (raw as Outcome) : null;
}

function detailOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim().slice(0, MAX_DETAIL_CHARS);
  return text || null;
}

function num(raw: unknown, low: number, high: number, fallback: number): number {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= low && raw <= high ? raw : fallback;
}

function at(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : null;
}

/** A stored heartbeat, kept only when it still reads (a hand-edited file loses nothing else). */
function clean(raw: unknown): StoredHeartbeat | null {
  if (!isObj(raw)) return null;
  const id = typeof raw.id === "string" && raw.id ? raw.id : null;
  const name = typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : null;
  const prompt = typeof raw.prompt === "string" && raw.prompt.trim() ? raw.prompt : null;
  const harness = typeof raw.ownerHarnessId === "string" && raw.ownerHarnessId ? raw.ownerHarnessId : null;
  const native = typeof raw.ownerNativeId === "string" && raw.ownerNativeId ? raw.ownerNativeId : null;
  const workspace = typeof raw.workspacePath === "string" && raw.workspacePath ? raw.workspacePath : null;
  if (!id || !name || !prompt || !harness || !native || !workspace) return null;
  const interval = num(raw.intervalMs, 5 * 60_000, 24 * 60 * 60_000, 0);
  if (interval === 0) return null;
  const cancelled = at(raw.cancelledAt);
  return {
    id,
    name,
    prompt,
    intervalMs: interval,
    maxRuns: num(raw.maxRuns, 1, 10_000, 10_000),
    ownerHarnessId: harness,
    ownerNativeId: native,
    workspacePath: workspace,
    createdAt: at(raw.createdAt) ?? Date.now(),
    nextRunAt: cancelled !== null ? null : at(raw.nextRunAt),
    runs: num(raw.runs, 0, 10_000, 0),
    lastRunAt: at(raw.lastRunAt),
    lastRunOutcome: outcomeOf(raw.lastRunOutcome),
    lastRunDetail: detailOf(raw.lastRunDetail),
    halted: detailOf(raw.halted),
    cancelledAt: cancelled,
  };
}

/** The wire view: the record without its server-only workspace binding. */
export function viewOf(heartbeat: StoredHeartbeat): HeartbeatView {
  return {
    id: heartbeat.id,
    name: heartbeat.name,
    prompt: heartbeat.prompt,
    intervalMs: heartbeat.intervalMs,
    maxRuns: heartbeat.maxRuns,
    runs: heartbeat.runs,
    nextRunAt: heartbeat.nextRunAt,
    lastRunAt: heartbeat.lastRunAt,
    lastRunOutcome: heartbeat.lastRunOutcome,
    lastRunDetail: heartbeat.lastRunDetail,
    halted: heartbeat.halted,
    cancelledAt: heartbeat.cancelledAt,
    ownerSessionId: `${heartbeat.ownerHarnessId}:${heartbeat.ownerNativeId}`,
  };
}

export class Heartbeats {
  private readonly byId = new Map<string, StoredHeartbeat>();

  private constructor(private readonly file: string | null) {}

  static inMemory(): Heartbeats {
    return new Heartbeats(null);
  }

  static async open(stateDir: string): Promise<Heartbeats> {
    const store = new Heartbeats(path.join(stateDir, "heartbeats.json"));
    const raw = await readJson(store.file);
    if (isObj(raw) && isObj(raw.heartbeats)) {
      for (const value of Object.values(raw.heartbeats)) {
        const heartbeat = clean(value);
        if (heartbeat) store.byId.set(heartbeat.id, heartbeat);
      }
    }
    return store;
  }

  /** The soonest first (a halted one last), so the timer can stop at the first not yet due. */
  all(): StoredHeartbeat[] {
    return [...this.byId.values()].sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || a.name.localeCompare(b.name));
  }

  get(id: string): StoredHeartbeat | undefined {
    return this.byId.get(id);
  }

  /** This chat's heartbeats: the owner is the exact session, so a resumed chat keeps its own. */
  forOwner(harnessId: string, nativeId: string): StoredHeartbeat[] {
    return this.all().filter((heartbeat) => heartbeat.ownerHarnessId === harnessId && heartbeat.ownerNativeId === nativeId);
  }

  /** How many heartbeats this server keeps for one owner, against the per-chat cap. */
  countForOwner(harnessId: string, nativeId: string): number {
    let count = 0;
    for (const heartbeat of this.byId.values()) if (heartbeat.ownerHarnessId === harnessId && heartbeat.ownerNativeId === nativeId) count += 1;
    return count;
  }

  /**
   * Schedule one: the owner identity and workspace come from the calling chat and its
   * validated token binding, spelled by the caller, never taken from the raw arguments.
   */
  async save(owner: { harnessId: string; nativeId: string; workspacePath: string }, input: ScheduleHeartbeatInput, now = Date.now()): Promise<StoredHeartbeat> {
    if (this.byId.size >= MAX_HEARTBEATS) throw new Error(`At most ${MAX_HEARTBEATS} heartbeats on this server`);
    if (this.countForOwner(owner.harnessId, owner.nativeId) >= 8) throw new Error("A chat may schedule at most 8 heartbeats");
    const heartbeat: StoredHeartbeat = {
      id: randomUUID(),
      name: input.name,
      prompt: input.prompt,
      intervalMs: input.intervalMs,
      maxRuns: input.maxRuns ?? 10_000,
      ownerHarnessId: owner.harnessId,
      ownerNativeId: owner.nativeId,
      workspacePath: owner.workspacePath,
      createdAt: now,
      nextRunAt: now + input.intervalMs,
      runs: 0,
      lastRunAt: null,
      lastRunOutcome: null,
      lastRunDetail: null,
      halted: null,
      cancelledAt: null,
    };
    this.byId.set(heartbeat.id, heartbeat);
    await this.persist();
    return heartbeat;
  }

  /** A routine that just ran counts the time and moves to its next slot (or stops, and says why). */
  async markRan(id: string, at = Date.now()): Promise<StoredHeartbeat | undefined> {
    const heartbeat = this.byId.get(id);
    if (!heartbeat || heartbeat.cancelledAt !== null) return undefined;
    const runs = heartbeat.runs + 1;
    const next: StoredHeartbeat = { ...heartbeat, runs, lastRunAt: at };
    if (heartbeat.maxRuns !== null && runs >= heartbeat.maxRuns) {
      next.nextRunAt = null;
      next.halted = `stopped after ${runs} run${runs === 1 ? "" : "s"} (its maxRuns)`;
    } else {
      next.nextRunAt = at + heartbeat.intervalMs;
    }
    this.byId.set(id, next);
    await this.persist();
    return next;
  }

  /** How the claimed slot ended: a skip's reason, or a failure's. */
  async markOutcome(id: string, outcome: Outcome, detail: string | null = null): Promise<StoredHeartbeat | undefined> {
    const heartbeat = this.byId.get(id);
    if (!heartbeat) return undefined;
    const next: StoredHeartbeat = { ...heartbeat, lastRunOutcome: outcome, lastRunDetail: detailOf(detail) };
    this.byId.set(id, next);
    await this.persist();
    return next;
  }

  /** Cancel by id; `false` is no such heartbeat or one this chat does not own. */
  async cancel(id: string, harnessId: string, nativeId: string): Promise<boolean> {
    const heartbeat = this.byId.get(id);
    if (!heartbeat || heartbeat.ownerHarnessId !== harnessId || heartbeat.ownerNativeId !== nativeId) return false;
    if (heartbeat.cancelledAt !== null) return true;
    const next: StoredHeartbeat = { ...heartbeat, cancelledAt: Date.now(), nextRunAt: null };
    this.byId.set(id, next);
    await this.persist();
    return true;
  }

  /** What is due now: alive, not halted, and its slot has come. */
  due(now = Date.now()): StoredHeartbeat[] {
    return this.all().filter((heartbeat) => heartbeat.cancelledAt === null && heartbeat.halted === null && heartbeat.nextRunAt !== null && heartbeat.nextRunAt <= now);
  }

  private persist(): Promise<void> {
    return writeJson(this.file, { heartbeats: Object.fromEntries(this.byId) });
  }
}
