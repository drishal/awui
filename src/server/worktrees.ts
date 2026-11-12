// Managed git worktrees for a project: one service per workspace, a validated
// name → `.awui/worktrees/<slug>-<hex>`, the trees recorded in the project's
// own `.awui/worktrees.json`. Git runs through the server's runner with none
// of the environment's GIT_* pointing it elsewhere, no prompts, no hooks.
// A checked-in `.worktreeinclude` seeds each new tree at once: gitignored
// files and small folders copied, large folders (under `[link]`) symlinked,
// every path confined to the project the way workspaces.ts confines itself.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { WorkspaceInfo, WorktreeCreated, WorktreeSeedReport } from "../shared/protocol.js";
import { isWithin } from "./workspaces.js";
import { ChatError } from "./chats/chat.js";
import { git } from "./git.js";
import { readJson, writeJsonChecked } from "./state-file.js";

/** One managed worktree, as the routes and the panel carry it. */
export interface WorktreeInfo {
  id: string;
  /** Absolute path inside the workspace. */
  path: string;
  branch: string;
  /** The commit-ish the tree was created from. */
  base: string;
  createdAt: number;
}

/** What a create takes beyond the name and base: the project's own `awui.yml` shared entries. */
export interface WorktreeCreateOptions {
  /**
   * Project-relative gitignored entries to symlink into the new tree, from the project's
   * checked-in `awui.yml`. Confined exactly as `.worktreeinclude`'s entries are: absolute
   * paths and `..` are skipped, and a source whose realpath leaves the project never lands.
   */
  shared?: readonly string[];
}

export interface WorktreeService {
  list(ws: WorkspaceInfo): Promise<WorktreeInfo[]>;
  create(ws: WorkspaceInfo, name: string, base: string, options?: WorktreeCreateOptions): Promise<WorktreeCreated>;
  prune(ws: WorkspaceInfo, id: string): Promise<void>;
  /** Drop a tree's record after something else removed the checkout (a race's cleanup). */
  forget(ws: WorkspaceInfo, id: string): Promise<void>;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Names the API reserves, whatever the slug pattern would make of them. */
const RESERVED: Record<string, true> = { new: true, prune: true, list: true };

const reasons: Record<string, string> = {
  bad_name: "Use lowercase letters, numbers, and dashes for the task name",
  reserved_name: "That name is reserved",
  name_taken: "That task name already has a managed worktree",
  bad_base: "Choose a real branch or commit as the base",
  no_dest: "Could not find a fresh worktree directory",
  dirty_tree: "Commit or resolve this worktree's changes before pruning",
  unknown_id: "That managed worktree is not in this project",
};
export function worktreeProblem(error: unknown): ChatError | undefined {
  if (!(error instanceof Error) || !(error.message in reasons)) return undefined;
  const code = error.message;
  return new ChatError(code === "unknown_id" ? 404 : code === "name_taken" || code === "dirty_tree" ? 409 : code === "bad_base" ? 400 : 422, code, reasons[code] ?? "Worktree operation failed");
}
const SUFFIX_ATTEMPTS = 8;
const operations = new Map<string, Promise<void>>();

/** Serialize name discovery, git registration, and the metadata commit per workspace. */
function serial<T>(ws: WorkspaceInfo, run: () => Promise<T>): Promise<T> {
  const previous = operations.get(ws.path) ?? Promise.resolve();
  const next = previous.then(run, run);
  const tail = next.then(() => undefined, () => undefined);
  operations.set(ws.path, tail);
  void tail.finally(() => {
    if (operations.get(ws.path) === tail) operations.delete(ws.path);
  });
  return next;
}

/** Names the API accepts: lowercase ascii alnum with dashes, starting alnum. */
const slug = (name: string): string => name.trim().toLowerCase();

/** The project's own record of its trees, inside the validated main root. */
const metaFile = (ws: WorkspaceInfo): string => path.join(ws.path, ".awui", "worktrees.json");

/** Lenient read of the project's records: anything malformed or outside the
 *  workspace drops out, nothing here writes it back. */
function cleanEntry(ws: WorkspaceInfo, e: unknown): WorktreeInfo | null {
  if (typeof e !== "object" || e === null) return null;
  const { id, path: p, branch, base, createdAt } = e as Record<string, unknown>;
  if (typeof id !== "string" || typeof p !== "string" || typeof branch !== "string") return null;
  if (typeof base !== "string" || typeof createdAt !== "number") return null;
  if (!isWithin(ws.path, p)) return null;
  return { id, path: p, branch, base, createdAt };
}

async function loadMeta(ws: WorkspaceInfo): Promise<WorktreeInfo[]> {
  const raw = await readJson(metaFile(ws));
  if (!Array.isArray(raw)) return [];
  const out: WorktreeInfo[] = [];
  for (const e of raw) {
    const t = cleanEntry(ws, e);
    if (t) out.push(t);
  }
  return out;
}

/** A tree the metadata lists whose directory is gone: git's stale worktree, dropped from the list only. */
async function existsDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `.awui/.gitignore` holding `*`: the control area (worktrees.json, the nested
 * checkouts) stays out of the project's git status and of checkpoint snapshots,
 * whose `git add --all` would otherwise record it and let a turn undo delete the
 * record. An existing file is the user's and is left alone.
 */
async function ignoreControlArea(ws: WorkspaceInfo): Promise<void> {
  const dir = path.join(ws.path, ".awui");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, ".gitignore"), "*\n", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
}

