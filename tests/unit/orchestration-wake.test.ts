// The wake report's composition: bounded, and honest about a task that did not fit.
import { describe, expect, it } from "vitest";
import { MAX_WAKE_CHARS, wakeReport } from "../../src/server/orchestration/wake.js";
import type { StoredTask } from "../../src/server/orchestration/types.js";

function task(id: string, finalText: string): StoredTask {
  return {
    id,
    title: `task ${id}`,
    harnessId: "fake",
    outcome: "done",
    state: "result_available",
    createdAt: 0,
    endedAt: 1000,
    result: { finalText, error: null, usage: null },
  } as unknown as StoredTask;
}

describe("wakeReport", () => {
  it("reports each task in one message", () => {
    const text = wakeReport([task("aa11", "first answer"), task("bb22", "second answer")]);
    expect(text).toContain("[awui delegate aa11 · done · fake");
    expect(text).toContain("second answer");
    expect(text).toContain('thread_read("bb22")');
  });

  it("stays within its bound and names the tasks that did not fit", () => {
    const big = "x".repeat(3900);
    const text = wakeReport([task("aa11", big), task("bb22", big), task("cc33", big)]);
    expect(text.length).toBeLessThanOrEqual(MAX_WAKE_CHARS + 200);
    expect(text).toContain("aa11");
    expect(text).toMatch(/\[\d+ more finished tasks? did not fit here/);
  });
});
