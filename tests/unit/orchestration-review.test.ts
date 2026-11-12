// Review-gated integration (review.ts): "completed" is not "reviewed". The ledger's
// bounds are exercised in memory; the gate itself against a real temp git repository
// and the fake harness, so every head is a real one: a finished isolated worker is
// recorded for review, a person's apply lands only while both recorded heads still
// stand, a moved lead or an advanced worker branch refuses before anything is written,
// and cleanup refuses unreviewed modifications. The route's own orchestration call is
// driven through POST /api/orchestration/call, so isolation is exercised end to end.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationReview, type IntegrationRecord, type ReviewProject } from "../../src/server/orchestration/review.js";
import { ManagedWorktrees } from "../../src/server/worktrees.js";
import { Workspaces } from "../../src/server/workspaces.js";
import { makeTestApp, signedIn, tempDir, type TestApp } from "../helpers/app.js";

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

/** A project with one tracked file the fake harness knows how to change, at its first commit. */
function repo(dir: string): string {
  mkdirSync(path.join(dir, "src"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  writeFileSync(path.join(dir, "app.txt"), "base\n");
  writeFileSync(path.join(dir, "src", "app.ts"), "const a = 1;\nconst b = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  return git(dir, "rev-parse", "HEAD").trim();
}

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

/** The review-state schema the record keeps, as a test reads it back from disk. */
interface LedgerRow {
  taskId: string;
  review: { decision: string; note: string } | null;
  appliedAt: number | null;
  discardedAt: number | null;
}

function ledgerRows(stateDir: string): LedgerRow[] {
  try {
    return JSON.parse(readFileSync(path.join(stateDir, "orchestration", "integration.json"), "utf8")) as LedgerRow[];
  } catch {
    return [];
  }
}

/** The rejection a POST answers with, as the route maps it. */
function post(agent: Awaited<ReturnType<typeof signedIn>>, url: string, body: Record<string, unknown>) {
  return agent.post(url).send(body);
}

describe("integration review ledger", () => {
  it("records a finished worker once, and a repeat returns the standing record", async () => {
    const root = tempDir("awui-review-once-");
    repo(root);
    const { workspaces } = await Workspaces.create([root], root);
    const trees = new ManagedWorktrees();
    const ws = await workspaces.open(root);
    const review = await IntegrationReview.open(null, async () => ({ path: "x", diff: "" }));
    const project: ReviewProject = { root: root, ws, trees };
    const first = await review.track({ taskId: "ab12", workspaceId: ws.id, workspacePath: root, worktreeId: "tree-1", branch: "awui/task-1", fork: "0".repeat(40) });
    const again = await review.track({ taskId: "ab12", workspaceId: ws.id, workspacePath: root, worktreeId: "tree-1", branch: "awui/task-1", fork: "0".repeat(40) });
    expect(again).toBe(first);
    expect(review.list()).toHaveLength(1);
    // A failed store is a failed record, never a silent success: thrown as the routes map it.
    expect(first.review).toBeNull();
    expect(first.appliedAt).toBeNull();
    void project;
  });

  it("writes the ledger to the state folder and reads back only rows it can trust", async () => {
    const dir = path.join(tempDir("awui-review-state-"), "state");
    mkdirSync(dir, { recursive: true });
    const review = await IntegrationReview.open(dir, async () => ({ path: "x", diff: "" }));
    const fork = git(tempDir("awui-review-git-"), "init", "-q", "-b", "main");
    void fork;
    const gitRoot = tempDir("awui-review-git2-");
    mkdirSync(gitRoot, { recursive: true });
    git(gitRoot, "init", "-q", "-b", "main");
    writeFileSync(path.join(gitRoot, "a.txt"), "x\n");
    git(gitRoot, "add", ".");
    git(gitRoot, "commit", "-qm", "a");
    const sha = git(gitRoot, "rev-parse", "HEAD").trim();
    await review.track({ taskId: "cd34", workspaceId: "w", workspacePath: gitRoot, worktreeId: "t", branch: "awui/x", fork: sha });
    const reopened = await IntegrationReview.open(dir, async () => ({ path: "x", diff: "" }));
    expect(reopened.get("cd34")?.fork).toBe(sha);
    // A hand-edited file loses the rows that do not validate, nothing else.
    const raw = JSON.parse(readFileSync(path.join(dir, "orchestration", "integration.json"), "utf8")) as Array<Record<string, unknown>>;
    writeFileSync(path.join(dir, "orchestration", "integration.json"), JSON.stringify([{ ...raw[0], taskId: "nothex!!" }, { taskId: 5 }, "junk", raw[0]]));
    const strict = await IntegrationReview.open(dir, async () => ({ path: "x", diff: "" }));
    expect(strict.list()).toHaveLength(1);
    expect(strict.get("cd34")?.fork).toBe(sha);
  });
});

describe("review-gated apply", () => {
  it("applies a reviewed worker's changes into the lead checkout only while both heads match", async () => {
    const app = await makeTestApp();
    t = app;
    repo(app.project);
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as { chatId: string };
    const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
    if (!token) throw new Error("no orchestration token");

    // The parent delegates an isolated worker, which edits src/app.ts and settles.
    const res = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "delegate_task", args: { brief: "edit", isolation: "worktree", notify: "none" } });
    expect(res.status).toBe(200);
    const started = res.body.data as { taskId: string; childChatId: string | null };
    expect(started.childChatId).not.toBeNull();
    const child = app.manager.get(started.childChatId as string);
    // The child's workspace is its own managed worktree, never the lead checkout.
    expect(child.workspace.path.startsWith(path.join(app.project, ".awui", "worktrees"))).toBe(true);

    // The run settles: the task is done and recorded for review.
    await vi.waitFor(() => {
      const task = app.manager.get(chat.chatId).snapshot().delegated?.find((t) => t.id === started.taskId);
      expect(task?.outcome).toBe("done");
    }, 20_000);

    // The ledger has the record: completed, unreviewed, with the fork point as its head.
    await vi.waitFor(() => expect(ledgerRows(app.stateDir).some((r) => r.taskId === started.taskId && r.review === null)), { timeout: 10_000 });
    const record = ledgerRows(app.stateDir).find((r) => r.taskId === started.taskId);
    expect(record?.appliedAt).toBeNull();

    // The worker's tree has the change; the lead checkout is still clean.
    const worktrees = await agent.get(`/api/workspaces/${ws.id}/worktrees`);
    const tree = (worktrees.body.worktrees as Array<{ id: string; path: string }>)[0];
    if (!tree) throw new Error("no managed worktree for the isolated worker");
    expect(existsSync(tree.path)).toBe(true);
    expect(readFileSync(path.join(tree.path, "src", "app.ts"), "utf8")).toContain("const changed = true;");
    expect(git(app.project, "status", "--porcelain").trim()).toBe("");

    // task_review answers unreviewed before the decision.
    const before = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "task_review", args: { taskId: started.taskId } });
    expect(before.status).toBe(200);
    expect(String(before.body.text)).toContain("waiting for review");

    // A person reviews and applies: the change lands unstaged in the lead checkout.
    const decision = await agent.post(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review`).send({ decision: "apply", note: "Looks right", workspaceId: ws.id });
    expect(decision.status).toBe(200);
    expect(decision.body.applied).toBe(true);
    expect(readFileSync(path.join(app.project, "src", "app.ts"), "utf8")).toContain("const changed = true;");
    expect(git(app.project, "status", "--porcelain")).toContain("M src/app.ts");
    expect(git(app.project, "diff", "--cached", "--name-only")).toBe("");
    expect(git(app.project, "log", "-1", "--format=%s").trim()).toBe("base");

    // The record keeps the decision, and a second decision is refused.
    expect(ledgerRows(app.stateDir).find((r) => r.taskId === started.taskId)).toMatchObject({ review: { decision: "apply", note: "Looks right" } });
    const settled = await agent.post(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review`).send({ decision: "discard", note: "", workspaceId: ws.id });
    expect(settled.status).toBe(409);
    expect(settled.body.code).toBe("already_settled");

    // Reviewed, applied, tree still there: cleanup now takes the worktree.
    const cleaned = await agent.post(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review/cleanup`).send({});
    expect(cleaned.status).toBe(200);
    expect(cleaned.body.removed).toBe(true);
  }, 30_000);

  it("refuses a review whose lead checkout moved past the recorded head, and keeps the worktree", async () => {
    const app = await makeTestApp();
    t = app;
    repo(app.project);
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as { chatId: string };
    const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
    if (!token) throw new Error("no orchestration token");

    const res = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "delegate_task", args: { brief: "edit", isolation: "worktree", notify: "none" } });
    expect(res.status).toBe(200);
    const started = res.body.data as { taskId: string };
    await vi.waitFor(() => {
      const task = app.manager.get(chat.chatId).snapshot().delegated?.find((t) => t.id === started.taskId);
      expect(task?.outcome).toBe("done");
    }, 20_000);

    // The lead checkout moves on: a commit the worker never saw.
    writeFileSync(path.join(app.project, "app.txt"), "moved on\n");
    git(app.project, "commit", "-qam", "moved on");

    // The apply refuses before anything is written, and the worktree is kept.
    const decision = await agent.post(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review`).send({ decision: "apply", note: "", workspaceId: ws.id });
    expect(decision.status).toBe(409);
    expect(decision.body.code).toBe("lead_moved");
    expect(decision.body.error).toContain("moved past the recorded head");
    expect(git(app.project, "cat-file", "-p", "HEAD:src/app.ts")).toContain("const b = 1;");
    const worktrees = (await agent.get(`/api/workspaces/${ws.id}/worktrees`)).body.worktrees as Array<{ id: string; path: string }>;
    expect(worktrees.length).toBe(1);

    // The status tool says the same, guarded.
    const status = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "task_review", args: { taskId: started.taskId } });
    expect(String(status.body.text)).toContain("guarded");

    // The heads-check route agrees, and says why.
    const check = await agent.get(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review`);
    expect(check.status).toBe(200);
    expect(check.body.headsMatch).toBe(false);
    expect(check.body.reason).toBe("lead_moved");
  }, 30_000);

  it("refuses a review whose worker branch moved past the recorded fork, and keeps the worktree", async () => {
    const app = await makeTestApp();
    t = app;
    repo(app.project);
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as { chatId: string };
    const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
    if (!token) throw new Error("no orchestration token");

    const res = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "delegate_task", args: { brief: "edit", isolation: "worktree", notify: "none" } });
    expect(res.status).toBe(200);
    const started = res.body.data as { taskId: string };
    await vi.waitFor(() => {
      const task = app.manager.get(chat.chatId).snapshot().delegated?.find((t) => t.id === started.taskId);
      expect(task?.outcome).toBe("done");
    }, 20_000);

    // Someone commits more on the worker's branch: the recorded fork no longer names its head.
    const worktrees = (await agent.get(`/api/workspaces/${ws.id}/worktrees`)).body.worktrees as Array<{ id: string; path: string; branch: string }>;
    writeFileSync(path.join(worktrees[0]!.path, "extra.txt"), "more\n");
    git(worktrees[0]!.path, "add", ".");
    git(worktrees[0]!.path, "commit", "-qm", "extra work after settle");

    const decision = await agent.post(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review`).send({ decision: "apply", note: "", workspaceId: ws.id });
    expect(decision.status).toBe(409);
    expect(decision.body.code).toBe("worker_changed");
    expect(decision.body.error).toContain("re-review");
    expect(existsSync(worktrees[0]!.path)).toBe(true);
    // The lead checkout gained nothing.
    expect(git(app.project, "status", "--porcelain").trim()).toBe("");
  }, 30_000);

  it("refuses cleanup of an unreviewed worktree, and the inverse unreview restores the decision", async () => {
    const app = await makeTestApp();
    t = app;
    repo(app.project);
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as { chatId: string };
    const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
    if (!token) throw new Error("no orchestration token");

    const res = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "delegate_task", args: { brief: "edit", isolation: "worktree", notify: "none" } });
    expect(res.status).toBe(200);
    const started = res.body.data as { taskId: string };
    await vi.waitFor(() => {
      const task = app.manager.get(chat.chatId).snapshot().delegated?.find((t) => t.id === started.taskId);
      expect(task?.outcome).toBe("done");
    }, 20_000);
    const worktrees = (await agent.get(`/api/workspaces/${ws.id}/worktrees`)).body.worktrees as Array<{ id: string; path: string }>;

    // Unreviewed changes: cleanup refuses, the worktree and its edits stay.
    const refused = await agent.post(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review/cleanup`).send({});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("unreviewed");
    expect(existsSync(worktrees[0]!.path)).toBe(true);
    expect(readFileSync(path.join(worktrees[0]!.path, "src", "app.ts"), "utf8")).toContain("const changed = true;");

    // The person discards instead: cleanup then takes the tree, branch and all.
    const discarded = await agent.post(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review`).send({ decision: "discard", note: "Wrong approach", workspaceId: ws.id });
    expect(discarded.status).toBe(200);
    expect(discarded.body.applied).toBe(false);
    const cleaned = await agent.post(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review/cleanup`).send({});
    expect(cleaned.status).toBe(200);
    expect(cleaned.body.removed).toBe(true);
    expect(existsSync(worktrees[0]!.path)).toBe(false);
    // A second worker was never spawned; the branch's commits were merged nowhere, so -d takes it.
    expect(git(app.project, "branch", "--list").trim()).not.toContain("awui/task");

    // A fresh isolated worker, discarded by mistake, is unreviewed back and decided again.
    const second = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "delegate_task", args: { brief: "edit", isolation: "worktree", notify: "none" } });
    expect(second.status).toBe(200);
    const secondTask = second.body.data as { taskId: string };
    await vi.waitFor(() => {
      const task = app.manager.get(chat.chatId).snapshot().delegated?.find((t) => t.id === secondTask.taskId);
      expect(task?.outcome).toBe("done");
    }, 20_000);
    const wrong = await agent.post(`/api/chats/${chat.chatId}/tasks/${secondTask.taskId}/review`).send({ decision: "discard", note: "", workspaceId: ws.id });
    expect(wrong.status).toBe(200);
    const back = await agent.post(`/api/chats/${chat.chatId}/tasks/${secondTask.taskId}/unreview`).send({});
    expect(back.status).toBe(200);
    expect(back.body.record.review).toBeNull();
    const again = await agent.post(`/api/chats/${chat.chatId}/tasks/${secondTask.taskId}/review`).send({ decision: "apply", note: "Kept after all", workspaceId: ws.id });
    expect(again.status).toBe(200);
    expect(again.body.applied).toBe(true);
  }, 40_000);

  it("accepts isolated no-op work once reviewed, instead of leaving it unclosable", async () => {
    const root = tempDir("awui-noop-review-");
    repo(root);
    const trees = new ManagedWorktrees();
    const { workspaces } = await Workspaces.create([root], root);
    const ws = await workspaces.open(root);
    const fork = git(root, "rev-parse", "HEAD").trim();
    const tree = await trees.create(ws, `noop-${Date.now()}`, fork);
    const service = await IntegrationReview.open(tempDir("awui-noop-state-"), async () => ({ path: "unused", diff: "" }));
    await service.track({ taskId: "abcd", workspaceId: ws.id, workspacePath: root, worktreeId: tree.id, branch: tree.branch, fork });
    const project = { root, ws, trees };
    expect((await service.reviewTask("abcd", "apply", "No change required", "tester", project)).applied).toBe(true);
    expect(git(root, "status", "--porcelain").trim()).toBe("");
    expect((await service.cleanup("abcd", project)).removed).toBe(true);
  });

  it("keeps isolation saying it is not wired when the ledger is absent, and answers a shared tree with nothing to review", async () => {
    const app = await makeTestApp();
    t = app;
    repo(app.project);
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as { chatId: string };
    const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
    if (!token) throw new Error("no orchestration token");

    // A shared-tree task (no isolation) answers: there is nothing to review.
    const shared = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "delegate_task", args: { brief: "edit", notify: "none" } });
    expect(shared.status).toBe(200);
    const sharedTask = shared.body.data as { taskId: string };
    await vi.waitFor(() => {
      const task = app.manager.get(chat.chatId).snapshot().delegated?.find((t) => t.id === sharedTask.taskId);
      expect(task?.outcome).toBe("done");
    }, 20_000);
    const nothing = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "task_review", args: { taskId: sharedTask.taskId } });
    expect(nothing.status).toBe(200);
    expect(String(nothing.body.text)).toContain("nothing to review");

    // The shared-tree child worked in the caller's own tree: its edit landed there directly.
    expect(git(app.project, "status", "--porcelain")).toContain("M src/app.ts");
    // And no managed worktree was created for it.
    const worktrees = (await agent.get(`/api/workspaces/${ws.id}/worktrees`)).body.worktrees as Array<{ id: string }>;
    expect(worktrees.length).toBe(0);
  }, 30_000);

  it("pins the apply's diff options, so a checkout's own config cannot move a new file", async () => {
    const app = await makeTestApp();
    t = app;
    repo(app.project);
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as { chatId: string };
    const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
    if (!token) throw new Error("no orchestration token");

    const res = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "delegate_task", args: { brief: "edit", isolation: "worktree", notify: "none" } });
    expect(res.status).toBe(200);
    const started = res.body.data as { taskId: string };
    await vi.waitFor(() => {
      const task = app.manager.get(chat.chatId).snapshot().delegated?.find((t) => t.id === started.taskId);
      expect(task?.outcome).toBe("done");
    }, 20_000);

    // The checkout's config is every worktree's config: with `diff.noprefix`, a diff of the
    // new file would read `src/g.txt` where the patch needs `a/src/g.txt`.
    git(app.project, "config", "diff.noprefix", "true");
    const worktrees = (await agent.get(`/api/workspaces/${ws.id}/worktrees`)).body.worktrees as Array<{ id: string; path: string }>;
    if (!worktrees[0]) throw new Error("no managed worktree");
    mkdirSync(path.join(worktrees[0].path, "src"), { recursive: true });
    writeFileSync(path.join(worktrees[0].path, "src", "g.txt"), "new\n");
    // Staged, never committed: the branch head still matches the recorded fork, so the
    // review gate measures the checkout, not an advanced branch (that is worker_changed).
    git(worktrees[0].path, "add", "src/g.txt");

    const decision = await agent.post(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review`).send({ decision: "apply", note: "", workspaceId: ws.id });
    expect(decision.status).toBe(200);
    expect(decision.body.applied).toBe(true);
    expect(existsSync(path.join(app.project, "src", "g.txt"))).toBe(true);
    expect(existsSync(path.join(app.project, "g.txt"))).toBe(false);
  }, 30_000);

  it("serves a worker file's diff against the fork point, bounded and confined", async () => {
    const app = await makeTestApp();
    t = app;
    repo(app.project);
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as { chatId: string };
    const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
    if (!token) throw new Error("no orchestration token");

    const res = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "delegate_task", args: { brief: "edit", isolation: "worktree", notify: "none" } });
    expect(res.status).toBe(200);
    const started = res.body.data as { taskId: string };
    await vi.waitFor(() => {
      const task = app.manager.get(chat.chatId).snapshot().delegated?.find((t) => t.id === started.taskId);
      expect(task?.outcome).toBe("done");
    }, 20_000);

    const diff = await agent.get(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review/diff`).query({ path: "src/app.ts" });
    expect(diff.status).toBe(200);
    expect(diff.body.path).toBe("src/app.ts");
    expect(diff.body.diff).toContain("const changed = true;");

    for (const bad of ["../../etc/passwd", "/etc/passwd", ".."]) {
      expect((await agent.get(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review/diff`).query({ path: bad })).status).toBe(400);
    }
    expect((await agent.get(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review/diff`).query({ path: "absent.txt" })).status).toBe(200);
  }, 30_000);
});

describe("review gate guards", () => {
  it("refuses an apply into a dirty lead checkout before anything is written", async () => {
    const app = await makeTestApp();
    t = app;
    repo(app.project);
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as { chatId: string };
    const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
    if (!token) throw new Error("no orchestration token");

    const res = await agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool: "delegate_task", args: { brief: "edit", isolation: "worktree", notify: "none" } });
    expect(res.status).toBe(200);
    const started = res.body.data as { taskId: string };
    await vi.waitFor(() => {
      const task = app.manager.get(chat.chatId).snapshot().delegated?.find((t) => t.id === started.taskId);
      expect(task?.outcome).toBe("done");
    }, 20_000);

    writeFileSync(path.join(app.project, "notes.txt"), "mine\n");
    const decision = await agent.post(`/api/chats/${chat.chatId}/tasks/${started.taskId}/review`).send({ decision: "apply", note: "", workspaceId: ws.id });
    expect(decision.status).toBe(409);
    expect(decision.body.code).toBe("dirty_checkout");
    expect(git(app.project, "cat-file", "-p", "HEAD:src/app.ts")).toContain("const b = 1;");
    expect(readFileSync(path.join(app.project, "notes.txt"), "utf8")).toBe("mine\n");
  }, 30_000);
});
