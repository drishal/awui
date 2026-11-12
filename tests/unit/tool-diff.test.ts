import { describe, expect, it } from "vitest";
import { parseUnified } from "../../src/shared/unified-diff.js";
import { argsDiff, lineDiff, parseNumbered, resultDiff } from "../../src/server/harness/tool-diff.js";

const shape = (lines: Array<{ kind: string; text: string; line?: number }>) => lines.map((l) => `${{ add: "+", del: "-", ctx: " ", hunk: "@", gap: "~" }[l.kind]}${l.line ?? ""}|${l.text}`);

describe("tool diffs", () => {
  it("aligns old and new text, keeping what did not change as context", () => {
    expect(shape(lineDiff(["a", "b", "c", "d"], ["a", "B", "c", "d", "e"], 10))).toEqual([" 10|a", "-11|b", "+11|B", " 12|c", " 13|d", "+14|e"]);
    const edit = argsDiff({ file_path: "f.ts", old_string: "one\ntwo\nthree", new_string: "one\n2\nthree\nfour" });
    expect(edit).toMatchObject({ added: 2, removed: 1 });
    expect(shape(edit?.lines ?? [])).toEqual([" |one", "-|two", "+|2", " |three", "+|four"]);
  });

  it("folds long unchanged runs and sums multi-edits", () => {
    const old = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const next = [...old];
    next[10] = "changed";
    const diff = argsDiff({ oldText: old.join("\n"), newText: next.join("\n") });
    expect(shape(diff?.lines ?? [])).toEqual(["~|7 unchanged lines", " |line 7", " |line 8", " |line 9", "-|line 10", "+|changed", " |line 11", " |line 12", " |line 13", "~|6 unchanged lines"]);
    expect(argsDiff({ edits: [{ old_string: "a", new_string: "b" }, { old_string: "c\nd", new_string: "c" }] })).toMatchObject({ added: 1, removed: 2 });
    expect(argsDiff({ path: "f.ts" })).toBeNull();
  });

  it("shows a write as every line added, numbered", () => {
    expect(shape(argsDiff({ file_path: "n.ts", content: "x\ny\n" })?.lines ?? [])).toEqual(["+1|x", "+2|y"]);
  });

  it("reads unified diffs with their line numbers, and omp's patch block", () => {
    const diff = parseUnified("--- a/f\n+++ b/f\n@@ -3,3 +3,4 @@ fn main\n keep\n-old\n+new\n+more\n tail\n");
    expect(diff).toMatchObject({ added: 2, removed: 1 });
    expect(shape(diff?.lines ?? [])).toEqual(["@|fn main", " 3|keep", "-4|old", "+4|new", "+5|more", " 6|tail"]);
    const omp = argsDiff({ input: "[src/a.ts#AB12]\nreplace 3..4:\n+x\n+y\n" });
    expect(shape(omp?.lines ?? [])).toEqual(["@|src/a.ts", "@|replace 3..4:", "+|x", "+|y"]);
  });

  it("prefers the harness's own diff: Pi, omp, Claude Code, Hermes", () => {
    // Pi pads its numbers and marks skipped lines with ...
    const pi = parseNumbered("  1 keep\n- 2 old\n+ 2 new\n    ...\n 40 end");
    expect(shape(pi?.lines ?? [])).toEqual([" 1|keep", "-2|old", "+2|new", "~|", " 40|end"]);
    // omp: +N|text, a blank line between hunks.
    const omp = resultDiff({ diff: " 1|providers:\n-3|  a: 1\n+3|  a: 2\n\n 40|end", path: "m.yml" }, "");
    expect(shape(omp?.lines ?? [])).toEqual([" 1|providers:", "-3|  a: 1", "+3|  a: 2", "~|", " 40|end"]);
    const claude = resultDiff({ type: "update", structuredPatch: [{ oldStart: 5, newStart: 5, lines: [" a", "-b", "+c"] }] }, "The file was updated");
    expect(shape(claude?.lines ?? [])).toEqual([" 5|a", "-6|b", "+6|c"]);
    expect(resultDiff({ type: "create", content: "new\nfile", structuredPatch: [] }, "")).toMatchObject({ added: 2, removed: 0 });
    const hermes = resultDiff(undefined, JSON.stringify({ success: true, diff: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n" }));
    expect(shape(hermes?.lines ?? [])).toEqual(["-1|a", "+1|b"]);
    expect(resultDiff(undefined, "Edited")).toBeNull();
  });
});
