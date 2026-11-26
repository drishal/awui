import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  geometryOf,
  initialLiquidState,
  neckBounds,
  neckGap,
  neckPath,
  ringCrossed,
  simulate,
  springRested,
  startSprings,
  stepSpring,
  stretchOf,
  waist,
  washPaths,
  type LiquidState,
  type SpringRefs,
} from "../../src/web/effort-spring.js";

// Mock the browser pieces the loop touches. Geometry itself is tested as pure TypeScript so every trace is
// deterministic; only the small DOM write surface uses this element stand-in.
function mockEl() {
  const attrs = new Map<string, string>();
  return {
    style: { setProperty: vi.fn() },
    setAttribute(name: string, value: string) { attrs.set(name, value); },
    getAttribute(name: string) { return attrs.get(name) ?? null; },
  };
}

const emptyRefs = (): SpringRefs => ({ thumb: null, shadow: null, washBody: null, washRim: null, neck: null, stops: null });
const STOPS = [15, 72.5, 130];
const WIDTH = 150;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function liquid(from = STOPS[0]!): LiquidState {
  return initialLiquidState(from, STOPS);
}

function advance(state: LiquidState, frames: number, stop?: () => boolean): void {
  for (let i = 0; i < frames; i++) {
    simulate(state, STOPS, 1 / 120);
    if (stop?.()) return;
  }
}

function assertContained(bounds: { x0: number; x1: number; y0: number; y1: number }): void {
  expect(bounds.x0).toBeGreaterThanOrEqual(0);
  expect(bounds.x1).toBeLessThanOrEqual(WIDTH);
  expect(bounds.y0).toBeGreaterThanOrEqual(0);
  expect(bounds.y1).toBeLessThanOrEqual(30);
}

describe("stretchOf", () => {
  it("is identity at rest and monotonically saturates with speed", () => {
    expect(stretchOf(0)).toEqual({ sx: 1, sy: 1 });
    // C.3 stretches by 22% of the speed saturation and conserves area through sy = 1 / sqrt(sx).
    expect(stretchOf(600).sx).toBeCloseTo(1 + 0.22 * Math.tanh(600 / 900));
    const areas = [0, 600, 1200, 2000, 5000].map((v) => {
      const { sx, sy } = stretchOf(v);
      return sx * sy * sy; // sx * sy² is the square-corrected area invariant.
    });
    areas.forEach((area) => expect(area).toBeCloseTo(1));
    [600, 1200, 2000, 5000].forEach((v) => {
      expect(stretchOf(v).sx).toBeGreaterThan(1);
      expect(stretchOf(v).sx).toBeLessThan(1.23);
      expect(stretchOf(-v)).toEqual(stretchOf(v));
    });
  });
});

describe("stepSpring", () => {
  it("takes a semi-implicit Euler step", () => {
    const s = { x: 0, v: 0 };
    stepSpring(s, 10, 500, 30, 0.001);
    expect(s.v).toBeCloseTo(5);
    expect(s.x).toBeCloseTo(0.005);
  });
});

describe("neckGap and waist", () => {
  it("has an analytic saturating gap and a large, flat droplet at rest", () => {
    expect(neckGap(0)).toEqual({ gap: 0, r2: 7 });
    expect(neckGap(6).gap).toBeLessThan(6);
    expect(neckGap(10).r2).toBeGreaterThan(7 - 2.5 * (10 / 16) ** 2 * (3 - 2 * (10 / 16)));
    expect(neckGap(10).gap).toBeLessThanOrEqual(10);
    expect(neckGap(22).gap).toBeLessThanOrEqual(22);
    expect(neckGap(-10)).toEqual(neckGap(10));
    expect(neckGap(100).gap).toBeLessThan(22);
    [0, 4, 10, 22].forEach((gap) => {
      const r2 = neckGap(gap).r2;
      const h = waist(gap, r2);
      expect(h).toBeGreaterThanOrEqual(r2 * 0.7);
      expect(h).toBeLessThanOrEqual(r2 * 0.95);
    });
  });
});

