// The sidebar's Recent view, its default: one flat list across a harness's projects (T3 Code's shape).
// The sections above it — what needs you, what is working, what is pinned — are Sidebar.tsx's and
// sidebarSections' business; this module is the rest of the list: every other session, newest first,
// under the same calendar headings the Projects view uses, each row carrying its project as a tag,
// and how much of it one page shows. Pure, so the order, the buckets, the page size, and the tag rule
// are unit-tested without a DOM.
import type { ProjectSession, SessionsOverview } from "../shared/protocol.js";
import { dateGroup, isTrunkBranch, placeOf, recency, visibleSessions, type GroupOptions } from "./session-groups.js";

/** The flat list's first page, and the rows one "Show more" adds — a folder's page adds the same. */
export const RECENT_PAGE = 12;
export const SHOW_MORE = 20;

/** The project a flat row is tagged with: its badge and name, and a branch worth saying. */
export interface ProjectTag {
  id: string;
  name: string;
  /** The checkout's branch, when it is one the project does not treat as its trunk (else null). */
  branch: string | null;
}

/** One row of the flat list: a calendar heading, or a session with the project it is out of. */
export type RecentRow = { kind: "divider"; key: string; label: string } | { kind: "session"; s: ProjectSession; tag: ProjectTag | null };

export interface RecentOptions extends GroupOptions {
  /** The locale's first day of the week, as the Projects view gets it; Monday when absent. */
  weekStartsOn?: number;
}

/**
 * The project a row belongs to, as the tag says it: its name for the badge, and its branch when that
 * is not a trunk one (a worktree's row says what it is checked out on; the main branch is the folder's
 * own fact). Null for a harness with no projects, whose rows have nothing to be out of.
 */
export function projectTag(overview: SessionsOverview, s: ProjectSession): ProjectTag | null {
  const workspace = overview.workspaces.find((w) => w.id === s.workspaceId);
  if (!workspace) return null;
  const branch = overview.checkouts?.[workspace.id]?.branch ?? null;
  return { id: workspace.id, name: workspace.name, branch: branch !== null && !isTrunkBranch(branch) ? branch : null };
}

/** Is this session in the flat list (rather than in a section above it, or hidden by its toggle)? */
function inFlatList(s: ProjectSession, opts: RecentOptions, searching: boolean): boolean {
  // A search lists its matches, wherever they would have sat.
  if (searching) return true;
  switch (placeOf(s, opts)) {
    case "needs":
    case "working":
    case "pinned":
      // They are the sections above this list.
      return false;
    case "archived":
      return opts.showArchived === true;
    case "settled":
      return opts.showSettled === true;
    case "snoozed":
      return opts.showSnoozed === true;
    default:
      return true;
  }
}

/**
 * The flat list as one page of it: the selected harness's sessions that are not above it in their own
 * section, newest first, each run of them under its calendar heading (`dateGroup`: Today, Yesterday,
 * Earlier this week, Last week, …, never one above the first row). `limit` stops the list after that
 * many sessions; `hidden` is how many the page left for "Show more".
 */
export function recentRows(overview: SessionsOverview, opts: RecentOptions, limit = RECENT_PAGE): { rows: RecentRow[]; hidden: number } {
  const searching = opts.query.trim() !== "";
  const now = opts.now ?? Date.now();
  const weekStartsOn = opts.weekStartsOn ?? 1;
  const list = visibleSessions(overview, opts)
    .filter((s) => inFlatList(s, opts, searching))
    .sort((a, b) => recency(b) - recency(a));
  const rows: RecentRow[] = [];
  let shown = 0;
  let hidden = 0;
  let key = "";
  for (const s of list) {
    if (shown >= limit) {
      hidden += 1;
      continue;
    }
    const group = dateGroup(recency(s), now, weekStartsOn);
    if (group.key !== key) {
      key = group.key;
      rows.push({ kind: "divider", key: group.key, label: group.label });
    }
    rows.push({ kind: "session", s, tag: projectTag(overview, s) });
    shown += 1;
  }
  return { rows, hidden };
}
