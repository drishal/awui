// atui's colours: the same tokens the web UI uses, read from the server's
// /api/theme (the shared theme.yml scheme when there is one), else the web
// UI's built-in dark palette. The terminal's own background shows through
// everywhere but the panels that are drawn on a surface. The context's
// colour ramps from green to amber to red as it fills.
import type { ThemeInfo } from "../shared/protocol.js";
import { ramp } from "./fx.js";

export interface Theme {
  bg: string;
  surface: string;
  surface2: string;
  border: string;
  selection: string;
  text: string;
  text2: string;
  muted: string;
  accent: string;
  accentFg: string;
  link: string;
  ok: string;
  warn: string;
  danger: string;
  info: string;
  orange: string;
  thinking: string;
  rare: string;
}

export const DARK: Theme = {
  bg: "#151517",
  surface: "#1b1b1c",
  surface2: "#2c2c2e",
  border: "#2c2c2e",
  selection: "#34415b",
  text: "#f5f6f7",
  text2: "#cfd3d6",
  muted: "#979da6",
  accent: "#7aaaff",
  accentFg: "#0f1115",
  link: "#8ab6ff",
  ok: "#4ed17e",
  warn: "#f7ad31",
  danger: "#f87171",
  info: "#93c5fd",
  orange: "#fb923c",
  thinking: "#b69cff",
  rare: "#d29922",
};

/** The web UI's built-in light palette (styles/tokens.css), for a light Tern pane with no theme file. */
export const LIGHT: Theme = {
  bg: "#ffffff",
  surface: "#f9fafb",
  surface2: "#eef1f5",
  border: "#e1e5ee",
  selection: "#dbe7fd",
  text: "#0f1115",
  text2: "#43454a",
  muted: "#61666b",
  accent: "#4176e6",
  accentFg: "#ffffff",
  link: "#2f5fcc",
  ok: "#15803d",
  warn: "#b45309",
  danger: "#c81e1e",
  info: "#0369a1",
  orange: "#c2410c",
  thinking: "#6d4fc2",
  rare: "#8a5a00",
};

const TOKENS: Record<keyof Theme, string> = {
  bg: "--bg",
  surface: "--surface",
  surface2: "--surface-2",
  border: "--border",
  selection: "--selection",
  text: "--text",
  text2: "--text-2",
  muted: "--muted",
  accent: "--accent",
  accentFg: "--accent-fg",
  link: "--link",
  ok: "--ok",
  warn: "--warn",
  danger: "--danger",
  info: "--info",
  orange: "--orange",
  thinking: "--thinking",
  rare: "--rare",
};

const HEX = /^#[0-9a-f]{6}$/i;

/** The server's scheme over the defaults; a token that is not a plain hex colour keeps the default. */
export function themeFrom(info: Pick<ThemeInfo, "vars"> | null): Theme {
  const theme = { ...DARK };
  if (!info) return theme;
  for (const key of Object.keys(TOKENS) as Array<keyof Theme>) {
    const value = info.vars[TOKENS[key]]?.trim();
    if (value && HEX.test(value)) theme[key] = value;
  }
  return theme;
}

/** A harness's colour: the theme token it declares (`link`, `thinking`, …). */
/**
 * The context's colour at `percent` full: green while there is room, amber
 * from where compacting starts to be offered, red as it runs out.
 */
export function contextTone(theme: Theme, percent: number): string {
  return ramp(percent, [
    [40, theme.ok],
    [65, theme.warn],
    [90, theme.danger],
  ]);
}

export function accentOf(theme: Theme, token: string | undefined): string {
  return token && token in theme ? theme[token as keyof Theme] : theme.accent;
}