describe("neckPath and neckBounds", () => {
  it("keeps a zero-gap droplet entirely inside the track", () => {
    const path = neckPath(15, 9, 15, 7, 6.3);
    expect(path).toMatch(/^M8\.00 15a7\.00 7\.00/);
    expect(path).toContain("Z");
    assertContained(neckBounds(15, 9, 15, 7, 6.3));
    const path0 = neckPath(0, 9, 0, 7, 6.3);
    expect(path0).toContain("a7.00 7.00");
    expect(Number.isFinite(neckBounds(0, 9, 0, 7, 6.3).x0)).toBe(true);
  });

  it("keeps the stopped droplet inside at both track ends", () => {
    for (const stop of STOPS) {
      for (const raw of [-0.01, 0, 0.01]) {
        const { gap, r2 } = neckGap(raw);
        const r1 = 9;
        const h = waist(gap, r2);
        const tip = stop + Math.sign(raw) * gap;
        assertContained(neckBounds(stop, r1, tip, r2, h));
        expect(neckPath(stop, r1, tip, r2, h)).toContain("a");
      }
    }
  });

  it("a moving tail is a single union path with non-negative waist", () => {
    const path = neckPath(15, 9, 33, 7, 4.9);
    expect(path).toContain("C");
    expect(path).toContain("a7.00 7.00");
    // The droplet's circle is complete, rather than a rectangle between two circles.
    expect(path).toMatch(/a7\.00 7\.00 0 1 1 14\.00 0a7\.00 7\.00 0 1 1 -14\.00 0Z$/);
    expect(neckBounds(15, 9, 33, 7, 4.9).y1).toBeLessThanOrEqual(22);
    expect(neckPath(15, 9, 33, -1, 4)).toBe("");
    expect(neckPath(NaN, 9, 33, 7, 4)).toBe("");
  });
});

describe("washPaths", () => {
  it("the wash front has bounded lag and its meniscus is bounded", () => {
    expect(washPaths(15, { x: 21, v: 0 }, WIDTH).body).toContain("H21.00");
    // Receding liquid may flatten from its resting 7.5 px curl to -3 px, clamped by b = -4.
    expect(washPaths(15, { x: 21, v: -10000 }, WIDTH).body).toContain("C15.67 6.00 15.67 24.00 21.00 31.00");
    expect(washPaths(15, { x: 21, v: 10000 }, WIDTH).body).toContain("C30.33 6.00 30.33 24.00 21.00 31.00");
    expect(washPaths(130, { x: 136 + 1000, v: 0 }, WIDTH).body).toContain("H150.00");
    expect(washPaths(15, { x: -1000, v: 0 }, WIDTH).body).toContain("H0.00");
    expect(washPaths(15, { x: 21, v: 0 }, WIDTH).rim).toContain("0.60");
    expect(washPaths(15, { x: 21, v: 0 }, WIDTH).rim).toContain("29.40");
  });
});

describe("ringCrossed", () => {
  it("requires a real crossing of the stop centre", () => {
    const state = liquid();
    state.previousX = 71;
    state.thumb.x = 74;
    state.thumb.v = 300;
    state.from = 0;
    expect(ringCrossed(72.5, 1, state)).toBe(true);
    state.previousX = 74;
    state.thumb.x = 71;
    expect(ringCrossed(72.5, 1, state)).toBe(true);
    state.previousX = 71;
    state.thumb.x = 71;
    expect(ringCrossed(72.5, 1, state)).toBe(false);
    state.thumb.x = 73;
    expect(ringCrossed(72.5, 1, state)).toBe(true);
  });

  it("does not ring the departure stop or an idle bead sitting on a stop", () => {
    const state = liquid();
    state.previousX = 14;
    state.thumb.x = 16;
    state.from = 0;
    expect(ringCrossed(15, 0, state)).toBe(false);
    state.previousX = 15;
    state.thumb.x = 15;
    state.from = 1;
    expect(ringCrossed(15, 0, state)).toBe(false);
    state.thumb.v = 10;
    expect(ringCrossed(15, 2, state)).toBe(false); // Rest drift cannot ring a stop in the departure direction.
    expect(ringCrossed(15, 2, state)).toBe(false);
  });

  it("rate limits repeats and ignores a fast fly-by", () => {
    const state = liquid();
    state.from = 0;
    state.previousX = 71;
    state.thumb.x = 74;
    state.thumb.v = 899;
    state.now = 100;
    expect(ringCrossed(72.5, 1, state)).toBe(true);
    state.rang[1] = state.now;
    expect(ringCrossed(72.5, 1, state)).toBe(false);
    state.now += 261;
    expect(ringCrossed(72.5, 1, state)).toBe(true);
    state.thumb.v = 901;
    expect(ringCrossed(72.5, 1, state)).toBe(false);
    state.target = 72.5;
    expect(ringCrossed(72.5, 1, state)).toBe(true);
  });
});

