// Sidebar grouping (Hermes Desktop style): sessions by project, newest activity
// first; projects by their newest session, a repository's projects together
// (the one you are in, then its main branch, then other branches and
// worktrees); and inside a project, an unlabelled run of what you did last,
// then calendar groups, each in the order a drag left it.
import type { ChatStatus, Checkout, ProjectSession, SessionsOverview, WorkspaceInfo } from "../shared/protocol.js";

const BUSY: ReadonlySet<ChatStatus> = new Set(["starting", "running", "stopping", "compacting"]);

/** A live chat that is doing something (the sidebar's working spinner). */
export function isBusy(status: ChatStatus | null | undefined): boolean {
  return status !== null && status !== undefined && BUSY.has(status);
}

/**
 * A chat the lists and rings may call working: busy, minus "starting". A resumed chat shows from its file while
 * its harness spawns (deferred.ts), and that is a start-up, not a turn: calling it working moved the row into
 * the Working section, counted it under Running, and put it back a moment later. Stopping and closing still use
 * isBusy, since a starting harness has to be stopped too.
 */
export function isWorking(status: ChatStatus | null | undefined): boolean {
  return status !== "starting" && isBusy(status);
}

export interface ProjectGroup {
  workspace: WorkspaceInfo;
  /** Newest activity first. */
  sessions: ProjectSession[];
  current: boolean;
  /** Its git checkout, when the project is in a repository. */
  checkout?: Checkout;
  /** Another project of the same repository is listed too: its branch tells them apart. */
  sharesRepo: boolean;
}

/** A session's last activity (its last turn, else when it began), in ms; 0 when unknown. */
export const recency = (s: ProjectSession): number => (s.updatedAt ? Date.parse(s.updatedAt) || 0 : 0);

/** The branches a repository treats as its trunk: where a "default branch" chat runs. */
const TRUNK_BRANCHES: ReadonlySet<string> = new Set(["main", "master", "trunk", "develop"]);

/** Is this a branch a repository treats as its default (a detached HEAD is not). */
export const isTrunkBranch = (branch: string | null | undefined): boolean => typeof branch === "string" && TRUNK_BRANCHES.has(branch);

/** Inside a repository: the project you are in, then its main branch, then the other branches and worktrees. */
const tier = (g: ProjectGroup): number => (g.current ? 0 : g.checkout?.branch && TRUNK_BRANCHES.has(g.checkout.branch) ? 1 : 2);
const activity = (g: ProjectGroup): number => g.sessions.reduce((max, s) => Math.max(max, recency(s)), 0);

export interface GroupOptions {
  currentId: string | null;
  query: string;
  harnessId: string | null;
  /** Archived, settled, and snoozed sessions stay in their projects instead of being left out. */
  showArchived?: boolean;
  showSettled?: boolean;
  showSnoozed?: boolean;
  /** The session on screen: it stays in its project whatever it is doing. */
  isActive?: (s: ProjectSession) => boolean;
  /** The focused project's hand-made order (the sidebar's drags), first to last. */
  order?: string[];
  now?: number;
}

/** Where a session goes in the list (T3 Code's inbox): what needs you and what works first, then pins and projects. */
export type Place = "needs" | "working" | "pinned" | "project" | "snoozed" | "settled" | "archived";

export function placeOf(s: ProjectSession, opts: GroupOptions): Place {
  if (s.archived) return "archived";
  const onScreen = opts.isActive?.(s) ?? false;
  if (!onScreen && s.asking) return "needs";
  if (!onScreen && isWorking(s.status)) return "working";
  if (s.snoozedUntil && s.snoozedUntil > (opts.now ?? Date.now())) return "snoozed";
  if (s.settled) return "settled";
  if (s.pinned) return "pinned";
  return "project";
}

/** The selected harness's sessions that match the search. */
function visible(overview: SessionsOverview, opts: GroupOptions): ProjectSession[] {
  const q = opts.query.trim().toLowerCase();
  // The harness switch scopes the list: only sessions that actually ran in it.
  return overview.sessions.filter((s) => s.harnessId === opts.harnessId && (!q || s.title.toLowerCase().includes(q)));
}

