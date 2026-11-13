import { describe, expect, it } from "vitest";
import { asHarnessId, type DelegatedTaskView } from "../../src/shared/protocol.js";
import { guardWords, metaText, reviewActions, reviewWords, scopeWords, stateClass, stateWords, taskElapsed, taskLine, tasksMeta } from "../../src/web/delegated-tasks.js";

const task = (over: Partial<DelegatedTaskView> = {}): DelegatedTaskView => ({
  id: "ab12",
  parentChatId: "parent",
  childChatId: "child",
  title: "Review the parser",
  harnessId: asHarnessId("pi"),
  model: null,
  role: "",
  profile: null,
  depth: 1,
  state: "working",
  outcome: null,
  createdAt: 1_000,
  endedAt: null,
  activity: null,
  result: null,
  asking: null,
  scope: null,
  reviewable: false,
  ...over,
});

const name = (id: string) => ({ pi: "Pi", omp: "omp" })[id] ?? id;

describe("a task row's chip", () => {
  it("says what a running task is doing and how a finished one ended", () => {
    expect(stateWords(task({ state: "working" }))).toBe("Working");
    expect(stateWords(task({ state: "waiting_for_user" }))).toBe("Waiting");
    expect(stateWords(task({ state: "waiting_for_children" }))).toBe("Waiting");
    expect(stateWords(task({ state: "result_available", outcome: "done" }))).toBe("Done");
    expect(stateWords(task({ state: "result_available", outcome: "failed" }))).toBe("Failed");
    expect(stateWords(task({ state: "result_available", outcome: "cancelled" }))).toBe("Cancelled");
    expect(stateWords(task({ state: "result_available", outcome: "interrupted" }))).toBe("Interrupted");
  });

  it("wears a class the stylesheet knows: the state while it runs, the outcome once it ends", () => {
    expect(stateClass(task({ state: "working" }))).toBe("working");
    expect(stateClass(task({ state: "waiting_for_children" }))).toBe("waiting_for_children");
    expect(stateClass(task({ state: "result_available", outcome: "done" }))).toBe("done");
    expect(stateClass(task({ state: "result_available", outcome: "cancelled" }))).toBe("cancelled");
    // A finish nobody recorded an outcome for still reads as an ending.
    expect(stateClass(task({ state: "result_available", outcome: null }))).toBe("interrupted");
  });
});

