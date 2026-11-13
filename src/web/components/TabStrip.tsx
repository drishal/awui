// Session tabs above the conversation (Hermes Desktop's): one per open chat or
// Board room, harness-coloured for a chat, a working ring while it runs and a
// dot when a run finished out of sight. Closing a tab only hides it; the chat
// keeps running on the server. Keys: ←/→ (Home/End) move, Alt+Shift+←/→ reorder,
// Enter opens, Delete closes. The browser owns Ctrl+T/W/Tab, so the strip claims
// none of them.
// A tab drags sideways to reorder (pointer events, so touch works too; a few px of
// slack keep a click a click) and pins from its right-click menu: a pinned tab sits
// at the left, narrow, with no ✕, and survives Delete and middle-click. The drag
// stays inside its group (tab-order.ts); the lifted tab follows the pointer and the
// others slide aside by transform, so nothing moves in the DOM until the drop.
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { ChatStatus } from "../../shared/protocol.js";
import { harnessColor } from "../harness-colors.js";
import { IconPin, IconPlus, IconRooms, IconX } from "../icons.js";
import { isWorking } from "../session-groups.js";
import { clampDrag, dropSlot, slideOf, type TabRect } from "../tab-order.js";
import type { Tab } from "../tabs.js";
import { SlidingIndicator } from "./SlidingIndicator.js";
import { WorkingRing } from "./WorkingRing.js";
import { plainTitle } from "../plain-title.js";

