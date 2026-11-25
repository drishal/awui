// Ctrl+K / ⌘K: one search over the app's actions, the sessions of every
// project, the chat's models and thinking levels, harnesses, and themes, in
// three sections (the chat, its work, the app). A modal <dialog> (focus stays
// inside, Escape closes) with combobox + listbox semantics, as the model picker.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  IconAgents, IconBranch, IconChat, IconCheck, IconChevronLeft, IconChevronRight, IconClock, IconDownload, IconEdit,
  IconFile, IconFilter, IconFork, IconGauge, IconGlobe, IconLink, IconMenu, IconNewTab, IconPalette, IconPin, IconPlan,
  IconPlus, IconQueue, IconRefresh, IconScreen, IconSearch, IconSettings, IconShield, IconSidebar, IconSplit, IconSpark,
  IconStash, IconStop, IconSwap, IconTerminal, IconTool, IconUndo, IconX,
} from "../icons.js";
import { rankItems, type PaletteItem } from "../palette.js";

const PAGE = 8;

/**
 * What each row is, by the item's id. A palette row is a word plus its key, so without a glyph fifteen
 * rows of equal weight read as one list; the leading 16px slot says which kind of thing a row is. Items
 * that draw their own mark (a theme's swatch) keep it.
 */
const ICONS: Record<string, ReactNode> = {
  new: <IconPlus size={16} />,
  "new-tab": <IconNewTab size={16} />,
  stop: <IconStop size={16} />,
  rename: <IconEdit size={16} />,
  "chat-link": <IconLink size={16} />,
  compact: <IconQueue size={16} />,
  restart: <IconSwap size={16} />,
  review: <IconFile size={16} />,
  timeline: <IconClock size={16} />,
  export: <IconDownload size={16} />,
  close: <IconX size={16} />,
  beside: <IconSplit size={16} />,
  "worker-plan": <IconPlan size={16} />,
  worktrees: <IconBranch size={16} />,
  terminal: <IconTerminal size={16} />,
  github: <IconFork size={16} />,
  compare: <IconSwap size={16} />,
  races: <IconSplit size={16} />,
  "open-file": <IconFile size={16} />,
  search: <IconSearch size={16} />,
  "search-all": <IconChat size={16} />,
  folder: <IconFilter size={16} />,
  prompts: <IconStash size={16} />,
  routines: <IconClock size={16} />,
  dashboard: <IconAgents size={16} />,
  usage: <IconGauge size={16} />,
  settings: <IconSettings size={16} />,
  shortcuts: <IconMenu size={16} />,
  sidebar: <IconSidebar size={16} />,
  back: <IconChevronLeft size={16} />,
  forward: <IconChevronRight size={16} />,
  reopen: <IconUndo size={16} />,
  "undo-mark": <IconUndo size={16} />,
  find: <IconSearch size={16} />,
  "pin-tab": <IconPin size={16} />,
  "reload-app": <IconRefresh size={16} />,
  pair: <IconScreen size={16} />,
  "theme:manage": <IconPalette size={16} />,
};

/** The list's ids the map does not name one by one: a session, a model, a level, a mode, a harness. */
function iconFor(id: string): ReactNode {
  const fixed = ICONS[id];
  if (fixed) return fixed;
  if (id.startsWith("s:")) return <IconChat size={16} />;
  if (id.startsWith("m:")) return <IconSpark size={16} />;
  if (id.startsWith("t:")) return <IconQueue size={16} />;
  if (id.startsWith("p:")) return <IconShield size={16} />;
  if (id.startsWith("h:")) return <IconAgents size={16} />;
  if (id.startsWith("theme:")) return <IconPalette size={16} />;
  return null;
}

