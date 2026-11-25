// The effort slider's spring engine (ThinkingPicker.tsx): one rAF loop over three springs (thumb, tail,
// wobble) integrated semi-implicit Euler at a fixed 1/120 s step, clamped so a dropped frame cannot
// explode them. Writes only to style through refs — never React state per frame — and stops dead once
// every spring has rested, so the loop never runs while idle. No dependency; the same physics the
// spec's springs name (thumb 560/36, tail 240/24, wobble 700/16).
export interface SpringRefs {
  /** The pill: translate3d(x, -50%, 0) scale(sx, sy). */
  thumb: HTMLElement | null;
  /** The lagging circle: translate3d(x, -50%, 0). */
  tail: HTMLElement | null;
  /** The unfiltered highlight: translate3d(x, -50%, 0), never scaled. */
  shine: HTMLElement | null;
  /** The track: carries --x in px for the dots and the fill to read. */
  track: HTMLElement | null;
}

export interface SpringState {
  x: number;
  v: number;
}

/** Semi-implicit Euler toward `target`. */
export function stepSpring(s: SpringState, target: number, stiffness: number, damping: number, dt: number): void {
  const a = stiffness * (target - s.x) - damping * s.v;
  s.v += a * dt;
  s.x += s.v * dt;
}

/** Rested: close enough and slow enough that snapping is invisible. */
export function springRested(s: SpringState, target: number): boolean {
  return Math.abs(target - s.x) < 0.3 && Math.abs(s.v) < 8;
}

/** Squash/stretch from velocity: wider when fast, taller to keep the area. */
export function stretchOf(v: number): { sx: number; sy: number } {
  const sx = 1 + Math.min(Math.abs(v) / 2000, 0.3);
  return { sx, sy: 1 / Math.sqrt(sx) };
}

export const THUMB_SPRING = { stiffness: 560, damping: 36 };
export const TAIL_SPRING = { stiffness: 240, damping: 24 };
export const WOBBLE_SPRING = { stiffness: 700, damping: 16 };

export interface SpringLoop {
  /** Point the thumb at a new place (px); the tail chases, the loop runs. */
  target(x: number): void;
  /** Stop everything at exact values and leave the loop idle. */
  rest(x: number): void;
  /** Whether the loop is running (tests ask this to wait for a settle). */
  running(): boolean;
  /** One wobble impulse on land (the thumb arriving at a stop). */
  kick(): void;
  stop(): void;
}

export function startSprings(refs: SpringRefs, from: number, opts: { tail: boolean; onStill?: (still: boolean) => void }): SpringLoop {
  const thumb: SpringState = { x: from, v: 0 };
  const tail: SpringState = { x: from, v: 0 };
  const wobble: SpringState = { x: 1, v: 0 };
  let target = from;
  let raf: number | null = null;
  let lastAt = 0;
  let still = true;
  let stopped = false;

  const write = (sx: number, sy: number): void => {
    const t = refs.track;
    if (t) t.style.setProperty("--x", `${thumb.x.toFixed(2)}px`);
    // Transform and one custom property per frame; never left or width.
    refs.thumb?.style.setProperty("transform", `translate3d(${thumb.x.toFixed(2)}px, -50%, 0) scale(${sx.toFixed(4)}, ${sy.toFixed(4)})`);
    refs.tail?.style.setProperty("transform", `translate3d(${tail.x.toFixed(2)}px, -50%, 0)`);
    refs.shine?.style.setProperty("transform", `translate3d(${thumb.x.toFixed(2)}px, -50%, 0)`);
  };

  const frame = (at: number): void => {
    raf = null;
    if (stopped) return;
    // Clamped: a background tab's 2 s gap is one 32 ms frame, not an explosion.
    const frameDt = Math.min((at - lastAt) / 1000, 0.032) || 1 / 120;
    lastAt = at;
    const steps = Math.max(1, Math.round(frameDt / (1 / 120)));
    const h = frameDt / steps;
    for (let i = 0; i < steps; i++) {
      // The fixed step is at most 1/120 s: at 120 fps one substep, at 30 fps four.
      stepSpring(thumb, target, THUMB_SPRING.stiffness, THUMB_SPRING.damping, h);
      if (opts.tail) stepSpring(tail, thumb.x, TAIL_SPRING.stiffness, TAIL_SPRING.damping, h);
      stepSpring(wobble, 1, WOBBLE_SPRING.stiffness, WOBBLE_SPRING.damping, h);
    }
    const { sx, sy } = stretchOf(thumb.v);
    // The wobble rides the squash: one scale, kicked on land.
    const kicked = sx * wobble.x;
    write(kicked, sy / Math.sqrt(Math.max(0.01, wobble.x)));
    const rested = springRested(thumb, target) && (!opts.tail || springRested(tail, thumb.x)) && springRested(wobble, 1);
    if (rested) {
      thumb.x = target;
      tail.x = thumb.x;
      wobble.x = 1;
      wobble.v = 0;
      write(1, 1);
      still = true;
      opts.onStill?.(true);
      return;
    }
    if (still) {
      still = false;
      opts.onStill?.(false);
    }
    raf = requestAnimationFrame(frame);
  };

  const loop: SpringLoop = {
    target(x: number): void {
      if (stopped) return;
      const was = Math.abs(target - thumb.x) < 0.3;
      target = x;
      if (was && still) {
        // A settled spring re-aimed at a far stop starts from rest, not from a stale velocity.
        thumb.v = 0;
        tail.v = 0;
      }
      if (raf === null && !stopped) {
        still = false;
        opts.onStill?.(false);
        lastAt = performance.now();
        raf = requestAnimationFrame(frame);
      }
    },
    rest(x: number): void {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      target = x;
      thumb.x = x;
      thumb.v = 0;
      tail.x = x;
      tail.v = 0;
      wobble.x = 1;
      wobble.v = 0;
      still = true;
      write(1, 1);
      opts.onStill?.(true);
    },
    running(): boolean {
      return raf !== null;
    },
    /** The land kick: one wobble impulse when the thumb arrives (release/settle, keyboard). */
    kick(): void {
      if (stopped) return;
      wobble.v += 0.12 * WOBBLE_SPRING.stiffness * 0.01;
      if (raf === null && !stopped) {
        still = false;
        opts.onStill?.(false);
        lastAt = performance.now();
        raf = requestAnimationFrame(frame);
      }
    },
    stop(): void {
      stopped = true;
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    },
  };
  // First paint: at rest, no loop.
  loop.rest(from);
  return loop;
}
