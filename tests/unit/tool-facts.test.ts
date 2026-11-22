import { describe, expect, it } from "vitest";
import type { ToolItem } from "../../src/shared/protocol.js";
import { toolFacts } from "../../src/shared/output-facts.js";
import { toolSentence } from "../../src/shared/tool-row.js";

// Outputs below were captured from the real tools in this repo (vitest, tsc, rg, git), except
// pytest, cargo, go, eslint, npm and pip, which are written to those tools' documented formats.
function call(category: ToolItem["category"], output: string, over: Partial<ToolItem> = {}): ToolItem {
  return { kind: "tool", id: "t", name: category === "search" ? "grep" : "bash", args: "{}", status: "done", output, truncated: false, category, summary: "", paths: [], ...over };
}
const bash = (output: string, command = "npm test", over: Partial<ToolItem> = {}) => call("command", output, { args: JSON.stringify({ command }), ...over });

const VITEST_FAIL = ` RUN  v5.0.3 /home/me/proj

 ❯ tests/unit/zz-sample.test.ts (2 tests | 1 failed) 10ms
   × keeps the order of two lists 7ms

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/unit/zz-sample.test.ts > keeps the order of two lists
AssertionError: expected [ 1, 2 ] to deeply equal [ 2, 1 ]

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 25 passed (26)
   Start at  11:07:58
   Duration  220ms (transform 67%, tests 14%, import 14%, worker 5%)`;

describe("test runners", () => {
  it("reads a Vitest run with a failure and names the failing test", () => {
    const f = toolFacts(bash(VITEST_FAIL));
    expect(f.kind).toBe("test");
    expect(f.facts).toEqual(["25 passed", "1 failed"]);
    expect(f.error).toBe("keeps the order of two lists");
    expect(f.failed).toBe(true);
  });
  it("reads a passing Vitest run, with colour codes in the way", () => {
    const f = toolFacts(bash("\u001b[32m✓\u001b[39m tests/unit/a.test.ts\n Test Files  1 passed (1)\n      Tests  24 passed (24)\n   Duration  201ms"));
    expect(f.facts).toEqual(["24 passed"]);
    expect(f.error).toBeUndefined();
    expect(f.failed).toBeUndefined();
  });
  it("reads Jest's summary and the failing test's name", () => {
    const f = toolFacts(bash("FAIL src/a.test.js\n  ● math › adds\n\n    expect(received).toBe(expected)\n\nTests:       1 failed, 2 skipped, 5 passed, 8 total\nTime:        1.2 s"));
    expect(f.facts).toEqual(["5 passed", "1 failed", "2 skipped"]);
    expect(f.error).toBe("adds");
    expect(f.failed).toBe(true);
  });
  it("reads pytest's last line and the first failure", () => {
    const f = toolFacts(bash("FAILED tests/test_x.py::test_adds - assert 1 == 2\n===== 1 failed, 2 passed in 0.12s =====", "pytest"));
    expect(f.facts).toEqual(["2 passed", "1 failed"]);
    expect(f.error).toBe("tests/test_x.py::test_adds - assert 1 == 2");
    expect(toolFacts(bash("============ 3 passed in 0.50s ============", "pytest")).facts).toEqual(["3 passed"]);
  });
  it("adds up cargo test's results from each test binary", () => {
    const out = "running 2 tests\ntest a ... ok\ntest tests::adds ... FAILED\n\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s\n\ntest result: ok. 4 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.01s";
    const f = toolFacts(bash(out, "cargo test"));
    expect(f.facts).toEqual(["5 passed", "1 failed", "1 skipped"]);
    expect(f.error).toBe("tests::adds");
  });
  it("reads go test, verbose or by package", () => {
    const verbose = toolFacts(bash("=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- FAIL: TestB (0.00s)\nFAIL\nFAIL\tex.com/p\t0.004s", "go test -v ./..."));
    expect(verbose.facts).toEqual(["1 passed", "1 failed"]);
    expect(verbose.error).toBe("TestB");
    expect(toolFacts(bash("ok  \tex.com/a\t0.003s\nok  \tex.com/b\t(cached)", "go test ./...")).facts).toEqual(["2 packages ok"]);
  });
  it("does not claim a log that only mentions passing", () => {
    expect(toolFacts(bash("the deploy passed 3 checks\nTests passed on staging"))).toEqual({ facts: [] });
    expect(toolFacts(bash("Tests: see the report"))).toEqual({ facts: [] });
  });
});

