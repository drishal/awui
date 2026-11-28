// Model, thinking, and permission mode live inside the composer card's bottom
// row (DeepSeek Harness). Tools are never narrowed: each harness keeps its
// normal tool set.
import { useState } from "react";
import { AgentPicker } from "./AgentPicker.js";
import type { ChatState } from "../chat-state.js";
import type { ConfigPatch, HarnessStatus } from "../../shared/protocol.js";
import { configSummary, modelSummary } from "../config-summary.js";
import { handoffChoice } from "../handoff.js";
import { useMediaQuery } from "../hooks.js";
import { harnessColor } from "../harness-colors.js";
import { IconChevronDown } from "../icons.js";
import { ConfigSheet } from "./ConfigSheet.js";
import { HarnessMenu } from "./HarnessMenu.js";
import { HarnessMark } from "./HarnessMark.js";
import { ModelPicker } from "./ModelPicker.js";
import { PermissionPicker } from "./PermissionPicker.js";
import { ThinkingPicker } from "./ThinkingPicker.js";


/**
 * The composer's harness chip: the chat's harness, and a menu of the others to
 * hand it off to. It stays disabled while a handoff runs (one POST, one new
 * session); success navigates away, failure re-enables it.
 */
function HandoffChip({ chat, harnesses, onHandoff }: { chat: ChatState; harnesses: HarnessStatus[]; onHandoff: (harnessId: string) => Promise<void> }) {
  const [pending, setPending] = useState(false);
  const choices = harnesses.filter((h) => h.id !== chat.harnessId).map(handoffChoice);
  const current = harnesses.find((h) => h.id === chat.harnessId);
  return (
    <HarnessMenu
      variant="chip"
      label="Hand off to another harness"
      handoff
      menuLabel="Hand off to"
      currentId={chat.harnessId}
      choices={current ? [{ harness: current, blocked: "This chat's harness" }, ...choices] : choices}
      triggerText={pending ? "Handing off…" : undefined}
      hint={`Hand this chat off from ${current?.displayName ?? chat.harnessId}; it starts a fresh native session without a second writer.`}
      disabled={pending || chat.status === "disposed" || choices.every((c) => c.blocked !== null)}
      onPick={(id) => {
        if (id === chat.harnessId) return;
        setPending(true);
        void onHandoff(id).finally(() => setPending(false));
      }}
    />
  );
}

/** The harness's own first-listed permission mode is the safe default: it needs one shield, not a word.
 *  Any other mode stops part of the asking and keeps its label (and its warn wash). */
function quietPolicy(config: ChatState["config"]): boolean {
  const first = config.permissionModes?.[0]?.id;
  return config.permissionMode === null || config.permissionMode === first;
}

export function ComposerControls({
  chat,
  harnesses,
  onConfig,
  onConfigError,
  onRefreshModels,
  onHandoff,
}: {
  chat: ChatState;
  harnesses: HarnessStatus[];
  onConfig: (patch: ConfigPatch) => Promise<void>;
  onConfigError: (error: unknown) => void;
  onRefreshModels: () => Promise<void>;
  onHandoff: (harnessId: string) => Promise<void>;
}) {
  const caps = chat.capabilities;
  const change = (patch: ConfigPatch) => { void onConfig(patch).catch(onConfigError); };
  const idle = chat.status === "idle" || chat.status === "error";
  const { config } = chat;
  const [settings, setSettings] = useState(false);
  const phone = useMediaQuery("(max-width: 600px)");
  const current = harnesses.find((h) => h.id === chat.harnessId);
  // A resumed chat's harness is still coming up: its pickers fade in and out until its own models arrive.
  const loading = chat.status === "starting";

  const agents = caps.supportsAgentSelection && config.agent !== undefined && config.agents !== undefined ? config.agents : null;
  return (
    <div className="composer-controls" data-harness-accent={current?.accent}>
      <div className={`composer-pickers${loading ? " is-loading" : ""}`} aria-busy={loading || undefined}>
        {agents ? <AgentPicker agents={agents} current={config.agent ?? null} disabled={!idle} onSelect={(agent) => change({ agent })} /> : null}
        {/* One split pill: the harness mark leads, and model and level read together as a single
            sentence ("Fake Echo · Low"). Each piece is still its own menu. */}
        <div className="composer-pill">
          <HandoffChip chat={chat} harnesses={harnesses} onHandoff={onHandoff} />
          {caps.supportsModelSelection || (caps.supportsThinkingLevel && config.thinkingLevels.length > 0) ? (
            <div className="composer-pill-settings">
              {caps.supportsModelSelection ? (
                <ModelPicker
                  models={config.models}
                  current={config.model}
                  harnessId={chat.harnessId}
                  disabled={!idle}
                  loading={loading && config.model === null}
                  onSelect={(model) => change({ model })}
                  onRefresh={onRefreshModels}
                />
              ) : null}
              {caps.supportsThinkingLevel && config.thinkingLevels.length > 0 ? (
                <ThinkingPicker
                  levels={config.thinkingLevels}
                  current={config.thinkingLevel}
                  sent={config.thinkingSent ?? null}
                  defaultLevel={caps.supportsThinkingDefault ? "Default" : undefined}
                  disabled={!idle}
                  onSelect={(thinkingLevel) => change({ thinkingLevel })}
                />
              ) : null}
            </div>
          ) : null}
        </div>
        {caps.supportsPermissionMode && config.permissionModes?.length ? (
          // The harness's default mode is one shield; a mode that stops asking keeps its word.
          <div className={`composer-policy${quietPolicy(config) ? " is-quiet" : ""}`}>
            <PermissionPicker
              modes={config.permissionModes}
              current={config.permissionMode ?? null}
              disabled={chat.status === "disposed"}
              onSelect={(permissionMode) => change({ permissionMode })}
            />
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="pill-trigger composer-config-chip"
        aria-haspopup="dialog"
        aria-expanded={settings}
        title="Chat settings"
        data-testid="config-chip"
        onClick={() => setSettings(true)}
      >
        <span className="harness-dot" style={harnessColor(chat.harnessId)}><HarnessMark harness={current} /></span>
        <span className="config-summary">{phone ? modelSummary(chat) : configSummary(chat, harnesses)}</span>
        <IconChevronDown size={12} />
      </button>
      {settings ? (
        <ConfigSheet
          chat={chat}
          harnesses={harnesses}
          onConfig={onConfig}
          onHandoff={onHandoff}
          onRefreshModels={onRefreshModels}
          onClose={() => setSettings(false)}
        />
      ) : null}
    </div>
  );
}
