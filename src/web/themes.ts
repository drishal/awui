// The theme library as the web UI offers it: one list of choices (the built-in
// System, Light, and Dark, then theme.yml and every library scheme) shared by the
// theme menu, the command palette, and Settings, so the three never disagree on
// what is offered or which one is current. Choosing is config.yml's `theme` and
// `theme_scheme`, saved through /api/settings like every shared look.
import { useCallback, useEffect, useState } from "react";
import type { Bootstrap, ThemeChoice, ThemeEntry, ThemeInfo, ThemeList } from "../shared/protocol.js";
import { api } from "./api.js";
import type { ThemeMode } from "./theme.js";

/** One thing the theme menu offers. `key` is stable across lists: `system`, `light`, `dark`, `scheme:` (theme.yml), `scheme:<id>`. */
export interface ThemeOption {
  key: string;
  label: string;
  /** config.yml's `theme` and `theme_scheme` once chosen. */
  theme: ThemeChoice;
  themeScheme: string | null;
  /** Set for a scheme: its colours (the swatch, the preview). */
  entry?: ThemeEntry;
  /** Where it comes from, for a hint ("theme.yml", "read-only"). */
  note?: string;
}

/** The scheme's key in the lists above. */
export const schemeKey = (id: string | null): string => `scheme:${id ?? ""}`;

/** Every choice, built-ins first; a scheme that cannot be used is left out (Settings lists it, to remove). */
export function themeOptions(list: ThemeList | null): ThemeOption[] {
  const out: ThemeOption[] = [
    { key: "system", label: "System", theme: "system", themeScheme: null, note: "follows the device" },
    { key: "light", label: "Light", theme: "light", themeScheme: null },
    { key: "dark", label: "Dark", theme: "dark", themeScheme: null },
  ];
  for (const entry of list?.themes ?? []) {
    if (entry.problem) continue;
    out.push({ key: schemeKey(entry.id), label: entry.name, theme: "base16", themeScheme: entry.id, entry, ...(entry.id === null ? { note: "theme.yml" } : entry.readOnly ? { note: "read-only" } : {}) });
  }
  return out;
}

/** The choice config.yml holds now: `base16` with the library pick, the bare mode otherwise; Automatic follows what it resolves to. */
export function currentThemeKey(ui: Pick<Bootstrap["ui"], "theme" | "themeScheme"> | null | undefined, mode: ThemeMode): string {
  if (mode === "scheme") return schemeKey(ui?.themeScheme ?? null);
  return mode;
}

/** A library entry as the page applies it (the same shape /api/theme answers). */
export function entryInfo(entry: ThemeEntry): ThemeInfo {
  return { source: "file", ...(entry.id ? { scheme: entry.id } : {}), name: entry.name, polarity: entry.polarity, vars: entry.vars, themeColor: entry.themeColor, fonts: entry.fonts };
}

/** What a choice paints: its mode, and the scheme behind "scheme". */
export function optionLook(option: ThemeOption): { mode: ThemeMode; info: ThemeInfo | null } {
  return option.entry ? { mode: "scheme", info: entryInfo(option.entry) } : { mode: option.theme === "light" || option.theme === "dark" ? option.theme : "system", info: null };
}

/** The palette keys a swatch shows as chips, in order: red, yellow, green, cyan, blue, purple. */
export const CHIP_KEYS = ["base08", "base0A", "base0B", "base0C", "base0D", "base0E"] as const;

/** The theme library from the server, read once `enabled` (signed in, bootstrapped) and again after each change. */
export function useThemeList(enabled = true): { list: ThemeList | null; refresh: () => Promise<ThemeList | null>; error: unknown } {
  const [list, setList] = useState<ThemeList | null>(null);
  const [error, setError] = useState<unknown>(null);
  const refresh = useCallback(async () => {
    try {
      const next = await api<ThemeList>("/api/themes");
      setList(next);
      setError(null);
      return next;
    } catch (e) {
      setError(e);
      return null;
    }
  }, []);
  useEffect(() => {
    if (enabled) void refresh();
  }, [enabled, refresh]);
  return { list, refresh, error };
}

/** A file name a downloaded theme gets: its id, else a slug of its name. */
export function themeFileName(entry: Pick<ThemeEntry, "id" | "name">): string {
  const slug = entry.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "theme";
  return `${entry.id ?? slug}.yml`;
}
