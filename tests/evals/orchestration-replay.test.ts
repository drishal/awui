// Replay seen failures in native Fake harnesses, asserting what actually changed
// in tool state, parent wake and persistence, never a generic model grade.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import { makeTestApp, signedIn, tempDir, type TestApp } from "../helpers/app.js";
import type { ChatSnapshot, UserItem } from "../../src/shared/protocol.js";
import { ChatManager } from "../../src/server/chats/manager.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { Orchestrator } from "../../src/server/orchestration/orchestrator.js";
import { DEFAULT_ORCHESTRATION_LIMITS } from "../../src/server/orchestration/limits.js";
import { Workspaces } from "../../src/server/workspaces.js";


interface Context {
  app: TestApp;
  agent: Awaited<ReturnType<typeof signedIn>>;
  parent: ChatSnapshot;
  token: string;
}
type ReplayEvent =
  | { stage: "duplicate"; result: `${string}: 1 child` }
  | { stage: "scope-denial"; result: `1/1/0: ${string}` }
  | { stage: "cancellation"; result: `${string}: cancelled` }
  | { stage: "union-finish"; result: `${string} & ${string}` }
  | { stage: "restoration"; result: `${string}: interrupted once` };

interface ReplayCase {
  /** Scenarios are easily rechecked via --testNamePattern (id, not arbitrary model names). */
  id: string;
  bug: string;
  /** System state which says that failure was correctly rejected. */
  required: string;
  /** Real token HTTP call and native Fake session lifecycle. */
  exercise(ctx: Context): Promise<ReplayEvent>;
}

