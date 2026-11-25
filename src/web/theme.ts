// Theme application through the CSSOM (style.setProperty), never injected
// <style> text, so the CSP needs no 'unsafe-inline'. A preview (the theme menu
// and the palette, while a theme is pointed at) paints the page the same way
// without becoming the theme: endPreview puts back the one last applied.
import { useEffect, useState } from "react";
import type { ThemeChoice, ThemeInfo } from "../shared/protocol.js";
import { api } from "./api.js";

export type ThemeMode = "system" | "light" | "dark" | "scheme";

let applied: string[] = [];

/** The id bootHtml gives its stylesheet, so the first paint of the client can retire it. */
export const BOOT_STYLE_ID = "theme-boot";

function setMetaThemeColor(color: string | null): void {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const fallback = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim() || "#1b1d22";
  meta.setAttribute("content", color ?? fallback);
}

/** The theme the page holds, as last applied; a preview paints over it until endPreview. */
let committed: { mode: ThemeMode; info: ThemeInfo | null } = { mode: "system", info: null };
let previewing = false;

export function applyTheme(mode: ThemeMode, info: ThemeInfo | null): void {
  committed = { mode, info };
  previewing = false;
  paint(mode, info);
}

/** Show a theme on the page without choosing it. */
export function previewTheme(mode: ThemeMode, info: ThemeInfo | null): void {
  previewing = true;
  paint(mode, info);
}

/** Back to the theme the page holds, after a preview. */
export function endPreview(): void {
  if (!previewing) return;
  previewing = false;
  paint(committed.mode, committed.info);
}

function paint(mode: ThemeMode, info: ThemeInfo | null): void {
  const root = document.documentElement;
  for (const name of applied) root.style.removeProperty(name);
  applied = [];
  const useScheme = mode === "scheme" && info?.source === "file";
  if (useScheme && info) {
    for (const [name, value] of Object.entries(info.vars)) {
      root.style.setProperty(name, value);
      applied.push(name);
    }
    if (info.fonts.sans) {
      root.style.setProperty("--font-sans", `"${info.fonts.sans}", system-ui, -apple-system, "Segoe UI", sans-serif, "Symbols Nerd Font Mono", "Symbols Nerd Font"`);
      applied.push("--font-sans");
    }
    if (info.fonts.mono) {
      root.style.setProperty("--font-mono", `"${info.fonts.mono}", ui-monospace, "SFMono-Regular", Menlo, monospace, "Symbols Nerd Font Mono", "Symbols Nerd Font"`);
      applied.push("--font-mono");
    }
    root.dataset.theme = info.polarity ?? "dark";
    root.dataset.scheme = "1";
  } else {
    delete root.dataset.scheme;
    if (mode === "light" || mode === "dark") root.dataset.theme = mode;
    else delete root.dataset.theme;
  }
  // The stylesheet the shell carried (static-web.ts) is for the first frame only: left in place, it would pin
  // the scheme it names under a mode chosen since (its :root block follows tokens.css's).
  document.getElementById(BOOT_STYLE_ID)?.remove();
  setMetaThemeColor(useScheme ? info?.themeColor ?? null : null);
}

/** config.yml's theme as a mode; "base16" needs a theme.yml to show. */
function configMode(choice: ThemeChoice | null, info: ThemeInfo | null): ThemeMode | null {
  if (choice === "base16") return info?.source === "file" ? "scheme" : "system";
  return choice;
}

/**
 * Every device follows config.yml: its theme, else theme.yml when there is
 * one. A changed file theme wins on the next page load.
 */
export function themeModeOf(info: ThemeInfo | null, choice: ThemeChoice | null = null): ThemeMode {
  const fallback = configMode(choice, info) ?? (info?.source === "file" ? "scheme" : "system");
  if (fallback === "scheme" && info?.source !== "file") return "system";
  return fallback;
}

export async function fetchTheme(): Promise<ThemeInfo | null> {
  try {
    return await api<ThemeInfo>("/api/theme");
  } catch {
    return null;
  }
}

/**
 * The device's theme: its mode, the theme.yml info behind "scheme", applying
 * both to the document, and a refetch when the tab comes back to the fore.
 */
export function useTheme() {
  const [themeInfo, setThemeInfo] = useState<ThemeInfo | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>("system");
  // Nothing may be painted before the theme is known: the shell already carries the one the server wrote
  // (static-web.ts), and painting its default "system" over that would flash the built-in colours back in.
  const [ready, setReady] = useState(false);

  /** Take the theme delivered with the bootstrap payload (null when /api/theme failed). */
  const initTheme = (info: ThemeInfo | null, choice: ThemeChoice | null): void => {
    setThemeInfo(info);
    setThemeMode(themeModeOf(info, choice));
    setReady(true);
  };

  /** Read the active scheme again (a switch, or an edit of the one in use); the old one stays when the read fails. */
  const refreshTheme = async (): Promise<ThemeInfo | null> => {
    const t = await fetchTheme();
    if (t) setThemeInfo((prev) => (JSON.stringify(prev) === JSON.stringify(t) ? prev : t));
    return t;
  };

  useEffect(() => {
    if (ready) applyTheme(themeMode, themeInfo);
  }, [ready, themeMode, themeInfo]);

  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== "visible") return;
      const t = await fetchTheme();
      if (t) setThemeInfo((prev) => (JSON.stringify(prev) === JSON.stringify(t) ? prev : t));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  return { themeMode, themeInfo, initTheme, setThemeMode, setThemeInfo, refreshTheme };
}
