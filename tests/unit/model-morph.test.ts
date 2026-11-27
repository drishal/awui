// The model picker's measured morph (model-morph.ts): the clip the panel uncovers from.
import { describe, expect, it } from "vitest";
import { morphClip } from "../../src/web/model-morph.js";

const rect = (top: number, left: number, width: number, height: number) => ({ top, left, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) });

describe("morphClip", () => {
  it("starts the panel's clip at the chip's rect", () => {
    // Panel 440x300 at (100, 200); chip 120x32 at its bottom-left, 10px above the panel's bottom.
    expect(morphClip(rect(490, 110, 120, 32), rect(200, 100, 440, 300))).toBe("inset(290px 310px 0px 10px)");
  });
  it("starts a tall popup at its lower edge, below its model chip", () => {
    // Two viewport rects normalized into the popup's own space, as usePopupMorph does.
    expect(morphClip({ top: 287, left: 279, right: 351, bottom: 319 }, { top: 0, left: 0, right: 440, bottom: 213 }))
      .toBe("inset(100% 89px 0px 279px)");
  });
  it("starts from the facing edge of a wholly side-adjacent chip", () => {
    expect(morphClip({ top: 5, left: -72, right: -12, bottom: 37 }, { top: 0, left: 0, right: 440, bottom: 300 }))
      .toBe("inset(5px 100% 263px 0px)");
  });
  it("clips an overhanging trigger to the panel instead of moving it to the far edge", () => {
    expect(morphClip({ top: 250, left: 10, right: 570, bottom: 282 }, { top: 0, left: 0, right: 440, bottom: 300 }))
      .toBe("inset(250px 0px 18px 10px)");
  });
});
