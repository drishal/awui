// What floats over the chat in Tern's `layer`: the command palette and the
// session, model, thinking, permission, and harness pickers as Tern's native picker sheet; the
// composer's / $ # @ menus as a list at the caret; the C-x keys as a card at
// the bottom. Tern draws them but never takes the keyboard, so the app keeps
// each menu's query and selection and moves them by key; this module only
// filters and lays out. Pure apart from the handlers it attaches.
import { span, ui, type Node } from "@stencil-hq/tern";
import type { IconName, PickerGroup, PickerItem } from "@stencil-hq/tern";
import type { ProjectSession, SessionsOverview } from "../shared/protocol.js";
import { isBusy, placeOf, type Place } from "../web/session-groups.js";
import { ago } from "../web/turns.js";
import { EDITOR_ID } from "./dock.js";

export type MenuKind = "palette" | "sessions" | "model" | "thinking" | "permission" | "harness" | "slash" | "skill" | "prompts" | "files" | "leader";

/** One row of a menu. */
export interface MenuItem {
  id: string;
  label: string;
  detail?: string;
  /** Right-aligned: a key, an age, a count. */
  value?: string;
  icon?: string;
  /** Rows are grouped under this heading, in the order the groups first appear. */
  group?: string;
  /** The one in use (a check). */
  current?: boolean;
  /** A status dot (a tone). */
  dot?: string;
  /** Why it cannot be picked now. */
  disabled?: string;
  /** Matched in the search but not shown. */
  keywords?: string;
}

/** A menu that is open: which one, what is typed, which row is selected. */
export interface Menu {
  kind: MenuKind;
  query: string;
  selected: number;
}

const TITLES: Record<MenuKind, string> = {
  palette: "Commands",
  sessions: "Sessions",
  model: "Model",
  thinking: "Thinking",
  permission: "Permissions",
  harness: "Harness",
  slash: "Commands",
  skill: "Skills",
  prompts: "Saved prompts",
  files: "Files",
  leader: "C-x",
};

const NOUNS: Record<MenuKind, string> = {
  palette: "commands",
  sessions: "sessions",
  model: "models",
  thinking: "levels",
  permission: "modes",
  harness: "harnesses",
  slash: "commands",
  skill: "skills",
  prompts: "prompts",
  files: "files",
  leader: "keys",
};

const PLACE_RANK: Record<Place, number> = { needs: 0, working: 1, pinned: 2, project: 3, snoozed: 5, settled: 5, archived: 5 };

/**
 * The sessions picker's rows, in the web sidebar's order: what needs you, what works, the pins, this
 * project, then the other projects by their newest session; what is snoozed, settled, or archived goes
 * last, where a search still finds it. A row outside its project's group names the project.
 */
export function sessionRows(overview: SessionsOverview, at: { here: string | null; current: string | null; harnessName: (id: string) => string }, now = Date.now()): MenuItem[] {
  const names = new Map(overview.workspaces.map((w) => [w.id, w.name]));
  const opts = { currentId: at.here, query: "", harnessId: null, isActive: (s: ProjectSession) => s.id === at.current, now };
  const time = (s: ProjectSession) => (s.updatedAt ? new Date(s.updatedAt).getTime() : 0);
  const newest = new Map<string, number>();
  for (const s of overview.sessions) newest.set(s.workspaceId, Math.max(newest.get(s.workspaceId) ?? 0, time(s)));
  const rank = (s: ProjectSession) => PLACE_RANK[placeOf(s, opts)] + (placeOf(s, opts) === "project" && s.workspaceId !== at.here ? 1 : 0);
  const byProject = (a: ProjectSession, b: ProjectSession) => (newest.get(b.workspaceId) ?? 0) - (newest.get(a.workspaceId) ?? 0) || a.workspaceId.localeCompare(b.workspaceId);
  const sorted = [...overview.sessions].sort((a, b) => rank(a) - rank(b) || (rank(a) === 4 ? byProject(a, b) : 0) || time(b) - time(a));
  const GROUPS: Partial<Record<Place, string>> = { needs: "Needs you", working: "Working", pinned: "Pinned" };
  return sorted.map((s) => {
    const place = placeOf(s, opts);
    const project = names.get(s.workspaceId);
    return {
      id: s.id,
      label: s.title || "Untitled",
      // A herdr pane runs it: opening it shows that pane first (state.ts openSession).
      detail: `${at.harnessName(s.harnessId)}${s.herdr ? ` · in herdr, ${s.herdr.status}` : ""}${place !== "project" && project ? ` · ${project}` : ""}`,
      value: s.updatedAt ? ago(time(s), now) : "",
      group: GROUPS[place] ?? (place === "project" ? (project ?? "Other projects") : "Snoozed, settled, and archived"),
      ...(s.asking || s.herdr?.status === "blocked" ? { dot: "warning" } : isBusy(s.status) || s.herdr?.status === "working" ? { dot: "accent" } : s.status === "error" ? { dot: "error" } : {}),
      current: s.id === at.current,
    };
  });
}

/** Menus drawn as Tern's picker sheet (searchable); the rest are small lists. */
export const SHEETS: ReadonlySet<MenuKind> = new Set(["palette", "sessions", "model", "thinking", "permission", "harness"]);

/** Menus whose query is what the composer holds after its trigger, not typed into the menu. */
export const AT_CARET: ReadonlySet<MenuKind> = new Set(["slash", "skill", "prompts", "files"]);

