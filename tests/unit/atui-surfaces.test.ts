// The terminal clients' own decisions about the new work surfaces: a worker's row, the rail's
// flat list and summary, and the window a cursor walks. The words themselves are the web UI's
// (web/delegated-tasks.ts, web/context-panel.ts) and are tested there.
import { describe, expect, it } from "vitest";
import { asHarnessId, type DelegatedTaskView } from "../../src/shared/protocol.js";
import { clockNote, moveRow, rowWindow, taskRows, workerCount } from "../../src/atui/delegated.js";
import { railEntries, railSummary, toneDot, toneOf } from "../../src/atui/rail.js";
import { DARK } from "../../src/atui/theme.js";
import type { ContextCard } from "../../src/web/context-panel.js";

const task = (over: Partial<DelegatedTaskView> = {}): DelegatedTaskView => ({
  id: "ab12",
  parentChatId: "parent",
  childChatId: "child",
  title: "Review the parser",
  harnessId: asHarnessId("pi"),
  model: "sonnet",
  role: "test",
  profile: null,
  depth: 1,
  state: "working",
  outcome: null,
  createdAt: 1_000,
  endedAt: null,
  activity: "Reading src/app.ts",
  result: null,
  asking: null,
  scope: null,
  reviewable: false,
  ...over,
});

const name = (id: string) => ({ pi: "Pi" })[id] ?? id;

describe("a worker's row in a terminal", () => {
  it("carries the status word, who runs it, its clock, and the child's last line", () => {
    const [row] = taskRows([task()], 61_000, name);
    expect(row).toMatchObject({ title: "Review the parser", meta: "Pi · sonnet · test", word: "Working", elapsed: "1m", line: "Reading src/app.ts", finished: false, reviewable: false });
    expect(row && clockNote(row)).toBe("running 1m");
  });

  it("reads a finished worker's clock as how long it took, and only a reviewable finish as reviewable", () => {
    const [done] = taskRows([task({ state: "result_available", outcome: "done", endedAt: 4_000, activity: null, result: { finalText: "Echo: child.", error: null, usage: null }, reviewable: true })], 61_000, name);
    expect(done).toMatchObject({ word: "Done", elapsed: "3.0s", line: "Echo: child.", finished: true, reviewable: true });
    expect(done && clockNote(done)).toBe("took 3.0s");
    // A worker that finished without a managed checkout has nothing to review.
    expect(taskRows([task({ state: "result_available", outcome: "done", reviewable: false })], 1, name)[0]?.reviewable).toBe(false);
    // A running worker that will be reviewable is not reviewable yet.
    expect(taskRows([task({ reviewable: true })], 1, name)[0]?.reviewable).toBe(false);
  });

  it("draws the write scope and the guard's count when the worker carries them", () => {
    const [row] = taskRows([task({ scope: { globs: ["src/**"], scratchDir: null, attempted: 2, blocked: 2, landed: 0, recent: ["write outside.ts"] } })], 1, name);
    expect(row?.scope).toBe("Scope src/**");
    expect(row?.guard).toBe("Out of scope: 2 blocked before it ran · write outside.ts");
    expect(taskRows([task()], 1, name)[0]).toMatchObject({ scope: null, guard: null });
  });

  it("counts workers, and holds a cursor and a window inside the list", () => {
    expect(workerCount(1)).toBe("1 worker");
    expect(workerCount(3)).toBe("3 workers");
    expect(moveRow(3, 0, -1)).toBe(0);
    expect(moveRow(3, 2, 1)).toBe(2);
    expect(moveRow(0, 4, 1)).toBe(0);
    expect(rowWindow(20, 0, 6)).toBe(0);
    expect(rowWindow(20, 10, 6)).toBe(7);
    expect(rowWindow(20, 19, 6)).toBe(14);
    expect(rowWindow(4, 2, 6)).toBe(0);
  });
});

const card = (id: ContextCard["id"], rows: ContextCard["rows"]): ContextCard => ({ id, label: id, count: rows.length, attention: false, rows });

describe("the rail's flat list and its summary", () => {
  const cards = [
    card("agents", [
      { key: "run:0", title: "Read the parser", meta: "Agent · scout", status: { tone: "working", word: "Working" }, target: { kind: "tool", toolId: "t1" } },
      { key: "run:1", title: "Search listen", meta: "Agent · scout", status: { tone: "failed", word: "Failed" }, target: { kind: "tool", toolId: "t2" } },
    ]),
    card("questions", [{ key: "request:r1", title: "Allow tool: bash", meta: "Approval", status: { tone: "waiting", word: "Needs you" }, target: { kind: "questions" } }]),
  ];

  it("walks every card's rows in drawing order, each with the card it belongs to", () => {
    const entries = railEntries(cards);
    expect(entries.map((e) => e.row.key)).toEqual(["run:0", "run:1", "request:r1"]);
    expect(entries[0]?.card.id).toBe("agents");
    expect(entries[2]?.card.id).toBe("questions");
  });

  it("sums what is working, what waits, and what failed; and says so when nothing is", () => {
    expect(railSummary(cards)).toBe("1 working · 1 needs you · 1 failed");
    expect(railSummary([card("questions", [{ key: "a", title: "x", meta: "", status: { tone: "waiting", word: "Needs you" }, target: { kind: "questions" } }, { key: "b", title: "y", meta: "", status: { tone: "waiting", word: "Needs you" }, target: { kind: "questions" } }])])).toBe("2 need you");
    expect(railSummary([card("memory", [{ key: "usage", title: "Context used", meta: "", status: { tone: "quiet", word: "42%" }, target: { kind: "usage" } }])])).toBe("Nothing is running");
  });

  it("colours a status by its tone, and draws a quiet one hollow", () => {
    expect(toneOf(DARK, "working")).toBe(DARK.accent);
    expect(toneOf(DARK, "waiting")).toBe(DARK.warn);
    expect(toneOf(DARK, "done")).toBe(DARK.ok);
    expect(toneOf(DARK, "failed")).toBe(DARK.danger);
    expect(toneOf(DARK, "quiet")).toBe(DARK.muted);
    expect(["working", "waiting", "failed"].map((tone) => toneDot(tone as "working"))).toEqual(["●", "●", "●"]);
    expect(toneDot("done")).toBe("✓");
    expect(toneDot("quiet")).toBe("○");
  });
});
