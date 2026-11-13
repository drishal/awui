// Derived rail facts: each worker/job is meaningful only at its native-call scope.
import { describe, expect, it } from "vitest";
import { jobReadout, raceCount, runEntries, runReadout, taskAttention, taskReadout, validatedFolds, type JobSummary, type RunSummary } from "../../src/web/context-panel.js";
import type { ChatItem, DelegatedTaskView, RaceSummary } from "../../src/shared/protocol.js";

describe("context facts from real per-chat tool state", () => {
  it("deduplicates repeated async wait views, using each report's own call id", () => {
    const start: ChatItem = { kind: "tool", id: "first", name: "subagent", args: "", status: "running", category: "agent", output: "", summary: "", truncated: false, paths: [], subagents: { runs: [{ id: "0", agent: "scout", task: "Read code", status: "running", activity: ["bash rg listen"] }] } };
    const update: ChatItem = { ...start, id: "wait", subagents: { runs: [{ id: "0", agent: "scout", task: "Read code", status: "done" }] } };
    const rows = runEntries([start, update]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ toolId: "wait", id: "0", status: "done" });
  });

  it("counts unfinished work and only unresolved comparisons in this workspace", () => {
    const tasks = [{ state: "working" }, { state: "waiting_for_user" }, { state: "result_available" }] as DelegatedTaskView[];
    expect(taskAttention(tasks)).toBe(2);
    const races = [{ workspaceId: "ours", winnerChatId: "done" }, { workspaceId: "ours", winnerChatId: null }, { workspaceId: "other", winnerChatId: null }] as RaceSummary[];
    expect(raceCount(races, "ours")).toBe(1);
  });

  it("keeps only known section-folder settings", () => {
    expect(validatedFolds({ memory: true, jobs: false })).toEqual({ memory: true, jobs: false });
    expect(validatedFolds({}).memory).toBeUndefined();
  });
});

describe("a row's status and figures in the panel's own words", () => {
  it("reads run and job states as one status each, never the wire's snake_case", () => {
    expect((["pending", "running", "done", "failed", "stopped"] as RunSummary["status"][]).map((status) => runReadout(status).word)).toEqual(["Queued", "Working", "Done", "Failed", "Stopped"]);
    expect(runReadout("running").tone).toBe("working");
    expect(runReadout("failed").tone).toBe("failed");
    expect((["running", "done", "failed", "stopped"] as JobSummary["status"][]).map((status) => jobReadout(status).word)).toEqual(["Working", "Done", "Failed", "Stopped"]);
  });

  it("reads a delegated task by its outcome, not by the protocol's result_available", () => {
    expect(taskReadout({ state: "working", outcome: null })).toEqual({ tone: "working", word: "Working" });
    expect(taskReadout({ state: "waiting_for_user", outcome: null })).toEqual({ tone: "waiting", word: "Waiting for you" });
    expect(taskReadout({ state: "waiting_for_children", outcome: null })).toEqual({ tone: "waiting", word: "Waiting" });
    expect(taskReadout({ state: "result_available", outcome: null })).toEqual({ tone: "done", word: "Done" });
    expect(taskReadout({ state: "result_available", outcome: "failed" })).toEqual({ tone: "failed", word: "Failed" });
    expect(taskReadout({ state: "result_available", outcome: "cancelled" })).toEqual({ tone: "quiet", word: "Cancelled" });
    expect(taskReadout({ state: "result_available", outcome: "interrupted" })).toEqual({ tone: "quiet", word: "Interrupted" });
  });
});
