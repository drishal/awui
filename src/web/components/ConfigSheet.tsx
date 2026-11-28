// Phone settings: actual common work choices come before the rare handoff list.
// A primary-agent choice opens a sub-pane of this same native Dialog, not an
// overlay that can escape the parent sheet. Back restores the settings list.
import { useRef, useState, type KeyboardEvent } from "react";
import { AgentPicker } from "./AgentPicker.js";
import { AgentOptions } from "./AgentOptions.js";
import type { ChatState } from "../chat-state.js";
import type { ConfigPatch, HarnessStatus, OauthAccountChoice } from "../../shared/protocol.js";
import { handoffChoice } from "../handoff.js";
import { errorText } from "../api.js";
import { harnessColor } from "../harness-colors.js";
import { IconArrowLeft, IconCheck } from "../icons.js";
import { HarnessMark } from "./HarnessMark.js";
import { Dialog } from "./Dialog.js";
import { ModelPicker } from "./ModelPicker.js";
import { PermissionPicker } from "./PermissionPicker.js";
import { ThinkingPicker } from "./ThinkingPicker.js";
import { AccountPicker } from "./AccountPicker.js";

function AgentPane({ agents, current, disabled, applying, error, onBack, onSelect }: { agents: NonNullable<ChatState["config"]["agents"]>; current: string | null; disabled: boolean; applying: boolean; error: string | null; onBack: () => void; onSelect: (id: string) => void }) {
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onBack();
  };
  return (
    <div className="config-agent-pane" onKeyDown={onKey}>
      <button type="button" className="btn btn-ghost config-back" onClick={onBack}><IconArrowLeft size={14} />Back to chat settings</button>
      <p className={`config-pane-note${error ? " config-error" : ""}`} aria-live="polite" aria-busy={applying}>{error ?? (applying ? "Saving…" : "Choose the role for this conversation.")}</p>
      <AgentOptions agents={agents} current={current} onBack={onBack} pane disabled={disabled} onSelect={onSelect} />
    </div>
  );
}

export function ConfigSheet({ chat, harnesses, onConfig, onHandoff, onRefreshModels, onClose }: {
  chat: ChatState;
  harnesses: HarnessStatus[];
  onConfig: (patch: ConfigPatch) => Promise<void>;
  onHandoff: (harnessId: string) => Promise<void>;
  onRefreshModels: () => Promise<void>;
  onClose: () => void;
}) {
  const caps = chat.capabilities;
  const { config } = chat;
  const idle = chat.status === "idle" || chat.status === "error";
  const [pending, setPending] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const primaryRow = useRef<HTMLDivElement>(null);
  const [accounts, setAccounts] = useState<OauthAccountChoice[] | null>(null);
  const [applying, setApplying] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  // Role instructions/model affect the next model call: the same idle-only rule as models.
  const agents = caps.supportsAgentSelection && config.agent !== undefined && config.agents !== undefined ? config.agents : null;
  const pick = async (patch: ConfigPatch) => {
    if (applying) return;
    setApplying(true);
    setConfigError(null);
    try {
      await onConfig(patch);
      onClose();
    } catch (error) {
      // Its previous native value remains authoritative. Keep the pane for retry/back.
      setConfigError(errorText(error).slice(0, 180));
    } finally {
      setApplying(false);
    }
  };
  const back = () => {
    setChoosing(false);
    window.requestAnimationFrame(() => primaryRow.current?.querySelector<HTMLButtonElement>("[data-testid=agent-picker]")?.focus());
  };
  return (
    <Dialog title={choosing ? "Primary agent" : "Chat settings"} onClose={onClose} className="config-sheet">
      {choosing && agents ? (
        <AgentPane agents={agents} current={config.agent ?? null} disabled={!idle || applying} applying={applying} error={configError} onBack={back} onSelect={(agent) => pick({ agent })} />
      ) : (
        <>
          {agents ? (
            <div className="config-row" ref={primaryRow}>
              <span className="config-row-label">Primary agent</span>
              <AgentPicker agents={agents} current={config.agent ?? null} disabled={!idle || applying} onOpen={() => setChoosing(true)} onSelect={() => undefined} />
            </div>
          ) : null}
          {caps.supportsModelSelection ? (
            <div className="config-row">
              <span className="config-row-label">Model</span>
              <ModelPicker models={config.models} current={config.model} harnessId={chat.harnessId} disabled={!idle || applying} onSelect={(model) => pick({ model })} onRefresh={onRefreshModels} />
            </div>
          ) : null}
          {caps.supportsThinkingLevel && config.thinkingLevels.length > 0 ? (
            <div className="config-row"><span className="config-row-label">Effort</span><ThinkingPicker levels={config.thinkingLevels} current={config.thinkingLevel} sent={config.thinkingSent ?? null}
              defaultLevel={caps.supportsThinkingDefault ? "Default" : undefined} disabled={!idle || applying} onSelect={(thinkingLevel) => pick({ thinkingLevel })} /></div>
          ) : null}
          {caps.supportsAccountSelection ? <AccountPicker chat={chat} /> : null}
          {caps.supportsPermissionMode && config.permissionModes?.length ? (
            <div className="config-row"><span className="config-row-label">Permission</span><PermissionPicker modes={config.permissionModes} current={config.permissionMode ?? null} disabled={chat.status === "disposed" || applying} onSelect={(permissionMode) => pick({ permissionMode })} /></div>
          ) : null}
          {configError || applying ? <p className={`config-pane-note${configError ? " config-error" : ""}`} aria-live="polite" aria-busy={applying}>{configError ?? "Saving…"}</p> : null}
          <h3 className="config-section-title">Hand off to another harness</h3>
          <div className="config-choices">
            {harnesses.map((h) => {
              const choice = handoffChoice(h);
              const here = h.id === chat.harnessId;
              const note = here ? "This chat" : (choice.blocked ?? choice.note);
              return (
                <button key={h.id} type="button" className="config-choice" disabled={here || choice.blocked !== null || pending !== null} aria-current={here ? "true" : undefined}
                  onClick={() => { setPending(h.id); void onHandoff(h.id).finally(() => setPending(null)); }}>
                  <span className="harness-dot" style={harnessColor(h.id)}><HarnessMark harness={h} /></span>
                  <span className="config-choice-main"><span className="config-choice-name">{h.displayName}</span><span className="config-choice-note">{pending === h.id ? "Handing off…" : note}</span></span>
                  {here ? <IconCheck size={14} /> : null}
                </button>
              );
            })}
          </div>
        </>
      )}
    </Dialog>
  );
}
