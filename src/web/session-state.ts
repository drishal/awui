// A sidebar row's title, its line of supporting facts, its state, and its native tooltip. In Recent the
// subline names the project, then what its agent says when it set a status, and puts the age at its end; a
// one-line row puts that age beside the title.
// Pure, so the flat Recent list, its sections, and grouped Projects share the same rules.
import type { AgentStatusLine, AgentStatusState, ProjectSession } from "../shared/protocol.js";
import { formatDuration } from "../shared/time-words.js";
import { AGENT_STATUS_WORDS, agentStatusText } from "./agent-status.js";
import { plainTitle } from "./plain-title.js";
import type { ProjectTag } from "./recent-view.js";
import { isTrunkBranch } from "./session-groups.js";

/**
 * The fact a tagged row says before the project it is out of:
 *  - `state`: the word for the state an agent reported, with the sentence it wrote under it as a note — a
 *    `blocked` row says both (`blocked · waiting on CI`), because a note alone read as a finished row;
 *  - `words`: everything else the agent said, one sentence (`ready to merge`).
 */
export type TagFact = { kind: "state"; word: string; note: string | null } | { kind: "words"; text: string };

/** The one muted line under a title. */
export type RowSubline =
  /**
   * The project the row is out of: its badge and name, its branch when that is not the trunk, and — in
   * place of that branch — the fact its own agent stated, or how it began.
   */
  | { kind: "tag"; tag: ProjectTag; fact: TagFact | null }
  /** The line the row's own agent set for itself: its words, its state, and when it wrote it. */
  | { kind: "agent"; text: string; state: AgentStatusState; line: string; at: number }
  /** The branch the row's project is checked out on, when it is not one it treats as its trunk. */
  | { kind: "branch"; text: string }
  /**
   * How the session began where no person typed its first prompt (`originWords`): whose task it is, or
   * that a schedule woke it — the one fact such a row has, since its group's head names the project.
   */
  | { kind: "origin"; text: string };

/**
 * The subline a row shows, or null when it has nothing to add (the row is then one line):
 *  - out of its project (`tag`), say which project — the flat list, and the sections above the folders —
 *    and, when it has one, that fact first (`tagFact`): one annotation, so the branch gives way;
 *  - inside its project, the agent's own status line, else how the session began (`originWords`), else a
 *    branch that is not the trunk one and not the one its group's head already states (`groupBranch`): a
 *    branch is said once, where it applies.
 */
export function rowSubline(s: ProjectSession, opts: { tag?: ProjectTag | null; branch?: string | null; groupBranch?: string | null }): RowSubline | null {
  if (opts.tag) {
    // The fact is what changed, so it leads: the row says it before the project it is out of. It takes the
    // branch's place, because two annotations on one line is one too many, and the branch is the group's
    // fact (the head states it) where a status, or how the session began, is this row's.
    const fact = tagFact(s.agentStatus) ?? wordsOf(originWords(s));
    // A group head owns its branch: only a worktree row with a different one states it again.
    const tag = fact !== null || (opts.groupBranch != null && opts.tag.branch === opts.groupBranch) ? { ...opts.tag, branch: null } : opts.tag;
    return { kind: "tag", tag, fact };
  }
  if (s.agentStatus) {
    const { state, comment, at } = s.agentStatus;
    return { kind: "agent", text: comment || agentStatusText(s.agentStatus), state, line: agentStatusText(s.agentStatus), at };
  }
  // How it began is this row's own fact, so it comes before a branch: a delegated child or a routine's
  // session says that it is one, not only where it is checked out.
  const origin = originWords(s);
  if (origin) return { kind: "origin", text: origin };
  const branch = opts.branch ?? null;
  if (branch === null || branch === opts.groupBranch || isTrunkBranch(branch)) return null;
  return { kind: "branch", text: branch };
}

/**
 * The longest one part of a row's native tooltip runs. A session's title is a whole prompt, and a tooltip
 * that long is a wall over the list; a status sentence is the one thing the compact row clips hardest, so
 * the cap sits above a real one (the shipped example is 83 characters). Each part is cut on its own, so a
 * long title never takes the fact's or the project's words away.
 */
const TITLE_PART_MAX = 100;

