// The render tool's names and the normalization of its result into the
// reference a tool card carries. Three call shapes register it: the extension
// (Pi/omp) names it plain `render_html`; awui's MCP server
// (extensions/render-html-mcp.mjs) serves it to Claude Code, which calls it
// `mcp__awui__render_html`; and the omp session's built-in `xd://...` device
// (what this agent sees as `write xd://render_html`) runs it as a WRITE with
// that device path in its args. Its result's `details.htmlRender` holds
// { id, title, height }; only one of those exact shapes may carry it, so a
// result that imitates the shape without going through the render tool does
// not publish a page. An MCP result has no details: the MCP server puts the
// reference on its output's last line, which the adapter lifts off
// (splitRenderMarker). Live (chat.ts) and history (agent-events.ts) both read
// the reference through here so they agree.
import { HTML_RENDER_MAX_HEIGHT, HTML_RENDER_MIN_HEIGHT, type HtmlRenderRef } from "../../shared/protocol.js";
import { htmlRenderTitle } from "../../shared/html-render.js";
import { ORCH_TOOLS } from "../orchestration/tools.js";
import { ORCH_MCP_SERVER, RENDER_TOOL_NAME } from "./render-extension.js";

/** The MCP server Claude Code is given. */
export const HTML_RENDER_MCP_SERVER = "awui";
/** The MCP tool as Claude Code names it (mcp__<server>__<tool>); Pi and omp's extension registers plain `render_html`. */
export const HTML_RENDER_MCP_TOOL = `mcp__${HTML_RENDER_MCP_SERVER}__${RENDER_TOOL_NAME}`;
/**
 * The orchestration tools as an MCP client names them (`mcp__awui-orchestrate__<tool>`),
 * from the catalogue itself so the allow list cannot drift from what is served.
 */
export function orchestrationMcpToolNames(): string[] {
  return ORCH_TOOLS.map((tool) => `mcp__${ORCH_MCP_SERVER}__${tool.name}`);
}

/** The same tool as other MCP clients write it. */
const HTML_RENDER_MCP_DOTTED = `${HTML_RENDER_MCP_SERVER}.${RENDER_TOOL_NAME}`;

/** What starts the MCP server's line carrying the page's reference. */
export const RENDER_MARKER = "awui-html-render:";

/**
 * An MCP render result's text, the reference line taken off: the text the
 * card shows, and the details that line carried ({ htmlRender }), or none.
 * Only a render call's details are read (htmlRenderFromDetails), so a marker
 * printed by anything else publishes nothing.
 */
export function splitRenderMarker(output: string): { text: string; details?: { htmlRender: unknown } } {
  const at = output.lastIndexOf(`\n${RENDER_MARKER}`);
  const start = at >= 0 ? at + 1 : output.startsWith(RENDER_MARKER) ? 0 : -1;
  if (start < 0) return { text: output };
  const line = output.slice(start + RENDER_MARKER.length).split("\n")[0] ?? "";
  try {
    return { text: output.slice(0, Math.max(0, start - 1)).trimEnd(), details: { htmlRender: JSON.parse(line) as unknown } };
  } catch {
    return { text: output };
  }
}

/** The omp chat's built-in `xd://render_html` device arrives as a write with that path in its args. */
const XD_DEVICE_PREFIX = "xd://";
const XD_RENDER = `${XD_DEVICE_PREFIX}${RENDER_TOOL_NAME}`;

function isXdRenderWrite(toolName: string, args: unknown): boolean {
  return toolName === "write" && typeof args === "object" && args !== null && !Array.isArray(args) && (args as Record<string, unknown>).path === XD_RENDER;
}

/**
 * Whether a call is the render tool in one of its three shapes (extension, MCP,
 * the xd:// device write). Decided from the call's raw args at its start, so a
 * caller remembers only the answer, not the args (a write's args are a whole file).
 */
export function isHtmlRenderCall(toolName: string, args: unknown): boolean {
  return toolName === RENDER_TOOL_NAME || toolName === HTML_RENDER_MCP_TOOL || toolName === HTML_RENDER_MCP_DOTTED || isXdRenderWrite(toolName, args);
}

/** The reference a tool result's `details.htmlRender` holds, or undefined when it is not one. */
export function htmlRenderFromDetails(toolName: string, args: unknown, details: unknown): HtmlRenderRef | undefined {
  // A tool's own result can imitate the shape; only the render tool may carry it.
  return isHtmlRenderCall(toolName, args) ? htmlRenderRef(details) : undefined;
}

/** A render call's result details → its page reference, or undefined when malformed. */
export function htmlRenderRef(details: unknown): HtmlRenderRef | undefined {
  if (typeof details !== "object" || details === null || Array.isArray(details)) return undefined;
  return readHtmlRenderRef((details as Record<string, unknown>).htmlRender);
}

function readHtmlRenderRef(value: unknown): HtmlRenderRef | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const d = value as Record<string, unknown>;
  if (typeof d.id !== "string" || !/^[0-9a-f]{32}$/.test(d.id)) return undefined;
  if (typeof d.height !== "number" || !Number.isFinite(d.height)) return undefined;
  return {
    id: d.id,
    title: htmlRenderTitle(d.title),
    height: Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.round(d.height))),
  };
}
