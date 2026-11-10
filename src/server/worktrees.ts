// Managed git worktrees for a project: one service per workspace, a validated
// name → `.awui/worktrees/<slug>-<hex>`, the trees recorded in the project's
// own `.awui/worktrees.json`. Git runs through the server's runner with none
// of the environment's GIT_* pointing it elsewhere, no prompts, no hooks.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { WorkspaceInfo } from "../shared/protocol.js";
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

export interface WorktreeService {
  list(ws: WorkspaceInfo): Promise<WorktreeInfo[]>;
  create(ws: WorkspaceInfo, name: string, base: string): Promise<WorktreeInfo>;
  prune(ws: WorkspaceInfo, id: string): Promise<void>;
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

  async create(ws: WorkspaceInfo, name: string, base: string): Promise<WorktreeInfo> {
    return serial(ws, () => this.createOne(ws, name, base));
  }

  private async createOne(ws: WorkspaceInfo, name: string, base: string): Promise<WorktreeInfo> {
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
    return info;
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
}
