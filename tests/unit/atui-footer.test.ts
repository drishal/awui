import { describe, expect, it } from "vitest";
import { fitFooter, spendWords } from "../../src/atui/footer.js";

describe("spendWords", () => {
  it("words the price and the cache's share, and leaves out what is unknown", () => {
    expect(spendWords({ input: 200, cachedInput: 800, cost: 0.1234 })).toBe("$0.12 · cache 80%");
    expect(spendWords({ input: 200, cachedInput: 0, cost: 0.004 })).toBe("<$0.01");
    expect(spendWords({ input: 200, cachedInput: 600, cost: null })).toBe("cache 75%");
    expect(spendWords({ input: 0, cachedInput: 0, cost: null })).toBe("");
    expect(spendWords(null)).toBe("");
  });
});

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
