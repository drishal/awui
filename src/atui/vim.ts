// atui's vim keybinds: in the vim style the app lives in NORMAL, where keys
// move around the conversation and act instead of typing, and i, a, A, I, o,
// or Enter go to INSERT (the composer). Motions take a count (5j, 3gt), and a
// few keys wait for a second (g, z, Z). Only the reading surface: the composer
// itself stays a plain editor, and INSERT is an ordinary text box.
//
//   j k / ↓ ↑     a line (with a count: 5j)      Ctrl+E Ctrl+Y  a line
//   Ctrl+D Ctrl+U half a page                    Ctrl+F Ctrl+B  a page
//   gg G          top, bottom                    { }  [ ]       previous, next turn
//   zR zM         open, fold every turn's work   zz             centre the turn read
//   gt gT 3gt     next, previous, that tab       q              close the tab
//   ZZ            quit atui                      Ctrl+O Ctrl+I  jumplist back, forward
//   h l           the session list, back         i a A I o Enter  INSERT (o: a new chat)
//   :             the command palette           /              the history
//   Space ?       the leader panel (SPC v: emacs keybinds)
//
// Worked out apart from the drawing (a key and what came before it in, an
// action and the new prefix out), so it can be tested.

export type VimAction =
  | { kind: "scroll"; lines: number }
  | { kind: "half"; dir: 1 | -1 }
  | { kind: "page"; dir: 1 | -1 }
  | { kind: "top" }
  | { kind: "bottom" }
  | { kind: "turn"; count: number }
  | { kind: "folds"; open: boolean }
  | { kind: "view"; where: "middle" }
  | { kind: "insert"; open?: boolean }
  | { kind: "sidebar" }
  | { kind: "leave" }
  | { kind: "tab"; to?: number; step?: number }
  | { kind: "closeTab" }
  | { kind: "quit" }
  | { kind: "leader" }
  | { kind: "jump"; dir: -1 | 1 }
  | { kind: "palette" }
  | { kind: "history" };

export interface VimKey {
  name: string;
  sequence: string;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

/** What NORMAL mode does with `key`, given the keys before it (a count, a `g`, `z` or `Z`): the action, or none yet, and what is now pending. */
export function vimKey(key: VimKey, pending: string): { action: VimAction | null; pending: string } {
  const none = { action: null, pending: "" };
  if (key.meta) return none;
  const count = Number(/^\d+/.exec(pending)?.[0] ?? "1") || 1;
  const prefix = pending.replace(/^\d+/, "");
  const ch = key.sequence.length === 1 ? key.sequence : "";

  if (key.ctrl) {
    const ctrl: Record<string, VimAction> = {
      d: { kind: "half", dir: 1 },
      u: { kind: "half", dir: -1 },
      f: { kind: "page", dir: 1 },
      b: { kind: "page", dir: -1 },
      e: { kind: "scroll", lines: count },
      y: { kind: "scroll", lines: -count },
      o: { kind: "jump", dir: -1 },
      // A terminal's Ctrl+I is Tab, and in NORMAL it is the jumplist forward, as in vim itself.
      i: { kind: "jump", dir: 1 },
    };
    const action = ctrl[key.name];
    return action ? { action, pending: "" } : none;
  }

  if (prefix === "g") {
    if (ch === "g") return { action: { kind: "top" }, pending: "" };
    // 3gt is vim's "go to tab 3"; without a count, gt steps to the next one.
    if (ch === "t") return { action: { kind: "tab", ...(count > 1 ? { to: count - 1 } : { step: 1 }) }, pending: "" };
    if (ch === "T") return { action: { kind: "tab", ...(count > 1 ? { to: count - 1 } : { step: -1 }) }, pending: "" };
    return none;
  }
  if (prefix === "z") {
    if (ch === "R" || ch === "o") return { action: { kind: "folds", open: true }, pending: "" };
    if (ch === "M" || ch === "c") return { action: { kind: "folds", open: false }, pending: "" };
    if (ch === "z") return { action: { kind: "view", where: "middle" }, pending: "" };
    return none;
  }
  // ZZ, vim's write-and-quit: the chat keeps running on the server either way.
  if (prefix === "Z") return ch === "Z" ? { action: { kind: "quit" }, pending: "" } : none;

  // A count: 1-9 starts one, 0 continues it.
  if (/^[1-9]$/.test(ch) || (ch === "0" && /^\d+$/.test(pending))) return { action: null, pending: `${pending}${ch}` };

  switch (ch || key.name) {
    case "j":
    case "down":
      return { action: { kind: "scroll", lines: count }, pending: "" };
    case "k":
    case "up":
      return { action: { kind: "scroll", lines: -count }, pending: "" };
    case "g":
      return { action: null, pending: `${pending}g` };
    case "z":
      return { action: null, pending: `${pending}z` };
    case "Z":
      return { action: null, pending: `${pending}Z` };
    case "G":
      return { action: { kind: "bottom" }, pending: "" };
    case "}":
    case "]":
      return { action: { kind: "turn", count }, pending: "" };
    case "{":
    case "[":
      return { action: { kind: "turn", count: -count }, pending: "" };
    case "i":
    case "I":
    case "a":
    case "A":
    case "return":
      return { action: { kind: "insert" }, pending: "" };
    // o is vim's "open below": a new chat, straight into INSERT.
    case "o":
      return { action: { kind: "insert", open: true }, pending: "" };
    case "h":
      return { action: { kind: "sidebar" }, pending: "" };
    case "l":
      return { action: { kind: "leave" }, pending: "" };
    case "q":
      return { action: { kind: "closeTab" }, pending: "" };
    case "tab":
    // A terminal's Tab is Ctrl+I, and its raw byte arrives with a one-char sequence.
    case "\t":
      return { action: { kind: "jump", dir: 1 }, pending: "" };
    case " ":
    case "space":
    case "?":
      return { action: { kind: "leader" }, pending: "" };
    case ":":
      return { action: { kind: "palette" }, pending: "" };
    case "/":
      return { action: { kind: "history" }, pending: "" };
    default:
      return none;
  }
}

/** How far to scroll to bring the next (or previous) turn's top to the top of the view. */
export function turnOffset(tops: number[], viewTop: number, count: number): number | null {
  const sorted = [...tops].sort((a, b) => a - b);
  if (count > 0) {
    const below = sorted.filter((y) => y > viewTop);
    const target = below[Math.min(count, below.length) - 1];
    return target === undefined ? null : target - viewTop;
  }
  const above = sorted.filter((y) => y < viewTop);
  const target = above[Math.max(0, above.length + count)];
  return target === undefined ? null : target - viewTop;
}

/**
 * The reading position a jumplist entry should leave you at: the transcript is
 * measured from its content's top, so a jump is that offset.
 */
export interface Jump {
  y: number;
}

/** Records where a jump left from: the past is kept, the forward path is cut, and only the last hundred stand. */
export function pushJump(list: Jump[], at: number, from: number): { list: Jump[]; at: number } {
  const kept = [...list.slice(0, at + 1), { y: from }].slice(-100);
  return { list: kept, at: kept.length - 1 };
}
