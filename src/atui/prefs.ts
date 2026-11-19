// What atui remembers between runs on this machine (vim mode, glass), in
// $XDG_CONFIG_HOME/awui/atui.json beside the server's config.yml.
// Read leniently and written whole; a failure to write only means it is not
// remembered. Renamed from agentwebui with the server; see user-config.ts.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface AtuiPrefs {
  vim?: boolean;
  /** Headers show reasoning next to the work by default; C-t folds all reasoning. */
  showThoughts?: boolean;
  /** No fills behind the transcript, composer, and status line: the terminal's own background shows through. */
  glass?: boolean;
}

export function prefsFile(env: Record<string, string | undefined> = process.env): string {
  const base = env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), ".config");
  return path.join(base, "awui", "atui.json");
}

export function readPrefs(file = prefsFile()): AtuiPrefs {
  try {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const r = raw as Record<string, unknown>;
    return {
      ...(typeof r.vim === "boolean" ? { vim: r.vim } : {}),
      ...(typeof r.showThoughts === "boolean" ? { showThoughts: r.showThoughts } : {}),
      ...(typeof r.glass === "boolean" ? { glass: r.glass } : {}),
    };
  } catch {
    return {};
  }
}

export function writePrefs(prefs: AtuiPrefs, file = prefsFile()): void {
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ ...readPrefs(file), ...prefs }, null, 2)}\n`);
    renameSync(tmp, file);
  } catch {
    // Not remembered; this run still has it.
  }
}