describe("compilers", () => {
  it("reads tsc's errors by file", () => {
    const out = "src/server/zz.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.\nsrc/server/zz.ts(2,14): error TS2322: Type 'number' is not assignable to type 'string'.";
    const f = toolFacts(bash(out, "npx tsc --noEmit"));
    expect(f.kind).toBe("typecheck");
    expect(f.facts).toEqual(["2 errors in 1 file"]);
    expect(f.error).toBe("src/server/zz.ts:1: TS2322: Type 'string' is not assignable to type 'number'.");
    expect(f.failed).toBe(true);
    expect(f.rows).toEqual([
      { file: "src/server/zz.ts", line: 1, text: "TS2322: Type 'string' is not assignable to type 'number'." },
      { file: "src/server/zz.ts", line: 2, text: "TS2322: Type 'number' is not assignable to type 'string'." },
    ]);
  });
  it("reads tsc's pretty form too", () => {
    const f = toolFacts(bash("src/a.ts:3:7 - error TS2304: Cannot find name 'x'.\nsrc/b.ts:9:1 - error TS1005: ';' expected.", "tsc --pretty"));
    expect(f.facts).toEqual(["2 errors in 2 files"]);
  });
  it("reads eslint's problem count and the first error", () => {
    const out = "/home/me/proj/src/a.ts\n  12:5  error  'x' is defined but never used  no-unused-vars\n  14:1  warning  Unexpected console  no-console\n\n✖ 2 problems (1 error, 1 warning)";
    const f = toolFacts(bash(out, "eslint src"));
    expect(f.facts).toEqual(["1 error", "1 warning"]);
    expect(f.error).toBe("/home/me/proj/src/a.ts:12: 'x' is defined but never used");
    expect(f.failed).toBe(true);
  });
  it("says nothing of clean output", () => {
    expect(toolFacts(bash("", "tsc --noEmit"))).toEqual({ facts: [] });
  });
});

describe("search hits", () => {
  const RG = "src/web/tool-sentence.ts:9:import { formatSpan } from \"./turn-time.js\";\nsrc/web/tool-sentence.ts:194:  return ms < 1000;\nsrc/web/turn-time.ts:46:export function formatSpan(ms: number): string {";
  it("counts results and files from path:line: lines", () => {
    const f = toolFacts(call("search", RG));
    expect(f.facts).toEqual(["3 results in 2 files"]);
    expect(f.rows).toHaveLength(3);
    expect(f.rows?.[0]).toEqual({ file: "src/web/tool-sentence.ts", line: 9, text: "import { formatSpan } from \"./turn-time.js\";" });
    expect(toolFacts(bash(RG, "rg -n formatSpan src")).facts).toEqual(["3 results in 2 files"]);
  });
  it("reads columns too", () => {
    expect(toolFacts(call("search", "a.ts:1:5:foo\nb.ts:2:1:foo")).facts).toEqual(["2 results in 2 files"]);
  });
  it("does not claim prose, a file list, or a cut list", () => {
    expect(toolFacts(call("search", "src/a.ts\nsrc/b.ts")).facts).toEqual([]);
    expect(toolFacts(bash("Note: line 4: something happened\nand then some more text")).facts).toEqual([]);
    expect(toolFacts(call("search", RG, { truncated: true })).facts).toEqual([]);
  });
});

