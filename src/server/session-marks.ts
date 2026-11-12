// Pinned, archived, settled, and snoozed sessions: marks this server keeps for
// every device, in its own state file. The harness's session files are never
// touched. A session is in one place in the list: setting one of the four
// clears the others (snoozing keeps nothing either). The same file remembers
// how a session began (a routine's slot), which is the one origin only this
// server can know: an agent-delegated child's comes from the orchestration
// records instead.
//
// The one decision kept here besides the marks: which sessions a sweep settles
// because nobody has touched them for days (config.yml's settle_after_days).
import path from "node:path";
import type { SessionMarkState, SessionOrigin } from "../shared/protocol.js";
import { isObj, readJson, writeJson } from "./state-file.js";

/** A mark as the file keeps it: a place (or none), seen or not, and how it began. */
export interface SessionMark extends SessionMarkState {
  /** Set by the server, never by a client: the marks route does not accept it. */
  origin?: SessionOrigin;
}

export interface MarkChange {
  pinned?: boolean;
  archived?: boolean;
  settled?: boolean;
  snoozedUntil?: number | null;
  /** Seen? Kept beside a place, never in place of one. */
  unread?: boolean;
  /** The server hibernated this chat's harness child (server-set only; the marks route refuses it). */
  parked?: boolean;
  /** Set exactly the given marks and clear the rest. */
  replace?: boolean;
}

function clean(raw: Record<string, unknown>): SessionMark {
  return {
    ...(raw.pinned === true ? { pinned: true } : {}),
    ...(raw.archived === true ? { archived: true } : {}),
    ...(raw.settled === true ? { settled: true } : {}),
    ...(typeof raw.snoozedUntil === "number" && raw.snoozedUntil > 0 ? { snoozedUntil: raw.snoozedUntil } : {}),
    ...(raw.unread === true ? { unread: true } : {}),
    ...(raw.parked === true ? { parked: true } : {}),
    ...(raw.origin === "routine" || raw.origin === "agent" ? { origin: raw.origin } : {}),
  };
}

const empty = (m: SessionMark) => !m.pinned && !m.archived && !m.settled && !m.snoozedUntil && !m.unread && !m.parked && !m.origin;

/** A session as the sweep sees it: its id and the harness's own last-activity time. */
export interface SweepCandidate {
  id: string;
  updatedAt: string | null;
}

/**
 * The sessions to settle now: last touched more than `idleDays` ago, and not already
 * somewhere on purpose (pinned, archived, settled, snoozed). A session with no time the
 * harness can read is left alone — age unknown is not old.
 */
export function staleSessions(sessions: readonly SweepCandidate[], marks: SessionMarks, idleDays: number, now = Date.now()): string[] {
  const cutoff = now - idleDays * 86_400_000;
  const out: string[] = [];
  for (const session of sessions) {
    if (!session.updatedAt) continue;
    const at = Date.parse(session.updatedAt);
    if (!Number.isFinite(at) || at > cutoff) continue;
    if (marks.get(session.id)) continue;
    out.push(session.id);
  }
  return out;
}

export class SessionMarks {
  private readonly marks = new Map<string, SessionMark>();

  private constructor(private readonly file: string | null) {}

  static inMemory(): SessionMarks {
    return new SessionMarks(null);
  }

  static async open(stateDir: string): Promise<SessionMarks> {
    const store = new SessionMarks(path.join(stateDir, "session-marks.json"));
    const raw = await readJson(store.file);
    if (isObj(raw)) {
      for (const [id, m] of Object.entries(raw)) {
        if (!isObj(m)) continue;
        const mark = clean(m);
        if (!empty(mark)) store.marks.set(id, mark);
      }
    }
    return store;
  }

  get(sessionId: string): SessionMark | undefined {
    return this.marks.get(sessionId);
  }

