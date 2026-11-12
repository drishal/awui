import { describe, expect, it } from "vitest";
import { asHarnessId, type DelegatedTaskView } from "../../src/shared/protocol.js";
import { metaText, stateClass, stateWords, taskElapsed, taskLine, tasksMeta } from "../../src/web/delegated-tasks.js";

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
