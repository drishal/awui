// The phone composer folds to one row only when folding hides nothing you are using.
import { describe, expect, it } from "vitest";
import { composerFolded, type FoldState } from "../../src/web/composer-fold.js";

const idle: FoldState = { phone: true, hero: false, closed: false, writing: false, text: "", images: 0, pastes: 0, menuOpen: false, dragging: false };

describe("composer fold", () => {
  it("folds an idle, empty phone composer", () => {
    expect(composerFolded(idle)).toBe(true);
  });
  it("stays open while it is in use, holds something, or is not a phone's", () => {
    for (const change of [{ writing: true }, { text: " " }, { images: 1 }, { pastes: 1 }, { menuOpen: true }, { dragging: true }, { phone: false }, { hero: true }, { closed: true }]) {
      expect(composerFolded({ ...idle, ...change })).toBe(false);
    }
  });
});
