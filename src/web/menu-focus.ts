// Keyboard support for the sidebar's action menus (a row's ⋯ menu, the view and project switches, and the rail peek).
// Menu items rove with ↑/↓ and Home/End; Escape returns focus to the opener. Filter dialogs keep native form keys.
import { useLayoutEffect, useRef, type KeyboardEvent, type RefObject } from "react";
import { useDismiss } from "./hooks.js";
import { focusables } from "./focus-trap.js";

/**
 * Where an arrow (or Home/End) moves inside a menu of `count` items, from `index`; null for any other key.
 * `index` may be -1 (nothing focused yet): ↓ starts at the first item, ↑ at the last. A menu wraps at its
 * ends; a list that `wrap`s nothing clamps instead.
 */
export function menuStep(key: string, index: number, count: number, wrap = true): number | null {
  if (count <= 0) return null;
  const at = index < 0 ? null : index;
  switch (key) {
    case "ArrowDown":
      if (at === null) return 0;
      return wrap ? (at + 1) % count : Math.min(at + 1, count - 1);
    case "ArrowUp":
      if (at === null) return count - 1;
      return wrap ? (at - 1 + count) % count : Math.max(at - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/** One of the items is the menu's tab stop; the rest are reached with the arrows. */
function rove(items: readonly HTMLElement[], to: HTMLElement | undefined): void {
  for (const el of items) el.tabIndex = el === to ? 0 : -1;
}

export interface MenuKeys {
  /** The menu's own keydown: arrows, Home/End, and nothing else (Escape is the document's, see below). */
  onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  /** Close it and return the focus to whatever opened it. */
  leave: () => void;
}

/** What a menu hands its own keyboard binding. */
export interface MenuBinding {
  /** Whether the menu is open: shut, it binds nothing, so Escape stays the page's. */
  open: boolean;
  /** Close it (the caller's own state). */
  close: () => void;
  /** The button that opened it: where Escape hands the focus back. */
  opener?: { readonly current: HTMLElement | null };
  /** Re-reads the items when the menu's own contents change (a fold opening) without moving the focus. */
  version?: number;
}

/**
 * Bind a menu to the keyboard while it is open: focus its first item, keep exactly one item tabbable
 * (roving tabindex), walk them with the arrows, and on Escape — from anywhere, the trigger included —
 * close it through `close` and focus the opener that put it there.
 */
export function useMenuKeys<T extends HTMLElement>(list: RefObject<T | null>, { open, close, opener, version = 0 }: MenuBinding): MenuKeys {
  // Whichever element had the focus when the menu opened is where Escape hands it back, unless the caller
  // names the real opener (a right-click leaves the focus on the row, not on the menu's button).
  const from = useRef<HTMLElement | null>(null);
  const entered = useRef(false);
  useLayoutEffect(() => {
    if (!open) {
      entered.current = false;
      return;
    }
    const items = focusables(list.current);
    const to = items.find((el) => el === document.activeElement) ?? items[0];
    rove(items, to);
    // Once, per open: a fold opening re-reads the items but must not pull the focus off its row.
    if (entered.current) return;
    entered.current = true;
    from.current = (document.activeElement as HTMLElement | null) ?? null;
    to?.focus();
  }, [list, open, version]);

  const leave = () => {
    close();
    const back = opener?.current ?? from.current;
    if (back?.isConnected) back.focus();
  };
  // Escape from anywhere in the menu, its trigger included (a filter menu used to stay open there).
  useDismiss(list, open, leave, { escape: true, outside: false });

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const items = focusables(list.current);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const next = menuStep(e.key, at, items.length);
    if (next === null) return;
    e.preventDefault();
    // The row list underneath answers arrows too: the menu's own walk is not its.
    e.stopPropagation();
    const to = items[next];
    rove(items, to);
    to?.focus();
  };
  return { onKeyDown, leave };
}
