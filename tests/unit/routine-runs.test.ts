// A routine's run history (routine-runs.ts): a record per run, its verdict, the
// session it opened (which the session lists leave out), and the caps that keep the
// file small however often a routine runs.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Routine } from "../../src/shared/protocol.js";
import { MAX_RUNS_PER_ROUTINE, RoutineRuns } from "../../src/server/routine-runs.js";

const routine = (id = "r1"): Routine => ({
  id,
  name: "Nightly review",
  prompt: "Review today's commits",
  harnessId: "fake",
  workspaceId: "w1",
  cadence: { kind: "daily", hour: 9, minute: 0 },
  precheck: "",
  timezone: "",
  until: null,
  maxRuns: null,
  graceMinutes: 0,
  hook: null,
  runs: 0,
  halted: null,
  enabled: true,
  nextRunAt: 0,
  lastRunAt: null,
  lastRunOutcome: null,
  lastRunDetail: null,
});

describe("a routine's run history", () => {
  it("writes a run as it starts, and its verdict when it ends", async () => {
    const runs = RoutineRuns.inMemory();
    const started = await runs.start(routine(), 1000);
    expect(started).toMatchObject({ routineId: "r1", name: "Nightly review", startedAt: 1000, endedAt: null, outcome: "launched" });
    await runs.attach(started.id, "chat-1");
    // Attaching is not ending: the run is still going.
    expect(runs.list("r1")[0]).toMatchObject({ chatId: "chat-1", endedAt: null, outcome: "launched" });
    const done = await runs.finish(started.id, { outcome: "posted", detail: "Found a flaky test", sessionId: "fake:s1", at: 2000 });
    expect(done).toMatchObject({ outcome: "posted", detail: "Found a flaky test", sessionId: "fake:s1", endedAt: 2000 });
  });

  it("lists newest first, only the routine asked for, and keeps the detail one bounded line", async () => {
    const runs = RoutineRuns.inMemory();
    const a = await runs.start(routine("r1"), 1000);
    const b = await runs.start(routine("r2"), 2000);
    await runs.finish(a.id, { outcome: "quiet", detail: null });
    await runs.finish(b.id, { outcome: "failed", detail: "x".repeat(1000) });
    expect(runs.list("r1").map((run) => run.routineId)).toEqual(["r1"]);
    expect(runs.list("r2")[0]).toMatchObject({ outcome: "failed", detail: "x".repeat(300) });
    expect(runs.list().map((run) => run.startedAt)).toEqual([2000, 1000]);
  });

  it("keeps only the newest runs of one routine", async () => {
    const runs = RoutineRuns.inMemory();
    for (let i = 0; i < MAX_RUNS_PER_ROUTINE + 3; i++) await runs.start(routine(), 1000 + i);
    const kept = runs.list("r1", 100);
    expect(kept).toHaveLength(MAX_RUNS_PER_ROUTINE);
    expect(kept[0]?.startedAt).toBe(1000 + MAX_RUNS_PER_ROUTINE + 2);
  });

  it("knows the sessions and chats a routine opened", async () => {
    const runs = RoutineRuns.inMemory();
    const run = await runs.start(routine());
    await runs.attach(run.id, "chat-1");
    await runs.finish(run.id, { outcome: "posted", detail: "done", sessionId: "fake:s1" });
    expect(runs.ownsSession("fake:s1")).toBe(true);
    expect(runs.ownsChat("chat-1")).toBe(true);
    expect(runs.ownsSession("fake:other")).toBe(false);
    expect(runs.ownsChat("chat-2")).toBe(false);
  });

  it("forgets a deleted routine's runs, but keeps hiding the sessions they opened", async () => {
    const runs = RoutineRuns.inMemory();
    const run = await runs.start(routine("r1"));
    await runs.finish(run.id, { outcome: "posted", detail: "done", sessionId: "fake:s1" });
    await runs.start(routine("r2"));
    await runs.forget("r1");
    expect(runs.list().map((run) => run.routineId)).toEqual(["r2"]);
    // Deleting the routine must not pour its past nights back into the sidebar.
    expect(runs.ownsSession("fake:s1")).toBe(true);
  });

  it("reads a file back, dropping what no longer validates", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "awui-routine-runs-"));
    try {
      writeFileSync(
        path.join(dir, "routine-runs.json"),
        JSON.stringify([
          { id: "a", routineId: "r1", name: "Nightly", startedAt: 1000, endedAt: 2000, outcome: "posted", detail: "ok", chatId: "c1", sessionId: "fake:s1" },
          { id: "b", routineId: "r1", outcome: "nonsense" },
          { id: "c", routineId: "r1", startedAt: 1000, outcome: "launched" },
          "junk",
        ]),
      );
      const runs = await RoutineRuns.open(dir);
      expect(runs.list().map((run) => run.id)).toEqual(["c", "a"]);
      expect(runs.list()[1]).toMatchObject({ chatId: "c1", sessionId: "fake:s1", detail: "ok" });
      // A run's session is remembered as the routine's, and so is one listed beside the runs.
      expect(runs.ownsSession("fake:s1")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
