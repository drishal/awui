import { describe, expect, it } from "vitest";
import { DEFAULT_SIDE_RATIO, splitBounds, splitKey, splitWidth } from "../../src/web/split-layout.js";

const width = 1600;

describe("side-by-side geometry", () => {
  it("keeps two ordinary chats bounded, and reserves real terminal space beside them", () => {
    expect(splitWidth(width, 0, false)).toBe(splitBounds(width, false).max);
    expect(splitWidth(width, 1, false)).toBe(splitBounds(width, false).min);
    expect(splitWidth(width, DEFAULT_SIDE_RATIO)).toBe(Math.round((width - 9) / 2));
    // A terminal must not crowd out the side chat: only half of the main chat
    // can be used while its full-width project terminal occupies the other half.
    const terminalStart = splitWidth(width, DEFAULT_SIDE_RATIO, true);
    const side = width - terminalStart;
    expect(side).toBeGreaterThanOrEqual(400);
    expect(terminalStart).toBe(splitBounds(width, true).max);
    expect(splitKey("ArrowRight", terminalStart, width, true)).toBe(terminalStart);
  });

  it("arrow/Home/End/Enter produce finite keyboard states at each viewport width", () => {
    for (const tool of [false, true]) for (const width of [1179, 1280, 1920]) {
      expect(splitKey("Home", 500, width, tool)).toBe(splitBounds(width, tool).min);
      expect(splitKey("End", 500, width, tool)).toBe(splitBounds(width, tool).max);
      expect(splitKey("Enter", 500, width, tool)).toBe(splitWidth(width, 0.5, tool));
      const current = tool ? splitBounds(width, true).min : splitWidth(width, DEFAULT_SIDE_RATIO, tool);
      const right = splitKey("ArrowRight", current, width, tool);
      expect(right).toBeGreaterThan(current);
      if (tool) expect(right).toBe(Math.min(splitBounds(width, true).max, current + 16));
      const left = splitKey("ArrowLeft", right!, width, tool);
      expect(left).toBe(right! - 16);
      expect(splitKey("Backspace", 500, width, tool)).toBeNull();
    }
  });
});
