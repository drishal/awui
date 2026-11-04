import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { gitFileDiff, gitStatus, parseNumstat, parsePorcelain } from "../../src/server/git-status.js";
import { clearDirenvCache } from "../../src/server/direnv.js";
import { groupFiles } from "../../src/web/git.js";
import { tempDir } from "../helpers/app.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=Tess", "-c", "user.email=t@t", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

describe("git status parsing", () => {
  it("reads porcelain v2 headers, renames, conflicts, and untracked files", () => {
    const out = [
      "# branch.oid 1234567890abcdef",
      "# branch.head feature/x",
      "# branch.upstream origin/feature/x",
      "# branch.ab +2 -1",
      "1 .M N... 100644 100644 100644 aaa bbb src/app file.ts",
      "2 R. N... 100644 100644 100644 aaa bbb R100 new.ts",
      "old.ts",
      "u UU N... 100644 100644 100644 100644 a b c clash.ts",
      "? notes.md",
      "",
    ].join("\0");
    expect(parsePorcelain(out)).toEqual({
      branch: "feature/x",
      head: "1234567",
      upstream: "origin/feature/x",
      ahead: 2,
      behind: 1,
      files: [
        { path: "src/app file.ts", staged: null, unstaged: "modified", added: null, removed: null },
        { path: "new.ts", from: "old.ts", staged: "renamed", unstaged: null, added: null, removed: null },
        { path: "clash.ts", staged: "conflict", unstaged: "conflict", added: null, removed: null },
        { path: "notes.md", staged: null, unstaged: "untracked", added: null, removed: null },
      ],
    });
    expect(parsePorcelain("# branch.oid (initial)\0# branch.head (detached)\0")).toMatchObject({ head: null, branch: null });
    expect(parseNumstat("3\t1\ta.ts\0-\t-\timg.png\x001\t0\t\0old.ts\0new.ts\0")).toEqual(
      new Map([
        ["a.ts", { added: 3, removed: 1 }],
        ["img.png", { added: null, removed: null }],
        ["new.ts", { added: 1, removed: 0 }],
      ]),
    );
  });
});

describe("git status of a repository", () => {
  it("summarizes branch, upstream, last commit, stashes, and every changed file", async () => {
    const origin = tempDir("awui-origin-");
    git(origin, "init", "-q", "--bare");
    const dir = tempDir("awui-git-");
    git(dir, "init", "-q");
    writeFileSync(path.join(dir, "app.ts"), "one\ntwo\nthree\n");
    writeFileSync(path.join(dir, "old.ts"), "moving\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "First commit");
    git(dir, "remote", "add", "origin", origin);
    git(dir, "push", "-qu", "origin", "main");
    writeFileSync(path.join(dir, "app.ts"), "one\nTWO\nthree\nfour\n");
    git(dir, "commit", "-qam", "Second: shout two");
    writeFileSync(path.join(dir, "stash.txt"), "s\n");
    git(dir, "add", "stash.txt");
    git(dir, "stash", "-q");
    writeFileSync(path.join(dir, "app.ts"), "one\nTWO\n");
    git(dir, "mv", "old.ts", "new.ts");
    writeFileSync(path.join(dir, "both.ts"), "x\n");
    git(dir, "add", "both.ts");
    writeFileSync(path.join(dir, "both.ts"), "x\ny\n");
    writeFileSync(path.join(dir, "staged.ts"), "a\nb\n");
    git(dir, "add", "staged.ts");
    mkdirSync(path.join(dir, "docs"));
    writeFileSync(path.join(dir, "docs", "notes.md"), "hello\nworld\n");

    const status = await gitStatus(path.join(dir, "docs"));
    expect(status).toMatchObject({
      branch: "main",
      upstream: "origin/main",
      ahead: 1,
      behind: 0,
      operation: null,
      stashes: 1,
      counts: { staged: 3, changed: 2, untracked: 1, conflicts: 0 },
      added: 4,
      removed: 2,
      more: 0,
    });
    expect(status?.lastCommit).toMatchObject({ subject: "Second: shout two", author: "Tess" });
    expect(status?.files.map((f) => [f.path, f.staged, f.unstaged, f.added, f.removed])).toEqual([
      ["both.ts", "added", "modified", 2, 0],
      ["new.ts", "renamed", null, 0, 0],
      ["staged.ts", "added", null, 2, 0],
      ["app.ts", null, "modified", 0, 2],
      ["docs/notes.md", null, "untracked", null, null],
    ]);
    const both = status?.files.find((f) => f.path === "both.ts");
    expect([both?.stagedLines, both?.unstagedLines]).toEqual([
      { added: 1, removed: 0 },
      { added: 1, removed: 0 },
    ]);
    // As git status lists them: a file staged and changed again is under both.
    expect(groupFiles(status?.files ?? []).map((g) => [g.group, g.files.map((e) => `${e.file.path}:${e.state}:${e.side}`)])).toEqual([
      ["staged", ["both.ts:added:staged", "new.ts:renamed:staged", "staged.ts:added:staged"]],
      ["changed", ["both.ts:modified:unstaged", "app.ts:modified:unstaged"]],
      ["untracked", ["docs/notes.md:untracked:untracked"]],
    ]);
    const lines = async (file: string, side: "staged" | "unstaged") => (await gitFileDiff(dir, file, side))?.diff?.lines.filter((l) => l.kind === "add").map((l) => l.text);
    expect(await lines("both.ts", "staged")).toEqual(["x"]);
    expect(await lines("both.ts", "unstaged")).toEqual(["y"]);

    const untracked = await gitFileDiff(dir, "docs/notes.md", "untracked");
    expect(untracked?.diff?.lines.map((l) => `${l.kind}:${l.text}`)).toEqual(["add:hello", "add:world"]);
    const modified = await gitFileDiff(dir, "app.ts", "unstaged");
    expect(modified?.diff?.lines.filter((l) => l.kind === "del").map((l) => l.text)).toEqual(["three", "four"]);
    expect(await gitFileDiff(dir, "../../etc/passwd", "untracked")).toBeNull();
    expect(await gitFileDiff(dir, "app.ts", "untracked")).toBeNull();
    expect(await gitStatus(tempDir("awui-nogit-"))).toBeNull();
  });

  it("names a merge under way and its conflicts", async () => {
    const dir = tempDir("awui-merge-");
    git(dir, "init", "-q");
    writeFileSync(path.join(dir, "a.txt"), "base\n");
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "base");
    git(dir, "checkout", "-qb", "other");
    writeFileSync(path.join(dir, "a.txt"), "theirs\n");
    git(dir, "commit", "-qam", "theirs");
    git(dir, "checkout", "-q", "main");
    writeFileSync(path.join(dir, "a.txt"), "ours\n");
    git(dir, "commit", "-qam", "ours");
    try {
      git(dir, "merge", "-q", "other");
    } catch {
      // the conflict is the point
    }
    const status = await gitStatus(dir);
    expect(status).toMatchObject({ operation: "merge", counts: { conflicts: 1 } });
    expect(status?.files[0]).toMatchObject({ path: "a.txt", staged: "conflict" });
  });
});

