// The command palette's items and their ranking. Matching is the model
// picker's (punctuation- and space-insensitive); a section name matches too,
// so "theme dark" or "model opus" find their entries.
import { normalize } from "./model-search.js";

export interface PaletteItem {
  id: string;
  section: string;
  label: string;
  /** Right-aligned detail: a project, a provider, a shortcut. */
  hint?: string;
  /** The hint is a key combination ("Ctrl+Shift+H", "#"): drawn as keycaps, not as words. */
  keys?: boolean;
  /** Matched but never shown: a session's harness, a model's id. */
  keywords?: string;
  /** Listed only once something is typed (every model, older sessions). */
  searchOnly?: boolean;
  /** Why it cannot run now; shown greyed. */
  disabled?: string;
  /** The current choice (a model, the theme): checked. */
  current?: boolean;
  run: () => void;
}

const compact = (value: string): string => normalize(value).replaceAll(" ", "");

function rank(item: PaletteItem, q: string, qc: string): number | null {
  const label = normalize(item.label);
  if (label.startsWith(q) || compact(item.label).startsWith(qc)) return 0;
  if (label.split(" ").some((word) => word.startsWith(q))) return 1;
  if (label.includes(q) || compact(item.label).includes(qc)) return 2;
  const rest = normalize(`${item.hint ?? ""} ${item.keywords ?? ""}`);
  if (rest.includes(q)) return 3;
  const hay = `${normalize(item.section)} ${label} ${rest}`;
  if (q.split(" ").every((word) => hay.includes(word))) return 4;
  return null;
}

/** What the palette lists for `query`, best first; with no query, every item not marked searchOnly, in order. */
export function rankItems(items: PaletteItem[], query: string, limit = 60): PaletteItem[] {
  const q = normalize(query);
  if (!q) return items.filter((i) => !i.searchOnly).slice(0, limit);
  const qc = compact(query);
  const ranked: Array<{ item: PaletteItem; r: number; i: number }> = [];
  items.forEach((item, i) => {
    const r = rank(item, q, qc);
    if (r !== null) ranked.push({ item, r, i });
  });
  return ranked
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .slice(0, limit)
    .map((x) => x.item);
}

/** Ctrl+K, or ⌘K on a Mac. */
export function isPaletteKey(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k";
}
