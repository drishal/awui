// The theme button beside Settings: a menu of every theme with its swatch,
// System, Light, and Dark first. Pointing at one (hover, or the arrow keys)
// previews it on the whole page; leaving, Escape, or closing puts the current
// one back, and choosing saves it for every device (config.yml). "Manage
// themes…" opens Settings, where themes are added, edited, and removed.
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useDismiss, useLeave } from "../hooks.js";
import { IconCheck, IconPalette } from "../icons.js";
import { endPreview, previewTheme } from "../theme.js";
import { optionLook, type ThemeOption } from "../themes.js";
import { ThemeSwatch } from "./ThemeSwatch.js";

export function ThemeMenu({
  options,
  current,
  onOpen,
  onChoose,
  onManage,
}: {
  options: ThemeOption[];
  current: string;
  /** The menu opened: read the library again, so a theme added on another device shows. */
  onOpen: () => void;
  onChoose: (option: ThemeOption) => void;
  onManage: () => void;
}) {
  const [open, setOpen] = useState(false);
  const { render: showPop, leaving } = useLeave(open);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  /** Wide screens: where the menu goes, fixed to the viewport, since the sidebar clips what leaves it. Phones use the sheet. */
  const [place, setPlace] = useState<CSSProperties | undefined>(undefined);
  const builtins = options.filter((o) => !o.entry);
  const schemes = options.filter((o) => o.entry);
  const ordered = [...builtins, ...schemes];

  const close = (refocus = true) => {
    endPreview();
    setOpen(false);
    if (refocus) trigger.current?.focus();
  };
  useDismiss(wrap, open, () => close(false), { escape: true });
  // A menu unmounted mid-preview (the sidebar folding away) must not leave the page painted.
  useEffect(() => () => endPreview(), []);

  useLayoutEffect(() => {
    if (!open) return;
    const rect = trigger.current?.getBoundingClientRect();
    const sheet = window.matchMedia("(max-width: 819px)").matches;
    const width = Math.min(300, window.innerWidth - 24);
    setPlace(rect && !sheet ? { position: "fixed", top: rect.bottom + 8, left: Math.max(12, Math.min(rect.left - 8, window.innerWidth - width - 12)), right: "auto", bottom: "auto", maxHeight: window.innerHeight - rect.bottom - 24 } : undefined);
    const at = Math.max(0, ordered.findIndex((o) => o.key === current));
    setActive(at);
    list.current?.querySelector<HTMLElement>(`[data-index="${at}"]`)?.focus();
    // Runs only when the menu opens.
  }, [open]);

  const point = (i: number) => {
    const option = ordered[i];
    if (!option) return;
    setActive(i);
    const look = optionLook(option);
    previewTheme(look.mode, look.info);
  };
  const choose = (option: ThemeOption) => {
    onChoose(option);
    setOpen(false);
    trigger.current?.focus();
  };
  const focusRow = (i: number) => {
    list.current?.querySelector<HTMLElement>(`[data-index="${i}"]`)?.focus();
    point(i);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const last = ordered.length - 1;
    const keys: Record<string, () => void> = {
      ArrowDown: () => focusRow(Math.min(last, active + 1)),
      ArrowUp: () => focusRow(Math.max(0, active - 1)),
      Home: () => focusRow(0),
      End: () => focusRow(last),
    };
    if (e.key === "Tab") return close(false);
    const action = keys[e.key];
    if (!action) return;
    e.preventDefault();
    action();
  };

  const currentName = ordered.find((o) => o.key === current)?.label ?? "System";
  const row = (option: ThemeOption, i: number) => (
    <button
      key={option.key}
      type="button"
      role="menuitemradio"
      aria-checked={option.key === current}
      data-index={i}
      tabIndex={i === active ? 0 : -1}
      className={`model-option theme-option${i === active ? " is-active" : ""}${option.key === current ? " is-current" : ""}`}
      onPointerEnter={() => point(i)}
      onFocus={() => i !== active && point(i)}
      onClick={() => choose(option)}
    >
      <ThemeSwatch option={option} size="sm" />
      <span className="theme-option-name">{option.label}</span>
      {option.note ? <span className="theme-option-note">{option.note}</span> : null}
      {option.key === current ? <IconCheck size={14} className="palette-check" /> : null}
    </button>
  );

  return (
    <div className="theme-menu" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="icon-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Theme: ${currentName}`}
        title="Theme"
        onClick={() => {
          if (open) return close();
          onOpen();
          setOpen(true);
        }}
      >
        <IconPalette size={16} />
      </button>
      {/* Phones: the menu is a bottom sheet over a backdrop, as the model picker's. */}
      {showPop ? <div className="model-backdrop" aria-hidden="true" onClick={() => close(false)} /> : null}
      {showPop ? (
        <div className={`model-pop is-below theme-pop${leaving ? " is-leaving" : ""}`} style={place}>
          {/* Leaving the list (not one row for the next) puts the current theme back. */}
          <div ref={list} className="model-list theme-list" role="menu" aria-label="Theme" onKeyDown={onKeyDown} onPointerLeave={() => endPreview()}>
            <div className="model-group-head" role="presentation">
              Theme
            </div>
            {builtins.map((o, i) => row(o, i))}
            {schemes.length > 0 ? (
              <div className="model-group-head" role="presentation">
                Schemes
              </div>
            ) : null}
            {schemes.map((o, i) => row(o, builtins.length + i))}
          </div>
          <button
            type="button"
            className="theme-manage"
            onClick={() => {
              close(false);
              onManage();
            }}
          >
            Manage themes…
          </button>
        </div>
      ) : null}
    </div>
  );
}
