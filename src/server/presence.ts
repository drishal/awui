// Presence: which connected client has which chat or room visibly focused, so
// a notification for a target the user is already looking at is not sent. The
// web client reports on focus, blur, visibility and tab switches and keeps the
// entry alive with a heartbeat; an entry that stops heartbeating expires. The
// table is in memory only and carries ids and flags, never conversation
// content — nothing here is written to the state folder.

const ENTRY_TTL_MS = 60_000;
/** Bounded: a handful of devices times a few tabs each; the oldest reports go first. */
const MAX_CLIENTS = 200;

export interface PresenceTarget {
  chatId?: string | null;
  roomId?: string | null;
}

interface Entry {
  chatId: string | null;
  roomId: string | null;
  visible: boolean;
  focused: boolean;
  at: number;
}

export class PresenceTable {
  private readonly entries = new Map<string, Entry>();

  private constructor() {}

  static inMemory(): PresenceTable {
    return new PresenceTable();
  }

  /** One client's latest report replaces its earlier one (a tab reports a new target on every switch). */
  report(clientId: string, target: { chatId: string | null; roomId: string | null }, visible: boolean, focused: boolean, now = Date.now()): void {
    this.prune(now);
    // Delete first so Map order stays oldest-report-first and eviction stays fair.
    this.entries.delete(clientId);
    this.entries.set(clientId, { chatId: target.chatId, roomId: target.roomId, visible, focused, at: now });
    while (this.entries.size > MAX_CLIENTS) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  /** Whether any live entry reports a client visibly focused on this target (chat and room are separate surfaces). */
  viewed(target: PresenceTarget, now = Date.now()): boolean {
    for (const e of this.entries.values()) {
      if (now - e.at >= ENTRY_TTL_MS) continue;
      if (!e.visible || !e.focused) continue;
      if (target.chatId != null && e.chatId === target.chatId) return true;
      if (target.roomId != null && e.roomId === target.roomId) return true;
    }
    return false;
  }

  private prune(now: number): void {
    for (const [id, e] of this.entries) if (now - e.at >= ENTRY_TTL_MS) this.entries.delete(id);
  }
}
