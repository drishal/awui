import { afterEach, describe, expect, it, vi } from "vitest";
import { flight, glide, handoff, land, pending, takeBox, viewTransition, type Box } from "../../src/web/morph.js";

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height });

/** A page that can start a view transition, and a reader who has not asked for any less. */
function stubPage({ reduce = false, coarse = false } = {}) {
  const started = vi.fn((update: () => void) => {
    update();
    return { finished: Promise.resolve() };
  });
  vi.stubGlobal("Element", class {});
  Object.defineProperty(Element.prototype, "animate", { value: () => ({}), configurable: true });
  vi.stubGlobal("document", { startViewTransition: started });
  vi.stubGlobal("window", { matchMedia: (query: string) => ({ matches: query.includes("reduced-motion") ? reduce : coarse }) });
  return started;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("morph", () => {
  it("hands a box to its claimant once, and not after it has gone stale", () => {
    handoff("a", box(1, 2, 3, 4), 1000);
    expect(pending("a", 1100)).toBe(true);
    expect(takeBox("a", 1200)).toEqual(box(1, 2, 3, 4));
    expect(pending("a", 1300)).toBe(false);
    expect(takeBox("a", 1300)).toBeNull();
    handoff("old", box(0, 0, 1, 1), 0);
    expect(pending("old", 10_000)).toBe(false);
    expect(takeBox("old", 10_000)).toBeNull();
  });
  it("forgets a box when handed null, and keeps keys apart", () => {
    handoff("x", box(1, 1, 1, 1), 0);
    handoff("y", box(2, 2, 2, 2), 0);
    handoff("x", null, 0);
    expect(takeBox("x", 1)).toBeNull();
    expect(takeBox("y", 1)).toEqual(box(2, 2, 2, 2));
  });
  it("moves from the new place back to the old one, in whole pixels, and not at all when they coincide", () => {
    expect(flight(box(10, 100, 500, 120), box(10, 600, 500, 90))).toEqual({ dx: 0, dy: -500, dh: false });
    expect(flight(box(10.4, 100.4, 500, 120), box(10, 100, 500, 120))).toBeNull();
  });
  it("counts a height change as movement only when asked to carry it", () => {
    expect(flight(box(0, 0, 500, 120), box(0, 0, 500, 90))).toBeNull();
    expect(flight(box(0, 0, 500, 120), box(0, 0, 500, 90), true)).toEqual({ dx: 0, dy: 0, dh: true });
    expect(flight(box(0, 0, 500, 90.3), box(0, 0, 500, 90), true)).toBeNull();
  });
});

describe("glide", () => {
  it("travels from a box the caller measured, and takes over from a glide already running on the element", () => {
    stubPage();
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "linear" }));
    const running = { id: "morph:glide", cancel: vi.fn(), oncancel: null, onfinish: null };
    const animate = vi.fn(() => ({ id: "morph:glide", oncancel: null, onfinish: null }));
    const el = {
      getAnimations: () => [running],
      getBoundingClientRect: () => ({ left: 100, top: 300, width: 200, height: 40 }),
      animate,
    } as unknown as HTMLElement;
    glide(box(100, 200, 200, 40), el);
    expect(running.cancel).toHaveBeenCalledTimes(1);
    const [frames, timing] = animate.mock.calls[0] as unknown as [Array<Record<string, string>>, { duration: number; easing: string }];
    expect(frames[0]?.transform).toBe("translate(0px, -100px)");
    expect(frames[1]?.transform).toBe("none");
    expect(frames[0]?.height).toBeUndefined();
    expect(timing).toMatchObject({ duration: 420, easing: "linear" });
    // Nothing to glide to: same box, no travel.
    expect(glide(box(100, 300, 200, 40), el)).toBeNull();
    expect(glide(box(0, 0, 1, 1), null)).toBeNull();
  });
  it("names a glide the caller's id gives it, and takes over only its own id", () => {
    stubPage();
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "linear" }));
    const other = { id: "morph:other", cancel: vi.fn(), oncancel: null, onfinish: null };
    const animate = vi.fn(() => ({ id: "morph:start-card", oncancel: null, onfinish: null }));
    const el = {
      getAnimations: () => [other],
      getBoundingClientRect: () => ({ left: 10, top: 20, width: 30, height: 40 }),
      animate,
    } as unknown as HTMLElement;
    glide(box(10, 60, 30, 40), el, { id: "morph:start-card" });
    const [frames, timing] = animate.mock.calls[0] as unknown as [Array<Record<string, string>>, { id: string }];
    expect(frames[0]?.transform).toBe("translate(0px, 40px)");
    expect(timing).toMatchObject({ id: "morph:start-card" });
    // A glide of another id keeps running: one claim per id, not per element.
    expect(other.cancel).not.toHaveBeenCalled();
  });
  it("lands with the handoff key as the glide's id", () => {
    stubPage();
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "linear" }));
    const animate = vi.fn(() => ({ id: "morph:start-card", oncancel: null, onfinish: null }));
    const el = {
      getAnimations: () => [],
      getBoundingClientRect: () => ({ left: 0, top: 500, width: 400, height: 60 }),
      animate,
    } as unknown as HTMLElement;
    handoff("start-card", box(0, 100, 400, 60), 1000);
    const run = land("start-card", el, {}, 1100);
    expect(run).not.toBeNull();
    const [, timing] = animate.mock.calls[0] as unknown as [unknown[], { id: string }];
    expect(timing).toMatchObject({ id: "morph:start-card" });
  });
});

describe("view transition", () => {
  it("swaps whole surfaces, and only where the platform can and nobody objects", () => {
    const started = stubPage();
    const commit = vi.fn();
    viewTransition(commit);
    expect(started).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit.mock.invocationCallOrder[0]).toBeGreaterThan(started.mock.invocationCallOrder[0] ?? 0);
  });

  it("hands a swap back to the plain cut while a run streams, on a phone, or under reduced motion", () => {
    stubPage().mockClear();
    const busy = vi.fn();
    viewTransition(busy, { busy: true });
    expect(busy).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();

    const phone = stubPage({ coarse: true });
    viewTransition(vi.fn());
    expect(phone).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    const quiet = stubPage({ reduce: true });
    const commit = vi.fn();
    viewTransition(commit);
    expect(quiet).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("runs the commit when the browser has no view transitions at all", () => {
    const commit = vi.fn();
    viewTransition(commit);
    expect(commit).toHaveBeenCalledTimes(1);
  });
});
