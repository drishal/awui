import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPullRequest, currentPullRequest, pullRequestChecks, pushBranch } from "../../src/server/github.js";

const dirs: string[] = [];
let workspace: string;
let remote: string;
let gh: string;
const originalPath = process.env.PATH;

const runGit = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), "awui-github-workflow-"));
  remote = mkdtempSync(path.join(tmpdir(), "awui-github-remote-"));
  dirs.push(workspace, remote);
  runGit(remote, "init", "--bare");
  runGit(workspace, "init");

  runGit(workspace, "remote", "add", "origin", remote);
  runGit(workspace, "checkout", "-b", "main");
  runGit(workspace, "config", "user.email", "test@example.invalid");
  runGit(workspace, "config", "user.name", "test");
  writeFileSync(path.join(workspace, "a.txt"), "hello\n");
  runGit(workspace, "add", "a.txt");
  runGit(workspace, "commit", "-qm", "base");
  runGit(workspace, "checkout", "-b", "feature-audit");
  writeFileSync(path.join(workspace, "b.txt"), "changed\n");
  runGit(workspace, "add", "b.txt");
  runGit(workspace, "commit", "-qm", "change");
  gh = path.join(workspace, "gh");
  writeFileSync(gh, `#!/usr/bin/env node\nconst fs = require("node:fs");const args=process.argv.slice(2);if(args[0]==="auth")process.exit(0);if(args[0]==="pr"&&args[1]==="create"){fs.writeFileSync(${JSON.stringify(path.join(workspace, "pr-args.json"))},JSON.stringify(args));console.log("https://github.com/example/repo/pull/42");process.exit(0)}if(args[0]==="pr"&&args[1]==="view"){console.log(JSON.stringify({url:"https://github.com/example/repo/pull/42",title:"Audit",state:"OPEN",isDraft:true}));process.exit(0)}if(args[0]==="pr"&&args[1]==="checks"){console.log(JSON.stringify([{name:"tests",bucket:"pass",link:"https://github.com/example/repo/actions/42"}]));process.exit(0)}process.exit(2);\n`);
  chmodSync(gh, 0o755);
});

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("GitHub git and CLI workflow", () => {
  it("pushes the local branch upstream, creates and reopens a PR, and reads real check payload", async () => {
    process.env.PATH = `${workspace}:${process.env.PATH ?? ""}`;
    const info = await pushBranch({ id: "w", path: workspace, name: "repo" });
    expect(info.ahead).toBe(0);
    expect(info.branch).toBe("feature-audit");
    expect(runGit(remote, "rev-parse", "feature-audit")).toBe(runGit(workspace, "rev-parse", "feature-audit"));
    const pr = await createPullRequest({ id: "w", path: workspace, name: "repo" }, "main", "Audit flow", "Verified locally");
    expect(pr.url).toBe("https://github.com/example/repo/pull/42");
    expect(JSON.parse(readFileSync(path.join(workspace, "pr-args.json"), "utf8"))).toEqual(["pr", "create", "--base", "main", "--title", "Audit flow", "--body", "Verified locally", "--head", "feature-audit"]);
    expect(await currentPullRequest({ id: "w", path: workspace, name: "repo" })).toMatchObject({ url: pr.url, title: "Audit", isDraft: true });
    expect(await pullRequestChecks({ id: "w", path: workspace, name: "repo" })).toEqual([{ name: "tests", state: "pass", link: "https://github.com/example/repo/actions/42" }]);
  });
});
