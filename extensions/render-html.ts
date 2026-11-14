// render_html: publish a finished, self-contained HTML page (a chart, table,
// diagram, mockup) into the chat, where awui shows it in a sandboxed frame
// above the final reply. awui loads this into every Pi and omp child with -e
// (it speaks only the extension API both share, and imports nothing) and
// points it at its render endpoint with two environment variables:
//
//   AWUI_RENDER_URL    POST target, e.g. http://127.0.0.1:4783/api/render/<chat>
//   AWUI_RENDER_TOKEN  the chat's render token, sent as X-Awui-Render-Token
//
// Without both it registers nothing, so a stray copy elsewhere stays inert.
// A page is a single HTML document with inline <style> and <script>, remote
// http(s) resources loading as-is. The endpoint stores it and answers
// { id, url }; the tool result's `details` carries both so awui's adapter can
// attach the page to this call's tool card.

interface ToolContent {
  type: "text";
  text: string;
}

interface ToolResult {
  content: ToolContent[];
  details: Record<string, unknown>;
  isError?: boolean;
}

interface RenderPage {
  id: string;
  url: string;
}

interface Api {
  registerTool(tool: {
    name: string;
    label: string;
    description: string;
    /** Pi lists a tool in the system prompt's "Available tools" only when it has one; omp ignores it. */
    promptSnippet?: string;
    parameters: unknown;
    execute(toolCallId: string, params: { html: string; title: string; height: number }): Promise<ToolResult>;
  }): void;
}

// Loaded twice (from a project's extensions folder and again with -e), it registers once.
const LOADED = Symbol.for("awui-render-html.loaded");

const text = (value: string): ToolContent => ({ type: "text", text: value });

const DEFAULT_HEIGHT = 320;
const MIN_HEIGHT = 80;
const MAX_HEIGHT = 2000;
const MAX_HTML_BYTES = 512 * 1024;
const TIMEOUT_MS = 10_000;
// omp's `write xd://render_html` device runs this tool but keeps only its content,
// so its details never reach awui. The reference also rides on the last line of
// the text, as the MCP server's does; awui lifts it off and the card shows the
// text without it. The details still carry it for a native Pi/omp call.
const RENDER_MARKER = "awui-html-render:";
const THEME_VARS = "--bg --surface --surface-2 --border --text --text-2 --muted --accent --accent-hover --link --ok --danger --warn --info --orange --thinking --font-sans --font-mono";

