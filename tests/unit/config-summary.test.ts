import { describe, expect, it } from "vitest";
import type { ModelInfo, PermissionModeInfo } from "../../src/shared/protocol.js";
import { configSummary, levelTitle, modelSummary } from "../../src/web/config-summary.js";

describe("thinking levels", () => {
  it.each([{ level: "xhigh", title: "Extra high" }, { level: "max", title: "Max" }, { level: "minimal", title: "Minimal" }])("titles $level as $title", ({ level, title }) => {
    expect(levelTitle(level)).toBe(title);
  });
});
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
  it("names a real chosen primary agent, not an inferred or permission default", () => {
    const capabilities = caps({ supportsAgentSelection: true });
    expect(configSummary({ harnessId: "fake", capabilities, config: config({ agent: "orchestrator", agents: [{ id: "orchestrator", label: "orchestrator", description: "Plugin role" }] }) }, harnesses)).toBe("Pi · Fake Echo · orchestrator · High");
    expect(modelSummary({ harnessId: "fake", capabilities, config: config({ agent: "orchestrator", agents: [{ id: "orchestrator", label: "orchestrator", description: "Plugin role" }] }) })).toBe("Fake Echo · orchestrator · High");
    expect(configSummary({ harnessId: "fake", capabilities, config: config({ agent: null, agents: [{ id: "build", label: "Build", description: "Default role" }] }) }, harnesses)).toBe("Pi · Fake Echo · Harness default · High");
  });
  it("does not infer a role for an unset default, while preserving selected ordering", () => {
    const caps = { supportsAgentSelection: true, supportsModelSelection: true, supportsThinkingLevel: true, supportsPermissionMode: false };
    expect(modelSummary({ harnessId: "fake", capabilities: caps, config: { agent: null, agents: [{ id: "build", label: "Build", description: "The default agent" }], models: [{ key: "fake/echo", provider: "fake", id: "echo", name: "Fake Echo" }], model: "fake/echo", thinkingLevel: null, permissionMode: null, permissionModes: [] } })).toBe("Fake Echo · Harness default · Default");
    expect(modelSummary({ harnessId: "fake", capabilities: caps, config: { agent: "plan", agents: [{ id: "plan", label: "Plan", description: "Read-only planning" }], models: [{ key: "fake/echo", provider: "fake", id: "echo", name: "Fake Echo" }], model: "fake/echo", thinkingLevel: "high", permissionMode: null, permissionModes: [] } })).toBe("Fake Echo · Plan · High");
  });

describe("the folded phone composer's one sentence", () => {
  it("names the model and the level, without the harness or the permission mode", () => {
    expect(modelSummary({ harnessId: "fake", capabilities: caps({ supportsPermissionMode: true }), config: config({ permissionMode: "default" }) })).toBe("Fake Echo · High");
  });

  it("leaves the level out where the harness has none", () => {
    expect(modelSummary({ harnessId: "fake", capabilities: caps({ supportsThinkingLevel: false }), config: config() })).toBe("Fake Echo");
  });

  it("says so when the harness reports no model at all", () => {
    expect(modelSummary({ harnessId: "fake", capabilities: caps(), config: config({ model: null }) })).toBe("No model · High");
    expect(modelSummary({ harnessId: "fake", capabilities: caps({ supportsThinkingLevel: false }), config: config({ model: null }) })).toBe("No model");
  });
});
