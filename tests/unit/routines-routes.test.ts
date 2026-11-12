// The routines routes: the dialog's reads and writes, validated against real projects,
// and the run history a routine's quiet runs leave (their sessions are not the user's).
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

async function setUp() {
  t = await makeTestApp();
  const agent = await signedIn(t);
  const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
  const body = (extra: object = {}) => ({ name: "Nightly review", prompt: "Review today", harnessId: "fake", workspaceId: ws.id, cadence: { kind: "daily", hour: 9, minute: 0 }, ...extra });
  return { agent, ws, body };
}

describe("the routines routes", () => {
  it("creates, lists, edits by id, and deletes", async () => {
    const { agent, body } = await setUp();
    expect((await agent.get("/api/routines")).body).toEqual({ routines: [] });
    const created = (await agent.put("/api/routines").send(body()).expect(200)).body as { id: string; nextRunAt: number; enabled: boolean };
    expect(created.id).toBeTruthy();
    expect(created.enabled).toBe(true);
    expect(created.nextRunAt).toBeGreaterThan(Date.now());

    const listed = (await agent.get("/api/routines").expect(200)).body as { routines: Array<{ id: string }> };
    expect(listed.routines.map((r) => r.id)).toEqual([created.id]);

    const edited = (await agent.put("/api/routines").send(body({ id: created.id, name: "Renamed" })).expect(200)).body as { id: string; name: string };
    expect(edited).toMatchObject({ id: created.id, name: "Renamed" });

    await agent.delete(`/api/routines/${created.id}`).expect(200);
    expect((await agent.get("/api/routines")).body).toEqual({ routines: [] });
    await agent.delete(`/api/routines/${created.id}`).expect(404);
  });

  it("refuses a bad cadence, a project that is not open, and a harness that is off", async () => {
    const { agent, body } = await setUp();
    expect((await agent.put("/api/routines").send(body({ cadence: { kind: "daily", hour: 24, minute: 0 } }))).status).toBe(400);
    expect((await agent.put("/api/routines").send(body({ workspaceId: "no-such-project" }))).status).toBe(404);
    expect((await agent.put("/api/routines").send(body({ harnessId: "nope" }))).status).toBe(404);
  });

  it("lists a routine's runs, and leaves the sessions they opened out of the user's list", async () => {
    const routineRuns = RoutineRuns.inMemory();
    t = await makeTestApp({ routineRuns });
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as WorkspaceInfo;
    const created = (await agent.put("/api/routines").send({ name: "Nightly review", prompt: "Review today", harnessId: "fake", workspaceId: ws.id, cadence: { kind: "daily", hour: 9, minute: 0 } }).expect(200)).body as Routine;

    // The timer's own call, driven here so the test does not wait for a clock.
    await runRoutine(created, ws, t.fake, t.manager, { runs: routineRuns });
    await until(() => routineRuns.list(created.id)[0]?.endedAt !== null);

    const history = (await agent.get(`/api/routines/runs?routineId=${created.id}`).expect(200)).body as { runs: RoutineRun[] };
    expect(history.runs).toHaveLength(1);
    expect(history.runs[0]).toMatchObject({ routineId: created.id, name: "Nightly review", outcome: "posted" });
    expect(history.runs[0]?.chatId).toBeTruthy();
    // Every routine's, when none is named; and the limit is bounded by the schema.
    expect(((await agent.get("/api/routines/runs").expect(200)).body as { runs: RoutineRun[] }).runs).toHaveLength(1);
    expect((await agent.get("/api/routines/runs?limit=1000")).status).toBe(400);

    // The run's chat is the routine's, not a chat of the user's: the session list leaves it out.
    const sessions = (await agent.get("/api/sessions").expect(200)).body as { sessions: Array<{ id: string; liveChatId?: string }> };
    expect(sessions.sessions.map((s) => s.liveChatId)).not.toContain(history.runs[0]?.chatId);
    expect(sessions.sessions.map((s) => s.id)).not.toContain(history.runs[0]?.sessionId);

    // Deleting the routine forgets its runs (and stops hiding their sessions).
    await agent.delete(`/api/routines/${created.id}`).expect(200);
    expect(((await agent.get("/api/routines/runs").expect(200)).body as { runs: RoutineRun[] }).runs).toEqual([]);
  });

  it("keeps a precheck, and refuses one longer than a command line", async () => {
    const { agent, body } = await setUp();
    const created = (await agent.put("/api/routines").send(body({ precheck: "  git diff --quiet HEAD  " })).expect(200)).body as { id: string; precheck: string; lastRunOutcome: string | null };
    expect(created.precheck).toBe("git diff --quiet HEAD");
    expect(created.lastRunOutcome).toBeNull();
    expect((await agent.put("/api/routines").send(body({ precheck: "x".repeat(501) }))).status).toBe(400);
  });
});

describe("a routine's schedule", () => {
  it("keeps a cron expression and a timezone, and says why one cannot run", async () => {
    const { agent, body } = await setUp();
    const created = (await agent.put("/api/routines").send(body({ cadence: { kind: "cron", expr: "0 9 * * 1-5" }, timezone: "Europe/Berlin" })).expect(200)).body as Routine;
    expect(created).toMatchObject({ cadence: { kind: "cron", expr: "0 9 * * 1-5" }, timezone: "Europe/Berlin", graceMinutes: 0, maxRuns: null, until: null, runs: 0, halted: null });
    expect(created.nextRunAt).toBeGreaterThan(Date.now());

    const bad = await agent.put("/api/routines").send(body({ cadence: { kind: "cron", expr: "0 9 * *" } }));
    expect(bad.status).toBe(400);
    expect((bad.body as { error: string }).error).toMatch(/five fields/);
    expect((await agent.put("/api/routines").send(body({ timezone: "Mars/Olympus" }))).status).toBe(400);
    expect((await agent.put("/api/routines").send(body({ until: Date.now() - 1000 }))).status).toBe(400);
    // A one-off in the past is refused too.
    expect((await agent.put("/api/routines").send(body({ cadence: { kind: "once", at: Date.now() - 1000 } }))).status).toBe(400);
  });

  it("runs one now, without moving its next slot", async () => {
    const { agent, body } = await setUp();
    const created = (await agent.put("/api/routines").send(body()).expect(200)).body as Routine;
    const ran = (await agent.post(`/api/routines/${created.id}/run`).expect(202)).body as { chatId: string; routineId: string };
    expect(ran.routineId).toBe(created.id);
    expect(ran.chatId).toBeTruthy();
    const after = ((await agent.get("/api/routines").expect(200)).body as { routines: Routine[] }).routines[0];
    expect(after?.nextRunAt).toBe(created.nextRunAt);
    expect(after?.runs).toBe(0);
    await agent.post("/api/routines/no-such/run").expect(404);
  });

  it("answers 409 when a run's precheck says there is nothing to do", async () => {
    const { agent, body } = await setUp();
    const created = (await agent.put("/api/routines").send(body({ precheck: "exit 1" })).expect(200)).body as Routine;
    const skipped = await agent.post(`/api/routines/${created.id}/run`);
    expect(skipped.status).toBe(409);
    expect((skipped.body as { error: string }).error).toMatch(/precheck exited 1/);
  });
});
