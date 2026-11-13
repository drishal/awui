// Running git for the server (checkpoints, the composer's git status): with
// none of the environment's GIT_* pointing it elsewhere, no prompts, no hooks
// or fsmonitor, and no automatic gc.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export interface GitOptions {
  cwd?: string;
  input?: string | Buffer;
  timeoutMs?: number;
  /** Exit codes that are an answer, not a failure (`diff --no-index` exits 1 when files differ). */
  okExit?: number[];
  /**
   * Variables this one call needs, applied over the hardened set: the environment's own GIT_*
   * never reach git, but a caller may hand one it means (the throwaway index worktreePatch uses).
   */
  env?: Record<string, string>;
}

/** The one runner: every call goes through the same hardening, and the caller picks text or bytes. */
function run(args: string[], opts: GitOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", ...args],
      { cwd: opts.cwd, env: { ...gitEnv(), ...opts.env }, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000, encoding: "buffer" },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (!error || (typeof code === "number" && opts.okExit?.includes(code))) resolve(stdout as Buffer);
        else reject(new Error(stderr.toString("utf8").trim() || error.message));
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

/** Git's text output: for anything a person reads or a parser splits into lines. */
export function git(args: string[], opts: GitOptions = {}): Promise<string> {
  return run(args, opts).then((stdout) => stdout.toString("utf8"));
}

/**
 * Git's raw output, for a patch. A patch is bytes: a Latin-1 or Shift-JIS file's
 * bytes have no UTF-8 meaning, so decoding and re-encoding one would replace
 * them with U+FFFD, and `git apply` would write the corrupted text happily.
 */
export function gitBuffer(args: string[], opts: GitOptions = {}): Promise<Buffer> {
  return run(args, opts);
}

/**
 * The patch a working tree makes against `ref`, untracked files included. A delegated worker
 * must not commit, so its new files stay untracked and a plain `git diff <ref>` leaves them
 * out entirely: an apply built from that patch reports success while dropping exactly the work
 * it was supposed to carry. A throwaway index (GIT_INDEX_FILE) is built from the tree against
 * the ref for this one read, so the tree's own index, status, and visible state are untouched.
 */
export async function worktreePatch(cwd: string, ref: string, diffOptions: string[], opts: GitOptions = {}): Promise<Buffer> {
  const indexFile = path.join(tmpdir(), `awui-patch-${randomUUID()}.index`);
  const indexed: GitOptions = { ...opts, cwd, env: { ...opts.env, GIT_INDEX_FILE: indexFile } };
  try {
    await run(["read-tree", ref], indexed);
    // `--all` records the tree as it stands (deletions too) and respects .gitignore, so an
    // ignored file stays out of the patch exactly as it stayed out of the diff before.
    await run(["add", "--all", "--", "."], indexed);
    return await run(["diff", "--cached", ...diffOptions, ref], indexed);
  } finally {
    await rm(indexFile, { force: true }).catch(() => undefined);
  }
}
