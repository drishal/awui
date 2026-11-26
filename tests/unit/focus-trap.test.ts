// The drawer's Tab wrap: the ends of a trapped surface point at each other, and every Tab between them stays
// the browser's own.
import { describe, expect, it } from "vitest";
import { trapTarget } from "../../src/web/focus-trap.js";

describe("trapTarget", () => {
  it("wraps forward from the last element to the first, and backward from the first to the last", () => {
    expect(trapTarget(4, 3, false)).toBe(0);
    expect(trapTarget(4, 0, true)).toBe(3);
  });

  it("leaves every Tab between the ends to the browser", () => {
    expect(trapTarget(4, 1, false)).toBeNull();
    expect(trapTarget(4, 2, false)).toBeNull();
    expect(trapTarget(4, 1, true)).toBeNull();
  });

  it("starts at the first element (last, backwards) when nothing inside has the focus", () => {
    expect(trapTarget(3, -1, false)).toBe(0);
    expect(trapTarget(3, -1, true)).toBe(2);
  });

  it("traps nothing in an empty surface", () => {
    expect(trapTarget(0, -1, false)).toBeNull();
    expect(trapTarget(0, 0, true)).toBeNull();
  });
});
