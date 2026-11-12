// awui's own agent tools as OpenCode's MCP naming writes them. OpenCode has no extension
// API, so render_html and the orchestration tools reach an OpenCode chat as two MCP servers
// registered at runtime on its shared server (harness/opencode-tools.ts). OpenCode exposes a
// registered server's tool as `<sanitized server>_<sanitized tool>` — the server is the tool's
// namespace, joined to the tool's own name by "_" (McpTool in OpenCode 2.2, which also
// refuses a name over 64 characters) — and checks permissions against that same name. This
// file is the one definition of that naming: the adapter registers under it, and the code
// that recognizes awui's calls (render-token.ts on the server, tool-sentence.ts and
// tool-kinds.ts in the web UI, atui, and the Tern client) matches the same shape.

/** Every server awui registers on OpenCode's shared server starts with this, so one deny rule covers them all. */
export const AWUI_MCP_SERVER_PREFIX = "awui-";

/** The two families of tool awui gives a chat: the render tool, and the orchestration tools. */
export type AwuiToolFamily = "render" | "orchestrate";

// One letter keeps the longest name (`awui-o-<id>_delegate_task`) far under OpenCode's 64.
const FAMILY_LETTER: Record<AwuiToolFamily, string> = { render: "r", orchestrate: "o" };

/** An id is what a chat's tokens hash to: lowercase hex, so a server name needs no sanitizing. */
const ID = /^[a-z0-9]+$/;

/** One chat's server for one tool family: `awui-r-<id>` or `awui-o-<id>`. */
export function awuiMcpServerName(family: AwuiToolFamily, id: string): string {
  return `${AWUI_MCP_SERVER_PREFIX}${FAMILY_LETTER[family]}-${id}`;
}

/**
 * The bare tool name when `name` is one of awui's tools as OpenCode writes it
 * (`awui-r-<id>_render_html`), and undefined for anything else: another chat's server, a
 * user's own MCP server, or a plain tool of the agent's.
 */
export function awuiOpenCodeTool(name: string, family: AwuiToolFamily): string | undefined {
  const prefix = `${AWUI_MCP_SERVER_PREFIX}${FAMILY_LETTER[family]}-`;
  if (!name.startsWith(prefix)) return undefined;
  const at = name.indexOf("_", prefix.length);
  if (at < 0 || !ID.test(name.slice(prefix.length, at))) return undefined;
  return name.slice(at + 1) || undefined;
}

/** The family a name belongs to when it is one of awui's OpenCode tools, or undefined for anything else. */
export function awuiOpenCodeFamily(name: string): AwuiToolFamily | undefined {
  return awuiOpenCodeTool(name, "render") !== undefined ? "render" : awuiOpenCodeTool(name, "orchestrate") !== undefined ? "orchestrate" : undefined;
}
