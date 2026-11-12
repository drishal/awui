// Sessions handed off to a terminal, in the state folder: when a chat is closed for
// the purpose of resuming it in the harness's own CLI, the server records the exact
// quoted resume line and refuses to resume the session here until a client says it is
// reclaiming it — a second writer must not start during the handover. The lock is one
// click to undo (the reclaim), and goes stale after a week: a handover nobody reclaims
// should not hold the session forever. The harness's session files are never touched,
// and nothing is run: the user pastes the line into their own terminal.
import path from "node:path";
import { isObj, readJson, writeJson } from "./state-file.js";

/** How many handovers one file keeps: a bound on the file. */
export const MAX_HANDOVERS = 50;
/** A handover older than this is dropped: a lock from last month is not this week's handover. */
export const HANDOVER_TTL_MS = 7 * 24 * 60 * 60_000;
/** A session id as the file keeps it: namespaced and opaque. */
const MAX_ID_CHARS = 512;
/** One shell line, quoted; more is not a resume line anyone pasted. */
const MAX_COMMAND_CHARS = 2000;

/** A handover as the file keeps it: the line, and when it was recorded. */
interface HandoverMark {
  command: string;
  at: number;
}

export class Handovers {
  private readonly bySession = new Map<string, HandoverMark>();

  private constructor(private readonly file: string | null) {}

  static inMemory(): Handovers {
    return new Handovers(null);
  }

  static async open(stateDir: string): Promise<Handovers> {
    const store = new Handovers(path.join(stateDir, "handovers.json"));
    const raw = await readJson(store.file);
    if (isObj(raw)) {
      const now = Date.now();
      for (const [id, mark] of Object.entries(raw)) {
        if (!isObj(mark)) continue;
        if (typeof mark.command !== "string" || mark.command.length === 0 || mark.command.length > MAX_COMMAND_CHARS) continue;
        if (typeof mark.at !== "number" || !Number.isFinite(mark.at) || id.length === 0 || id.length > MAX_ID_CHARS) continue;
        store.bySession.set(id, { command: mark.command, at: mark.at });
      }
      store.trim(now);
    }
    return store;
  }

  /** The session's handover: the line that took it over, or null. */
  get(sessionId: string): string | null {
    return this.bySession.get(sessionId)?.command ?? null;
  }

  has(sessionId: string): boolean {
    return this.bySession.has(sessionId);
  }

  /** Record the handover: one write for the whole file. */
  async set(sessionId: string, command: string, at = Date.now()): Promise<void> {
    if (sessionId.length === 0 || sessionId.length > MAX_ID_CHARS) return;
    this.bySession.set(sessionId, { command: command.slice(0, MAX_COMMAND_CHARS), at });
    this.trim(at);
    await writeJson(this.file, Object.fromEntries([...this.bySession].map(([id, mark]) => [id, mark])));
  }

  /** Take the handover (a reclaim): the line it held, or null. */
  async take(sessionId: string): Promise<string | null> {
    const mark = this.bySession.get(sessionId);
    if (!mark) return null;
    this.bySession.delete(sessionId);
    await writeJson(this.file, Object.fromEntries([...this.bySession].map(([id, m]) => [id, m])));
    return mark.command;
  }

  /** The sessions still locked, oldest first (a test's and logs' view). */
  all(now = Date.now()): string[] {
    this.trim(now);
    return [...this.bySession.entries()].sort((a, b) => a[1].at - b[1].at).map(([id]) => id);
  }

  /** Forget the stale ones, and keep the newest MAX_HANDOVERS. */
  private trim(now: number): void {
    for (const [id, mark] of this.bySession) if (now - mark.at > HANDOVER_TTL_MS) this.bySession.delete(id);
    if (this.bySession.size <= MAX_HANDOVERS) return;
    const newest = [...this.bySession.entries()].sort((a, b) => b[1].at - a[1].at).slice(0, MAX_HANDOVERS);
    this.bySession.clear();
    for (const [id, mark] of newest) this.bySession.set(id, mark);
  }
}
