// What kinds of tools a run used, for the card header's icon stack: one chip per
// kind in first-use order, an MCP server counting as a kind of its own, "+N" for
// the rest. Also the monogram and hue an MCP server's chip wears. Pure.
import { awuiOpenCodeFamily } from "../shared/awui-mcp.js";
import type { ChatItem, ToolCategory } from "../shared/protocol.js";
import { toolFacts } from "./tool-facts.js";
import { isPlanCall, orchestrationTool } from "./tool-sentence.js";

export interface ToolKind {
  /** Distinct per kind: the category, or `mcp:<server>`. */
  key: string;
  category: ToolCategory;
  /** The MCP server, for a monogram chip. */
  server?: string;
  /** A command whose output was a test run: it wears the test glyph, and is a kind of its own. */
  test?: boolean;
  /** A todo or plan call: it wears the checklist, and is a kind of its own. */
  plan?: boolean;
}

/** The kind of one call: its MCP server, a test run (a command whose output tool-facts reads as one), else its category. */
export function toolKind(item: Extract<ChatItem, { kind: "tool" }>): ToolKind {
  // A delegation through awui's own surface is an agent call, whichever bridge carried it (the
  // extension's plain names, or the MCP server's `mcp__awui-orchestrate__…`): it wears the agents
  // mark rather than its server's monogram.
  if (orchestrationTool(item.name)) return { key: "agent", category: "agent" };
  // A server's tool, as Claude Code and Codex name them (`mcp__<server>__<tool>`) or as OpenCode
  // does (`<server>_<tool>`); awui's own per-chat servers on OpenCode all read as "awui".
  const server = /^mcp__(.+?)__/.exec(item.name)?.[1] ?? (awuiOpenCodeFamily(item.name) ? "awui" : undefined);
  if (server) return { key: `mcp:${server}`, category: item.category, server };
  // Agents win over the call's own kind: omp's eval spawns them from inside code.
  if (item.subagents) return { key: "agent", category: "agent" };
  if (item.category === "command" && toolFacts(item).kind === "test") return { key: "test", category: "command", test: true };
  if (isPlanCall(item.name, item.plan !== undefined)) return { key: "plan", category: item.category, plan: true };
  return { key: item.category, category: item.category };
}

/** The distinct kinds of tool the items called, in the order each was first used. */
export function toolKinds(items: readonly ChatItem[]): ToolKind[] {
  const seen = new Map<string, ToolKind>();
  for (const item of items) {
    if (item.kind !== "tool") continue;
    const kind = toolKind(item);
    if (!seen.has(kind.key)) seen.set(kind.key, kind);
  }
  return [...seen.values()];
}

/** The chips to draw (at most `max`) and how many kinds are left out. */
export function iconStack(kinds: readonly ToolKind[], max = 3): { shown: ToolKind[]; more: number } {
  return { shown: kinds.slice(0, max), more: Math.max(0, kinds.length - max) };
}

/** An MCP server's chip letters: the first letter, or the first of each of the first two words ("GH" for "git-hub"). */
export function monogram(server: string): string {
  const words = server.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const letters = words.length > 1 ? `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}` : (words[0]?.[0] ?? server[0] ?? "?");
  return letters.toUpperCase();
}

/** A stable hue slot (0 to 3) for a server name; the stylesheet maps each slot onto theme tokens. */
export function serverHue(server: string): number {
  let h = 0;
  for (const ch of server) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h % 4;
}

/** "Used 1 tool", "Used 6 tools". */
export function usedLabel(n: number): string {
  return `Used ${n} ${n === 1 ? "tool" : "tools"}`;
}
