// Races: the record of one prompt in several worktree chats, and the two things
// the server may do with a member afterwards (apply the winner's changes, remove a
// loser git agrees to drop). The store's bounds are exercised in memory; the routes
// against a real temp git repo and the fake adapters, so every tree is a real one.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ChatStatus, RaceCleanupResult, RaceSummary, RaceWinnerResult } from "../../src/shared/protocol.js";
import { MAX_RACES, Races, type RaceChats, type RaceRecordMember } from "../../src/server/races.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

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

const apps: TestApp[] = [];
afterAll(async () => {
  for (const app of apps.splice(0)) await app.close();
});

interface Race {
  app: TestApp;
  agent: Awaited<ReturnType<typeof signedIn>>;
  raceId: string;
  wsId: string;
  members: Array<{ chatId: string; tree: string; branch: string }>;
}

/** Compare two fake agents over one prompt, and read back the members the server just started. */
async function startRace(prompt: string): Promise<Race> {
  const app = await makeTestApp();
  apps.push(app);
  repo(app.project);
  const agent = await signedIn(app);
  const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
  const res = await agent.post("/api/compare").send({ workspaceId: ws.id, name: "try", base: "HEAD", prompt, choices: [{ harnessId: "fake" }, { harnessId: "fake-b" }] });
  expect(res.status).toBe(201);
  const started = res.body.results as Array<{ snapshot: { chatId: string } | null; tree: { path: string; branch: string } | null }>;
  return {
    app,
    agent,
    raceId: String(res.body.raceId),
    wsId: ws.id,
    members: started.map((result) => ({ chatId: String(result.snapshot?.chatId), tree: String(result.tree?.path), branch: String(result.tree?.branch) })),
  };
}

/** Wait until every started chat settles (the fake's run ends). */
async function settled(race: Race): Promise<void> {
  await vi.waitFor(() => {
    for (const member of race.members) expect(race.app.manager.peek(member.chatId)?.status).toBe("idle");
  }, 20_000);
}

const detail = async (race: Race): Promise<RaceSummary> => (await race.agent.get(`/api/races/${race.raceId}`)).body as RaceSummary;

/** The two members a comparison starts, with the tree paths their routes read. */
function two(race: Race): [{ chatId: string; tree: string; branch: string }, { chatId: string; tree: string; branch: string }] {
  const [first, second] = race.members;
  if (!first || !second) throw new Error("expected two members");
  return [first, second];
}

/** Members as the store keeps them, for the store's own tests. */
function member(index: number): RaceRecordMember {
  const root = path.join(tmpdir(), `awui-race-${index}`);
  return { chatId: `chat-${index}`, worktreeId: `tree-${index}`, worktree: `try-${index}`, path: path.join(root, ".awui", "worktrees", `try-${index}`), branch: `awui/try-${index}`, harnessId: "fake", startedAt: 1, fork: "abcdef01" };
}

const start = (index: number) => ({ workspaceId: "w", workspacePath: path.join(tmpdir(), `awui-race-${index}`), workspaceName: "proj", prompt: "do it", base: "HEAD", members: [member(index)] });

function stubChats(status: () => ChatStatus | null = () => null): RaceChats {
  return { status: () => status(), answer: () => null, close: async () => undefined };
}

describe("race records", () => {
  it("keeps the newest fifty and prunes the oldest settled one, never a race that is running", async () => {
    const running = new Set<string>(["chat-0"]);
    const chats: RaceChats = { status: (id) => (running.has(id) ? "running" : null), answer: () => null, close: async () => undefined };
    const races = Races.inMemory(chats);
    for (let i = 0; i < MAX_RACES; i += 1) await races.create(start(i));
    expect(races.list()).toHaveLength(MAX_RACES);
    // The oldest race's chat is working, so its record is the one to keep: the next one oldest goes.
    await races.create(start(MAX_RACES));
    expect(races.list()).toHaveLength(MAX_RACES);
    expect(races.list().some((race) => race.members[0]?.chatId === "chat-0")).toBe(true);
    expect(races.list().some((race) => race.members[0]?.chatId === "chat-1")).toBe(false);
    expect(races.list()[0]?.members[0]?.chatId).toBe(`chat-${MAX_RACES}`);
  });

  it("writes the record to the state folder and reads back only rows it can trust", async () => {
    const dir = path.join(tmpdir(), `awui-race-state-${Math.random().toString(36).slice(2, 8)}`);
    const races = await Races.open(dir, stubChats());
    const record = await races.create(start(0));
    const reopened = await Races.open(dir, stubChats());
    expect(reopened.get(record.id)?.members[0]?.chatId).toBe("chat-0");
    // A hand-edited file loses the rows that do not validate, and nothing else.
    writeFileSync(path.join(dir, "races.json"), JSON.stringify([{ ...record, members: [{ ...member(0), path: "/etc/passwd" }] }, { id: "junk" }]));
    expect((await Races.open(dir, stubChats())).list()).toHaveLength(0);
  });
});

