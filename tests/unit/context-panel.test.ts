// Derived rail facts: each worker/job is meaningful only at its native-call scope.
import { describe, expect, it } from "vitest";
import { raceCount, runEntries, taskAttention, validatedFolds } from "../../src/web/context-panel.js";
import type { ChatItem, RaceSummary, DelegatedTaskView } from "../../src/shared/protocol.js";

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