describe("simulate", () => {
  it("converges toward a target and brings its trailing tail to rest", () => {
    const state = liquid();
    state.target = STOPS[1]!;
    advance(state, 2000);
    expect(state.thumb.x).toBeCloseTo(STOPS[1]!, 2);
    expect(state.tail.x).toBeCloseTo(STOPS[1]!, 2);
    expect(state.wash.x).toBeCloseTo(STOPS[1]! + 6, 2);
  });

  it("the overshoot stays bounded under the shipped spring constants", () => {
    const state = liquid();
    state.target = STOPS[1]!;
    let min = state.thumb.x;
    for (let i = 0; i < 300; i++) {
      simulate(state, STOPS, 1 / 120);
      min = Math.min(min, state.thumb.x);
    }
    expect(state.thumb.x).toBeGreaterThan(STOPS[1]!);
    expect(state.thumb.x - STOPS[1]!).toBeLessThan(20);
    expect(min).toBe(STOPS[0]);
  });

  it("kicks the wobble only when a release or key reaches its stop, scaled by speed", () => {
    const released = liquid();
    released.target = STOPS[1]!;
    released.armed = true;
    advance(released, 500, () => released.wobble.v !== 0);
    expect(released.wobble.v).toBeGreaterThan(0);
    expect(released.wobble.v).toBeGreaterThanOrEqual(0.04 * 22.8);
    expect(released.wobble.v).toBeLessThanOrEqual(0.12 * 22.8);
    expect(released.armed).toBe(false);

    const snapped = liquid();
    advance(snapped, 500);
    expect(snapped.wobble.v).toBe(0);
    expect(snapped.thumb.x).toBe(STOPS[0]);
  });

  it("a simulated stop crossing rings once at the centre, not continuously", () => {
    const state = liquid();
    state.from = 0;
    state.target = STOPS[2]!;
    let rang = 0;
    for (let i = 0; i < 500; i++) {
      rang += simulate(state, STOPS, 1 / 120).length;
    }
    // An intermediate stop may be passed quickly; it cannot ring merely because it is passed in state.
    expect(rang).toBeLessThanOrEqual(1);
    expect(state.rang[0]).toBe(-Infinity);
  });

  it("reduced-motion simulation has no independent wash front", () => {
    const state = liquid();
    state.target = STOPS[1]!;
    for (let i = 0; i < 100; i++) simulate(state, STOPS, 1 / 120, false);
    expect(state.wash.x).toBe(state.thumb.x + 6);
    expect(state.wash.v).toBe(0);
  });
});

