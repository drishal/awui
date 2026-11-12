// The project's git status for the composer's git row (Hermes Desktop's coding
// row): branch, upstream and ahead/behind, an operation under way, the last
// commit, stashes, and every changed file with its lines against HEAD. Read
// with --no-optional-locks, so it never takes the index lock from under the
// agent's own git commands.
import { promises as fs } from "node:fs";
import path from "node:path";
import type { GitDiffSide, GitFile, GitFileDiff, GitFileState, GitStatus } from "../shared/protocol.js";
import { git } from "./git.js";
import { parseUnified } from "../shared/unified-diff.js";

const MAX_FILES = 500;
const MAX_UNTRACKED_BYTES = 512 * 1024;
const READ = { timeoutMs: 15_000 };

const STATE: Record<string, GitFileState> = { M: "modified", T: "typechange", A: "added", D: "deleted", R: "renamed", C: "copied", U: "conflict" };
const side = (c: string | undefined): GitFileState | null => (c && c !== "." ? (STATE[c] ?? "modified") : null);

const read = (cwd: string, args: string[]) => git(["--no-optional-locks", ...args], { cwd, ...READ });

/** `git status --porcelain=v2 --branch -z`, parsed. */
export function parsePorcelain(out: string): Pick<GitStatus, "branch" | "head" | "upstream" | "ahead" | "behind"> & { files: GitFile[] } {
  const parts = out.split("\0");
  let branch: string | null = null;
  let head: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: GitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i] as string;
    if (!line) continue;
    if (line.startsWith("# branch.oid ")) {
      const oid = line.slice(13);
      head = oid === "(initial)" ? null : oid.slice(0, 7);
    } else if (line.startsWith("# branch.head ")) {
      const name = line.slice(14);
      branch = name === "(detached)" ? null : name;
    } else if (line.startsWith("# branch.upstream ")) upstream = line.slice(18);
    else if (line.startsWith("# branch.ab ")) {
      const m = /^\+(\d+) -(\d+)$/.exec(line.slice(12));
      if (m) [ahead, behind] = [Number(m[1]), Number(m[2])];
    } else if (line.startsWith("1 ")) {
      const f = line.split(" ");
      files.push({ path: f.slice(8).join(" "), staged: side(f[1]?.[0]), unstaged: side(f[1]?.[1]), added: null, removed: null });
    } else if (line.startsWith("2 ")) {
      const f = line.split(" ");
      const from = parts[++i] ?? "";
      files.push({ path: f.slice(9).join(" "), from, staged: side(f[1]?.[0]), unstaged: side(f[1]?.[1]), added: null, removed: null });
    } else if (line.startsWith("u ")) {
      const f = line.split(" ");
      files.push({ path: f.slice(10).join(" "), staged: "conflict", unstaged: "conflict", added: null, removed: null });
    } else if (line.startsWith("? ")) {
      files.push({ path: line.slice(2), staged: null, unstaged: "untracked", added: null, removed: null });
    }
  }
  return { branch, head, upstream, ahead, behind, files };
}

/** `git diff --numstat -z -M`: lines per path (`-` for binary files is null); a rename is `a\tb\t\0from\0to`. */
export function parseNumstat(out: string): Map<string, { added: number | null; removed: number | null }> {
  const stats = new Map<string, { added: number | null; removed: number | null }>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const m = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(parts[i] as string);
    if (!m) continue;
    let file = m[3] as string;
    if (file === "") {
      i += 2;
      file = parts[i] ?? "";
    }
    stats.set(file, { added: m[1] === "-" ? null : Number(m[1]), removed: m[2] === "-" ? null : Number(m[2]) });
  }
  return stats;
}

async function exists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function operation(cwd: string): Promise<GitStatus["operation"]> {
  const names = ["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG"];
  const out = (await read(cwd, ["rev-parse", "--path-format=absolute", ...names.flatMap((n) => ["--git-path", n])]).catch(() => "")).split("\n");
  const has = await Promise.all(names.map((_, i) => (out[i] ? exists(out[i] as string) : Promise.resolve(false))));
  if (has[0]) return "merge";
  if (has[1] || has[2]) return "rebase";
  if (has[3]) return "cherry-pick";
  if (has[4]) return "revert";
  if (has[5]) return "bisect";
  return null;
}

