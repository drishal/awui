// Small shared React hooks: the ticker behind live timestamps, and the
// outside-pointerdown / Escape dismissal shared by every popover.
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { VIEW_SLIDE_MS, VIEW_SLIDE_OFFSET, viewSlideDirection } from "./view-slide.js";

/** A ticking clock for "2m ago" style labels; paused while `enabled` is false. */
export function useNow(enabled: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const t = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(t);
  }, [enabled, intervalMs]);
  return now;
}

/** How long a popover's furl plays before it unmounts (matches --dur-hover, the leave length in motion.css). */
export const LEAVE_MS = 120;

/**
 * Keep a popover mounted briefly after `open` goes false so its closing furl
 * (an `.is-leaving` animation) can play: `render` stays true for LEAVE_MS with
 * `leaving` set, then both go false. Reopening inside the window cancels it.
 */
export function useLeave(open: boolean): { render: boolean; leaving: boolean } {
  const [render, setRender] = useState(open);
  const [leaving, setLeaving] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  // Opening mounts in the same commit (focus and layout effects see the panel at once);
  // only the unmount waits, so the furl can play. Reopening inside the window cancels it.
  if (open && (!render || leaving)) {
    setRender(true);
    setLeaving(false);
  }
  useEffect(() => () => window.clearTimeout(timer.current), []);
  useEffect(() => {
    window.clearTimeout(timer.current);
    if (!open && render) {
      setLeaving(true);
      timer.current = window.setTimeout(() => {
        setRender(false);
        setLeaving(false);
      }, LEAVE_MS);
    }
  }, [open, render]);
  return { render, leaving };
}

export interface DismissOptions {
  /** Close on Escape. Off by default: not every surface is keyboard-dismissed. */
  escape?: boolean;
  /** Close on pointerdown outside `ref`. On by default. */
  outside?: boolean;
}

/**
 * Dismiss an open popover: pointerdown outside the element and, when opted in,
 * Escape. Listeners stay mounted-stable; the latest `onClose` wins via a ref.
 */
export function useDismiss<T extends HTMLElement>(
  ref: RefObject<T | null>,
  open: boolean,
  onClose: () => void,
  { escape = false, outside = true }: DismissOptions = {},
): void {
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = outside
      ? (e: PointerEvent) => {
          if (ref.current && !ref.current.contains(e.target as Node)) onCloseRef.current();
        }
      : null;
    const onKey = escape
      ? (e: KeyboardEvent) => {
          if (e.key !== "Escape") return;
          // The topmost popover owns Escape: without this, a native <dialog>'s cancel
          // would close the dialog underneath the picker that just closed.
          e.preventDefault();
          onCloseRef.current();
        }
      : null;
    if (onDown) document.addEventListener("pointerdown", onDown);
    if (onKey) document.addEventListener("keydown", onKey);
    return () => {
      if (onDown) document.removeEventListener("pointerdown", onDown);
      if (onKey) document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, escape, outside]);
}

/**
 * Slide a list in when its view changes, from the side the change goes (the
 * sidebar's all-projects list and a focused folder are the two views). Layout
 * timing, so the first painted frame is the slide's start rather than a flash
 * of the new list in place. Scroll goes back to the top with the slide: a
 * folder opens at its newest session, not at wherever the last list was.
 */
export function useViewSlide(ref: RefObject<HTMLElement | null>, view: string): void {
  const previous = useRef<string | null>(null);
  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = view;
    const el = ref.current;
    if (!el || before === null || before === view) return;
    el.scrollTop = 0;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const forward = viewSlideDirection(before, view) === "forward";
    const from = forward ? VIEW_SLIDE_OFFSET : -VIEW_SLIDE_OFFSET;
    // Switching again before the last slide ends: start from the top, not mid-flight.
    for (const running of el.getAnimations()) running.cancel();
    el.animate(
      [
        { opacity: 0.3, transform: `translateX(${from}px)` },
        { opacity: 1, transform: "translateX(0)" },
      ],
      { duration: VIEW_SLIDE_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  }, [ref, view]);
}

/** Whether a media query matches now, kept in step as it changes (a phone's width, a rotated screen). */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);
  return matches;
}

/**
 * Animate a container between two layouts when `state` changes (FLIP): its height springs from the old
 * to the new, and each part named by `parts` (selectors inside it) glides from where it was to where it
 * is now. Parts are measured against the container's own top-left, since a container anchored at the
 * bottom (the composer) moves its top as it grows, and its parts ride along with it. Measured after every
 * render, so the "before" is always the last layout drawn. Off under reduced motion.
 */
export function useMorph(root: RefObject<HTMLElement | null>, state: unknown, parts: readonly string[], durationMs = 380): void {
  const last = useRef<{ box: DOMRect; parts: Array<DOMRect | null> } | null>(null);
  const was = useRef(state);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const measure = () => ({ box: el.getBoundingClientRect(), parts: parts.map((sel) => el.querySelector(sel)?.getBoundingClientRect() ?? null) });
    const before = last.current;
    const changed = was.current !== state;
    was.current = state;
    const now = measure();
    last.current = now;
    if (!changed || !before || typeof el.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const easing = getComputedStyle(el).getPropertyValue("--spring").trim() || "ease-out";
    const timing = { duration: durationMs, easing };
    if (Math.abs(before.box.height - now.box.height) > 0.5) {
      el.classList.add("is-morphing");
      const grow = el.animate([{ height: `${before.box.height}px` }, { height: `${now.box.height}px` }], timing);
      grow.onfinish = grow.oncancel = () => el.classList.remove("is-morphing");
    }
    parts.forEach((sel, i) => {
      const from = before.parts[i];
      const to = now.parts[i];
      const node = el.querySelector<HTMLElement>(sel);
      if (!from || !to || !node) return;
      const dx = from.left - before.box.left - (to.left - now.box.left);
      const dy = from.top - before.box.top - (to.top - now.box.top);
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "none" }], timing);
    });
  });
}
