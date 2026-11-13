// The agent tools awui injects into its harness children, and the files that carry
// them. render_html: extensions/render-html.ts, which awui's Pi and omp children load
// with -e; it registers an agent tool which POSTs a self-contained HTML page to the
// chat's render endpoint and returns the page's id in the tool result's `details`, so
// the adapter can attach it to the tool card. The orchestration tools
// (extensions/orchestrate.ts) reach the same Pi and omp children the same way. Claude
// Code, Codex, and DSH have no extension API; they get both families from awui's MCP
// servers instead (extensions/*-mcp.mjs). Every extension activates only when the child
// was spawned with its own two variables, so loading one anywhere else registers
// nothing.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractedExtensionPath } from "../embedded.js";
import { ORCH_INSTRUCTIONS } from "../orchestration/tools.js";

export const RENDER_TOOL_NAME = "render_html";

let found: string | null | undefined;

/** The render_html extension file: the materialized embedded copy in the binary, else the repo path found by walking up. */
export function renderHtmlExtension(): string | null {
  if (found !== undefined) return found;
  const embedded = extractedExtensionPath("render-html.ts");
  if (embedded !== null) return (found = embedded);
  found = null;
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "extensions", "render-html.ts");
    if (existsSync(file)) return (found = file);
    if (path.dirname(dir) === dir) return found;
  }
}

/** The CLI arguments that load it, or none when it is missing. */
export function renderHtmlExtensionArgs(): string[] {
  const file = renderHtmlExtension();
  return file ? ["-e", file] : [];
}

let foundMcp: string | null | undefined;

/** The render_html MCP server (for Claude Code): embedded copy in the binary, else the repo path. */
export function renderHtmlMcpServer(): string | null {
  if (foundMcp !== undefined) return foundMcp;
  const embedded = extractedExtensionPath("render-html-mcp.mjs");
  if (embedded !== null) return (foundMcp = embedded);
  foundMcp = null;
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "extensions", "render-html-mcp.mjs");
    if (existsSync(file)) return (foundMcp = file);
    if (path.dirname(dir) === dir) return foundMcp;
  }
}

let foundEval: string | null | undefined;

/** The eval_python extension file (scratch-dir Python for the awui chat surface): embedded copy in the binary, else the repo path. */
export function evalPythonExtension(): string | null {
  if (foundEval !== undefined) return foundEval;
  const embedded = extractedExtensionPath("eval-python.ts");
  if (embedded !== null) return (foundEval = embedded);
  foundEval = null;
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "extensions", "eval-python.ts");
    if (existsSync(file)) return (foundEval = file);
    if (path.dirname(dir) === dir) return foundEval;
  }
}

/** The CLI arguments that load eval_python, or none when it is missing. */
export function evalPythonExtensionArgs(): string[] {
  const file = evalPythonExtension();
  return file ? ["-e", file] : [];
}

/** The MCP server name Claude Code, Codex, and DSH are given for the orchestration tools, beside render_html's `awui`. */
export const ORCH_MCP_SERVER = "awui-orchestrate";

let foundOrch: string | null | undefined;
let foundOrchMcp: string | null | undefined;

/** The walk up from this module for one of the repo's extensions/ files, when the binary embedded no copy of it. */
function findExtensionFile(name: string): string | null {
  for (let dir = path.dirname(fileURLToPath(import.meta.url)); ; dir = path.dirname(dir)) {
    const file = path.join(dir, "extensions", name);
    if (existsSync(file)) return file;
    if (path.dirname(dir) === dir) return null;
  }
}

/** The orchestration extension file: the materialized embedded copy in the binary, else the repo path. */
export function orchestrateExtension(): string | null {
  if (foundOrch !== undefined) return foundOrch;
  return (foundOrch = extractedExtensionPath("orchestrate.ts") ?? findExtensionFile("orchestrate.ts"));
}

/**
 * The CLI arguments that load the orchestration tools, or none when the extension is missing
 * or the child was not given a token: a chat without one has no tools to call, so the
 * extension would only load to register nothing.
 */
export function orchestrateExtensionArgs(toolEnv?: NodeJS.ProcessEnv): string[] {
  if (!toolEnv?.AWUI_ORCH_TOKEN) return [];
  const file = orchestrateExtension();
  return file ? ["-e", file] : [];
}

/**
 * What a child is told about awui's orchestration tools in its own instructions, or undefined when it has
 * none to call (no token). For a harness that neither lists an extension tool's guideline (omp) nor shows
 * an MCP server's instructions (Codex): Claude Code, OpenCode and Grok show the MCP server's, Pi takes the
 * extension's guideline, so those get no second copy.
 */
export function orchestrationInstructionsFor(toolEnv?: NodeJS.ProcessEnv): string | undefined {
  return toolEnv?.AWUI_ORCH_URL && toolEnv.AWUI_ORCH_TOKEN ? ORCH_INSTRUCTIONS : undefined;
}

/** The orchestration MCP server (for Claude Code, Codex, and DSH): embedded copy in the binary, else the repo path. */
export function orchestrateMcpServer(): string | null {
  if (foundOrchMcp !== undefined) return foundOrchMcp;
  return (foundOrchMcp = extractedExtensionPath("orchestrate-mcp.mjs") ?? findExtensionFile("orchestrate-mcp.mjs"));
}

/**
 * An absolute Node to run awui's MCP server files, or null when there is none. A
 * compiled awui binary is Bun, not Node, so the Node on PATH runs them there.
 */
export function nodeForMcpServers(): string | null {
  if (!process.versions.bun) return process.execPath;
  const names = process.platform === "win32" ? ["node.exe", "node"] : ["node"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
