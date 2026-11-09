// One harness menu for both places a harness is chosen: the sidebar row picks
// the harness the sidebar lists and new chats use; the composer chip hands the
// open chat off. Every harness is listed with its version, and one that cannot
// be picked says why, so the menu grows with the registry instead of
// squeezing a segmented control.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { HarnessStatus } from "../../shared/protocol.js";
import { harnessColor } from "../harness-colors.js";
import { useDismiss, useLeave } from "../hooks.js";
import { IconCheck, IconChevronDown } from "../icons.js";

export interface HarnessChoice {
  harness: HarnessStatus;
  /** Why it cannot be picked here, or null when it can. */
  blocked: string | null;
  /** What picking it does, shown in place of the version. */
  note?: string;
}

export function HarnessMenu({
  choices,
  currentId,
  variant,
  label,
  menuLabel,
  triggerText,
  disabled = false,
  ariaKeyShortcuts,
  onPick,
}: {
  choices: HarnessChoice[];
  /** The harness in use; marked as selected in the list. */
  currentId: string | null;
  /** "row": a full-width sidebar row that opens downward. "chip": a composer pill that opens upward. */
  variant: "row" | "chip";
  label: string;
  menuLabel: string;
  /** Replaces the harness name on the trigger (e.g. while a handoff runs). */
  triggerText?: string;
  disabled?: boolean;
  /** What a key press on the trigger does (the start screen's agent chip: Enter opens the menu). */
  ariaKeyShortcuts?: string;
  onPick: (harnessId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { render: showMenu, leaving } = useLeave(open);
  const [active, setActive] = useState(-1);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const current = choices.find((c) => c.harness.id === currentId)?.harness;
  const enabled = (i: number) => choices[i] !== undefined && choices[i].blocked === null;
  const canOpen = !disabled && choices.length > 0;

  const close = (refocus: boolean) => {
    setOpen(false);
    setActive(-1);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(wrap, open, () => close(false));

  const show = () => {
    if (!canOpen) return;
    const selected = choices.findIndex((c) => c.harness.id === currentId);
    const first = choices.findIndex((c) => c.blocked === null);
    setActive(selected >= 0 && enabled(selected) ? selected : first);
    setOpen(true);
  };

  // Focus moves into the list as soon as it renders.
  useEffect(() => {
    if (open) list.current?.focus();
  }, [open]);

  const pick = (i: number) => {
    const choice = choices[i];
    if (!choice || choice.blocked !== null) return;
    close(true);
    onPick(choice.harness.id);
  };

  /** The next pickable option from `from` in `step` direction, wrapping. */
  const move = (from: number, step: 1 | -1): number => {
    for (let k = 1; k <= choices.length; k += 1) {
      const i = (from + step * k + choices.length * 2) % choices.length;
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

  // Keys that reach the trigger while the list is open (pressed before focus moved) act on the list.
  const onTriggerKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (open) return onListKey(e);
    if (!["ArrowDown", "ArrowUp"].includes(e.key)) return;
    e.preventDefault();
    show();
  };

  const name = triggerText ?? current?.displayName ?? currentId ?? "Choose a harness";
  return (
    <div className={`harness-menu-wrap is-${variant}`} ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className={variant === "row" ? "harness-row" : "pill-select harness-chip"}
        style={harnessColor(currentId ?? undefined)}
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={!canOpen}
        {...(ariaKeyShortcuts ? { "aria-keyshortcuts": ariaKeyShortcuts } : {})}
        onClick={() => (open ? close(false) : show())}
        onKeyDown={onTriggerKey}
      >
        {variant === "row" ? <span className="harness-dot" aria-hidden="true" /> : null}
        <span className="harness-row-name">{name}</span>
        {variant === "row" && current?.version ? (
          <span className="harness-row-meta" title={current.versionDetail ?? current.version}>
            {current.version}
          </span>
        ) : null}
        {/* The chip needs no chevron: its tint says it opens; the sidebar row keeps one. */}
        {variant === "row" ? <IconChevronDown size={12} /> : null}
      </button>
      {showMenu ? (
        <div
          ref={list}
          className={`harness-menu${leaving ? " is-leaving" : ""}`}
          role="listbox"
          tabIndex={-1}
          aria-label={menuLabel}
          aria-activedescendant={active >= 0 ? `${baseId}-${active}` : undefined}
          onKeyDown={onListKey}
        >
          <div className="harness-menu-head">{menuLabel}</div>
          {choices.map((c, i) => (
            <div
              key={c.harness.id}
              id={`${baseId}-${i}`}
              role="option"
              aria-label={c.harness.displayName}
              aria-selected={c.harness.id === currentId}
              aria-disabled={c.blocked !== null}
              className={`harness-option${i === active ? " is-active" : ""}${c.blocked !== null ? " is-blocked" : ""}`}
              style={harnessColor(c.harness.id)}
              title={c.blocked ?? c.note ?? c.harness.versionDetail ?? c.harness.version}
              onMouseMove={() => enabled(i) && setActive(i)}
              onClick={() => pick(i)}
            >
              <span className="harness-dot" aria-hidden="true" />
              <span className="harness-option-name">{c.harness.displayName}</span>
              <span className="harness-option-meta">{c.blocked ?? c.note ?? c.harness.version ?? ""}</span>
              {c.harness.id === currentId ? <IconCheck size={13} className="harness-option-check" /> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
