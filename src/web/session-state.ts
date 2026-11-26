// What a sidebar row says about its session besides its title: the one muted subline under the title —
// the project it is out of, the status its agent set, or a branch that is not the folder's trunk — and
// nothing else. Pure, so the flat Recent list, the sections above it, and the grouped Projects list all
// state a session the same way, and the rules are unit-tested without a DOM.
import type { AgentStatusState, ProjectSession } from "../shared/protocol.js";
import { agentStatusText } from "./agent-status.js";
import type { ProjectTag } from "./recent-view.js";
import { isTrunkBranch } from "./session-groups.js";

/** The one muted line under a title. */
export type RowSubline =
  /** The project the row is out of: its badge and name, and its branch when that is not the trunk. */
  | { kind: "tag"; tag: ProjectTag }
  /** The line the row's own agent set for itself: its words, its state, and when it wrote it. */
  | { kind: "agent"; text: string; state: AgentStatusState; line: string; at: number }
  /** The branch the row's project is checked out on, when it is not one it treats as its trunk. */
  | { kind: "branch"; text: string };

/**
 * The subline a row shows, or null when it has nothing to add (the row is then one line):
 *  - out of its project (`tag`), say which project — the flat list, and the sections above the folders;
 *  - inside its project, the agent's own status line, else a branch that is not the trunk one. Inside a
 *    project on `main` the branch is the folder head's fact, so repeating it says nothing.
 */
export function rowSubline(s: ProjectSession, opts: { tag?: ProjectTag | null; branch?: string | null }): RowSubline | null {
  if (opts.tag) return { kind: "tag", tag: opts.tag };
  if (s.agentStatus) {
    const { state, comment, at } = s.agentStatus;
    return { kind: "agent", text: comment || agentStatusText(s.agentStatus), state, line: agentStatusText(s.agentStatus), at };
  }
  const branch = opts.branch ?? null;
  return branch !== null && !isTrunkBranch(branch) ? { kind: "branch", text: branch } : null;
}

/** The leading slot a row's 10px mark takes, in the order the row chooses one. */
export type RowMark = "working" | "needs" | "harness" | "blank";

/** The one state word the right-hand slot can carry in place of the age, and its one colour. */
export interface RowWord {
  text: "Needs you" | "Working" | "Done";
  tone: "warn" | "accent" | "ok";
}

/** The quieter facts that share ONE muted glyph to the left of the age, in priority order. */
export interface RowGlyph {
  kind: "handover" | "herdr" | "parked";
  className: string;
  label: string;
}

export interface RowState {
  mark: RowMark;
  /** The word in the age's place, or null where the age stays. */
  word: RowWord | null;
  glyph: RowGlyph | null;
  unread: boolean;
}

/**
 * What a row's two state slots say (the plan's colour contract, docs/ui.md):
 *  - the leading mark is a run's ring, the amber question of a row waiting on you, or — in a list that
 *    mixes harnesses — the harness's dot; a list of one harness keeps the slot but not the colour;
 *  - the right-hand slot is ONE word when the session has one to say (Needs you, Working, Done), else
 *    the age: a snoozed row keeps its wake time, which is its state;
 *  - the parked / herdr / handover marks collapse into one glyph (handover wins over herdr wins over
 *    parked); the card names the rest.
 * Nothing else on the row is coloured: amber is needs-you, accent is a run or the word for one, green is
 * done, and unread is the title's weight.
 */
export function rowState(s: ProjectSession, opts: { working: boolean; showHarness: boolean; now?: number }): RowState {
  const snoozed = (s.snoozedUntil ?? 0) > (opts.now ?? Date.now());
  const mark: RowMark = opts.working && !s.asking ? "working" : s.asking ? "needs" : opts.showHarness ? "harness" : "blank";
  return { mark, word: rowWord(s, opts.working, snoozed), glyph: rowGlyph(s), unread: s.unread === true };
}

function rowWord(s: ProjectSession, working: boolean, snoozed: boolean): RowWord | null {
  if (snoozed) return null;
  if (s.asking) return { text: "Needs you", tone: "warn" };
  if (working) return { text: "Working", tone: "accent" };
  // Green is the agent's own verdict, and only a made one: review counts as done for now.
  const state = s.agentStatus?.state;
  if (state === "done" || state === "review") return { text: "Done", tone: "ok" };
  return null;
}

function rowGlyph(s: ProjectSession): RowGlyph | null {
  if (s.handover) {
    const line = s.handoverCommand ? `Handed to a terminal: ${s.handoverCommand}` : "Handed to a terminal";
    return { kind: "handover", className: "session-handover", label: line };
  }
  if (s.herdr) {
    const { paneId, status } = s.herdr;
    return { kind: "herdr", className: `session-herdr is-${status}`, label: `Open in herdr, pane ${paneId} (${status})` };
  }
  // A live chat is this server's own writer; a parked one is a child that was put to sleep (and a live
  // chat is never parked).
  if (s.parked && !s.liveChatId) {
    return { kind: "parked", className: "session-parked", label: "Parked: the agent was parked after sitting idle; opening it resumes the same session" };
  }
  return null;
}
