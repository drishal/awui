// Markdown and code colours from the theme, for OpenTUI's <markdown> and <code>.
import { RGBA, SyntaxStyle, type NativeResourceOwner } from "@opentui/core";
import type { Theme } from "../theme.js";
import { mix } from "../fx.js";

// One style per renderer and theme: OpenTUI 0.6+ gives a style's memory to its owner, and a destroyed renderer takes
// its styles with it, so a style made for one renderer can never be handed to the next (a test's second mount).
const cache = new WeakMap<NativeResourceOwner, Map<string, SyntaxStyle>>();

/** The theme's styles, owned by the renderer that draws them; quiet styles never leak into answers. */
/** `found`: the landed turn of a find, whose bold runs are the matched words, set on a warn-tinted ground as the web marks them. */
export function syntaxFor(theme: Theme, owner: NativeResourceOwner, quiet = false, found = false): SyntaxStyle {
  const key = `${JSON.stringify(theme)}:${quiet}:${found}`;
  let mine = cache.get(owner);
  if (!mine) cache.set(owner, (mine = new Map()));
  const hit = mine.get(key);
  if (hit) return hit;
  const c = (hex: string) => RGBA.fromHex(hex);
  // The quiet ramp stays a ramp (muted toward text), never a background mix: bold must be
  // more prominent than the plain reasoning prose, in both polarities, and every role the
  // reasoning body draws rides the same ramp so nothing renders as loud as an answer.
  const normal = quiet ? theme.muted : theme.text;
  const emphasis = quiet ? mix(theme.muted, theme.text, 0.35) : theme.text;
  const headingColor = quiet ? mix(theme.accent, theme.muted, 0.35) : theme.accent;
  const block = quiet ? theme.muted : theme.text2;
  const heading = { fg: c(headingColor), bold: true };
  const style = SyntaxStyle.fromStyles(
    {
      default: { fg: c(normal) },
      "markup.heading": heading,
      "markup.heading.1": heading,
      "markup.heading.2": heading,
      "markup.heading.3": heading,
      "markup.heading.4": heading,
      "markup.heading.5": heading,
      "markup.heading.6": heading,
      "markup.strong": found ? { fg: c(theme.text), bg: c(mix(theme.bg, theme.warn, 0.4)), bold: true } : { fg: c(emphasis), bold: true },
      "markup.italic": { fg: c(emphasis), italic: true },
      "markup.strikethrough": { fg: c(theme.muted) },
      "markup.raw": { fg: c(theme.rare) },
      "markup.raw.block": { fg: c(block) },
      "markup.link": { fg: c(theme.link), underline: true },
      "markup.link.label": { fg: c(theme.link) },
      "markup.link.url": { fg: c(theme.muted), underline: true },
      "markup.list": { fg: c(theme.muted) },
      "markup.quote": { fg: c(block), italic: true },
      keyword: { fg: c(theme.thinking) },
      string: { fg: c(theme.ok) },
      comment: { fg: c(theme.muted), italic: true },
      number: { fg: c(theme.orange) },
      function: { fg: c(theme.link) },
      type: { fg: c(theme.rare) },
    },
    owner,
  );
  mine.set(key, style);
  return style;
}
