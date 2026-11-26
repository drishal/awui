// A sidebar row's title, its line of supporting facts, and its state. In Recent the subline
// names the project, then what its agent says when it set a status, and puts the age at its end; a
// one-line row puts that age beside the title.
// Pure, so the flat Recent list, its sections, and grouped Projects share the same rules.
import type { AgentStatusState, ProjectSession } from "../shared/protocol.js";
import { formatDuration } from "../shared/time-words.js";
import { agentStatusText } from "./agent-status.js";
import type { ProjectTag } from "./recent-view.js";
import { isTrunkBranch } from "./session-groups.js";

/** The one muted line under a title. */
export type RowSubline =
  /**
   * The project the row is out of: its badge and name, its branch when that is not the trunk, and — in
   * place of that branch — the line its own agent set.
   */
  | { kind: "tag"; tag: ProjectTag; status: string | null }
  /** The line the row's own agent set for itself: its words, its state, and when it wrote it. */
  | { kind: "agent"; text: string; state: AgentStatusState; line: string; at: number }
  /** The branch the row's project is checked out on, when it is not one it treats as its trunk. */
  | { kind: "branch"; text: string };

/**
 * The subline a row shows, or null when it has nothing to add (the row is then one line):
 *  - out of its project (`tag`), say which project — the flat list, and the sections above the folders —
 *    and, when its agent set a line, that line first (`tagWords`): one annotation, so the branch gives way;
 *  - inside its project, the agent's own status line, else a branch that is not the trunk one and not
 *    the one its group's head already states (`groupBranch`): a branch is said once, where it applies.
 */
export function rowSubline(s: ProjectSession, opts: { tag?: ProjectTag | null; branch?: string | null; groupBranch?: string | null }): RowSubline | null {
  if (opts.tag) {
    // The status is the fact that changed, so it leads: the tag's words put it before the project it is
    // out of (tagWords below). It takes the branch's place, because two annotations on one line is one
    // too many, and the branch is the group's fact (the head states it) where a status is this row's.
    const status = s.agentStatus ? s.agentStatus.comment || agentStatusText(s.agentStatus) : null;
    // A group head owns its branch: only a worktree row with a different one states it again.
    const tag = status !== null || (opts.groupBranch != null && opts.tag.branch === opts.groupBranch) ? { ...opts.tag, branch: null } : opts.tag;
    return { kind: "tag", tag, status };
  }
  if (s.agentStatus) {
    const { state, comment, at } = s.agentStatus;
    return { kind: "agent", text: comment || agentStatusText(s.agentStatus), state, line: agentStatusText(s.agentStatus), at };
  }
  const branch = opts.branch ?? null;
  if (branch === null || branch === opts.groupBranch || isTrunkBranch(branch)) return null;
  return { kind: "branch", text: branch };
}

/**
 * The words a tagged row says after its badge. The agent's own line comes first — it is the fact that
 * changed, and the project is where the row lives — then the project, after a `·`: `ready to merge ·
 * awui-wt`. A branch rides after the project's name only where no status took its place.
 */
export function tagWords(tag: ProjectTag, status: string | null): string {
  const project = tag.branch ? `${tag.name} · ${tag.branch}` : tag.name;
  return status ? `${status} · ${project}` : project;
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
 *  - the meta holds the age, or one state word elsewhere than its own Needs-you/Working section.
 *    Inside either section the row's mark and heading carry the state, so no word repeats it.
 *  - the parked / herdr / handover marks collapse into one glyph (handover wins over herdr wins over
 *    parked); the card names the rest.
 * Nothing else on the row is coloured: amber is needs-you, accent is a run or the word for one, green is
 * done, and unread is the title's weight.
 */
export function rowState(s: ProjectSession, opts: { working: boolean; showHarness: boolean; section?: "needs" | "working" | null; now?: number }): RowState {
  const snoozed = (s.snoozedUntil ?? 0) > (opts.now ?? Date.now());
  const mark: RowMark = opts.working && !s.asking ? "working" : s.asking ? "needs" : opts.showHarness ? "harness" : "blank";
  return { mark, word: rowWord(s, opts.working, snoozed, opts.section), glyph: rowGlyph(s), unread: s.unread === true };
}

function rowWord(s: ProjectSession, working: boolean, snoozed: boolean, section?: "needs" | "working" | null): RowWord | null {
  if (snoozed) return null;
  if ((s.asking && section === "needs") || (working && section === "working")) return null;
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

/**
 * How long the run in this row has been going, in words ("12s", "1m 4s"), or null when its start is not
 * known and the row should keep its age. A working row's only clock is its last activity, which for a live
 * chat is the prompt that started the run (the server stamps it on the user's message); a listing that
 * says nothing, or a clock that reads ahead of ours, leaves the age in place rather than inventing a start.
 * The reader is scanning for "is this going anywhere", so the elapsed time belongs where the age would sit.
 */
export function runElapsed(s: ProjectSession, now: number): string | null {
  const start = s.updatedAt === null ? Number.NaN : Date.parse(s.updatedAt);
  if (!Number.isFinite(start) || start > now) return null;
  return formatDuration(now - start);
}
