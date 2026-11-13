// base16 / base24 scheme support. Accepts tinted-theming (`system`, `name`,
// `variant`, nested `palette:`), stylix-generated (`name` + `palette:`, hex
// without `#`), and legacy flat base16 (`scheme:` + top-level `base00`…).
// Colors become CSS custom properties, so only exact 6-digit hex is accepted.
import { promises as fs } from "node:fs";
import { parse } from "yaml";
import type { ThemeInfo } from "../shared/protocol.js";
import { isObj } from "./harness/agent-events.js";

const HEX = /^#?([0-9a-fA-F]{6})$/;
const FONT = /^[A-Za-z0-9 -]{1,64}$/;
const MAX_THEME_BYTES = 64 * 1024;
const REQUIRED = Array.from({ length: 16 }, (_, i) => `base0${i.toString(16).toUpperCase()}`);
const BASE24 = Array.from({ length: 8 }, (_, i) => `base1${i}`);

export class ThemeError extends Error {}

export interface Scheme {
  name: string;
  polarity: "dark" | "light";
  palette: Record<string, string>;
  fonts: { sans?: string; mono?: string };
}

export function parseScheme(text: string): Scheme {
  let doc: unknown;
  try {
    // failsafe: every scalar stays a string, so `001122` keeps its zeros.
    doc = parse(text, { schema: "failsafe", maxAliasCount: 10 });
  } catch (error) {
    throw new ThemeError(`not valid YAML (${(error as Error).message.split("\n")[0]})`);
  }
  if (!isObj(doc)) throw new ThemeError("expected a YAML mapping");
  const source = isObj(doc.palette) ? doc.palette : doc;
  const palette: Record<string, string> = {};
  for (const key of [...REQUIRED, ...BASE24]) {
    const value = source[key];
    if (value === undefined) {
      if (REQUIRED.includes(key)) throw new ThemeError(`missing ${key}`);
      continue;
    }
    const match = typeof value === "string" ? HEX.exec(value.trim()) : null;
    if (!match?.[1]) throw new ThemeError(`${key} is not a 6-digit hex color`);
    palette[key] = `#${match[1].toLowerCase()}`;
  }
  const rawName = typeof doc.name === "string" ? doc.name : typeof doc.scheme === "string" ? doc.scheme : "Custom";
  const name = rawName.replace(/[^\p{L}\p{N} ._()-]/gu, "").trim().slice(0, 60) || "Custom";
  const variant = typeof doc.variant === "string" ? doc.variant.toLowerCase() : "";
  const polarity =
    variant === "dark" || variant === "light" ? variant : luminance(palette.base00 as string) < 0.5 ? "dark" : "light";
  const fonts: Scheme["fonts"] = {};
  if (isObj(doc.fonts)) {
    if (typeof doc.fonts.sans === "string" && FONT.test(doc.fonts.sans)) fonts.sans = doc.fonts.sans;
    if (typeof doc.fonts.mono === "string" && FONT.test(doc.fonts.mono)) fonts.mono = doc.fonts.mono;
  }
  return { name, polarity, palette, fonts };
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

// ---- file-backed store ------------------------------------------------------------

interface Cached {
  key: string;
  info: ThemeInfo;
}

export class ThemeStore {
  private cache: Cached | null = null;
  private lastLogged = "";

  constructor(
    private readonly file: string | null,
    private readonly explicit: boolean,
    private readonly log: (message: string) => void = (m) => console.warn(m),
  ) {}

  private none(problem?: string): ThemeInfo {
    if (problem && problem !== this.lastLogged) {
      this.lastLogged = problem;
      this.log(`theme: ${problem}; using built-in themes`);
    }
    return { source: "none", name: null, polarity: null, vars: {}, themeColor: null, fonts: {}, ...(problem ? { problem } : {}) };
  }

  /** Re-resolves realpath + mtime each call so a home-manager switch is picked up. */
  async get(): Promise<ThemeInfo> {
    if (!this.file) return this.none();
    let real: string;
    let key: string;
    try {
      real = await fs.realpath(this.file);
      const stat = await fs.stat(real);
      if (!stat.isFile()) return this.none("theme file is not a regular file");
      if (stat.size > MAX_THEME_BYTES) return this.none("theme file is too large");
      key = `${real}:${stat.mtimeMs}:${stat.size}`;
    } catch {
      return this.explicit ? this.none("THEME_FILE does not exist") : this.none();
    }
    if (this.cache?.key === key) return this.cache.info;
    let info: ThemeInfo;
    try {
      const scheme = parseScheme(await fs.readFile(real, "utf8"));
      const { vars, adjusted } = buildThemeVars(scheme);
      if (adjusted.length > 0) this.log(`theme: raised contrast for ${adjusted.join(", ")} in "${scheme.name}"`);
      info = {
        source: "file",
        name: scheme.name,
        polarity: scheme.polarity,
        vars,
        themeColor: scheme.palette.base00 ?? null,
        fonts: scheme.fonts,
      };
      this.lastLogged = "";
    } catch (error) {
      info = this.none(`theme file rejected: ${(error as Error).message}`);
    }
    this.cache = { key, info };
    return info;
  }
}
