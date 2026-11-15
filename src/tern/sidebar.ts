// The sessions sidebar in Tern, after the web UI's (components/Sidebar.tsx): what needs you, what is working,
// and what is pinned, then every project's sessions newest first, a project folding under its head and showing a
// few rows before "Show N more". The grouping is the browser's own (web/session-groups.ts), so the two lists agree
// on where a session goes; this file only turns it into rows and lays them out as Tern nodes.
//
// A surface has no region beside the conversation (main, dock, and layer only), so the sidebar is a sheet docked
// to the layer's left edge that takes no keys (non-modal): the composer keeps the caret, and the stylesheet moves
// the page and the dock right by its width while it shows (look.ts). The keyboard way through the same list is the
// sessions sheet (C-x s), which searches.
import { span, ui, type IconName, type Node, type Span } from "@stencil-hq/tern";
import type { ProjectSession, SessionsOverview, WorkspaceInfo } from "../shared/protocol.js";
import { groupByProject, isWorking, sidebarSections } from "../web/session-groups.js";
import { shortAgo } from "../web/turns.js";
import { projectMonogram } from "../web/project-badge.js";
import { plainTitle } from "../web/plain-title.js";

/** The sheet's width in CSS pixels: the web sidebar's default. */
export const SIDEBAR_WIDTH = 272;
/** The folded rail's width: one small button and its margins. */
export const SIDEBAR_RAIL = 44;
/**
 * Below this many columns the sidebar folds away by itself, as the web UI's does under 1200 px: about that width at
 * Tern's default 13 px font. Columns, not pixels, because Tern's cell size is in device pixels and says nothing of the
 * display's scale (a 700 px pane at 2x read as 1360 px), while the column count is the same at any scale.
 */
export const SIDEBAR_AUTO_FOLD = 150;
/** The rows a project shows before "Show N more", as the web sidebar's first stretch. */
export const PROJECT_ROWS = 6;

/** One block of the list: a fixed section above the projects, or a project with its rows. */
export interface SidebarBlock {
  key: string;
  title: string;
  /** The branch that tells a repository's projects apart, when two of them are listed. */
  branch: string | null;
  workspace: WorkspaceInfo | null;
  rows: ProjectSession[];
  /** Rows left out until "Show N more". */
  more: number;
  folded: boolean;
}

export interface SidebarModel {
  blocks: SidebarBlock[];
  /** Each project's name by id, for the rows of a section that is not one project. */
  names: ReadonlyMap<string, string>;
  /** Sessions the list leaves out (snoozed, settled, archived), named in its foot. */
  hidden: number;
}

export interface SidebarState {
  /** The harness the list is scoped to, as the web sidebar's harness switch scopes it. */
  harnessId: string | null;
  /** The project this pane is in: it comes first in its repository and stays listed when empty. */
  here: string | null;
  /** The session on screen: it stays in its project whatever it is doing. */
  current: string | null;
  /** Projects folded under their heads. */
  folded: ReadonlySet<string>;
  /** Projects showing every row. */
  expanded: ReadonlySet<string>;
  now: number;
}

/** The sidebar's blocks from the sessions overview, in the web sidebar's order. */
export function sidebarModel(overview: SessionsOverview, at: SidebarState): SidebarModel {
  const opts = { currentId: at.here, query: "", harnessId: at.harnessId, isActive: (s: ProjectSession) => s.id === at.current, now: at.now };
  const sections = sidebarSections(overview, opts);
  const fixed = (key: string, title: string, rows: ProjectSession[]): SidebarBlock[] => (rows.length > 0 ? [{ key, title, branch: null, workspace: null, rows, more: 0, folded: false }] : []);
  const projects = groupByProject(overview, opts).map((g): SidebarBlock => {
    const all = at.expanded.has(g.workspace.id);
    const rows = all ? g.sessions : g.sessions.slice(0, PROJECT_ROWS);
    return { key: `p:${g.workspace.id}`, title: g.workspace.name, branch: g.sharesRepo ? (g.checkout?.branch ?? null) : null, workspace: g.workspace, rows, more: g.sessions.length - rows.length, folded: at.folded.has(g.workspace.id) };
  });
  const { snoozed, settled, archived } = sections.counts;
  return { names: new Map(overview.workspaces.map((w) => [w.id, w.name])), blocks: [...fixed("needs", "Needs you", sections.needs), ...fixed("working", "Working", sections.working), ...fixed("pinned", "Pinned", sections.pinned), ...projects], hidden: snoozed + settled + archived };
}