describe("startSprings", () => {
  let rafQueue: FrameRequestCallback[];
  let rafId = 0;
  let request: ReturnType<typeof vi.fn>;
  let cancel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    rafQueue = []; rafId = 0;
    request = vi.fn((fn: FrameRequestCallback) => { rafQueue.push(fn); return ++rafId; });
    cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", cancel);
    vi.setSystemTime(0);
  });

  function raf(at: number): void {
    const fn = rafQueue.shift();
    if (!fn) throw new Error("no frame requested: the spring has already settled");
    fn(at);
  }

  function settle(startAt = 0): number {
    let frames = 0;
    while (rafQueue.length > 0) { raf(startAt + frames * 16.67); frames++; }
    return frames;
  }

  function runningRefs() {
    const refs = emptyRefs();
    refs.thumb = mockEl() as never;
    refs.shadow = mockEl() as never;
    refs.neck = mockEl() as never;
    refs.washBody = mockEl() as never;
    refs.washRim = mockEl() as never;
    refs.stops = mockEl() as never;
    return refs;
  }

  it("rest writes the bead, its shadow, and --x, scheduling no animation", () => {
    const refs = runningRefs();
    const loop = startSprings(refs, 15, STOPS, WIDTH, { tail: true });
    expect(refs.thumb!.style.setProperty).toHaveBeenCalledWith("transform", "translate3d(15.00px, 0, 0) scale(1.0000, 1.0000)");
    expect(refs.shadow!.style.setProperty).toHaveBeenCalledWith("transform", "translate3d(15.00px, 0, 0) scale(1.0000, 1.0000)");
    expect(refs.stops!.style.setProperty).toHaveBeenCalledWith("--x", "15.00px");
    expect(request).not.toHaveBeenCalled();
    expect(loop.running()).toBe(false);
    loop.stop();
  });

  it("writes only transforms and SVG paths, never layout left or width", () => {
    const left = vi.fn();
    const refs = runningRefs();
    const loop = startSprings(refs, 15, STOPS, WIDTH, { tail: true });
    vi.mocked(refs.stops!.style.setProperty).mockClear();
    loop.target(72.5, 0);
    raf(16.67);
    expect(left).not.toHaveBeenCalled();
    expect(refs.stops!.style.setProperty).toHaveBeenLastCalledWith("--x", "20.95px");
    expect(refs.neck!.getAttribute("d")).toContain("a");
    loop.target(72.5);
    settle(16.67);
    expect(loop.running()).toBe(false);
    expect(refs.stops!.style.setProperty).toHaveBeenLastCalledWith("--x", "72.50px");
    loop.stop();
  });

  it("settles and stops requesting frames, resetting every spring at rest", () => {
    const refs = runningRefs();
    const loop = startSprings(refs, 15, STOPS, WIDTH, { tail: true });
    vi.mocked(refs.stops!.style.setProperty).mockClear();
    loop.target(72.5, 0);
    expect(loop.running()).toBe(true);
    const frames = settle();
    expect(frames).toBeGreaterThan(1);
    expect(request).toHaveBeenCalled();
    expect(loop.running()).toBe(false);
    expect(refs.stops!.style.setProperty).toHaveBeenLastCalledWith("--x", "72.50px");
    loop.stop();
  });

  it("clamps a dropped frame to four fixed steps and remains bounded", () => {
    const refs = runningRefs();
    const loop = startSprings(refs, 15, STOPS, WIDTH, { tail: true });
    vi.mocked(refs.stops!.style.setProperty).mockClear();
    loop.target(72.5, 0);
    raf(16.67);
    loop.target(72.5);
    expect(settle(16.67)).toBeGreaterThan(1);
    expect(loop.running()).toBe(false);
    loop.stop();
  });

  it("a still target writes the new bead position without scheduling frames", () => {
    const refs = runningRefs();
    const loop = startSprings(refs, 15, STOPS, WIDTH, { tail: false });
    vi.mocked(refs.thumb!.style.setProperty).mockClear();
    loop.target(130, 0);
    expect(loop.running()).toBe(false);
    expect(refs.thumb!.style.setProperty).toHaveBeenLastCalledWith("transform", "translate3d(130.00px, 0, 0) scale(1.0000, 1.0000)");
    loop.stop();
  });

  it("a still press writes the resting bead without scheduling frames", () => {
    const refs = runningRefs();
    const loop = startSprings(refs, 15, STOPS, WIDTH, { tail: false });
    vi.mocked(refs.thumb!.style.setProperty).mockClear();
    loop.press(true, 0);
    vi.mocked(refs.thumb!.style.setProperty).mockClear();
    loop.press(false);
    expect(request).not.toHaveBeenCalled();
    expect(loop.running()).toBe(false);
    expect(refs.neck!.getAttribute("d")).toBe("");
    loop.stop();
  });

  it("stop cancels pending frames and later targets do nothing", () => {
    const refs = runningRefs();
    const loop = startSprings(refs, 15, STOPS, WIDTH, { tail: true });
    loop.target(72.5, 0);
    loop.stop();
    expect(cancel).toHaveBeenCalled();
    expect(loop.running()).toBe(false);
    const calls = vi.mocked(refs.stops!.style.setProperty).mock.calls.length;
    loop.target(130, 0);
    expect(refs.stops!.style.setProperty).toHaveBeenCalledTimes(calls);
  });
});
