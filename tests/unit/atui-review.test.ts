import { describe, expect, it } from "vitest";
import type { ToolItem } from "../../src/shared/protocol.js";
import { firstStop, gapSpan, moveCursor, moveFile, nearestGap, openGaps, reviewRows, windowStart } from "../../src/atui/review.js";
import type { FileChanges } from "../../src/web/review.js";

const edit = (id: string, lines: Array<[string, string, number?]>): ToolItem =>
  ({ kind: "tool", id, name: "edit", category: "edit", status: "done", diff: { lines: lines.map(([kind, text, line]) => ({ kind, text, line })), added: 1, removed: 1 } }) as unknown as ToolItem;

const files: FileChanges[] = [
  { path: "a.ts", added: 1, removed: 1, edits: [{ turn: 2, tool: edit("t1", [["hunk", "@@"], ["del", "old", 3], ["add", "new", 3], ["ctx", "same", 4]]) }] },
  { path: "b.ts", added: 1, removed: 0, edits: [{ turn: 3, tool: edit("t2", [["add", "only", 1]]) }] },
];

describe("review in atui", () => {
  it("lays every file's edits out as rows: the file, the edit, its lines", () => {
    const rows = reviewRows(files);
    expect(rows.map((r) => (r.kind === "line" ? `${r.line.kind}:${r.key}` : r.kind === "edit" ? `edit:${r.label}` : `file:${r.path}`))).toEqual([
      "file:a.ts",
      "edit:turn 2 · edit",
      "hunk:t1:0",
      "del:t1:1",
      "add:t1:2",
      "ctx:t1:3",
      "file:b.ts",
      "edit:turn 3 · edit",
      "add:t2:0",
    ]);
  });

  it("moves the cursor over lines that take a comment, and a file at a time", () => {
    const rows = reviewRows(files);
    const first = firstStop(rows);
    expect(first).toBe(3);
    expect(moveCursor(rows, first, 1)).toBe(4);
    expect(moveCursor(rows, 5, 1)).toBe(8);
    expect(moveCursor(rows, 8, 5)).toBe(8);
    expect(moveCursor(rows, first, -1)).toBe(first);
    expect(moveFile(rows, first, 1)).toBe(8);
    expect(moveFile(rows, 8, -1)).toBe(3);
    expect(moveFile(rows, 8, 1)).toBe(8);
    expect(firstStop([])).toBe(-1);
  });

  it("keeps the cursor a third of the way down, without running past either end", () => {
    expect(windowStart(100, 50, 30)).toBe(40);
    expect(windowStart(100, 2, 30)).toBe(0);
    expect(windowStart(100, 99, 30)).toBe(70);
    expect(windowStart(10, 5, 30)).toBe(0);
  });

  it("opens a gap that names its unchanged lines, read-only, and leaves any other gap shut", () => {
    const gapped: FileChanges[] = [{ path: "c.ts", added: 1, removed: 0, edits: [{ turn: 1, tool: edit("g1", [["ctx", "top", 10], ["gap", "3 unchanged lines"], ["add", "new", 14], ["gap", ""]]) }] }];
    const rows = reviewRows(gapped);
    const at = rows.findIndex((r) => r.kind === "line" && r.line.kind === "gap" && r.line.text !== "");
    expect(gapSpan(rows, at)).toEqual({ from: 11, count: 3 });
    // The bare hunk break has no count and no number to read from.
    expect(gapSpan(rows, rows.length - 1)).toBeNull();
    expect(nearestGap(rows, 0)).toBe(at);
    expect(nearestGap(rows, rows.length - 1)).toBe(at);
    const key = (rows[at] as { key: string }).key;
    const open = openGaps(rows, new Map([[key, ["a", "b", "c"]]]));
    const shown = open.filter((r) => r.kind === "line" && r.shown);
    expect(shown.map((r) => (r.kind === "line" ? `${r.line.line}:${r.line.text}` : ""))).toEqual(["11:a", "12:b", "13:c"]);
    // The cursor never stands on an opened line, so nothing can be pinned to it.
    expect(moveCursor(open, firstStop(open), 1)).toBe(open.findIndex((r) => r.kind === "line" && r.line.kind === "add"));
    // A gap that holds more than was read keeps a closed remainder.
    const partial = openGaps(rows, new Map([[key, ["a"]]]));
    expect(partial.some((r) => r.kind === "line" && r.line.kind === "gap" && r.line.text === "2 more unchanged lines")).toBe(true);
  });
});