/** What a row is doing when that is news, as the dot's tone: asking, working, or failed; null when it is idle. */
export function rowTone(s: ProjectSession): "warning" | "accent" | "error" | null {
  if (s.asking) return "warning";
  if (isWorking(s.status)) return "accent";
  if (s.status === "error") return "error";
  return null;
}

/**
 * A row's right edge, the web sidebar's: a toned dot when the row is doing something, then its age in the narrow form
 * ("1m", not "1m ago"), so the title keeps the width; in a section that is not one project, the project's name first.
 * A quiet row open in this server carries the web's green live dot instead.
 */
export function rowEdge(s: ProjectSession, now: number, project?: string): Span[] {
  const tone = rowTone(s) ?? (s.liveChatId ? "success" : null);
  const age = s.updatedAt ? shortAgo(Date.parse(s.updatedAt) || 0, now) : "";
  // The project and the age part with a "·" only when no dot stands between them ("alpha ● 2m", not "alpha · ● 2m").
  return [...(project ? [span(tone ? `${project} ` : age ? `${project} · ` : project, "dim")] : []), ...(tone ? [span("● ", tone)] : []), span(age, "dim")];
}

export interface SidebarCx {
  model: SidebarModel;
  harnessName: string;
  current: string | null;
  now: number;
  on: {
    open: (session: ProjectSession) => void;
    newChat: (workspace: WorkspaceInfo | null) => void;
    fold: (workspaceId: string, folded: boolean) => void;
    /** Show a project's every row, or its first ones again. */
    more: (workspaceId: string) => void;
    sessions: () => void;
    hide: () => void;
    /** The harness picker: the scope row is the web sidebar's harness switch. */
    pickHarness: () => void;
  };
}

/** A block's rows as Tern's list: the title, then at the right edge its dot and age, after its project in Needs you,
 *  Working, and Pinned; the session on screen is marked. */
function rowsNode(block: SidebarBlock, cx: SidebarCx): Node {
  const byKey = new Map(block.rows.map((s, i) => [`s${i}`, s]));
  const open = (item: string) => {
    const s = byKey.get(/(s\d+)$/.exec(item)?.[1] ?? "");
    if (s) cx.on.open(s);
  };
  // One click opens a row, as on the web: Tern's click is a select (activate is a double click or Enter).
  return ui.list({ key: "rows", role: "awui.side-rows", onSelect: (e) => open(e.item), onActivate: (e) => open(e.item) },
    block.rows.map((s, i) =>
      ui.item({
        key: `s${i}`,
        role: s.id === cx.current ? "awui.side-current" : "awui.side-row",
        label: [span(s.title ? plainTitle(s.title) : "Untitled"), ...(s.unread ? [span(" •", "accent")] : [])],
        // A fixed section's rows are not one project's, so they name theirs, as the web's.
        value: rowEdge(s, cx.now, block.workspace ? undefined : (cx.model.names.get(s.workspaceId) ?? "")),
      }),
    ),
  );
}

/** The tone and glyph of each fixed section's label, as the web sidebar draws them. */
const LABEL: Record<string, { tone: string; icon: IconName }> = {
  needs: { tone: "warning", icon: "warning" },
  working: { tone: "accent", icon: "running" },
  pinned: { tone: "muted", icon: "pin" },
};

/** A label row: the glyph (or a project's monogram) and the words on the left, the count at the right edge. */
function labelNode(key: string, words: Node | Span[], count: number, icon?: IconName | Node): Node {
  return ui.row(
    { key, role: "awui.side-label", align: "center", gap: "sm" },
    typeof icon === "string" ? ui.icon({ key: "i", name: icon }) : (icon ?? null),
    ui.text({ key: "t", grow: 1, truncate: "end" }, words as Span[]),
    ui.text({ key: "n", role: "awui.side-count" }, span(String(count), "dim")),
  );
}

/** A project's monogram, the web's folder badge: its first letter in one of four colours taken from its name. */
function badge(name: string): Node {
  const { letter, slot } = projectMonogram(name);
  return ui.text({ key: "b", role: `awui.side-badge-${slot}` }, span(letter));
}