describe("git status over HTTP", () => {
  it("serves the chat project's status and a listed file's diff, and nothing else", async () => {
    const { makeTestApp, signedIn } = await import("../helpers/app.js");
    const t = await makeTestApp();
    try {
      git(t.project, "init", "-q");
      writeFileSync(path.join(t.project, "a.txt"), "a\n");
      git(t.project, "add", ".");
      git(t.project, "commit", "-qm", "first");
      writeFileSync(path.join(t.project, "a.txt"), "b\n");
      const agent = await signedIn(t);
      const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
      const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as { chatId: string };
      // The direnv state rides along: no .envrc here, so none.
      const res = (await agent.get(`/api/chats/${chat.chatId}/git`).expect(200)).body as { status: unknown; direnv: { blocked: boolean; rcPath: string | null; allowed: boolean | null } };
      expect(res.status).toMatchObject({ branch: "main", counts: { changed: 1 }, added: 1, removed: 1 });
      expect(res.direnv).toEqual({ blocked: false, rcPath: null, allowed: null });
      // An allowed .envrc says so by direnv's own word.
      writeFileSync(path.join(t.project, ".envrc"), "export AWUI_TEST_ENVRC=git-route\n");
      execFileSync("direnv", ["allow"], { cwd: t.project });
      clearDirenvCache();
      const allowed = (await agent.get(`/api/chats/${chat.chatId}/git`).expect(200)).body as { direnv: { blocked: boolean; allowed: boolean | null } };
      expect(allowed.direnv).toEqual({ blocked: false, rcPath: path.join(t.project, ".envrc"), allowed: true });
      const diff = (await agent.get(`/api/chats/${chat.chatId}/git/diff?path=a.txt&side=unstaged`).expect(200)).body;
      expect(diff.diff.lines.map((l: { kind: string; text: string }) => `${l.kind}:${l.text}`)).toEqual(["del:a", "add:b"]);
      await agent.get(`/api/chats/${chat.chatId}/git/diff?path=${encodeURIComponent("/etc/passwd")}&side=untracked`).expect(404);
      await agent.get(`/api/chats/${chat.chatId}/git/diff`).expect(400);
    } finally {
      await t.close();
    }
  });
});
