// Native-Windows support. One home for every decision that differs between
// POSIX and a native Windows host (process.platform === "win32"), so the rest
// of the server never branches on process.platform itself.
//
// Why the branches exist:
//  - Node's spawn() runs only native executables on Windows. An npm-installed
//    CLI (pi, claude) is a `<name>.cmd` batch file in the npm prefix, which
//    CreateProcess rejects with EINVAL since Node's CVE-2024-27980 fix unless
//    a shell interprets it. Native binaries (omp.exe, bun.exe, git.exe, python)
//    spawn directly. So only a command that on win32 spells a `.cmd`/`.bat` is
//    wrapped in the command interpreter; everything else is spawned as-is.
//  - There is no SIGTERM/SIGKILL on Windows. child.kill() maps to
//    TerminateProcess for a direct child, but a `.cmd` shim spawns the real
//    node.exe below it and TerminateProcess on the shim leaves that tree alive.
//    `taskkill /PID <pid> /T /F` kills the whole tree, matching the ladder.
//  - XDG base dirs (~/.config, ~/.local/state) are POSIX, and Windows shells
//    are cmd/PowerShell, not bash/sh/zsh/fish.
import { execFile, spawn, spawnSync, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import { accessSync } from "node:fs";
import path from "node:path";
import { envForSpawn } from "./direnv.js";

export const IS_WINDOWS = process.platform === "win32";

/** Where user settings live by default: XDG_CONFIG_HOME always wins, then the platform base. */
function configBase(env: NodeJS.ProcessEnv, home: string): string {
  if (env.XDG_CONFIG_HOME) return env.XDG_CONFIG_HOME;
  if (IS_WINDOWS) return env.APPDATA ?? path.join(home, "AppData", "Roaming");
  return path.join(home, ".config");
}

/** Where running state lives by default: XDG_STATE_HOME always wins, then the platform base. */
function stateBase(env: NodeJS.ProcessEnv, home: string): string {
  if (env.XDG_STATE_HOME) return env.XDG_STATE_HOME;
  if (IS_WINDOWS) return env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  return path.join(home, ".local", "state");
}

/** Default awui config dir (~/.config/awui, or %APPDATA%\awui). */
export function defaultConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(configBase(env, home), "awui");
}

/** Default awui state dir with the platform base (~/.local/state/awui, or %LOCALAPPDATA%\awui). */
export function defaultStateDir(env: NodeJS.ProcessEnv, home: string): string {
  return path.join(stateBase(env, home), "awui");
}

/** cmd.exe's metacharacters, each escaped with a caret (cross-spawn's set). */
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/** The shim's path on a cmd line: every metacharacter (spaces too) caret-escaped, no quotes. */
function cmdCommand(command: string): string {
  return command.replace(CMD_META, "^$1");
}

/**
 * One argument on a cmd line that runs an npm `.cmd` shim, the way cross-spawn
 * escapes it. First the C runtime's rules, which the node.exe at the end of the
 * shim parses with: backslashes before a quote or the end are doubled and an
 * inner quote becomes \". Then every cmd metacharacter is caret-escaped, and
 * escaped again, because the shim hands its arguments on through `%*`, which
 * cmd reads a second time. Quoting alone is not enough: cmd takes no backslash
 * escape and expands %VAR% inside quotes, so a path holding `&` or `%` would
 * otherwise break the line or run part of it.
 */