/**
 * Sessions by project. What needs you, what is working, and pinned sessions
 * sit in their own lists above (see sidebarSections); archived, settled, and
 * snoozed ones are left out unless shown. A search finds every session where
 * it lives.
 */
export function groupByProject(overview: SessionsOverview, opts: GroupOptions): ProjectGroup[] {
  const searching = opts.query.trim() !== "";
  const groups = new Map<string, ProjectGroup>();
  for (const ws of overview.workspaces) {
    const checkout = overview.checkouts?.[ws.id];
    groups.set(ws.id, { workspace: ws, sessions: [], current: ws.id === opts.currentId, ...(checkout ? { checkout } : {}), sharesRepo: false });
  }
  for (const s of visible(overview, opts)) {
    const place = placeOf(s, opts);
    const shown =
      searching ||
      place === "project" ||
      (place === "archived" && opts.showArchived) ||
      (place === "settled" && opts.showSettled) ||
      (place === "snoozed" && opts.showSnoozed);
    if (shown) groups.get(s.workspaceId)?.sessions.push(s);
  }
  const shown = [...groups.values()].filter((g) => g.sessions.length > 0 || (g.current && !searching));
  for (const g of shown) g.sessions.sort((a, b) => recency(b) - recency(a));
  // A repository's projects stay together, placed by the newest of them; empty ones sink.
  const repos = new Map<string, ProjectGroup[]>();
  for (const g of shown) {
    const key = g.checkout ? `repo:${g.checkout.repo}` : `ws:${g.workspace.id}`;
    const list = repos.get(key);
    if (list) list.push(g);
    else repos.set(key, [g]);
  }
  const byName = (a: ProjectGroup, b: ProjectGroup) => a.workspace.name.localeCompare(b.workspace.name);
  const clusters = [...repos.values()].map((list) => {
    for (const g of list) g.sharesRepo = list.length > 1;
    return list.sort((a, b) => tier(a) - tier(b) || activity(b) - activity(a) || byName(a, b));
  });
  const newest = (list: ProjectGroup[]) => Math.max(...list.map(activity));
  return clusters.sort((a, b) => newest(b) - newest(a) || byName(a[0] as ProjectGroup, b[0] as ProjectGroup)).flat();
}

export interface SidebarSections {
  needs: ProjectSession[];
  working: ProjectSession[];
  pinned: ProjectSession[];
  counts: { snoozed: number; settled: number; archived: number };
}

/** The lists above the projects, and how many sessions each toggle below them would bring back; empty while searching. */
export function sidebarSections(overview: SessionsOverview, opts: GroupOptions): SidebarSections {
  const out: SidebarSections = { needs: [], working: [], pinned: [], counts: { snoozed: 0, settled: 0, archived: 0 } };
  if (opts.query.trim()) return out;
  for (const s of visible(overview, opts)) {
    const place = placeOf(s, opts);
    if (place === "needs" || place === "working" || place === "pinned") out[place].push(s);
    else if (place !== "project") out.counts[place] += 1;
  }
  return out;
}

/** The pinned list above the projects, newest first; empty while searching. */
export function pinnedSessions(overview: SessionsOverview, opts: GroupOptions): ProjectSession[] {
  return sidebarSections(overview, opts).pinned;
}

export function archivedCount(overview: SessionsOverview, harnessId: string | null): number {
  return overview.sessions.filter((s) => s.harnessId === harnessId && s.archived).length;
}

