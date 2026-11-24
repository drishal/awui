// Agent presets: a name for a harness, model and thinking level together ("Explore": the
// cheap model, low thinking; "Deep work": the strongest one, high), kept in atui.json so a
// new chat can start from one in a step, as omo's role-named agents do. Pure: the palette
// asks, state.ts applies one, prefs.ts keeps the list.
import { levelTitle } from "../web/config-summary.js";

export interface Preset {
  name: string;
  harnessId: string;
  model?: string;
  thinkingLevel?: string;
}

/** The list stays short enough to read in one sheet. */
export const MAX_PRESETS = 12;
export const MAX_PRESET_NAME = 32;

/** A name as it is kept: trimmed, one line, bounded. Empty when nothing is left. */
export const presetName = (raw: string): string => raw.replace(/\s+/g, " ").trim().slice(0, MAX_PRESET_NAME);

const word = (v: unknown, max = 200): string | undefined => (typeof v === "string" && v.trim() && v.length <= max ? v.trim() : undefined);

/** The saved list, read leniently: anything malformed is dropped, names are unique (first wins), and the list is capped. */
export function parsePresets(raw: unknown): Preset[] {
  if (!Array.isArray(raw)) return [];
  const out: Preset[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const r = entry as Record<string, unknown>;
    const name = typeof r.name === "string" ? presetName(r.name) : "";
    const harnessId = word(r.harnessId, 64);
    if (!name || !harnessId || out.some((p) => p.name.toLowerCase() === name.toLowerCase())) continue;
    const model = word(r.model);
    const thinkingLevel = word(r.thinkingLevel, 64);
    out.push({ name, harnessId, ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}) });
    if (out.length >= MAX_PRESETS) break;
  }
  return out;
}

/** The list with `preset` saved: a name that exists (any case) is replaced in place, a new one goes last, and the oldest makes room at the cap. */
export function withPreset(list: Preset[], preset: Preset): Preset[] {
  const at = list.findIndex((p) => p.name.toLowerCase() === preset.name.toLowerCase());
  if (at >= 0) return list.map((p, i) => (i === at ? preset : p));
  return [...list, preset].slice(-MAX_PRESETS);
}

/** The list without the preset of this name. */
export const withoutPreset = (list: Preset[], name: string): Preset[] => list.filter((p) => p.name.toLowerCase() !== name.toLowerCase());

/** What a preset row says after its name, as the chips word it: "Claude Code · Opus 4 · High" (`modelName` is the catalog's label for the model, when this screen has that harness's catalog; else the model's own key). */
export const presetWords = (p: Preset, harnessName: string, modelName?: string): string =>
  [harnessName, modelName ?? p.model, p.thinkingLevel ? levelTitle(p.thinkingLevel) : undefined].filter(Boolean).join(" · ");