/** Where each word of the query is in `label` (UTF-16 ranges), or null when a word is missing. */
export function matchRanges(label: string, query: string): Array<[number, number]> | null {
  const hay = label.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const word of query.toLowerCase().split(/\s+/).filter(Boolean)) {
    const at = hay.indexOf(word);
    if (at < 0) return null;
    ranges.push([at, at + word.length]);
  }
  return ranges.sort((a, b) => a[0] - b[0]);
}

/** The rows matching every word of the query (in the label, detail, or keywords), best first: label hits before the rest, in their order. */
export function filterItems(items: readonly MenuItem[], query: string): MenuItem[] {
  if (!query.trim()) return [...items];
  const inLabel: MenuItem[] = [];
  const elsewhere: MenuItem[] = [];
  for (const item of items) {
    if (matchRanges(item.label, query)) inLabel.push(item);
    else if (matchRanges(`${item.label} ${item.detail ?? ""} ${item.keywords ?? ""}`, query)) elsewhere.push(item);
  }
  return [...inLabel, ...elsewhere];
}

/** Move the selection by `by` rows, wrapping, skipping nothing (a disabled row can be selected, not picked). */
export function moveSelection(menu: Menu, count: number, by: number): Menu {
  if (count === 0) return { ...menu, selected: 0 };
  return { ...menu, selected: (((menu.selected + by) % count) + count) % count };
}

export interface MenuCx {
  menu: Menu;
  items: MenuItem[];
  on: {
    pick: (item: MenuItem) => void;
    select: (index: number) => void;
    close: () => void;
  };
}

/** The picker sheet: grouped rows, the query's hits marked, the current row checked. */
function sheet(cx: MenuCx): Node {
  const { menu, items } = cx;
  const order: Array<string | PickerGroup> = [];
  let group: string | undefined;
  for (const item of items) {
    if (item.group && item.group !== group) {
      group = item.group;
      order.push({ group: item.group, label: item.group, count: items.filter((i) => i.group === item.group).length });
    }
    order.push(item.id);
  }
  const rows: PickerItem[] = items.map((item) => {
    const hits = matchRanges(item.label, menu.query);
    return {
      id: item.id,
      label: item.label,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.icon ? { icon: item.icon as IconName } : {}),
      ...(item.dot ? { dot: item.dot as "accent" } : {}),
      ...(item.value ? { facts: { v: item.value } } : {}),
      ...(item.disabled ? { disabled: item.disabled } : {}),
      ...(hits && hits.length > 0 ? { hits } : {}),
    };
  });
  const selected = items[menu.selected]?.id;
  return ui.picker({
    key: menu.kind,
    size: menu.kind === "sessions" ? "lg" : "md",
    preview: "none",
    title: TITLES[menu.kind],
    noun: NOUNS[menu.kind],
    query: menu.query,
    cursor: menu.query.length,
    placeholder: menu.kind === "palette" ? "Type a command…" : `Search ${NOUNS[menu.kind]}…`,
    items: rows,
    order,
    ...(selected ? { selected } : {}),
    current: items.filter((i) => i.current).map((i) => i.id),
    columns: items.some((i) => i.value) ? [{ id: "v", head: "", format: "dim", priority: 50 }] : [],
    empty: `No ${NOUNS[menu.kind]} match`,
    actions: [
      { id: "close", label: "Close", keys: ["esc"] },
      { id: "pick", label: menu.kind === "sessions" ? "Open" : "Choose", keys: ["enter"], primary: true },
    ],
    onSelect: (e) => cx.on.select(items.findIndex((i) => i.id === e.item)),
    onActivate: (e) => {
      const item = items.find((i) => i.id === e.item);
      if (item) cx.on.pick(item);
    },
    onAction: {
      close: cx.on.close,
      pick: () => {
        const item = items[menu.selected];
        if (item) cx.on.pick(item);
      },
    },
  });
}

/** A small list: over the caret for the composer's menus, or at the bottom for C-x. */
function list(cx: MenuCx): Node {
  const { menu, items } = cx;
  const at = AT_CARET.has(menu.kind);
  const shown = items.slice(0, 40);
  const rows = shown.map((item, i) =>
    ui.item({
      key: `i${i}`,
      label: item.current ? [span(item.label), span("  ✓", "accent")] : item.label,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.value ? { value: item.value } : {}),
      ...(item.icon ? { icon: item.icon as IconName } : {}),
      ...(item.disabled ? { disabled: true } : {}),
    }),
  );
  return ui.overlay(
    {
      key: menu.kind,
      anchor: at ? { caret: EDITOR_ID } : menu.kind === "leader" ? "bottom" : "center",
      size: at ? "md" : "sm",
      ...(at ? {} : { head: TITLES[menu.kind] }),
    },
    ui.list({
      key: "l",
      ...(shown[menu.selected] ? { selected: `layer.${menu.kind}.l.i${menu.selected}` } : {}),
      filter: menu.query,
      empty: [span(`No ${NOUNS[menu.kind]} match`, "muted")],
      max: { lines: 12 },
      onSelect: (e) => cx.on.select(Number(/\.i(\d+)$/.exec(e.item)?.[1] ?? -1)),
      onActivate: (e) => {
        const item = shown[Number(/\.i(\d+)$/.exec(e.item)?.[1] ?? -1)];
        if (item) cx.on.pick(item);
      },
    }, rows),
  );
}

/** The open menu's node, for `layer`. */
export function menuNode(cx: MenuCx): Node {
  return SHEETS.has(cx.menu.kind) ? sheet(cx) : list(cx);
}
