// The single primary-role listbox used by a compact popover and by the native
// Chat settings sub-pane. Keyboard focus and selection are the same in both.
import { forwardRef, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { AgentInfo } from "../../shared/protocol.js";
import { IconCheck } from "../icons.js";

export const AgentOptions = forwardRef<HTMLDivElement, {
  agents: AgentInfo[];
  current: string | null;
  onSelect: (id: string) => void;
  onDefault?: () => void | Promise<void>;
  onBack: () => void;
  onTab?: () => void;
  viewport?: boolean;
  pane?: boolean;
  shift?: number;
  leaving?: boolean;
  disabled?: boolean;
}>(function AgentOptions({ agents, current, onSelect, onDefault, onBack, viewport = false, pane = false, shift = 0, leaving = false, onTab, disabled = false }, forwarded) {
  const own = useRef<HTMLDivElement>(null);
  const hasDefault = onDefault !== undefined;
  const [active, setActive] = useState(() => {
    const found = agents.findIndex((a) => a.id === current);
    return found >= 0 ? found + (hasDefault ? 1 : 0) : hasDefault ? 0 : Math.max(0, found);
  });
  const id = useId();
  useEffect(() => { own.current?.focus(); }, []);
  useEffect(() => { document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, id]);
  // The popover has no inline error surface; a rejected native start already reported through the app's banner.
  const activateDefault = () => {
    if (disabled || current === null) return;
    void Promise.resolve(onDefault?.()).catch(() => undefined);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === "Tab") {
      // A popover's Tab hands focus back to its trigger. Letting the browser move it first would
      // leave focus behind the still-visible sheet for a frame, then on a background control once it closes.
      if (onTab) { e.preventDefault(); onTab(); }
      return;
    }
    const total = agents.length + (hasDefault ? 1 : 0);
    const choose = (index: number) => {
      if (disabled) return;
      if (hasDefault && index === 0) { activateDefault(); return; }
      const choice = agents[index - (hasDefault ? 1 : 0)];
      if (choice) onSelect(choice.id);
    };
    const wrap = (value: number) => (value + total) % total;
    const actions: Record<string, () => void> = {
      ArrowDown: () => setActive((v) => wrap(v + 1)),
      ArrowUp: () => setActive((v) => wrap(v - 1)),
      Home: () => setActive(0),
      End: () => setActive(total - 1),
      Enter: () => choose(active),
      " ": () => choose(active),
      Escape: onBack,
    };
    const action = actions[e.key];
    if (!action) return;
    // Key repeat is not a second choice: holding Enter must not start the same native action again.
    if (e.repeat && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); return; }
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
      {hasDefault ? (
        <div id={`${id}-0`} role="option" data-role="default" aria-label="Harness default"
          aria-describedby={`${id}-default-desc`} aria-selected={current === null}
          aria-disabled={disabled || current === null || undefined}
          className={`permission-option is-default${pane ? " is-pane" : ""}${active === 0 ? " is-active" : ""}`}
          onMouseMove={() => !leaving && setActive(0)}
          onClick={activateDefault}>
          <span className="permission-option-text">
            <span className="permission-option-name">Harness default</span>
            <span id={`${id}-default-desc`} className="permission-option-desc">The harness decides. After a role is set, this starts a new chat on its default.</span>
          </span>
          {current === null ? <IconCheck size={13} className="harness-option-check" /> : null}
        </div>
      ) : null}
      {agents.map((agent, i) => {
        const index = i + (hasDefault ? 1 : 0);
        return (
        <div key={agent.id} id={`${id}-${index}`} role="option" data-role="agent" aria-label={agent.label} aria-describedby={agent.description ? `${id}-${index}-desc` : undefined} aria-selected={agent.id === current}
          className={`permission-option${index === active ? " is-active" : ""}${pane ? " is-pane" : ""}`}
          onMouseMove={() => !leaving && setActive(index)} aria-disabled={disabled || undefined} onClick={() => { if (!disabled && !leaving) onSelect(agent.id); }}>
          <span className="permission-option-text">
            <span className="permission-option-name">{agent.label}</span>
            {agent.description ? <span id={`${id}-${index}-desc`} className="permission-option-desc">{agent.description}</span> : null}
          </span>
          {agent.id === current ? <IconCheck size={13} className="harness-option-check" /> : null}
        </div>
        );
      })}
    </div>
  );
});
