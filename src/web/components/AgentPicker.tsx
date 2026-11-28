// The harness's primary-role trigger and ordinary popover, or a phone viewport
// sheet. A native parent sheet may own the role pane through onOpen instead.
import { createPortal } from "react-dom";
import { useLayoutEffect, useRef, useState } from "react";
import type { AgentInfo } from "../../shared/protocol.js";
import { useDismiss, useLeave } from "../hooks.js";
import { usePopupMorph } from "../model-morph.js";
import { IconChevronDown } from "../icons.js";
import { AgentOptions } from "./AgentOptions.js";

export function AgentPicker({ agents, current, disabled, viewportSheet = false, onSelect, onDefault, onOpen }: {
  agents: AgentInfo[];
  current: string | null;
  disabled: boolean;
  viewportSheet?: boolean;
  onSelect: (id: string) => void;
  /** A harness can start a fresh default-native chat; the existing session's explicit role stays. */
  onDefault?: () => void;
  onOpen?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { render: showMenu, leaving } = useLeave(open);
  const [shift, setShift] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const label = agents.find((agent) => agent.id === current)?.label ?? current ?? "Harness default";
  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(wrap, open, () => close(false), { escape: true });
  const show = () => {
    if (disabled || agents.length === 0) return;
    if (onOpen) { onOpen(); return; }
    setShift(0);
    setOpen(true);
  };
  useLayoutEffect(() => {
    if (!open || !list.current || !wrap.current || viewportSheet) return;
    const left = wrap.current.getBoundingClientRect().left + list.current.offsetLeft;
    const right = left + list.current.offsetWidth;
    setShift(Math.floor(Math.max(8 - left, Math.min(0, window.innerWidth - 8 - right))));
  }, [open, viewportSheet]);
  usePopupMorph(trigger, list, showMenu, leaving);
  const menu = <AgentOptions ref={list} agents={agents} current={current} onDefault={onDefault} onBack={() => close(true)}
    onSelect={(id) => { close(true); if (id !== current) onSelect(id); }}
    viewport={viewportSheet} shift={viewportSheet ? 0 : shift} leaving={leaving} onTab={() => close(true)} />;
  // A phone sheet portals its scrim and panel together: the scrim must sit under the panel in the
  // top layer's sibling order, not back in the start screen's flow.
  const host = viewportSheet ? (wrap.current?.closest("dialog") ?? document.body) : null;
  // A native dialog already owns one scrim; only the start screen's sheet adds its own.
  const sheetScrim = host !== null && !(host instanceof HTMLDialogElement);
  return (
    <div className="model-picker" ref={wrap}>
      <button ref={trigger} type="button" className="pill-trigger agent-trigger" aria-haspopup={onOpen ? "dialog" : "listbox"} aria-expanded={onOpen ? undefined : open}
        aria-label={`Agent: ${label}`} title={agents.find((agent) => agent.id === current)?.description ?? "Primary agent"}
        disabled={disabled || agents.length === 0} data-testid="agent-picker" data-agent={current ?? ""} data-default-ready={onDefault !== undefined || undefined}
        onClick={show} onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); show(); }
        }}>
        <span className="pill-label">{label}</span><IconChevronDown size={12} />
      </button>
      {showMenu ? (
        viewportSheet && host ? createPortal(
          <>
            {sheetScrim ? <div className={`model-backdrop${leaving ? " is-leaving" : ""}`} aria-hidden="true" onClick={() => close(true)} /> : null}
            {menu}
          </>,
          host,
        ) : (
          <>
            {!viewportSheet ? <div className={`model-backdrop${leaving ? " is-leaving" : ""}`} aria-hidden="true" onClick={() => close(true)} /> : null}
            {menu}
          </>
        )
      ) : null}
    </div>
  );
}
