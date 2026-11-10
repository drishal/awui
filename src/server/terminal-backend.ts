// Native PTY process selected for the actual server runtime. Source Node uses
// node-pty's supplied native binding; Bun compiles with Bun.Terminal instead of
// risky external CJS and .node loaders. This isn't a command execution API.
/// <reference types="bun-types/bun.d.ts" />
import type { IDisposable } from "@lydell/node-pty";
import type * as NodePty from "@lydell/node-pty";
import type { Terminal as BunTerminal } from "bun";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** TerminalManager's process surface; Node's native object is compatible. */
export interface ProjectPty {
  readonly pid: number;
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

// PTYs use node-pty's package in source mode; Bun's compile selects native Bun.Terminal.
/** Avoid Bun.execPath being used as a CJS namespace instead of a JS filename. */
function requiredBackend<T>(id: string): T {
  const parent = process.versions.bun ? pathToFileURL(path.join(path.dirname(process.execPath), "package.js")) : import.meta.url;
  return createRequire(parent)(id) as T;
}

export function spawnPty(file: string, options: Parameters<typeof NodePty.spawn>[2]): ProjectPty {
  if (!process.versions.bun) {
    const child = requiredBackend<typeof NodePty>("@lydell/node-pty").spawn(file, [], options);
    return {
      pid: child.pid,
      onData: (listener) => child.onData(listener),
      onExit: (listener) => child.onExit(listener),
      write: (data) => child.write(data),
      resize: (cols, rows) => child.resize(cols, rows),
      kill: () => child.kill(),
    };
  }
  if (process.platform === "win32") throw new Error("The compiled terminal needs a native Bun.ConPTY provider on Windows");
  const decoder = new TextDecoder();
  const listeners = new Set<(data: string) => void>();
  const exits = new Set<(event: { exitCode: number; signal?: number }) => void>();
  const terminal = new Bun.Terminal({
    name: options.name,
    cols: options.cols ?? 80,
    rows: options.rows ?? 24,
    data: (_terminal: BunTerminal, data: Uint8Array) => { for (const listener of listeners) listener(decoder.decode(data)); },
  });
  const child = Bun.spawn([file], { terminal, detached: true, cwd: options.cwd, env: options.env });
  void child.exited.then((exitCode: number) => {
    for (const listener of exits) listener({ exitCode, signal: typeof child.signalCode === "number" ? child.signalCode : undefined });
  });
  return {
    pid: child.pid,
    onData: (listener) => { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
    onExit: (listener) => { exits.add(listener); return { dispose: () => exits.delete(listener) }; },
    write: (data) => terminal.write(data),
    resize: (cols, rows) => terminal.resize(cols, rows),
    kill: () => { if (!terminal.closed) terminal.close(); child.kill(); },
  };
}
