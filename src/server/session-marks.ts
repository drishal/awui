// Pinned, archived, settled, and snoozed sessions: marks this server keeps for
// every device, in its own state file. The harness's session files are never
// touched. A session is in one place in the list: setting one of the four
// clears the others (snoozing keeps nothing either). The same file remembers
// how a session began (a routine's slot), which is the one origin only this
// server can know: an agent-delegated child's comes from the orchestration
// records instead.
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
    ...(raw.origin === "routine" || raw.origin === "agent" ? { origin: raw.origin } : {}),
  };
}

const empty = (m: SessionMark) => !m.pinned && !m.archived && !m.settled && !m.snoozedUntil && !m.unread && !m.origin;

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

  /** Activity in the session (a run starts, it fails or asks): it is no longer settled or snoozed. */
  wake(sessionId: string): void {
    const mark = this.marks.get(sessionId);
    if (!mark || (!mark.settled && !mark.snoozedUntil)) return;
    const { settled: _s, snoozedUntil: _z, ...rest } = mark;
    // Fire and forget: a failed write must not become an unhandled rejection (Node exits on one).
    this.store(sessionId, rest).catch((error: unknown) => console.error(`awui: could not save session marks: ${error instanceof Error ? error.message : String(error)}`));
  }

  private store(sessionId: string, mark: SessionMark): Promise<SessionMark> {
    if (empty(mark)) this.marks.delete(sessionId);
    else this.marks.set(sessionId, mark);
    return writeJson(this.file, Object.fromEntries(this.marks)).then(() => mark);
  }
}
