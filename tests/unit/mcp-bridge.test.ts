// `awui mcp`: the orchestration bridge on stdio as a harness config names it, and
// the command that name resolves to. A compiled awui is its own program; from a
// checkout it is the repo's extension file. Without AWUI_ORCH_URL/TOKEN it must
// still answer `initialize`, an empty `tools/list`, and `ping`, and stay up, so a
// harness never reports the entry as a broken server.
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { describe, expect, it } from "vitest";
import { bridgeCommand, mcpBridgeFile } from "../../src/server/mcp-bridge.js";
import { tempDir } from "../helpers/app.js";

describe("awui's own bridge command", () => {
  it("names this checkout's launcher when the PATH has none, and the PATH's awui when it does", () => {
    const launcher = path.resolve(import.meta.dirname, "..", "..", "bin", "awui");
    expect(bridgeCommand({ PATH: tempDir("awui-empty-path-") })).toEqual({ command: launcher, source: "this checkout's bin/awui" });
    expect(bridgeCommand({ PATH: path.dirname(launcher) })).toEqual({ command: launcher, source: "the awui on your PATH" });
  });

  it("resolves to the checkout's orchestration bridge, which answers inertly over stdio", async () => {
    const file = mcpBridgeFile();
    expect(file).not.toBeNull();
    // No AWUI_ORCH_URL/TOKEN: `initialize`, an empty `tools/list`, and `ping` only, so a
    // harness config that names it outside awui is silent rather than broken.
    const child = spawn(process.execPath, [file as string], { env: { PATH: process.env.PATH ?? "" }, stdio: ["pipe", "pipe", "pipe"] });
    const waiting = new Map<number, (message: Answer) => void>();
    readline.createInterface({ input: child.stdout }).on("line", (line) => {
      const message = JSON.parse(line) as Answer;
      waiting.get(message.id)?.(message);
    });
    let id = 0;
    const ask = (method: string) =>
      new Promise<Answer>((resolve) => {
        const mine = ++id;
        waiting.set(mine, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: mine, method, params: {} })}\n`);
      });
    try {
      expect((await ask("initialize")).result?.capabilities).toEqual({ tools: {} });
      expect((await ask("tools/list")).result?.tools).toEqual([]);
      expect((await ask("ping")).result).toEqual({});
      // It stays up: an inert server must not exit, or the harness reports a broken one.
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill();
    }
  });
});

interface Answer {
  id: number;
  result?: { capabilities?: unknown; tools?: unknown[] };
  error?: unknown;
}
