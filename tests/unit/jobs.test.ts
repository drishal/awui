// Background jobs read from each harness's recorded shapes: omp's backgrounded
// bash, wait, and async-result; Claude Code's run_in_background, TaskStop, and
// task notifications; the bg_task extension's spawn, list, and exit event.
import { describe, expect, it } from "vitest";
import { applyJobReports, claudeTaskNotice, jobReports, jobsFromCall, jobWidget, mergeJob } from "../../src/server/harness/jobs.js";
import { historyToItems } from "../../src/server/harness/agent-events.js";
import type { ToolItem } from "../../src/shared/protocol.js";

describe("omp's background jobs", () => {
  it("reads a backgrounded bash call as a running job", () => {
    const jobs = jobsFromCall("bash", { command: "npm run test:e2e", i: "Running the suite" }, { async: { state: "running", jobId: "bg_1", type: "bash" }, timeoutSeconds: 300 }, "");
    expect(jobs).toEqual([{ id: "bg_1", kind: "shell", status: "running", label: "npm run test:e2e", title: "Running the suite" }]);
  });

  it("reads a wait's jobs with their widget, bounded", () => {
    const details = {
      op: "wait",
      jobs: [
        {
          id: "bg_18",
          type: "bash",
          status: "completed",
          label: "npx playwright test tests/e2e/board.spec.ts 2>&1 | tail -14",
          intent: "Rerunning board spec",
          durationMs: 134720,
          resultText: "2 passed (2.2m)",
          widget: {
            title: "playwright · board.spec 6 tests",
            stage: "2 passed (2.2m)",
            state: "live",
            updatedAt: 1,
            blocks: [
              { kind: "grid", label: "tests", items: [{ label: "1", text: "✓", tone: "success" }, { label: "2", text: "✘", tone: "error" }] },
              { kind: "meter", label: "test files passed", value: 1.4, text: "8/6 files", tone: "success" },
              { kind: "spark", label: "tests passed", values: Array.from({ length: 90 }, (_, i) => i), last: "68 tests" },
              { kind: "nonsense" },
            ],
          },
        },
      ],
    };
    const [job] = jobsFromCall("wait", { i: "Waiting" }, details, "") ?? [];
    expect(job).toMatchObject({ id: "bg_18", status: "done", title: "Rerunning board spec", durationMs: 134720, output: "2 passed (2.2m)" });
    expect(job?.widget?.blocks.map((b) => b.kind)).toEqual(["grid", "meter", "spark"]);
    const meter = job?.widget?.blocks[1];
    expect(meter?.kind === "meter" && meter.value).toBe(1);
    const spark = job?.widget?.blocks[2];
    expect(spark?.kind === "spark" && spark.values.length).toBe(60);
  });

  it("reads an async-result as the job's end, its notice as the output", () => {
    const content = "<system-notice>\nBackground job bg_3 has completed. Resume your work using the result below.\nok\n</system-notice>";
    const [job] = jobReports("async-result", content, { jobs: [{ jobId: "bg_3", type: "bash", status: "completed", label: "tern ctl --help", durationMs: 66988 }] });
    expect(job).toMatchObject({ id: "bg_3", status: "done", label: "tern ctl --help", durationMs: 66988 });
    expect(job?.output).toContain("Background job bg_3 has completed");
    expect(job?.output).not.toContain("<system-notice>");
  });

  it("a job's report reaches the call that started it in a reloaded transcript", () => {
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "sleep 60" } }], timestamp: 1000 },
      { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "" }], details: { async: { state: "running", jobId: "bg_1", type: "bash" } }, timestamp: 1001 },
      { role: "custom", customType: "async-result", content: "done", details: { jobs: [{ jobId: "bg_1", type: "bash", status: "failed", label: "sleep 60" }] }, timestamp: 5000 },
    ];
    const tool = historyToItems(messages).find((i): i is ToolItem => i.kind === "tool");
    expect(tool?.jobs).toEqual([expect.objectContaining({ id: "bg_1", status: "failed", startedAt: 1000, endedAt: 5000 })]);
  });

  it("a proc read of a job omp no longer holds ends it, here and in a reloaded transcript", () => {
    const gone = "Background job or service not found: bg_1";
    expect(jobsFromCall("read", { path: "proc://bg_1" }, {}, gone)).toEqual([{ id: "bg_1", kind: "shell", status: "stopped", label: "bg_1" }]);
    expect(jobsFromCall("read", { path: "proc://bg_1" }, {}, "still going")).toBeNull();
    expect(jobsFromCall("read", { path: "src/app.ts" }, {}, gone)).toBeNull();
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "npm run test:e2e:fast" } }], timestamp: 1000 },
      { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "" }], details: { async: { state: "running", jobId: "bg_1", type: "bash" } }, timestamp: 1001 },
      { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "read", arguments: { path: "proc://bg_1" } }], timestamp: 2000 },
      { role: "toolResult", toolCallId: "c2", toolName: "read", content: [{ type: "text", text: gone }], details: {}, isError: true, timestamp: 2001 },
    ];
    const tool = historyToItems(messages).find((i): i is ToolItem => i.kind === "tool" && i.id.endsWith("c1"));
    expect(tool?.jobs).toEqual([expect.objectContaining({ id: "bg_1", status: "stopped", label: "npm run test:e2e:fast", startedAt: 1000, endedAt: 2001 })]);
  });

  it("a task left running with no report in a settled transcript reads as stopped", () => {
    // The EsetResearch shape: a task spawn's details mark it running; nothing ever reports again.
    const messages = [
      { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "task", arguments: { context: "Research" } }], timestamp: 1000 },
      { role: "toolResult", toolCallId: "c1", toolName: "task", content: [{ type: "text", text: "Spawned agent `EsetResearch` (job `EsetResearch`)." }], details: { async: { state: "running", jobId: "EsetResearch", type: "task" } }, timestamp: 1001 },
    ];
    const tool = historyToItems(messages).find((i): i is ToolItem => i.kind === "tool");
    expect(tool?.jobs).toEqual([expect.objectContaining({ id: "EsetResearch", kind: "task", status: "stopped" })]);
    expect(tool?.jobs?.[0]?.endedAt).toBeTypeOf("number");
  });
});

