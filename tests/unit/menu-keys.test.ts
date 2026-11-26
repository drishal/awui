// A menu's walk: the arrows and Home/End through its items, wrapping in a menu and clamping in a list.
import { describe, expect, it } from "vitest";
import { menuStep } from "../../src/web/menu-focus.js";

describe("menuStep", () => {
  it("walks down and up, wrapping at both ends", () => {
    expect(menuStep("ArrowDown", 0, 3)).toBe(1);
    expect(menuStep("ArrowDown", 2, 3)).toBe(0);
    expect(menuStep("ArrowUp", 0, 3)).toBe(2);
    expect(menuStep("ArrowUp", 1, 3)).toBe(0);
  });

  it("enters at the first item walking down and at the last walking up, when nothing has the focus", () => {
    expect(menuStep("ArrowDown", -1, 4)).toBe(0);
    expect(menuStep("ArrowUp", -1, 4)).toBe(3);
  });

  it("jumps to either end and clamps where the list has to stop", () => {
    expect(menuStep("Home", 2, 4)).toBe(0);
    expect(menuStep("End", 1, 4)).toBe(3);
    expect(menuStep("ArrowDown", 3, 4, false)).toBe(3);
    expect(menuStep("ArrowUp", 0, 4, false)).toBe(0);
  });

  it("leaves every other key alone, and an empty menu", () => {
    for (const key of ["Enter", " ", "Escape", "Tab", "ArrowLeft", "ArrowRight", "a"]) expect(menuStep(key, 0, 3)).toBeNull();
    expect(menuStep("ArrowDown", 0, 0)).toBeNull();
  });
});
