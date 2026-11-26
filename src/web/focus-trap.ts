// What is focusable inside one surface, and how Tab wraps at its ends: the sidebar's phone drawer traps the
// keyboard this way while it is open, so Tab never walks into the chat behind it. The wrap itself is pure
// (`trapTarget`) and unit-tested; the selector is the same rule a menu uses to know its items.
import type { KeyboardEvent, RefObject } from "react";

/**
 * A surface's focusable elements, in reading order: controls, links, and anything a menu item is. Disabled,
 * aria-hidden, and display-none ones are left out, so Tab never lands on something invisible.
 */
export function focusables(root: HTMLElement | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>('button, input:not([type="hidden"]), select, textarea, a[href], [role^="menuitem"]')).filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true" && el.getClientRects().length > 0,
  );
}

/**
 * Where Tab moves inside a surface of `count` focusable elements when the focus is on `index` (or nowhere,
 * -1): the first element forward and the last backward, wrapping at both ends. Null means the browser's own
 * next (or previous) element is still inside, so the key is left alone.
 */
export function trapTarget(count: number, index: number, backward: boolean): number | null {
  if (count === 0) return null;
  if (index < 0) return backward ? count - 1 : 0;
  if (!backward && index === count - 1) return 0;
  if (backward && index === 0) return count - 1;
  return null;
}

/**
 * Keep Tab inside `root` while `active` is true: spread the result on the surface's own keydown. The ends
 * wrap; everywhere in between the browser's own Tab applies, so nothing about the surface's inner order
 * changes.
 */
export function useFocusTrap<T extends HTMLElement>(root: RefObject<T | null>, active: boolean): (e: KeyboardEvent<HTMLElement>) => void {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (!active || e.key !== "Tab" || e.altKey || e.ctrlKey || e.metaKey) return;
    const items = focusables(root.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next = trapTarget(items.length, index, e.shiftKey);
    if (next === null) return;
    e.preventDefault();
    items[next]?.focus();
  };
}
