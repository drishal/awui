// A session's status line, as its own agent sets it: one word for where the work
// stands and one free-text line saying what it is doing — "blocked on the flaky
// test in auth", "ready for review". An agent sets it through the orchestration
// tool surface (set_status); a person reads it in the sidebar's row, the chat's
// header, and its hover card, without opening the chat. Kept per native session
// in the state folder, so a resumed chat and every device see the same line.
// Bounded: the comment is cut to MAX_STATUS_CHARS, and the file keeps the newest
// MAX_STATUS_ENTRIES sessions only.
import type { AgentStatusLine, AgentStatusState } from "../shared/protocol.js";
import { isObj, readJson, writeJson } from "./state-file.js";

/** One status line's comment: long enough for a sentence, short enough for a row. */
export const MAX_STATUS_CHARS = 200;
/** Sessions whose line is kept; the oldest drop out first (their file is the harness's, not ours). */
export const MAX_STATUS_ENTRIES = 500;

const STATES: readonly AgentStatusState[] = ["working", "blocked", "review", "done"];

/** A stored state, when it names one (the file may hold anything). */
export const asStatusState = (v: unknown): AgentStatusState | null => (STATES as readonly unknown[]).includes(v) ? (v as AgentStatusState) : null;

/** The comment as it is kept: one line, collapsed spaces, cut to the cap. */
export function cleanComment(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > MAX_STATUS_CHARS ? `${line.slice(0, MAX_STATUS_CHARS - 1).trimEnd()}…` : line;
}

export class AgentStatuses {
  /** Newest last, so trimming the oldest is one shift. */
  private readonly lines = new Map<string, AgentStatusLine>();
  /** The file's write order: oldest first. */
  private readonly order: string[] = [];

  private constructor(private readonly file: string | null) {}

  static inMemory(): AgentStatuses {
    return new AgentStatuses(null);
  }

  static async open(file: string | null): Promise<AgentStatuses> {
    const store = new AgentStatuses(file);
    const raw = await readJson(file);
    if (!isObj(raw)) return store;
    for (const [sessionId, line] of Object.entries(raw)) {
      if (!isObj(line)) continue;
      const state = asStatusState(line.state);
      if (!state || typeof line.at !== "number" || typeof line.comment !== "string") continue;
      const value: AgentStatusLine = { state, comment: cleanComment(line.comment), at: line.at };
      store.lines.set(sessionId, value);
      store.order.push(sessionId);
    }
    return store;
  }

  get(sessionId: string): AgentStatusLine | undefined {
    return this.lines.get(sessionId);
  }

  /** Set one session's line: the caller validates the state, this bounds the text and the file. */
  set(sessionId: string, state: AgentStatusState, comment: string, at = Date.now()): Promise<AgentStatusLine> {
    const line: AgentStatusLine = { state, comment: cleanComment(comment), at };
    this.lines.set(sessionId, line);
    const at2 = this.order.indexOf(sessionId);
    if (at2 >= 0) this.order.splice(at2, 1);
    this.order.push(sessionId);
    while (this.order.length > MAX_STATUS_ENTRIES) {
      const oldest = this.order.shift();
      if (oldest !== undefined) this.lines.delete(oldest);
    }
    return writeJson(this.file, Object.fromEntries(this.lines)).then(() => line);
  }
}
