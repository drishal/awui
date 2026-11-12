import { describe, expect, it } from "vitest";
import type { ChatItem, DiffLine, ReviewThread, ToolItem } from "../../src/shared/protocol.js";
import { anchorOf, batchPrompt, buildLineIndex, hashLine, reanchor } from "../../src/shared/review.js";
import { collectChanges, commentKey, placeThreads, type FileChanges } from "../../src/web/review.js";

/** One file with one edit's lines, as the panel's model has it. */
const fileOf = (path: string, lines: DiffLine[]): FileChanges => ({ path, edits: [{ tool: { ...edit("e1", path, 1), diff: { lines, added: 1, removed: 0 } }, turn: 1 }], added: 1, removed: 0 });

const thread = (id: string, anchor: ReviewThread["anchor"], notes: string[], status: ReviewThread["status"] = "open"): ReviewThread => ({
  id,
  chatId: "c1",
  anchor,
  notes: notes.map((text, i) => ({ id: `${id}-n${i}`, text, at: 1 })),
  status,
  createdAt: 1,
});

const edit = (id: string, path: string, added: number, status: ToolItem["status"] = "done"): ToolItem => ({
  kind: "tool",
  id,
  name: "edit",
  args: "",
  status,
  output: "",
  truncated: false,
  category: "edit",
  summary: path,
  paths: [path],
  diff: { added, removed: 1, lines: [{ kind: "del", text: "old", line: 4 }, { kind: "add", text: "  new();", line: 4 }] },
});

const items: ChatItem[] = [
  { kind: "user", id: "u1", text: "first" },
  edit("e1", "/p/src/a.ts", 2),
  edit("e2", "/p/src/b.ts", 1),
  { kind: "user", id: "u2", text: "second" },
  edit("e3", "/p/src/a.ts", 3),
  edit("e4", "/p/src/c.ts", 1, "error"),
];

describe("review", () => {
  it("groups the chat's finished edits by file, in the order files were first touched", () => {
    const files = collectChanges(items, "/p");
    expect(files.map((f) => [f.path, f.edits.map((e) => [e.tool.id, e.turn]), f.added, f.removed])).toEqual([
      ["src/a.ts", [["e1", 1], ["e3", 2]], 5, 2],
      ["src/b.ts", [["e2", 1]], 1, 1],
    ]);
  });


  it("hashes a line's trimmed text to 8 hex characters, the same everywhere", () => {
    expect(hashLine("  new();  ")).toBe(hashLine("new();"));
    expect(hashLine("new();")).toMatch(/^[0-9a-f]{8}$/);
    expect(hashLine("new();")).not.toBe(hashLine("new(1);"));
  });

  it("keeps a pin on its line, follows it when the same text moved, and calls it stale when it is gone", () => {
    const first = fileOf("src/a.ts", [
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "ctx", text: "const a = 1;", line: 1 },
      { kind: "add", text: "new();", line: 2 },
    ]);
    const pin = anchorOf("src/a.ts", { kind: "add", text: "new();", line: 2 });
    // One edit: the pin is where it was written.
    expect(reanchor(pin, buildLineIndex([first]))).toEqual({ line: 2 });

    // A later edit moved the line down (two lines before it): the hash follows it there.
    const moved = fileOf("src/a.ts", [
      { kind: "add", text: "// one", line: 1 },
      { kind: "add", text: "// two", line: 2 },
      { kind: "add", text: "new();", line: 4 },
    ]);
    expect(reanchor(pin, buildLineIndex([first, moved]))).toEqual({ line: 4 });

    // The text is gone from every edit the panel still knows: stale, and the stored anchor is left alone.
    const changed = fileOf("src/a.ts", [{ kind: "add", text: "newer();", line: 3 }]);
    expect(reanchor(pin, buildLineIndex([changed]))).toBe("stale");
    expect(reanchor(pin, buildLineIndex([]))).toBe("stale");
    expect(pin).toEqual({ path: "src/a.ts", side: "add", line: 2, hash: hashLine("new();"), text: "new();" });
  });

  it("turns a batch of open threads into one numbered prompt, and counts the resolved ones it left out", () => {
    const prompt = batchPrompt(
      [
        thread("t1", { path: "src/a.ts", side: "add", line: 41, hash: hashLine("new();"), text: "new();" }, ["Call it with the config.", "Also pass the timeout here."]),
        thread("t2", { path: "src/a.ts", side: "del", line: 4, hash: hashLine("old"), text: "old" }, ["Keep this one"], "resolved"),
        thread("t3", { path: "src/b.ts", side: "ctx", line: 9, hash: hashLine("gone"), text: "gone" }, ["Rename this"]),
      ],
      new Set(["t3"]),
    );
    expect(prompt).toBe(
      [
        "Review comments on your changes:",
        "",
        "1. src/a.ts:41",
        "    + new();",
        "   Call it with the config.",
        "   Also pass the timeout here.",
        "",
        "2. src/b.ts:9 — the line has since changed",
        "      gone",
        "   Rename this",
        "",
        "(2 open threads sent; 1 resolved thread not included)",
      ].join("\n"),
    );
    expect(batchPrompt([thread("t1", { path: "src/a.ts", side: "add", line: 1, hash: "00000000", text: "x" }, ["One"])])).toContain("(1 open thread sent)");
  });

  it("draws a thread once, under the newest edit that still shows its line", () => {
    const files = collectChanges(items, "/p");
    const pinned = thread("t1", { path: "src/a.ts", side: "add", line: 4, hash: hashLine("  new();"), text: "  new();" }, ["Fix this"]);
    const { placed, detached } = placeThreads(files, [pinned]);
    // The same file was edited twice, and both edits show line 4: it is drawn on the later one only.
    expect([...placed.keys()]).toEqual([commentKey("e3", 1)]);
    expect(placed.get(commentKey("e3", 1))?.[0]?.line).toBe(4);
    expect(detached).toEqual([]);
  });

  it("keeps a stale thread where it was pinned, and sets aside one whose path is gone", () => {
    const files = collectChanges(items, "/p");
    // Its text is in no diff any more: it stays on the line it was pinned to, marked changed.
    const gone = thread("t1", { path: "src/a.ts", side: "del", line: 4, hash: "00000000", text: "was here" }, ["Drop this"]);
    const elsewhere = thread("t2", { path: "src/z.ts", side: "add", line: 2, hash: hashLine("x"), text: "x" }, ["Also this"]);
    const { placed, detached } = placeThreads(files, [gone, elsewhere]);
    expect(placed.get(commentKey("e3", 0))?.map((p) => [p.line, p.stale])).toEqual([[4, true]]);
    expect(detached.map((d) => [d.thread.id, d.stale])).toEqual([["t2", true]]);
  });
});