describe("Claude Code's background tasks", () => {
  it("reads a backgrounded Bash by its structured result, else its words", () => {
    const args = { command: "npm test", run_in_background: true, description: "Run the tests" };
    expect(jobsFromCall("Bash", args, { backgroundTaskId: "b11ldbem9" }, "")).toEqual([{ id: "b11ldbem9", kind: "shell", status: "running", label: "npm test", title: "Run the tests" }]);
    expect(jobsFromCall("Bash", args, undefined, "Command running in background with ID: bq8mz09pe. Output is being written to: /tmp/x")?.[0]?.id).toBe("bq8mz09pe");
    // A foreground Bash is no job.
    expect(jobsFromCall("Bash", { command: "ls" }, {}, "a\nb")).toBeNull();
  });

  it("reads a TaskStop and a task notification", () => {
    expect(jobsFromCall("TaskStop", { task_id: "b0c" }, { message: "Successfully stopped task: b0c (tail -f x)", task_id: "b0c" }, "")?.[0]).toMatchObject({ id: "b0c", status: "stopped" });
    expect(jobsFromCall("TaskStop", { task_id: "b0c" }, "Error: No task found with ID: b0c", "Error: No task found")).toBeNull();
    const notice = claudeTaskNotice("<task-notification>\n<task-id>b11</task-id>\n<status>failed</status>\n<summary>Background command \"Launch\" failed with exit code 144</summary>\n</task-notification>");
    expect(notice).toMatchObject({ id: "b11", status: "failed", title: 'Background command "Launch" failed with exit code 144' });
  });
});

describe("the bg_task extension", () => {
  const task = { id: "bg-1", title: "e2e suite", command: "npm run test:e2e", status: "running", exitCode: null, startedAt: 1792242946316, updatedAt: 1792242946316, pid: 1 };
  it("reads a spawn, a list, and an exit event", () => {
    expect(jobsFromCall("bg_task", { action: "spawn" }, { action: "spawn", task }, "")).toEqual([{ id: "bg-1", kind: "shell", status: "running", label: "npm run test:e2e", title: "e2e suite", startedAt: 1792242946316 }]);
    expect(jobsFromCall("bg_status", { action: "list" }, { action: "list", tasks: [task, { ...task, id: "bg-2", status: "failed", exitCode: 2, updatedAt: 9 }] }, "")?.map((j) => [j.id, j.status, j.exitCode])).toEqual([
      ["bg-1", "running", undefined],
      ["bg-2", "failed", 2],
    ]);
    const [ended] = jobReports("kendex-background-tasks:event", "Background task bg-1 finished.", { eventType: "exit", outputTail: "all good", task: { ...task, status: "completed", exitCode: 0, updatedAt: 99 } });
    expect(ended).toMatchObject({ id: "bg-1", status: "done", exitCode: 0, endedAt: 99, output: "all good" });
  });
});

describe("folding reports", () => {
  it("never takes a finished job back to running, and keeps a better label", () => {
    const done = { id: "b1", kind: "shell" as const, status: "done" as const, label: "npm test" };
    expect(mergeJob(done, { ...done, status: "running" })).toBe(done);
    expect(mergeJob({ ...done, status: "running" }, { id: "b1", kind: "shell", status: "failed", label: "b1" }).label).toBe("npm test");
  });

  it("stamps the end when the report ends a running job", () => {
    const running = [{ id: "b1", kind: "shell" as const, status: "running" as const, label: "x" }];
    expect(applyJobReports(running, [{ id: "b1", kind: "shell", status: "done", label: "b1" }], 42)?.[0]).toMatchObject({ status: "done", endedAt: 42 });
    expect(applyJobReports(running, [{ id: "other", kind: "shell", status: "done", label: "o" }], 42)).toBeNull();
  });

  it("drops a widget with nothing drawable", () => {
    expect(jobWidget({ blocks: [{ kind: "chart" }] })).toBeNull();
    expect(jobWidget({ headline: { text: "208", label: "passed" }, blocks: [] })).toEqual({ headline: { text: "208", label: "passed" }, blocks: [] });
  });
});
