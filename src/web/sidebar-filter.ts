// The sidebar's filters: the quick chips under the search box (Running, Needs
// you, Today) and the hide menu beside them. One chip at most is on and it
// narrows the list together with the text search; the hide toggles take whole
// kinds of session out of the way (sleeping, on the default branch, started by
// a routine or by an agent), each a fact read off the row without opening it.
// Pure: the Sidebar passes the clock, the projects' checkouts, and what it
// knows of the chat on screen (whose live status beats the listing's), and
// gets a narrowed overview back that every existing grouping understands.
import type { Checkout, ProjectSession, SessionsOverview } from "../shared/protocol.js";
import { isTrunkBranch, isWorking, placeOf, recency, type GroupOptions } from "./session-groups.js";

export type QuickFilter = "running" | "needs" | "today";

/** The chips, left to right. */
export const QUICK_FILTERS: readonly QuickFilter[] = ["running", "needs", "today"];

export const QUICK_LABELS: Record<QuickFilter, string> = { running: "Running", needs: "Needs you", today: "Today" };

/** A stored value, when it names a chip (browser storage may hold anything). */
export const asQuickFilter = (v: unknown): QuickFilter | null => (QUICK_FILTERS as readonly unknown[]).includes(v) ? (v as QuickFilter) : null;

/** Is this session doing something right now. The Sidebar's `working` knows the open chat's live status. */
export type Working = (s: ProjectSession) => boolean;

const startOfDay = (ms: number): number => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/**
 * Whether a session passes a filter. "Needs you" is attention.ts's definition
 * of a chat asking for an answer (asking, and live); "Today" is last activity
 * since local midnight, a session with no known activity never.
 */
export function matchesQuick(s: ProjectSession, filter: QuickFilter, now: number, working: Working = (x) => isWorking(x.status)): boolean {
  if (filter === "running") return working(s);
  if (filter === "needs") return s.asking === true && s.liveChatId !== undefined;
  return recency(s) >= startOfDay(now);
}

/**
 * What each chip would show: the selected harness's sessions that the list shows
 * by default (not archived, settled, or snoozed), whatever the text search says,
 * so a chip's number does not jump while you type.
 */
export function quickCounts(overview: SessionsOverview, opts: GroupOptions, working?: Working): Record<QuickFilter, number> {
  const now = opts.now ?? Date.now();
  const counts: Record<QuickFilter, number> = { running: 0, needs: 0, today: 0 };
  for (const s of overview.sessions) {
    if (s.harnessId !== opts.harnessId) continue;
    const place = placeOf(s, opts);
    if (place === "archived" || place === "settled" || place === "snoozed") continue;
    for (const f of QUICK_FILTERS) if (matchesQuick(s, f, now, working)) counts[f] += 1;
  }
  return counts;
}

/**
 * The chips to draw: Running and Needs you only while something would match
 * (the one that is on stays, so it can always be switched off); Today always.
 */
export function chipsShown(counts: Record<QuickFilter, number>, active: QuickFilter | null): QuickFilter[] {
  return QUICK_FILTERS.filter((f) => f === "today" || f === active || counts[f] > 0);
}

/** The overview with only the sessions that pass the filter; the same overview when none is on. */
export function applyQuick(overview: SessionsOverview, filter: QuickFilter | null, now: number, working?: Working): SessionsOverview {
  if (!filter) return overview;
  return { ...overview, sessions: overview.sessions.filter((s) => matchesQuick(s, filter, now, working)) };
}

/** Escape in the search box: the text goes first, then the filter. Null when there is nothing to clear. */
export function escapeClears(query: string, filter: QuickFilter | null): "query" | "filter" | null {
  if (query !== "") return "query";
  return filter ? "filter" : null;
}

// ---- what to hide (the filter menu beside the chips) ----------------------
//
// The chips narrow to one thing; these are the opposite: sessions you do not
// want in the way at all. Each is a fact about the session that can be read
// without opening it — its project's checkout, its age, and where it came
// from — so the menu works offline and hides nothing it cannot name on hover.

export type HideGroup = "sleeping" | "defaultBranch" | "automation" | "agent";

/** The menu's toggles, top to bottom: the ones that pile up first are first. */
export const HIDE_GROUPS: readonly HideGroup[] = ["sleeping", "defaultBranch", "automation", "agent"];

export const HIDE_LABELS: Record<HideGroup, string> = {
  sleeping: "Sleeping",
  defaultBranch: "On the default branch",
  automation: "Started by a routine",
  agent: "Started by an agent",
};