describe("who runs a task", () => {
  it("names the harness, then what the task asked for", () => {
    expect(metaText(task(), name)).toBe("Pi");
    expect(metaText(task({ model: "claude-sonnet-4-5", role: "review" }), name)).toBe("Pi · claude-sonnet-4-5 · review");
    expect(metaText(task({ profile: "reviewer" }), name)).toBe("Pi · reviewer");
    // A harness the client does not know keeps its id rather than vanishing.
    expect(metaText(task({ harnessId: asHarnessId("dsh") }), name)).toBe("dsh");
  });
  it("cuts a long line and says it did", () => {
    const long = metaText(task({ model: "a-very-long-model-name-that-runs-on", role: "review" }), name);
    expect(long.length).toBe(42);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("a task's line and clock", () => {
  it("prefers a question, then the child's last line, then its answer", () => {
    expect(taskLine(task({ asking: "Allow tool: bash" }))).toBe("Asks: Allow tool: bash");
    expect(taskLine(task({ activity: "Reading src/app.ts" }))).toBe("Reading src/app.ts");
    expect(taskLine(task({ result: { finalText: "\n\nEcho: hello\nmore", error: null, usage: null } }))).toBe("Echo: hello");
    expect(taskLine(task({ result: { finalText: "", error: "Cancelled by the parent", usage: null } }))).toBe("Cancelled by the parent");
    expect(taskLine(task())).toBeNull();
  });
  it("counts up while it runs, and stops at the end", () => {
    expect(taskElapsed(task({ createdAt: 1_000, endedAt: null }), 60_000)).toBe("59s");
    expect(taskElapsed(task({ createdAt: 1_000, endedAt: 3_000 }), 60_000)).toBe("2.0s");
  });
});

describe("the group's meta line", () => {
  it("counts what is working and what has finished, and says nothing with no tasks", () => {
    expect(tasksMeta([])).toBeNull();
    expect(tasksMeta([task(), task({ id: "b", state: "waiting_for_user" }), task({ id: "c", state: "result_available", outcome: "done" })])).toBe("2 working · 1 finished");
    expect(tasksMeta([task({ state: "result_available", outcome: "failed" })])).toBe("1 finished");
  });
});

describe("a worker's scope and the guard's count", () => {
  it("writes the write scope as its globs, or says it had none, with the scratch folder when it has one", () => {
    expect(scopeWords(task())).toBeNull();
    expect(scopeWords(task({ scope: { globs: ["src/**", "docs/*.md"], scratchDir: null, attempted: 0, blocked: 0, landed: 0, recent: [] } }))).toBe("Scope src/**, docs/*.md");
    expect(scopeWords(task({ scope: { globs: [], scratchDir: ".awui/scratch/ab12", attempted: 0, blocked: 0, landed: 0, recent: [] } }))).toBe("Scope anywhere in the project · scratch .awui/scratch/ab12");
  });

  it("says nothing when the guard saw nothing, and counts what it blocked and what landed", () => {
    expect(guardWords(task())).toBeNull();
    expect(guardWords(task({ scope: { globs: [], scratchDir: null, attempted: 0, blocked: 0, landed: 0, recent: [] } }))).toBeNull();
    expect(guardWords(task({ scope: { globs: [], scratchDir: null, attempted: 3, blocked: 2, landed: 1, recent: ["write unsafe-outside.ts"] } }))).toBe("Out of scope: 2 blocked before it ran · 1 landed and reported · write unsafe-outside.ts");
    expect(guardWords(task({ scope: { globs: [], scratchDir: null, attempted: 1, blocked: 0, landed: 0, recent: [] } }))).toBe("Out of scope: 1 seen");
  });
});

describe("a review's words and the actions it offers", () => {
  const open = { review: null, appliedAt: null, discardedAt: null, headsMatch: true, reason: null };
  const applied = { review: { decision: "apply" as const, note: "", by: "local", at: 5 }, appliedAt: 5, discardedAt: null, headsMatch: true, reason: null };

  it("says what the record is, in the browser's words", () => {
    expect(reviewWords(open)).toContain("Choose whether to apply its patch");
    expect(reviewWords({ ...open, appliedAt: 5, review: applied.review })).toContain("Approved and applied into the lead checkout");
    expect(reviewWords({ ...open, discardedAt: 6, review: { decision: "discard", note: "", by: "local", at: 6 } })).toContain("Reviewed without applying");
    expect(reviewWords({ ...open, headsMatch: false, reason: "lead_moved" })).toBe("Cannot apply yet: lead_moved. Open the worktree to inspect it.");
  });

  it("offers apply and keep until something is decided, then the inverse; apply is off when a head moved", () => {
    expect(reviewActions(open).map((a) => [a.id, a.enabled])).toEqual([["apply", true], ["discard", true]]);
    expect(reviewActions({ ...open, headsMatch: false, reason: "lead_moved" })[0]).toMatchObject({ id: "apply", enabled: false, why: "lead_moved" });
    expect(reviewActions({ ...open, headsMatch: null }).map((a) => a.enabled)).toEqual([true, true]);
    expect(reviewActions(applied).map((a) => [a.id, a.label, a.confirms])).toEqual([["unreview", "Undo apply", false]]);
    expect(reviewActions({ ...open, discardedAt: 6, review: { decision: "discard", note: "", by: "local", at: 6 } }).map((a) => [a.id, a.confirms])).toEqual([["unreview", false], ["cleanup", true]]);
  });
});
