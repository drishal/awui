// The sidebar's hide menu, beside the quick chips: four toggles that take whole
// kinds of session out of the list (sleeping, on the default branch, started by
// a routine, started by an agent). Each shows how many it would hide, so an empty
// list is never a mystery. Pure state lives in sidebar-filter.ts; this draws it.
import { useRef, useState } from "react";
import { HIDE_GROUPS, HIDE_HINTS, HIDE_LABELS, type HideGroup } from "../sidebar-filter.js";

export function SidebarFilters({ hide, counts, onChange }: {
  hide: readonly HideGroup[];
  counts: Record<HideGroup, number>;
  onChange: (next: HideGroup[]) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const [at, setAt] = useState<DOMRect | null>(null);
  const toggle = (group: HideGroup) => onChange(hide.includes(group) ? hide.filter((g) => g !== group) : [...hide, group]);
  const clear = () => onChange([]);
  return (
    <>
      <button
        ref={button}
        type="button"
        className={`quick-chip filter-chip${hide.length > 0 ? " is-on" : ""}`}
        aria-expanded={at !== null}
        aria-haspopup="true"
        aria-label={hide.length > 0 ? `Filters, ${hide.length} hiding sessions` : "Filters"}
        title="Hide kinds of session"
        onClick={() => setAt(at ? null : (button.current?.getBoundingClientRect() ?? null))}
      >
        Filters{hide.length > 0 ? <span className="quick-count">{hide.length}</span> : null}
      </button>
      {at ? (
        <>
          <div className="menu-backdrop" onClick={() => setAt(null)} aria-hidden="true" />
          <div
            className="menu-list filter-menu"
            role="group"
            aria-label="Hide sessions"
            style={{ position: "fixed", top: at.bottom + 4, right: Math.max(8, window.innerWidth - at.right) }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setAt(null);
            }}
          >
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
        </>
      ) : null}
    </>
  );
}
