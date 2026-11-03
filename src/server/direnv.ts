// direnv support for harness children: a project's .envrc applies to the
// agents awui spawns in it, as it would in a terminal. POSIX-only (direnv
// itself is); on Windows, or when direnv is absent, every call is a no-op.
//
// The probe is `direnv export json`:
//   - allowed .envrc → exit 0, the project's env as JSON.
//   - blocked .envrc → exit 1 with "is blocked" on stderr; the caller can ask
//     the user to allow it (the allow route runs direnv allow).
//   - no .envrc anywhere in the tree → exit 0 with {}.
//
// Spawns are sync, so the probe is execFileSync; its timeout caps a slow
// .envrc (devenv can build), and the answer is cached briefly per directory,
// keyed on the envrc's mtime so an edit (and its re-allow) lands on the next
// spawn without a server restart.
import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

/** direnv exists for POSIX; on Windows this whole module is a no-op. */
const IS_WINDOWS = process.platform === "win32";

/** Result of a look at a directory's direnv state. */
export interface DirenvState {
  /** A .envrc in the tree that direnv refuses to load until allowed. */
  blocked: boolean;
  /** The .envrc that matters (nearest up the tree), when one exists. */
  rcPath: string | null;
}

/** What a spawn takes: the env, and the state for an "allow?" prompt. */
export interface DirenvEnv {
  env: NodeJS.ProcessEnv;
  state: DirenvState;
}

/** direnv's own bookkeeping names; they belong to direnv's shell session, not a spawned agent. */
const DIRENV_OWN = /^DIRENV_(ACTIVE|DIFF|DIR|FILE|WATCHES|LOG)/;

const CACHE_MS = 5_000;
/** A slow .envrc (devenv evaluation) is capped well under a spawn's own cost. */
const TIMEOUT_MS = 15_000;

const cache = new Map<string, { at: number; stamp: string; result: DirenvEnv }>();

/** The nearest .envrc at or above dir, if one exists (direnv walks the same tree upward). */
export function findEnvrc(dir: string): string | null {
  let here = dir;
  for (;;) {
    const candidate = path.join(here, ".envrc");
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(here);
    if (parent === here) return null;
    here = parent;
  }
}

/** stat's (mtime, size) as the change stamp; a missing file is "gone". */
function stampOf(rcPath: string): string {
  try {
    const s = statSync(rcPath);
    return `${rcPath}:${s.mtimeMs}:${s.size}`;
  } catch {
    return "gone";
  }
}

function probe(dir: string, rcPath: string): DirenvEnv {
  if (IS_WINDOWS) return { env: process.env, state: { blocked: false, rcPath } };
  let stdout: string;
  try {
    stdout = execFileSync("direnv", ["export", "json"], {
      cwd: dir,
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    // The one failure that means something to the user: an .envrc direnv will not run yet
    // ("direnv: error <path>/.envrc is blocked. Run `direnv allow`..."). Anything else (direnv
    // missing, a failed eval) leaves the server env untouched.
    let stderr = "";
    if (error && typeof error === "object" && "stderr" in error) {
      const value = error.stderr;
      if (typeof value === "string" || Buffer.isBuffer(value)) stderr = String(value);
    }
    return { env: process.env, state: { blocked: /is blocked/.test(stderr), rcPath } };
  }
  let parsed: Record<string, string | null>;
  try {
    parsed = JSON.parse(stdout || "{}") as Record<string, string | null>;
  } catch {
    return { env: process.env, state: { blocked: false, rcPath } };
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(parsed)) {
    if (DIRENV_OWN.test(name)) continue;
    if (value === null) delete env[name];
    else env[name] = value;
  }
  // direnv's bookkeeping may also sit in the server's own environment (a server started from a
  // direnv shell): a spawned agent is not a direnv session, so these never cross over.
  for (const name of Object.keys(env)) if (DIRENV_OWN.test(name)) delete env[name];
  return { env, state: { blocked: false, rcPath } };
}

/**
 * The env for a child about to spawn in dir: the server's env with the tree's
 * direnv diff applied when its .envrc is allowed, unchanged otherwise; the
 * state's `blocked` flags an envrc waiting on a `direnv allow`. Lasts CACHE_MS,
 * or until the .envrc changes on disk.
 */
export function envForSpawn(dir: string): DirenvEnv {
  const rcPath = findEnvrc(dir);
  if (!rcPath) return { env: process.env, state: { blocked: false, rcPath: null } };
  const stamped = stampOf(rcPath);
  const hit = cache.get(dir);
  if (hit && hit.stamp === stamped && Date.now() - hit.at < CACHE_MS) return hit.result;
  const result = probe(dir, rcPath);
  cache.set(dir, { at: Date.now(), stamp: stamped, result });
  return result;
}

/** Allow the tree's .envrc (direnv allow), so the next spawn picks it up. True when direnv took it. */
export function allowEnvrc(dir: string): boolean {
  const rcPath = findEnvrc(dir);
  if (!rcPath) return false;
  try {
    execFileSync("direnv", ["allow", dir], { cwd: dir, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    cache.delete(dir);
    return true;
  } catch {
    return false;
  }
}

/** Test hook: forget every cached answer. */
export function clearDirenvCache(): void {
  cache.clear();
}