/** When a snooze ends, said briefly: "4:30 PM", "Tomorrow 9:00 AM", "Mon 9:00 AM". */
export function wakeLabel(at: number, now = Date.now()): string {
  const when = new Date(at);
  const time = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const day = new Date(now);
  day.setHours(0, 0, 0, 0);
  const dayMs = 86_400_000;
  if (at < day.getTime() + dayMs) return time;
  if (at < day.getTime() + 2 * dayMs) return `Tomorrow ${time}`;
  return `${when.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** Snooze presets: an hour from now, tomorrow at 9:00, next Monday at 9:00. */
export function snoozeOptions(now = Date.now()): Array<{ label: string; until: number }> {
  const at9 = (days: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(9, 0, 0, 0);
    return d.getTime();
  };
  const today = new Date(now).getDay();
  const toMonday = ((8 - today) % 7) || 7;
  return [
    { label: "For an hour", until: now + 3_600_000 },
    { label: "Until tomorrow", until: at9(1) },
    { label: "Until next week", until: at9(toMonday) },
  ];
}

/** Tomorrow at 9:00 as a datetime-local value: the snooze dialog's default. */
export function snoozeInputDefault(now = Date.now()): string {
  const d = new Date(now);
  d.setDate(d.getDate() + 1);
  d.setHours(9, 0, 0, 0);
  return localSnoozeInput(d);
}

/** A datetime-local value as epoch ms; null for one that is not a time in the future. */
export function snoozeInputAt(value: string, now = Date.now()): number | null {
  const at = new Date(value).getTime();
  return Number.isFinite(at) && at > now ? at : null;
}

/** `YYYY-MM-DDTHH:mm` in this browser's zone, which is what a datetime-local input reads and writes. */
function localSnoozeInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Claude.ai's sidebar bucket: Today, Yesterday, this week, then a short date, then Older. */
export function conversationBucket(iso: string | null, now = new Date()): string {
  if (!iso) return "Older";
  const then = new Date(iso);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const day = 86_400_000;
  const t = then.getTime();
  if (t >= today.getTime()) return "Today";
  if (t >= today.getTime() - day) return "Yesterday";
  if (t >= today.getTime() - 6 * day) {
    const label = then.toLocaleDateString([], { month: "short", day: "numeric" });
    return then.getFullYear() === now.getFullYear() ? label : then.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  }
  return "Older";
}

/** One labelled rung of a history or focused list, in display order; a blank label is the unlabelled recent run. */
export interface HistorySection {
  label: string;
  sessions: ProjectSession[];
}

/**
 * The current project's focused view (Hermes Desktop's): its sessions of the
 * selected harness as date-grouped sections, and the other projects that an
 * "All projects" list would show. The header row and the back row are the
 * caller's (Sidebar's). Like groupByProject, archived, settled, and snoozed
 * sessions stay out unless shown; a search is the caller's unscoped list.
 */
export function focusProject(
  overview: SessionsOverview,
  workspaceId: string,
  opts: GroupOptions,
): { workspace: WorkspaceInfo; checkout?: Checkout; sections: HistorySection[]; allCount: number; rest: ProjectGroup[] } | null {
  const workspace = overview.workspaces.find((w) => w.id === workspaceId);
  if (!workspace) return null;
  const checkout = overview.checkouts?.[workspaceId];
  const groups = groupByProject(overview, { ...opts, currentId: workspaceId });
  const here = groups.find((g) => g.workspace.id === workspaceId);
  // Needs you, Working, and Pinned have their own sections above; everything else
  // sits in the date list, including settled, snoozed, and archived rows when
  // their toggle is on (groupByProject has already applied those).
  const elsewhere = new Set(["needs", "working", "pinned"]);
  const sessions = (here?.sessions ?? []).filter((s) => !elsewhere.has(placeOf(s, opts)));
  const out: HistorySection[] = [];
  let run: HistorySection | null = null;
  let label = "";
  for (const r of projectRows(sessions, { now: opts.now, weekStartsOn: localeWeekStart(), ...(opts.order ? { order: opts.order } : {}) })) {
    if (r.kind === "divider") {
      // The divider's label is the date group of the run it introduces.
      run = null;
      label = r.label;
      continue;
    }
    if (!run) {
      run = { label, sessions: [] };
      out.push(run);
    }
    run.sessions.push(r.s);
  }
  const rest = groups.filter((g) => g.workspace.id !== workspaceId && g.sessions.length > 0);
  const allCount = visible(overview, opts).length;
  return { workspace, ...(checkout ? { checkout } : {}), sections: out, allCount, rest };
}

/** What the focused header's switch shows: every project of the overview, by newest session; `current` first. */
export function sessionScope(overview: SessionsOverview, opts: GroupOptions): Array<{ workspace: WorkspaceInfo; count: number; current: boolean }> {
  return groupByProject(overview, opts).map((g) => ({ workspace: g.workspace, count: g.sessions.length, current: g.current }));
}

/**
 * The awui harness's history: a flat, newest-first list grouped into dated
 * rungs — no projects. Pinned first, then Today, Yesterday, this week (each
 * its own short date), Older. Search flattens to one matching list.
 */
export function historySections(overview: SessionsOverview, opts: GroupOptions): HistorySection[] {
  const sessions = visible(overview, opts).filter((s) => !s.archived);
  const pinned = sessions.filter((s) => s.pinned);
  // Newest first (undated last), so the buckets come out in display order as they fill:
  // Today, Yesterday, this week's days newest first, Older.
  const time = (s: ProjectSession) => (s.updatedAt ? Date.parse(s.updatedAt) : -Infinity);
  const rest = sessions.filter((s) => !s.pinned).sort((a, b) => time(b) - time(a));
  const byBucket = new Map<string, ProjectSession[]>();
  const now = opts.now !== undefined ? new Date(opts.now) : new Date();
  for (const s of rest) {
    const label = conversationBucket(s.updatedAt, now);
    const list = byBucket.get(label);
    if (list) list.push(s);
    else byBucket.set(label, [s]);
  }
  const out: HistorySection[] = [];
  if (pinned.length > 0) out.push({ label: "Pinned", sessions: pinned });
  for (const [label, list] of byBucket) out.push({ label, sessions: list });
  return out;
}


/** The locale's first day of the week (0 Sunday … 6 Saturday); Monday when the browser does not say. */
export function localeWeekStart(): number {
  try {
    if (typeof navigator === "undefined") return 1;
    const locale = new Intl.Locale(navigator.language) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = locale.getWeekInfo?.().firstDay ?? locale.weekInfo?.firstDay;
    return typeof first === "number" ? first % 7 : 1;
  } catch {
    return 1;
  }
}

const startOfDay = (ms: number): Date => {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d;
};

/** A date group, by the calendar (Hermes Desktop's): Today, Yesterday, Earlier this week, Last week, Earlier this month, then months. */
export function dateGroup(ms: number, now = Date.now(), weekStartsOn = 1): { key: string; label: string } {
  if (ms <= 0) return { key: "undated", label: "Older" };
  const day = startOfDay(ms);
  const today = startOfDay(now);
  const days = Math.round((today.getTime() - day.getTime()) / 86_400_000);
  if (days <= 0) return { key: "today", label: "Today" };
  if (days === 1) return { key: "yesterday", label: "Yesterday" };
  const weekStart = new Date(today);
  weekStart.setDate(today.getDate() - ((today.getDay() - weekStartsOn + 7) % 7));
  if (day >= weekStart) return { key: "this-week", label: "Earlier this week" };
  const lastWeek = new Date(weekStart);
  lastWeek.setDate(weekStart.getDate() - 7);
  if (day >= lastWeek) return { key: "last-week", label: "Last week" };
  const sameYear = day.getFullYear() === today.getFullYear();
  if (sameYear && day.getMonth() === today.getMonth()) return { key: "this-month", label: "Earlier this month" };
  const month = day.toLocaleDateString("en-US", { month: "long" });
  return { key: `m-${day.getFullYear()}-${day.getMonth()}`, label: sameYear ? month : `${month} ${day.getFullYear()}` };
}

const HEAD_SESSIONS = 5;
const MIN_BREAK_MS = 30 * 60_000;
const MAX_RUN_GAP_MS = 8 * 3_600_000;

/**
 * Where the unlabelled run of what you did last ends (Hermes Desktop's head
 * run): the oldest time still in it. The run is cut at a real pause (30
 * minutes or more) near five sessions down, never mid-burst, and a silence
 * over 8 hours always ends it. -Infinity: the whole list is one run;
 * Infinity: no run (it would only be the top of its own date group).
 */
export function headCutoff(times: number[], now = Date.now(), weekStartsOn = 1): number {
  const t = [...times].sort((a, b) => b - a);
  let best = -1;
  let bestScore = Infinity;
  let ended = false;
  for (let i = 1; i < t.length; i++) {
    const gap = (t[i - 1] as number) - (t[i] as number);
    const ends = gap > MAX_RUN_GAP_MS;
    if (gap >= MIN_BREAK_MS || ends) {
      const score = Math.abs(Math.log(i / HEAD_SESSIONS));
      if (score < bestScore) {
        bestScore = score;
        best = i;
        ended = ends;
      }
    }
    if (ends) break;
  }
  if (best === -1) return -Infinity;
  if (ended && dateGroup(t[0] as number, now, weekStartsOn).key === dateGroup(t[best] as number, now, weekStartsOn).key) return Infinity;
  return t[best - 1] as number;
}

/** A project's list: date dividers between its sessions. `group` is what a drag may stay inside. */
export type ProjectRow = { kind: "divider"; key: string; label: string } | { kind: "session"; s: ProjectSession; group: string };

/**
 * A project's sessions as the sidebar lists them: newest activity first, the
 * run of what you did last unlabelled, then a divider before each calendar
 * group (never before the first row), and inside each group the hand-made
 * `order` where it names sessions (the rest keep the places recency gave them).
 */
export function projectRows(sessions: ProjectSession[], opts: { now?: number; weekStartsOn?: number; order?: string[] } = {}): ProjectRow[] {
  const now = opts.now ?? Date.now();
  const weekStartsOn = opts.weekStartsOn ?? 1;
  const sorted = [...sessions].sort((a, b) => recency(b) - recency(a));
  const cutoff = headCutoff(sorted.map(recency).filter((t) => t > 0), now, weekStartsOn);
  const runs: Array<{ key: string; label: string; sessions: ProjectSession[] }> = [];
  for (const s of sorted) {
    const at = recency(s);
    const group = at > 0 && at >= cutoff ? { key: "recent", label: "" } : dateGroup(at, now, weekStartsOn);
    const last = runs[runs.length - 1];
    if (last && last.key === group.key) last.sessions.push(s);
    else runs.push({ ...group, sessions: [s] });
  }
  const rank = new Map((opts.order ?? []).map((id, i) => [id, i]));
  const rows: ProjectRow[] = [];
  for (const run of runs) {
    // The sessions the order names swap among the places they already hold.
    const slots = run.sessions.flatMap((s, i) => (rank.has(s.id) ? [i] : []));
    const ranked = slots.map((i) => run.sessions[i] as ProjectSession).sort((a, b) => (rank.get(a.id) as number) - (rank.get(b.id) as number));
    slots.forEach((slot, j) => (run.sessions[slot] = ranked[j] as ProjectSession));
    if (rows.length > 0 && run.key !== "recent") rows.push({ kind: "divider", key: run.key, label: run.label });
    for (const s of run.sessions) rows.push({ kind: "session", s, group: run.key });
  }
  return rows;
}

/**
 * The project's hand-made order after moving session `id` next to `target`
 * (both in one group), or by `delta` places within its group: the whole list
 * as shown, with the move. Null when the move would leave its group.
 */
export function movedOrder(rows: ProjectRow[], id: string, to: { target: string; place: "before" | "after" } | { delta: -1 | 1 }): string[] | null {
  const sessions = rows.flatMap((r) => (r.kind === "session" ? [r] : []));
  const from = sessions.findIndex((r) => r.s.id === id);
  const moving = sessions[from];
  if (!moving) return null;
  let target: string;
  let place: "before" | "after";
  if ("delta" in to) {
    const next = sessions[from + to.delta];
    if (!next || next.group !== moving.group) return null;
    target = next.s.id;
    place = to.delta < 0 ? "before" : "after";
  } else {
    const other = sessions.find((r) => r.s.id === to.target);
    if (!other || other.group !== moving.group || to.target === id) return null;
    ({ target, place } = to);
  }
  const ids = sessions.map((r) => r.s.id).filter((x) => x !== id);
  const at = ids.indexOf(target) + (place === "after" ? 1 : 0);
  ids.splice(at, 0, id);
  return ids;
}

/** An answer's Markdown as plain text for a hover card's few lines: marks off, list bullets as •. */
export const plainPreview = (text: string): string =>
  text
    .replace(/```[\s\S]*?(```|$)/g, "")
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*[-*+][ \t]+/gm, "• ")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