export function CommandPalette({ items, onClose, onPreviewEnd }: { items: PaletteItem[]; onClose: () => void; /** Undo what a highlighted item's `preview` showed. */ onPreviewEnd?: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const shown = useMemo(() => rankItems(items, query), [items, query]);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);

  useEffect(() => {
    const first = shown.findIndex((i) => !i.disabled);
    setActive(first < 0 ? 0 : first);
  }, [shown]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // A highlighted theme shows on the page; moving off it, or closing without choosing, puts the old one back.
  const previewed = useRef(false);
  const highlighted = shown[active];
  useEffect(() => {
    if (highlighted?.preview && !highlighted.disabled) {
      highlighted.preview();
      previewed.current = true;
    } else if (previewed.current) {
      previewed.current = false;
      onPreviewEnd?.();
    }
  }, [highlighted]);
  useEffect(() => () => void (previewed.current && onPreviewEnd?.()), []);

  const run = (item: PaletteItem | undefined) => {
    if (!item || item.disabled) return;
    onClose();
    item.run();
  };

  /** The next enabled row `step` rows away, stopping at the ends. */
  const move = (step: number) => {
    if (shown.length === 0) return;
    let i = active;
    for (let n = 0; n < Math.abs(step); n++) {
      let next = i;
      do next += Math.sign(step);
      while (next >= 0 && next < shown.length && shown[next]?.disabled);
      if (next < 0 || next >= shown.length) break;
      i = next;
    }
    setActive(i);
  };

  return (
    <dialog
      ref={ref}
      className="palette"
      aria-label="Commands"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="palette-body">
        <label className="model-search palette-search">
          <IconSearch size={15} />
          <input
            autoFocus
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={shown[active] ? `${listId}-${active}` : undefined}
            aria-label="Search commands and sessions"
            placeholder="Search commands, sessions, models…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              const step = { ArrowDown: 1, ArrowUp: -1, PageDown: PAGE, PageUp: -PAGE }[e.key];
              if (step !== undefined) {
                e.preventDefault();
                move(step);
              } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                // The row pointer is reset to the first match by an effect, so a query
                // typed a moment before Enter can still point past the shorter list:
                // run its first row rather than nothing at all.
                run(shown[active] ?? shown.find((item) => !item.disabled));
              }
            }}
          />
          <kbd className="palette-kbd">Esc</kbd>
        </label>
        <ul ref={listRef} id={listId} className="palette-list" role="listbox" aria-label="Results">
          {shown.map((item, i) => {
            const head = i === 0 || shown[i - 1]?.section !== item.section;
            return (
              <li key={item.id} role="presentation">
                {head ? (
                  <div className="model-group-head" role="presentation">
                    {item.section}
                  </div>
                ) : null}
                <div
                  id={`${listId}-${i}`}
                  data-index={i}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={item.disabled ? true : undefined}
                  title={item.disabled}
                  className={`model-option palette-option${i === active ? " is-active" : ""}${item.disabled ? " is-disabled" : ""}`}
                  onPointerMove={() => !item.disabled && i !== active && setActive(i)}
                  onClick={() => run(item)}
                >
                  <span className="palette-icon" aria-hidden="true">{item.icon ?? iconFor(item.id)}</span>
                  {/* Label and detail share one baseline: centred on their own, the smaller detail rode high. */}
                  <span className="palette-text">
                    <span className="palette-label">{item.label}</span>
                    {item.hint && !item.keys ? <span className="palette-hint">{item.hint}</span> : null}
                  </span>
                  {item.hint && item.keys ? (
                    <span className="palette-keys">
                      {item.hint.split(/(?<=.)\+(?=.)/).map((key, k) => (
                        <kbd key={k}>{key}</kbd>
                      ))}
                    </span>
                  ) : null}
                  {item.current ? <IconCheck size={14} className="palette-check" /> : null}
                </div>
              </li>
            );
          })}
          {shown.length === 0 ? <li className="palette-empty">Nothing matches “{query.trim()}”</li> : null}
        </ul>
        <footer className="palette-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> run</span>
          <span><kbd>esc</kbd> close</span>
        </footer>
      </div>
    </dialog>
  );
}
