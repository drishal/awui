// The composer's one line of settings on a phone (model · role · effort ·
// permission), for the single chip standing in for the pickers there. Pure,
// so which parts appear and in what order is tested without a browser.
import type { ChatConfig, HarnessCapabilities } from "../shared/protocol.js";

type SummaryChat = {
  harnessId: string;
  capabilities: Pick<HarnessCapabilities, "supportsModelSelection" | "supportsThinkingLevel" | "supportsPermissionMode" | "supportsAgentSelection">;
  config: Pick<ChatConfig, "model" | "models" | "thinkingLevel" | "permissionMode" | "permissionModes" | "agent" | "agents">;
};

/** A thinking level as a person reads it: "xhigh" → "Extra high", "max" → "Max". */
export function levelTitle(level: string): string {
  return level === "xhigh" ? "Extra high" : level.charAt(0).toUpperCase() + level.slice(1);
}

/** Model, primary role and effort in native order. "Harness default" marks an
 * unset role, distinct from a selected role or a delegated worker. The header
 * already names the harness, so the phone needn't repeat it. */
export function modelSummary(chat: SummaryChat): string {
  const { config, capabilities } = chat;
  const parts: string[] = [];
  if (capabilities.supportsModelSelection) {
    const model = config.models.find((m) => m.key === config.model);
    parts.push(model ? (model.providerName ? `${model.providerName} · ${model.name}` : model.name) : (config.model ?? "No model"));
  }

  if (capabilities.supportsAgentSelection) parts.push(config.agent ? (config.agents?.find((a) => a.id === config.agent)?.label ?? config.agent) : "Harness default");
  if (capabilities.supportsThinkingLevel) parts.push(levelTitle(config.thinkingLevel ?? "default"));
  return parts.join(" · ");
}

export function configSummary(chat: SummaryChat, harnesses: Array<{ id: string; displayName: string }>): string {
  const { config, capabilities } = chat;
  const parts = [harnesses.find((h) => h.id === chat.harnessId)?.displayName ?? chat.harnessId];
  if (capabilities.supportsModelSelection) {
    const model = config.models.find((m) => m.key === config.model);
    // A virtual provider (MoA) says its name: "Mixture of Agents · default", not "default".
    parts.push(model ? (model.providerName ? `${model.providerName} · ${model.name}` : model.name) : (config.model ?? "No model"));
  }
  if (capabilities.supportsAgentSelection && config.agent) parts.push(config.agents?.find((a) => a.id === config.agent)?.label ?? config.agent);
  if (capabilities.supportsThinkingLevel && config.thinkingLevel) parts.push(levelTitle(config.thinkingLevel));
  if (capabilities.supportsPermissionMode && config.permissionMode) {
    parts.push(config.permissionModes?.find((m) => m.id === config.permissionMode)?.label ?? config.permissionMode);
  }
  return parts.join(" · ");
}