export function TabStrip({
  tabs,
  active,
  statusOf,
  harnessName,
  onActivate,
  onClose,
  onMove,
  onPin,
  onNew,
  newDisabled,
}: {
  tabs: Tab[];
  active: number;
  /** A tab's chat status, when the server holds its chat. */
  statusOf: (tab: Tab) => ChatStatus | null;
  harnessName: (id: string) => string;
  onActivate: (index: number) => void;
  onClose: (index: number) => void;
  /** Reorder: the tab at `from` goes to `to` (kept inside its pinned or unpinned group). */
  onMove: (from: number, to: number) => void;
  onPin: (index: number, pinned: boolean) => void;
  onNew: () => void;
  newDisabled: boolean;
}) {
  const strip = useRef<HTMLDivElement>(null);
  /** A drag in progress: the lifted tab, how far the pointer took it, and the slot it would drop into, and its width (how far the others slide). */
  const [drag, setDrag] = useState<{ from: number; dx: number; to: number; width: number } | null>(null);
  const press = useRef<{ id: number; x: number; from: number; rects: TabRect[]; started: boolean } | null>(null);
  const swallowClick = useRef(false);
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null);
  /** The tab to focus once the list has been redrawn: a reorder moves its element, which drops focus. */
  const refocus = useRef<string | null>(null);
  /** Reorder or pin, and keep the focus on that tab (a no-op leaves no focus request behind). */
  const act = (key: string, run: () => void) => {
    refocus.current = key;
    run();
    setTimeout(() => (refocus.current = null), 0);
  };

  useLayoutEffect(() => {
    if (refocus.current === null) return;
    const el = Array.from(strip.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? []).find((t) => t.dataset.tabKey === refocus.current);
    refocus.current = null;
    el?.focus();
  }, [tabs]);

  // Keep the shown tab in view when the strip overflows.
  useEffect(() => {
    strip.current?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [active, tabs.length]);

  const focusTab = (i: number) => strip.current?.querySelectorAll<HTMLElement>('[role="tab"]')[i]?.focus();

  const onKey = (e: KeyboardEvent<HTMLDivElement>, i: number) => {
    const last = tabs.length - 1;
    const tab = tabs[i];
    const go = (j: number) => {
      e.preventDefault();
      focusTab(j);
    };
    if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && (e.key === "ArrowRight" || e.key === "ArrowLeft") && tab) {
      e.preventDefault();
      act(tab.key, () => onMove(i, i + (e.key === "ArrowRight" ? 1 : -1)));
    } else if (e.key === "Escape" && press.current?.started) {
      // Let go of a drag without dropping it.
      e.preventDefault();
      press.current = null;
      setDrag(null);
    } else if (e.key === "ArrowRight") go(i === last ? 0 : i + 1);
    else if (e.key === "ArrowLeft") go(i === 0 ? last : i - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(last);
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onActivate(i);
    } else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      // A pinned tab stays until it is unpinned.
      if (tab?.pinned) return;
      onClose(i);
      focusTab(Math.min(i, last - 1));
    }
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>, i: number) => {
    swallowClick.current = false;
    if (e.button !== 0 || (e.target as HTMLElement).closest(".session-tab-close")) return;
    const rects = Array.from(strip.current?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [], (t) => {
      const r = t.getBoundingClientRect();
      return { left: r.left, width: r.width };
    });
    press.current = { id: e.pointerId, x: e.clientX, from: i, rects, started: false };
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    if (!p.started) {
      if (Math.abs(e.clientX - p.x) < 5) return;
      p.started = true;
      e.currentTarget.setPointerCapture(e.pointerId);
    }
    const dx = clampDrag(tabs, p.rects, p.from, e.clientX - p.x);
    setDrag({ from: p.from, dx, to: dropSlot(tabs, p.rects, p.from, dx), width: p.rects[p.from]?.width ?? 0 });
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const p = press.current;
    if (!p || p.id !== e.pointerId) return;
    press.current = null;
    if (!p.started) return;
    // The click that follows a drag's release is not a click on the tab.
    swallowClick.current = true;
    const tab = tabs[p.from];
    setDrag(null);
    if (drag && tab && drag.to !== p.from) act(tab.key, () => onMove(p.from, drag.to));
  };

  const onPointerCancel = (e: PointerEvent<HTMLDivElement>) => {
    if (press.current?.id !== e.pointerId) return;
    press.current = null;
    setDrag(null);
  };

  const menuTab = menu ? tabs.findIndex((t) => t.key === menu.key) : -1;
  const closeMenu = (focusKey?: string) => {
    setMenu(null);
    if (focusKey) strip.current?.querySelector<HTMLElement>(`[data-tab-key="${focusKey}"]`)?.focus();
  };

  return (
    <div className="tab-strip">
      <div className={`tab-list${drag ? " is-dragging" : ""}`} role="tablist" aria-label="Open tabs" ref={strip}>
        {tabs.map((tab, i) => {
          const status = statusOf(tab);
          const working = isWorking(status);
          const selected = i === active;
          const name = harnessName(tab.harnessId);
          // A room's tab says "Room" where a chat's names its harness.
          const kind = tab.roomId ? "Room" : name;
          // The lifted tab goes where the pointer took it; the ones it passes slide a tab's width aside.
          const lifted = drag !== null && drag.from === i;
          const shift = !drag ? 0 : lifted ? drag.dx : slideOf(i, drag.from, drag.to) * drag.width;
          return (
            <div
              key={tab.key}
              role="tab"
              data-tab-index={i}
              data-tab-key={tab.key}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={`session-tab${selected ? " is-active" : ""}${tab.unread ? " is-unread" : ""}${tab.pinned ? " is-pinned" : ""}${tab.roomId ? " session-tab-room" : ""}${lifted ? " is-lifted" : ""}`}
              style={{ ...harnessColor(tab.harnessId), ...(shift !== 0 ? { transform: `translateX(${shift}px)` } : {}) }}
              title={`${plainTitle(tab.title)} · ${kind}${tab.pinned ? " · pinned" : ""}`}
              onClick={() => {
                if (swallowClick.current) swallowClick.current = false;
                else onActivate(i);
              }}
              onMouseDown={(e) => {
                // Middle-click closes; stop the browser's autoscroll from starting.
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                if (!tab.pinned) onClose(i);
              }}
              onPointerDown={(e) => onPointerDown(e, i)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onContextMenu={(e) => {
                e.preventDefault();
                // A key press (the menu key, Shift+F10) arrives without a pointer position: open under the tab.
                const r = e.currentTarget.getBoundingClientRect();
                const keyed = e.clientX === 0 && e.clientY === 0;
                setMenu({ key: tab.key, x: keyed ? r.left : e.clientX, y: keyed ? r.bottom : e.clientY });
              }}
              onKeyDown={(e) => onKey(e, i)}
            >
              {tab.roomId ? (
                <IconRooms size={13} className="session-tab-room-icon" />
              ) : working ? (
                <WorkingRing harnessId={tab.harnessId} colored />
              ) : (
                <span className="harness-dot" role="img" aria-label={name} />
              )}
              <span className="session-tab-title">{plainTitle(tab.title)}</span>
              {tab.unread ? <span className="session-tab-unread" role="img" aria-label="Finished while away" /> : null}
              {tab.pinned ? null : (
                <button
                  type="button"
                  className="session-tab-close"
                  aria-label={`Close ${tab.title}`}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onClose(i);
                  }}
                >
                  <IconX size={12} />
                </button>
              )}
            </div>
          );
        })}
        {/* The active tab's underline glides to it; a drag pins it to the lifted tab. */}
        <SlidingIndicator target={strip} active={drag ? drag.from : active} of=".session-tab" className="tab-active-line" />
      </div>
      <button type="button" className="icon-btn tab-new" aria-label="New chat in a new tab" title="New chat in a new tab" disabled={newDisabled} onClick={onNew}>
        <IconPlus size={14} />
      </button>
      {menu && menuTab >= 0 ? (
        <>
          <div
            className="menu-backdrop"
            onClick={() => closeMenu()}
            onContextMenu={(e) => {
              e.preventDefault();
              closeMenu();
            }}
            aria-hidden="true"
          />
          <ul
            className="menu-list row-menu tab-menu"
            role="menu"
            aria-label={`Tab ${tabs[menuTab]?.title ?? ""}`}
            style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 220)), top: Math.min(menu.y + 4, window.innerHeight - 100), right: "auto" }}
            onKeyDown={(e) => e.key === "Escape" && closeMenu(menu.key)}
          >
            <li role="none">
              <button
                type="button"
                role="menuitem"
                autoFocus
                onClick={() => {
                  act(menu.key, () => onPin(menuTab, !tabs[menuTab]?.pinned));
                  closeMenu(menu.key);
                }}
              >
                <IconPin size={14} /> {tabs[menuTab]?.pinned ? "Unpin tab" : "Pin tab"}
              </button>
            </li>
            {tabs[menuTab]?.pinned ? null : (
              <li role="none">
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    closeMenu();
                    onClose(menuTab);
                  }}
                >
                  <IconX size={14} /> Close tab
                </button>
              </li>
            )}
          </ul>
        </>
      ) : null}
    </div>
  );
}
