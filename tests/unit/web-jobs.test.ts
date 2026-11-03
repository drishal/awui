// The chat's background jobs, folded from the calls that hold them, and which show.
import { describe, expect, it } from "vitest";
import { chatJobs, FINISHED_SHOWN_MS, jobElapsed, shownJobs, STALE_AFTER_MS } from "../../src/web/jobs.js";
import type { BackgroundJob, ChatItem } from "../../src/shared/protocol.js";

const tool = (id: string, at: number, jobs: BackgroundJob[]): ChatItem => ({ kind: "tool", id, name: "bash", args: "{}", status: "done", output: "", truncated: false, category: "command", summary: "", paths: [], at, jobs });
const job = (over: Partial<BackgroundJob>): BackgroundJob => ({ id: "bg_1", kind: "shell", status: "running", label: "npm run test:e2e", ...over });

describe("chat jobs", () => {
  it("folds a wait's look into the job its start began, keeping the start's call and time", () => {
    const jobs = chatJobs([tool("t:a", 1000, [job({})]), tool("t:b", 5000, [job({ label: "bg_1", widget: { title: "e2e", blocks: [] } })])]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ toolId: "t:a", seenAt: 1000, label: "npm run test:e2e", widget: { title: "e2e" } });
    expect(jobElapsed(jobs[0]!, 61_000)).toBe(60_000);
  });

  it("never takes a finished job back to running", () => {
    const jobs = chatJobs([tool("t:a", 1000, [job({ status: "done", endedAt: 2000 })]), tool("t:b", 3000, [job({ status: "running" })])]);
    expect(jobs[0]?.status).toBe("done");
  });

  it("shows running jobs first, a finished one for a moment, and not one whose end was lost", () => {
    const now = 10 * 3600_000;
    const jobs = chatJobs([
      tool("t:a", now - 1000, [job({ id: "a", status: "done", endedAt: now - 500 })]),
      tool("t:b", now - 2000, [job({ id: "b" })]),
      tool("t:c", now - STALE_AFTER_MS - 1, [job({ id: "c" })]),
      tool("t:d", now - FINISHED_SHOWN_MS * 3, [job({ id: "d", status: "failed", endedAt: now - FINISHED_SHOWN_MS * 2 })]),
    ]);
    expect(shownJobs(jobs, now).map((j) => j.id)).toEqual(["b", "a"]);
  });
});
