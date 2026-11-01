import { describe, expect, it } from "vitest";
import type { ModelInfo, PermissionModeInfo } from "../../src/shared/protocol.js";
import { configSummary } from "../../src/web/config-summary.js";

const models: ModelInfo[] = [
  { key: "fake/echo", provider: "fake", id: "echo", name: "Fake Echo", reasoning: true },
  { key: "zeta/glm", provider: "zeta", id: "glm", name: "GLM-5.3-Flash", reasoning: false },
];
const modes: PermissionModeInfo[] = [{ id: "default", label: "Ask first", description: "Asks before edits" }];
const harnesses = [{ id: "fake", displayName: "Pi" }];

const caps = (over: Record<string, boolean> = {}) => ({
  supportsModelSelection: true,
  supportsThinkingLevel: true,
  supportsPermissionMode: false,
  ...over,
});

const config = (over: Record<string, unknown> = {}) => ({
  model: "fake/echo",
  models,
  thinkingLevel: "high",
  permissionMode: null,
  permissionModes: modes,
  ...over,
});

describe("the composer's one-line config summary", () => {
  it("names the harness, the model, and the effort", () => {
    expect(configSummary({ harnessId: "fake", capabilities: caps(), config: config() }, harnesses)).toBe("Pi · Fake Echo · High");
  });

  it("names a virtual provider with its preset (Hermes's MoA)", () => {
    const moa: ModelInfo[] = [{ key: "moa/default", provider: "moa", providerName: "Mixture of Agents", id: "default", name: "default" }];
    expect(configSummary({ harnessId: "fake", capabilities: caps(), config: config({ model: "moa/default", models: moa }) }, harnesses)).toBe("Pi · Mixture of Agents · default · High");
  });

  it("adds the permission mode only when the harness has one", () => {
    const withModes = caps({ supportsPermissionMode: true });
    expect(configSummary({ harnessId: "fake", capabilities: withModes, config: config({ permissionMode: "default" }) }, harnesses)).toBe(
      "Pi · Fake Echo · High · Ask first",
    );
    expect(configSummary({ harnessId: "fake", capabilities: caps(), config: config({ permissionMode: "default" }) }, harnesses)).toBe("Pi · Fake Echo · High");
  });

  it("leaves out what the harness has no picker for", () => {
    const none = caps({ supportsModelSelection: false, supportsThinkingLevel: false });
    expect(configSummary({ harnessId: "fake", capabilities: none, config: config() }, harnesses)).toBe("Pi");
  });

  it("falls back to the raw ids when the lists do not know them", () => {
    const chat = { harnessId: "claude", capabilities: caps({ supportsThinkingLevel: false }), config: config({ model: "unknown/key", thinkingLevel: null }) };
    expect(configSummary(chat, harnesses)).toBe("claude · unknown/key");
  });
});
