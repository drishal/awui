// The sidebar's filter disclosure: quick filters and the kinds of session to hide.
// Native Tab and radio keys keep their form semantics; view selection lives beside search.
import { useLayoutEffect, useRef, useState } from "react";
import { HIDE_GROUPS, HIDE_HINTS, HIDE_LABELS, QUICK_FILTERS, QUICK_LABELS, type HideGroup, type QuickFilter } from "../sidebar-filter.js";
import { IconFilter, IconPlus, IconRefresh } from "../icons.js";
import { useSidebarView } from "../sidebar-view.js";
export function SidebarFilters({ quick, quickCounts, onQuickChange, hide, counts, onChange, onRefresh, onNewRoom, roomsAvailable }: {
  quick: QuickFilter | null;
  quickCounts: Record<QuickFilter, number>;
  onQuickChange: (next: QuickFilter | null) => void;
  hide: readonly HideGroup[];
  counts: Record<HideGroup, number>;
  onChange: (next: HideGroup[]) => void;
  onRefresh: () => void;
  onNewRoom: () => void;
  roomsAvailable: boolean;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<DOMRect | null>(null);
  const [view, setView] = useSidebarView();
  const active = hide.length + (quick ? 1 : 0);
  const toggle = (group: HideGroup) => onChange(hide.includes(group) ? hide.filter((g) => g !== group) : [...hide, group]);
  const clear = () => onChange([]);
  // Register before Sidebar's effect: a child's Escape dismisses only this popover, never its drawer parent.
  useLayoutEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || at === null) return;
      e.preventDefault();
      e.stopPropagation();
      setAt(null);
      button.current?.focus();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [at]);
  return (
    <span ref={root} className="filter-control">
      <button
        ref={button}
        type="button"
        className={`filter-chip${active > 0 ? " is-on" : ""}`}
        aria-expanded={at !== null}
        aria-haspopup="dialog"
        aria-label={hide.length > 0 && !quick ? `Filters, ${hide.length} hiding sessions` : active > 0 ? `Filters, ${active} active ${active === 1 ? "filter" : "filters"}` : "Filters"}
        title="Filter sessions"
        onClick={() => {
          if (at) return setAt(null);
          // The popover is wider than the chip and must end inside the rail: it hangs from the search
          // field's own left edge (clamped into the viewport) rather than from the chip, whose right
          // edge would push it off the screen's left.
          const field = button.current?.closest(".search-field")?.getBoundingClientRect() ?? button.current?.getBoundingClientRect();
          setAt(field ?? null);
        }}
      >
        <IconFilter size={14} />
        {active > 0 ? <span className="filter-dot" aria-hidden="true" /> : null}
      </button>
      {at ? (
        <>
          <div className="menu-backdrop" onClick={() => setAt(null)} aria-hidden="true" />
          <div
            ref={menu}
            className="menu-list filter-menu"
            role="dialog"
            aria-label="Filters"
            style={{ position: "fixed", top: at.bottom + 4, left: Math.max(8, at.left) }}
          >
            <div className="filter-view" role="radiogroup" aria-label="View">
              <span className="filter-heading">View</span>
              {(["recent", "projects"] as const).map((option) => (
                <label key={option} className="filter-row">
                  <input type="radio" name="sidebar-view" checked={view === option} onChange={() => setView(option)} />
                  <span className="filter-label">{option === "recent" ? "Recent" : "Projects"}</span>
                </label>
              ))}
            </div>
            <div className="filter-quick" role="radiogroup" aria-label="Show">
              <span className="filter-heading">Show</span>
              {QUICK_FILTERS.map((filter) => (
                <label key={filter} className="filter-row" data-count={quickCounts[filter]}>
                  <input type="radio" name="sidebar-quick-filter" checked={quick === filter} onClick={(e) => { if (quick === filter) { e.preventDefault(); onQuickChange(null); } }} onChange={(e) => onQuickChange(e.currentTarget.checked ? filter : null)} />
                  <span className="filter-label">{QUICK_LABELS[filter]}</span>
                  <span className="filter-count">{quickCounts[filter]}</span>
                </label>
              ))}
            </div>
            <div className="filter-hide" role="group" aria-label="Hide sessions">
              <div className="filter-heading-row">
                <span className="filter-heading">Hide</span>
                {/* A quiet text action, and only while there is something to undo: an always-present
                    "✓ Show everything" read as a checked option. */}
                {hide.length > 0 ? (
                  <button type="button" className="filter-reset" onClick={clear}>
                    Reset
                  </button>
                ) : null}
              </div>
              {HIDE_GROUPS.map((group) => (
                <label key={group} className="filter-row" data-count={counts[group]} title={HIDE_HINTS[group]}>
                  <input type="checkbox" checked={hide.includes(group)} onChange={() => toggle(group)} aria-describedby={`filter-hint-${group}`} />
                  <span className="filter-label">{HIDE_LABELS[group]}</span>
                  <span className="filter-count">{counts[group]}</span>
                </label>
              ))}
              {/* What each toggle takes out, on hover (the label's title) and to a screen reader. The
                  hidden spans live outside the labels: inside one, Chromium folds the description into
                  the control's accessible name. */}
              {HIDE_GROUPS.map((group) => (
                <span key={group} id={`filter-hint-${group}`} className="visually-hidden">
                  {HIDE_HINTS[group]}
                </span>
              ))}
            </div>
            <div className="filter-actions">
              <span className="filter-heading">List actions</span>
              <button type="button" disabled={!roomsAvailable} onClick={() => { setAt(null); onNewRoom(); }}>
                <IconPlus size={14} /> New room
              </button>
              <button type="button" onClick={() => { setAt(null); onRefresh(); }}>
                <IconRefresh size={14} /> Refresh sessions
              </button>
            </div>
          </div>
        </>
      ) : null}
    </span>
  );
}