export function renderActionOps(url: string, token: string, args: { renderId: string; action: string; selector?: string; value?: string; amount?: number; theme?: { appearance: "dark" | "light"; variables: Record<string, string> } }): Promise<Response> {
  return fetch(`${url.replace(/\/$/, "")}/action`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Awui-Render-Token": token },
    body: JSON.stringify(args),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

export default function renderHtml(pi: Api): void {

  const url = process.env.AWUI_RENDER_URL;
  const token = process.env.AWUI_RENDER_TOKEN;
  if (!url || !token) return;
  const registry = globalThis as Record<symbol, unknown>;
  if (registry[LOADED]) return;
  registry[LOADED] = true;

  pi.registerTool({
    name: "render_html",
    label: "awui · Render HTML",
    promptSnippet: "awui: show a finished HTML page (chart, table, diagram, mockup) inline in this chat, above your final reply.",
    description:
      "awui: show a finished HTML page (chart, table, diagram, mockup) inline in this chat, above your final text reply; call it before writing that reply. " +
      "Write one complete, self-contained document with inline <style> and <script> and no external <script src> for its logic (remote data urls over https are fine). " +
      "Style it from the reader's theme variables, already set on :root and matching the light or dark page around the frame: " +
      THEME_VARS +
      ". The body starts with var(--bg) and var(--text); set only the rest. Keep the page short enough to read at a glance; a height below the content height makes the rest scroll inside the frame. " +
      "The reader already sees the page, so the reply should not announce it or say where it is: add only what the page doesn't say.",
    parameters: {
      type: "object",
      required: ["html", "title", "height"],
      properties: {
        html: { type: "string", description: "The complete HTML document." },
        title: { type: "string", description: "Short name for the page." },
        height: {
          type: "number",
          description: `Frame height in CSS pixels, ${MIN_HEIGHT}-${MAX_HEIGHT}; ${DEFAULT_HEIGHT} is a good default. Shorter than the content and the rest scrolls.`,
        },
      },
    },
    async execute(_toolCallId, params) {
      const html = typeof params.html === "string" ? params.html : "";
      if (html.trim() === "") return { content: [text("html is empty: pass a complete HTML document")], details: {}, isError: true };
      const bytes = Buffer.byteLength(html, "utf8");
      if (bytes > MAX_HTML_BYTES)
        return { content: [text(`html is ${(bytes / 1024).toFixed(0)} KB; the limit is ${MAX_HTML_BYTES / 1024} KB`)], details: {}, isError: true };
      const title = typeof params.title === "string" && params.title.trim() !== "" ? params.title.trim() : "HTML";
      const height = Number.isFinite(params.height) ? Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, Math.round(params.height))) : DEFAULT_HEIGHT;
      let page: RenderPage;
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Awui-Render-Token": token },
          body: JSON.stringify({ html, title, height }),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (!response.ok) {
          const detail = (await response.text().catch(() => "")).slice(0, 200);
          return { content: [text(`the chat's render endpoint refused the page (HTTP ${response.status})${detail ? `: ${detail}` : ""}`)], details: {}, isError: true };
        }
        page = (await response.json()) as RenderPage;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { content: [text(`could not reach the chat's render endpoint: ${reason}`)], details: {}, isError: true };
      }
      return {
        content: [text(`Rendered "${title}" into the chat. The page is above; do not describe or restate it in your reply.\n${RENDER_MARKER} ${JSON.stringify({ id: page.id, title, height })}`)],
        details: { htmlRender: { id: page.id, title, height }, url: page.url },
      };
    },
  });
  pi.registerTool({
    name: "browser_action",
    label: "awui · Page action",
    promptSnippet: "awui: take one bounded action (snapshot, click, fill, scroll, screenshot, close) on a page you rendered with render_html.",
    description: "awui: use a bounded action on a known agent-rendered page: snapshot, click a non-link button/input, fill a text/textarea/select control, scroll, screenshot or close. renderId comes from render_html; this never permits arbitrary site URLs, a JavaScript evaluator, popup tabs, storage or remote network. Enumerate a selector, then click/fill the current page; do not treat this as a normal unrestricted web browser.",
    parameters: {
      type: "object",
      required: ["renderId", "action"],
      properties: {
        renderId: { type: "string", description: "32-hex id from render_html (not a URL)" },
        action: { type: "string", enum: ["snapshot", "click", "fill", "scroll", "screenshot", "close"] },
        selector: { type: "string", description: "One exact CSS control selector, ≤512 chars" },
        value: { type: "string", description: "For fill, text to type or option label to select (≤4096 chars)" },
        amount: { type: "number", description: "For scroll, integer offset ±10000 CSS pixel" },
        theme: { type: "object", description: "Optional current HtmlRenderTheme ({appearance:dark|light,variables}) for snapshot/screenshot presentation only; no executable CSS/JS." },
      },
    },
    async execute(_id, params) {
      const args = params as unknown as { renderId: string; action: "snapshot" | "click" | "fill" | "scroll" | "screenshot" | "close"; selector?: string; value?: string; amount?: number; theme?: { appearance: "dark" | "light"; variables: Record<string, string> } };
      if (typeof args.renderId !== "string" || /^[0-9a-f]{32}$/.test(args.renderId) === false) return { content: [text("renderId must be the 32-hex id from render_html, not a site URL")], details: {} };
      if (args.action !== "close" && args.action !== "snapshot" && args.action !== "screenshot" && !["click", "fill", "scroll"].includes(args.action)) {
        return { content: [text(`Unsupported browser action; use snapshot, click, fill, scroll, screenshot or close.`)], details: {} };
      }
      if (args.action === "scroll" && (typeof args.amount !== "number" || !Number.isInteger(args.amount) || Math.abs(args.amount) > 10000)) {
        return { content: [text("scroll amount must be an integer within +/-10000 CSS pixels")], details: {} };
      }
      if (args.action !== "click" && args.action !== "fill" && args.action !== "scroll" && args.action !== "snapshot" && args.action !== "close" && args.action !== "screenshot") {
        return { content: [text("A known bounded action is required")], details: {} };
      }
      if (typeof args.selector === "string" && args.selector.length > 512 || typeof args.value === "string" && args.value.length > 4096) {
        return { content: [text("Selector/value too large; keep them within the documented 512/4096 limits")], details: {} };
      }
      if (args.action === "fill" && (typeof args.selector !== "string" || args.selector.length < 1 || typeof args.value !== "string")) {
        return { content: [text("fill needs one precise CSS selector and bounded input value")], details: {} };
      }
      if (args.action === "click" && (typeof args.selector !== "string" || args.selector.length < 1)) {
        return { content: [text("click needs one precise button or local input selector")], details: {} };
      }
      const result = await renderActionOps(url, token, args);
      const body = await result.text();
      return { content: [text(body)], details: {}, isError: !result.ok };
    },
  });
}
