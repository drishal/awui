// base16 / base24 scheme support. Accepts tinted-theming (`system`, `name`,
// `variant`, nested `palette:`), stylix-generated (`name` + `palette:`, hex
// without `#`), and legacy flat base16 (`scheme:` + top-level `base00`…).
// Colors become CSS custom properties, so only exact 6-digit hex is accepted.
// The colour roles themselves live in shared/theme-scheme.ts, so the browser's
// theme editor previews exactly what is served here.
import { promises as fs } from "node:fs";
import { parse } from "yaml";
import type { ThemeInfo } from "../shared/protocol.js";
import { BASE16_KEYS, BASE24_KEYS, buildThemeVars, cleanSchemeName, FONT_NAME, HEX_COLOR, polarityOf, type Scheme } from "../shared/theme-scheme.js";
import { isObj } from "./harness/agent-events.js";
import type { ThemeLibrary } from "./theme-library.js";

export { buildThemeVars, contrast, luminance, type Scheme } from "../shared/theme-scheme.js";

export const MAX_THEME_BYTES = 64 * 1024;

export class ThemeError extends Error {}

/** A scheme from a parsed document (a YAML file's, or the theme editor's JSON in the same shape). */
export function schemeFromDoc(doc: unknown): Scheme {
  if (!isObj(doc)) throw new ThemeError("expected a YAML mapping");
  const source = isObj(doc.palette) ? doc.palette : doc;
  const palette: Record<string, string> = {};
  for (const key of [...BASE16_KEYS, ...BASE24_KEYS]) {
    const value = source[key];
    if (value === undefined) {
      if (BASE16_KEYS.includes(key)) throw new ThemeError(`missing ${key}`);
      continue;
    }
    const match = typeof value === "string" ? HEX_COLOR.exec(value.trim()) : null;
    if (!match?.[1]) throw new ThemeError(`${key} is not a 6-digit hex color`);
    palette[key] = `#${match[1].toLowerCase()}`;
  }
  const rawName = typeof doc.name === "string" ? doc.name : typeof doc.scheme === "string" ? doc.scheme : "Custom";
  const name = cleanSchemeName(rawName) || "Custom";
  const variant = typeof doc.variant === "string" ? doc.variant.toLowerCase() : "";
  const polarity = variant === "dark" || variant === "light" ? variant : polarityOf(palette.base00 as string);
  const fonts: Scheme["fonts"] = {};
  if (isObj(doc.fonts)) {
    if (typeof doc.fonts.sans === "string" && FONT_NAME.test(doc.fonts.sans)) fonts.sans = doc.fonts.sans;
    if (typeof doc.fonts.mono === "string" && FONT_NAME.test(doc.fonts.mono)) fonts.mono = doc.fonts.mono;
  }
  return { name, polarity, palette, fonts };
}

export function parseScheme(text: string): Scheme {
  let doc: unknown;
  try {
    // failsafe: every scalar stays a string, so `001122` keeps its zeros.
    doc = parse(text, { schema: "failsafe", maxAliasCount: 10 });
  } catch (error) {
    throw new ThemeError(`not valid YAML (${(error as Error).message.split("\n")[0]})`);
  }
  return schemeFromDoc(doc);
}

/** A scheme as the page applies it: its contrast-checked custom properties, colour, and fonts. */
export function schemeInfo(scheme: Scheme, log?: (message: string) => void): Omit<ThemeInfo, "source"> {
  const { vars, adjusted } = buildThemeVars(scheme);
  if (adjusted.length > 0) log?.(`theme: raised contrast for ${adjusted.join(", ")} in "${scheme.name}"`);
  return { name: scheme.name, polarity: scheme.polarity, vars, themeColor: scheme.palette.base00 ?? null, fonts: scheme.fonts };
}

// ---- file-backed store ------------------------------------------------------------

interface Cached {
  key: string;
  info: ThemeInfo;
  scheme: Scheme | null;
}

export interface ThemeStoreOptions {
  /** The theme library (~/.config/awui/themes); without one only theme.yml is served. */
  library?: ThemeLibrary | null;
  /** config.yml's `theme_scheme`: which library theme `theme: base16` uses (null: theme.yml). Read on every call. */
  selected?: () => string | null;
}

/**
 * The active scheme: the library theme config.yml selects, else theme.yml. Every client (web, atui, Tern)
 * reads it through /api/theme, so a switch reaches them all.
 */
export class ThemeStore {
  private cache: Cached | null = null;
  private lastLogged = "";
  readonly library: ThemeLibrary | null;
  private readonly selected: () => string | null;

  constructor(
    private readonly file: string | null,
    private readonly explicit: boolean,
    private readonly log: (message: string) => void = (m) => console.warn(m),
    options: ThemeStoreOptions = {},
  ) {
    this.library = options.library ?? null;
    this.selected = options.selected ?? (() => null);
  }

  private none(problem?: string): ThemeInfo {
    if (problem && problem !== this.lastLogged) {
      this.lastLogged = problem;
      this.log(`theme: ${problem}; using built-in themes`);
    }
    return { source: "none", name: null, polarity: null, vars: {}, themeColor: null, fonts: {}, ...(problem ? { problem } : {}) };
  }

  /** The active scheme: config.yml's library pick when it still exists and parses, else theme.yml. */
  async get(): Promise<ThemeInfo> {
    const id = this.selected();
    if (id && this.library) {
      const entry = await this.library.get(id);
      if (entry && !entry.problem) return { source: "file", scheme: id, name: entry.name, polarity: entry.polarity, vars: entry.vars, themeColor: entry.themeColor, fonts: entry.fonts };
      const fallback = await this.fileTheme();
      const why = entry ? `theme "${id}" is unusable (${entry.problem})` : `theme "${id}" is not in the theme library`;
      return { ...fallback, problem: fallback.problem ? `${why}; ${fallback.problem}` : `${why}; using ${fallback.source === "file" ? "theme.yml" : "the built-in themes"}` };
    }
    return this.fileTheme();
  }

  /** theme.yml's raw palette as well as its info, for the library listing (Duplicate starts from it). */
  async fileEntry(): Promise<{ info: ThemeInfo; scheme: Scheme | null }> {
    const info = await this.fileTheme();
    return { info, scheme: this.cache?.info === info ? this.cache.scheme : null };
  }

  /** theme.yml. Re-resolves realpath + mtime each call so a home-manager switch is picked up. */
  async fileTheme(): Promise<ThemeInfo> {
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
    let scheme: Scheme | null = null;
    try {
      scheme = parseScheme(await fs.readFile(real, "utf8"));
      info = { source: "file", ...schemeInfo(scheme, this.log) };
      this.lastLogged = "";
    } catch (error) {
      info = this.none(`theme file rejected: ${(error as Error).message}`);
    }
    this.cache = { key, info, scheme };
    return info;
  }
}
