// The worktree picker's seeded notice: what the create report turns into, one
// line or none.
import { describe, expect, it } from "vitest";
import type { WorktreeSeedReport } from "../../src/shared/protocol.js";
import { worktreeSeedSummary } from "../../src/web/worktree-seed.js";

const report = (r: Partial<WorktreeSeedReport>): WorktreeSeedReport => ({ copied: [], linked: [], skipped: [], more: 0, ...r });

describe("worktreeSeedSummary", () => {
  it("says nothing when the include file seeded none", () => {
    expect(worktreeSeedSummary(report({}))).toBeNull();
  });

  it("joins copied, linked, and skipped with their reasons", () => {
    expect(worktreeSeedSummary(report({
      copied: [".env", ".vscode"],
      linked: ["node_modules"],
      skipped: [{ path: "../x", reason: "outside the project" }],
    }))).toBe("Worktree seeded: copied .env, .vscode; linked node_modules; skipped ../x (outside the project)");
  });

  it("counts past the named few and folds the unreported skips into the count", () => {
    expect(worktreeSeedSummary(report({
      copied: Array.from({ length: 8 }, (_, i) => `f${i}.txt`),
      skipped: [{ path: "a", reason: "missing" }, { path: "b", reason: "missing" }],
      more: 2,
    }))).toBe("Worktree seeded: copied f0.txt, f1.txt, f2.txt, f3.txt, f4.txt, f5.txt +2 more; skipped a (missing), b (missing) +2 more");
  });
});
