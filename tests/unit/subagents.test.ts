import { describe, expect, it } from "vitest";
import { historyToItems, toolCategory } from "../../src/server/harness/agent-events.js";
import { applyReports, asyncReports, detailReports, notifyReports, runsFromArgs, runsFromDetails, settleRuns, transcriptFile, transcriptRecords } from "../../src/server/harness/subagents.js";

describe("subagents", () => {
  it("knows delegation tools, and not todo lists", () => {
    for (const name of ["task", "subagent", "Task", "Agent", "spawn_subagent"]) expect(toolCategory(name), name).toBe("agent");
    expect(toolCategory("todo_write")).toBe("other");
    expect(toolCategory("tasks_list")).not.toBe("agent");
  });

  it("reads the runs a call asks for: pi-subagents, omp, Claude Code", () => {
    expect(runsFromArgs({ agent: "scout", task: "count lines" })).toEqual({ mode: "single", runs: [{ id: "0", agent: "scout", task: "count lines", status: "pending" }] });
    expect(runsFromArgs({ chain: [{ agent: "a", task: "x" }, { agent: "b", task: "{previous}" }] })?.mode).toBe("chain");
    expect(runsFromArgs({ context: "c", tasks: [{ name: "MethodContracts", agent: "scout", task: "read" }] })?.runs[0]).toMatchObject({ id: "MethodContracts", agent: "scout" });
    expect(runsFromArgs({ subagent_type: "general-purpose", description: "Find it", prompt: "Find the config loader" })?.runs[0]).toMatchObject({ agent: "general-purpose", task: "Find the config loader" });
    // Grok's spawn has no agent yet: the description is the label, and the prompt is the child's transcript.
    expect(runsFromArgs({ description: "Ping a subagent", prompt: "Reply with pong", background: true })).toEqual({
      mode: "single",
      background: true,
      runs: [{ id: "0", agent: "agent", task: "Ping a subagent", status: "pending" }],
    });
    expect(runsFromArgs({ action: "list" })).toBeNull();
  });

  it("folds pi-subagents' live progress and results, keeping the brief its details redact", () => {
    const start = runsFromArgs({ tasks: [{ agent: "scout", task: "Find the entry" }, { agent: "worker", task: "Summarize" }] });
    const live = runsFromDetails("call1", { mode: "parallel", progress: [{ index: 0, agent: "scout", status: "running", task: "[prompt redacted]", recentTools: [{ tool: "bash", args: "rg -n listen" }], toolCount: 1, tokens: 900, durationMs: 1200 }] }, start);
    expect(live?.runs.map((r) => [r.id, r.status, r.task])).toEqual([
      ["0", "running", "Find the entry"],
      ["1", "pending", "Summarize"],
    ]);
    expect(live?.runs[0]).toMatchObject({ activity: ["bash rg -n listen"], toolCount: 1, tokens: 900 });
    const done = runsFromDetails(
      "call1",
      {
        mode: "parallel",
        results: [
          { index: 0, agent: "scout", task: "[prompt redacted]", exitCode: 0, finalOutput: "src/server.ts:13", usage: { input: 2000, output: 100, cost: 0.002 }, model: "m", transcriptPath: "/tmp/t0_transcript.jsonl" },
          { index: 1, agent: "worker", task: "[prompt redacted]", exitCode: 1, error: "boom", usage: { input: 1, output: 1, cost: 0 } },
        ],
      },
      live,
    );
    expect(done?.runs[0]).toMatchObject({ id: "0", status: "done", task: "Find the entry", output: "src/server.ts:13", tokens: 2100, cost: 0.002, model: "m", transcript: true });
    expect(done?.runs[0]?.activity).toBeUndefined();
    expect(done?.runs[1]).toMatchObject({ status: "failed", error: "boom" });
    expect(transcriptFile("call1", "0")).toBe("/tmp/t0_transcript.jsonl");
  });

  it("takes omp's run ids, and its reports from deliveries, waits, and kills", () => {
    const start = runsFromArgs({ tasks: [{ agent: "scout", task: "# Target\nA" }, { agent: "scout", task: "# Target\nB" }] });
    const spawned = runsFromDetails("call2", { async: { state: "running" }, progress: [
      { index: 0, id: "RaspyQuokka", agent: "scout", status: "pending", task: "Complete assignment thoroughly:\n\n# Target\nA", assignment: "# Target\nA" },
      { index: 1, id: "FellowAntelope", agent: "scout", status: "pending", task: "…", assignment: "# Target\nB" },
    ] }, start) ;
    expect(spawned).toMatchObject({ background: true });
    expect(spawned?.runs.map((r) => [r.id, r.task, r.transcript])).toEqual([
      ["RaspyQuokka", "# Target\nA", true],
      ["FellowAntelope", "# Target\nB", true],
    ]);
    // A delivery message names the run, how it ended, and a preview of its answer.
    const delivered = asyncReports(
      "async-result",
      '<system-notice>\nBackground job RaspyQuokka has completed.\n<task-result id="RaspyQuokka" agent="scout" status="completed" duration="1m21s">\n<preview full-output="agent://RaspyQuokka">\n{"architecture": "gateway"}\n</preview>\n</task-result>\n</system-notice>',
      { jobs: [{ jobId: "RaspyQuokka", type: "task", durationMs: 81089 }, { jobId: "bg_1", type: "bash" }] },
    );
    expect(delivered).toEqual([{ id: "RaspyQuokka", status: "done", durationMs: 81089, output: '{"architecture": "gateway"}' }]);
    const after = applyReports(spawned as NonNullable<typeof spawned>, delivered);
    expect(after?.runs.map((r) => r.status)).toEqual(["done", "pending"]);
    // A wait's snapshot, and a kill.
    expect(detailReports({ op: "wait", jobs: [{ id: "FellowAntelope", type: "task", status: "completed", durationMs: 71614, resolvedModel: "m", resultText: '<task-result id="FellowAntelope" status="completed"><output>\nok\n</output></task-result>' }] })).toEqual([
      { id: "FellowAntelope", status: "done", durationMs: 71614, output: "ok", model: "m" },
    ]);
    expect(detailReports({ proc: { op: "cancel", jobs: [{ id: "X", type: "task", status: "cancelled" }] } })).toEqual([{ id: "X", status: "stopped" }]);
    expect(applyReports(spawned as NonNullable<typeof spawned>, [{ id: "Other", status: "done" }])).toBeNull();
  });

  it("keeps pi-subagents' background runs running until their notice comes", () => {
    const start = runsFromArgs({ agent: "scout", task: "count", async: true });
    const launched = runsFromDetails("call3", { mode: "single", results: [], asyncId: "d2027", asyncDir: "/tmp/runs/d2027" }, start);
    expect(launched).toMatchObject({ background: true, runs: [{ id: "0", status: "running", ref: "d2027", transcript: true }] });
    // The launch text is no answer.
    expect(settleRuns(launched as NonNullable<typeof launched>, "Async: scout [d2027]", false).runs[0]?.status).toBe("running");
    const notice = notifyReports(
      "subagent-notify",
      "Background task completed: **scout**\n\nscout:\nlist.txt has 3 lines.\n\nRetention-managed async directory: /tmp/pi-subagents-uid-1000/async-subagent-runs/d2027",
    );
    expect(notice).toEqual([{ id: "d2027", status: "done", output: "list.txt has 3 lines." }]);
    expect(applyReports(launched as NonNullable<typeof launched>, notice)?.runs[0]).toMatchObject({ status: "done", output: "list.txt has 3 lines." });
    const grouped = notifyReports(
      "subagent-notify",
      "Background tasks completed (2): **a**, **b**\n\n1. a\nfirst\nRetention-managed async directory: /x/r1\n\n2. b\n(no output)\nRetention-managed async directory: /x/r2",
    );
    expect(grouped).toEqual([
      { id: "r1", status: "done", output: "first" },
      { id: "r2", status: "done" },
    ]);
    expect(notifyReports("book-recall", "Background task completed: **x**")).toEqual([]);
  });

  it("settles a call that answered in text, and rebuilds runs from history", () => {
    const claude = runsFromArgs({ subagent_type: "Explore", prompt: "Find it" });
    expect(settleRuns(claude as NonNullable<typeof claude>, "Found in src/a.ts", false).runs[0]).toMatchObject({ status: "done", output: "Found in src/a.ts" });
    const items = historyToItems([
      { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "task", arguments: { tasks: [{ agent: "scout", task: "A" }] } }] },
      { role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "Spawned" }], details: { async: { state: "running" }, progress: [{ index: 0, id: "Quick", agent: "scout", status: "pending" }] } },
      { role: "custom", customType: "async-result", display: true, content: '<task-result id="Quick" agent="scout" status="failed">', details: { jobs: [] } },
    ]);
    expect(items[0]).toMatchObject({ kind: "tool", category: "agent", subagents: { background: true, runs: [{ id: "Quick", status: "failed" }] } });
  });

  it("reads pi-subagents' transcript records, skipping the launcher's audit copy", () => {
    const rec = (message: object) => JSON.stringify({ version: 1, recordType: "message", ts: 5, message });
    const text = [
      rec({ role: "user", content: [{ type: "text", text: "[prompt redacted]; live Prompt Audit only." }] }),
      rec({ role: "system", content: "You are a scout" }),
      rec({ role: "user", content: [{ type: "text", text: "Task: count" }] }),
      JSON.stringify({ version: 1, recordType: "tool_start", toolName: "bash" }),
      rec({ role: "assistant", content: [{ type: "text", text: "2 lines" }] }),
    ].join("\n");
    expect(transcriptRecords(text)).toEqual([
      { role: "user", content: [{ type: "text", text: "Task: count" }], timestamp: 5 },
      { role: "assistant", content: [{ type: "text", text: "2 lines" }], timestamp: 5 },
    ]);
    expect(transcriptRecords('{"type":"session","id":"x"}')).toBeNull();
  });
});
