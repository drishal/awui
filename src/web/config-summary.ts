// The composer's one line of settings on a phone (harness · model · effort ·
// permission), for the single chip that stands in for the pickers there. Pure,
// so which parts appear and in what order is tested without a browser.
import type { ChatConfig, HarnessCapabilities } from "../shared/protocol.js";

type SummaryChat = {
  harnessId: string;
  capabilities: Pick<HarnessCapabilities, "supportsModelSelection" | "supportsThinkingLevel" | "supportsPermissionMode">;
  config: Pick<ChatConfig, "model" | "models" | "thinkingLevel" | "permissionMode" | "permissionModes">;
};

/** A thinking level as a person reads it: "max" → "Max". */
export function levelTitle(level: string): string {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

export function configSummary(chat: SummaryChat, harnesses: Array<{ id: string; displayName: string }>): string {
  const { config, capabilities } = chat;
  const parts = [harnesses.find((h) => h.id === chat.harnessId)?.displayName ?? chat.harnessId];
  if (capabilities.supportsModelSelection) {
    const model = config.models.find((m) => m.key === config.model);
    // A virtual provider (MoA) says its name: "Mixture of Agents · default", not "default".
    parts.push(model ? (model.providerName ? `${model.providerName} · ${model.name}` : model.name) : (config.model ?? "No model"));
  }
  if (capabilities.supportsThinkingLevel && config.thinkingLevel) parts.push(levelTitle(config.thinkingLevel));
  if (capabilities.supportsPermissionMode && config.permissionMode) {
    parts.push(config.permissionModes?.find((m) => m.id === config.permissionMode)?.label ?? config.permissionMode);
  }
  return parts.join(" · ");
}
