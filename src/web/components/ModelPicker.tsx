// Searchable model picker anchored to the composer's model pill (DeepSeek
// Harness's composer seat), with Hermes's "Current" line and OpenCode-style
// matching plus recents. Combobox + listbox semantics; on phones it opens as
// a bottom sheet.
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ModelInfo } from "../../shared/protocol.js";
import { useDismiss, useLeave } from "../hooks.js";
import { IconCheck, IconChevronDown, IconRefresh, IconSearch, Spinner } from "../icons.js";
import { groupModels, type ModelGroup } from "../model-search.js";
import { morphClip } from "../model-morph.js";
import { load, save } from "../storage.js";
import { Dot } from "./Dot.js";

const MAX_RECENT = 5;
/** Visible vertical band for a popover under `el`: the viewport cut by any clipping ancestor. */
export function clipBand(el: HTMLElement): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let p = el.parentElement; p; p = p.parentElement) {
    if (/(auto|scroll|hidden|clip)/.test(getComputedStyle(p).overflowY)) {
      const r = p.getBoundingClientRect();
      top = Math.max(top, r.top);
      bottom = Math.min(bottom, r.bottom);
    }
  }
  return { top, bottom };
}

function shortName(name: string): string {
  return name.length > 28 ? `${name.slice(0, 27)}…` : name;
}

/** A provider group's heading: its display name when it has one (Hermes's MoA), else the slug. */
function providerLabel(section: { provider: string; models: ModelInfo[] }): string {
  return section.models[0]?.providerName ?? section.provider;
}

