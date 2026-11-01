// The model picker's measured morph (model-morph.ts): the clip the panel uncovers from.
import { describe, expect, it } from "vitest";
import { morphClip } from "../../src/web/model-morph.js";

const rect = (top: number, left: number, width: number, height: number) => ({ top, left, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) });

describe("morphClip", () => {
  it("starts the panel's clip at the chip's rect", () => {
    // Panel 440x300 at (100, 200); chip 120x32 at its bottom-left, 10px above the panel's bottom.
    expect(morphClip(rect(490, 110, 120, 32), rect(200, 100, 440, 300))).toBe("inset(290px 310px 0px 10px)");
  });
  it("clamps a chip hanging past the panel's edge, hiding the panel until it uncovers", () => {
    expect(morphClip(rect(0, 0, 40, 40), rect(200, 100, 440, 300))).toBe("inset(0px 500px 460px 0px)");
  });
});
