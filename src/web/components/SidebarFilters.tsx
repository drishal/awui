// The sidebar's one filter disclosure: the list view, one optional quick filter,
// and the kinds of session to hide. Counts explain each choice before it is made.
// Filter logic lives in sidebar-filter.ts; this owns only the popover and its state.
import { useEffect, useRef, useState } from "react";
import { HIDE_GROUPS, HIDE_HINTS, HIDE_LABELS, QUICK_FILTERS, QUICK_LABELS, type HideGroup, type QuickFilter } from "../sidebar-filter.js";
import { IconFilter, IconPlus, IconRefresh } from "../icons.js";
import { useSidebarView } from "../sidebar-view.js";
import { useMenuKeys } from "../menu-focus.js";

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
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<DOMRect | null>(null);
  const [view, setView] = useSidebarView();
  const active = hide.length + (quick ? 1 : 0);
  // Escape closes it from anywhere (its trigger included) and puts the focus back on the trigger; the
  // arrows walk its rows, which are one tab stop.
  const keys = useMenuKeys(menu, { open: at !== null, close: () => setAt(null), opener: button });
  const toggle = (group: HideGroup) => onChange(hide.includes(group) ? hide.filter((g) => g !== group) : [...hide, group]);
  const clear = () => onChange([]);
  useEffect(() => {
    if (!at) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setAt(null);
      button.current?.focus();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [at]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`filter-chip${active > 0 ? " is-on" : ""}`}
        aria-expanded={at !== null}
        aria-haspopup="true"
        aria-label={hide.length > 0 && !quick ? `Filters, ${hide.length} hiding sessions` : active > 0 ? `Filters, ${active} active ${active === 1 ? "filter" : "filters"}` : "Filters"}
        title="Filter sessions and choose a view"
        onClick={() => setAt(at ? null : (button.current?.getBoundingClientRect() ?? null))}
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
            role="group"
            aria-label="Filter sessions"
            style={{ position: "fixed", top: at.bottom + 4, right: Math.max(8, window.innerWidth - at.right) }}
            onKeyDown={keys.onKeyDown}
          >
            <div className="filter-view" role="group" aria-label="Sidebar view">
              <span className="filter-heading">View</span>
              <span className="view-segment">
                {(["recent", "projects"] as const).map((option) => (
                  <button key={option} type="button" aria-pressed={view === option} onClick={() => setView(option)}>
                    {option === "recent" ? "Recent" : "Projects"}
                  </button>
                ))}
              </span>
            </div>
            <div className="filter-quick" role="radiogroup" aria-label="Show">
              <span className="filter-heading">Show</span>
              {QUICK_FILTERS.map((filter) => (
                <label key={filter} className="filter-row">
                  <input type="radio" name="sidebar-quick-filter" checked={quick === filter} onClick={(e) => { if (quick === filter) { e.preventDefault(); onQuickChange(null); } }} onChange={(e) => onQuickChange(e.currentTarget.checked ? filter : null)} />
                  <span className="filter-label">{QUICK_LABELS[filter]}</span>
                  <span className="filter-count">{quickCounts[filter]}</span>
                </label>
              ))}
            </div>
            <div className="filter-hide" role="group" aria-label="Hide sessions">
              <span className="filter-heading">Hide</span>
              {HIDE_GROUPS.map((group) => (
                <label key={group} className="filter-row" title={HIDE_HINTS[group]}>
                  <input type="checkbox" checked={hide.includes(group)} onChange={() => toggle(group)} />
                  <span className="filter-label">{HIDE_LABELS[group]}</span>
                  <span className="filter-count">{counts[group]}</span>
                </label>
              ))}
              <button type="button" className="filter-clear" disabled={hide.length === 0} onClick={clear}>
                Show everything
              </button>
            </div>
            <div className="filter-actions">
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
    </>
  );
}