describe("git", () => {
  it("counts git diff --stat", () => {
    const out = " README.md                           |   2 +-\n docs/ui.md                          |   2 +-\n src/web/tool-sentence.ts            | 195 ++++++++++++++++++++++++++++++++++++\n 6 files changed, 387 insertions(+), 19 deletions(-)";
    const f = toolFacts(bash(out, "git diff --stat HEAD~1"));
    expect(f.facts).toEqual(["6 files", "+387 −19"]);
    expect(f.rows?.map((r) => r.file)).toEqual(["README.md", "docs/ui.md", "src/web/tool-sentence.ts"]);
    expect(toolFacts(bash(" 1 file changed, 1 insertion(+)", "git diff --stat")).facts).toEqual(["1 file", "+1"]);
  });
  it("counts git status --short", () => {
    const f = toolFacts(bash(" M src/web/tool-sentence.ts\n?? node_modules\n?? src/web/tool-facts.ts\nD  old.ts", "git status --short"));
    expect(f.facts).toEqual(["2 changed", "2 new"]);
  });
  it("counts git status's long form", () => {
    const out = "On branch worktree-agent-abfbf1c3b06f48df7\nChanges not staged for commit:\n  (use \"git add <file>...\" to update what will be committed)\n\tmodified:   src/web/tool-sentence.ts\n\nUntracked files:\n  (use \"git add <file>...\" to include in what will be committed)\n\tnode_modules\n\tsrc/web/tool-facts.ts\n\nno changes added to commit (use \"git add\" and/or \"git commit -a\")";
    expect(toolFacts(bash(out, "git status")).facts).toEqual(["1 changed", "2 new"]);
    expect(toolFacts(bash("On branch main\nnothing to commit, working tree clean", "git status")).facts).toEqual(["clean"]);
  });
  it("does not read a listing as git status unless the command is git status", () => {
    expect(toolFacts(bash(" M a\n?? b", "cat notes.txt")).facts).toEqual([]);
  });
});

describe("installs and JSON", () => {
  it("reads npm, pnpm and pip", () => {
    expect(toolFacts(bash("\nadded 12 packages, and audited 13 packages in 2s\n\n3 packages are looking for funding", "npm install")).facts).toEqual(["added 12 packages"]);
    expect(toolFacts(bash("added 1 package, removed 2 packages in 1s", "npm i")).facts).toEqual(["added 1 package", "removed 2 packages"]);
    expect(toolFacts(bash("up to date, audited 300 packages in 1s", "npm ci")).facts).toEqual(["up to date"]);
    expect(toolFacts(bash("Packages: +12\n++++++++++\nDone in 2.1s", "pnpm add x")).facts).toEqual(["added 12 packages"]);
    expect(toolFacts(bash("Collecting requests\nSuccessfully installed requests-2.32.0 idna-3.7", "pip install requests")).facts).toEqual(["installed 2 packages"]);
  });
  it("counts the items of a JSON array", () => {
    expect(toolFacts(call("other", "[{\"id\":1},{\"id\":2},{\"id\":3}]", { name: "mcp__linear__list_issues" })).facts).toEqual(["3 items"]);
    expect(toolFacts(call("other", "[1]")).facts).toEqual(["1 item"]);
    expect(toolFacts(call("other", "[]")).facts).toEqual(["no items"]);
  });
  it("says nothing of a JSON object, a cut array, or text", () => {
    expect(toolFacts(call("other", "{\"items\":[1,2]}")).facts).toEqual([]);
    expect(toolFacts(call("other", "[{\"id\":1},{\"id\":2},{\"i", { truncated: true })).facts).toEqual([]);
    expect(toolFacts(call("other", "[not json]")).facts).toEqual([]);
  });
});

