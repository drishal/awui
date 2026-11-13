// The composer chips' words: the same rule the web start screen uses, for both terminal clients.
import { describe, expect, it } from "vitest";
import type { ModelInfo } from "../../src/shared/protocol.js";
import { chipWords } from "../../src/web/model-label.js";

const models: ModelInfo[] = [
  { key: "deepseek/flash", provider: "deepseek", id: "flash", name: "DeepSeek V4.1 Flash", reasoning: true, levels: ["off", "low", "high", "max"] },
  { key: "deepseek/pro", provider: "deepseek", id: "pro", name: "DeepSeek V4.1 Pro" },
  { key: "moa/default", provider: "moa", providerName: "Mixture of Agents", id: "default", name: "default", reasoning: true },
  { key: "acme/new", provider: "acme", id: "new", name: "New" },
  { key: "acme/reason", provider: "acme", id: "reason", name: "Reason", reasoning: true },
];

describe("model chip words", () => {
  it("names the harness's default and its reasoning level when nothing is picked", () => {
    const words = chipWords({ models, thinkingLevels: ["off", "low", "max"], defaultModel: { model: "deepseek/flash", thinkingLevel: "max" } });
    expect(words.name).toBe("DeepSeek V4.1 Flash");
    expect(words.level).toBe("max");
    expect(words.label).toBe("DeepSeek V4.1 Flash · Max");
  });

  it("names a virtual provider with its own name", () => {
    const words = chipWords({ models, thinkingLevels: [], defaultModel: { model: "moa/default", thinkingLevel: null } });
    expect(words.name).toBe("Mixture of Agents · default");
    expect(words.level).toBeNull();
    expect(words.label).toBe("Mixture of Agents · default");
  });

  it("hides the reasoning word for a model that does not reason, and the chip says Default model with no default", () => {
    expect(chipWords({ models, defaultModel: { model: "deepseek/pro", thinkingLevel: "max" } }).level).toBeNull();
    const none = chipWords({ models, defaultModel: null });
    expect(none).toMatchObject({ model: null, name: "Default model", level: null, label: "Default model" });
    expect(chipWords({ defaultModel: null, fallback: "No model" }).name).toBe("No model");
  });

  it("keeps the default's level for the default only: a model picked beside it has no level of its own", () => {
    const words = chipWords({ models, defaultModel: { model: "deepseek/flash", thinkingLevel: "max" }, model: "acme/new" });
    expect(words.name).toBe("New");
    expect(words.level).toBeNull();
    expect(words.label).toBe("New");
  });

  it("follows a model or level the picker set, then falls back to the default for a model the list lacks", () => {
    const catalog = { models, defaultModel: { model: "deepseek/flash", thinkingLevel: "max" } };
    expect(chipWords({ ...catalog, model: "deepseek/pro", thinkingLevel: "low" })).toMatchObject({ name: "DeepSeek V4.1 Pro", level: "low", label: "DeepSeek V4.1 Pro" });
    expect(chipWords({ ...catalog, model: "acme/reason", thinkingLevel: "high" })).toMatchObject({ name: "Reason", level: "high", label: "Reason · High" });
    expect(chipWords({ ...catalog, model: "gone/model" }).name).toBe("DeepSeek V4.1 Flash");
    // A chat's own model, by its id as some harnesses spell it, with no default listed at all.
    expect(chipWords({ models, model: "acme/reason", thinkingLevel: "high" })).toMatchObject({ name: "Reason", level: "high", label: "Reason · High" });
  });
});
