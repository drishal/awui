import { describe, expect, it } from "vitest";
import { plainTitle } from "../../src/web/plain-title.js";

describe("plainTitle", () => {
  it("takes inline Markdown markers out of a title", () => {
    expect(plainTitle("hello tool, render **markdown** and a `code` span")).toBe("hello tool, render markdown and a code span");
    expect(plainTitle("fix the *flaky* test")).toBe("fix the flaky test");
    expect(plainTitle("drop ~~old~~ code")).toBe("drop old code");
    expect(plainTitle("read [the docs](https://example.com/x) first")).toBe("read the docs first");
    expect(plainTitle("## Plan the release")).toBe("Plan the release");
    expect(plainTitle("- add a test")).toBe("add a test");
    expect(plainTitle("use ``a `tick` inside``")).toBe("use a `tick` inside");
  });

  it("leaves words that only look like markers alone", () => {
    expect(plainTitle("rename my_var_name to other_name")).toBe("rename my_var_name to other_name");
    expect(plainTitle("2 * 3 * 4 is 24")).toBe("2 * 3 * 4 is 24");
    expect(plainTitle("glob **/*.ts files")).toBe("glob **/*.ts files");
    expect(plainTitle("growth of ~5% to ~10%")).toBe("growth of ~5% to ~10%");
    expect(plainTitle("v2.1 release")).toBe("v2.1 release");
  });

  it("never returns nothing", () => {
    expect(plainTitle("**")).toBe("**");
    expect(plainTitle("")).toBe("");
  });
});