describe("limits", () => {
  it("claims nothing while the call runs, or for an empty output", () => {
    expect(toolFacts(bash(VITEST_FAIL, "npm test", { status: "running" }))).toEqual({ facts: [] });
    expect(toolFacts(bash(""))).toEqual({ facts: [] });
  });
  it("finds a cut run's summary at its tail", () => {
    const filler = Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n");
    const f = toolFacts(bash(`${filler}\n[... 3000 bytes cut ...]\n Tests  5 passed (5)`, "npm test", { truncated: true }));
    expect(f.facts).toEqual(["5 passed"]);
  });
  it("feeds the sentence: parsed facts win, and a failed run keeps them", () => {
    const run = bash(VITEST_FAIL, "npm test");
    expect(toolSentence(run, "/home/me/proj").facts).toEqual(["25 passed", "1 failed"]);
    expect(toolSentence(run, "/home/me/proj").error).toBe("keeps the order of two lists");
    const failed = toolSentence({ ...run, status: "error" }, "/home/me/proj");
    expect(failed.text).toBe("Couldn't run npm test");
    expect(failed.facts).toEqual(["25 passed", "1 failed"]);
  });
});

describe("Playwright's own summary", () => {
  it("reads the count lines a passed run prints, with its duration", () => {
    expect(toolFacts(bash("  27 passed (1.2m)", "npx playwright test")).facts).toEqual(["27 passed"]);
    expect(toolFacts(bash("  26 passed (1.3m)", "npx playwright test")).facts).toEqual(["26 passed"]);
  });
  it("reads a failing run's counts and names the failing test", () => {
    const out = [
      "  1) [chromium] › e2e/checkout.spec.ts:42:5 › checkout › pays with saved card ───────",
      "     Error: Timed out 5000ms waiting for getByRole('button', { name: 'Pay' })",
      "",
      "  1 failed",
      "    [chromium] › e2e/checkout.spec.ts:42:5 › checkout › pays with saved card ──────",
      "  26 passed (1.3m)",
      "  2 flaky",
      "  1 skipped",
    ].join("\n");
    const f = toolFacts(bash(out, "npx playwright test"));
    expect(f.facts).toEqual(["26 passed", "1 failed", "1 skipped", "2 flaky"]);
    expect(f.error).toBe("pays with saved card");
    expect(f.failed).toBe(true);
  });
  it("claims nothing from a run that died before its summary", () => {
    // A count alone is not a finished run: no duration, no card.
    expect(toolFacts(bash("  1 failed\n    [chromium] › e2e/a.spec.ts:1:1 › suite › test", "npx playwright test")).facts).toEqual([]);
    // And a vitest summary is still read by its own parser.
    expect(toolFacts(bash(" Test Files  1 passed (1)\n      Tests  3 passed (3)", "npx vitest run")).facts).toEqual(["3 passed"]);
  });
});

describe("npm's own error line and a pull request it opened", () => {
  it("says why a failed script stopped, in npm's words", () => {
    const f = toolFacts(bash("> app@1.0.0 test\n> vitest run\n\nnpm ERR! Test failed.  See above for more details.", "npm test", { status: "error" }));
    expect(f.facts).toEqual([]);
    expect(f.error).toBe("Test failed. See above for more details.");
  });
  it("reads gh pr create's answer as the pull request it opened", () => {
    expect(toolFacts(bash("Warning: 3 uncommitted changes\nhttps://github.com/drishal/awui/pull/42", "gh pr create --fill")).facts).toEqual(["opened #42"]);
    // A URL in some other command's output is not a pull request this call opened.
    expect(toolFacts(bash("https://github.com/drishal/awui/pull/42", "curl -s https://api.github.com")).facts).toEqual([]);
  });
});

// A parser's candidates are what it read, with the line it read it from. Nothing is proposed
// that the output does not contain, and the evidence stays inside a row's worth of text.
function candidateOf(f: ReturnType<typeof toolFacts>, key: string): Array<string | number> {
  return (f.candidates ?? []).filter((c) => c.key === key).map((c) => c.value);
}

