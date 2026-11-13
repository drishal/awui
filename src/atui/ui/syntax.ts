// Markdown and code colours from the theme, for OpenTUI's <markdown> and <code>.
import { RGBA, SyntaxStyle, type NativeResourceOwner } from "@opentui/core";
import type { Theme } from "../theme.js";

// One style per renderer and theme: OpenTUI 0.6+ gives a style's memory to its owner, and a destroyed renderer takes
// its styles with it, so a style made for one renderer can never be handed to the next (a test's second mount).
const cache = new WeakMap<NativeResourceOwner, Map<string, SyntaxStyle>>();

/** The theme's styles, owned by the renderer that draws them. */
export function syntaxFor(theme: Theme, owner: NativeResourceOwner): SyntaxStyle {
  const key = JSON.stringify(theme);
  let mine = cache.get(owner);
  if (!mine) cache.set(owner, (mine = new Map()));
  const hit = mine.get(key);
  if (hit) return hit;
  const c = (hex: string) => RGBA.fromHex(hex);
  const heading = { fg: c(theme.accent), bold: true };
  const style = SyntaxStyle.fromStyles(
    {
      default: { fg: c(theme.text) },
      "markup.heading": heading,
      "markup.heading.1": heading,
      "markup.heading.2": heading,
      "markup.heading.3": heading,
      "markup.heading.4": heading,
      "markup.heading.5": heading,
      "markup.heading.6": heading,
      "markup.strong": { fg: c(theme.text), bold: true },
      "markup.italic": { fg: c(theme.text), italic: true },
      "markup.strikethrough": { fg: c(theme.muted) },
      "markup.raw": { fg: c(theme.rare) },
      "markup.raw.block": { fg: c(theme.text2) },
      "markup.link": { fg: c(theme.link), underline: true },
      "markup.link.label": { fg: c(theme.link) },
      "markup.link.url": { fg: c(theme.muted), underline: true },
      "markup.list": { fg: c(theme.muted) },
      "markup.quote": { fg: c(theme.text2), italic: true },
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
