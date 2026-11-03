// A running test command's progress, read from what it has printed so far.
import { describe, expect, it } from "vitest";
import { testProgress } from "../../src/web/tool-facts.js";

describe("test progress", () => {
  it("reads Playwright's line reporter: the test starting and the failures so far", () => {
    const out = ["Running 27 tests using 1 worker", "[18/27] [chromium] › tests/e2e/a.spec.ts:3:1 › one", "  1) [chromium] › tests/e2e/a.spec.ts:9:1 › broke", "[20/27] [chromium] › tests/e2e/tabs.spec.ts:378:1 › a session opens"].join("\n");
    expect(testProgress(out)).toEqual({ done: 19, total: 27, failed: 1, current: "[chromium] › tests/e2e/tabs.spec.ts:378:1 › a session opens" });
  });

  it("reads the list reporter, and adds up e2e-parallel's shards", () => {
    const out = [
      "[1] Running 110 tests using 1 worker",
      "[2] Running 102 tests using 1 worker",
      "[1]   ✓   40 [chromium] › tests/e2e/a.spec.ts:1:1 › a (2.1s)",
      "[2]   ✘   12 [chromium] › tests/e2e/b.spec.ts:1:1 › b (3.0s)",
      "[2]   ✓   13 [chromium] › tests/e2e/b.spec.ts:9:1 › c (1.2s)",
    ].join("\n");
    expect(testProgress(out)).toEqual({ done: 53, total: 212, failed: 1, current: "[chromium] › tests/e2e/b.spec.ts:9:1 › c" });
  });

  it("reads pytest and cargo", () => {
    expect(testProgress("collected 10 items\n\ntests/test_a.py ..F.   [ 40%]")).toEqual({ done: 4, total: 10, failed: 1, current: "tests/test_a.py" });
    expect(testProgress("running 3 tests\ntest a::one ... ok\ntest a::two ... FAILED")).toEqual({ done: 2, total: 3, failed: 1, current: "a::two" });
  });

  it("claims nothing without a total", () => {
    expect(testProgress(" ✓ tests/unit/a.test.ts (12 tests) 30ms")).toBeNull();
    expect(testProgress("building… [3/5] steps")).toBeNull();
    // A build's own counter is no test run.
    expect(testProgress("[12/40] Building CXX object src/a.o\n[13/40] Linking b")).toBeNull();
  });
});
