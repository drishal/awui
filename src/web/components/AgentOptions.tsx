// The single primary-role listbox used by a compact popover and by the native
// Chat settings sub-pane. Keyboard focus and selection are the same in both.
import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { AgentInfo } from "../../shared/protocol.js";
import { IconCheck } from "../icons.js";

export const AgentOptions = forwardRef<HTMLDivElement, {
  agents: AgentInfo[];
  current: string | null;
  onSelect: (id: string) => void;
  onBack: () => void;
  onTab?: () => void;
  viewport?: boolean;
  pane?: boolean;
  shift?: number;
  leaving?: boolean;
  disabled?: boolean;
}>(function AgentOptions({ agents, current, onSelect, onBack, viewport = false, pane = false, shift = 0, leaving = false, onTab, disabled = false }, forwarded) {
  const own = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(() => Math.max(0, agents.findIndex((a) => a.id === current)));
  const id = useId();
  useEffect(() => { own.current?.focus(); }, []);
  useEffect(() => { document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, id]);
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Tab") { onTab?.(); return; }
    const n = agents.length;
    const actions: Record<string, () => void> = {
      ArrowDown: () => setActive((v) => (v + 1) % n),
      ArrowUp: () => setActive((v) => (v - 1 + n) % n),
      Home: () => setActive(0),
      End: () => setActive(n - 1),
      Enter: () => { const choice = agents[active]; if (!disabled && choice) onSelect(choice.id); },
      " ": () => { const choice = agents[active]; if (!disabled && choice) onSelect(choice.id); },
      Escape: onBack,
    };
    const action = actions[e.key];
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    action();
  };
  return (
    <div ref={(el) => { own.current = el; if (typeof forwarded === "function") forwarded(el); else if (forwarded) forwarded.current = el; }}
      className={`${pane ? "" : "harness-menu "}permission-menu agent-menu${viewport ? " is-sheet" : ""}${pane ? " is-pane" : ""}${leaving ? " is-leaving" : ""}`}
      role="listbox" tabIndex={-1} aria-label="Primary agent" aria-disabled={disabled || undefined} aria-activedescendant={`${id}-${active}`}
      style={shift ? { left: shift } : undefined} onKeyDown={onKeyDown}>
      <div className="harness-menu-head">{!pane ? "Primary agent" : null}</div>
      {agents.map((agent, i) => (
        <div key={agent.id} id={`${id}-${i}`} role="option" aria-label={agent.label} aria-describedby={agent.description ? `${id}-${i}-desc` : undefined} aria-selected={agent.id === current}
          className={`permission-option${i === active ? " is-active" : ""}${pane ? " is-pane" : ""}`}
          onMouseMove={() => !leaving && setActive(i)} aria-disabled={disabled || undefined} onClick={() => { if (!disabled && !leaving) onSelect(agent.id); }}>
          <span className="permission-option-text">
            <span className="permission-option-name">{agent.label}</span>
            {agent.description ? <span id={`${id}-${i}-desc`} className="permission-option-desc">{agent.description}</span> : null}
          </span>
          {agent.id === current ? <IconCheck size={13} className="harness-option-check" /> : null}
        </div>
      ))}
    </div>
  );
});
