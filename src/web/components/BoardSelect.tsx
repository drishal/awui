// A Board form's select: the app's own menu instead of a native <select>, whose
// OS popup ignores the theme and dumps every option at once (the workspace list
// over a home directory). The trigger is a field-shaped button; the listbox
// reuses the harness menu's classes, so it looks and keys like every other menu
// here — dots, a hint line, a check on the selected row.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { useDismiss, useLeave } from "../hooks.js";
import { IconCheck, IconChevronDown } from "../icons.js";

export interface BoardSelectOption {
  value: string;
  label: string;
  /** A line after the label: a version, a note, or why it cannot be picked. */
  hint?: string;
  disabled?: boolean;
  /** A CSS colour for the leading dot (a theme variable, or the harness badge's var). */
  dot?: string;
}

export function BoardSelect({
  label,
  value,
  options,
  onChange,
  placeholder = "Choose…",
  disabled = false,
}: {
  /** The field's name: the trigger's accessible name and the menu's. */
  label: string;
  value: string;
  options: BoardSelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { render: showMenu, leaving } = useLeave(open);
  const [active, setActive] = useState(-1);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const current = options.find((o) => o.value === value);
  const enabled = (i: number) => options[i] !== undefined && !options[i].disabled;
  const canOpen = !disabled && options.length > 0;

  const close = (refocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(wrap, open, () => close(false));

  const show = () => {
    if (!canOpen) return;
    const selected = options.findIndex((o) => o.value === value);
    const first = options.findIndex((o) => !o.disabled);
    setActive(selected >= 0 && enabled(selected) ? selected : first);
    setOpen(true);
  };
  // Focus moves into the list as soon as it renders (the harness menu's own rule).
  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  const pick = (i: number) => {
    const option = options[i];
    if (!option || option.disabled) return;
    close(true);
    onChange(option.value);
  };
  /** The next pickable option from `from` in `step` direction, wrapping. */
  const move = (from: number, step: 1 | -1): number => {
    for (let k = 1; k <= options.length; k += 1) {
      const i = (from + step * k + options.length * 2) % options.length;
      if (enabled(i)) return i;
    }
    return from;
  };
  const onListKey = (e: KeyboardEvent<HTMLElement>) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive((a) => move(a, 1)),
      ArrowUp: () => setActive((a) => move(a, -1)),
      Home: () => setActive(move(-1, 1)),
      End: () => setActive(move(0, -1)),
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
  // Keys that reach the trigger while the list is open act on the list.
  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (open) return onListKey(e);
    if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    show();
  };

  return (
    <div className="harness-menu-wrap is-row board-select-wrap" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="board-select"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={!canOpen}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onTriggerKey}
      >
        {current?.dot ? <span className="harness-dot" style={{ ["--harness" as string]: current.dot }} aria-hidden="true" /> : null}
        <span className="harness-row-name">{current?.label ?? placeholder}</span>
        <IconChevronDown size={12} />
      </button>
      {showMenu ? (
        <div
          ref={list}
          className={`harness-menu${leaving ? " is-leaving" : ""}`}
          role="listbox"
          tabIndex={-1}
          aria-label={label}
          aria-activedescendant={active >= 0 ? `${baseId}-${active}` : undefined}
          onKeyDown={onListKey}
        >
          {options.map((option, i) => (
            <div
              key={option.value}
              id={`${baseId}-${i}`}
              role="option"
              aria-label={option.label}
              aria-selected={option.value === value}
              aria-disabled={option.disabled === true}
              className={`harness-option${i === active ? " is-active" : ""}${option.disabled ? " is-blocked" : ""}`}
              title={option.hint}
              onMouseMove={() => enabled(i) && setActive(i)}
              onClick={() => pick(i)}
            >
              {option.dot ? <span className="harness-dot" style={{ ["--harness" as string]: option.dot }} aria-hidden="true" /> : null}
              <span className="harness-option-name">{option.label}</span>
              <span className="harness-option-meta">{option.hint ?? ""}</span>
              {option.value === value ? <IconCheck size={13} className="harness-option-check" /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