function cmdArg(arg: string): string {
  const quoted = `"${arg.replace(/(?=(\\+?)?)\1"/g, '$1$1\\"').replace(/(?=(\\+?)?)\1$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

/** The `cmd /d /s /c` argv that runs a batch shim: /s strips the outer quotes and runs the line inside verbatim. */
function cmdLine(shim: string, args: string[]): [string, string[]] {
  const line = [cmdCommand(shim), ...args.map(cmdArg)].join(" ");
  return [process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", `"${line}"`]];
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** cmd.exe escaping, exported for tests. */
export { cmdArg, cmdCommand };

/**
 * On Windows, turn the command the adapters were given into what Node can
 * actually start plus the interpreter prefix.
 *
 * A POSIX run is unchanged. On Windows:
 *  - a command spelled as a path or with an explicit extension spawns as-is
 *    (omp.exe) or, if it is a `.cmd`/`.bat`, through `cmd /d /s /c`;
 *  - a bare name (`pi`, `claude`) is searched on PATH with the batch-shim
 *    extensions first. npm-global CLIs install only a `.cmd` beside a POSIX
 *    launch script with no extension; that bare `pi` file is not executable by
 *    CreateProcess, so we prefer `<dir>\pi.cmd` and wrap it in cmd. A native
 *    `.exe` (omp) is found without an extension by libuv, so it stays as-is.
 *
 * Returns `[argv0, prefix]` where argv0 is what to spawn and prefix is any
 * leading args (the cmd switches + built line) before the caller's real args.
 * Exported for tests.
 */
export function resolveWin(command: string, args: string[]): [string, string[]] {
  const hasSep = /[/\\]/.test(command) || /^[A-Za-z]:/.test(command);
  if (hasSep || /\.[A-Za-z0-9]+$/.test(command)) {
    // Explicit path or extension: .cmd/.bat need the interpreter, .exe runs bare.
    if (/\.(cmd|bat)$/i.test(command)) return cmdLine(command, args);
    return [command, []];
  }
  // Bare name: prefer the .cmd shim, since that is what npm writes on Windows.
  const pathExt = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toUpperCase());
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const ext of [".CMD", ".BAT"].filter((e) => pathExt.includes(e))) {
      const shim = path.join(dir, command + ext);
      try {
        accessSync(shim);
        return cmdLine(shim, args);
      } catch {
        /* not here */
      }
    }
  }
  // No .cmd shim on PATH: leave the name to libuv (finds a native .exe).
  return [command, []];
}

/**
 * The spawn site for every harness child. On POSIX this is spawn() unchanged,
 * with the project's direnv diff applied: a .envrc the user allowed (in the
 * child's cwd or a parent) gives the harness the same environment a terminal
 * there would. The caller's own env wins over the diff; process.env feeds both.
 * On Windows a bare npm CLI (pi, claude) resolves to its `.cmd` shim and runs
 * through the command interpreter, since CreateProcess cannot execute a batch
 * file directly; a native `.exe` (omp) or an explicit path spawns as-is.
 */
export function spawnHarness(command: string, args: string[], opts: SpawnOptions): ChildProcessWithoutNullStreams {
  if (!IS_WINDOWS) {
    // direnv is POSIX-first; on Windows there is nothing to merge.
    const dir = typeof opts.cwd === "string" ? opts.cwd : process.cwd();
    opts = { ...opts, env: { ...envForSpawn(dir).env, ...(opts.env ?? {}) } };
  }
  if (IS_WINDOWS) {
    const [argv0, prefix] = resolveWin(command, args);
    // resolveWin already folded the real args into the cmd line when it wrapped. That line is escaped for cmd
    // already, so Node must pass it verbatim: its own quoting would wrap it again and /s would strip the wrong quotes.
    if (prefix.length > 0) return spawn(argv0, prefix, { ...opts, windowsVerbatimArguments: true }) as ChildProcessWithoutNullStreams;
    return spawn(argv0, args, opts) as ChildProcessWithoutNullStreams;
  }
  return spawn(command, args, opts) as ChildProcessWithoutNullStreams;
}

/**
 * The version/discovery probe counterpart to spawnHarness: the adapters run
 * `execFile(cli, ["--version"])` to decide a harness is installed, which hits
 * the same Windows batch-shim EINVAL. Same shell-only-for-.cmd rule.
 */
export function execHarness(
  command: string,
  args: string[],
  opts: { timeout?: number; env?: NodeJS.ProcessEnv; maxBuffer?: number },
): Promise<ExecResult> {
  let resolve!: (r: ExecResult) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<ExecResult>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const finish = (error: Error | null, stdout: string, stderr: string) => {
    if (error) reject(error);
    else resolve({ stdout, stderr });
  };
  if (IS_WINDOWS) {
    const [argv0, prefix] = resolveWin(command, args);
    // A wrapped line is already escaped for cmd: Node passes it verbatim (see spawnHarness).
    execFile(argv0, prefix.length > 0 ? prefix : args, { encoding: "utf8", ...opts, ...(prefix.length > 0 ? { windowsVerbatimArguments: true } : {}) }, finish);
    return promise;
  }
  execFile(command, args, { encoding: "utf8", ...opts }, finish);
  return promise;
}

/**
 * Kill a harness child and, on Windows, its whole tree. POSIX is the caller's
 * SIGTERM→SIGKILL ladder. Windows has no signals for this, and a batch shim's
 * real process sits below the shim, so the tree kill goes through taskkill.
 */
export function killChildTree(child: ChildProcessWithoutNullStreams): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (IS_WINDOWS) {
    try {
      spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
      return; // taskkill is the tree kill; nothing further to escalate to
    } catch {
      /* fall through to a direct kill */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

/** One graceful stop, portable: the caller's timer escalates to killChildTree. */
export function terminateHarnessChild(child: ChildProcessWithoutNullStreams): void {
  if (child.pid === undefined) return;
  try {
    // On Windows child.kill() is TerminateProcess for a native child; for a
    // batch shim it ends only the shim, so the escalation timer must reach the
    // tree (killChildTree), which is why it is the ladder's second rung.
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
}
