// The breakdown chip: which pile a changed path falls in, and the lines each pile holds.
import { describe, expect, it } from "vitest";
import { breakdown, breakdownText, breakdownTitle, bucketOf, DEFAULT_BREAKDOWN_RULES, matchesGlob, type BreakdownFile } from "../../src/shared/breakdown.js";
import { breakdownRules } from "../../src/server/user-config.js";

const file = (path: string, added: number, removed = 0): BreakdownFile => ({ path, added, removed });

describe("a changed path's kind", () => {
  it("reads tests from their name or their folder", () => {
    expect(bucketOf("src/app.test.ts")).toBe("tests");
    expect(bucketOf("src/app.spec.tsx")).toBe("tests");
    expect(bucketOf("src/__tests__/app.ts")).toBe("tests");
    expect(bucketOf("tests/unit/app.ts")).toBe("tests");
    expect(bucketOf("app_test.go")).toBe("tests");
    expect(bucketOf("src/app.ts")).toBe("source");
  });

  it("reads generated output from lockfiles, builds, and minified files", () => {
    expect(bucketOf("package-lock.json")).toBe("generated");
    expect(bucketOf("dist/web/index.js")).toBe("generated");
    expect(bucketOf("src/app.min.js")).toBe("generated");
    expect(bucketOf("Cargo.lock")).toBe("generated");
    // Windows-style separators read the same.
    expect(bucketOf("dist\\web\\index.js")).toBe("generated");
  });

  it("counts a generated test file as generated, since nobody reviews it", () => {
    expect(bucketOf("dist/out.test.js")).toBe("generated");
  });

  it("takes the project's own globs over the defaults", () => {
    const rules = { tests: ["**/*_spec.rb"], generated: ["**/assets/**"] };
    // The folder is not a rule here, only the name: rspec's `spec/` stays source.
    expect(bucketOf("spec/models/user.rb", rules)).toBe("source");
    expect(bucketOf("app/models/user_spec.rb", rules)).toBe("tests");
    expect(bucketOf("src/assets/logo.svg", rules)).toBe("generated");
    expect(bucketOf("src/models/user.rb", rules)).toBe("source");
  });
});

describe("a glob", () => {
  it("lets a double star cross folders, and stand for none when a slash follows", () => {
    expect(matchesGlob("a/b/c.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("c.ts", "**/*.ts")).toBe(true);
    expect(matchesGlob("a/b/c.ts", "src/**")).toBe(false);
  });

  it("keeps a single star inside one segment", () => {
    expect(matchesGlob("src/app.ts", "src/*.ts")).toBe(true);
    expect(matchesGlob("src/deep/app.ts", "src/*.ts")).toBe(false);
  });

  it("treats a trailing slash as everything under that folder", () => {
    expect(matchesGlob("build/anything/x.js", "build/")).toBe(true);
    expect(matchesGlob("buildx/x.js", "build/")).toBe(false);
  });
});

describe("the split", () => {
  it("adds each pile's lines and files, in source, tests, generated order", () => {
    const counts = breakdown([file("src/a.ts", 40, 2), file("src/b.ts", 10), file("tests/a.test.ts", 30), file("package-lock.json", 1200)]);
    expect(counts.map((row) => [row.bucket, row.lines, row.files])).toEqual([
      ["source", 52, 2],
      ["tests", 30, 1],
      ["generated", 1200, 1],
    ]);
  });

  it("leaves out a pile with no file, and keeps a binary file's own count out of the lines", () => {
    expect(breakdown([file("src/a.ts", 5)]).map((row) => row.bucket)).toEqual(["source"]);
    expect(breakdown([file("logo.png", 0, 0)]).map((row) => [row.bucket, row.lines, row.files])).toEqual([["source", 0, 1]]);
  });

  it("never counts a negative or missing count below zero", () => {
    expect(breakdown([file("src/a.ts", -4, 3)])[0]?.lines).toBe(3);
  });

  it("words the chip only when there is more than one pile to compare", () => {
    expect(breakdownText(breakdown([file("src/a.ts", 5)]))).toBeNull();
    const counts = breakdown([file("src/a.ts", 320), file("tests/a.test.ts", 80), file("yarn.lock", 1204)]);
    expect(breakdownText(counts)).toBe("Source 320 · Tests 80 · Generated 1,204");
    expect(breakdownTitle(counts, DEFAULT_BREAKDOWN_RULES)).toContain("Tests: 1 file, +80 −0 (**/*.test.*");
    expect(breakdownTitle(counts)).toContain("Source: 1 file, +320 −0 (everything else)");
  });
});

describe("config.yml's breakdown block", () => {
  it("takes the project's own list over the default one, and the default where the file says nothing", () => {
    expect(breakdownRules(undefined)).toEqual(DEFAULT_BREAKDOWN_RULES);
    expect(breakdownRules({ breakdown: { tests: ["**/*_spec.rb"] } })).toEqual({ tests: ["**/*_spec.rb"], generated: DEFAULT_BREAKDOWN_RULES.generated });
  });
});
