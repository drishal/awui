// The composer's model and thinking chips' words, shared by the web start screen and both terminal
// clients, so they name the same thing: one rule for what a chip says before anything is picked.
// With nothing picked the harness's own default model is named (with its provider's name too when
// it has a virtual one), and its reasoning level only when that model reasons and a level is known;
// otherwise the model chip says "Default model" rather than nothing, and the thinking chip says no
// word at all. A chat's own model wins when it has one, and a model the list no longer holds is no
// better than none (the harness starts the chat on something else).
import type { ModelInfo } from "../shared/protocol.js";
import { levelTitle } from "./config-summary.js";

/** What a start screen (or a chat's config) knows: the models, the harness's levels, and its default. */
export interface ChipCatalog {
  models: ReadonlyArray<ModelInfo>;
  thinkingLevels: ReadonlyArray<string>;
  defaultModel: { model: string; thinkingLevel: string | null } | null;
}

export interface ChipInput extends Partial<ChipCatalog> {
  /** The picked model: a chat's, or the start screen's (its key, or its id). */
  model?: string | null;
  /** The picked thinking level, "" or null when nothing was picked. */
  thinkingLevel?: string | null;
  /** What the model chip says when no model is named: the harness's own default is the usual answer. */
  fallback?: string;
}

export interface ChipWords {
  /** The catalog's entry for the model in force: the pick, else the harness's default; null when neither is listed. */
  model: ModelInfo | null;
  /** The model chip's words: "Provider · Name", "Name", or the fallback. */
  name: string;
  /** The thinking chip's level in the harness's own word; null when there is none to name (the chip shows no word). */
  level: string | null;
  /** One pill's words (the web start screen): the name, then the reasoning word when that model reasons. */
  label: string;
}

const entryOf = (models: ReadonlyArray<ModelInfo>, pick: string | null | undefined): ModelInfo | null =>
  pick ? (models.find((m) => m.key === pick || m.id === pick) ?? null) : null;

export function chipWords(input: ChipInput): ChipWords {
  const models = input.models ?? [];
  const picked = entryOf(models, input.model);
  const fallbackModel = entryOf(models, input.defaultModel?.model);
  const model = picked ?? fallbackModel;
  const name = model ? (model.providerName ? `${model.providerName} · ${model.name}` : model.name) : (input.fallback ?? "Default model");
  // The harness's default level is the default model's own: it is no answer for another model picked here.
  const isDefault = !picked && model !== null && input.defaultModel != null && model.key === input.defaultModel.model;
  const level = (input.thinkingLevel ?? "").trim() || (isDefault && model?.reasoning ? (input.defaultModel?.thinkingLevel ?? null) : null);
  const label = level && model?.reasoning ? `${name} · ${levelTitle(level)}` : name;
  return { model, name, level, label };
}
