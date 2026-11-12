// Running git for the server (checkpoints, the composer's git status): with
// none of the environment's GIT_* pointing it elsewhere, no prompts, no hooks
// or fsmonitor, and no automatic gc.
import { execFile } from "node:child_process";

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
}

/** The one runner: every call goes through the same hardening, and the caller picks text or bytes. */
function run(args: string[], opts: GitOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "gc.auto=0", ...args],
      { cwd: opts.cwd, env: gitEnv(), maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000, encoding: "buffer" },
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
