// One surface across a swap. What leaves a screen leaves its box behind (`handoff`); what arrives glides
// in from that box (`land`). FLIP over the Web Animations API, so the content inside keeps streaming and a
// glide can be cancelled and restarted from where the element visibly is. Never a view-transition: those
// snapshot the page (a running chat would freeze under it) and need both ends named in one DOM update,
// while the two ends here arrive in separate commits (queue-glide.ts leaves them out for the same reason).
// The CSS reduced-motion rule (tokens.css) does not reach element.animate(), so `motionOff` is asked here,
// once, instead of by every caller. The boxes are kept a couple of seconds at most: a handoff nobody
// claims must not make an unrelated mount glide later.

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** How long a left-behind box can be claimed. */
const KEEP_MS = 2500;

const boxes = new Map<string, { box: Box; at: number }>();

/** No motion at all: the browser cannot animate an element, or the user asked for none. */
export function motionOff(): boolean {
  if (typeof Element === "undefined" || typeof Element.prototype.animate !== "function") return true;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

/**
 * A phone or a touch screen: the keyboard opening or closing resizes the viewport mid-glide, so a whole card
 * does not travel there; only small things (a prompt lifting into its bubble) do.
 */
export function handheld(): boolean {
  return window.matchMedia?.("(pointer: coarse), (max-width: 600px)").matches ?? false;
}

/** Leave `box` behind for `key` (null forgets it): the place something was when it went away. */
export function handoff(key: string, box: Box | null, now = Date.now()): void {
  if (box) boxes.set(key, { box, at: now });
  else boxes.delete(key);
}

/** Whether a box is waiting for `key` (what a caller asks to know if it is the arriving end, without taking it). */
export function pending(key: string, now = Date.now()): boolean {
  const held = boxes.get(key);
  return held !== undefined && now - held.at < KEEP_MS;
}

/** The box left for `key`, taken: one claim per handoff, and nothing once it has gone stale. */
export function takeBox(key: string, now = Date.now()): Box | null {
  const held = boxes.get(key);
  boxes.delete(key);
  return held && now - held.at < KEEP_MS ? held.box : null;
}

/**
 * The move that puts `to` back where `from` was: whole pixels, null when it would not show. With `height`
 * the card's height changes too (`dh`), which counts as movement by itself.
 */
export function flight(from: Box, to: Box, height = false): { dx: number; dy: number; dh: boolean } | null {
  const dx = Math.round(from.left - to.left);
  const dy = Math.round(from.top - to.top);
  const dh = height && Math.abs(from.height - to.height) > 0.5;
  return dx === 0 && dy === 0 && !dh ? null : { dx, dy, dh };
}

export interface LandOptions {
  /** Milliseconds; the card-sized default is a calm one. */
  duration?: number;
  /** A start that waits a little behind the rest of the swap. */
  delay?: number;
  /** Land on the spring (what you sent), not eased out (a surface that should not bounce). */
  spring?: boolean;
  /** Carry the height from the old box to the new one (the element clips while it does). */
  height?: boolean;
  /** Extra values for the first frame, e.g. an opacity to rise from. */
  from?: Keyframe;
  /** A class that holds while it glides (the CSS clips a card to its animated height with it, and holds its contents back). */
  while?: string;
}

/**
 * Glide `el` from the box left for `key`. Returns the animation, or null when nothing moved: no box,
 * motion off, no element, or the two places coincide. A glide already running for the key is cancelled,
 * and the new one measures the element where it is on screen now, so a reversal starts from where it
 * visibly is.
 */
export function land(key: string, el: HTMLElement | null, opts: LandOptions = {}, now = Date.now()): Animation | null {
  const from = takeBox(key, now);
  if (!el || !from || motionOff()) return null;
  const id = `morph:${key.split(":")[0]}`;
  // The old glide's cancel event fires after this call returns; unhooked, it cannot strip the new one's class.
  for (const running of el.getAnimations()) {
    if (running.id !== id) continue;
    running.oncancel = running.onfinish = null;
    running.cancel();
  }
  const to = el.getBoundingClientRect();
  const move = flight(from, to, opts.height === true);
  if (!move) return null;
  const easing = getComputedStyle(el).getPropertyValue(opts.spring ? "--spring" : "--ease-out").trim() || "ease-out";
  const hold = opts.while;
  if (hold) el.classList.add(hold);
  const run = el.animate(
    [
      { transform: `translate(${move.dx}px, ${move.dy}px)`, ...(move.dh ? { height: `${from.height}px` } : {}), ...opts.from },
      { transform: "none", ...(move.dh ? { height: `${to.height}px` } : {}) },
    ],
    { id, duration: opts.duration ?? 420, delay: opts.delay ?? 0, easing, fill: "backwards" },
  );
  if (hold) run.onfinish = run.oncancel = () => el.classList.remove(hold);
  return run;
}