/** One line under each label, saying what it takes out of the list. */
export const HIDE_HINTS: Record<HideGroup, string> = {
  sleeping: "No run, no question, and nothing said for a day",
  defaultBranch: "Chats in a project's own checkout on main/master, not in a worktree",
  automation: "Sessions a scheduled routine opened",
  agent: "Sessions another agent delegated",
};

/** How long a quiet session counts as sleeping (a day of nothing). */
export const SLEEPING_AFTER_MS = 24 * 60 * 60_000;

/** What the toggles read beyond the session row itself: the clock, the checkouts, the open chat. */
export interface HideContext {
  now: number;
  /** `SessionsOverview.checkouts`, by workspace id: the branch and whether it is the repository's own tree. */
  checkouts?: Record<string, Checkout>;
  /** The session on screen: it is never hidden, whatever the toggles say, so it can be closed from here. */
  keep?: (s: ProjectSession) => boolean;
}

/** A stored value, when it names toggles (browser storage may hold anything). */
export function asHideGroups(v: unknown): HideGroup[] {
  if (!Array.isArray(v)) return [];
  return HIDE_GROUPS.filter((g) => v.includes(g));
}

/** Quiet: nothing running, no question waiting, and no activity for a day. */
export const isSleeping = (s: ProjectSession, now: number): boolean =>
  s.liveChatId === undefined && s.asking !== true && recency(s) > 0 && now - recency(s) >= SLEEPING_AFTER_MS;

/** In a project's own working tree, on the branch that repository calls its trunk. */
export function isOnDefaultBranch(s: ProjectSession, checkouts: HideContext["checkouts"]): boolean {
  const checkout = checkouts?.[s.workspaceId];
  return checkout?.primary === true && isTrunkBranch(checkout.branch);
}

/** Which toggle hides this session, the first that applies; null for the ones that always show. */
export function hiddenBy(s: ProjectSession, hide: readonly HideGroup[], ctx: HideContext): HideGroup | null {
  if (ctx.keep?.(s)) return null;
  for (const group of hide) {
    if (group === "sleeping" && isSleeping(s, ctx.now)) return group;
    if (group === "defaultBranch" && isOnDefaultBranch(s, ctx.checkouts)) return group;
    if (group === "automation" && s.origin === "routine") return group;
    if (group === "agent" && s.origin === "agent") return group;
  }
  return null;
}

/** The overview without the sessions the toggles hide; the same overview when none is on. */
export function applyHidden(overview: SessionsOverview, hide: readonly HideGroup[], ctx: HideContext): SessionsOverview {
  if (hide.length === 0) return overview;
  return { ...overview, sessions: overview.sessions.filter((s) => hiddenBy(s, hide, ctx) === null) };
}

/**
 * Why a row is where it is, for its hover card: a person's session says nothing
 * (that is the default), a routine's or an agent's names its starter, and a
 * sleeping one says how long it has been quiet.
 */
export function provenanceOf(s: ProjectSession, ctx: HideContext): string | null {
  const parts: string[] = [];
  if (s.origin === "routine") parts.push("Started by a scheduled routine");
  else if (s.origin === "agent") parts.push("Started by another agent");
  if (isSleeping(s, ctx.now)) parts.push(`Sleeping for ${ageWords(ctx.now - recency(s))}`);
  else if (isOnDefaultBranch(s, ctx.checkouts)) parts.push(`On ${ctx.checkouts?.[s.workspaceId]?.branch ?? "the default branch"}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** How long a quiet session has been quiet, in whole days: at least one, since that is what sleeping means. */
function ageWords(ms: number): string {
  const days = Math.max(1, Math.floor(ms / (24 * 60 * 60_000)));
  return days === 1 ? "1 day" : `${days} days`;
}

/**
 * How many sessions each toggle would take out, counted on the overview as it
 * arrives (archived ones aside) so a number does not jump while a chip or the
 * search narrows the list.
 */
export function hideCounts(overview: SessionsOverview, ctx: HideContext): Record<HideGroup, number> {
  const counts: Record<HideGroup, number> = { sleeping: 0, defaultBranch: 0, automation: 0, agent: 0 };
  for (const s of overview.sessions) {
    if (s.archived) continue;
    for (const group of HIDE_GROUPS) counts[group] += hiddenBy(s, [group], ctx) === null ? 0 : 1;
  }
  return counts;
}