export class ManagedWorktrees implements WorktreeService {
  async list(ws: WorkspaceInfo): Promise<WorktreeInfo[]> {
    const meta = await loadMeta(ws);
    const out: WorktreeInfo[] = [];
    for (const t of meta) {
      if (await existsDir(t.path)) out.push(t);
    }
    return out;
  }

  async create(ws: WorkspaceInfo, name: string, base: string, options?: WorktreeCreateOptions): Promise<WorktreeCreated> {
    return serial(ws, () => this.createOne(ws, name, base, options));
  }

  private async createOne(ws: WorkspaceInfo, name: string, base: string, options?: WorktreeCreateOptions): Promise<WorktreeCreated> {
    const s = slug(name);
    if (!s || s !== name.trim() || !SLUG_PATTERN.test(s)) throw new Error("bad_name");
    if (RESERVED[s]) throw new Error("reserved_name");

    const meta = await loadMeta(ws);
    if (meta.some((t) => slug(path.basename(t.path).replace(/-[0-9a-f]{1,8}$/, "")) === s)) {
      throw new Error("name_taken");
    }

    // base must be a branch or commit git can resolve before anything is created.
    const resolved = (await git(["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], { cwd: ws.path })).trim();
    if (!resolved) throw new Error("bad_base");

    // A short random suffix absorbs collisions with unrelated directories.
    let dest = "";
    for (let i = 0; i < SUFFIX_ATTEMPTS; i++) {
      const cand = path.join(ws.path, ".awui", "worktrees", `${s}-${randomUUID().replace(/-/g, "").slice(0, 8)}`);
      if (!(await existsDir(cand))) {
        dest = cand;
        break;
      }
    }
    if (!dest) throw new Error("no_dest");
    if (!isWithin(ws.path, dest)) throw new Error("bad_dest");

    await ignoreControlArea(ws);
    const branch = `awui/${s}-${randomUUID().replace(/-/g, "").slice(0, 8)}`;
    // `-b <branch>` before the destination, `--` keeps it from being mistaken
    // for an option, and the resolved base last — the legal syntax git accepts.
    await git(["worktree", "add", "-b", branch, "--", dest, resolved], { cwd: ws.path });
    if (!(await existsDir(dest))) throw new Error("create_failed");

    const info: WorktreeInfo = { id: randomUUID().slice(0, 8), path: dest, branch, base, createdAt: Date.now() };
    meta.push(info);
    // The record must be on disk before create returns; if it cannot be saved,
    // undo git's registration so metadata and git's worktree list stay
    // consistent with the throw. Only the tree this call just created.
    try {
      await writeJsonChecked(metaFile(ws), meta);
    } catch (err) {
      await git(["worktree", "remove", "--force", "--", dest], { cwd: ws.path }).catch(() => undefined);
      throw err;
    }
    // Seeding never fails the create: a broken include file or an unreadable
    // entry is reported entry by entry, and the tree is usable regardless.
    const seeded = await seedWorktree(ws.path, dest, options?.shared ?? []).catch((): WorktreeSeedReport => ({ copied: [], linked: [], skipped: [{ path: INCLUDE_FILE, reason: "could not be read" }], more: 0 }));
    return { ...info, seeded };
  }

  /** Remove a managed tree by id: its work tree must be clean (`.awui` aside), then git removes it with no --force. */
  async prune(ws: WorkspaceInfo, id: string): Promise<void> {
    return serial(ws, () => this.pruneOne(ws, id));
  }

  private async pruneOne(ws: WorkspaceInfo, id: string): Promise<void> {
    const meta = await loadMeta(ws);
    const at = meta.findIndex((t) => t.id === id);
    if (at < 0) throw new Error("unknown_id");
    const tree = meta[at];
    if (!tree) throw new Error("unknown_id");
    if (!isWithin(ws.path, tree.path)) throw new Error("bad_path");
    if (!(await existsDir(tree.path))) {
      // Git's stale registration: drop the record, nothing to remove.
      meta.splice(at, 1);
      await writeJsonChecked(metaFile(ws), meta);
      return;
    }

    const status = await git(["status", "--porcelain"], { cwd: tree.path });
    const dirty = status
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !l.endsWith(".awui") && !l.includes(".awui/"));
    if (dirty.length > 0) throw new Error("dirty_tree");

    await git(["worktree", "remove", "--", tree.path], { cwd: ws.path });
    meta.splice(at, 1);
    // Remove already happened; a failed save leaves the record listed and a
    // retry of prune converges (the tree is gone, so the record drops out).
    await writeJsonChecked(metaFile(ws), meta);
    // The task branch goes too once its commits are merged; `-d` refuses an unmerged
    // one, which stays for the user to merge or delete, so no committed work is lost.
    await git(["branch", "-d", "--", tree.branch], { cwd: ws.path }).catch(() => undefined);
  }

  /** Drop a record whose checkout is already gone (a race's cleanup removed it): nothing to remove, nothing to break. */
  async forget(ws: WorkspaceInfo, id: string): Promise<void> {
    await serial(ws, async () => {
      const meta = await loadMeta(ws);
      const at = meta.findIndex((t) => t.id === id);
      if (at < 0) return;
      meta.splice(at, 1);
      await writeJsonChecked(metaFile(ws), meta);
    });
  }
}

/**
 * `.worktreeinclude`, checked in at the project root, makes a new worktree
 * usable at once. Plain lines name gitignored files or folders copied into
 * the tree (`.env`, `.vscode/`); under a `[link]` section (until a `[copy]`
 * line) they are symlinked instead, for large folders such as `node_modules`.
 * Paths are project-relative, one per line, `#` comments and blank lines
 * ignored. Every entry is confined the way workspaces.ts confines itself:
 * `..` and absolute paths are refused outright, and a source — or anything
 * inside a copied folder — whose realpath leaves the project is skipped.
 * Copies are bounded (50 entries, 20 MB, 2000 files, depth 16) and never
 * overwrite anything the fresh checkout already has.
 */

const INCLUDE_FILE = ".worktreeinclude";
const MAX_INCLUDE_ENTRIES = 50;
const MAX_SEED_BYTES = 20 * 1024 * 1024;
const MAX_SEED_FILES = 2000;
/** Stops a symlink cycle inside a copied folder from recursing for ever. */
const MAX_SEED_DEPTH = 16;
/** The report stays a bounded payload: past 100 skips only a count is carried. */
const MAX_REPORTED_SKIPS = 100;

export interface WorktreeIncludeEntry {
  path: string;
  link: boolean;
}

/** Parse the include file's text into entries with their mode; section headers are exact. */
export function parseWorktreeInclude(text: string): WorktreeIncludeEntry[] {
  const entries: WorktreeIncludeEntry[] = [];
  let link = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    if (line === "[link]") { link = true; continue; }
    if (line === "[copy]") { link = false; continue; }
    entries.push({ path: line.replace(/\/+$/, ""), link });
  }
  return entries;
}

interface SeedWalk {
  root: string;
  bytes: number;
  files: number;
  report: WorktreeSeedReport;
}

const pathTaken = async (p: string): Promise<boolean> => {
  try { await fs.lstat(p); return true; } catch { return false; }
};

/** The project-relative text a line carries: absolute paths and any `..` segment are refused outright. */
const escapes = (entry: string): boolean => path.isAbsolute(entry) || entry.split("/").includes("..");

function skip(walk: SeedWalk, p: string, reason: string): void {
  if (walk.report.skipped.length >= MAX_REPORTED_SKIPS) walk.report.more += 1;
  else walk.report.skipped.push({ path: p, reason });
}

/** Copy one file into the new tree under the budget; false when it was skipped. */
async function copyFileEntry(walk: SeedWalk, from: string, to: string, rel: string): Promise<boolean> {
  if (walk.files >= MAX_SEED_FILES || walk.bytes >= MAX_SEED_BYTES) { skip(walk, rel, "over the copy budget"); return false; }
  const size = (await fs.stat(from)).size;
  if (walk.bytes + size > MAX_SEED_BYTES) { skip(walk, rel, "over the copy budget"); return false; }
  await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
  walk.bytes += size;
  walk.files += 1;
  return true;
}

/** Copy one realpath-checked source into the new tree, walking folders with the budget in hand; false when the entry itself was skipped. */
async function copyEntry(walk: SeedWalk, from: string, to: string, rel: string, depth: number): Promise<boolean> {
  const stat = await fs.stat(from);
  if (stat.isFile()) return copyFileEntry(walk, from, to, rel);
  if (!stat.isDirectory()) { skip(walk, rel, "not a regular file"); return false; }
  if (depth > MAX_SEED_DEPTH) { skip(walk, rel, "nested too deep"); return false; }
  await fs.mkdir(to, { recursive: true });
  for (const item of await fs.readdir(from, { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${item.name}` : item.name;
    let childFrom = path.join(from, item.name);
    if (item.isSymbolicLink()) {
      // A link inside a copied folder is dereferenced, never carried over:
      // only targets that stay in the project are copied, the rest skipped.
      try { childFrom = await fs.realpath(childFrom); } catch { skip(walk, childRel, "missing"); continue; }
      if (!isWithin(walk.root, childFrom)) { skip(walk, childRel, "outside the project"); continue; }
    }
    await copyEntry(walk, childFrom, path.join(to, item.name), childRel, depth + 1);
  }
  return true;
}

/**
 * Seed one new tree from the project's `.worktreeinclude`, reporting what was copied,
 * linked, and skipped, then link the entries its `awui.yml` shares (the project config's
 * `shared`, which are always symlinks, never copies: they name what the tree reaches
 * back for, such as `node_modules`).
 */
async function seedWorktree(root: string, dest: string, shared: readonly string[] = []): Promise<WorktreeSeedReport> {
  const report: WorktreeSeedReport = { copied: [], linked: [], skipped: [], more: 0 };
  let text = "";
  try { text = await fs.readFile(path.join(root, INCLUDE_FILE), "utf8"); } catch { /* no include file: the shared entries below may still apply */ }
  const walk: SeedWalk = { root, bytes: 0, files: 0, report };
  const entries = [...parseWorktreeInclude(text), ...shared.map((entry) => ({ path: entry.replace(/\/+$/, ""), link: true }))];
  for (const entry of entries) {
    if (report.copied.length + report.linked.length >= MAX_INCLUDE_ENTRIES) { skip(walk, entry.path, "too many entries"); continue; }
    if (escapes(entry.path)) { skip(walk, entry.path, "outside the project"); continue; }
    let real: string;
    try { real = await fs.realpath(path.join(root, entry.path)); } catch { skip(walk, entry.path, "missing"); continue; }
    if (!isWithin(root, real)) { skip(walk, entry.path, "outside the project"); continue; }
    const to = path.join(dest, entry.path);
    if (await pathTaken(to)) { skip(walk, entry.path, "already exists"); continue; }
    const stat = await fs.stat(real);
    if (!stat.isFile() && !stat.isDirectory()) { skip(walk, entry.path, "not a regular file"); continue; }
    try {
      await fs.mkdir(path.dirname(to), { recursive: true });
      // The source is confined above; the destination must be too. A base ref's own tree can hold a symlink where the
      // project has a real folder, and writing through it would leave the new checkout.
      if (!isWithin(await fs.realpath(dest), await fs.realpath(path.dirname(to)))) { skip(walk, entry.path, "outside the new tree"); continue; }
      if (entry.link) {
        // A relative target keeps the link valid if the project folder moves.
        await fs.symlink(path.relative(dest, real), to);
        report.linked.push(entry.path);
      } else {
        if (await copyEntry(walk, real, to, entry.path, 1)) report.copied.push(entry.path);
      }
    } catch {
      skip(walk, entry.path, entry.link ? "could not be linked" : "could not be copied");
    }
  }
  return report;
}