export function ModelPicker({
  models,
  current,
  harnessId,
  disabled,
  onSelect,
  onRefresh,
  emptyLabel = "No model",
  triggerLabel,
  header,
  levels,
  thinking,
  onThinking,
}: {
  models: ModelInfo[];
  current: string | null;
  harnessId: string;
  disabled: boolean;
  onSelect: (key: string) => void;
  /** Re-read the harness's models (new local servers, catalogs, config edits). */
  onRefresh: () => Promise<void>;
  /** The chip's words with nothing picked yet (the start screen: the harness's own default). */
  emptyLabel?: string;
  /** Replaces the chip's words (Board's combined harness · model chip). */
  triggerLabel?: string;
  /** A row above the search (Board's harness chips): the caller switches catalogs from inside the picker. */
  header?: ReactNode;
  /** The thinking levels the harness exposes for the chosen model: a footer to pick one, never free text. */
  levels?: string[];
  thinking?: string;
  onThinking?: (level: string) => void;
}) {
  const [open, setOpen] = useState(false);
  // Closing furls the panel back into the chip for a moment before it goes (see .model-pop.is-leaving).
  const { render: showPop, leaving } = useLeave(open);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [place, setPlace] = useState<{ below: boolean; maxHeight: number }>({ below: false, maxHeight: 520 });
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const refreshButton = useRef<HTMLButtonElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const listId = useId();
  const recentKey = `recentModels.${harnessId}`;
  const currentModel = models.find((m) => m.key === current);
  // A virtual provider (MoA) needs its name here: its preset alone ("default") says nothing.
  const label = currentModel ? (currentModel.providerName ? `${currentModel.providerName} · ${currentModel.name}` : currentModel.name) : (current ?? emptyLabel);
  const chipLabel = triggerLabel ?? shortName(label);

  const sections = useMemo<Array<ModelGroup & { recent?: boolean }>>(() => {
    if (!showPop) return [];
    const groups = groupModels(models, query, current);
    if (query.trim()) return groups;
    const recent = load<string[]>(recentKey, [])
      .filter((k) => k !== current)
      .map((k) => models.find((m) => m.key === k))
      .filter((m): m is ModelInfo => m !== undefined)
      .slice(0, MAX_RECENT);
    return recent.length > 0 ? [{ provider: "Recent", models: recent, recent: true }, ...groups] : groups;
  }, [showPop, models, query, current, recentKey]);
  const flat = useMemo(() => sections.flatMap((s) => s.models), [sections]);

  const close = (refocus = true) => {
    if (!open) return;
    setQuery("");
    if (refocus) trigger.current?.focus();
    setOpen(false);
  };
  /** Open the picker, with `text` already typed into its search. */
  const openWith = (text: string) => {
    setQuery(text);
    setOpen(true);
  };

  const choose = (model: ModelInfo) => {
    const recent = [model.key, ...load<string[]>(recentKey, []).filter((k) => k !== model.key)].slice(0, 8);
    save(recentKey, recent);
    // The composer's chip closes on a pick; Board's combined chip stays open so the thinking
    // levels of the newly chosen model can be set in the same visit.
    if (onThinking === undefined) close();
    if (model.key !== current) onSelect(model.key);
  };

  // Place above the pill unless there is too little room; size to the space.
  useLayoutEffect(() => {
    if (!open || !trigger.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const band = clipBand(trigger.current);
    const above = rect.top - band.top - 16;
    const below = band.bottom - rect.bottom - 16;
    const useBelow = above < 280 && below > above;
    // Fit the side it opens on; never taller than the room (that would push it off-screen).
    setPlace({ below: useBelow, maxHeight: Math.max(120, Math.min(520, useBelow ? below : above)) });
    const start = flat.findIndex((m) => m.key === current);
    // Typed ahead, the first match is the one Enter takes; opened plain, the current model is.
    setActive(start >= 0 && !query ? start : 0);
    input.current?.focus();
    input.current?.setSelectionRange(query.length, query.length);
    // Runs only when the picker opens.
  }, [open]);

  const pop = useRef<HTMLDivElement>(null);
  // The measured morph (A8): once the panel mounts, uncover it from the chip's rect instead of the
  // keyframed corner. Phones keep the sheet's own motion, reduced motion stays still, and browsers
  // without the Web Animations API keep the CSS keyframes.
  useLayoutEffect(() => {
    if (!showPop || leaving) return;
    const panel = pop.current;
    const chip = trigger.current;
    if (!panel || !chip || typeof panel.animate !== "function") return;
    if (window.matchMedia?.("(pointer: coarse)").matches) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    panel.dataset.morph = "";
    const anim = panel.animate(
      [{ clipPath: morphClip(chip.getBoundingClientRect(), panel.getBoundingClientRect()), opacity: "0" }, { clipPath: "inset(-24px)", opacity: "1" }],
      { duration: 180, easing: getComputedStyle(panel).getPropertyValue("--ease-out") || "ease-out" },
    );
    return () => anim.cancel();
  }, [showPop, leaving]);

  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-opt-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listId]);

  // Escape closes from anywhere; the input's own Escape case runs first and
  // refocuses the trigger, then this idempotent close is a no-op.
  useDismiss(wrap, open, () => close(false), { escape: true });

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setActive((i) => Math.min(i + 1, flat.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((i) => Math.max(i - 1, 0));
        break;
      case "PageDown":
        e.preventDefault();
        setActive((i) => Math.min(i + 8, flat.length - 1));
        break;
      case "PageUp":
        e.preventDefault();
        setActive((i) => Math.max(i - 8, 0));
        break;
      case "Enter": {
        e.preventDefault();
        const model = flat[active];
        if (model) choose(model);
        break;
      }
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "Tab":
        // Tab reaches the refresh button; past it, the picker closes.
        if (!e.shiftKey && refreshButton.current && !refreshButton.current.disabled) {
          e.preventDefault();
          refreshButton.current.focus();
        } else close(false);
        break;
      default:
        break;
    }
  };

  let index = -1;
  return (
    <div className="model-picker" ref={wrap}>
      <button
        ref={trigger}
        type="button"
        className="pill-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={triggerLabel ? triggerLabel : `Model: ${label}`}
        title={currentModel ? `${currentModel.name} · ${currentModel.providerName ?? currentModel.provider}` : label}
        disabled={disabled || (models.length === 0 && header === undefined)}
        data-testid="model-picker"
        onClick={() => (open && !leaving ? close() : openWith(""))}
        onKeyDown={(e) => {
          // Type-ahead: a letter typed on the focused chip opens the list with it already searched.
          if (open || e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || e.key === " ") return;
          e.preventDefault();
          openWith(e.key);
        }}
      >
        <span className="pill-label">{chipLabel}</span>
        <IconChevronDown size={12} />
      </button>
      {showPop ? (
        <>
          <div className={`model-backdrop${leaving ? " is-leaving" : ""}`} aria-hidden="true" onClick={() => close(false)} />
          <div
            ref={pop}
            className={`model-pop${place.below ? " is-below" : ""}${leaving ? " is-leaving" : ""}`}
            role="dialog"
            aria-label="Choose a model"
            style={{ ["--pop-max-h" as string]: `${place.maxHeight}px` }}
          >
            {header}
            <div className="model-search">
              <IconSearch size={14} />
              <input
                ref={input}
                role="combobox"
                aria-expanded="true"
                aria-controls={listId}
                aria-autocomplete="list"
                aria-activedescendant={flat.length > 0 ? `${listId}-opt-${active}` : undefined}
                aria-label="Search models"
                placeholder="Search models"
                autoComplete="off"
                spellCheck={false}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onKeyDown}
              />
              <span className="model-count" aria-live="polite">
                {flat.length}
              </span>
              <button
                ref={refreshButton}
                type="button"
                className="icon-btn model-refresh"
                aria-label="Refresh models"
                title="Refresh models"
                disabled={refreshing}
                onClick={async () => {
                  setRefreshing(true);
                  try {
                    await onRefresh();
                  } finally {
                    setRefreshing(false);
                    input.current?.focus();
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.preventDefault();
                    close();
                  } else if (e.key === "Tab") {
                    if (e.shiftKey) {
                      e.preventDefault();
                      input.current?.focus();
                    } else close(false);
                  }
                }}
              >
                {refreshing ? <Spinner size={13} /> : <IconRefresh size={14} />}
              </button>
            </div>
            {currentModel ? (
              <div className="model-current">
                Current <strong>{currentModel.name}</strong>
                <Dot />
                {currentModel.providerName ?? currentModel.provider}
              </div>
            ) : null}
            <div className="model-list" id={listId} role="listbox" aria-label="Models">
              {sections.map((section) => (
                <div key={section.provider} role="group" aria-label={providerLabel(section)} className="model-group">
                  <div className="model-group-head" aria-hidden="true">
                    <span>{providerLabel(section)}</span>
                    <span>{section.models.length}</span>
                  </div>
                  {section.models.map((model) => {
                    index += 1;
                    const i = index;
                    return (
                      <div
                        key={`${section.provider}:${model.key}`}
                        id={`${listId}-opt-${i}`}
                        role="option"
                        aria-selected={i === active}
                        className={`model-option${i === active ? " is-active" : ""}${model.key === current ? " is-current" : ""}`}
                        onPointerMove={() => setActive(i)}
                        onClick={() => choose(model)}
                      >
                        <span className="model-name">{model.name}</span>
                        {model.name !== model.id ? <span className="model-id">{section.recent ? model.key : model.id}</span> : null}
                        {model.levels?.length ? (
                          // The strongest level; the harness lists them weakest first.
                          <span className="model-tag" title={`Reasoning: ${model.levels.join(", ")}`}>
                            {model.levels[model.levels.length - 1]}
                          </span>
                        ) : null}
                        <span className="model-check">{model.key === current ? <IconCheck size={13} /> : null}</span>
                      </div>
                    );
                  })}
                </div>
              ))}
              {flat.length === 0 ? <div className="model-empty">No models match “{query}”</div> : null}
            </div>
            {levels && levels.length > 0 && onThinking ? (
              <div className="model-thinking" role="group" aria-label="Thinking level">
                <span className="model-thinking-label">Thinking</span>
                <div className="board-thinking-chips">
                  <button type="button" className="board-level-chip" aria-pressed={!thinking} onClick={() => onThinking("")}>
                    Model default
                  </button>
                  {levels.map((level) => (
                    <button key={level} type="button" className="board-level-chip" aria-pressed={thinking === level} onClick={() => onThinking(level)}>
                      {level}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
