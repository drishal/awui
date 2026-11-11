// A routine's precheck: one shell command in the routine's project, run before a
// due run has a chat. It is the server's answer to "only run when there is work",
// so a non-zero exit, a timeout, or a shell that cannot start skips the slot
// instead of starting an agent on nothing. The command is the user's own line,
// handed to the host's shell as one argument, and it sees the same environment a
// harness spawned in that project sees (direnv's export included — run-command.ts).
import { runShellCommand } from "./run-command.js";

/** Long enough for a git or test probe, short enough that a hung one cannot hold the tick. */
export const PRECHECK_TIMEOUT_MS = 30_000;
/** Only a line or two reaches the list, so the spawn keeps no more than this. */
const MAX_OUTPUT = 4_000;
/** The detail the list shows: one line of what the command said. */
const MAX_DETAIL = 200;

/** What a precheck decided: run the routine as usual, or skip this slot (detail says why). */
export interface PrecheckResult {
  ok: boolean;
  /** For a skip: the exit code, or the timeout or spawn failure in words. */
  detail: string | null;
}

/** The first non-empty line of the output, bounded, for the detail. */
function firstLine(output: string): string {
  const line = output
    .split("\n")
    .map((text) => text.trim())
    .find((text) => text.length > 0);
  if (!line) return "";
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL)}…` : line;
}

/** What the command's exit says, in the words the list shows. */
function describeExit(exitCode: number, output: string): string {
  const line = firstLine(output);
  return line ? `precheck exited ${exitCode}: ${line}` : `precheck exited ${exitCode}`;
}

/** How long the limit was, in the words the list shows: "30 s", or "250 ms" for a test's short one. */
function limitWords(ms: number): string {
  return ms >= 1000 ? `${Math.round(ms / 1000)} s` : `${ms} ms`;
}

/**
 * Run `command` in `cwd`; ok only on exit 0. A timeout or a spawn failure is a skip
 * too, with its reason: an unhealthy guard must not turn into a launched chat.
 * `timeoutMs` is a parameter so a test can watch a `sleep` be cut short.
 */
export async function runPrecheck(command: string, cwd: string, timeoutMs = PRECHECK_TIMEOUT_MS): Promise<PrecheckResult> {
  const result = await runShellCommand(command, cwd, { timeoutMs, maxOutput: MAX_OUTPUT });
  if (result.timedOut) return { ok: false, detail: `precheck timed out after ${limitWords(timeoutMs)}` };
  if (result.exitCode === null) return { ok: false, detail: `precheck could not start: ${firstLine(result.output) || "no shell"}` };
  if (result.exitCode !== 0) return { ok: false, detail: describeExit(result.exitCode, result.output) };
  return { ok: true, detail: null };
}
