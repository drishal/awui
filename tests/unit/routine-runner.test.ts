// Running a routine (routine-runner.ts): its precheck first (a non-zero exit skips
// the slot, no chat), then a chat in its project, with its prompt sent. A launched run
// is quiet: its verdict (posted, quiet, failed) is kept in the run history, and only a
// run with something to say posts a note.
import { afterEach, describe, expect, it } from "vitest";
import type { Routine, RoutineRun, WorkspaceInfo } from "../../src/shared/protocol.js";
import { runRoutine } from "../../src/server/routine-runner.js";
import { RoutineRuns } from "../../src/server/routine-runs.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** A routine for the fake harness in ws, with its precheck as given. */
function routineFor(ws: WorkspaceInfo, precheck: string, prompt = "Review today's commits"): Routine {
  return {
    id: "r1",
    name: "Nightly review",
    prompt,
    harnessId: "fake",
    workspaceId: ws.id,
    cadence: { kind: "daily", hour: 9, minute: 0 },
    precheck,
  timezone: "",
  until: null,
  maxRuns: null,
  graceMinutes: 0,
  hook: null,
  runs: 0,
  halted: null,
    enabled: true,
    nextRunAt: Date.now(),
    lastRunAt: null,
    lastRunOutcome: null,
    lastRunDetail: null,
  };
}

describe("running a routine", () => {
  it("opens a chat in its project and sends the prompt", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as WorkspaceInfo;

    const { chat } = await runRoutine(routineFor(ws, ""), ws, t.fake, t.manager);
    expect(chat).not.toBeNull();
    if (!chat) return;
    await until(() => chat.snapshot().items.some((item) => item.kind === "user"));
    expect(chat.snapshot().workspace.id).toBe(ws.id);
    expect(chat.snapshot().items.flatMap((item) => (item.kind === "user" ? [item.text] : []))).toEqual(["Review today's commits"]);
    await until(() => chat.status === "idle");
  });

  it("runs when the precheck exits zero", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as WorkspaceInfo;

    const { chat, detail } = await runRoutine(routineFor(ws, "true"), ws, t.fake, t.manager);
    expect(detail).toBeNull();
    expect(chat?.snapshot().workspace.id).toBe(ws.id);
    expect(t.manager.list()).toHaveLength(1);
  });

  it("records a posted run with what the agent said, and posts one note", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as WorkspaceInfo;
    const runs = RoutineRuns.inMemory();
    const notes: string[] = [];

    const { chat } = await runRoutine(routineFor(ws, ""), ws, t.fake, t.manager, { runs, post: (_routine, _chat, text) => notes.push(text) });
    expect(chat).not.toBeNull();
    await until(() => runs.list("r1")[0]?.endedAt !== null);
    const run = runs.list("r1")[0] as RoutineRun;
    expect(run.outcome).toBe("posted");
    expect(run.detail).toContain("Echo: Review today's commits");
    // The session it opened is what keeps it out of the user's session list.
    expect(run.sessionId).toMatch(/^fake:/);
    expect(notes).toHaveLength(1);
    // The record names the chat it opened, so the list can offer to open it.
    expect(run.chatId).toBe(chat?.chatId);
  });

  it("records a quiet run when the agent ends with nothing to say, and posts no note", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as WorkspaceInfo;
    const runs = RoutineRuns.inMemory();
    const notes: string[] = [];

    await runRoutine(routineFor(ws, "", "silent"), ws, t.fake, t.manager, { runs, post: (_r, _c, text) => notes.push(text) });
    await until(() => runs.list("r1")[0]?.endedAt !== null);
    expect(runs.list("r1")[0]).toMatchObject({ outcome: "quiet", detail: null });
    expect(notes).toEqual([]);

    // A run that says QUIET on its first line is quiet too, without an empty answer.
    await runRoutine(routineFor(ws, "", "quietrun"), ws, t.fake, t.manager, { runs, post: (_r, _c, text) => notes.push(text) });
    await until(() => runs.list("r1").length === 2 && runs.list("r1")[0]?.endedAt !== null);
    expect(runs.list("r1")[0]).toMatchObject({ outcome: "quiet", detail: null });
  });

  it("records a failed run, and posts no note", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as WorkspaceInfo;
    const runs = RoutineRuns.inMemory();
    const notes: string[] = [];

    await runRoutine(routineFor(ws, "", "fail"), ws, t.fake, t.manager, { runs, post: (_r, _c, text) => notes.push(text) });
    await until(() => runs.list("r1")[0]?.endedAt !== null);
    expect(runs.list("r1")[0]).toMatchObject({ outcome: "failed", detail: "Fake failure" });
    expect(notes).toEqual([]);
  });

  it("skips the slot, with the exit and what it said, when the precheck fails", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as WorkspaceInfo;

    const { chat, detail } = await runRoutine(routineFor(ws, "echo nothing to review; exit 3"), ws, t.fake, t.manager);
    expect(chat).toBeNull();
    expect(detail).toBe("precheck exited 3: nothing to review");
    // No chat was opened at all, so no prompt was sent and no harness spawned.
    expect(t.manager.list()).toHaveLength(0);
  });
});
