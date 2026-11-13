// The agent dashboard's decisions, kept pure: which column a session belongs to
// (Needs you, Working, Done), which cards a filter leaves, the project's pull-request
// state as a filter value, and which delegated children nest under their parent's card.
// The Dashboard component only draws what this answers. Everything it reads is already
// metadata (the sidebar's overview, the sessions' status lines, the GitHub lookup awui
// makes on request): no transcript ever reaches it from here.
import type { ProjectSession, SessionsOverview, WorkspaceInfo } from "../shared/protocol.js";
import { isWorking, recency } from "./session-groups.js";

export type BoardColumn = "needs" | "working" | "done";

/** The board's columns, left to right. */
export const BOARD_COLUMNS: readonly BoardColumn[] = ["needs", "working", "done"];

export const BOARD_TITLES: Record<BoardColumn, string> = { needs: "Needs you", working: "Working", done: "Done" };

/** How a column reads when it holds nothing, so an empty board says why. */
export const BOARD_EMPTY: Record<BoardColumn, string> = {
  needs: "Nothing is waiting on you.",
  working: "Nothing is running.",
  done: "Nothing has finished yet.",
};

/** A project's pull request as this board filters it. `none` also covers "could not ask". */
export type PrState = "open" | "draft" | "merged" | "closed" | "none";

/** The pull-request filter's values: any, or one state. */
export type PrFilter = "any" | PrState;

export const PR_FILTERS: readonly PrFilter[] = ["any", "open", "draft", "merged", "closed", "none"];

export const PR_FILTER_LABELS: Record<PrFilter, string> = {
  any: "Any pull request",
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
  none: "No pull request",
};

/** A pull request as `GET /api/workspaces/:id/github/pr` answers it. */
export interface PullRequestShape {
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
}

/** One project's pull request as the filter sees it; null (no PR, or gh could not be asked) is `none`. */
export function prStateOf(pr: PullRequestShape | null | undefined): PrState {
  if (!pr) return "none";
  const state = pr.state.toUpperCase();
  if (state === "MERGED") return "merged";
  if (state === "CLOSED") return "closed";
  return pr.isDraft ? "draft" : "open";
}

/** One card: a session, and the delegated children that nest under it. */
export interface BoardCard {
  session: ProjectSession;
  children: ProjectSession[];
}

export interface BoardOptions {
  /** The session on screen counts as working by its live status; the caller knows it. */
  working?: (s: ProjectSession) => boolean;
  /** One project only; null or absent is every project. */
  project?: string | null;
  pr?: PrFilter;
  /** Each project's pull request as last read, by workspace id. A project not read yet never hides a card. */
  prStates?: Record<string, PrState>;
}

/** Where a session stands: asking for you, running, or done for now. */
export function columnOf(s: ProjectSession, working: (s: ProjectSession) => boolean = (x) => isWorking(x.status)): BoardColumn {
  if (s.asking) return "needs";
  if (working(s)) return "working";
  return "done";
}

/** Newest activity first, the way every list in awui orders a run. */
const byRecency = (a: ProjectSession, b: ProjectSession): number => recency(b) - recency(a);

/** Whether a card survives the pull-request filter: a project not read yet is not hidden. */
function passesPr(s: ProjectSession, opts: BoardOptions): boolean {
  const filter = opts.pr ?? "any";
  if (filter === "any") return true;
  const state = opts.prStates?.[s.workspaceId];
  if (state === undefined) return true;
  return state === filter;
}

/**
 * The board: every unarchived session in the chosen project, split by column, sorted
 * newest first, with a delegated child nested under its parent's card when that parent
 * is on the board (a child whose parent is not listed is a card of its own).
 */
export function boardCards(overview: SessionsOverview, opts: BoardOptions = {}): Record<BoardColumn, BoardCard[]> {
  const working = opts.working ?? ((s: ProjectSession) => isWorking(s.status));
  const visible = overview.sessions.filter((s) => !s.archived && (!opts.project || s.workspaceId === opts.project) && passesPr(s, opts));
  const byLiveChat = new Map<string, ProjectSession>();
  for (const s of visible) if (s.liveChatId) byLiveChat.set(s.liveChatId, s);
  const nested = new Set<string>();
  const childrenOf = new Map<string, ProjectSession[]>();
  for (const s of visible) {
    const parent = s.lineage ? byLiveChat.get(s.lineage.parentChatId) : undefined;
    if (!parent || parent.id === s.id) continue;
    nested.add(s.id);
    const list = childrenOf.get(parent.id) ?? [];
    list.push(s);
    childrenOf.set(parent.id, list);
  }
  const out: Record<BoardColumn, BoardCard[]> = { needs: [], working: [], done: [] };
  for (const s of visible) {
    if (nested.has(s.id)) continue;
    out[columnOf(s, working)].push({ session: s, children: (childrenOf.get(s.id) ?? []).sort(byRecency) });
  }
  for (const column of BOARD_COLUMNS) out[column].sort((a, b) => byRecency(a.session, b.session));
  return out;
}

/** How many cards (not children) each column holds, for its heading. */
export const boardCounts = (cards: Record<BoardColumn, BoardCard[]>): Record<BoardColumn, number> => ({
  needs: cards.needs.length,
  working: cards.working.length,
  done: cards.done.length,
});

/** A card's pull request badge, if its project has one: the words and the link. */
export function prBadge(s: ProjectSession, prs: Record<string, PullRequestShape | null> | undefined): { words: string; url: string } | null {
  const pr = prs?.[s.workspaceId];
  if (!pr) return null;
  const state = prStateOf(pr);
  return { words: state === "open" ? "PR open" : state === "draft" ? "PR draft" : state === "merged" ? "PR merged" : "PR closed", url: pr.url };
}

/** The projects the board may filter to, with how many cards each would show. */
export function boardProjects(overview: SessionsOverview): Array<WorkspaceInfo & { count: number }> {
  const counts = new Map<string, number>();
  for (const s of overview.sessions) if (!s.archived) counts.set(s.workspaceId, (counts.get(s.workspaceId) ?? 0) + 1);
  return overview.workspaces
    .filter((w) => (counts.get(w.id) ?? 0) > 0)
    .map((w) => ({ ...w, count: counts.get(w.id) ?? 0 }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

/** How a card's own status line reads, if its agent set one (none when it did not). */
export const cardStatusLine = (s: ProjectSession): string | null => (s.agentStatus ? s.agentStatus.comment || s.agentStatus.state : null);
