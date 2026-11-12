import { describe, expect, it } from "vitest";
import { asHarnessId, MAX_DELEGATED_TASKS, type ChatSnapshot, type DelegatedTaskView } from "../../src/shared/protocol.js";
import { applyEvents } from "../../src/web/chat-state.js";

/** Only what this fold reads is real; the rest of a snapshot is the server's business. */
const snapshot = (delegated?: DelegatedTaskView[]): ChatSnapshot => ({ chatId: "parent", items: [], lastEventId: 0, ...(delegated ? { delegated } : {}) }) as unknown as ChatSnapshot;

const task = (id: string, extra: Partial<DelegatedTaskView> = {}): DelegatedTaskView => ({
  id,
  parentChatId: "parent",
  childChatId: `child-${id}`,
  title: `Task ${id}`,
  harnessId: asHarnessId("pi"),
  model: null,
  role: "",
  profile: null,
  depth: 1,
  state: "working",
  outcome: null,
  createdAt: 1,
  endedAt: null,
  activity: null,
  result: null,
  asking: null,
  scope: null,
  reviewable: false,
  ...extra,
});

describe("the delegated tasks fold", () => {
  it("seeds the panel from the snapshot", () => {
    const state = applyEvents(null, [{ type: "snapshot", snapshot: snapshot([task("b"), task("a")]) }]);
    expect(state?.delegated?.map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("updates a row in place and puts a new task in front", () => {
    let state = applyEvents(null, [{ type: "snapshot", snapshot: snapshot([task("b"), task("a")]) }]);
    state = applyEvents(state, [{ type: "task", task: task("a", { state: "result_available", outcome: "done" }) }]);
    expect(state?.delegated?.map((t) => t.id)).toEqual(["b", "a"]);
    expect(state?.delegated?.[1]).toMatchObject({ id: "a", state: "result_available", outcome: "done" });

    state = applyEvents(state, [{ type: "task", task: task("c") }]);
    expect(state?.delegated?.map((t) => t.id)).toEqual(["c", "b", "a"]);
  });

  it("starts a list for a chat whose snapshot carried none, and keeps it bounded", () => {
    let state = applyEvents(null, [{ type: "snapshot", snapshot: snapshot() }]);
    expect(state?.delegated).toBeUndefined();
    state = applyEvents(state, [{ type: "task", task: task("a") }]);
    expect(state?.delegated?.map((t) => t.id)).toEqual(["a"]);

    for (let i = 0; i < MAX_DELEGATED_TASKS + 5; i += 1) state = applyEvents(state, [{ type: "task", task: task(`t${i}`) }]);
    expect(state?.delegated).toHaveLength(MAX_DELEGATED_TASKS);
    // Newest first: the oldest rows are the ones that fall off the end.
    expect(state?.delegated?.[0]?.id).toBe(`t${MAX_DELEGATED_TASKS + 4}`);
  });
});
