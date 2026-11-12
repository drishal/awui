// The composer's settings on a phone, where three pills do not fit: the chip in
// the composer opens this sheet, which holds the harness (inline, because
// changing it is a handoff and its own menu is a popover a sheet would clip)
// and the model, effort, and permission pickers as rows. Those keep their own
// bottom sheets, so nothing about choosing one changes. Picking a value closes
// the sheet: the point of it was to get back to the message box.
import { useState } from "react";
import type { ChatState } from "../chat-state.js";
import type { ConfigPatch, HarnessStatus, OauthAccountChoice } from "../../shared/protocol.js";
import { handoffChoice } from "../handoff.js";
import { harnessColor } from "../harness-colors.js";
import { IconCheck } from "../icons.js";
import { Dialog } from "./Dialog.js";
import { ModelPicker } from "./ModelPicker.js";
import { PermissionPicker } from "./PermissionPicker.js";
import { ThinkingPicker } from "./ThinkingPicker.js";
import { AccountPicker } from "./AccountPicker.js";

export function ConfigSheet({
  chat,
  harnesses,
  onConfig,
  onHandoff,
  onRefreshModels,
  onClose,
}: {
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
  const [accounts, setAccounts] = useState<OauthAccountChoice[] | null>(null);
  const pick = (patch: ConfigPatch) => {
    void onConfig(patch);
    onClose();
  };
  return (
    <Dialog title="Chat settings" onClose={onClose} className="config-sheet">
      <h3 className="config-section-title">Harness</h3>
      <div className="config-choices">
        {harnesses.map((h) => {
          const choice = handoffChoice(h);
          const here = h.id === chat.harnessId;
          const note = here ? "This chat" : (choice.blocked ?? choice.note);
          return (
            <button
              key={h.id}
              type="button"
              className="config-choice"
              disabled={here || choice.blocked !== null || pending !== null}
              aria-current={here ? "true" : undefined}
              onClick={() => {
                setPending(h.id);
                void onHandoff(h.id).finally(() => setPending(null));
              }}
            >
              <span className="harness-dot" style={harnessColor(h.id)} />
              <span className="config-choice-main">
                <span className="config-choice-name">{h.displayName}</span>
                <span className="config-choice-note">{pending === h.id ? "Handing off…" : note}</span>
              </span>
              {here ? <IconCheck size={14} /> : null}
            </button>
          );
        })}
      </div>
      {caps.supportsModelSelection ? (
        <div className="config-row">
          <span className="config-row-label">Model</span>
          <ModelPicker models={config.models} current={config.model} harnessId={chat.harnessId} disabled={!idle} onSelect={(model) => pick({ model })} onRefresh={onRefreshModels} />
        </div>
      ) : null}
      {caps.supportsThinkingLevel && config.thinkingLevels.length > 0 ? (
        <div className="config-row">
          <span className="config-row-label">Effort</span>
          <ThinkingPicker
            levels={config.thinkingLevels}
            current={config.thinkingLevel}
            sent={config.thinkingSent ?? null}
            disabled={!idle}
            onSelect={(thinkingLevel) => pick({ thinkingLevel })}
          />
        </div>
      ) : null}
      {caps.supportsAccountSelection ? <AccountPicker chat={chat} /> : null}

      {caps.supportsPermissionMode && config.permissionModes?.length ? (
        <div className="config-row">
          <span className="config-row-label">Permission</span>
          <PermissionPicker
            modes={config.permissionModes}
            current={config.permissionMode ?? null}
            disabled={chat.status === "disposed"}
            onSelect={(permissionMode) => pick({ permissionMode })}
          />
        </div>
      ) : null}
    </Dialog>
  );
}
