// ManagedWorktrees against a real tmp git repo: names validated, trees added
// and removed through real git, records kept in the project's `.awui`.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { ManagedWorktrees } from "../../src/server/worktrees.js";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });

function repo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, "app.ts"), "const a = 1;\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "init");
}

let dirs: string[] = [];
function ws(): { ws: WorkspaceInfo; root: string } {
  const root = path.join(tmpdir(), `awui-wt-${Math.random().toString(36).slice(2, 8)}`);
  dirs.push(root);
  repo(root);
  return { ws: { id: "w", path: root, name: path.basename(root) }, root };
}
afterEach(() => {
  for (const d of dirs) execFileSync("rm", ["-rf", d]);
  dirs = [];
});

const metaPath = (root: string) => path.join(root, ".awui", "worktrees.json");

describe("managed worktrees", () => {
  it("creates a tree under .awui/worktrees with a hex-suffixed branch, recorded in the project's metadata", async () => {
    const { ws: w, root } = ws();
    const svc = new ManagedWorktrees();
    const t = await svc.create(w, "feature-x", "HEAD");
    expect(t.path.startsWith(path.join(root, ".awui", "worktrees", "feature-x-"))).toBe(true);
    expect(t.branch).toMatch(/^awui\/feature-x-[0-9a-f]{8}$/);
    expect(t.base).toBe("HEAD");
    expect(t.id).toMatch(/^[0-9a-f]{8}$/);
    expect(existsSync(t.path)).toBe(true);
    expect(existsSync(path.join(t.path, "app.ts"))).toBe(true);
    const meta = JSON.parse(readFileSync(metaPath(root), "utf8")) as unknown[];
    expect(meta).toHaveLength(1);
    const first = meta[0];
    expect(first && typeof first === "object" && "id" in first ? first.id : undefined).toBe(t.id);
    expect(await svc.list(w)).toHaveLength(1);
  });

  it("rejects bad names, reserved names, and bad bases without creating anything", async () => {
    const { ws: w, root } = ws();
    const svc = new ManagedWorktrees();
    for (const bad of ["", "Feature_X", "-lead", "../escape", "/abs", "a".repeat(65), "prune", "list", "new"]) {
      await expect(svc.create(w, bad, "HEAD")).rejects.toThrow();
    }
    for (const badBase of ["nope-does-not-exist", "../.."]) {
      await expect(svc.create(w, "ok-name", badBase)).rejects.toThrow();
    }
    expect(existsSync(path.join(root, ".awui", "worktrees"))).toBe(false);
    expect(existsSync(metaPath(root))).toBe(false);
  });

  it("takes a second distinct name but refuses a duplicate of an existing one", async () => {
    const { ws: w } = ws();
    const svc = new ManagedWorktrees();
    const a = await svc.create(w, "dup", "HEAD");
    const b = await svc.create(w, "other", "HEAD");
    expect(a.path).not.toBe(b.path);
    await expect(svc.create(w, "dup", "HEAD")).rejects.toThrow("name_taken");
  });

  it("prunes a clean tree: directory gone, metadata updated, root worktree untouched", async () => {
    const { ws: w, root } = ws();
    const svc = new ManagedWorktrees();
    const t = await svc.create(w, "gone", "HEAD");
    await svc.prune(w, t.id);
    expect(existsSync(t.path)).toBe(false);
    expect(await svc.list(w)).toHaveLength(0);
    expect(JSON.parse(readFileSync(metaPath(root), "utf8"))).toHaveLength(0);
    expect(existsSync(root)).toBe(true);
  });

  it("refuses to prune a dirty tree without --force, then prunes once a change is committed", async () => {
    const { ws: w } = ws();
    const svc = new ManagedWorktrees();
    const t = await svc.create(w, "dirty", "HEAD");
    writeFileSync(path.join(t.path, "app.ts"), "const a = 2;\n");
    await expect(svc.prune(w, t.id)).rejects.toThrow("dirty_tree");
    expect(existsSync(t.path)).toBe(true);
    git(t.path, "add", ".");
    git(t.path, "commit", "-qm", "edit");
    await svc.prune(w, t.id);
    expect(existsSync(t.path)).toBe(false);
  });

  it("prunes only ids from the given workspace and drops stale records whose directory vanished", async () => {
    const { ws: w, root } = ws();
    const other = ws();
    const svc = new ManagedWorktrees();
    const t = await svc.create(w, "mine", "HEAD");
    await expect(svc.prune(other.ws, t.id)).rejects.toThrow("unknown_id");
    execFileSync("rm", ["-rf", t.path]);
    expect(await svc.list(w)).toHaveLength(0);
    await svc.prune(w, t.id);
    expect(JSON.parse(readFileSync(metaPath(root), "utf8"))).toHaveLength(0);
  });

  it("ignores malformed metadata entries and lists only existing directories", async () => {
    const { ws: w, root } = ws();
    const svc = new ManagedWorktrees();
    const t = await svc.create(w, "kept", "HEAD");
    // Replace the service's records with one real entry (the tree just made),
    // a stale one whose directory is gone, and two malformed rows.
    writeFileSync(
      metaPath(root),
      JSON.stringify([
        t,
        { id: "deadbeef", path: path.join(root, ".awui", "worktrees", "ghost-x"), branch: "awui/ghost", base: "HEAD", createdAt: 1 },
        "junk",
        { id: 5 },
      ]),
    );
    const listed = await svc.list(w);
    expect(listed.map((x) => x.id)).not.toContain("deadbeef");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(t.id);
  });

  it("absorbs a name collision with an existing unrelated directory via the suffix", async () => {
    const { ws: w, root } = ws();
    const svc = new ManagedWorktrees();
    const pre = path.join(root, ".awui", "worktrees", "clash-00000000");
    mkdirSync(pre, { recursive: true });
    const t = await svc.create(w, "clash", "HEAD");
    expect(t.path.startsWith(path.join(root, ".awui", "worktrees", "clash-"))).toBe(true);
    expect(t.path).not.toBe(pre);
    expect(await svc.list(w)).toHaveLength(1);
  });

  it("hides metadata rows whose path points outside the workspace", async () => {
    const { ws: w, root } = ws();
    const svc = new ManagedWorktrees();
    await svc.create(w, "kept", "HEAD");
    const outside = path.join(path.dirname(root), `awui-wt-outside-${Math.random().toString(36).slice(2, 8)}`);
    mkdirSync(outside, { recursive: true });
    writeFileSync(
      metaPath(root),
      JSON.stringify([
        { id: "outsider", path: outside, branch: "awui/out", base: "HEAD", createdAt: 1 },
        { id: "escapee", path: path.join(root, "..", "elsewhere"), branch: "awui/esc", base: "HEAD", createdAt: 2 },
      ]),
    );
    const listed = await svc.list(w);
    expect(listed).toHaveLength(0);
    await expect(svc.prune(w, "outsider")).rejects.toThrow("unknown_id");
    execFileSync("rm", ["-rf", outside]);
  });

  it("keeps .awui out of the project's git status, and prune drops the task branch only when it is merged", async () => {
    const { ws: w, root } = ws();
    const svc = new ManagedWorktrees();
    const merged = await svc.create(w, "merged-task", "HEAD");
    expect(git(root, "status", "--porcelain", "--untracked-files=all")).toBe("");
    await svc.prune(w, merged.id);
    expect(git(root, "branch", "--list", merged.branch)).toBe("");
    const unmerged = await svc.create(w, "unmerged-task", "HEAD");
    writeFileSync(path.join(unmerged.path, "new.ts"), "export {};\n");
    git(unmerged.path, "add", ".");
    git(unmerged.path, "commit", "-qm", "work");
    await svc.prune(w, unmerged.id);
    expect(git(root, "branch", "--list", unmerged.branch)).toContain(unmerged.branch);
  });
});
