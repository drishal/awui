// atui's keys in Emacs notation (C-x is Ctrl+X, M-m is Alt+M), and the C-x
// prefix's table, which the which-key panel, the help line, and the palette
// hints all read, so they cannot drift apart. Laid out column by column the
// way Emacs's which-key does.

export interface PrefixKey {
  key: string;
  /** What it does, as the panel names it. */
  label: string;
  /** A prefix-like entry (another menu) is drawn in a different colour, as which-key draws `+prefix`. */
  menu?: boolean;
}

/** C-x then one of these. */
export const LEADER_KEYS: PrefixKey[] = [
  { key: "b", label: "side panel" },
  { key: "s", label: "browse sessions" },
  { key: "r", label: "+history", menu: true },
  { key: "i", label: "info tab" },
  { key: "n", label: "new chat" },
  { key: "a", label: "new tab" },
  { key: "]", label: "next tab" },
  { key: "[", label: "previous tab" },
  { key: "w", label: "close tab" },
  { key: "m", label: "+model", menu: true },
  { key: "o", label: "reasoning" },
  { key: "t", label: "+thinking", menu: true },
  { key: "h", label: "+harness", menu: true },
  { key: "c", label: "compact context" },
  { key: "z", label: "restore undone files" },
  { key: "d", label: "review changes" },
  { key: "j", label: "delegated work" },
  { key: "k", label: "agents dashboard" },
  { key: "p", label: "active work panel" },
  { key: "u", label: "git panel" },
  { key: "x", label: "run a command" },
  { key: "f", label: "compact or full" },
  { key: "e", label: "show all work" },
  { key: "v", label: "keybinds" },
  { key: "g", label: "glass mode" },
  { key: "l", label: "chat width" },
  { key: "q", label: "quit atui" },
];

/** The C-x keys on one line, for a narrow terminal's hint. */
export const LEADER_HELP = LEADER_KEYS.map((k) => `${k.key} ${k.label.replace(/^\+/, "")}`).join(" · ");

/**
 * The width of one which-key column. Every `k → label (state)` fits it with
 * two columns to spare (the unit test pins this), so a full cell keeps air
 * beside its neighbour and the renderer's mid-word cut never fires — and
 * three columns fit an 80-column pane, keeping the panel to nine rows
 * instead of fourteen.
 */
export const WHICH_KEY_CELL = 26;
/** The air a which-key line keeps inside its cell, so one column never reads as part of the next. */
export const WHICH_KEY_AIR = 2;
/** NORMAL mode's reminder as it starts, short enough for the composer's footer (the README has them all). */
/** NORMAL's reminder as it starts, short enough for the composer's footer. */
export const VIM_HELP = "j/k scroll · gg/G top/bottom · {/} turns · SPC actions · : commands · i type";

/** The leader hint for a key: "C-x n" or "SPC n". */
/** The two keybind styles atui ships: the Emacs chords, or vim's NORMAL-first keys. */
export type KeybindStyle = "emacs" | "vim";

/** The leader key's name in each style: the chords and the panel's footer cue read it. */
export function leaderPrefix(style: KeybindStyle): string {
  return style === "vim" ? "SPC" : "C-x";
}

/** The C-x hint for a key: "C-x n" in the Emacs style, "SPC n" in vim's. */
export const leader = (key: string, style: KeybindStyle = "emacs"): string => `${leaderPrefix(style)} ${key}`;

/**
 * The keys the empty screen, its tips, and the palette name for the actions
 * people reach for first: each style's own binding, so those surfaces cannot
 * drift from what the keys actually do.
 */
export function actionKeys(style: KeybindStyle): {
  commands: string;
  history: string;
  sessions: string;
  files: string;
  model: string;
  thinking: string;
  harness: string;
  thoughts: string;
  glass: string;
  keybinds: string;
} {
  return {
    commands: style === "vim" ? ":" : "C-k",
    history: style === "vim" ? "/" : "C-r",
    sessions: leader("s", style),
    files: "@",
    model: style === "vim" ? leader("m", style) : "M-m",
    thinking: style === "vim" ? leader("t", style) : "M-t",
    harness: style === "vim" ? leader("h", style) : "M-h",
    thoughts: style === "vim" ? leader("o", style) : "C-t",
    glass: leader("g", style),
    keybinds: leader("v", style),
  };
}

/** The empty screen's hint row: the four keys that get you somewhere. */
export function splashHints(style: KeybindStyle): Array<{ key: string; label: string }> {
  const keys = actionKeys(style);
  return [
    { key: keys.commands, label: "commands" },
    { key: keys.history, label: "history" },
    { key: keys.sessions, label: "sessions" },
    { key: keys.files, label: "files" },
  ];
}

/** The hint row as one line, for tests and a narrow look at the same keys. */
export function splashHintLine(style: KeybindStyle): string {
  return splashHints(style).map((h) => `${h.key} ${h.label}`).join(" · ");
}

/**
 * Which-key's grid for `count` entries in `width` columns: as many columns of
 * `cell` characters as fit, filled top to bottom, then left to right.
 */
export function whichKeyGrid(count: number, width: number, cell: number): { columns: number; rows: number } {
  const columns = Math.max(1, Math.min(count, Math.floor(width / Math.max(1, cell))));
  return { columns, rows: Math.max(1, Math.ceil(count / columns)) };
}

/** The entries in each column of the grid, column-major. */
export function whichKeyColumns<T>(entries: T[], width: number, cell: number): T[][] {
  const { columns, rows } = whichKeyGrid(entries.length, width, cell);
  return Array.from({ length: columns }, (_, c) => entries.slice(c * rows, c * rows + rows)).filter((col) => col.length > 0);
}
