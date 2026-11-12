// Sessions that were mid-run when this server stopped, in the state folder: the
// harness's child dies with the process, so nothing of the run survives but its
// intent. The server records the sessions that were running as it shuts down, and the
// next time one of them is opened here it sends one prompt — "Resume working." — so the
// agent picks the work up instead of waiting for a word. It never starts a harness by
// itself: a restart that fired model calls for chats nobody opened would spend money on
// a screen nobody is looking at. An intent is one use, and goes stale after a day.
import path from "node:path";
import { isObj, readJson, writeJson } from "./state-file.js";

/** What the run is told when its chat is reopened: the agent carries on from where it stopped. */
export const RESUME_TEXT = "Resume working.";
/** How many sessions one shutdown may record: a bound on the file, and on the prompts a reopen could send. */
export const MAX_INTENTS = 50;
/** An intent older than this is dropped: work from last week is not what this chat was doing. */
export const INTENT_TTL_MS = 24 * 60 * 60_000;

export class ResumeIntents {
  /** Session id → when it was recorded. */
  private readonly bySession = new Map<string, number>();

  private constructor(private readonly file: string | null) {}

  static inMemory(): ResumeIntents {
    return new ResumeIntents(null);
  }

  static async open(stateDir: string): Promise<ResumeIntents> {
    const store = new ResumeIntents(path.join(stateDir, "resume-intents.json"));
    const raw = await readJson(store.file);
    if (isObj(raw)) {
      for (const [id, at] of Object.entries(raw)) {
        if (typeof at === "number" && Number.isFinite(at) && id.length > 0 && id.length <= 200) store.bySession.set(id, at);
      }
    }
    return store;
  }

  /** Record the sessions that were running: one write for all of them. */
  async markMany(sessionIds: readonly string[], at = Date.now()): Promise<void> {
    const fresh = sessionIds.filter((id) => id.length > 0 && id.length <= 200 && !this.bySession.has(id)).slice(0, MAX_INTENTS);
    if (fresh.length === 0) return;
    for (const id of fresh) this.bySession.set(id, at);
    this.trim(at);
    await writeJson(this.file, Object.fromEntries(this.bySession));
  }

  /** Take a session's intent (one use): true when this chat should carry on by itself. */
  async take(sessionId: string, now = Date.now()): Promise<boolean> {
    this.trim(now);
    if (!this.bySession.delete(sessionId)) return false;
    await writeJson(this.file, Object.fromEntries(this.bySession));
    return true;
  }

  /** The sessions still recorded, oldest first (a test's and logs' view). */
  all(now = Date.now()): string[] {
    this.trim(now);
    return [...this.bySession.entries()].sort((a, b) => a[1] - b[1]).map(([id]) => id);
  }

  /** Forget the stale ones, and keep the newest MAX_INTENTS. */
  private trim(now: number): void {
    for (const [id, at] of this.bySession) if (now - at > INTENT_TTL_MS) this.bySession.delete(id);
    if (this.bySession.size <= MAX_INTENTS) return;
    const newest = [...this.bySession.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_INTENTS);
    this.bySession.clear();
    for (const [id, at] of newest) this.bySession.set(id, at);
  }
}