describe("race routes", () => {
  it("records the group the comparison started and answers each member's changes", async () => {
    const race = await startRace("edit");
    expect(race.raceId).toMatch(/[0-9a-f-]{36}/);
    const [member] = two(race);
    expect(member.tree.startsWith(path.join(race.app.project, ".awui", "worktrees"))).toBe(true);

    // The list stays cheap: statuses, no git per row.
    const list = (await race.agent.get("/api/races")).body as { races: RaceSummary[] };
    expect(list.races).toHaveLength(1);
    expect(list.races[0]?.members[0]?.added).toBeUndefined();

    await settled(race);
    const one = await detail(race);
    expect(one.workspaceId).toBe(race.wsId);
    expect(one.prompt).toBe("edit");
    expect(one.members).toHaveLength(2);
    for (const view of one.members) {
      expect(view.status).toBe("settled");
      expect(view.winner).toBe(false);
      expect(view.added).toBe(1);
      expect(view.removed).toBe(1);
      expect(view.dirty).toBe(true);
      expect(view.unmerged).toBe(0);
      expect(view.files?.[0]?.path).toBe("src/app.ts");
      expect(view.answer).toContain("Echo: edit");
    }

    // One file's diff, bounded like a tool's, and its path confined to that member's tree.
    const diff = await race.agent.get(`/api/races/${race.raceId}/members/${member.chatId}/diff`).query({ path: "src/app.ts" });
    expect(diff.status).toBe(200);
    expect(diff.body.path).toBe("src/app.ts");
    expect(diff.body.diff.added).toBe(1);
    expect(diff.body.diff.removed).toBe(1);
    expect(diff.body.diff.lines.some((line: { kind: string; text: string }) => line.kind === "add" && line.text.includes("const changed = true;"))).toBe(true);

    for (const bad of ["../../etc/passwd", "/etc/passwd", "src/./app.ts", ".."]) {
      expect((await race.agent.get(`/api/races/${race.raceId}/members/${member.chatId}/diff`).query({ path: bad })).status).toBe(400);
    }
    // A symlink that leaves the worktree is refused even though its name is inside.
    symlinkSync(path.join(race.app.project, "app.txt"), path.join(member.tree, "leak"));
    expect((await race.agent.get(`/api/races/${race.raceId}/members/${member.chatId}/diff`).query({ path: "leak" })).status).toBe(400);
    expect((await race.agent.get(`/api/races/nope`)).status).toBe(404);
  }, 30_000);

  it("keeps a winner without touching the project, and applies one only into a clean checkout at the fork point", async () => {
    const race = await startRace("edit");
    await settled(race);
    const [winner, other] = two(race);

    // keep: the record says who won, and nothing in the project changed.
    const kept = (await race.agent.post(`/api/races/${race.raceId}/winner`).send({ chatId: winner.chatId })).body as RaceWinnerResult;
    expect(kept.mode).toBe("keep");
    expect(kept.applied).toBe(false);
    expect(kept.race.winnerChatId).toBe(winner.chatId);
    expect(kept.instructions).toContain("merge");
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: race.app.project, encoding: "utf8" })).not.toContain("app.txt");

    // Committed work on the winner's branch is what apply carries.
    writeFileSync(path.join(winner.tree, "app.txt"), "picked\n");
    writeFileSync(path.join(other.tree, "app.txt"), "other\n");
    git(winner.tree, "commit", "-qam", "picked");
    git(other.tree, "commit", "-qam", "other");

    // A dirty checkout refuses before anything is written.
    writeFileSync(path.join(race.app.project, "notes.txt"), "mine\n");
    const dirty = await race.agent.post(`/api/races/${race.raceId}/winner`).send({ chatId: winner.chatId, mode: "apply" });
    expect(dirty.status).toBe(409);
    expect(dirty.body.code).toBe("dirty_checkout");
    expect(execFileSync("git", ["cat-file", "-p", "HEAD:app.txt"], { cwd: race.app.project, encoding: "utf8" })).toBe("base\n");
    expect(execFileSync("git", ["show", ":app.txt"], { cwd: race.app.project, encoding: "utf8" })).toBe("base\n");

    execFileSync("rm", ["-f", path.join(race.app.project, "notes.txt")]);
    const applied = (await race.agent.post(`/api/races/${race.raceId}/winner`).send({ chatId: winner.chatId, mode: "apply" })).body as RaceWinnerResult;
    expect(applied.applied).toBe(true);
    expect(applied.race.winnerChatId).toBe(winner.chatId);
    expect(execFileSync("git", ["log", "-1", "--format=%s"], { cwd: race.app.project, encoding: "utf8" }).trim()).toBe("base");
    // Written to the working tree only, never staged.
    expect(execFileSync("git", ["status", "--porcelain"], { cwd: race.app.project, encoding: "utf8" })).toContain("M app.txt");
    expect(execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: race.app.project, encoding: "utf8" })).toBe("");
    expect(execFileSync("git", ["show", ":app.txt"], { cwd: race.app.project, encoding: "utf8" })).toBe("base\n");
  }, 30_000);

  it("refuses an apply whose checkout has moved past the fork point", async () => {
    const race = await startRace("edit");
    await settled(race);
    const [winner] = two(race);
    writeFileSync(path.join(winner.tree, "app.txt"), "picked\n");
    git(winner.tree, "commit", "-qam", "picked");
    writeFileSync(path.join(race.app.project, "app.txt"), "moved on\n");
    git(race.app.project, "commit", "-qam", "moved on");
    const res = await race.agent.post(`/api/races/${race.raceId}/winner`).send({ chatId: winner.chatId, mode: "apply" });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("head_moved");
    expect(execFileSync("git", ["show", ":app.txt"], { cwd: race.app.project, encoding: "utf8" })).toBe("moved on\n");
  }, 30_000);

  it("removes a clean loser, keeps the dirty and unmerged ones, and keeps a branch git refuses", async () => {
    const race = await startRace("edit");
    await settled(race);
    const [first, second] = two(race);
    const cleanup = async (discard: string[] = []) =>
      (await race.agent.post(`/api/races/${race.raceId}/cleanup`).send({ discard })).body as RaceCleanupResult;
    const reasonFor = (result: RaceCleanupResult, chatId: string) => result.results.find((row) => row.chatId === chatId);

    // Both have uncommitted work from the run: nothing is removed.
    const dirty = await cleanup();
    expect(reasonFor(dirty, first.chatId)?.reason).toBe("uncommitted");
    expect(reasonFor(dirty, second.chatId)?.reason).toBe("uncommitted");
    expect(existsSync(first.tree)).toBe(true);

    // A clean tree with no commits of its own is removed, branch and all.
    git(first.tree, "checkout", "-q", "--", ".");
    const clean = await cleanup();
    expect(reasonFor(clean, first.chatId)).toEqual({ chatId: first.chatId, removed: true, branchRemoved: true, reason: null });
    expect(existsSync(first.tree)).toBe(false);
    expect(git(race.app.project, "branch", "--list", first.branch).trim()).toBe("");
    expect(clean.race.members.some((view) => view.chatId === first.chatId)).toBe(false);
    // Its chat is closed through the manager, not by touching a session file.
    expect((await race.agent.get(`/api/chats/${first.chatId}`)).status).toBe(404);

    // A commit the project's branch does not have: kept, unless the request discards it.
    git(second.tree, "commit", "-qam", "second's work");
    const unmerged = await cleanup();
    expect(reasonFor(unmerged, second.chatId)?.reason).toBe("unmerged");
    expect(existsSync(second.tree)).toBe(true);
    const discarded = await cleanup([second.chatId]);
    expect(reasonFor(discarded, second.chatId)).toEqual({ chatId: second.chatId, removed: true, branchRemoved: true, reason: null });
    expect(git(race.app.project, "branch", "--list", second.branch).trim()).toBe("");
  }, 30_000);

  it("leaves a member that is still running alone", async () => {
    // The fake's quiz asks a question and waits for it: the run is unsettled (and asking)
    // until this chat is disposed, so "still running" does not depend on timing.
    const race = await startRace("quiz");
    const [member] = two(race);
    await vi.waitFor(() => expect(race.app.manager.peek(member.chatId)?.status).toBe("running"), 10_000);
    const res = (await race.agent.post(`/api/races/${race.raceId}/cleanup`).send({})).body as RaceCleanupResult;
    expect(res.results.find((row) => row.chatId === member.chatId)?.reason).toBe("running");
    expect(existsSync(member.tree)).toBe(true);
  }, 30_000);

  it("answers 404 for an unknown race and 400 for a member that is not in it", async () => {
    const race = await startRace("edit");
    expect((await race.agent.get("/api/races")).status).toBe(200);
    expect((await race.agent.post("/api/races/missing/winner").send({ chatId: "x" })).status).toBe(404);
    expect((await race.agent.post(`/api/races/${race.raceId}/winner`).send({ chatId: "someone-else" })).status).toBe(404);
    expect((await race.agent.post(`/api/races/${race.raceId}/winner`).send({ chatId: two(race)[0].chatId, mode: "merge" })).status).toBe(400);
    expect((await race.agent.get(`/api/races/${race.raceId}/members/not-a-member/diff`).query({ path: "app.txt" })).status).toBe(404);
  }, 30_000);
});
