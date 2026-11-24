import { describe, expect, it } from "vitest";
import { fitFooter } from "../../src/atui/footer.js";

const segs = [
  { id: "git", width: 18, rank: 2 },
  { id: "rate", width: 22, rank: 4 },
  { id: "spark", width: 13, rank: 5 },
  { id: "ctx", width: 9, rank: 1 },
];

describe("fitFooter", () => {
  it("keeps everything that fits", () => {
    expect([...fitFooter(segs, 62)].sort()).toEqual(["ctx", "git", "rate", "spark"]);
  });
  it("drops whole segments, the least important first", () => {
    expect([...fitFooter(segs, 50)].sort()).toEqual(["ctx", "git", "rate"]);
    expect([...fitFooter(segs, 30)].sort()).toEqual(["ctx", "git"]);
  });
  it("always keeps the most important one, even alone and too wide", () => {
    expect([...fitFooter(segs, 4)]).toEqual(["ctx"]);
  });
  it("ignores segments that draw nothing", () => {
    expect([...fitFooter([{ id: "x", width: 0, rank: 9 }, ...segs], 62)]).not.toContain("x");
  });
});
