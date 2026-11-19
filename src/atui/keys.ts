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
  { key: "a", label: "new chat, new tab" },
  { key: "]", label: "next tab" },
  { key: "[", label: "previous tab" },
  { key: "w", label: "close tab" },
  { key: "m", label: "+model", menu: true },
  { key: "o", label: "reasoning" },
  { key: "t", label: "+thinking", menu: true },
  { key: "h", label: "+harness", menu: true },
  { key: "c", label: "compact context" },
  { key: "z", label: "put undone files back" },
  { key: "d", label: "review changes" },
  { key: "j", label: "delegated work" },
  { key: "k", label: "agents dashboard" },
  { key: "p", label: "active work panel" },
  { key: "u", label: "git panel" },
  { key: "x", label: "run a command" },
  { key: "f", label: "compact before send" },
  { key: "e", label: "show all work" },
  { key: "v", label: "vim navigation" },
  { key: "g", label: "glass mode" },
  { key: "l", label: "chat width" },
  { key: "q", label: "quit atui" },
];

/** The C-x keys on one line, for a narrow terminal's hint. */
export const LEADER_HELP = LEADER_KEYS.map((k) => `${k.key} ${k.label.replace(/^\+/, "")}`).join(" · ");

/**
 * The width of one which-key column. Every `k → label (state)` fits it (the
 * unit test pins this), so a column never truncates a line into its neighbour
 * with the renderer's mid-word cut — and three columns fit an 80-column pane,
 * keeping the panel to nine rows instead of fourteen.
 */
export const WHICH_KEY_CELL = 26;
/** NORMAL mode's reminder as it starts, short enough for the composer's footer (the README has them all). */
export const VIM_HELP = "j/k scroll · gg/G top/bottom · {/} turns · i type";

/** The C-x hint for a key: "C-x n". */
export const leader = (key: string): string => `C-x ${key}`;

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
