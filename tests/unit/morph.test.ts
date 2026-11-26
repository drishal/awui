import { afterEach, describe, expect, it, vi } from "vitest";
import { firstLineBox, flight, glide, handoff, land, landTitle, pending, takeBox, viewTransition, withinReach, TITLE_REACH_PX, type Box } from "../../src/web/morph.js";

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

describe("a title's arrival", () => {
  const header = (top: number) => ({ getAnimations: () => [], getBoundingClientRect: () => ({ left: 0, top, width: 200, height: 22 }), animate: vi.fn() }) as unknown as HTMLElement & { animate: ReturnType<typeof vi.fn> };

  it("flies only from within reach, and settles in place from further away", () => {
    expect(withinReach(box(0, 300, 100, 18), box(0, 44, 200, 22), TITLE_REACH_PX)).toBe(true);
    expect(withinReach(box(0, 44 + TITLE_REACH_PX, 100, 18), box(0, 44, 200, 22), TITLE_REACH_PX)).toBe(true);
    expect(withinReach(box(0, 45 + TITLE_REACH_PX, 100, 18), box(0, 44, 200, 22), TITLE_REACH_PX)).toBe(false);
    // The rail's own geometry: its first row sits about 270 px below the header, a deep one much further.
    expect(withinReach(box(0, 312, 100, 18), box(0, 44, 200, 22), TITLE_REACH_PX)).toBe(true);
    expect(withinReach(box(0, 434, 100, 18), box(0, 44, 200, 22), TITLE_REACH_PX)).toBe(false);
  });

  it("makes a near row's title fly, eased, with no spring behind it", () => {
    stubPage();
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: (name: string) => (name === "--ease-out" ? "cubic-bezier(0.16, 1, 0.3, 1)" : "linear") }));
    const el = header(44);
    handoff("sidebar-title", box(53, 312, 113, 18), 1000);
    expect(landTitle("sidebar-title", el, 1100)).not.toBeNull();
    const [frames, timing] = el.animate.mock.calls[0] as unknown as [Array<Record<string, string>>, { id: string; duration: number; easing: string; fill: string }];
    expect(frames[0]?.transform).toBe("translate(53px, 268px)");
    expect(timing).toMatchObject({ id: "morph:sidebar-title", duration: 240, easing: "cubic-bezier(0.16, 1, 0.3, 1)", fill: "backwards" });
  });

  it("keeps a far row's title partly visible where it belongs instead of dragging it across the rail", () => {
    stubPage();
    vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "linear" }));
    const el = header(44);
    handoff("sidebar-title", box(53, 700, 113, 18), 1000);
    landTitle("sidebar-title", el, 1100);
    const [frames, timing] = el.animate.mock.calls[0] as unknown as [Array<Record<string, string | number>>, { id: string; duration: number; easing: string }];
    expect(frames[0]).toMatchObject({ opacity: 0.35, transform: "translateY(3px)" });
    expect(frames[1]).toMatchObject({ opacity: 1, transform: "none" });
    expect(timing).toMatchObject({ id: "morph:sidebar-title", duration: 180, easing: "linear" });
  });

  it("shows nothing at all under reduced motion, and nothing without a box", () => {
    stubPage({ reduce: true });
    const quiet = header(44);
    handoff("sidebar-title", box(53, 312, 113, 18), 1000);
    expect(landTitle("sidebar-title", quiet, 1100)).toBeNull();
    expect(quiet.animate).not.toHaveBeenCalled();
    vi.unstubAllGlobals();

    stubPage();
    expect(landTitle("sidebar-title", header(44), 1100)).toBeNull();
  });

  it("hands a wrapped title over as its first line, not as a two-line box", () => {
    vi.stubGlobal("document", {
      createRange: () => ({
        selectNodeContents: () => {},
        getClientRects: () => [
          { left: 53, top: 308, width: 113, height: 18 },
          { left: 53, top: 326, width: 80, height: 18 },
        ],
      }),
    });
    const span = { getBoundingClientRect: () => ({ left: 53, top: 308, width: 179, height: 36 }) } as unknown as Element;
    expect(firstLineBox(span)).toEqual({ left: 53, top: 308, width: 113, height: 18 });
    expect(firstLineBox(null)).toBeNull();
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
    expect(viewTransition(commit)).toBeDefined();
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
