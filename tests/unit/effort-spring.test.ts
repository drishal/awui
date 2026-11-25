import { afterEach, describe, expect, it, vi } from "vitest";
import { springRested, startSprings, stepSpring, stretchOf, type SpringState } from "../../src/web/effort-spring.js";

/** A jsdom-free element: only the style writes the loop makes, kept as one named shape. */
interface MockEl {
  style: { setProperty: (k: string, v: string) => void };
}

const mockEl = (): MockEl & HTMLElement => {
  const writes = { setProperty: vi.fn() };
  return { style: writes } as unknown as MockEl & HTMLElement;
};

/** The writes a mock recorded. */
type Writes = Array<[string, string]>;

const writesOf = (el: MockEl & HTMLElement): Writes => (el.style.setProperty as unknown as { mock: { calls: Writes } }).mock.calls;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("effort spring", () => {
  it("integrates a spring toward its target and rests near it", () => {
    const s: SpringState = { x: 0, v: 0 };
    for (let i = 0; i < 2000; i++) stepSpring(s, 100, 560, 36, 1 / 120);
    expect(Math.abs(s.x - 100)).toBeLessThan(0.3);
    expect(springRested(s, 100)).toBe(true);
  });
  it("overshoots a little, like a spring, not an ease", () => {
    const s: SpringState = { x: 0, v: 0 };
    let peak = 0;
    for (let i = 0; i < 400; i++) {
      stepSpring(s, 100, 560, 36, 1 / 120);
      peak = Math.max(peak, s.x);
    }
    expect(peak).toBeGreaterThan(100);
    expect(peak).toBeLessThan(106);
  });
  it("clamps a dropped frame: a 2 s gap moves one 32 ms frame, not an explosion", () => {
    const raf = { cb: null as ((at: number) => void) | null };
    vi.stubGlobal("performance", { now: () => 1000 });
    vi.stubGlobal("requestAnimationFrame", vi.fn((cb: (at: number) => void) => {
      raf.cb = cb;
      return 7;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const track = mockEl();
    const loop = startSprings({ thumb: mockEl(), tail: null, shine: null, track }, 0, { tail: false });
    loop.target(100);
    expect(raf.cb).toBeTruthy();
    // The first frame arrives on time (16 ms), the second 2 s late: one clamped frame, not 2 s of springs.
    raf.cb?.(1016);
    const onTime = writesOf(track).findLast(([k]) => k === "--x")?.[1] ?? "";
    raf.cb?.(3016);
    const late = Number.parseFloat(writesOf(track).findLast(([k]) => k === "--x")?.[1] ?? "");
    const punctual = Number.parseFloat(onTime);
    expect(late).toBeGreaterThan(punctual);
    // Two clamped frames of 32 ms are bounded: under a third of the way at spring speed, not metres away.
    expect(late - punctual).toBeLessThan(40);
    loop.stop();
  });
  it("stretches with velocity and keeps the area", () => {
    expect(stretchOf(0)).toEqual({ sx: 1, sy: 1 });
    const { sx, sy } = stretchOf(600);
    expect(sx).toBeGreaterThan(1);
    expect(sx * sy * sy).toBeCloseTo(1, 5);
    // Capped at 30 %.
    expect(stretchOf(9999).sx).toBe(1.3);
  });
  it("writes transform and --x, never left or width, and rests without a loop", () => {
    vi.stubGlobal("performance", { now: () => 1000 });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 7));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const track = mockEl();
    const thumb = mockEl();
    const loop = startSprings({ thumb, tail: null, shine: null, track }, 20, { tail: false });
    // First paint: at rest, no loop, --x written once.
    expect(loop.running()).toBe(false);
    expect(writesOf(track).some(([k, v]) => k === "--x" && v === "20.00px")).toBe(true);
    const keys = writesOf(thumb).map(([k]) => k);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => k === "transform")).toBe(true);
    loop.target(120);
    expect(loop.running()).toBe(true);
    loop.rest(120);
    expect(loop.running()).toBe(false);
    expect(writesOf(track).some(([k, v]) => k === "--x" && v === "120.00px")).toBe(true);
    loop.stop();
  });
  it("kicks the wobble on land: a kick with no target still starts the loop", () => {
    vi.stubGlobal("performance", { now: () => 1000 });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 7));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const thumb = mockEl();
    const loop = startSprings({ thumb, tail: null, shine: null, track: null }, 50, { tail: false });
    loop.kick();
    expect(loop.running()).toBe(true);
    loop.stop();
  });
  it("stops dead: no writes after stop", () => {
    vi.stubGlobal("performance", { now: () => 1000 });
    vi.stubGlobal("requestAnimationFrame", vi.fn(() => 7));
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const thumb = mockEl();
    const loop = startSprings({ thumb, tail: null, shine: null, track: null }, 0, { tail: false });
    loop.stop();
    const count = writesOf(thumb).length;
    loop.target(80);
    loop.kick();
    expect(writesOf(thumb).length).toBe(count);
  });
});