describe("candidates a parser proposes", () => {
  it("proposes Vitest's counts and its failing test, each with the line it read", () => {
    const f = toolFacts(bash(VITEST_FAIL));
    expect(candidateOf(f, "passed")).toEqual([25]);
    expect(candidateOf(f, "failed")).toEqual([1]);
    expect(candidateOf(f, "failing_test")).toEqual(["keeps the order of two lists"]);
    const failing = (f.candidates ?? []).find((c) => c.key === "failing_test");
    expect(failing?.source).toBe("sniffer");
    expect(failing?.evidence).toContain("FAIL  tests/unit/zz-sample.test.ts > keeps the order of two lists");
  });
  it("proposes Playwright's runner, counts, duration and every numbered failure", () => {
    const out = [
      "Running 27 tests using 4 workers",
      "  1) [chromium] › e2e/checkout.spec.ts:42:5 › checkout › pays with saved card ───────",
      "     Error: Timed out 5000ms waiting for getByRole('button', { name: 'Pay' })",
      "  2) [chromium] › e2e/checkout.spec.ts:57:5 › checkout › retries a declined card ─────",
      "  1 failed",
      "  26 passed (1.3m)",
      "  2 flaky",
    ].join("\n");
    const f = toolFacts(bash(out, "npx playwright test"));
    expect(candidateOf(f, "runner")).toEqual(["playwright"]);
    expect(candidateOf(f, "passed")).toEqual([26]);
    expect(candidateOf(f, "failed")).toEqual([1]);
    expect(candidateOf(f, "flaky")).toEqual([2]);
    expect(candidateOf(f, "duration_ms")).toEqual([78_000]);
    expect(candidateOf(f, "failing_test")).toEqual(["pays with saved card", "retries a declined card"]);
    expect(candidateOf(f, "error_line")[0]).toContain("Timed out 5000ms");
  });
  it("proposes no tally from a Playwright run that printed no duration", () => {
    const f = toolFacts(bash("  1 failed\n  26 passed", "npx playwright test"));
    expect(f.candidates).toBeUndefined();
  });
  it("proposes cargo's summed counts and the binary count", () => {
    const out = ["test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s", "test result: FAILED. 4 passed; 1 failed; 2 ignored; 0 measured; 0 filtered out; finished in 0.02s", "test keeps_order ... FAILED"].join("\n");
    const f = toolFacts(bash(out, "cargo test"));
    expect(candidateOf(f, "runner")).toEqual(["cargo"]);
    expect(candidateOf(f, "passed")).toEqual([7]);
    expect(candidateOf(f, "failed")).toEqual([1]);
    expect(candidateOf(f, "ignored")).toEqual([2]);
    expect(candidateOf(f, "binaries")).toEqual([2]);
    expect(candidateOf(f, "failing_test")).toEqual(["keeps_order"]);
  });
  it("proposes npm's own tally, audit and duration", () => {
    const f = toolFacts(bash("added 12 packages, and audited 13 packages in 2s\n\n3 packages are looking for funding\n\nfound 0 vulnerabilities", "npm install"));
    expect(f.facts).toEqual(["added 12 packages"]);
    expect(candidateOf(f, "packages_added")).toEqual([12]);
    expect(candidateOf(f, "audited")).toEqual([13]);
    expect(candidateOf(f, "vulnerabilities")).toEqual([0]);
    expect(candidateOf(f, "duration_ms")).toEqual([2000]);
  });
  it("proposes the pull request's URL and number", () => {
    const url = "https://github.com/drishal/awui/pull/42";
    const f = toolFacts(bash(url, "gh pr create --fill"));
    expect(candidateOf(f, "pr_url")).toEqual([url]);
    expect(candidateOf(f, "pr_number")).toEqual([42]);
  });
  it("keeps a candidate's evidence inside the line's own words", () => {
    const name = "a suite whose name is long ".repeat(20).trim();
    const f = toolFacts(bash(` FAIL  tests/a.test.ts > ${name}\n Test Files  1 failed (1)\n      Tests  1 failed | 0 passed (1)`));
    const evidence = (f.candidates ?? []).find((c) => c.key === "failing_test")?.evidence ?? "";
    expect(evidence.length).toBeLessThanOrEqual(120);
  });
});
