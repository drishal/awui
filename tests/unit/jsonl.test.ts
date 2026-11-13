// The streaming JSONL reader and the incremental fold behind the session listings: lines whole across
// chunk edges (multi-byte characters included), a torn last line kept out of the saved progress, and a
// grown file resumed to exactly what reading it all would give.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { foldJsonlFile, FoldStore, readJsonlEntries, scanJsonlLines, type FoldProgress } from "../../src/server/harness/jsonl.js";
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

describe("Pi-family reads agree with the text readers they replace", () => {
  const header = { type: "session", version: 3, id: "s1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/p" };
  const msg = (id: string, parentId: string | null, role: string, text: string, ts: string) => ({ type: "message", id, parentId, timestamp: ts, message: { role, content: [{ type: "text", text }] } });
  const lines = [
    { type: "title", title: "A title" },
    header,
    msg("a", null, "user", "héllo 日本", "2026-01-01T00:00:01.000Z"),
    msg("b", "a", "assistant", "hi", "2026-01-01T00:00:02.000Z"),
    msg("c", "b", "user", "side branch", "2026-01-01T00:00:03.000Z"),
    msg("d", "b", "user", "main branch", "2026-01-01T00:00:04.000Z"),
  ];
  const text = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n{"type":"message","torn`;

  it("branchMessagesOfEntries matches branchMessages", async () => {
    writeFileSync(file, text);
    const { branchMessages, branchMessagesOfEntries } = await import("../../src/server/harness/session-files.js");
    expect(branchMessagesOfEntries(await readJsonlEntries(file))).toEqual(branchMessages(text));
  });

  it("readFileMessages matches fileMessages and returns the first line", async () => {
    writeFileSync(file, text);
    const { fileMessages, readFileMessages } = await import("../../src/server/harness/session-files.js");
    const read = await readFileMessages(file);
    expect(read.messages).toEqual(fileMessages(text));
    expect(read.messages).toHaveLength(4);
    expect(read.head).toEqual({ type: "title", title: "A title" });
  });
});

describe("FoldStore", () => {
  const shape = ["n", "words"];
  const entry = (n: number): FoldProgress<Count> => ({ size: 10, mtimeMs: 5, offset: 10, head: "h", tail: "", state: { n, words: "w" } });

  it("keeps progress between runs and starts from it", async () => {
    const first = new FoldStore<Count>("test-roundtrip", shape);
    await first.bind(dir);
    first.set("/a.jsonl", entry(3));
    await first.flush();
    const second = new FoldStore<Count>("test-roundtrip", shape);
    await second.bind(dir);
    expect(second.get("/a.jsonl")?.state.n).toBe(3);
  });

  it("drops a saved copy whose fold changed shape", async () => {
    const first = new FoldStore<Count>("test-shape", shape);
    await first.bind(dir);
    first.set("/a.jsonl", entry(1));
    await first.flush();
    const second = new FoldStore<Count>("test-shape", [...shape, "extra"]);
    await second.bind(dir);
    expect(second.get("/a.jsonl")).toBeUndefined();
  });

  it("ignores malformed saved entries and keeps what this run folded first", async () => {
    writeFileSync(path.join(dir, "fold-test-bad.json"), JSON.stringify({ version: `1:${shape.join(",")}`, entries: [["/ok", entry(1)], ["/bad", { size: "x" }], 7, ["/mine", entry(9)]] }));
    const store = new FoldStore<Count>("test-bad", shape);
    store.set("/mine", entry(2));
    await store.bind(dir);
    expect(store.get("/ok")?.state.n).toBe(1);
    expect(store.get("/bad")).toBeUndefined();
    expect(store.get("/mine")?.state.n).toBe(2);
  });

  it("refolds a file that changed since it was saved, with the same answer as a fresh fold", async () => {
    writeFileSync(file, '{"w":"a"}\n{"w":"b"}\n');
    const first = new FoldStore<Count>("test-stale", shape);
    await first.bind(dir);
    const folded = await foldJsonlFile(file, first.get(file), fold);
    first.set(file, folded!.progress);
    await first.flush();
    writeFileSync(file, '{"w":"x"}\n{"w":"y"}\n{"w":"z"}\n');
    const second = new FoldStore<Count>("test-stale", shape);
    await second.bind(dir);
    const again = await foldJsonlFile(file, second.get(file), fold);
    expect(again?.state).toEqual({ n: 3, words: "xyz" });
  });

  it("keeps at most `max` files, newest last", () => {
    const store = new FoldStore<Count>("test-max", shape, 2);
    store.set("/1", entry(1));
    store.set("/2", entry(2));
    store.set("/3", entry(3));
    expect(store.get("/1")).toBeUndefined();
    expect(store.get("/3")?.state.n).toBe(3);
  });
});
