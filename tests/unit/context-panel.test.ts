// Derived rail facts: each worker/job is meaningful only at its native-call scope.
import { describe, expect, it } from "vitest";
import { contextCards, gitSummary, gitSummaryLine, jobReadout, raceCount, runEntries, runReadout, taskAttention, taskReadout, tokenCount, validatedFolds, type JobSummary, type RunSummary } from "../../src/web/context-panel.js";
import type { ChatItem, DelegatedTaskView, GitStatus, RaceSummary, ReviewThread, SecondOpinion } from "../../src/shared/protocol.js";

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

  it("summarizes the project line: branch, files, diff lines, and any operation", () => {
    const git = { branch: "main", head: "abc1234", files: [{ path: "a.ts" }, { path: "b.ts" }], more: 3, operation: "rebase", added: 12, removed: 4 } as unknown as GitStatus;
    expect(gitSummary(git)).toEqual({ branch: "main", files: 5, operation: "rebase", added: 12, removed: 4 });
    expect(gitSummary({ ...git, branch: null, head: "abc1234" })).toMatchObject({ branch: "detached at abc1234" });
    expect(gitSummary(null)).toBeNull();
  });

  it("writes token figures short, and says so when the harness did not report one", () => {
    expect(tokenCount(840)).toBe("840");
    expect(tokenCount(8400)).toBe("8.4k");
    expect(tokenCount(21_150)).toBe("21k");
    expect(tokenCount(100_000)).toBe("100k");
    expect(tokenCount(1_250_000)).toBe("1.3M");
    expect(tokenCount(null)).toBe("unknown");
  });
});

describe("the rail as cards of rows, for a client that draws no sections", () => {
  const runTool: ChatItem = {
    kind: "tool",
    id: "call-1",
    name: "subagent",
    args: "",
    status: "done",
    category: "agent",
    output: "",
    summary: "",
    truncated: false,
    paths: [],
    subagents: { runs: [{ id: "0", agent: "scout", task: "Read the parser", status: "running", activity: ["bash rg parse"] }] },
    jobs: [{ id: "j1", kind: "shell", label: "npm test", title: "Running the suite", status: "running", output: "ok 1" }],
  };
  const workspace = { id: "ws-1", name: "alpha", path: "/tmp/alpha" };
  const chat = {
    items: [runTool],
    pending: [{ id: "r1", kind: "confirm" as const, title: "Allow tool: bash", createdAt: 1 }],
    delegated: [{ id: "t1", parentChatId: "p", childChatId: "c1", title: "Review the parser", harnessId: "pi", model: null, role: "", profile: null, depth: 1, state: "result_available", outcome: "done", createdAt: 1, endedAt: 2, activity: null, result: null, asking: null, scope: null, reviewable: true } as DelegatedTaskView],
    workspace,
    context: { percent: 42, tokens: 8400, window: 20_000, categories: [] },
  };
  const race = { id: "race-1", workspaceId: "ws-1", workspaceName: "alpha", prompt: "Which parser?", base: "main", createdAt: 1, winnerChatId: null, cleanedAt: null, members: [{ status: "running" }, { status: "running" }] } as unknown as RaceSummary;
  const opinion = { id: "op-1", turn: 2, from: "pi", to: "claude", chatId: "op-chat", ask: "Is this sound?", askedAt: 1, report: null } as SecondOpinion;
  const thread = { id: "th-1", chatId: "c1", anchor: { path: "src/app.ts", side: "add", line: 12, hash: "abcd1234", text: "const x = 1;" }, notes: [{ id: "n1", text: "Name this better", at: 1 }], status: "open", createdAt: 1 } as unknown as ReviewThread;

  it("groups the snapshot's own work into the browser's cards, each row naming its target", () => {
    const cards = contextCards({ chat, races: [race], opinions: [opinion], threads: [thread] });
    expect(cards.map((c) => c.id)).toEqual(["agents", "tasks", "jobs", "questions", "races", "opinions", "review", "memory"]);
    const byId = new Map(cards.map((c) => [c.id, c]));
    expect(byId.get("agents")?.rows[0]).toMatchObject({ title: "Read the parser", meta: "Agent · scout · bash rg parse", status: { word: "Working" }, target: { kind: "tool", toolId: "call-1" } });
    expect(byId.get("tasks")?.rows[0]).toMatchObject({ title: "Review the parser", status: { word: "Done" }, target: { kind: "chat", chatId: "c1" }, taskId: "t1" });
    expect(byId.get("tasks")?.rows[0]?.note).toContain("review");
    expect(byId.get("jobs")?.rows[0]).toMatchObject({ title: "Running the suite", meta: "Shell job", status: { word: "Working" } });
    expect(byId.get("questions")?.rows[0]).toMatchObject({ title: "Allow tool: bash", meta: "Approval", status: { tone: "waiting" } });
    expect(byId.get("races")?.rows[0]).toMatchObject({ title: "Which parser?", meta: "2 chats", status: { word: "Working" } });
    expect(byId.get("opinions")?.rows[0]).toMatchObject({ title: "Is this sound?", meta: "Asked claude", target: { kind: "chat", chatId: "op-chat" } });
    expect(byId.get("review")?.rows[0]).toMatchObject({ title: "src/app.ts:12", meta: "Name this better", status: { word: "Open" } });
    expect(byId.get("memory")?.rows[0]).toMatchObject({ meta: "8.4k of 20k tokens", status: { word: "42%" } });
  });

  it("leaves out a group with nothing in it, and keeps the context card as the browser does", () => {
    const cards = contextCards({ chat: { ...chat, items: [], pending: [], delegated: [], context: null }, races: null, opinions: null, threads: null });
    expect(cards.map((c) => c.id)).toEqual(["memory"]);
    expect(cards[0]?.rows[0]).toMatchObject({ status: { word: "—" }, meta: "This harness has not reported a context window" });
    // A project's comparisons are only this chat's when they share its project.
    expect(contextCards({ chat, races: [{ ...race, workspaceId: "other" }], opinions: null, threads: null }).some((c) => c.id === "races")).toBe(false);
  });

  it("warns on the context card once the window is 80% full", () => {
    const cards = contextCards({ chat: { ...chat, items: [], pending: [], delegated: [], context: { percent: 81, tokens: 16_200, window: 20_000, categories: [] } }, races: null, opinions: null, threads: null });
    expect(cards[0]).toMatchObject({ id: "memory", attention: "warn" });
  });
});

describe("the project line the summary card draws", () => {
  it("writes the branch, any operation, and the files with their lines", () => {
    const git = { branch: "main", head: "abc1234", files: [{ path: "a.ts" }], more: 2, operation: null, added: 12, removed: 4 } as unknown as GitStatus;
    expect(gitSummaryLine(git)).toBe("main · 3 files +12 −4");
    expect(gitSummaryLine({ ...git, branch: null, head: "abc1234" })).toBe("detached at abc1234 · 3 files +12 −4");
    expect(gitSummaryLine({ ...git, files: [], more: 0, operation: "rebase" })).toBe("main · rebase in progress · clean");
    expect(gitSummaryLine(null)).toBeNull();
  });
});
