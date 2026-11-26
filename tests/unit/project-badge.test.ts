// A project's monogram (project-badge.ts): a letter, and a colour slot that does not move.
import { describe, expect, it } from "vitest";
import { projectMonogram, projectSlots } from "../../src/web/project-badge.js";

describe("a project's monogram", () => {
  it("takes the first letter, in one of the four badge colours", () => {
    const badge = projectMonogram("alpha");
    expect(badge.letter).toBe("A");
    expect([1, 2, 3, 4]).toContain(badge.slot);
    expect(projectMonogram("alpha")).toEqual(badge);
  });

  it("skips leading punctuation, keeps a digit, and has an answer for a nameless folder", () => {
    expect(projectMonogram("  _wild-project").letter).toBe("W");
    expect(projectMonogram("42-answers").letter).toBe("4");
    expect(projectMonogram("émile").letter).toBe("É");
    expect(projectMonogram("   ").letter).toBe("?");
  });

  it("gives different names different colours, mostly", () => {
    const slots = new Set(["alpha", "beta", "gamma", "webui", "dotfiles"].map((n) => projectMonogram(n).slot));
    expect(slots.size).toBeGreaterThan(1);
  });
});

describe("a sidebar's badges together", () => {
  it("gives every project of a small set a hue of its own", () => {
    const slots = projectSlots(["awui", "dotfiles", "drishal-notes"]);
    expect(new Set([...slots.values()]).size, "three folders, three hues").toBe(3);
  });

  it("is stable: a hue depends on the set of projects, not on the order they are drawn in", () => {
    const one = projectSlots(["awui", "dotfiles", "drishal-notes"]);
    const other = projectSlots(["drishal-notes", "awui", "dotfiles"]);
    expect([...other]).toEqual([...one]);
    expect(other.get("awui")).toBe(one.get("awui"));
  });
});
