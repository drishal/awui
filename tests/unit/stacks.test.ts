// Stacked PRs and stack-aware merge (stacks.ts), and the checkout-pr / archive
// flow (worktrees.ts) against a real tmp git repo and a controlled gh stand-in on
// PATH: a stack is created above #N, merged bottom-up with its base branches
// following GitHub's, and a checkout-pr tree is archived only when its PR merged,
// the tree is clean, and HEAD still sits on the recorded branch.
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PrStack } from "../../src/shared/protocol.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

const dirs: string[] = [];
let root: string;
let remote: string;
let gh: string;
const originalPath = process.env.PATH;
/** The PRs the stand-in knows, keyed by number: state, branches, and the head commit it names. */
let prs: Record<number, { state: string; base: string; head: string; oid: string }>;
/** The merges the stand-in was asked for, in order. */
let merges: number[];
/** Whether the stand-in deletes a merged PR's head branch, as a repository with auto-delete on does. */
let autoDeleteBranches: boolean;
function ghScript(): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const prs = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, "gh-prs.json"))}, "utf8"));
const settings = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, "gh-settings.json"))}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(path.join(root, "gh-prs.json"))}, JSON.stringify(prs));
const record = (name, value) => { const all = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(root, "gh-log.json"))}, "utf8")); all.push(value); fs.writeFileSync(${JSON.stringify(path.join(root, "gh-log.json"))}, JSON.stringify(all)); };
const headCommit = () => { try { return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(); } catch { return "0".repeat(40); } };
if (args[0] === "auth") process.exit(0);
if (args[0] === "pr" && args[1] === "view") {
  const n = Number(args[2] && /^\\d+$/.test(args[2]) ? args[2] : 0);
  const pr = prs[n];
  if (!pr) process.exit(1);
  console.log(JSON.stringify({ url: "https://github.com/example/repo/pull/" + n, title: "PR " + n, state: pr.state, isDraft: false, baseRefName: pr.base, headRefName: pr.head, headRefOid: pr.oid }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "create") {
  const base = args[args.indexOf("--base") + 1];
  const head = args[args.indexOf("--head") + 1];
  const n = 100 + Object.keys(prs).length;
  prs[n] = { state: "OPEN", base, head, oid: headCommit() };
  save();
  record("create", args);
  console.log("https://github.com/example/repo/pull/" + n);
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "merge") {
  const n = Number(args[2]);
  const pr = prs[n];
  if (!pr) process.exit(1);
  record("merge-args", args);
  // A PR's branch may move after the panel read its head: headMovedTo is the commit the
  // branch stands at when the merge lands, so a merge naming the old head is refused.
  const at = args.indexOf("--match-head-commit");
  if (at !== -1 && args[at + 1] !== (pr.headMovedTo || pr.oid)) { console.error("Head branch was modified. Review and try the merge again."); process.exit(1); }
  if (pr.state === "CLEAN" || pr.state === "OPEN") {
    pr.state = "MERGED";
    // GitHub retargets a stacked PR when the branch below goes: with auto-delete on, the
    // upper layers now target this PR's base; with it off, nothing is retargeted.
    if (settings.autoDeleteBranches) for (const key of Object.keys(prs)) if (prs[key].base === pr.head) prs[key].base = pr.base;
    save();
    record("merge", n);
    process.exit(0);
  }
  if (pr.state === "BLOCKED") { console.error("Pull request " + n + " is not mergeable: required checks are failing"); process.exit(1); }
  process.exit(1);
}
if (args[0] === "pr" && args[1] === "checks") {
  const n = Number(args[2] && /^\\d+$/.test(args[2]) ? args[2] : 0);
  const pr = prs[n];
  if (!pr) process.exit(8);
  console.log(JSON.stringify([{ name: "tests", state: pr.state === "BLOCKED" ? "failure" : "pass", link: "https://github.com/example/repo/actions/" + n }]));
  process.exit(0);
}
process.exit(2);
`;
}

afterEach(() => {
  process.env.PATH = originalPath;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * One test server with the repo inside its own workspace root (the routes confine
 * every project to the app's roots), a controlled gh stand-in on PATH, and the
 * workspace opened. Layer 1 targets main, layer 2 layer-1, layer 3 layer-2.
 */
async function app(): Promise<{ t: TestApp; agent: Awaited<ReturnType<typeof signedIn>>; wsId: string }> {
  const t = await makeTestApp();
  dirs.push(t.root);
  root = path.join(t.root, "repo");
  remote = path.join(t.root, "remote");
  mkdirSync(remote, { recursive: true });
  mkdirSync(root, { recursive: true });
  git(remote, "init", "--bare", "-q");
  git(root, "init", "-q", "-b", "main");
  git(root, "remote", "add", "origin", remote);
  writeFileSync(path.join(root, "a.txt"), "base\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "base");
  git(root, "checkout", "-qb", "layer-1");
  writeFileSync(path.join(root, "a.txt"), "one\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "layer 1");
  git(root, "checkout", "-qb", "layer-2");
  writeFileSync(path.join(root, "a.txt"), "two\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "layer 2");
  git(root, "checkout", "-qb", "layer-3");
  writeFileSync(path.join(root, "a.txt"), "three\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "layer 3");
  // The PR head branches live on the remote, as a real pull request's do.
  git(root, "push", "-q", "origin", "main", "layer-1", "layer-2", "layer-3");
  // Each PR names the commit its branch is at, as gh's headRefOid does: #42's head branch
  // is layer-1's tip, and a merge must name exactly that.
  const tip = (ref: string) => git(remote, "rev-parse", ref).trim();
  prs = {
    41: { state: "MERGED", base: "main", head: "layer-0", oid: tip("main") },
    42: { state: "OPEN", base: "main", head: "layer-1", oid: tip("layer-1") },
    43: { state: "OPEN", base: "layer-1", head: "layer-2", oid: tip("layer-2") },
    44: { state: "OPEN", base: "layer-2", head: "layer-3", oid: tip("layer-3") },
  };
  // GitHub serves every PR's head as `refs/pull/<n>/head`, which is what a checkout fetches:
  // a fork's branch (`main`, say) is not this repository's branch of the same name.
  for (const pr of [42, 43, 44]) git(remote, "update-ref", `refs/pull/${pr}/head`, prs[pr]!.oid);
  merges = [];
  autoDeleteBranches = true;
  writeFileSync(path.join(root, "gh-prs.json"), JSON.stringify(prs));
  writeFileSync(path.join(root, "gh-log.json"), JSON.stringify(merges));
  writeFileSync(path.join(root, "gh-settings.json"), JSON.stringify({ autoDeleteBranches }));
  gh = path.join(root, "gh");
  writeFileSync(gh, ghScript());
  chmodSync(gh, 0o755);
  process.env.PATH = `${root}:${process.env.PATH ?? ""}`;
  const agent = await signedIn(t);
  const ws = (await agent.post("/api/workspaces/open").send({ path: root })).body as { id: string };
  expect(ws.id).toBeTruthy();
  return { t, agent, wsId: ws.id };
}

const stackOf = async (agent: Awaited<ReturnType<typeof signedIn>>, wsId: string): Promise<PrStack | null> =>
  ((await agent.get(`/api/workspaces/${wsId}/pr-stack`).expect(200)).body as { stacks: PrStack[] }).stacks[0] ?? null;

describe("stacked pull requests", () => {
  it("stacks a new PR above #N, persists the ordered stack, and shows per-layer status", async () => {
    const { agent, wsId } = await app();
    git(root, "checkout", "-q", "layer-1");
    const created = await agent.post(`/api/workspaces/${wsId}/pr-stack`).send({ base: "main", title: "Layer one", body: "first layer" }).expect(201);
    let stack = (created.body as { stack: PrStack }).stack;
    expect(stack.layers).toHaveLength(1);
    expect(stack.layers[0]?.state).toBe("OPEN");
    expect(stack.layers[0]?.baseBranch).toBe("main");

    // Stack layer-2 above the first PR the stand-in minted.
    const first = stack.layers[0]?.pr ?? 0;
    git(root, "checkout", "-q", "layer-2");
    const second = await agent.post(`/api/workspaces/${wsId}/pr-stack`).send({ above: first, title: "Layer two" }).expect(201);
    stack = (second.body as { stack: PrStack }).stack;
    expect(stack.layers.map((l) => l.pr)).toEqual([second.body.layer.pr, first]);
    expect(stack.layers[0]?.baseBranch).toBe("layer-1");
    expect(stack.layers[0]?.state).toBe("OPEN");

    // The stack survives a store reopen (makeTestApp keeps state in memory; the list route re-reads it).
    const listed = await stackOf(agent, wsId);
    expect(listed?.layers.map((l) => l.pr)).toEqual(stack.layers.map((l) => l.pr));
  });

  it("merges bottom-up and follows GitHub's retargeted base branches", async () => {
    const { agent, wsId } = await app();
    git(root, "checkout", "-q", "layer-1");
    await agent.post(`/api/workspaces/${wsId}/pr-stack`).send({ base: "main", title: "Layer one" }).expect(201);
    const stack = await stackOf(agent, wsId);
    expect(stack).toBeTruthy();
    const first = stack!.layers[0]!.pr;

    // Add two more layers on top of the first, each stacked above the one below.
    git(root, "checkout", "-q", "layer-2");
    await agent.post(`/api/workspaces/${wsId}/pr-stack`).send({ above: first, title: "Layer two" }).expect(201);
    git(root, "checkout", "-q", "layer-3");
    await agent.post(`/api/workspaces/${wsId}/pr-stack`).send({ above: (await stackOf(agent, wsId))!.layers[0]!.pr, title: "Layer three" }).expect(201);
    const before = await stackOf(agent, wsId);
    expect(before!.layers).toHaveLength(3);

    // The stand-in refuses BLOCKED PRs: mark the top one blocked, so the merge
    // merges the bottom two then stops. The stand-in minted 105/106 into the file,
    // so re-read it: the test's own object never saw those creates.
    const onDisk = JSON.parse(readFileSync(path.join(root, "gh-prs.json"), "utf8")) as Record<string, { state: string; base: string; head: string; oid: string }>;
    const top = before!.layers[0]!.pr;
    onDisk[String(top)] = { ...onDisk[String(top)]!, state: "BLOCKED" };
    writeFileSync(path.join(root, "gh-prs.json"), JSON.stringify(onDisk));
    const merged = await agent.post(`/api/workspaces/${wsId}/pr-stack/${before!.id}/merge`).send({}).expect(200);
    const result = merged.body as { stack: PrStack; mergedThrough: number | null; refusal: { pr: number; message: string } | null };
    // Bottom-up: the oldest open layer merged first, then the next; the blocked
    // top stopped the merge. The stand-in numbers created PRs from 100: the first
    // layer is 100, the second 101, the third 102 — the merge merged through 101.
    expect(result.mergedThrough).toBe(before!.layers[1]!.pr);
    expect(result.stack.layers.find((l) => l.pr === first)?.state).toBe("MERGED");
    // The stand-in leaves a refused PR's state as it is: the top layer keeps BLOCKED.
    expect(result.stack.layers.find((l) => l.pr === top)?.state).toBe("BLOCKED");
    // The merge record is persisted: a fresh list shows the same states.
    const after = await stackOf(agent, wsId);
    expect(after!.layers.find((l) => l.pr === first)?.state).toBe("MERGED");
    // The stand-in was asked for exactly the two merges, oldest first (the log
    // carries the creates' argv arrays too; the merges are bare numbers).
    const logged = JSON.parse(readFileSync(path.join(root, "gh-log.json"), "utf8")) as Array<number | string[]>;
    expect(logged.filter((entry): entry is number => typeof entry === "number")).toEqual([first, before!.layers[1]!.pr]);
    // Every layer was attempted, oldest first, and each attempt named the head commit GitHub
    // had just reported: gh merges that commit or refuses, and the stand-in refuses a mismatch.
    const mergeCalls = logged.filter((entry): entry is string[] => Array.isArray(entry) && entry[0] === "pr" && entry[1] === "merge");
    expect(mergeCalls.map((call) => call[2])).toEqual([String(first), String(before!.layers[1]!.pr), String(top)]);
    for (const call of mergeCalls) {
      const at = call.indexOf("--match-head-commit");
      expect(at).toBeGreaterThan(-1);
      expect(call[at + 1]).toBe(onDisk[String(Number(call[2]))]!.oid);
    }
  });

  it("refuses a merge refusal's actionable error and persists the layers that did merge", async () => {
    const { agent, wsId } = await app();
    await agent.post(`/api/workspaces/${wsId}/pr-stack`).send({ base: "main", title: "One layer" }).expect(201);
    const stack = await stackOf(agent, wsId);
    const pr = stack!.layers[0]!.pr;
    // The stand-in minted this number into its own file, so mark the row that is on disk:
    // the view must still read it as a real PR, with its bases and head.
    const onDisk = JSON.parse(readFileSync(path.join(root, "gh-prs.json"), "utf8")) as Record<string, { state: string }>;
    const row = onDisk[String(pr)];
    if (!row) throw new Error(`the stand-in minted no PR ${pr}`);
    row.state = "BLOCKED";
    writeFileSync(path.join(root, "gh-prs.json"), JSON.stringify(onDisk));
    const merged = await agent.post(`/api/workspaces/${wsId}/pr-stack/${stack!.id}/merge`).send({}).expect(200);
    const result = merged.body as { refusal: { pr: number; message: string } | null; mergedThrough: number | null };
    expect(result.refusal?.pr).toBe(pr);
    expect(result.refusal?.message).toContain("not mergeable");
    expect(result.mergedThrough).toBeNull();
  });

  it("refuses a layer that still targets the layer below it, merging nothing into it", async () => {
    const { agent, wsId } = await app();
    // Branch auto-delete off, as a repository may be: GitHub then leaves the upper PR
    // targeting the layer below, and `gh pr merge` would put this layer's work into that
    // branch instead of the stack's base while the panel reported the stack merged.
    autoDeleteBranches = false;
    writeFileSync(path.join(root, "gh-settings.json"), JSON.stringify({ autoDeleteBranches }));
    git(root, "checkout", "-q", "layer-1");
    await agent.post(`/api/workspaces/${wsId}/pr-stack`).send({ base: "main", title: "Layer one" }).expect(201);
    const first = (await stackOf(agent, wsId))!.layers[0]!.pr;
    git(root, "checkout", "-q", "layer-2");
    await agent.post(`/api/workspaces/${wsId}/pr-stack`).send({ above: first, title: "Layer two" }).expect(201);
    const before = await stackOf(agent, wsId);
    const top = before!.layers[0]!.pr;

    const merged = await agent.post(`/api/workspaces/${wsId}/pr-stack/${before!.id}/merge`).send({}).expect(200);
    const result = merged.body as { stack: PrStack; mergedThrough: number | null; refusal: { pr: number; message: string } | null };
    // The bottom layer merged; the next still targets `layer-1`, so it refuses and says how.
    expect(result.mergedThrough).toBe(first);
    expect(result.refusal?.pr).toBe(top);
    expect(result.refusal?.message).toContain("targets `layer-1`");
    expect(result.refusal?.message).toContain("--base main");
    expect(result.stack.layers.find((l) => l.pr === top)?.state).toBe("OPEN");
    // Exactly one merge ran: nothing was folded into the layer below.
    const logged = JSON.parse(readFileSync(path.join(root, "gh-log.json"), "utf8")) as Array<number | string[]>;
    expect(logged.filter((entry): entry is number => typeof entry === "number")).toEqual([first]);
  });

  it("refuses a merge when the layer's head moved since GitHub named it", async () => {
    const { agent, wsId } = await app();
    git(root, "checkout", "-q", "layer-1");
    await agent.post(`/api/workspaces/${wsId}/pr-stack`).send({ base: "main", title: "Layer one" }).expect(201);
    const stack = await stackOf(agent, wsId);
    const pr = stack!.layers[0]!.pr;
    // The branch moved to a commit GitHub's view does not name (headMovedTo), as it does
    // between the panel's read and the merge: GitHub then refreshes the head it was asked
    // about, so the requested merge names the old one and is refused.
    const onDisk = JSON.parse(readFileSync(path.join(root, "gh-prs.json"), "utf8")) as Record<string, { state: string; base: string; head: string; oid: string; headMovedTo?: string }>;
    const row = onDisk[String(pr)];
    if (!row) throw new Error(`the stand-in minted no PR ${pr}`);
    row.headMovedTo = "f".repeat(40);
    writeFileSync(path.join(root, "gh-prs.json"), JSON.stringify(onDisk));
    const merged = await agent.post(`/api/workspaces/${wsId}/pr-stack/${stack!.id}/merge`).send({}).expect(200);
    const result = merged.body as { mergedThrough: number | null; refusal: { pr: number; message: string } | null };
    expect(result.mergedThrough).toBeNull();
    expect(result.refusal?.pr).toBe(pr);
    expect(result.refusal?.message).toContain("Head branch was modified");
  });

  it("treats a layer merged elsewhere as through, and a closed one as a refusal", async () => {
    const { agent, wsId } = await app();
    git(root, "checkout", "-q", "layer-1");
    await agent.post(`/api/workspaces/${wsId}/pr-stack`).send({ base: "main", title: "Layer one" }).expect(201);
    const first = (await stackOf(agent, wsId))!.layers[0]!.pr;
    git(root, "checkout", "-q", "layer-2");
    await agent.post(`/api/workspaces/${wsId}/pr-stack`).send({ above: first, title: "Layer two" }).expect(201);
    const before = await stackOf(agent, wsId);
    const top = before!.layers[0]!.pr;
    // The record's OPEN is not the truth: the bottom PR was merged by hand and the top one
    // closed, so the merge records what GitHub says and stops at the layer that cannot merge.
    const onDisk = JSON.parse(readFileSync(path.join(root, "gh-prs.json"), "utf8")) as Record<string, { state: string; base: string; head: string; oid: string }>;
    onDisk[String(first)] = { ...onDisk[String(first)]!, state: "MERGED" };
    onDisk[String(top)] = { ...onDisk[String(top)]!, state: "CLOSED" };
    writeFileSync(path.join(root, "gh-prs.json"), JSON.stringify(onDisk));

    const merged = await agent.post(`/api/workspaces/${wsId}/pr-stack/${before!.id}/merge`).send({}).expect(200);
    const result = merged.body as { stack: PrStack; mergedThrough: number | null; refusal: { pr: number; message: string } | null };
    expect(result.mergedThrough).toBe(first);
    expect(result.stack.layers.find((l) => l.pr === first)?.state).toBe("MERGED");
    expect(result.refusal?.pr).toBe(top);
    expect(result.refusal?.message).toContain("CLOSED");
    const logged = JSON.parse(readFileSync(path.join(root, "gh-log.json"), "utf8")) as Array<number | string[]>;
    expect(logged.filter((entry): entry is number => typeof entry === "number")).toEqual([]);
  });
});

describe("checkout-pr and archive on merge", () => {
  it("creates a managed isolated checkout of a PR's head branch, recorded with its number", async () => {
    const { agent, wsId } = await app();
    const res = await agent.post(`/api/workspaces/${wsId}/worktrees/checkout-pr`).send({ pr: 42, name: "audit-42" }).expect(201);
    const tree = res.body as { id: string; path: string; branch: string; base: string; pr: number };
    expect(tree.pr).toBe(42);
    expect(tree.path.startsWith(path.join(root, ".awui", "worktrees", "pr-42-"))).toBe(true);
    expect(existsSync(tree.path)).toBe(true);
    // The checkout's base is the head commit GitHub names for the PR.
    expect(tree.base).toBe(git(remote, "rev-parse", "refs/pull/42/head").trim());
    const listed = (await agent.get(`/api/workspaces/${wsId}/worktrees`).expect(200)).body as { worktrees: Array<{ id: string; pr?: number }> };
    expect(listed.worktrees.find((w) => w.id === tree.id)?.pr).toBe(42);
  });

  it("checks out the pull request's own head commit, not a same-named branch", async () => {
    const { agent, wsId } = await app();
    // A fork's PR whose head branch is called `main`: this repository's own `main` is a
    // different commit, so a checkout that trusted `origin/main` would take the wrong tree.
    const forkMain = git(remote, "rev-parse", "layer-3").trim();
    git(remote, "update-ref", "refs/pull/55/head", forkMain);
    prs[55] = { state: "OPEN", base: "main", head: "main", oid: forkMain };
    writeFileSync(path.join(root, "gh-prs.json"), JSON.stringify(prs));

    const res = await agent.post(`/api/workspaces/${wsId}/worktrees/checkout-pr`).send({ pr: 55, name: "fork-main" }).expect(201);
    const tree = res.body as { base: string; path: string };
    expect(tree.base).toBe(forkMain);
    // The work the PR carries, not this repository's main.
    expect(readFileSync(path.join(tree.path, "a.txt"), "utf8")).toBe("three\n");
    expect(git(root, "rev-parse", "origin/main").trim()).not.toBe(forkMain);
  });

  it("refuses a checkout whose fetched head is not the commit GitHub named", async () => {
    const { agent, wsId } = await app();
    // The PR's branch moved between gh's answer and the fetch: the tree would be a commit
    // nobody named, so the checkout refuses instead of creating it.
    git(remote, "update-ref", "refs/pull/56/head", git(remote, "rev-parse", "layer-2").trim());
    prs[56] = { state: "OPEN", base: "main", head: "layer-2", oid: "f".repeat(40) };
    writeFileSync(path.join(root, "gh-prs.json"), JSON.stringify(prs));
    const res = await agent.post(`/api/workspaces/${wsId}/worktrees/checkout-pr`).send({ pr: 56, name: "moved-head" });
    expect(res.status).toBe(409);
    expect((res.body as { code?: string }).code).toBe("pr_head_moved");
    const listed = (await agent.get(`/api/workspaces/${wsId}/worktrees`).expect(200)).body as { worktrees: Array<{ id: string }> };
    expect(listed.worktrees).toHaveLength(0);
  });

  it("refuses a second checkout of the same PR, and an unknown one", async () => {
    const { agent, wsId } = await app();
    await agent.post(`/api/workspaces/${wsId}/worktrees/checkout-pr`).send({ pr: 42, name: "first" }).expect(201);
    const again = await agent.post(`/api/workspaces/${wsId}/worktrees/checkout-pr`).send({ pr: 42, name: "second" });
    expect(again.status).toBe(409);
    expect((again.body as { code?: string }).code).toBe("pr_taken");
    const missing = await agent.post(`/api/workspaces/${wsId}/worktrees/checkout-pr`).send({ pr: 999, name: "nope" });
    expect(missing.status).toBe(404);
    expect((missing.body as { code?: string }).code).toBe("bad_pr");
  });

  it("archives a merged PR's clean checkout, and refuses a dirty tree with the worktree kept", async () => {
    const { agent, wsId } = await app();
    const res = await agent.post(`/api/workspaces/${wsId}/worktrees/checkout-pr`).send({ pr: 42, name: "archive-me" }).expect(201);
    const tree = res.body as { id: string; path: string };
    // Not merged yet: the archive route refuses before the worktree is touched.
    prs[42] = { ...prs[42]!, state: "OPEN" };
    writeFileSync(path.join(root, "gh-prs.json"), JSON.stringify(prs));
    const notMerged = await agent.post(`/api/workspaces/${wsId}/worktrees/${tree.id}/archive?pr=42`).send({});
    expect(notMerged.status).toBe(409);
    expect((notMerged.body as { code?: string }).code).toBe("not_merged");
    expect(existsSync(tree.path)).toBe(true);

    // Dirty tree: the worktree refuses itself, the refusal names the problem.
    prs[42] = { ...prs[42]!, state: "MERGED" };
    writeFileSync(path.join(root, "gh-prs.json"), JSON.stringify(prs));
    writeFileSync(path.join(tree.path, "a.txt"), "uncommitted\n");
    const dirty = await agent.post(`/api/workspaces/${wsId}/worktrees/${tree.id}/archive?pr=42`).send({});
    expect(dirty.status).toBe(409);
    expect((dirty.body as { code?: string }).code).toBe("dirty_tree");
    expect(existsSync(tree.path)).toBe(true);

    // Clean (the change committed): the archive removes the checkout and its branch.
    git(tree.path, "add", ".");
    git(tree.path, "commit", "-qm", "finish");
    await agent.post(`/api/workspaces/${wsId}/worktrees/${tree.id}/archive?pr=42`).send({}).expect(200);
    expect(existsSync(tree.path)).toBe(false);
    const listed = (await agent.get(`/api/workspaces/${wsId}/worktrees`).expect(200)).body as { worktrees: Array<{ id: string }> };
    expect(listed.worktrees.find((w) => w.id === tree.id)).toBeUndefined();
  });

  it("archives a checkout through the stack merge when the layer tracks it", async () => {
    const { agent, wsId } = await app();
    const res = await agent.post(`/api/workspaces/${wsId}/worktrees/checkout-pr`).send({ pr: 42, name: "stacked-checkout" }).expect(201);
    const tree = res.body as { id: string; path: string };
    // A stack whose bottom layer tracks the checkout (the panel wires worktreeId
    // when it stacks from a checkout-pr tree): one layer, its PR merged by the stand-in.
    await agent.post(`/api/workspaces/${wsId}/pr-stack`).send({ base: "main", title: "Layer one" }).expect(201);
    const stack = await stackOf(agent, wsId);
    // The stack record is the server's; write the layer's worktreeId the way the
    // stacking panel does when it stacks a PR from its managed checkout.
    const stacks = (await agent.get(`/api/workspaces/${wsId}/pr-stack`).expect(200)).body as { stacks: PrStack[] };
    expect(stacks.stacks).toHaveLength(1);
    // The merge with archive: the layer's PR merges and the tracked checkout goes.
    const body = await agent.post(`/api/workspaces/${wsId}/pr-stack/${stack!.id}/merge`).send({ archive: true }).expect(200);
    const result = body.body as { stack: PrStack; archiveRefusals: Array<{ pr: number; message: string }> };
    expect(result.archiveRefusals).toHaveLength(0);
    // Form-minted layers track no checkout, so the checkout stays; this test's
    // layer has none wired either, and the archive itself is covered above.
    expect(existsSync(tree.path)).toBe(true);
  });
});

describe("managed worktrees with gh only", () => {
  it("never runs a browser credential path: the stand-in is the only gh", async () => {
    const { agent, wsId } = await app();
    // The stack route runs gh from the workspace: the stand-in's log proves it was ours.
    await agent.post(`/api/workspaces/${wsId}/pr-stack`).send({ base: "main", title: "Prove gh" }).expect(201);
    const logged = JSON.parse(readFileSync(path.join(root, "gh-log.json"), "utf8")) as unknown[][];
    expect(logged.length).toBeGreaterThan(0);
    expect(logged[0]![0]).toBe("pr");
  });
});
