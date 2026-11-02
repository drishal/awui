// "Run" on a shell code block in an answer (T3 Code's): one command line, run
// in the chat's project folder by the shell its fence names, with a time
// limit and a cap on what is kept of the output. Any signed-in device may do
// this, as it may already ask the agent to.
//
// The fences that reach here are POSIX shells (bash/sh/zsh/fish — see
// code-blocks.ts); a Windows host has none of those on PATH. runCommand maps
// a request onto what the host actually has: on win32 `sh` runs under cmd and
// `bash` under PowerShell, and the timeout kills the process tree with
// taskkill, since Windows has no process-group signal for this.
import { spawn, spawnSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { IS_WINDOWS } from "./platform-win.js";
import type { RunShell, RunResult } from "../shared/protocol.js";

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 100_000;

const SHELLS: Record<RunShell, string> = { bash: "bash", sh: "sh", zsh: "zsh", fish: "fish" };

/** The interpreter and its one-line flag for a fence's shell on this host. */
function shellFor(shell: RunShell): [string, string] {
  if (IS_WINDOWS) {
    if (shell === "bash") return ["powershell.exe", "-Command"];
    return [process.env.ComSpec ?? "cmd.exe", "/c"]; // sh/zsh/fish all fall to cmd
  }
  return [SHELLS[shell], "-c"];
}

export function runCommand(command: string, shell: RunShell, cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    let output = "";
    let truncated = false;
    let timedOut = false;
    // One decoder per stream: a character split across chunks stays whole.
    const decoders = { out: new StringDecoder("utf8"), err: new StringDecoder("utf8") };
    const take = (decoder: StringDecoder) => (chunk: Buffer) => {
      if (output.length >= MAX_OUTPUT) {
        truncated = true;
        return;
      }
      output += decoder.write(chunk);
      if (output.length > MAX_OUTPUT) {
        output = output.slice(0, MAX_OUTPUT);
        truncated = true;
      }
    };
    const [bin, flag] = shellFor(shell);
    // detached is POSIX-only (it starts a new process group for the group kill
    // below); Windows has no groups here, and the kill goes through taskkill.
    const child = IS_WINDOWS
      ? spawn(bin, [flag, command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] })
      : spawn(bin, [flag, command], { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"], detached: true });
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (child.pid) {
          if (IS_WINDOWS) spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
          else process.kill(-child.pid, signal);
        }
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 2000).unref();
    }, TIMEOUT_MS);
    child.stdout.on("data", take(decoders.out));
    child.stderr.on("data", take(decoders.err));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, output: `${shell}: ${error.message}`, truncated: false, timedOut: false, durationMs: Date.now() - started });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code, output, truncated, timedOut, durationMs: Date.now() - started });
    });
  });
}
