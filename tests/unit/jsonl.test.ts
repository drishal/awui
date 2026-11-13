// The streaming JSONL reader and the incremental fold behind the session listings: lines whole across
// chunk edges (multi-byte characters included), a torn last line kept out of the saved progress, and a
// grown file resumed to exactly what reading it all would give.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { foldJsonlFile, readJsonlEntries, scanJsonlLines, type FoldProgress } from "../../src/server/harness/jsonl.js";
import type { Obj } from "../../src/server/harness/agent-events.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "awui-jsonl-"));
  file = path.join(dir, "s.jsonl");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Count {
  n: number;
  words: string;
}
const fold = {
  init: (): Count => ({ n: 0, words: "" }),
  clone: (s: Count): Count => ({ ...s }),
  push: (s: Count, e: Obj) => {
    s.n += 1;
    s.words += String(e.w ?? "");
  },
};

describe("scanJsonlLines", () => {
  it("hands over whole lines whatever the chunk size, multi-byte characters included", async () => {
    const lines = [JSON.stringify({ w: "héllo wörld" }), JSON.stringify({ w: "日本語のテキスト" }), JSON.stringify({ w: "x" })];
    writeFileSync(file, `${lines.join("\n")}\n`);
    for (const chunk of [1, 2, 3, 5, 64, 1 << 20]) {
      const got: string[] = [];
      const scan = await scanJsonlLines(file, (l) => got.push(l), 0, chunk);
      expect(got).toEqual(lines);
      expect(scan.tail).toBe("");
      expect(scan.end).toBe(Buffer.byteLength(`${lines.join("\n")}\n`));
    }
  });

  it("keeps an unterminated last line out of `end` and returns it as the tail", async () => {
    writeFileSync(file, '{"a":1}\n{"a":2');
    const got: string[] = [];
    const scan = await scanJsonlLines(file, (l) => got.push(l), 0, 4);
    expect(got).toEqual(['{"a":1}']);
    expect(scan.tail).toBe('{"a":2');
    expect(scan.end).toBe(8);
  });

  it("starts from a byte offset and skips empty lines", async () => {
    writeFileSync(file, '{"a":1}\n\n   \n{"a":2}\n');
    const got: string[] = [];
    await scanJsonlLines(file, (l) => got.push(l), 8);
    expect(got).toEqual(['{"a":2}']);
  });
});

describe("readJsonlEntries", () => {
  it("parses every object line and skips torn or foreign ones", async () => {
    writeFileSync(file, '{"a":1}\nnot json\n[1,2]\n{"a":2}\n{"a":3');
    expect(await readJsonlEntries(file)).toEqual([{ a: 1 }, { a: 2 }]);
  });
});

describe("foldJsonlFile", () => {
  const line = (w: string) => `${JSON.stringify({ w })}\n`;
  const run = async (prev?: FoldProgress<Count>) => {
    const out = await foldJsonlFile(file, prev, fold);
    if (!out) throw new Error("unreadable");
    return out;
  };

  it("resumes a grown file and matches a fresh read of it", async () => {
    writeFileSync(file, line("a") + line("b"));
    const first = await run();
    expect(first.state).toEqual({ n: 2, words: "ab" });
    appendFileSync(file, line("c"));
    const second = await run(first.progress);
    expect(second.progress.offset).toBeGreaterThan(first.progress.offset);
    expect(second.state).toEqual((await run()).state);
    expect(second.state).toEqual({ n: 3, words: "abc" });
  });

  it("counts an unterminated last line in the result but not in the saved progress", async () => {
    writeFileSync(file, line("a") + '{"w":"b"}');
    const first = await run();
    expect(first.state).toEqual({ n: 2, words: "ab" });
    expect(first.progress.state).toEqual({ n: 1, words: "a" });
    appendFileSync(file, "\n");
    const second = await run(first.progress);
    expect(second.state).toEqual({ n: 2, words: "ab" });
    expect(second.progress.state).toEqual({ n: 2, words: "ab" });
  });

  it("answers an unchanged file from the saved progress, tail included", async () => {
    writeFileSync(file, line("a") + '{"w":"b"}');
    const first = await run();
    const again = await run(first.progress);
    expect(again.progress).toBe(first.progress);
    expect(again.state).toEqual({ n: 2, words: "ab" });
  });

  it("starts over when the file was rewritten rather than appended to", async () => {
    writeFileSync(file, line("a") + line("b"));
    const first = await run();
    writeFileSync(file, line("z") + line("y") + line("x"));
    const second = await run(first.progress);
    expect(second.state).toEqual({ n: 3, words: "zyx" });
  });

  it("starts over when the file got shorter", async () => {
    writeFileSync(file, line("a") + line("b") + line("c"));
    const first = await run();
    writeFileSync(file, line("a"));
    expect((await run(first.progress)).state).toEqual({ n: 1, words: "a" });
  });

  it("is null for a file that does not exist", async () => {
    expect(await foldJsonlFile(path.join(dir, "missing.jsonl"), undefined, fold)).toBeNull();
  });
});
