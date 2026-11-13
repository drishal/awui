// The permission mode as a composer pill: the mode in force, and a list of the
// harness's modes with a line on what each lets the agent do without asking.
// Unlike model and thinking it stays enabled mid-run, since a run full of
// approval prompts is when you want it (Claude Code's own Shift+Tab). The
// popover is the harness menu's, so the composer's menus look alike.
import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import type { PermissionModeInfo } from "../../shared/protocol.js";
import { useDismiss, useLeave } from "../hooks.js";
import { IconCheck, IconChevronDown, IconShield } from "../icons.js";

export function PermissionPicker({
  modes,
  current,
  disabled,
  onSelect,
}: {
  modes: PermissionModeInfo[];
  current: string | null;
  disabled: boolean;
  onSelect: (mode: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { render: showMenu, leaving } = useLeave(open);
  const [active, setActive] = useState(0);
  const [shift, setShift] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const mode = modes.find((m) => m.id === current);
  const label = mode?.label ?? current ?? "Default";

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(wrap, open, () => close(false));

  const show = () => {
    if (disabled || modes.length === 0) return;
    setActive(Math.max(0, modes.findIndex((m) => m.id === current)));
    setShift(0);
    setOpen(true);
  };

  // Late in a phone's composer row the list would run off the window's right edge: it moves left to stay on screen.
  // Layout sizes, not the box: the list pops in scaled, and a scaled box is narrower than where it settles.
  useLayoutEffect(() => {
    if (!open || !list.current || !wrap.current) return;
    const left = wrap.current.getBoundingClientRect().left + list.current.offsetLeft;
    const right = left + list.current.offsetWidth;
    setShift(Math.floor(Math.max(8 - left, Math.min(0, window.innerWidth - 8 - right))));
  }, [open]);

  // Focus moves into the list as soon as it renders.
  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  const pick = (i: number) => {
    const choice = modes[i];
    if (!choice) return;
    close(true);
    if (choice.id !== current) onSelect(choice.id);
  };

  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    const n = modes.length;
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

  // Keys that reach the trigger while the list is open (pressed before focus moved) act on the list.
  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (open) return onListKey(e);
    if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    show();
  };

  return (
    <div className="model-picker" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className={`pill-trigger permission-trigger${mode?.caution ? " is-caution" : ""}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Permissions: ${label}`}
        title={mode?.description ?? "Permission mode"}
        disabled={disabled}
        data-testid="permission-picker"
        data-mode={mode?.id ?? ""}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onTriggerKey}
      >
        <IconShield size={13} />
        <span className="pill-label">{label}</span>
        <IconChevronDown size={12} />
      </button>
      {showMenu ? (
        <div
          ref={list}
          className={`harness-menu permission-menu${leaving ? " is-leaving" : ""}`}
          role="listbox"
          tabIndex={-1}
          aria-label="Permission mode"
          aria-activedescendant={`${baseId}-${active}`}
          style={shift ? { left: shift } : undefined}
          onKeyDown={onListKey}
        >
          <div className="harness-menu-head">Permission mode</div>
          {modes.map((m, i) => (
            <div
              key={m.id}
              id={`${baseId}-${i}`}
              role="option"
              aria-label={m.label}
              aria-selected={m.id === current}
              className={`permission-option${i === active ? " is-active" : ""}${m.caution ? " is-caution" : ""}`}
              onMouseMove={() => setActive(i)}
              onClick={() => pick(i)}
            >
              <span className="permission-option-text">
                <span className="permission-option-name">{m.label}</span>
                <span className="permission-option-desc">{m.description}</span>
              </span>
              {m.id === current ? <IconCheck size={13} className="harness-option-check" /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
