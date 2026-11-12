// awui's own tools inside an OpenCode chat. OpenCode has no extension API, but its server
// registers MCP servers at runtime: `PUT /api/experimental/mcp/:server` with a `local`
// config (a command, its environment, and `codemode: false` so its tools stay top-level
// tools instead of entries inside Code Mode's `execute`), the project as
// `?location[directory]=<cwd>`, and DELETE to take one away. awui registers its render and
// orchestration bridges that way — one pair per chat, named `awui-r-<id>`/`awui-o-<id>`
// (src/shared/awui-mcp.ts) — and never reads or writes the user's opencode.json: the user's
// own MCP servers keep loading beside ours. Because every OpenCode chat in one project
// shares one server, and so one MCP set, the chat also carries session permission rules:
// deny `awui-*` then allow its own servers, and the rule check is last-match-wins, so no
// chat can call another chat's tools with another chat's token.
//
// Checked against OpenCode 2.2.7: the add answers 204 and `/api/mcp` then lists the server
// as connected; a server's tool arrives as `<sanitized server>_<sanitized tool>`; a
// session's `permissions` are glob rules on the action (that tool name) and resource, and
// `PATCH /api/session/:id` stores them where a later read shows them again.
import { createHash } from "node:crypto";
import { awuiMcpServerName, AWUI_MCP_SERVER_PREFIX, type AwuiToolFamily } from "../../shared/awui-mcp.js";
import { nodeForMcpServers, orchestrateMcpServer, renderHtmlMcpServer } from "./render-extension.js";

/** One MCP server registered for a chat. */
export interface OpenCodeToolServer {
  name: string;
  config: { type: "local"; command: string[]; environment: Record<string, string>; codemode: false };
}

/** A session permission rule, as OpenCode stores one: a glob on the action (the tool name) and resource. */
export interface OpenCodeRule {
  action: string;
  resource: string;
  effect: "allow" | "deny";
}

export interface OpenCodeTools {
  servers: OpenCodeToolServer[];
  /** Deny every awui server, then allow this chat's own: last match wins, so the order is the meaning. */
  rules: OpenCodeRule[];
}

/**
 * This chat's id, as its server names use it: a hash of its own tokens. Never the token
 * itself — a server name becomes part of every tool name, and tool names reach the model,
 * the transcript, and the provider.
 */
function chatId(env: NodeJS.ProcessEnv): string {
  return createHash("sha256").update(`${env.AWUI_RENDER_TOKEN ?? ""}\n${env.AWUI_ORCH_TOKEN ?? ""}`).digest("hex").slice(0, 16);
}

/**
 * The tool servers a chat was given, or null when it has neither family or no Node to run a
 * bridge. Each family is wired only by its own two variables, exactly as the other
 * harnesses' spawn wiring is: `render_html` never appears for a chat without a render
 * endpoint and token, nor the orchestration tools without theirs.
 */
export function openCodeTools(toolEnv?: NodeJS.ProcessEnv): OpenCodeTools | null {
  if (!toolEnv) return null;
  const node = nodeForMcpServers();
  if (!node) return null;
  const id = chatId(toolEnv);
  const servers: OpenCodeToolServer[] = [];
  const add = (family: AwuiToolFamily, file: string | null, environment: Record<string, string>): void => {
    if (!file) return;
    servers.push({ name: awuiMcpServerName(family, id), config: { type: "local", command: [node, file], environment, codemode: false } });
  };
  const render = renderHtmlMcpServer();
  if (render && toolEnv.AWUI_RENDER_URL && toolEnv.AWUI_RENDER_TOKEN) {
    add("render", render, { AWUI_RENDER_URL: toolEnv.AWUI_RENDER_URL, AWUI_RENDER_TOKEN: toolEnv.AWUI_RENDER_TOKEN });
  }
  const orchestrate = orchestrateMcpServer();
  if (orchestrate && toolEnv.AWUI_ORCH_URL && toolEnv.AWUI_ORCH_TOKEN) {
    add("orchestrate", orchestrate, { AWUI_ORCH_URL: toolEnv.AWUI_ORCH_URL, AWUI_ORCH_TOKEN: toolEnv.AWUI_ORCH_TOKEN });
  }
  if (servers.length === 0) return null;
  return {
    servers,
    rules: [
      { action: `${AWUI_MCP_SERVER_PREFIX}*`, resource: "*", effect: "deny" },
      ...servers.map((server): OpenCodeRule => ({ action: `${server.name}_*`, resource: "*", effect: "allow" })),
    ],
  };
}

/** Whether a permission rule is one awui wrote for a chat's tool servers, so a reuse replaces it instead of growing the list. */
export function isAwuiRule(rule: unknown): boolean {
  return typeof rule === "object" && rule !== null && typeof (rule as { action?: unknown }).action === "string" && (rule as { action: string }).action.startsWith(AWUI_MCP_SERVER_PREFIX);
}
