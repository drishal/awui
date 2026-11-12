// The context ring's two colour lines and when it is drawn at all (context-tone.ts).
import { describe, expect, it } from "vitest";
import type { ContextUsage } from "../../src/shared/protocol.js";
import { CONTEXT_DANGER_PERCENT, CONTEXT_WARN_PERCENT, contextTone, hasContextFigure } from "../../src/web/context-tone.js";

const ctx = (percent: number | null, window = 200_000): ContextUsage => ({ tokens: percent === null ? null : (percent / 100) * window, window, percent });

describe("contextTone", () => {
  it("stays quiet until the window is 75 % full", () => {
    expect(contextTone(0)).toBe("ok");
    expect(contextTone(42)).toBe("ok");
    expect(contextTone(74.9)).toBe("ok");
  });

  it("turns amber at 75 % and stays amber below 90 %", () => {
    expect(contextTone(75)).toBe("warn");
    expect(contextTone(82)).toBe("warn");
    expect(contextTone(89.9)).toBe("warn");
  });

  it("turns red at 90 % and keeps the red past it", () => {
    expect(contextTone(90)).toBe("danger");
    expect(contextTone(100)).toBe("danger");
  });

  it("pins the two lines the ring draws against", () => {
    expect(CONTEXT_WARN_PERCENT).toBe(75);
    expect(CONTEXT_DANGER_PERCENT).toBe(90);
    expect(contextTone(CONTEXT_WARN_PERCENT - 0.1)).toBe("ok");
    expect(contextTone(CONTEXT_DANGER_PERCENT - 0.1)).toBe("warn");
  });
});

describe("hasContextFigure", () => {
  it("is false with no report at all", () => {
    expect(hasContextFigure(null)).toBe(false);
  });

  it("is false while the harness cannot say how full the window is", () => {
    expect(hasContextFigure(ctx(null))).toBe(false);
    expect(hasContextFigure({ tokens: 1200, window: 200_000, percent: null })).toBe(false);
  });

  it("is false for a context too small to draw, which would read as a spinner", () => {
    expect(hasContextFigure(ctx(0))).toBe(false);
    expect(hasContextFigure(ctx(0.4))).toBe(false);
  });

  it("is true from half a percent", () => {
    expect(hasContextFigure(ctx(0.5))).toBe(true);
    expect(hasContextFigure(ctx(61))).toBe(true);
  });
});
