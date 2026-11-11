// Running a routine (routine-runner.ts): its precheck first (a non-zero exit skips
// the slot, no chat), then a chat in its project, with its prompt sent.
import { afterEach, describe, expect, it } from "vitest";
import type { Routine, WorkspaceInfo } from "../../src/shared/protocol.js";
import { runRoutine } from "../../src/server/routine-runner.js";
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
function routineFor(ws: WorkspaceInfo, precheck: string): Routine {
  return {
    id: "r1",
    name: "Nightly review",
    prompt: "Review today's commits",
    harnessId: "fake",
    workspaceId: ws.id,
    cadence: { kind: "daily", hour: 9, minute: 0 },
    precheck,
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
