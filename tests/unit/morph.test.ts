import { describe, expect, it } from "vitest";
import { flight, handoff, pending, takeBox, type Box } from "../../src/web/morph.js";

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height });

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
