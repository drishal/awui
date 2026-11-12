// Attribution: which diff lines the agent wrote, and which have been changed outside the
// chat since — the pure rule, the panel's grouping of it, and the read of the files on
// disk that flips a line (through the route, against a real project folder).
import { afterEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatSnapshot, DiffLine, ToolItem } from "../../src/shared/protocol.js";
import type { AttributionSnapshot } from "../../src/shared/protocol.js";
import { agentHashes, attributeLines, commentKey, hashLine, type FileChanges } from "../../src/shared/review.js";
import { collectChanges } from "../../src/web/review.js";
import { groupMarks } from "../../src/web/attribution.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const line = (kind: DiffLine["kind"], text: string, n?: number): DiffLine => ({ kind, text, ...(n === undefined ? {} : { line: n }) });

const tool = (id: string, lines: DiffLine[]): ToolItem => ({
  kind: "tool",
  id,
  name: "edit",
  args: "{}",
  status: "done",
  output: "",
  truncated: false,
  category: "edit",
  summary: "src/app.ts",
  paths: ["/proj/src/app.ts"],
  diff: { lines, added: lines.filter((l) => l.kind === "add").length, removed: lines.filter((l) => l.kind === "del").length },
});

const changes = (edits: Array<[string, DiffLine[]]>, file = "src/app.ts"): FileChanges[] => [{ path: file, edits: edits.map(([id, lines]) => ({ tool: tool(id, lines), turn: 1 })), added: 1, removed: 0 }];

describe("the attribution rule", () => {
  it("marks an added line as the agent's, and a context line only when an earlier edit added that text", () => {
    const files = changes([
      ["t1", [line("hunk", "@@"), line("ctx", "const a = 1;", 1), line("add", "const b = 2;", 2)]],
      ["t2", [line("ctx", "const a = 1;", 1), line("ctx", "const b = 2;", 2), line("add", "const c = 3;", 3)]],
    ]);
    const marks = attributeLines(files, null);
    expect(marks.get(commentKey("t1", 0))).toBeUndefined();
    expect(marks.get(commentKey("t1", 1))).toBeUndefined();
    expect(marks.get(commentKey("t1", 2))).toBe("agent");
    // t2's context lines: a's text was never added by the agent, b's was.
    expect(marks.get(commentKey("t2", 0))).toBeUndefined();
    expect(marks.get(commentKey("t2", 1))).toBe("agent");
    expect(marks.get(commentKey("t2", 2))).toBe("agent");
    // A removal is not a line anybody owns.
    expect(attributeLines(changes([["t3", [line("del", "old", 9)]]]), null).size).toBe(0);
  });

  it("flips a line the file no longer has to changed, and leaves a truncated file's lines alone", () => {
    const files = changes([["t1", [line("add", "keep me", 1), line("add", "gone now", 2)]]]);
    const present = new Map([["src/app.ts", new Set([hashLine("keep me")])]]);
    const marks = attributeLines(files, present);
    expect(marks.get(commentKey("t1", 0))).toBe("agent");
    expect(marks.get(commentKey("t1", 1))).toBe("changed");
    expect(attributeLines(files, new Map())?.size ?? 2).toBe(2);
    // A path the read left out says nothing, so nothing flips there.
    expect(attributeLines(files, new Map([["other.ts", new Set()]])).get(commentKey("t1", 1))).toBe("agent");
  });

  it("collects the hashes the agent wrote per file", () => {
    const hashes = agentHashes(changes([["t1", [line("add", "one", 1), line("ctx", "two", 2)]]]));
    expect([...(hashes.get("src/app.ts") ?? [])]).toEqual([hashLine("one")]);
  });
});

describe("the panel's grouping", () => {
  it("splits one chat's marks by edit and counts them per file", () => {
    const files = changes([
      ["t1", [line("add", "one", 1), line("add", "two", 2)]],
      ["t2", [line("ctx", "one", 1)]],
    ]);
    const marks = new Map([
      [commentKey("t1", 0), "agent" as const],
      [commentKey("t1", 1), "changed" as const],
      [commentKey("t2", 0), "agent" as const],
    ]);
    const grouped = groupMarks(files, marks);
    expect(grouped.byTool.get("t1")).toEqual(new Map([[0, "agent"], [1, "changed"]]));
    expect(grouped.byTool.get("t2")).toEqual(new Map([[0, "agent"]]));
    expect(grouped.byPath.get("src/app.ts")).toEqual({ agent: 2, changed: 1 });
  });
});

describe("the attribution read", () => {
  it("answers with the edited files' present lines, and a line the file lost reads as changed", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "edit something" });
    const live = () => t?.manager.get(chat.chatId);
    await until(() => live()?.status === "idle" && (live()?.snapshot().items.some((item) => item.kind === "tool" && item.diff !== undefined) ?? false));

    const items = live()?.snapshot().items ?? [];
    const files = collectChanges(items, chat.workspace.path);
    expect(files.length).toBeGreaterThan(0);
    const edited = files[0] as FileChanges;
    const added = (edited.edits[0]?.tool.diff?.lines ?? []).filter((entry) => entry.kind === "add").map((entry) => entry.text);

    // The file as the fake harness left it: the route hands its lines' hashes back.
    const read = await agent.get(`/api/chats/${chat.chatId}/attribution`);
    expect(read.status).toBe(200);
    const snapshot = read.body as AttributionSnapshot;
    const readPath = snapshot.paths.find((entry) => entry.path === edited.path);
    expect(readPath).toBeDefined();
    const onDisk = await fs.readFile(path.join(t.project, edited.path), "utf8");
    expect(readPath?.hashes).toEqual(onDisk.replace(/\n$/, "").split("\n").map(hashLine));

    // Written so the agent's own lines are in the file: they read as the agent's.
    await fs.writeFile(path.join(t.project, edited.path), `${[...added, "// local note"].join("\n")}\n`);
    const present = new Map([[edited.path, new Set((await fs.readFile(path.join(t.project, edited.path), "utf8")).split("\n").map(hashLine))]]);
    const kept = attributeLines(files, present);
    const firstEdit = edited.edits[0] as FileChanges["edits"][number];
    const addedAt = (firstEdit.tool.diff?.lines ?? []).findIndex((entry) => entry.kind === "add");
    expect(kept.get(commentKey(firstEdit.tool.id, addedAt))).toBe("agent");

    // A file that lost the line: it reads changed on the next read.
    await fs.writeFile(path.join(t.project, edited.path), "// everything rewritten by hand\n");
    const again = (await agent.get(`/api/chats/${chat.chatId}/attribution`)).body as AttributionSnapshot;
    const after = new Map([[edited.path, new Set(again.paths.find((entry) => entry.path === edited.path)?.hashes ?? [])]]);
    const flipped = attributeLines(files, after);
    expect([...flipped.values()].filter((origin) => origin === "agent")).toHaveLength(0);
    expect([...flipped.values()].every((origin) => origin === "changed")).toBe(true);
  });
});
