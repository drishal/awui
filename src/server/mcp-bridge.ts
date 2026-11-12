// `awui mcp`: awui's orchestration MCP server on this process's stdio, for a
// harness whose own config names a program rather than letting awui pass the
// server per chat. Every other harness is handed the bridge (or awui's HTTP MCP
// endpoint) by its adapter at spawn; Hermes mounts MCP servers from its own
// config, so its one-time entry names this command.
//
// The bridge is `extensions/orchestrate-mcp.mjs`, never a second copy: from a
// checkout that file runs as-is, and in the compiled binary its embedded source
// does, imported through a data URL because a binary has no Node to spawn it
// with. Without AWUI_ORCH_URL and AWUI_ORCH_TOKEN it answers `initialize`,
// an empty `tools/list`, and `ping`, so the entry sits inert in a user's
// harness config outside awui instead of reporting a broken server.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { embeddedExtensionSource, isEmbedded } from "./embedded.js";
import { orchestrateMcpServer } from "./harness/render-extension.js";

/** The bridge as a file on disk: the checkout's extensions/ copy, or the binary's materialized one. */
export function mcpBridgeFile(): string | null {
  return orchestrateMcpServer();
}

/** awui's own command for a harness config, and where it was found (so the report can say which). */
export interface BridgeCommand {
  command: string;
  /** "this binary", "the awui on your PATH", … */
  source: string;
}

/** awui's own command for a harness config: this binary, else the `awui` on the PATH, else this checkout's. */
export function bridgeCommand(env: NodeJS.ProcessEnv = process.env): BridgeCommand | null {
  // A compiled awui is its own program: nothing else on this machine is that build.
  if (isEmbedded) return { command: process.execPath, source: "this binary" };
  for (const dir of (env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of process.platform === "win32" ? ["awui.exe", "awui"] : ["awui"]) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return { command: candidate, source: "the awui on your PATH" };
    }
  }
  // A checkout that was never linked: its own launcher is still a runnable command.
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "bin", "awui");
    if (existsSync(file)) return { command: file, source: "this checkout's bin/awui" };
    if (path.dirname(dir) === dir) return null;
  }
}

/**
 * Run the bridge on this process's stdio until the client closes it. The module
 * is the whole program: it reads stdin lines, answers on stdout, and ends with
 * the stream, so nothing here has to be cleaned up.
 */
export async function runMcpBridge(): Promise<void> {
  const file = mcpBridgeFile();
  if (file !== null) {
    await import(pathToFileURL(file).href);
    return;
  }
  const source = embeddedExtensionSource("orchestrate-mcp.mjs");
  if (source === null) throw new Error("the orchestration MCP bridge is missing: no extensions/orchestrate-mcp.mjs and no copy in this binary");
  await import(`data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`);
}
