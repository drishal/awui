// Ctrl+K / ⌘K: one search over the app's actions, the sessions of every
// project, the chat's models and thinking levels, harnesses, and themes.
// A modal <dialog> (focus stays inside, Escape closes) with combobox +
// listbox semantics, as the model picker.
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconCheck, IconSearch } from "../icons.js";
import { rankItems, type PaletteItem } from "../palette.js";

const PAGE = 8;

export function CommandPalette({ items, onClose }: { items: PaletteItem[]; onClose: () => void }) {
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
      </div>
    </dialog>
  );
}