async function setup(app: TestApp): Promise<Context> {
  const agent = await signedIn(app);
  const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
  const parent = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
  const token = app.manager.list().find((chat) => chat.chatId === parent.chatId)?.orchestration?.token;
  if (!token) throw new Error("auth token absent from actual chat");
  return { app, agent, token, parent };
}
async function call(ctx: Context, tool: string, args: unknown): Promise<any> {
  return ctx.agent.post("/api/orchestration/call").set("x-awui-orch-token", ctx.token).send({ tool, args });
}
async function until(fn: () => boolean, why = "event", atMost = 12_000): Promise<void> {
  const started = Date.now();
  while (!fn()) {
    if (Date.now() - started > atMost) throw new Error(`waiting ${why}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
const cases: ReplayCase[] = [
  {
    id: "duplicate-delegation",
    bug: "Repeating the same client request generated twin workers and split its stable lineage.",
    required: "One logical task and child are retained by the idempotent client key.",
    exercise: async (ctx) => {
      const args = { brief: "rewrite the log with care", clientRequestId: "replay-token-01"};
      const first = await call(ctx, "delegate_task", args);
      expect(first.status).toBe(200);
      const again = await call(ctx, "delegate_task", args);
      expect(again.body.data.taskId).toBe(first.body.data.taskId);
      expect(again.body.data.childChatId).toBe(first.body.data.childChatId);
      const lineage = ctx.app.manager.list().filter((c) => c.lineage?.taskId === first.body.data.taskId);
      expect(lineage).toHaveLength(1);
      if (!first.body.data.taskId || lineage.length !== 1) throw new Error("did not deduplicate truly same request");
      return { stage: "duplicate", result: `${first.body.data.taskId}: 1 child` };
    },
  },
  {
    id: "safe-write-rejection",
    bug: "An unsafe write lacked a visible guard, so tools seemed to permit out-of-scope changes.",
    required: "Real fake write approval is denied before execution with blocked counts and no landed edit.",
    exercise: async (ctx) => {
      const result = await call(ctx, "delegate_task", { brief: "unsafe write beside parser", writeScope: ["src/**"] });
      await until(() => ctx.app.manager.get(ctx.parent.chatId).snapshot().delegated?.find((t) => t.id === result.body.data.taskId)?.outcome !== null, "guard-enforced delegated run");
      const scope = ctx.app.manager.get(ctx.parent.chatId).snapshot().delegated?.find((t) => t.id === result.body.data.taskId)?.scope;
      if (!scope || scope.attempted !== 1 || scope.blocked !== 1 || scope.landed !== 0) throw new Error(`bad actual scope record: ${JSON.stringify(scope)}`);
      if (!scope.recent.some((line) => line.includes("blocked") && line.includes("src/**"))) throw new Error("negative enforcement trace missed");
      return { stage: "scope-denial", result: `${scope.attempted}/${scope.blocked}/${scope.landed}: ${scope.recent[0]}` };
    },
  },
  {
    id: "cancel-settle",
    bug: "Cancelling a worker sometimes surfaced done after cancellation, invalidating reliable status consumers.",
    required: "Terminal cancellation remains cancelled and result_available rather than reflected as done.",
    exercise: async (ctx) => {
      const created = await call(ctx, "delegate_task", { brief: "slow changes" });
      const id = created.body.data.taskId as string;
      expect((await ctx.agent.post(`/api/chats/${ctx.parent.chatId}/tasks/${id}/cancel`).send({})).status).toBe(200);
      await until(() => ctx.app.manager.get(ctx.parent.chatId).snapshot().delegated?.find((t) => t.id === id)?.outcome === "cancelled", "task ends cancellation");
      const stored = ctx.app.manager.get(ctx.parent.chatId).snapshot().delegated?.find((t) => t.id === id);
      if (stored?.outcome !== "cancelled" || stored?.state !== "result_available") throw new Error("not reported with exact stop-sealed relationship");
      return { stage: "cancellation", result: `${id}: ${stored.outcome}` };
    },
  },
  {
    id: "delayed-group",
    bug: "The quickest member's response could wake the lead while a sibling still awaited human approval.",
    required: "A blocked group sends no result until its final member settles, then one consolidated message includes both ids.",
    exercise: async (ctx) => {
      const fast = await call(ctx, "delegate_task", { brief: "inspect routine write", completionGroup: "boundary" });
      const slow = await call(ctx, "delegate_task", { brief: "ask on scope gate", completionGroup: "boundary" });
      const child = slow.body.data.childChatId as string;
      await until(() => ctx.app.manager.get(child).snapshot().pending.length > 0, "second member's actual human approval");
      await until(() => ctx.app.manager.get(ctx.parent.chatId).snapshot().delegated?.find((t) => t.id === fast.body.data.taskId)?.outcome !== null, "first journey finished");
      expect(ctx.app.manager.get(ctx.parent.chatId).snapshot().items.filter((i) => i.kind === "user" && i.text.includes("[awui delegate")).length).toBe(0);
      const id = ctx.app.manager.get(child).snapshot().pending[0]?.id;
      if (!id) throw new Error("real approval has no request identity");
      await ctx.agent.post(`/api/chats/${child}/requests/${encodeURIComponent(id)}`).send({ answer: { kind: "confirm", confirmed: true } });
      await until(() => ctx.app.manager.get(ctx.parent.chatId).snapshot().items.some((i) => i.kind === "user" && i.text.includes("[awui delegate")), "one all-group ready prompt");
      const messages = ctx.app.manager.get(ctx.parent.chatId).snapshot().items.filter((i): i is UserItem => i.kind === "user" && i.text.includes("[awui delegate"));
      expect(messages).toHaveLength(1);
      expect(messages[0]?.text).toContain(fast.body.data.taskId);
      expect(messages[0]?.text).toContain(slow.body.data.taskId);
      return { stage: "union-finish", result: `${fast.body.data.taskId} & ${slow.body.data.taskId}` };
    },
  },
  {
    id: "interrupted-session",
    bug: "A task left working across a restart might resume implicitly instead of keeping its unique interrupted report.",
    required: "Unresolved orphan becomes interrupted on disk and wakes exactly once for the registered real parent session.",
    exercise: async (_ctx) => {
      const root = tempDir("awui-eval-start");
      mkdirSync(path.join(root, "project"), { recursive: true });
      const manager = new ChatManager();
      const registry = new HarnessRegistry();
      const fake = new FakeAdapter();
      registry.register(fake);
      await registry.refreshStatus();
      const { workspaces } = await Workspaces.create([root], root);
      const workspace = { id: "one", path: path.join(root, "project"), name: "project" };
      try {
        const parent = await manager.create(fake, workspace);
        const identity = parent.sessionId;
        if (!identity) throw new Error("no session to register after restart");
        const file = path.join(root, ".state", "orchestration", "tasks.json");
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({
          schemaVersion: 1,
          tasks: [{
            id: "lost", parentChatId: "forgotten", childChatId: null, title: "Original work", harnessId: "fake", model: null,
            role: "", profile: null, depth: 1, state: "working", outcome: null, createdAt: Date.now() - 20_000,
            endedAt: null, activity: null, result: null, asking: null, workspacePath: workspace.path, parentTitle: "Parent",
            parentSessionId: identity, childSessionId: "fake:unknown-session", generation: 0, cancelRequestedAt: null,
            notify: "wake", clientRequestId: null,
            wake: { pendingSince: null, deliveredAt: null, attempts: 0, skipped: null },
          }],
        }), { mode: 0o600 });
        const replays = new Orchestrator({ chats: manager, registry, workspaces, file, limits: () => DEFAULT_ORCHESTRATION_LIMITS, log: () => undefined });
        await replays.start();
        await replays.registered(parent);
        await until(() => parent.snapshot().items.some((item) => item.kind === "user" && item.text.includes("[awui delegate lost")), "one interruption wake");
        const messages = parent.snapshot().items.filter((i): i is UserItem => i.kind === "user" && i.text.includes("[awui delegate lost"));
        expect(messages).toHaveLength(1);
        expect(messages[0]?.text).toContain("interrupted");
        const ledger = JSON.parse(readFileSync(file, "utf8")).tasks[0];
        expect(ledger.outcome).toBe("interrupted");
        expect(ledger.state).toBe("result_available");
        expect(ledger.wake.skipped).toBeNull();
        await replays.registered(parent);
        expect(parent.snapshot().items.filter((i): i is UserItem => i.kind === "user" && i.text.includes("[awui delegate lost"))).toHaveLength(1);
        return { stage: "restoration", result: `${identity}: interrupted once` };
      } finally {
        await manager.shutdown();
      }
    },
  },
];

describe("orchestration tool-use failure replays (G10)", () => {
  let app: TestApp | undefined;
  const results: Array<{ id: string; bug: string; required: string; note: ReplayEvent }> = [];
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  for (const c of cases) {
    it(c.id, async () => {
      app = await makeTestApp();
      const ctx = await setup(app);
      expect(c.bug.length).toBeGreaterThan(5);
      expect(c.required.length).toBeGreaterThan(5);
      const note = await c.exercise(ctx);
      results.push({ id: c.id, bug: c.bug, required: c.required, note });
      if (process.env.AWUI_REPLAY_JSON === "1") console.info(JSON.stringify({ ...c, stage: note.stage, result: note.result }));
    });
  }

  it("covers guard, stop, group and abandoned results (rather than an alleged text reply)", () => {
    for (const id of ["duplicate-delegation", "safe-write-rejection", "cancel-settle", "delayed-group", "interrupted-session"]) {
      const reported = results.find((entry) => entry.id === id);
      if (!reported) throw new Error(`Replay ${id} did not run; proof point cannot be certified${app ? "" : " at create or setup"}`);
      expect(reported.bug, `${id}: report mechanism`).toBe(cases.find((c) => c.id === id)?.bug);
      expect(reported.required).toBe(cases.find((c) => c.id === id)?.required);
      expect(reported.note.stage).toMatch(/^(duplicate|scope-denial|cancellation|union-finish|restoration)$/);
      expect(reported.note.result.length).toBeGreaterThan(0);
    }
  });
});