/**
 * The sidebar: a sheet down the left edge with the web sidebar's parts in its order: the head (awui, Search, Hide),
 * New chat, the harness the list is scoped to, the fixed sections, then each project folding under its head.
 */
export function sidebarNode(cx: SidebarCx): Node {
  const blocks = cx.model.blocks.map((block) => {
    const total = block.rows.length + block.more;
    if (!block.workspace) {
      const look = LABEL[block.key] ?? { tone: "muted", icon: "session" as IconName };
      return ui.col({ key: block.key, role: `awui.side-block` }, labelNode("h", [span(block.title, look.tone)], total, look.icon), rowsNode(block, cx));
    }
    const ws = block.workspace;
    return ui.section(
      {
        key: block.key,
        role: "awui.side-project",
        head: labelNode("head", [span(block.title, "strong"), ...(block.branch ? [span(`  ${block.branch}`, "dim")] : [])], total, badge(block.title)),
        collapsible: true,
        collapsed: block.folded,
        onToggle: (e) => cx.on.fold(ws.id, e.collapsed ?? false),
      },
      block.rows.length > 0 ? rowsNode(block, cx) : ui.text({ key: "none", role: "awui.side-note" }, span("No sessions here yet", "dim")),
      block.more > 0 || block.rows.length > PROJECT_ROWS
        ? ui.button({ key: "more", text: block.more > 0 ? `Show ${block.more} more` : "Show fewer", variant: "quiet", size: "sm", onClick: () => cx.on.more(ws.id) })
        : null,
    );
  });
  return ui.overlay(
    {
      key: "sidebar",
      role: "awui.sidebar",
      side: "left",
      modal: false,
      head: [span("awui", "strong")],
      end: ui.row(
        { key: "end", gap: "xs", align: "center" },
        ui.button({ key: "find", icon: "search", variant: "quiet", size: "sm", title: "Search sessions (C-x s)", onClick: cx.on.sessions }),
        ui.button({ key: "hide", icon: "sidebar", variant: "quiet", size: "sm", title: "Hide the sidebar (C-x b)", onClick: cx.on.hide }),
      ),
      ...(cx.model.hidden > 0 ? { foot: ui.text({ key: "foot", role: "awui.side-foot" }, span(`${cx.model.hidden} snoozed, settled, or archived · C-x s`, "dim")) } : {}),
    },
    ui.scroll(
      { key: "body", role: "awui.side", gap: "md" },
      ui.button({ key: "new", role: "awui.side-new", icon: "plus", text: "New chat", title: "New chat (C-x n)", onClick: () => cx.on.newChat(null) }),
      ui.button({ key: "harness", role: "awui.side-harness", text: cx.harnessName, variant: "quiet", title: "Switch harness", onClick: cx.on.pickHarness }),
      ...(blocks.length > 0 ? blocks : [ui.text({ key: "empty", role: "awui.side-note" }, span("No chats yet. Start one in the composer.", "dim"))]),
    ),
  );
}

/**
 * The sidebar folded: a rail down the left edge with the buttons that bring it back, start a chat, and search, as
 * the web UI's header keeps a Show sidebar button when its sidebar is closed. Without it the only way back was a key.
 */
export function sidebarRail(on: { show: () => void; newChat: () => void; sessions: () => void }, asks = false): Node {
  return ui.overlay(
    { key: "sidebar-rail", role: "awui.side-rail", side: "left", modal: false },
    ui.col(
      { key: "r", gap: "xs", align: "center" },
      ui.button({ key: "show", icon: "sidebar", variant: "quiet", size: "sm", title: "Show the sidebar (C-x b)", onClick: on.show }),
      ui.button({ key: "new", icon: "plus", variant: "quiet", size: "sm", title: "New chat (C-x n)", onClick: on.newChat }),
      // A session waiting on you is still seen with the sidebar folded: a warning dot on the sessions button.
      ui.button({ key: "find", ...(asks ? { role: "awui.side-rail-asks" } : {}), icon: "search", variant: "quiet", size: "sm", title: asks ? "Search sessions (C-x s): a session needs you" : "Search sessions (C-x s)", onClick: on.sessions }),
    ),
  );
}
