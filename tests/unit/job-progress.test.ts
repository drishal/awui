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
    expect(jobProgress([], true)).toBeNull();
    expect(jobProgress([toolItem("t1", [])], true)).toBeNull();
  });

  it("counts across delegation calls still in flight and vanishes when the last run settles", () => {
    const live = [toolItem("t1", [run("a", "running"), run("b", "pending")]), toolItem("t2", [run("c", "done"), run("d", "running")])];
    const p = jobProgress(live, true);
    expect(p).toMatchObject({ total: 4, running: 2, queued: 1, done: 1, active: 3 });
    expect(jobLine(p!)).toEqual({ label: "2 running agents", meta: "1 queued · 1/4 done" });
    expect(jobProgress([toolItem("t3", [run("e", "done")])], true)).toBeNull();
  });

  it("keeps showing a background call's runs after its tool item settled", () => {
    const p = jobProgress([toolItem("t1", [run("a", "running")], { background: true, status: "done" })], true);
    expect(p).toMatchObject({ total: 1, active: 1, mode: "background" });
    expect(jobLine(p!)).toEqual({ label: "1 running jobs", meta: "" });
  });

  it("labels a wholly queued fan-out", () => {
    const p = jobProgress([toolItem("t1", [run("a", "pending"), run("b", "pending")], { background: true })], true);
    expect(p).toMatchObject({ total: 2, active: 2, running: 0 });
    expect(jobLine(p!)).toEqual({ label: "2 queued jobs", meta: "" });
  });

  it("ignores fully settled calls: their failed/done runs stay in their own card", () => {
    // Two earlier delegations failed outright; one current call is driving one run.
    const items = [toolItem("old1", [run("a", "failed"), run("b", "failed")], { status: "done" }), toolItem("old2", [run("c", "done")], { status: "done" }), toolItem("now", [run("d", "running")])];
    const p = jobProgress(items, true);
    expect(p).toMatchObject({ total: 1, running: 1, failed: 0, done: 0 });
  });

  it("drops runs nothing will settle: an open call once the chat is idle, a background run from an earlier turn", () => {
    const user = (id: string) => ({ kind: "user", id, text: "go" }) as unknown as ChatItem;
    // A call stopped mid-run never gets its result, so its runs keep reading "running".
    const stopped = [user("u1"), toolItem("t1", [run("a", "running")])];
    expect(jobProgress(stopped, true)).toMatchObject({ running: 1 });
    expect(jobProgress(stopped, false)).toBeNull();
    // A settled call's runs are the call's history, even mid-run.
    expect(jobProgress([user("u1"), toolItem("t1", [run("a", "running")], { status: "done" })], true)).toBeNull();
    // A background run goes on while the chat is idle, but not past the next prompt: its report would have come by then.
    const background = toolItem("t1", [run("a", "running")], { background: true, status: "done" });
    expect(jobProgress([user("u1"), background], false)).toMatchObject({ mode: "background", running: 1 });
    expect(jobProgress([user("u1"), background, user("u2")], false)).toBeNull();
  });
});
