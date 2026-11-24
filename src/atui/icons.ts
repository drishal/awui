// The marks atui draws for a kind of call, an edit, a find: two sets, plain Unicode (works in any font, the default) and Nerd Font glyphs (the look
// omp's statusline has, for a terminal whose font carries them). One module-level signal holds the choice so the transcript, the Timing rows and
// the composer all follow a toggle at once, and nothing else has to be passed the set. Chosen by --icons, else $ATUI_ICONS, else what the palette's
// "Icons" entry last saved in atui.json (prefs.ts); a value that is neither "unicode" nor "nerd" is ignored. Nerd codepoints are the Font Awesome
// range (U+F000-F2FF), present in every Nerd Fonts version since 2.0. Some are drawn wider than a cell in a non-Mono Nerd Font, so the "Nerd Font Mono" variant is the one to set in the terminal.
import { createSignal } from "solid-js";

export type IconSet = "unicode" | "nerd";
export type IconName = "read" | "edit" | "write" | "command" | "search" | "web" | "agent" | "other" | "plan" | "mcp" | "fail" | "pencil" | "find" | "changed" | "routine" | "retry";

const UNICODE: Record<IconName, string> = { read: "▤", edit: "±", write: "±", command: "›", search: "◎", web: "⊕", agent: "◈", other: "●", plan: "≡", mcp: "◇", fail: "✗", pencil: "✎", find: "⌕", changed: "±", routine: "↻", retry: "↻" };
// Nerd Font Awesome: file-text, pencil, floppy (a write), terminal, search, globe, sitemap, circle, tasks, plug, times, pencil, search, pencil-square-o.
const NERD: Record<IconName, string> = {
  read: "",
  edit: "",
  write: "",
  command: "",
  search: "",
  web: "",
  agent: "",
  other: "",
  plan: "",
  mcp: "",
  fail: "",
  pencil: "",
  find: "",
  changed: "",
  routine: "",
  retry: "",
};

const [iconSet, setIconSet] = createSignal<IconSet>("unicode");
export { iconSet, setIconSet };

/** A value from a flag, the environment or atui.json as an icon set, or undefined when it is neither. */
export function iconSetFrom(value: unknown): IconSet | undefined {
  return value === "unicode" || value === "nerd" ? value : undefined;
}

/** The mark for this name in the current set; reads the signal, so a toggle redraws every caller that runs inside an effect. */
export function icon(name: IconName, set: IconSet = iconSet()): string {
  return (set === "nerd" ? NERD : UNICODE)[name];
}
