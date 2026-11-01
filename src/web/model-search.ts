// Model search for the picker. Matching after OpenCode (punctuation- and
// space-insensitive, across provider, name, and id, so "gpt55" finds
// "GPT-5.5"); ranking after DeepSeek Harness (name prefix first).
import type { ModelInfo } from "../shared/protocol.js";

export const normalize = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");

const compact = (value: string): string => normalize(value).replaceAll(" ", "");

/** 0 = best. Null when the model does not match. */
export function matchRank(query: string, model: ModelInfo): number | null {
  const q = normalize(query);
  if (!q) return 0;
  const qc = compact(query);
  const name = normalize(model.name);
  const fields = [model.name, model.id, model.provider, model.providerName ?? "", model.key];
  if (name.startsWith(q) || compact(model.name).startsWith(qc)) return 0;
  if (name.split(" ").some((word) => word.startsWith(q))) return 1;
  if (name.includes(q) || compact(model.name).includes(qc)) return 2;
  if (fields.some((f) => normalize(f).includes(q) || compact(f).includes(qc))) return 3;
  // Every query word appears somewhere ("glm flash", "zeta 5.3").
  const hay = fields.map(normalize).join(" ");
  if (q.split(" ").every((word) => hay.includes(word))) return 4;
  return null;
}

export interface ModelGroup {
  provider: string;
  models: ModelInfo[];
}

/**
 * Provider groups for the list: the current model's provider first, then the
 * rest alphabetically; models by rank, then name. Empty groups are dropped.
 */
export function groupModels(models: ModelInfo[], query: string, current: string | null): ModelGroup[] {
  const ranked = new Map<string, Array<{ model: ModelInfo; rank: number }>>();
  for (const model of models) {
    const rank = matchRank(query, model);
    if (rank === null) continue;
    const list = ranked.get(model.provider) ?? [];
    list.push({ model, rank });
    ranked.set(model.provider, list);
  }
  const currentProvider = current ? models.find((m) => m.key === current)?.provider : undefined;
  const best = (list: Array<{ rank: number }>) => Math.min(...list.map((x) => x.rank));
  return [...ranked.entries()]
    .sort(([a, la], [b, lb]) => {
      if (normalize(query)) {
        const d = best(la) - best(lb);
        if (d !== 0) return d;
      }
      if (a === currentProvider) return -1;
      if (b === currentProvider) return 1;
      return a.localeCompare(b);
    })
    .map(([provider, list]) => ({
      provider,
      models: list.sort((x, y) => x.rank - y.rank || x.model.name.localeCompare(y.model.name)).map((x) => x.model),
    }));
}