/** One part of a row's tooltip: one line, and never longer than TITLE_PART_MAX. */
function titlePart(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= TITLE_PART_MAX ? flat : `${flat.slice(0, TITLE_PART_MAX - 1).trimEnd()}…`;
}

/**
 * A row's native `title`. The drawn line can clip any part of itself — a compact row does not draw the
 * project's name beside a fact at all (sidebar.css) — so the tooltip is where the whole text stays: the
 * session's full title, the line under it (the agent's sentence, how the session began, or the project's
 * fact), the project it is out of, and a branch that is not the trunk's. The accessible name is not this:
 * it stays the row's own drawn content, which keeps a clipped project's words.
 */
export function rowTitle(s: ProjectSession, opts: { tag?: ProjectTag | null; branch?: string | null; groupBranch?: string | null } = {}): string {
  const sub = rowSubline(s, opts);
  const parts = [titlePart(plainTitle(s.title))];
  if (sub?.kind === "tag") {
    if (sub.fact !== null) parts.push(titlePart(factText(sub.fact)));
    parts.push(titlePart(sub.tag.name));
    // The branch the drawn line says, which a compact row also caps at 56px.
    if (sub.tag.branch !== null) parts.push(titlePart(sub.tag.branch));
  } else if (sub !== null) {
    parts.push(titlePart(sub.text));
  }
  // The branch the drawn line could not say: a tagged row gives that place to its fact, and a row whose
  // folder head above already states the branch does not repeat it (rowSubline's groupBranch).
  const own = opts.tag?.branch ?? opts.branch ?? null;
  const said = sub?.kind === "branch" ? sub.text : sub?.kind === "tag" ? sub.tag.branch : null;
  // A tagged row's branch is already known not to be the trunk's (projectTag cleared it); the row's own
  // checkout is not, so it is asked here.
  if (own !== null && own !== said && !isTrunkBranch(own) && own !== opts.groupBranch) parts.push(titlePart(own));
  return parts.filter((part) => part !== "").join(" · ");
}

/** The words a tag fact says, one line: a state's word and the note under it, or the agent's sentence. */
function factText(fact: TagFact): string {
  return fact.kind === "state" ? [fact.word, fact.note].filter((part) => part !== null && part !== "").join(" · ") : fact.text;
}

/**
 * How a session began, where no person typed its first prompt: whose task it is, or that a schedule woke
 * it. A delegated child's lineage is live only while its chat is (the listing drops it once the chat is
 * reaped), so both say "another agent" when the parent's name is gone. Null for what a person started.
 */
export function originWords(s: ProjectSession): string | null {
  if (s.lineage) return s.lineage.parentTitle ? `From ${s.lineage.parentTitle}` : "From another agent";
  if (s.origin === "routine") return "Scheduled routine";
  if (s.origin === "agent") return "From another agent";
  return null;
}

/**
 * What a tagged row says before the project it is out of, in the branch's place. The agent's own words lead
 * — it is the fact that changed, and the project is only where the row lives — and `blocked` is the one state
 * whose word its own note does not already say: `waiting on CI` alone read as a finished row, so the row says
 * `blocked · waiting on CI` (the state first, its note under it).
 */
function tagFact(status: AgentStatusLine | undefined): TagFact | null {
  if (!status) return null;
  if (status.state === "blocked") return { kind: "state", word: AGENT_STATUS_WORDS.blocked, note: status.comment || null };
  return { kind: "words", text: status.comment || agentStatusText(status) };
}

/** A row's own words as the fact of a tagged line, or nothing where it has none to add. */
function wordsOf(text: string | null): TagFact | null {
  return text ? { kind: "words", text } : null;
}

/** The leading slot a row's 10px mark takes, in the order the row chooses one. */
export type RowMark = "working" | "needs" | "harness" | "blank";

/** The one state word the right-hand slot can carry in place of the age, and its one colour. */
export interface RowWord {
  text: "Needs you" | "Working" | "Review" | "Done";
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
  // One coloured outcome per slot: review waits for a person, done means the agent made a verdict.
  const state = s.agentStatus?.state;
  if (state === "review") return { text: "Review", tone: "accent" };
  if (state === "done") return { text: "Done", tone: "ok" };
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
