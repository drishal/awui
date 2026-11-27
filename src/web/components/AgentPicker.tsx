// The harness's primary agent in the composer. This is its conversation role
// (OpenCode's Build, Plan, or a plugin's orchestrator), not a permission mode
// and not a type of delegated worker: the server already filtered the catalog.
import { createPortal } from "react-dom";
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentInfo } from "../../shared/protocol.js";
import { useDismiss, useLeave } from "../hooks.js";
import { IconCheck, IconChevronDown } from "../icons.js";

export function AgentPicker({ agents, current, disabled, viewportSheet = false, onSelect }: { agents: AgentInfo[]; current: string | null; disabled: boolean; viewportSheet?: boolean; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const { render: showMenu, leaving } = useLeave(open);
  const [active, setActive] = useState(0);
  const [shift, setShift] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const agent = agents.find((a) => a.id === current);
  const label = agent?.label ?? current ?? "Default agent";

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(wrap, open, () => close(false), { escape: true });

  const show = () => {
    if (disabled || agents.length === 0) return;
    setActive(Math.max(0, agents.findIndex((a) => a.id === current)));
    setShift(0);
    setOpen(true);
  };

  // Keep the list inside both the viewport and a horizontally scrollable chat.
  useLayoutEffect(() => {
    if (!open || !list.current || !wrap.current || viewportSheet) return;
    const left = wrap.current.getBoundingClientRect().left + list.current.offsetLeft;
    const right = left + list.current.offsetWidth;
    setShift(Math.floor(Math.max(8 - left, Math.min(0, window.innerWidth - 8 - right))));
  }, [open, viewportSheet]);
  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  const pick = (i: number) => {
    const choice = agents[i];
    if (!choice) return;
    close(true);
    if (choice.id !== current) onSelect(choice.id);
  };
  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    const n = agents.length;
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((a) => (a + 1) % n),
      ArrowUp: () => setActive((a) => (a - 1 + n) % n),
      Home: () => setActive(0),
      End: () => setActive(n - 1),
      Enter: () => pick(active),
      " ": () => pick(active),
      Escape: () => close(true),
    };
    if (e.key === "Tab") return close(false);
    const action = keys[e.key];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  };
  const menuNode = (
    <div
      ref={list}
      className={`harness-menu permission-menu agent-menu${viewportSheet ? " is-sheet" : ""}${leaving ? " is-leaving" : ""}`}
      role="listbox"
      tabIndex={-1}
      aria-label="Primary agent"
      aria-activedescendant={`${baseId}-${active}`}
      style={!viewportSheet && shift ? { left: shift } : undefined}
      onKeyDown={onListKey}
    >
      <div className="harness-menu-head">Primary agent</div>
      {agents.map((a, i) => (
        <div
          key={a.id}
          id={`${baseId}-${i}`}
          role="option"
          aria-label={a.label}
          aria-selected={a.id === current}
          className={`permission-option${i === active ? " is-active" : ""}`}
          onMouseMove={() => setActive(i)}
          onClick={() => pick(i)}
        >
          <span className="permission-option-text">
            <span className="permission-option-name">{a.label}</span>
            {a.description ? <span className="permission-option-desc">{a.description}</span> : null}
          </span>
          {a.id === current ? <IconCheck size={13} className="harness-option-check" /> : null}
        </div>
      ))}
    </div>
  );

  return (
    <div className="model-picker" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="pill-trigger agent-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Agent: ${label}`}
        title={agent?.description ?? "Primary agent"}
        disabled={disabled || agents.length === 0}
        data-testid="agent-picker"
        data-agent={agent?.id ?? current ?? ""}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={(e) => {
          if (open) {
            onListKey(e);
            return;
          }
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            show();
          }
        }}
      >
        <span className="pill-label">{label}</span>
        <IconChevronDown size={12} />
      </button>
      {showMenu ? (
        <>
          {!viewportSheet ? <div className={`model-backdrop${leaving ? " is-leaving" : ""}`} aria-hidden="true" onClick={() => close(false)} /> : null}
          {viewportSheet ? createPortal(menuNode, wrap.current?.closest("dialog") ?? document.body) : menuNode}
        </>
      ) : null}
    </div>
  );
}