/** The status of the repository holding `cwd`, or null outside one. */
export async function gitStatus(cwd: string): Promise<GitStatus | null> {
  let root: string;
  try {
    root = (await read(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
  if (!root) return null;
  const porcelain = parsePorcelain(await read(root, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]));
  const numstat = (args: string[]) => read(root, ["diff", ...args, "--numstat", "-z", "-M", "--no-ext-diff"]).catch(() => "");
  const [total, cached, worktree, op, log, stashes] = await Promise.all([
    porcelain.head ? numstat(["HEAD"]) : Promise.resolve(""),
    numstat(["--cached"]),
    numstat([]),
    operation(root),
    porcelain.head ? read(root, ["log", "-1", "--format=%h%x00%s%x00%an%x00%ct"]).catch(() => "") : Promise.resolve(""),
    read(root, ["rev-list", "--walk-reflogs", "--count", "refs/stash"]).catch(() => "0"),
  ]);
  const stats = parseNumstat(total);
  const stagedStats = parseNumstat(cached);
  const unstagedStats = parseNumstat(worktree);
  const counts = { staged: 0, changed: 0, untracked: 0, conflicts: 0 };
  let added = 0;
  let removed = 0;
  // Conflicts first, then staged, changed, and untracked files, each by path.
  const rank = (f: GitFile) => (f.staged === "conflict" ? 0 : f.unstaged === "untracked" ? 3 : f.staged ? 1 : 2);
  const files = porcelain.files
    .map((f) => {
      const s = stats.get(f.path);
      if (f.staged === "conflict") counts.conflicts += 1;
      else if (f.unstaged === "untracked") counts.untracked += 1;
      else {
        if (f.staged) counts.staged += 1;
        if (f.unstaged) counts.changed += 1;
      }
      added += s?.added ?? 0;
      removed += s?.removed ?? 0;
      const st = f.staged && f.staged !== "conflict" ? stagedStats.get(f.path) : undefined;
      const un = f.unstaged && f.unstaged !== "untracked" && f.unstaged !== "conflict" ? unstagedStats.get(f.path) : undefined;
      return { ...f, ...(s ?? {}), ...(st ? { stagedLines: st } : {}), ...(un ? { unstagedLines: un } : {}) };
    })
    .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  const [hash = "", subject = "", author = "", at = "0"] = log.trim().split("\0");
  return {
    root,
    branch: porcelain.branch,
    head: porcelain.head,
    upstream: porcelain.upstream,
    ahead: porcelain.ahead,
    behind: porcelain.behind,
    operation: op,
    lastCommit: hash ? { hash, subject, author, at: Number(at) * 1000 } : null,
    stashes: Number(stashes.trim()) || 0,
    files: files.slice(0, MAX_FILES),
    more: Math.max(0, files.length - MAX_FILES),
    counts,
    added,
    removed,
  };
}

/**
 * One side of a changed file's diff: what is staged (against HEAD), what is
 * not yet (the work tree against the index), or all of an untracked file as
 * added. Only a path `git status` lists right now is read: the route never
 * opens anything else.
 */
export async function gitFileDiff(cwd: string, file: string, side: GitDiffSide): Promise<GitFileDiff | null> {
  const status = await gitStatus(cwd);
  const entry = status?.files.find((f) => f.path === file);
  if (!status || !entry) return null;
  const base = ["diff", "--no-color", "--no-ext-diff", "-M"];
  const paths = ["--", ...(entry.from ? [entry.from] : []), file];
  if (side === "untracked" || entry.unstaged === "untracked") {
    if (entry.unstaged !== "untracked") return null;
    const stat = await fs.stat(path.join(status.root, file)).catch(() => null);
    if (!stat?.isFile()) return { diff: null, note: "Not a regular file" };
    if (stat.size > MAX_UNTRACKED_BYTES) return { diff: null, note: "Too large to show" };
    return described(await git(["--no-optional-locks", "diff", "--no-index", "--no-color", "--no-ext-diff", "--", "/dev/null", file], { cwd: status.root, ...READ, okExit: [1] }));
  }
  if (side === "staged") return described(await read(status.root, [...base, "--cached", ...paths]));
  return described(await read(status.root, [...base, ...paths]));
}

function described(out: string): GitFileDiff {
  const diff = parseUnified(out);
  if (diff) return { diff };
  return { diff: null, note: /^Binary files /m.test(out) ? "Binary file" : "No line changes (mode or rename only)" };
}
