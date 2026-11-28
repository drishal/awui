// The popovers' measured motion: the direction of the panel's short glide follows its trigger.
import { describe, expect, it } from "vitest";

import { morphShift } from "../../src/web/model-morph.js";

const rect = (top: number, left: number, width: number, height: number) => ({ top, left, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON: () => ({}) });

describe("morphShift", () => {
  it("rises toward a trigger below the panel", () => {
    expect(morphShift(rect(530, 110, 120, 32), rect(200, 100, 440, 300))).toEqual({ x: 0, y: 12 });
  });

  it("rises from a local trigger below a tall panel", () => {
    expect(morphShift({ top: 287, left: 279, right: 351, bottom: 319 }, { top: 0, left: 0, right: 440, bottom: 213 })).toEqual({ x: 0, y: 12 });
  });

  it("travels from the facing edge of a wholly side-adjacent trigger", () => {
    expect(morphShift({ top: 5, left: -72, right: -12, bottom: 37 }, { top: 0, left: 0, right: 440, bottom: 300 })).toEqual({ x: 12, y: 0 });
  });

  it("does not invent a direction for an overlapping trigger", () => {
    expect(morphShift({ top: 250, left: 10, right: 570, bottom: 282 }, { top: 0, left: 0, right: 440, bottom: 300 })).toEqual({ x: 0, y: 0 });
  });
  it("takes the nearer facing edge for a diagonal trigger", () => {
    expect(morphShift({ top: 330, left: -30, right: 20, bottom: 360 }, { top: 0, left: 0, right: 440, bottom: 300 })).toEqual({ x: 0, y: 12 });
    expect(morphShift({ top: 330, left: -95, right: -25, bottom: 360 }, { top: 0, left: 0, right: 440, bottom: 300 })).toEqual({ x: 12, y: 0 });
  });
});