  /** What a change makes of one session's current mark: replace wins, else the new place clears the others. */
  private merged(sessionId: string, change: MarkChange): SessionMark {
    // An undo replaces the places, not where the session came from.
    if (change.replace) {
      const origin = this.marks.get(sessionId)?.origin;
      return { ...clean(change as Record<string, unknown>), ...(origin ? { origin } : {}) };
    }
    const next: SessionMark = { ...this.marks.get(sessionId) };
    const only = (keep: keyof SessionMark) => {
      for (const key of ["pinned", "archived", "settled", "snoozedUntil"] as const) if (key !== keep) delete next[key];
    };
    if (change.pinned === true) {
      only("pinned");
      next.pinned = true;
    } else if (change.pinned === false) delete next.pinned;
    if (change.archived === true) {
      only("archived");
      next.archived = true;
    } else if (change.archived === false) delete next.archived;
    if (change.settled === true) {
      only("settled");
      next.settled = true;
    } else if (change.settled === false) delete next.settled;
    if (typeof change.snoozedUntil === "number") {
      only("snoozedUntil");
      next.snoozedUntil = change.snoozedUntil;
    } else if (change.snoozedUntil === null) delete next.snoozedUntil;
    // Unread sits beside a place (pin, settle, snooze) instead of replacing it.
    if (change.unread === true) next.unread = true;
    else if (change.unread === false) delete next.unread;
    // Parked too: the scheduler's mark, beside wherever the session sits. Only the
    // server sets it (the marks route never takes one), so `true` comes from the
    // hibernation hook and `false` from a run starting or the session being read.
    if (change.parked === true) next.parked = true;
    else if (change.parked === false) delete next.parked;
    return next;
  }

  set(sessionId: string, change: MarkChange): Promise<SessionMark> {
    return this.store(sessionId, this.merged(sessionId, change));
  }

  /**
   * Remember how a session began, once. The server's own wiring sets a routine's
   * here (the marks route never takes an origin); a later call keeps the first.
   */
  setOrigin(sessionId: string, origin: SessionOrigin): Promise<SessionMark> {
    const current = this.marks.get(sessionId) ?? {};
    return this.store(sessionId, { ...current, origin });
  }
  /**
   * One change applied to a whole selection, with one write: a loop of `set`
   * would rewrite the file per row and race its own snapshots.
   */
  async setMany(sessionIds: string[], change: MarkChange): Promise<Record<string, SessionMark>> {
    const out: Record<string, SessionMark> = {};
    for (const id of sessionIds) {
      const next = this.merged(id, change);
      if (empty(next)) this.marks.delete(id);
      else this.marks.set(id, next);
      out[id] = next;
    }
    await writeJson(this.file, Object.fromEntries(this.marks));
    return out;
  }

  /**
   * The session failed or asked for something: it is awake whether it was settled or
   * snoozed, since both mean "not now" rather than "not even if I am needed".
   */
  wake(sessionId: string): void {
    this.drop(sessionId, ["settled", "snoozedUntil"]);
  }

  /**
   * A run started in the session: a settled one is back in the list (that is what settled
   * meant), but a snoozed one stays quiet, so a snooze that keeps working does not return
   * on its own — only a failure or a question wakes it (wake, above).
   */
  unsettle(sessionId: string): void {
    this.drop(sessionId, ["settled"]);
  }

  private drop(sessionId: string, keys: ReadonlyArray<keyof SessionMark>): void {
    const mark = this.marks.get(sessionId);
    if (!mark || !keys.some((key) => key in mark)) return;
    const next: SessionMark = { ...mark };
    for (const key of keys) delete next[key];
    // Fire and forget: a failed write must not become an unhandled rejection (Node exits on one).
    this.store(sessionId, next).catch((error: unknown) => console.error(`awui: could not save session marks: ${error instanceof Error ? error.message : String(error)}`));
  }

  private store(sessionId: string, mark: SessionMark): Promise<SessionMark> {
    if (empty(mark)) this.marks.delete(sessionId);
    else this.marks.set(sessionId, mark);
    return writeJson(this.file, Object.fromEntries(this.marks)).then(() => mark);
  }
}
