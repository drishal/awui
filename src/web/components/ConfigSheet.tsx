// Phone settings: actual common work choices come before the rare handoff list.
// A primary-agent choice opens a sub-pane of this same native Dialog, not an
// overlay that can escape the parent sheet. Back restores the settings list.
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { AgentPicker } from "./AgentPicker.js";
import { AgentOptions } from "./AgentOptions.js";
import type { ChatState } from "../chat-state.js";
import type { ConfigPatch, HarnessStatus } from "../../shared/protocol.js";
import { handoffChoice } from "../handoff.js";
import { errorText } from "../api.js";
import { motionOff } from "../morph.js";
import { POPUP_ENTER_MS, POPUP_LEAVE_MS } from "../model-morph.js";
import { harnessColor } from "../harness-colors.js";
import { IconArrowLeft, IconCheck } from "../icons.js";
import { HarnessMark } from "./HarnessMark.js";
import { Dialog } from "./Dialog.js";
import { ModelPicker } from "./ModelPicker.js";
import { PermissionPicker } from "./PermissionPicker.js";
import { ThinkingPicker } from "./ThinkingPicker.js";
import { AccountPicker } from "./AccountPicker.js";

function AgentPane({ harnessName, agents, current, disabled, applying, returning, error, onBack, onSelect, onDefault }: { harnessName: string; agents: NonNullable<ChatState["config"]["agents"]>; current: string | null; disabled: boolean; applying: boolean; returning: boolean; error: string | null; onBack: () => void; onSelect: (id: string) => void; onDefault: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || motionOff() || typeof root.animate !== "function") return;
    // One current native root moves. There is no second overlay, clip or text rescale.
    const run = root.animate(
      [{ opacity: 0.72, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }],
      { id: "morph:pane", duration: POPUP_ENTER_MS, easing: "cubic-bezier(.65,0,.35,1)" },
    );
    return () => run.cancel();
  }, []);
  const onKey = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    onBack();
  };
  return (
    <div className={`config-agent-pane${returning ? " is-returning" : ""}`} ref={rootRef} onKeyDown={onKey}>
      <button type="button" className="btn btn-ghost config-back" disabled={applying || returning} title={applying ? "Close when saving finishes" : "Back to chat settings"} onClick={onBack}><IconArrowLeft size={14} />Back to chat settings</button>
      <p className={`config-pane-note${error ? " config-error" : ""}`} aria-live="polite" aria-busy={applying}>{error ?? (applying ? "Saving…" : `${current === null ? "Harness default. " : ""}Role changes how ${harnessName} approaches the prompt; model and permissions stay separate. Tap a role, or use Arrow keys and Enter.`)}</p>
      <AgentOptions agents={agents} current={current} onBack={onBack} pane disabled={disabled || returning} onSelect={onSelect} onDefault={onDefault} />
    </div>
  );
}



