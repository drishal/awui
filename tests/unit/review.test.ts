import { describe, expect, it } from "vitest";
import type { ChatItem, DiffLine, ReviewThread, ToolItem } from "../../src/shared/protocol.js";
import { anchorOf, batchPrompt, buildLineIndex, hashLine, reanchor } from "../../src/shared/review.js";
import { collectChanges, commentKey, reviewPrompt, type FileChanges, type ReviewComment } from "../../src/web/review.js";

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

  it("turns comments into one prompt naming each line", () => {
    const files = collectChanges(items, "/p");
    const lines = files[0]?.edits[0]?.tool.diff?.lines ?? [];
    const comments: ReviewComment[] = [
      { key: commentKey("e1", 1), path: "src/a.ts", line: lines[1] as never, text: "Call it with the config. " },
      { key: commentKey("e1", 0), path: "src/a.ts", line: lines[0] as never, text: "Keep this one" },
    ];
    expect(reviewPrompt(comments)).toBe(
      "Review comments on your changes:\n\nsrc/a.ts:4\n    + new();\nCall it with the config.\n\nsrc/a.ts (removed line 4)\n    - old\nKeep this one",
    );
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
});
