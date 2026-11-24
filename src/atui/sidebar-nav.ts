// The sidebar's pure row model: occurrence-specific selection, reversible folds,
// and a session's own project as its parent. Input and rendering stay in ui/sidebar.tsx.
import type { ProjectSession, SessionsOverview, WorkspaceInfo } from "../shared/protocol.js";
import { groupByProject, sidebarSections, type GroupOptions } from "../web/session-groups.js";

export type SectionId = "needs" | "working" | "pinned";
export type SidebarRow =
  | { kind: "section"; id: SectionId; label: string; count: number }
  | { kind: "project"; workspace: WorkspaceInfo; count: number; current: boolean; newest?: ProjectSession }
  | { kind: "session"; s: ProjectSession; project?: string; child?: true };
export type ProjectOption = { workspace: WorkspaceInfo; sessions: ProjectSession[] };

/**
 * A list of sessions with each running delegated child moved to just after its parent
 * and marked, when the parent is in the same list; a child whose parent is elsewhere
 * keeps its own place, as the board's cards do. Order within the rest is untouched.
 */
export function nestDelegated(sessions: readonly ProjectSession[]): Array<{ s: ProjectSession; child: boolean }> {
  const parentOf = new Map<string, ProjectSession>();
  for (const s of sessions) if (s.liveChatId) parentOf.set(s.liveChatId, s);
  const kids = new Map<string, ProjectSession[]>();
  const nested = new Set<string>();
  for (const s of sessions) {
    const parent = s.lineage ? parentOf.get(s.lineage.parentChatId) : undefined;
    if (!parent || parent.id === s.id) continue;
    nested.add(s.id);
    kids.set(parent.id, [...(kids.get(parent.id) ?? []), s]);
  }
  return sessions.filter((s) => !nested.has(s.id)).flatMap((s) => [{ s, child: false }, ...(kids.get(s.id) ?? []).map((k) => ({ s: k, child: true }))]);
}

/** Preserve web session grouping, but retain offered empty projects as scoped-new-chat targets. */
export function sidebarProjects(overview: SessionsOverview, opts: GroupOptions): ProjectOption[] {
  const groups = groupByProject(overview, opts);
  const shown = new Set(groups.map((group) => group.workspace.id));
  const empty = overview.workspaces.filter((workspace) => workspace.id !== opts.currentId && !shown.has(workspace.id)).map((workspace) => ({ workspace, sessions: [] }));
  return [...groups, ...empty];
}
/** The display state of a project: other projects start folded, explicit actions override that. */
export function projectOpen(folded: ReadonlySet<string>, workspaceId: string, current: boolean): boolean {
  return folded.has(`open:project:${workspaceId}`) ? true : folded.has(`shut:project:${workspaceId}`) ? false : current;
}

export function sidebarRows(overview: SessionsOverview, opts: GroupOptions, folded: ReadonlySet<string>): SidebarRow[] {
  const sections = sidebarSections(overview, opts);
  const rows: SidebarRow[] = [];
  for (const [id, label] of [["needs", "Needs you"], ["working", "Working"], ["pinned", "Pinned"]] as const) {
    const sessions = sections[id];
    // An empty group is not drawn: the web's sidebar shows Needs you, Working and Pinned only when they hold rows.
    if (sessions.length === 0) continue;
    rows.push({ kind: "section", id, label, count: sessions.length });
    if (folded.has(`shut:${id}`) && !folded.has(`open:${id}`)) continue;
    for (const { s, child } of nestDelegated(sessions)) {
      const ws = overview.workspaces.find((w) => w.id === s.workspaceId);
      rows.push({ kind: "session", s, ...(ws && ws.id !== opts.currentId ? { project: ws.name } : {}), ...(child ? { child: true as const } : {}) });
    }
  }
  for (const group of sidebarProjects(overview, opts)) {
    const current = group.workspace.id === opts.currentId;
    const newest = group.sessions[0];
    rows.push({ kind: "project", workspace: group.workspace, count: group.sessions.length, current, ...(newest ? { newest } : {}) });
    const key = `project:${group.workspace.id}`;
    if (!projectOpen(folded, group.workspace.id, current)) continue;
    for (const { s, child } of nestDelegated(group.sessions)) rows.push({ kind: "session", s, ...(child ? { child: true as const } : {}) });
  }
  return rows;
}

/**
 * The stored selection's key for one drawn row. A session occurrence is keyed by its
 * session id plus how many prior rows show that same session — not the row index —
 * so a selection survives the list changing around it (a new session, one moving
 * into Working). Duplicate occurrences stay distinct: a section can name one and a
 * project another.
 */
export function sidebarKey(row: SidebarRow | undefined, index: number, rows: readonly SidebarRow[] = []): string | null {
  if (!row) return null;
  if (row.kind === "section") return row.id;
  if (row.kind === "project") return `project:${row.workspace.id}`;
  const ordinal = rows.slice(0, index).filter((item) => item.kind === "session" && item.s.id === row.s.id).length;
  return `s:${row.s.id}:${ordinal}`;
}

export function sidebarSelectedIndex(rows: readonly SidebarRow[], selected: string | null): number {
  if (selected === null) return 0;
  const found = rows.findIndex((row, index) => sidebarKey(row, index, rows) === selected);
  return found < 0 ? 0 : found;
}


/** Change only the explicit fold. Both expanding and re-folding always have an inverse. */
export function sidebarFolded(folded: ReadonlySet<string>, row: SidebarRow, currentId: string | null): Set<string> {
  if (row.kind === "session") return new Set(folded);
  const key = row.kind === "section" ? row.id : `project:${row.workspace.id}`;
  const fallback = row.kind === "project" && row.workspace.id !== currentId;
  const closed = folded.has(`open:${key}`) ? false : folded.has(`shut:${key}`) ? true : fallback;
  const next = new Set(folded);
  if (closed) {
    next.delete(`shut:${key}`);
    next.add(`open:${key}`);
  } else {
    next.add(`shut:${key}`);
    next.delete(`open:${key}`);
  }
  return next;
}

/** The parent of a session is its own workspace, not whichever project is open. */
export function sidebarParentKey(rows: readonly SidebarRow[], row: SidebarRow | undefined): string | null {
  if (!row) return null;
  if (row.kind === "section") return row.id;
  const workspaceId = row.kind === "project" ? row.workspace.id : row.s.workspaceId;
  return rows.reduce<string | null>((key, item, index) => item.kind === "project" && item.workspace.id === workspaceId ? sidebarKey(item, index) : key, null);
}

/** For `t`: a session opens itself; a header opens its own first session, and an empty header opens nothing. */
export function sidebarTabRow(rows: readonly SidebarRow[], index: number): SidebarRow | undefined {
  const at = rows[index];
  if (at?.kind === "session") return at;
  for (let i = index + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row && row.kind !== "session") return undefined;
    if (row) return row;
  }
  return undefined;
}
