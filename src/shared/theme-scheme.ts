// A base16 / base24 scheme as data, and the CSS custom properties it becomes.
// Shared so the theme editor previews exactly what the server will serve: the
// same roles, the same contrast checks, the same nudges. Pure (no YAML, no fs):
// server/theme.ts parses files into a Scheme, the browser builds one from its
// colour pickers.

/** base00…base0F, in order: every scheme has them. */
export const BASE16_KEYS = Array.from({ length: 16 }, (_, i) => `base0${i.toString(16).toUpperCase()}`);
/** base10…base17: base24's extra brights, optional. */
export const BASE24_KEYS = Array.from({ length: 8 }, (_, i) => `base1${i}`);

export interface Scheme {
  name: string;
  polarity: "dark" | "light";
  /** `#rrggbb`, lower case, keyed base00…base0F (and base10…base17 for base24). */
  palette: Record<string, string>;
  fonts: { sans?: string; mono?: string };
}

/** Exact 6-digit hex, with or without `#`: colours become CSS custom properties, so nothing else gets through. */
export const HEX_COLOR = /^#?([0-9a-fA-F]{6})$/;
/** A font family name that cannot escape a CSS font stack. */
export const FONT_NAME = /^[A-Za-z0-9 -]{1,64}$/;

/** A scheme name made safe to show and to write back: letters, digits, and a few marks, at most 60. */
export function cleanSchemeName(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} ._()-]/gu, "").trim().slice(0, 60);
}

// ---- color math ---------------------------------------------------------------

type RGB = [number, number, number];

function toRgb(hex: string): RGB {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: RGB): string {
  return `#${[r, g, b].map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, "0")).join("")}`;
}

export function luminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  }) as RGB;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function mix(a: string, b: string, t: number): string {
  const ca = toRgb(a);
  const cb = toRgb(b);
  return toHex([0, 1, 2].map((i) => (ca[i] as number) + ((cb[i] as number) - (ca[i] as number)) * t) as RGB);
}

/** Move `fg` toward white or black until it reaches `min` against every background. */
function ensure(fg: string, backgrounds: string[], min: number, towardLight: boolean): { color: string; adjusted: boolean } {
  const ok = (c: string) => backgrounds.every((bg) => contrast(c, bg) >= min);
  if (ok(fg)) return { color: fg, adjusted: false };
  const target = towardLight ? "#ffffff" : "#000000";
  for (let t = 0.05; t <= 1.0001; t += 0.05) {
    const candidate = mix(fg, target, t);
    if (ok(candidate)) return { color: candidate, adjusted: true };
  }
  return { color: target, adjusted: true };
}

/** The scheme's polarity when the file does not say: dark when its background is. */
export function polarityOf(base00: string): "dark" | "light" {
  return luminance(base00) < 0.5 ? "dark" : "light";
}

/**
 * The scheme as the web UI's custom properties, every text and control role checked against WCAG AA
 * (4.5:1 text, 3:1 controls) on the page, the cards, and the chip surface, and nudged when short.
 * `adjusted` names the roles that were nudged.
 */
export function buildThemeVars(scheme: Scheme): { vars: Record<string, string>; adjusted: string[] } {
  const p = scheme.palette as Record<string, string> & { base00: string };
  const light = scheme.polarity === "dark";
  const bg = p.base00;
  const surface = p.base01 as string;
  const adjusted: string[] = [];
  const role = (name: string, color: string, min: number, against: string[] = [bg, surface]) => {
    const result = ensure(color, against, min, light);
    if (result.adjusted) adjusted.push(name);
    return result.color;
  };
  const accent = role("accent", p.base0D as string, 3);
  const accentFgCandidates = [bg, p.base07 as string, "#000000", "#ffffff"];
  const accentFg = accentFgCandidates.reduce((best, c) => (contrast(c, accent) > contrast(best, accent) ? c : best));
  const bright = (key: string, fallback: string) => p[key] ?? mix(fallback, p.base05 as string, 0.18);
  const surface2 = p.base02 as string;
  // Secondary text is checked against the chip surface as well, where most of it
  // sits; muted *text* is then a step below it, still 4.5:1. base03 alone is
  // base16's comment colour (3:1 by design), so it is never used for text as is.
  const text2 = role("text-2", p.base04 as string, 5, [bg, surface, surface2]);
  const mutedText = role("muted-text", mix(text2, bg, 0.18), 4.5, [bg, surface, surface2]);
  const vars: Record<string, string> = {
    "--bg": bg,
    "--surface": surface,
    "--surface-2": p.base02 as string,
    "--selection": p.base02 as string,
    "--border": p.base02 as string,
    "--control-border": role("control-border", p.base03 as string, 3, [bg]),
    "--text": role("text", p.base05 as string, 4.5, [bg, surface, surface2]),
    "--text-2": text2,
    "--muted-text": mutedText,
    "--muted": role("muted", p.base03 as string, 3),
    "--inverse-bg": p.base07 as string,
    "--inverse-fg": bg,
    "--danger": role("danger", p.base08 as string, 4.5),
    "--orange": role("orange", p.base09 as string, 4.5),
    "--warn": role("warn", p.base0A as string, 4.5),
    "--ok": role("ok", p.base0B as string, 4.5),
    "--info": role("info", p.base0C as string, 4.5),
    "--accent": accent,
    "--accent-fg": accentFg,
    "--accent-hover": bright("base16", accent),
    "--link": role("link", p.base0D as string, 4.5),
    "--thinking": role("thinking", p.base0E as string, 3),
    // Gold, as in the built-in themes; base0F is a dark orange in most schemes and read as --orange.
    "--rare": role("rare", p.base0A as string, 4.5),
    // base0F: brown, a harness hue that is neither status nor look.
    "--brown": role("brown", p.base0F as string, 4.5),
    "--danger-hover": bright("base12", p.base08 as string),
    "--ok-hover": bright("base14", p.base0B as string),
  };
  return { vars, adjusted };
}

/**
 * The scheme as a tinted-theming YAML file (`system`, `name`, `variant`, nested `palette`), the shape the
 * library writes and Export downloads. Every value is a safe literal (names cleaned, colours hex, fonts
 * checked), and each is double-quoted so YAML never reads `001122` as a number.
 */
export function schemeToYaml(scheme: Scheme): string {
  const keys = [...BASE16_KEYS, ...BASE24_KEYS].filter((k) => scheme.palette[k]);
  const system = keys.some((k) => BASE24_KEYS.includes(k)) ? "base24" : "base16";
  const lines = [`system: "${system}"`, `name: "${cleanSchemeName(scheme.name) || "Custom"}"`, `variant: "${scheme.polarity}"`, "palette:"];
  for (const k of keys) lines.push(`  ${k}: "${(scheme.palette[k] as string).toLowerCase()}"`);
  const fonts = Object.entries(scheme.fonts).filter(([, v]) => typeof v === "string" && FONT_NAME.test(v));
  if (fonts.length > 0) {
    lines.push("fonts:");
    for (const [k, v] of fonts) lines.push(`  ${k}: "${v}"`);
  }
  return `${lines.join("\n")}\n`;
}
