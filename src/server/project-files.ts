// A project's files, for a client's `@file` mention picker: what git tracks
// plus untracked files it does not ignore, or, outside a repository, a
// bounded walk that skips dependency and build folders. Listed paths are
// relative to the project and never leave it; a list is cached briefly so
// typing a mention does not run git per key.
import { promises as fs } from "node:fs";
import path from "node:path";
import { git } from "./git.js";

/** At most this many paths are kept per project: a mention picker needs to find, not to enumerate a monorepo. */
const MAX_FILES = 50_000;
const WALK_DEPTH = 8;
const CACHE_MS = 15_000;
const SKIP = new Set(["node_modules", "dist", "build", "target", ".git", ".direnv", ".devenv", ".venv", "__pycache__", ".next", ".cache", ".awui"]);

const cache = new Map<string, { at: number; files: Promise<string[]> }>();

async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, depth: number) => {
    if (depth > WALK_DEPTH || out.length >= MAX_FILES) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const full = path.join(dir, e.name);
      // Symlinks are not followed: a link out of the project would list what is outside it.
      if (e.isDirectory()) await visit(full, depth + 1);
      else if (e.isFile()) out.push(path.relative(root, full));
    }
  };
  await visit(root, 0);
  return out;
}

async function load(root: string): Promise<string[]> {
  try {
    const listed = await git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: root, timeoutMs: 10_000 });
    // awui's managed-worktree records are control data, not project files an
    // agent should read by default; other servers' ignored .awui dirs stay out.
    const files = [...new Set(listed.split("\0").filter(Boolean))].filter((file) => file !== ".awui" && !file.startsWith(".awui/"));
    return files.slice(0, MAX_FILES);
  } catch {
    return walk(root);
  }
}

/** The project's files, relative to `root`, from a cache younger than a few seconds. */
export function projectFiles(root: string, now = Date.now()): Promise<string[]> {
  const hit = cache.get(root);
  if (hit && now - hit.at < CACHE_MS) return hit.files;
  const files = load(root);
  cache.set(root, { at: now, files });
  files.catch(() => cache.delete(root));
  return files;
}

/** Whether the project lists `rel` (a path relative to it); a miss re-reads the list once, since the agent may have just made the file. */
export async function knownFile(root: string, rel: string): Promise<boolean> {
  if ((await projectFiles(root)).includes(rel)) return true;
  cache.delete(root);
  return (await projectFiles(root)).includes(rel);
}

/** How well `file` matches `q`: lower is better, null for no match (the name first, then the path, then letters in order). */
function score(file: string, q: string): number | null {
  const f = file.toLowerCase();
  const base = path.posix.basename(f);
  if (base.startsWith(q)) return 0;
  if (base.includes(q)) return 1;
  if (f.includes(q)) return 2;
  let at = 0;
  for (const ch of q) {
    at = f.indexOf(ch, at);
    if (at < 0) return null;
    at++;
  }
  return 3;
}

/** The best `limit` files for a mention query; with no query, the shortest paths (the project's top level). */
export function searchFiles(files: string[], query: string, limit = 30): string[] {
  const q = query.trim().toLowerCase();
  const ranked: Array<{ file: string; s: number }> = [];
  for (const file of files) {
    const s = q ? score(file, q) : 0;
    if (s !== null) ranked.push({ file, s });
  }
  return ranked
    .sort((a, b) => a.s - b.s || a.file.length - b.file.length || a.file.localeCompare(b.file))
    .slice(0, limit)
    .map((r) => r.file);
}
