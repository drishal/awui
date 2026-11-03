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
import { execFile, execFileSync } from "node:child_process";
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

/**
 * How long an export is reused. It used to be 5 s, so nearly every harness start paid a
 * full `direnv export` (1.5 s for a devenv project, 10 s cold) on top of its own boot. The
 * stamp below covers what a devenv/flake .envrc is made from, so edits still land at once.
 */
const CACHE_MS = 60_000;
/** A slow .envrc (devenv evaluation) is capped well under a spawn's own cost. */
const TIMEOUT_MS = 15_000;

const cache = new Map<string, { at: number; stamp: string; result: DirenvEnv }>();

/** A blocked .envrc is looked at again soon: `direnv allow` run in a terminal changes nothing the stamp can see. */
const BLOCKED_CACHE_MS = 5_000;

function reusable(hit: { at: number; stamp: string; result: DirenvEnv } | undefined, stamped: string): hit is { at: number; stamp: string; result: DirenvEnv } {
  return hit !== undefined && hit.stamp === stamped && Date.now() - hit.at < (hit.result.state.blocked ? BLOCKED_CACHE_MS : CACHE_MS);
}

/** `direnv status` never evaluates the .envrc (about 2 ms), so its answer can be kept a good while. */
const STATE_CACHE_MS = 30_000;
const stateCache = new Map<string, { at: number; stamp: string; state: DirenvState }>();

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

/** Files beside an .envrc that its environment is evaluated from (devenv and flake projects). */
const RC_INPUTS = ["devenv.nix", "devenv.yaml", "devenv.lock", "flake.nix", "flake.lock", "shell.nix", ".env"];

/** stat's (mtime, size) of the .envrc and the files it is built from, as the change stamp; a missing .envrc is "gone". */
function stampOf(rcPath: string): string {
  try {
    const s = statSync(rcPath);
    let stamp = `${rcPath}:${s.mtimeMs}:${s.size}`;
    const dir = path.dirname(rcPath);
    for (const name of RC_INPUTS) {
      try {
        const input = statSync(path.join(dir, name));
        stamp += `|${name}:${input.mtimeMs}:${input.size}`;
      } catch {
        // not part of this project
      }
    }
    return stamp;
  } catch {
    return "gone";
  }
}

const EXPORT_ARGS = ["export", "json"];

function probe(dir: string, rcPath: string): DirenvEnv {
  if (IS_WINDOWS) return { env: process.env, state: { blocked: false, rcPath } };
  try {
    const stdout = execFileSync("direnv", EXPORT_ARGS, { cwd: dir, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return interpret(stdout, null, rcPath);
  } catch (error) {
    return interpret("", error, rcPath);
  }
}

/** The same probe off the event loop: a devenv .envrc takes seconds, and every chat's stream waits on a blocked loop. */
function probeAsync(dir: string, rcPath: string): Promise<DirenvEnv> {
  if (IS_WINDOWS) return Promise.resolve({ env: process.env, state: { blocked: false, rcPath } });
  return new Promise((resolve) => {
    execFile("direnv", EXPORT_ARGS, { cwd: dir, timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
      resolve(error ? interpret("", Object.assign(error, { stderr }), rcPath) : interpret(stdout, null, rcPath));
    });
  });
}

/** What `direnv export json` said, as the spawn env and the blocked state. */
function interpret(stdout: string, failure: unknown, rcPath: string): DirenvEnv {
  if (failure) {
    // The one failure that means something to the user: an .envrc direnv will not run yet
    // ("direnv: error <path>/.envrc is blocked. Run `direnv allow`..."). Anything else (direnv
    // missing, a failed eval) leaves the server env untouched.
    let stderr = "";
    if (typeof failure === "object" && failure !== null && "stderr" in failure) {
      const value = failure.stderr;
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
 * Only the "is it blocked?" half of envForSpawn, for listings (the sidebar, a workspace's
 * info): `direnv status --json` reads the allow files and never evaluates the .envrc, where
 * `direnv export` runs it (a devenv one takes a second or more, and the call blocks the loop).
 * foundRC.allowed is 0 allowed, 1 not allowed yet, 2 denied; both of the latter block an export.
 */
export function direnvState(dir: string): DirenvState {
  const rcPath = findEnvrc(dir);
  if (!rcPath) return { blocked: false, rcPath: null };
  const stamped = stampOf(rcPath);
  const hit = stateCache.get(dir);
  if (hit && hit.stamp === stamped && Date.now() - hit.at < STATE_CACHE_MS) return hit.state;
  let state: DirenvState = { blocked: false, rcPath };
  if (!IS_WINDOWS) {
    try {
      const out = execFileSync("direnv", ["status", "--json"], { cwd: dir, timeout: 5_000, maxBuffer: 1024 * 1024, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const found = (JSON.parse(out) as { state?: { foundRC?: { allowed?: number } | null } }).state?.foundRC;
      // No foundRC (or direnv missing, or an older direnv without --json) leaves it unblocked, like probe().
      state = { blocked: typeof found?.allowed === "number" && found.allowed !== 0, rcPath };
    } catch {
      // keep the unblocked default
    }
  }
  stateCache.set(dir, { at: Date.now(), stamp: stamped, state });
  return state;
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
  if (reusable(hit, stamped)) return hit.result;
  const result = probe(dir, rcPath);
  cache.set(dir, { at: Date.now(), stamp: stamped, result });
  return result;
}

const preparing = new Map<string, Promise<void>>();

/**
 * Fill envForSpawn's cache for dir without blocking the event loop. Callers that are about
 * to start a harness await this first; the synchronous spawn that follows then finds the
 * answer cached instead of running the export itself. Never rejects.
 */
export function prepareSpawnEnv(dir: string): Promise<void> {
  const rcPath = findEnvrc(dir);
  if (!rcPath) return Promise.resolve();
  const stamped = stampOf(rcPath);
  if (reusable(cache.get(dir), stamped)) return Promise.resolve();
  let pending = preparing.get(dir);
  if (!pending) {
    pending = probeAsync(dir, rcPath)
      .then((result) => {
        cache.set(dir, { at: Date.now(), stamp: stamped, result });
      })
      .catch(() => undefined)
      .finally(() => {
        preparing.delete(dir);
      });
    preparing.set(dir, pending);
  }
  return pending;
}

/** Allow the tree's .envrc (direnv allow), so the next spawn picks it up. True when direnv took it. */
export function allowEnvrc(dir: string): boolean {
  const rcPath = findEnvrc(dir);
  if (!rcPath) return false;
  try {
    execFileSync("direnv", ["allow", dir], { cwd: dir, timeout: 10_000, stdio: ["ignore", "pipe", "pipe"] });
    cache.clear();
    // One allow can cover several folders under the same .envrc.
    stateCache.clear();
    return true;
  } catch {
    return false;
  }
}

/** Test hook: forget every cached answer. */
export function clearDirenvCache(): void {
  cache.clear();
  stateCache.clear();
}
