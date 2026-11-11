// The routines routes: the dialog's reads and writes, validated against real projects.
import { afterEach, describe, expect, it } from "vitest";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

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

  it("keeps a precheck, and refuses one longer than a command line", async () => {
    const { agent, body } = await setUp();
    const created = (await agent.put("/api/routines").send(body({ precheck: "  git diff --quiet HEAD  " })).expect(200)).body as { id: string; precheck: string; lastRunOutcome: string | null };
    expect(created.precheck).toBe("git diff --quiet HEAD");
    expect(created.lastRunOutcome).toBeNull();
    expect((await agent.put("/api/routines").send(body({ precheck: "x".repeat(501) }))).status).toBe(400);
  });
});
