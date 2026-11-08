import { afterEach, describe, expect, it } from "vitest";
import { draftImages, forgetDraftImages, saveDraftImages } from "../../src/web/draft-images.js";
import type { PendingImage } from "../../src/web/images.js";

const image = (id: number): PendingImage => ({ id, mimeType: "image/png", data: "AAAA", width: 2, height: 2 });

afterEach(() => forgetDraftImages());

describe("the composer's draft images", () => {
  it("keeps each chat's images apart, so a tab switch brings its own back", () => {
    saveDraftImages("a", [image(1), image(2)]);
    saveDraftImages("b", [image(3)]);
    expect(draftImages("a").map((i) => i.id)).toEqual([1, 2]);
    expect(draftImages("b").map((i) => i.id)).toEqual([3]);
    expect(draftImages("c")).toEqual([]);
  });

  it("forgets a chat's images when they are cleared, as a sent prompt does", () => {
    saveDraftImages("a", [image(1)]);
    saveDraftImages("a", []);
    expect(draftImages("a")).toEqual([]);
  });

  it("keeps four chats at most, dropping the one stored longest ago", () => {
    for (const id of ["a", "b", "c", "d"]) saveDraftImages(id, [image(1)]);
    // Reading `a` makes it the newest, so `b` is the one to go.
    draftImages("a");
    saveDraftImages("e", [image(1)]);
    expect(draftImages("b")).toEqual([]);
    expect(draftImages("a")).toHaveLength(1);
    expect(draftImages("e")).toHaveLength(1);
  });
});