export function ConfigSheet({ chat, harnesses, onConfig, onDefaultChat, onHandoff, onRefreshModels, onClose }: {
  chat: ChatState;
  harnesses: HarnessStatus[];
  onConfig: (patch: ConfigPatch) => Promise<void>;
  /** Starts a fresh native chat on the harness default; only supplied when the harness supports this inverse. */
  onDefaultChat?: () => Promise<void>;
  onHandoff: (harnessId: string) => Promise<void>;
  onRefreshModels: () => Promise<void>;
  onClose: () => void;
}) {
  const caps = chat.capabilities;
  const { config } = chat;
  const idle = chat.status === "idle" || chat.status === "error";
  const [pending, setPending] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const [returning, setReturning] = useState(false);
  const transitioning = useRef(false);
  const primaryRow = useRef<HTMLDivElement>(null);
  const ownerRef = useRef<HTMLDialogElement>(null);
  // The role pane can hide Dialog's own previous focus target. The composer chip is the outside owner.
  const returnFocus = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  const resized = useRef<Animation | null>(null);
  const restoreRoleFocus = useRef(false);
  useLayoutEffect(() => {
    // Reduced-motion Back skips the outgoing phase. It has the same focus target,
    // so depend on actual settings replacing the role pane, not returning flags.
    if (!choosing && restoreRoleFocus.current) {
      restoreRoleFocus.current = false;
      const picker = primaryRow.current?.querySelector<HTMLButtonElement>("[data-testid=agent-picker]");
      if (picker && !picker.disabled) picker.focus();
      resized.current?.cancel();
      resized.current = null;
      ownerRef.current?.querySelector<HTMLElement>(".dialog-body")?.style.removeProperty("height");
    }
  }, [choosing, returning]);
  const settingsHeight = useRef<number | null>(null);
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
  const useDefault = async () => {
    if (applying || !onDefaultChat) return;
    setApplying(true);
    setConfigError(null);
    try {
      await onDefaultChat();
      onClose();
    } catch (error) {
      // The current chat remains authoritative; the pane stays for retry/back.
      setConfigError(errorText(error).slice(0, 180));
    } finally {
      setApplying(false);
    }
  };

  const back = async () => {
    // Both Back and its Escape route obey the single in-flight owner's lock.
    if (applying || transitioning.current) return;
    const dialog = ownerRef.current;
    const root = dialog?.querySelector<HTMLElement>(".config-agent-pane");
    const body = dialog?.querySelector<HTMLElement>(".dialog-body");
    const target = settingsHeight.current;
    if (!root || !dialog || !body) return;
    transitioning.current = true;
    restoreRoleFocus.current = true;
    setReturning(true);
    if (!motionOff() && typeof root.animate === "function" && typeof body.animate === "function") {
      // Earlier entrance takes precedence. Repeated Escape/click cannot start another outgoing call.
      const entry = root.getAnimations().find(run => run.id === "morph:pane" && run.playState !== "finished");
      if (entry) await entry.finished.catch(() => undefined);
      if (root.isConnected) {
        const current = body.getBoundingClientRect().height;
        const leave = root.animate(
          [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(-8px)" }],
          { id: "morph:pane", duration: POPUP_LEAVE_MS, easing: getComputedStyle(root).getPropertyValue("--ease-out").trim() || "ease-out", fill: "forwards" },
        );
        // Exit toward Back. Pushing the bottom choice down would clip it through
        // the sheet before its container had finished moving into its next size.
        const left = await leave.finished.then(() => true, () => false);
        if (!left || !root.isConnected) return;
        if (target !== null && target !== current) {
          resized.current = body.animate(
            [{ height: `${current}px` }, { height: `${target}px` }],
            { id: "morph:pane-size", duration: POPUP_LEAVE_MS, easing: "cubic-bezier(.65,0,.35,1)", fill: "forwards" },
          );
          const sized = await resized.current.finished.then(() => true, () => false);
          if (!sized) return;
          // Preserve this completed size until settings commits; cancellation and
          // native focus then belong to that same replacement, not a newer RAF.
        }
        // Settings mount only after the outgoing pane has left and its native body fits.
      }
    }
    transitioning.current = false;
    setReturning(false);
    setConfigError(null);
    setChoosing(false);
    // The returning effect releases ownership after these replacements commit.
  };
  const openAgent = () => {
    if (applying || returning) return;
    settingsHeight.current = ownerRef.current?.querySelector<HTMLElement>(".dialog-body")?.getBoundingClientRect().height ?? null;
    setConfigError(null);
    setChoosing(true);
  };
  return (
    <Dialog title={choosing ? "Primary agent" : "Chat settings"} onClose={onClose} closeLocked={applying} ownerRef={ownerRef} returnFocus={returnFocus} className="config-sheet">
      {agents && choosing ? (
        <AgentPane harnessName={harnesses.find(h => h.id === chat.harnessId)?.displayName ?? chat.harnessId} agents={agents} current={config.agent ?? null} disabled={!idle || applying} applying={applying} returning={returning} error={configError} onBack={back} onSelect={(agent) => pick({ agent })} onDefault={useDefault} />
      ) : (
        <>
          {agents ? (
            <div className="config-row" ref={primaryRow}>
              <span className="config-row-label">Primary agent</span>
              <AgentPicker agents={agents} current={config.agent ?? null} disabled={!idle || applying} onOpen={openAgent} onSelect={() => undefined} onDefault={onDefaultChat ? useDefault : undefined} />
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
                <button key={h.id} type="button" className="config-choice" disabled={here || choice.blocked !== null || pending !== null || applying} aria-current={here ? "true" : undefined}
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
