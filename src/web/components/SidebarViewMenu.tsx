// The sidebar's Recent / Projects choice belongs beside search, not inside Filters.
// Its two choices are a menu with roving keys; the trigger names the current view.
import { useRef, useState } from "react";
import { IconCheck, IconChevronDown } from "../icons.js";
import { useSidebarView } from "../sidebar-view.js";
import { useMenuKeys } from "../menu-focus.js";
import { useDismiss } from "../hooks.js";

export function SidebarViewMenu() {
  const root = useRef<HTMLSpanElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const [at, setAt] = useState<DOMRect | null>(null);
  const [view, setView] = useSidebarView();
  useDismiss(root, at !== null, () => setAt(null));
  const keys = useMenuKeys(menu, { open: at !== null, close: () => setAt(null), opener: button });
  const pick = (next: "recent" | "projects") => {
    setView(next);
    setAt(null);
    button.current?.focus();
  };
  return (
    <span className="sidebar-view-control" ref={root}>
      <button
        ref={button}
        type="button"
        className="view-switch"
        aria-label={`Sidebar view: ${view === "recent" ? "Recent" : "Projects"}`}
        aria-haspopup="menu"
        aria-expanded={at !== null}
        onClick={() => setAt(at ? null : button.current?.getBoundingClientRect() ?? null)}
      >
        <span>{view === "recent" ? "Recent" : "Projects"}</span>
        <IconChevronDown size={12} />
      </button>
      {at ? (
        <>
          <div className="menu-backdrop" onClick={() => setAt(null)} aria-hidden="true" />
          <ul
            ref={menu}
            className="menu-list view-menu"
            role="menu"
            aria-label="Sidebar view"
            style={{ top: at.bottom + 4, right: Math.max(8, window.innerWidth - at.right), left: "auto" }}
            onKeyDown={keys.onKeyDown}
          >
            {(["recent", "projects"] as const).map((option) => (
              <li key={option} role="none">
                <button type="button" role="menuitemradio" aria-checked={view === option} onClick={() => pick(option)}>
                  <span>{option === "recent" ? "Recent" : "Projects"}</span>
                  {view === option ? <IconCheck size={13} /> : <span className="view-menu-check" aria-hidden="true" />}
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </span>
  );
}
