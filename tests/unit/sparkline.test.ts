import { describe, expect, it } from "vitest";
import type { ContextPoint } from "../../src/shared/protocol.js";
import { downsample, percents, SPARK_H, SPARK_MAX_POINTS, SPARK_W, sparkline } from "../../src/web/sparkline.js";

const pts = (...p: Array<number | null>): ContextPoint[] => p.map((percent) => ({ percent, tokens: null }));

describe("sparkline", () => {
  it("needs two readings with a percent", () => {
    expect(sparkline(pts())).toBeNull();
    expect(sparkline(pts(10))).toBeNull();
    expect(sparkline(pts(10, null))).toBeNull();
    expect(percents(pts(10, null, 30))).toEqual([10, 30]);
  });

  it("scales on a fixed 0-100 axis inside the box", () => {
    const s = sparkline(pts(0, 100))!;
    expect(s.points[0]).toMatchObject({ x: 3, y: SPARK_H - 3 });
    expect(s.points[1]).toMatchObject({ x: SPARK_W - 3, y: 3 });
    expect(s.warnY).toBeGreaterThan(3);
    expect(s.warnY).toBeLessThan(6);
    expect(s.path.startsWith("M3 25 L117 3")).toBe(true);
  });

  it("closes the line down to the floor for the full view's area, and names where it ends", () => {
    const s = sparkline(pts(0, 100))!;
    expect(s.end).toEqual({ x: SPARK_W - 3, y: 3 });
    expect(s.area).toBe(`${s.path} L${SPARK_W - 3} ${SPARK_H - 3} L3 ${SPARK_H - 3} Z`);
  });

  it("thins a long history to 60 points, keeping the ends", () => {
    const values = Array.from({ length: 500 }, (_, i) => i / 5);
    const out = downsample(values);
    expect(out).toHaveLength(SPARK_MAX_POINTS);
    expect(out[0]?.value).toBe(0);
    expect(out.at(-1)?.value).toBe(99.8);
  });

  it("keeps a compaction that falls between kept readings", () => {
    const values = Array.from({ length: 300 }, (_, i) => (i < 151 ? i / 4 : (i - 151) / 4));
    const out = downsample(values);
    expect(out.filter((p) => p.drop)).toHaveLength(1);
    const s = sparkline(pts(...values))!;
    expect(s.points).toHaveLength(60);
    expect(s.label).toBe("Context per turn: 0% … 37%, compacted 1 time");
  });

  it("does not call a small wobble a compaction", () => {
    expect(downsample([40, 38, 41]).some((p) => p.drop)).toBe(false);
  });

  it("describes the line for a screen reader", () => {
    expect(sparkline(pts(12, 30, 61))!.label).toBe("Context per turn: 12% … 61%");
  });
});
