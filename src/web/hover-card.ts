// What every hover card shares (the sidebar's session card, a file link's
// preview): a short rest of the mouse (or keyboard focus) before it shows, a
// scroll or a press that takes it away again, and a place that keeps it inside
// the window. The placement is pure so it can be tested without a browser.
import { useEffect, useLayoutEffect, useMemo, useState, type RefObject } from "react";

export type CardSide = "right" | "below";

export interface CardPlace {
  left: number;
  top: number;
}

const EDGE = 8;

/**
 * Where a card of `size` goes against `anchor` in a `view`-sized window:
 * "right" sits beside the anchor (its top a little above the anchor's),
 * "below" sits under it, or above when there is no room under. Always kept
 * EDGE pixels inside the window.
 */
export function placeCard(anchor: DOMRect, size: { width: number; height: number }, view: { width: number; height: number }, side: CardSide): CardPlace {
  const clamp = (v: number, max: number) => Math.max(EDGE, Math.min(v, max));
  if (side === "right") return { left: anchor.right + 10, top: clamp(anchor.top - 6, view.height - size.height - EDGE) };
  const under = anchor.bottom + 6;
  const top = under + size.height <= view.height - EDGE ? under : anchor.top - size.height - 6;
  return { left: clamp(anchor.left, view.width - size.width - EDGE), top: Math.max(EDGE, top) };
}

/** How long a press keeps a card away when nothing tells the card the pointer left (a row can go away under it). */
const HOLD_MS = 4000;

/**
 * The moment a press dismissed a row's card, by the row's key. Kept here, not in one hook instance: a
 * session switch replaces the row's node under a still pointer, and the browser then re-fires that
 * pointer's enter on the new node, which must not undo the press it just answered.
 */
const pressed = new Map<string, number>();

/** What a hover card waits on, apart from React, so its rules can be tested: a rest opens it after `delay`. */
export function cardRest(delay: number, open: (el: Element) => void, close: () => void, key: string | null = null) {
  let timer = 0;
  // Something under the pointer was pressed (or opened a menu): that press already answered what the card
  // would offer, so the rest may not bring it back until the pointer leaves and comes back.
  let held = false;
  /** A press still holds this card back: the row's own (which outlives the node), else this instance's. */
  const isHeld = (): boolean => (key === null ? held : Date.now() - (pressed.get(key) ?? -HOLD_MS) < HOLD_MS);
  const clear = (): void => {
    window.clearTimeout(timer);
    timer = 0;
    close();
  };
  return {
    /** The pointer (or focus) rested on `el`: it opens after `delay`, unless a press holds it back. */
    rest(el: Element): void {
      window.clearTimeout(timer);
      if (isHeld()) return;
      timer = window.setTimeout(() => open(el), delay);
    },
    /** Keep the card away until the pointer leaves: a press, or a menu opened on the element. */
    hold(): void {
      if (key === null) held = true;
      else {
        pressed.set(key, Date.now());
        // A press whose row went away with no leave cannot hold a card for good, nor grow the map.
        for (const [row, at] of pressed) if (Date.now() - at >= HOLD_MS) pressed.delete(row);
      }
      clear();
    },
    /** The pointer left: the card goes, and the next rest may open it again. */
    leave(): void {
      held = false;
      if (key !== null) pressed.delete(key);
      clear();
    },
    /** Gone for another reason (a scroll anywhere would leave it behind), with any hold kept as it was. */
    clear,
  };
}

/**
 * The anchor's rect once the pointer (or focus) has rested for `delay` ms,
 * else null. `show(element)` starts the wait, `hide()` ends it and `hold()`
 * keeps it away until the anchor is left (a press on it already said what it
 * wants). A scroll anywhere hides the card, because it would be left behind.
 * `key` names the anchor across a replaced node, so a press survives the
 * redraw that follows it (the sidebar's rows).
 */
export function useHoverCard(delay: number, key: string | null = null) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const card = useMemo(() => cardRest(delay, (el) => setAnchor(el.getBoundingClientRect()), () => setAnchor(null), key), [delay, key]);
  useEffect(() => () => card.clear(), [card]);
  useEffect(() => {
    if (!anchor) return;
    window.addEventListener("scroll", card.clear, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", card.clear, { capture: true });
  }, [anchor, card]);
  return { anchor, show: card.rest, hold: card.hold, hide: card.leave };
}

/** A card's place, measured after it draws (its size is not known before) and again when `deps` change. */
export function useCardPlace(ref: RefObject<HTMLElement | null>, anchor: DOMRect, side: CardSide, deps: readonly unknown[]): CardPlace {
  const [place, setPlace] = useState<CardPlace>(() => placeCard(anchor, { width: 0, height: 0 }, { width: window.innerWidth, height: window.innerHeight }, side));
  useLayoutEffect(() => {
    const el = ref.current;
    setPlace(placeCard(anchor, { width: el?.offsetWidth ?? 0, height: el?.offsetHeight ?? 0 }, { width: window.innerWidth, height: window.innerHeight }, side));
  }, [anchor, side, ...deps]);
  return place;
}
