// The effort slider's liquid engine (ThinkingPicker.tsx). One rAF loop integrates the bead, its lagging
// droplet, the wetting front and the landing wobble at a fixed 1/120 s semi-implicit Euler step. The neck
// is one analytic union path, not two filtered circles; the wash is a path with its own meniscus. Writes
// go through refs, never React state per frame, and the loop stops once every spring and the wobble rest.
// The pure simulation and geometry functions let tests inspect each step without a browser.

export interface SpringState {
  x: number;
  v: number;
}

/** A bead's state, including the decisions that must happen in the same integration step as its motion. */
export interface LiquidState {
  thumb: SpringState;
  tail: SpringState;
  wobble: SpringState;
  wash: SpringState;
  target: number;
  /** A release or key landing can kick the wobble when the bead reaches its stop. */
  armed: boolean;
  /** The stop left by this gesture: it must not ring as the bead leaves it. */
  from: number;
  previousX: number;
  rang: number[];
  now: number;
  pressed: number;
}

export interface NeckBounds {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export interface LiquidGeometry {
  sx: number;
  sy: number;
  neck: string;
  neckBounds: NeckBounds;
  wash: { body: string; rim: string };
  wet: boolean[];
}

export interface SpringRefs {
  /** The bead: translate3d(x, 0, 0) scale(sx, sy). */
  thumb: HTMLElement | null;
  /** The bead's separate shadow layer: the same transform as the bead. */
  shadow: HTMLElement | null;
  /** The wash paths and the meniscus on its wet edge. */
  washBody: SVGPathElement | null;
  washRim: SVGPathElement | null;
  /** The analytic bead-to-droplet union. */
  neck: SVGPathElement | null;
  /** The stop layer carries --x, the bead centre used by the dead-zone dot swell. */
  stops: HTMLElement | null;
}

export interface SpringLoop {
  /** Point the bead at a new place. A known origin stop also arms a release/key landing. */
  target(x: number, from?: number): void;
  /** Stop everything at exact values and leave the loop idle. */
  rest(x: number): void;
  /** Whether the loop is running (tests ask this to wait for a settle). */
  running(): boolean;
  /** Apply or remove the pointer's small uniform press scale. */
  press(on: boolean, from?: number): void;
  stop(): void;
}

export const THUMB_SPRING = { stiffness: 560, damping: 36 };
export const TAIL_SPRING = { stiffness: 300, damping: 28 };
export const WOBBLE_SPRING = { stiffness: 520, damping: 15 };
export const WASH_SPRING = { stiffness: 190, damping: 15 };
const WASH_LEAD = 6;
const MAX_GAP = 22;

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

/** Smoothstep, including its clamps at the two ends. */
function smooth(a: number, b: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Bounded squash/stretch: the bead gets wider with speed but keeps its drawn area. */
export function stretchOf(v: number): { sx: number; sy: number } {
  const sx = 1 + 0.22 * Math.tanh(Math.abs(v) / 900);
  return { sx, sy: 1 / Math.sqrt(sx) };
}

/** The drawn gap and droplet radius for a signed tail lag. */
export function neckGap(raw: number): { gap: number; r2: number } {
  const gap = MAX_GAP * Math.tanh(Math.abs(raw) / MAX_GAP);
  return { gap, r2: 7 - 2.5 * smooth(6, 22, gap) };
}

/** A pinched waist still joins the bead to the droplet; it never becomes a broken bridge. */
export function waist(gap: number, r2: number): number {
  return r2 * (0.95 - 0.25 * smooth(8, 22, gap));
}

/** The wash front follows the bead with a short lead; its bulge follows the front's velocity. */
export function washPaths(thumbX: number, wash: SpringState, width: number, cy = 15): { body: string; rim: string } {
  const f = (n: number) => n.toFixed(2);
  const wl = wash.x - thumbX - WASH_LEAD;
  const xw = Math.min(Math.max(0, width), Math.max(0, thumbX + WASH_LEAD + 26 * Math.tanh(wl / 26)));
  const b = Math.max(-4, Math.min(7, 1.5 + 0.012 * wash.v));
  const k = (4 * b) / 3;
  return {
    body: `M-1 ${f(-cy + 14)}H${f(xw)}C${f(xw + k)} ${f(6 - cy + 15)} ${f(xw + k)} ${f(24 - cy + 15)} ${f(xw)} ${f(cy + 16)}H-1Z`,
    rim: `M${f(xw)} ${f(0.6 - cy + 15)}C${f(xw + k)} ${f(6.6 - cy + 15)} ${f(xw + k)} ${f(23.4 - cy + 15)} ${f(xw)} ${f(cy + 14.4)}`,
  };
}

/** A stop rings on a bead-centre crossing, except the stop being left, a recent ring, or a fast fly-by. */
export function ringCrossed(stopX: number, index: number, state: LiquidState): boolean {
  const a = state.previousX - stopX;
  const b = state.thumb.x - stopX;
  const speed = Math.abs(state.thumb.v);
  return a * b < 0 && index !== state.from && state.now - (state.rang[index] ?? -Infinity) > 260
    && speed > 20 && (speed < 900 || Math.abs(state.target - stopX) < 0.5);
}

/** Integrate one fixed step. Returned ring indices are the only events the caller should animate. */
export function simulate(state: LiquidState, stopXs: number[], h: number, wash = true): number[] {
  const rings: number[] = [];
  stepSpring(state.thumb, state.target, THUMB_SPRING.stiffness, THUMB_SPRING.damping, h);
  stepSpring(state.tail, state.thumb.x, TAIL_SPRING.stiffness, TAIL_SPRING.damping, h);
  stepSpring(state.wobble, 1, WOBBLE_SPRING.stiffness, WOBBLE_SPRING.damping, h);
  if (wash) stepSpring(state.wash, state.thumb.x + WASH_LEAD, WASH_SPRING.stiffness, WASH_SPRING.damping, h);
  else { state.wash.x = state.thumb.x + WASH_LEAD; state.wash.v = 0; }
  for (let i = 0; i < stopXs.length; i++) {
    const stopX = stopXs[i];
    if (stopX !== undefined && ringCrossed(stopX, i, state)) {
      state.rang[i] = state.now;
      rings.push(i);
    }
  }
  // Kick on arrival, including an overshoot. Amplitude comes from the arrival speed, not from the key or click.
  if (state.armed && ((state.previousX - state.target) * (state.thumb.x - state.target) <= 0 || Math.abs(state.thumb.x - state.target) < 0.5)) {
    state.armed = false;
    const amplitude = Math.min(0.12, Math.max(0.04, Math.abs(state.thumb.v) / 1600));
    state.wobble.v += amplitude * 22.8;
  }
  state.previousX = state.thumb.x;
  state.now += h * 1000;
  return rings;
}

/** The neck is a bead circle joined to a droplet with tangent cubic halves and a union droplet circle. */
export function neckPath(x1: number, r1: number, x2: number, r2: number, h: number, cy = 15): string {
  const f = (n: number) => n.toFixed(2);
  if (![x1, r1, x2, r2, h, cy].every(Number.isFinite) || r1 < 0 || r2 < 0) return "";
  const s = Math.sign(x2 - x1) || 1;
  const d = Math.abs(x2 - x1);
  // Match the droplet's winding with the neck, including reversed travel; otherwise fill cuts out their union.
  const w = s > 0 ? 1 : 0;
  const circle = `M${f(x2 - r2)} ${cy}a${f(r2)} ${f(r2)} 0 1 ${w} ${f(2 * r2)} 0a${f(r2)} ${f(r2)} 0 1 ${w} ${f(-2 * r2)} 0Z`;
  if (h <= 0 || d < r1 - r2 + 0.5) return circle;
  // The intersection lens is the thinnest usable waist; a narrower bridge would notch the union.
  if (d < r1 + r2) {
    const a = (d * d + r1 * r1 - r2 * r2) / (2 * d);
    h = Math.max(h, Math.sqrt(Math.max(0, r1 * r1 - a * a)) + 0.3);
  }
  h = Math.min(h, r2 * 0.98);
  // A broad bead attachment tapering toward a smaller droplet makes a teardrop, not a barbell's straight bar.
  const H1 = Math.min(r1 * 0.94, h + 0.55 * (r1 - h));
  const H2 = Math.min(r2 * 0.94, h + 0.4 * (r2 - h));
  const c1 = Math.sqrt(r1 * r1 - H1 * H1);
  const c2 = Math.sqrt(r2 * r2 - H2 * H2);
  const P1x = x1 + s * c1;
  const P2x = x2 - s * c2;
  const Mx = P1x + (P2x - P1x) * 0.6;
  // Start and finish each cubic along the circle tangent, keeping the bridge smooth at both attachments.
  const t1x = s * H1 / r1 || 0;
  const t1y = c1 / r1 || 0;
  const t2x = -s * H2 / r2 || 0;
  const t2y = c2 / r2 || 0;
  const k1 = Math.abs(Mx - P1x) * 0.55;
  const k2 = Math.abs(P2x - Mx) * 0.55;
  const half = (sg: number) => {
    const y1 = cy + sg * H1;
    const y2 = cy + sg * H2;
    const ym = cy + sg * h;
    return `C${f(P1x + t1x * k1)} ${f(y1 - sg * t1y * k1)} ${f(Mx - s * k1)} ${f(ym)} ${f(Mx)} ${f(ym)}` +
      `C${f(Mx + s * k2)} ${f(ym)} ${f(P2x + t2x * k2)} ${f(y2 - sg * t2y * k2)} ${f(P2x)} ${f(y2)}`;
  };
  // The return edge runs back to the bead. This is one closed bridge plus the droplet, not two separate tails.
  const y1 = cy + H1;
  const y2 = cy + H2;
  const ym = cy + h;
  const bottom = `C${f(P2x + t2x * k2)} ${f(y2 - t2y * k2)} ${f(Mx + s * k2)} ${f(ym)} ${f(Mx)} ${f(ym)}` +
    `C${f(Mx - s * k1)} ${f(ym)} ${f(P1x + t1x * k1)} ${f(y1 - t1y * k1)} ${f(P1x)} ${f(y1)}`;
  return `M${f(P1x)} ${f(cy - H1)}${half(-1)}L${f(P2x)} ${f(cy + H2)}${bottom}Z` + circle;
}

/** Conservative bounds for the path, including cubic controls and the droplet circle, for containment tests. */
export function neckBounds(x1: number, r1: number, x2: number, r2: number, h: number, cy = 15): NeckBounds {
  if (![x1, r1, x2, r2, h, cy].every(Number.isFinite) || r1 < 0 || r2 < 0) return { x0: 0, x1: 0, y0: 0, y1: 0 };
  const out = { x0: x2 - r2, x1: x2 + r2, y0: cy - r2, y1: cy + r2 };
  const include = (x: number, y: number) => {
    out.x0 = Math.min(out.x0, x); out.x1 = Math.max(out.x1, x);
    out.y0 = Math.min(out.y0, y); out.y1 = Math.max(out.y1, y);
  };
  const s = Math.sign(x2 - x1) || 1;
  const d = Math.abs(x2 - x1);
  if (h <= 0 || d < r1 - r2 + 0.5) return out;
  if (d < r1 + r2) {
    const a = (d * d + r1 * r1 - r2 * r2) / (2 * d);
    h = Math.max(h, Math.sqrt(Math.max(0, r1 * r1 - a * a)) + 0.3);
  }
  h = Math.min(h, r2 * 0.98);
  const H1 = Math.min(r1 * 0.94, h + 0.55 * (r1 - h));
  const H2 = Math.min(r2 * 0.94, h + 0.4 * (r2 - h));
  const c1 = Math.sqrt(r1 * r1 - H1 * H1);
  const c2 = Math.sqrt(r2 * r2 - H2 * H2);
  const P1x = x1 + s * c1;
  const P2x = x2 - s * c2;
  const Mx = P1x + (P2x - P1x) * 0.6;
  const t1x = s * H1 / r1 || 0;
  const t1y = c1 / r1 || 0;
  const t2x = -s * H2 / r2 || 0;
  const t2y = c2 / r2 || 0;
  const k1 = Math.abs(Mx - P1x) * 0.55;
  const k2 = Math.abs(P2x - Mx) * 0.55;
  for (const sg of [-1, 1]) {
    const y1 = cy + sg * H1;
    const y2 = cy + sg * H2;
    const ym = cy + sg * h;
    include(P1x + t1x * k1, y1 - sg * t1y * k1);
    include(Mx - s * k1, ym);
    include(Mx, ym);
    include(Mx + s * k2, ym);
    include(P2x + t2x * k2, y2 - sg * t2y * k2);
    include(P2x, y2);
  }
  return out;
}

/** All per-frame geometry in one pure calculation, including which dots the wet front has reached. */
export function geometryOf(state: LiquidState, stopXs: number[], width: number, cy = 15): LiquidGeometry {
  const stretch = stretchOf(state.thumb.v);
  const sx = stretch.sx * state.wobble.x * state.pressed;
  const sy = stretch.sy / Math.sqrt(Math.max(0.01, state.wobble.x)) * state.pressed;
  const raw = state.tail.x - state.thumb.x;
  const s = Math.sign(raw) || 1;
  const { gap, r2 } = neckGap(raw);
  const r1 = Math.min(10 * sx, 12 * sy) * state.pressed - 0.5;
  const h = waist(gap, r2);
  // Keep the hidden part of the droplet inside the bead's own box at either end of the track.
  const tip = Math.min(width - r2 - 1, Math.max(r2 + 1, state.thumb.x + s * gap));
  return {
    sx, sy,
    // Below the visible gap there is no separate material to draw. The bead itself covers the whole attachment.
    neck: gap < 0.5 ? "" : neckPath(state.thumb.x, r1, tip, r2, h, cy),
    neckBounds: neckBounds(state.thumb.x, r1, tip, r2, h, cy),
    wash: washPaths(state.thumb.x, state.wash, width, cy),
    wet: stopXs.map((stopX) => stopX <= tip - 2),
  };
}

export function initialLiquidState(from: number, stopXs: number[]): LiquidState {
  return {
    thumb: { x: from, v: 0 }, tail: { x: from, v: 0 }, wobble: { x: 1, v: 0 },
    wash: { x: from + WASH_LEAD, v: 0 }, target: from, armed: false, from: 0, previousX: from,
    rang: stopXs.map(() => -Infinity), now: 0, pressed: 1,
  };
}

/** Start the DOM-backed loop. Disabling tail also pins the wash to its bead-relative rest position. */
export function startSprings(refs: SpringRefs, from: number, stopXs: number[], width: number,
  opts: { tail: boolean; onStill?: (still: boolean) => void; onRing?: (index: number) => void; onWet?: (index: number, wet: boolean) => void },
): SpringLoop {
  const state = initialLiquidState(from, stopXs);
  let raf: number | null = null;
  let lastAt = 0;
  let still = true;
  let stopped = false;

  const wake = (): void => {
    if (raf !== null || stopped) return;
    still = false;
    opts.onStill?.(false);
    lastAt = performance.now();
    raf = requestAnimationFrame(frame);
  };

  const write = (): void => {
    const geometry = geometryOf(state, stopXs, width);
    refs.stops?.style.setProperty("--x", `${state.thumb.x.toFixed(2)}px`);
    // Only transforms and path data change; the bead's two layers share exactly the same transform.
    const transform = `translate3d(${state.thumb.x.toFixed(2)}px, 0, 0) scale(${geometry.sx.toFixed(4)}, ${geometry.sy.toFixed(4)})`;
    refs.thumb?.style.setProperty("transform", transform);
    refs.shadow?.style.setProperty("transform", transform);
    refs.neck?.setAttribute("d", geometry.neck);
    refs.washBody?.setAttribute("d", geometry.wash.body);
    refs.washRim?.setAttribute("d", geometry.wash.rim);
    refs.washRim?.setAttribute("stroke-opacity", Math.min(1, Math.abs(state.wash.v) / 400).toFixed(2));
    geometry.wet.forEach((wet, i) => opts.onWet?.(i, wet));
  };

  const frame = (at: number): void => {
    raf = null;
    if (stopped) return;
    // A background tab's long gap is one 32 ms frame, never hundreds of unstable integration steps.
    const frameDt = Math.min((at - lastAt) / 1000, 0.032) || 1 / 120;
    lastAt = at;
    const steps = Math.max(1, Math.min(4, Math.round(frameDt / (1 / 120))));
    const h = frameDt / steps;
    for (let i = 0; i < steps; i++) simulate(state, stopXs, h, opts.tail).forEach((index) => opts.onRing?.(index));
    const rested = springRested(state.thumb, state.target) && springRested(state.tail, state.thumb.x)
      && springRested(state.wash, state.thumb.x + WASH_LEAD) && springRested(state.wobble, 1);
    if (rested) {
      state.thumb.x = state.target;
      state.thumb.v = 0;
      state.tail.x = state.thumb.x;
      state.tail.v = 0;
      state.wash.x = state.thumb.x + WASH_LEAD;
      state.wash.v = 0;
      state.wobble.x = 1;
      state.wobble.v = 0;
      state.armed = false;
      state.previousX = state.thumb.x;
      write();
      still = true;
      opts.onStill?.(true);
      return;
    }
    write();
    if (still) {
      still = false;
      opts.onStill?.(false);
    }
    raf = requestAnimationFrame(frame);
  };

  const loop: SpringLoop = {
    target(x: number, from?: number): void {
      if (stopped) return;
      const was = Math.abs(state.target - state.thumb.x) < 0.3;
      state.target = x;
      if (from !== undefined) { state.from = from; state.armed = true; }
      // A reduced-motion target is a rest write, just like release: the new position is visible in this paint.
      if (!opts.tail) { loop.rest(x); return; }
      if (was && still) {
        // A settled spring re-aimed at a far stop starts from rest, not from its old velocity.
        state.thumb.v = 0;
        state.tail.v = 0;
      }
      wake();
    },
    rest(x: number): void {
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      state.target = x;
      state.thumb = { x, v: 0 };
      state.tail = { x, v: 0 };
      state.wash = { x: x + WASH_LEAD, v: 0 };
      state.wobble = { x: 1, v: 0 };
      state.armed = false;
      state.previousX = x;
      state.rang.fill(-Infinity);
      state.now = 0;
      still = true;
      write();
      opts.onStill?.(true);
    },
    running(): boolean { return raf !== null; },
    press(on: boolean, from?: number): void {
      if (stopped) return;
      if (on && from !== undefined) state.from = from;
      state.pressed = on && opts.tail ? 1.06 : 1;
      if (on) state.armed = false;
      // With reduced motion a press is a rest write too: no delayed scale or landing wobble schedules a loop.
      if (!opts.tail) loop.rest(state.target);
      else wake();
    },
    stop(): void {
      stopped = true;
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
    },
  };
  // First paint: an at-rest path and no animation loop.
  loop.rest(from);
  return loop;
}
