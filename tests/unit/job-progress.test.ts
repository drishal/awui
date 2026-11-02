import { describe, expect, it } from "vitest";
import { jobLine, jobProgress } from "../../src/web/job-progress.js";
import type { ChatItem, SubagentRun } from "../../src/shared/protocol.js";

function run(id: string, status: SubagentRun["status"]): SubagentRun {
  return { id, agent: "scout", task: "t", status };
}

function toolItem(id: string, runs: SubagentRun[], extra: { background?: boolean; status?: "running" | "done" } = {}): ChatItem {
  return {
    kind: "tool",
    id,
    name: "task",
    args: {},
    status: extra.status ?? "running",
    output: "",
    subagents: { runs, ...(extra.background ? { background: true } : {}) },
  } as unknown as ChatItem;
}

describe("jobProgress", () => {
  it("is null with no subagent items", () => {
    expect(jobProgress([])).toBeNull();
    expect(jobProgress([toolItem("t1", [])])).toBeNull();
  });

  it("counts across delegation calls still in flight and vanishes when the last run settles", () => {
    const live = [toolItem("t1", [run("a", "running"), run("b", "pending")]), toolItem("t2", [run("c", "done"), run("d", "running")])];
    const p = jobProgress(live);
    expect(p).toMatchObject({ total: 4, running: 2, queued: 1, done: 1, active: 3 });
    expect(jobLine(p!)).toEqual({ label: "2 running agents", meta: "1 queued · 1/4 done" });
    expect(jobProgress([toolItem("t3", [run("e", "done")])])).toBeNull();
  });

  it("keeps showing a background call's runs after its tool item settled", () => {
    const p = jobProgress([toolItem("t1", [run("a", "running")], { background: true, status: "done" })]);
    expect(p).toMatchObject({ total: 1, active: 1, mode: "background" });
    expect(jobLine(p!)).toEqual({ label: "1 running jobs", meta: "" });
  });

  it("labels a wholly queued fan-out", () => {
    const p = jobProgress([toolItem("t1", [run("a", "pending"), run("b", "pending")], { background: true })]);
    expect(p).toMatchObject({ total: 2, active: 2, running: 0 });
    expect(jobLine(p!)).toEqual({ label: "2 queued jobs", meta: "" });
  });

  it("ignores fully settled calls: their failed/done runs stay in their own card", () => {
    // Two earlier delegations failed outright; one current call is driving one run.
    const items = [toolItem("old1", [run("a", "failed"), run("b", "failed")], { status: "done" }), toolItem("old2", [run("c", "done")], { status: "done" }), toolItem("now", [run("d", "running")])];
    const p = jobProgress(items);
    expect(p).toMatchObject({ total: 1, running: 1, failed: 0, done: 0 });
  });
});
