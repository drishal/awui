// Every key the web UI answers, in one table: the shortcut sheet (? or
// Ctrl+/) lists it, and the palette's hints read their keys from it, so the
// two cannot drift apart. Keys are written as "Mod+Shift+F" (Mod is Ctrl, or
// ⌘ on a Mac); several ways to press one thing are separate entries in `keys`.
// Pure, apart from asking the browser whether it runs on a Mac.

export interface Shortcut {
  id: string;
  keys: string[];
  label: string;
}

export interface ShortcutGroup {
  title: string;
  items: Shortcut[];
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: "Anywhere",
    items: [
      { id: "palette", keys: ["Mod+K"], label: "Commands, sessions, models, and settings" },
      { id: "new", keys: ["Mod+N"], label: "New chat" },
      { id: "shortcuts", keys: ["?", "Mod+/"], label: "These shortcuts" },
      { id: "history-search", keys: ["Mod+Shift+H"], label: "Search every chat" },
      { id: "search", keys: ["Mod+Shift+F"], label: "Search in project" },
      { id: "find", keys: ["Mod+F"], label: "Find in this chat" },
      { id: "back", keys: ["Mod+["], label: "Back to the previous chat" },
      { id: "forward", keys: ["Mod+]"], label: "Forward to the next chat" },
      { id: "reopen", keys: ["Alt+Shift+T"], label: "Reopen the last closed tab" },
      { id: "undo-mark", keys: ["Mod+Z"], label: "Undo a pin, archive, or snooze (while its toast shows)" },
      { id: "close", keys: ["Esc"], label: "Close a dialog, menu, or panel" },
    ],
  },
  {
    title: "Composer",
    items: [
      { id: "send", keys: ["Enter"], label: "Send (while the agent works: steer)" },
      { id: "newline", keys: ["Shift+Enter"], label: "New line (in a list: the next item)" },
      { id: "send-new", keys: ["Mod+Alt+Enter"], label: "Send, then start a new chat in a tab" },
      { id: "then", keys: ["Mod+Shift+Enter"], label: "While a run goes: send this once it is over (the chain)" },
      { id: "indent", keys: ["Tab", "Shift+Tab"], label: "Indent or outdent a list item" },
      { id: "recall", keys: ["↑", "↓"], label: "Recall the prompts sent in this chat" },
      { id: "stash", keys: ["Alt+S"], label: "Stash the draft for later" },
      { id: "commands", keys: ["/"], label: "The harness's commands (at the start)" },
      { id: "skills", keys: ["$"], label: "The harness's skills (at the start)" },
      { id: "mention", keys: ["@"], label: "Mention a project file" },
      { id: "prompts", keys: ["#"], label: "Put in a saved prompt (at the start)" },
      { id: "blank", keys: ["Tab", "Shift+Tab"], label: "Next or previous blank of a saved prompt" },
    ],
  },
  {
    title: "Conversation",
    items: [
      { id: "find-next", keys: ["Enter", "Shift+Enter"], label: "Next or previous match (in Find)" },
      { id: "edit-save", keys: ["Mod+Enter"], label: "Save an edited message, or a review comment" },
      { id: "answer", keys: ["1–9"], label: "Pick an answer to the agent's question" },
      { id: "answer-move", keys: ["↑", "↓"], label: "Move between an approval's buttons" },
      { id: "new-tab", keys: ["Mod+Click"], label: "Open a session in a new tab" },
    ],
  },
  {
    title: "Tabs and lists",
    items: [
      { id: "tab-move", keys: ["←", "→", "Home", "End"], label: "Move between tabs" },
      { id: "tab-reorder", keys: ["Alt+Shift+←", "Alt+Shift+→"], label: "Move the focused tab left or right (inside its group, pinned or not)" },
      { id: "tab-close", keys: ["Delete"], label: "Close the focused tab (a pinned one stays)" },
      { id: "list-move", keys: ["↑", "↓"], label: "Move in a picker or search's results" },
      { id: "list-pick", keys: ["Enter"], label: "Pick the highlighted result" },
      { id: "search-open", keys: ["Alt+Enter"], label: "Open a project search result in the file viewer" },
      { id: "session-move", keys: ["Alt+↑", "Alt+↓"], label: "Move a sidebar session up or down inside its date section" },
    ],
  },
];

/** Whether the browser runs on a Mac (or an iPad with a keyboard): ⌘ and ⌥ instead of Ctrl and Alt. */
export function onMac(): boolean {
  if (typeof navigator === "undefined") return false;
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

const MAC: Record<string, string> = { Mod: "⌘", Alt: "⌥", Shift: "⇧", Enter: "↩", Esc: "esc" };
const PC: Record<string, string> = { Mod: "Ctrl" };

/** One key combination as the keys to press, for keycaps: "Mod+Shift+F" → ["Ctrl", "Shift", "F"] (["⌘", "⇧", "F"] on a Mac). */
export function keyCaps(combo: string, mac = onMac()): string[] {
  // "Mod++" would split badly; no shortcut uses a plus key, and a lone "+" is not a combination.
  const parts = combo === "+" ? ["+"] : combo.split("+");
  return parts.map((p) => (mac ? MAC[p] : PC[p]) ?? p);
}

/** A combination as one hint: "Ctrl+Shift+F", or "⌘⇧F" on a Mac. */
export function keyHint(combo: string, mac = onMac()): string {
  return keyCaps(combo, mac).join(mac ? "" : "+");
}

/** The first keys of shortcut `id`, as a palette hint; "" for an id that is not in the table. */
export function shortcutHint(id: string, mac = onMac()): string {
  for (const group of SHORTCUTS) {
    const hit = group.items.find((s) => s.id === id);
    if (hit?.keys[0]) return keyHint(hit.keys[0], mac);
  }
  return "";
}

/** The groups holding `query` (in a label or a key), each with only its matching shortcuts. */
export function filterShortcuts(query: string, mac = onMac()): ShortcutGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return SHORTCUTS;
  const hay = (s: Shortcut) => `${s.label} ${s.keys.map((k) => `${k} ${keyHint(k, mac)}`).join(" ")}`.toLowerCase();
  return SHORTCUTS.map((g) => ({ ...g, items: g.items.filter((s) => q.split(/\s+/).every((w) => hay(s).includes(w))) })).filter((g) => g.items.length > 0);
}

/** The groups in two stacks of about the same height (rows plus a heading each), in order, for the sheet's columns. */
export function balanceColumns(groups: ShortcutGroup[]): [ShortcutGroup[], ShortcutGroup[]] {
  const size = (g: ShortcutGroup) => g.items.length + 2;
  const total = groups.reduce((n, g) => n + size(g), 0);
  const left: ShortcutGroup[] = [];
  let height = 0;
  for (const g of groups) {
    // A group goes left while that keeps the left stack nearer half than leaving it out would.
    if (left.length === groups.indexOf(g) && Math.abs(total / 2 - (height + size(g))) <= Math.abs(total / 2 - height)) {
      left.push(g);
      height += size(g);
    } else break;
  }
  if (left.length === 0 && groups[0]) left.push(groups[0]);
  return [left, groups.slice(left.length)];
}

/** Whether a key press is the sheet's: "?" outside a text box, or Mod+/ anywhere. */
export function isShortcutsKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "target">): boolean {
  if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key === "/") return true;
  if (e.key !== "?" || e.ctrlKey || e.metaKey || e.altKey) return false;
  const target = e.target as HTMLElement | null;
  return !target?.closest?.("input, textarea, select, [contenteditable='true'], dialog");
}
