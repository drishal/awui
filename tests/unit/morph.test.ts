import { afterEach, describe, expect, it, vi } from "vitest";
import { flight, handoff, pending, takeBox, viewTransition, type Box } from "../../src/web/morph.js";

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
