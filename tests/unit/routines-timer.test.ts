// The routines timer's decision (routines-timer.ts): start each due routine once,
// and record how its slot ended (launched, skipped by a precheck, or failed).
import { describe, expect, it } from "vitest";
import type { Routine, RoutineOutcome } from "../../src/shared/protocol.js";
import { type RoutineDue, startDue } from "../../src/server/routines-timer.js";

const routine = (id: string, nextRunAt: number, enabled = true): Routine => ({
  id,
  name: id,
  prompt: "go",
  harnessId: "pi",
  workspaceId: "w",
  cadence: { kind: "daily", hour: 9, minute: 0 },
  precheck: "",
  enabled,
  nextRunAt,
  lastRunAt: null,
  lastRunOutcome: null,
  lastRunDetail: null,
});

type OutcomeMark = [string, RoutineOutcome, string | null];

/** A store that remembers the marks, so a second tick sees what the first did. */
function fakeStore(routines: Routine[]): RoutineDue & { marks: Array<[string, number]>; outcomes: OutcomeMark[] } {
  const marks: Array<[string, number]> = [];
  const outcomes: OutcomeMark[] = [];
  return {
    marks,
    outcomes,
    due: (now: number) => routines.filter((r) => r.enabled && r.nextRunAt <= now),
    markRan: async (id: string, at: number) => {
      marks.push([id, at]);
      const found = routines.find((r) => r.id === id);
      if (!found) return undefined;
      found.nextRunAt = at + 86_400_000;
      found.lastRunAt = at;
      return found;
    },
    markOutcome: async (id: string, outcome: RoutineOutcome, detail: string | null) => {
      outcomes.push([id, outcome, detail]);
      const found = routines.find((r) => r.id === id);
      if (!found) return undefined;
      found.lastRunOutcome = outcome;
      found.lastRunDetail = detail;
      return found;
    },
  };
}

describe("the routines timer", () => {
  it("starts every routine that is due, in one pass", async () => {
    const store = fakeStore([routine("a", 100), routine("b", 100), routine("later", 10_000)]);
    const started: string[] = [];
    expect(await startDue(store, async (r) => void started.push(r.id), 500)).toEqual(["a", "b"]);
    expect(started).toEqual(["a", "b"]);
    expect(store.marks).toEqual([
      ["a", 500],
      ["b", 500],
    ]);
    expect(store.outcomes).toEqual([
      ["a", "launched", null],
      ["b", "launched", null],
    ]);
    // A second tick at the same time starts nothing: they were claimed.
    expect(await startDue(store, async (r) => void started.push(r.id), 500)).toEqual([]);
  });

  it("claims one whose start throws, tells the reporter, and goes on", async () => {
    const store = fakeStore([routine("bad", 100), routine("good", 100)]);
    const started: string[] = [];
    const reported: string[] = [];
    const ids = await startDue(
      store,
      async (r) => {
        if (r.id === "bad") throw new Error("no model");
        started.push(r.id);
      },
      500,
      (r) => void reported.push(r.id),
    );
    expect(ids).toEqual(["good"]);
    expect(started).toEqual(["good"]);
    expect(reported).toEqual(["bad"]);
    // The failed slot is on record, with why; its next slot is the retry.
    expect(store.outcomes).toEqual([
      ["bad", "failed", "no model"],
      ["good", "launched", null],
    ]);
    expect(await startDue(store, async (r) => void started.push(r.id), 500)).toEqual([]);
  });

  it("records a skipped slot with its reason, and counts it as not started", async () => {
    const store = fakeStore([routine("quiet", 100)]);
    const ids = await startDue(store, async () => ({ outcome: "skipped", detail: "precheck exited 1: no changes" }), 500);
    expect(ids).toEqual([]);
    expect(store.outcomes).toEqual([["quiet", "skipped", "precheck exited 1: no changes"]]);
    // The slot is used up, so the next tick does not try it again.
    expect(await startDue(store, async () => undefined, 500)).toEqual([]);
  });

  it("never starts a disabled routine", async () => {
    const store = fakeStore([routine("off", 100, false), routine("on", 100)]);
    expect(await startDue(store, async () => undefined, 500)).toEqual(["on"]);
  });
});
