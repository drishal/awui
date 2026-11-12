// Races: the record of one prompt in several worktree chats, and the two things
// the server may do with a member afterwards (apply the winner's changes, remove a
// loser git agrees to drop). The store's bounds are exercised in memory; the routes
// against a real temp git repo and the fake adapters, so every tree is a real one.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ChatStatus, RaceSummary } from "../../src/shared/protocol.js";
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

    expect((await race.agent.get(`/api/races/nope`)).status).toBe(404);
  }, 30_000);

  it("answers 404 for a comparison it does not have", async () => {
    const race = await startRace("edit");
    expect((await race.agent.get("/api/races")).status).toBe(200);
    expect((await race.agent.get("/api/races/missing")).status).toBe(404);
    expect(((await race.agent.get(`/api/races/${race.raceId}`)).body as RaceSummary).id).toBe(race.raceId);
  }, 30_000);
});
