// awui's own tools as OpenCode's MCP naming writes them: the names the adapter registers
// (`awui-r-<id>`, `awui-o-<id>`), the tool names that come back (`<server>_<tool>`), the
// permission rules that scope one chat on the shared server, and the guards that keep a
// user's own MCP server, another chat's server, or a plain tool out of them.
import { describe, expect, it } from "vitest";
import { awuiMcpServerName, awuiOpenCodeFamily, awuiOpenCodeTool } from "../../src/shared/awui-mcp.js";
import { isHtmlRenderCall } from "../../src/server/harness/render-token.js";
import { isAwuiRule, openCodeTools } from "../../src/server/harness/opencode-tools.js";

const toolEnv = (over: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => ({
  AWUI_RENDER_URL: "http://127.0.0.1:4783/api/render",
  AWUI_RENDER_TOKEN: "a".repeat(32),
  AWUI_ORCH_URL: "http://127.0.0.1:4783/api/orchestration",
  AWUI_ORCH_TOKEN: "b".repeat(32),
  ...over,
});

/** The servers a chat with these tokens is given, as the adapter builds them. */
const chatTools = (over: Record<string, string | undefined> = {}) => openCodeTools(toolEnv(over));
const render = chatTools()?.servers[0]?.name ?? "";
const orchestrate = chatTools()?.servers[1]?.name ?? "";

describe("OpenCode's name for one of awui's tool servers", () => {
  it("is short, sanitized already, and never the chat's token", () => {
    expect(awuiMcpServerName("render", "0123456789abcdef")).toBe("awui-r-0123456789abcdef");
    expect(awuiMcpServerName("orchestrate", "0123456789abcdef")).toBe("awui-o-0123456789abcdef");
    expect(render).toMatch(/^awui-r-[0-9a-f]{16}$/);
    expect(orchestrate).toMatch(/^awui-o-[0-9a-f]{16}$/);
    const tools = openCodeTools(toolEnv());
    const names = tools?.servers.map((s) => s.name).join(" ") ?? "";
    expect(names).not.toContain("a".repeat(32));
    // Every tool name stays under OpenCode's 64-character limit, even the longest one.
    expect(`${orchestrate}_delegate_task`.length).toBeLessThan(64);
  });

  it("gives each chat its own, from its own tokens", () => {
    const one = openCodeTools(toolEnv())?.servers[0]?.name;
    const two = openCodeTools(toolEnv({ AWUI_RENDER_TOKEN: "c".repeat(32) }))?.servers[0]?.name;
    expect(one).not.toBe(two);
  });

  it("recognizes only a chat's own awui tool, never a user's server or a plain tool", () => {
    expect(awuiOpenCodeTool(`${render}_render_html`, "render")).toBe("render_html");
    expect(awuiOpenCodeTool(`${orchestrate}_delegate_task`, "orchestrate")).toBe("delegate_task");
    expect(awuiOpenCodeTool(`${orchestrate}_delegate_task`, "render")).toBeUndefined();
    expect(awuiOpenCodeTool("github_list_issues", "render")).toBeUndefined();
    expect(awuiOpenCodeTool("awui-zzz1_render_html", "render")).toBeUndefined();
    expect(awuiOpenCodeTool("render_html", "render")).toBeUndefined();
    expect(awuiOpenCodeFamily(`${render}_render_html`)).toBe("render");
    expect(awuiOpenCodeFamily(`${orchestrate}_thread_wait`)).toBe("orchestrate");
    expect(awuiOpenCodeFamily("mcp__awui__render_html")).toBeUndefined();
  });

  it("makes the render tool, and only it, publish a page", () => {
    expect(isHtmlRenderCall(`${render}_render_html`, {})).toBe(true);
    expect(isHtmlRenderCall(`${render}_other`, {})).toBe(false);
    expect(isHtmlRenderCall(`${orchestrate}_delegate_task`, {})).toBe(false);
    // A user's server with a tool of that name is not awui's.
    expect(isHtmlRenderCall("myserver_render_html", {})).toBe(false);
    expect(isHtmlRenderCall("render_html", {})).toBe(true);
  });
});

describe("the tool servers a chat is given", () => {
  it("carries awui's bridge, the chat's own environment, and no Code Mode", () => {
    const tools = openCodeTools(toolEnv());
    expect(tools?.servers).toHaveLength(2);
    const [renderServer, orchServer] = tools?.servers ?? [];
    expect(renderServer?.name).toBe(render);
    expect(renderServer?.config).toMatchObject({ type: "local", codemode: false, environment: { AWUI_RENDER_URL: toolEnv().AWUI_RENDER_URL, AWUI_RENDER_TOKEN: toolEnv().AWUI_RENDER_TOKEN } });
    expect(renderServer?.config.command[1]).toMatch(/render-html-mcp\.mjs$/);
    expect(renderServer?.config.environment).not.toHaveProperty("AWUI_ORCH_TOKEN");
    expect(orchServer?.config.command[1]).toMatch(/orchestrate-mcp\.mjs$/);
    expect(orchServer?.config.environment).toMatchObject({ AWUI_ORCH_URL: toolEnv().AWUI_ORCH_URL, AWUI_ORCH_TOKEN: toolEnv().AWUI_ORCH_TOKEN });
  });

  it("is only the families the chat was given a token for", () => {
    const noRender = openCodeTools(toolEnv({ AWUI_RENDER_URL: undefined }))?.servers ?? [];
    expect(noRender.map((s) => s.name)).toEqual([expect.stringMatching(/^awui-o-/)]);
    expect(noRender[0]?.config.environment).not.toHaveProperty("AWUI_RENDER_TOKEN");
    const noOrchestration = openCodeTools(toolEnv({ AWUI_ORCH_URL: undefined, AWUI_ORCH_TOKEN: undefined }))?.servers ?? [];
    expect(noOrchestration.map((s) => s.name)).toEqual([expect.stringMatching(/^awui-r-/)]);
    expect(noOrchestration[0]?.config.environment).not.toHaveProperty("AWUI_ORCH_TOKEN");
    expect(openCodeTools({})).toBeNull();
    expect(openCodeTools(undefined)).toBeNull();
  });

  it("scopes the session: every awui server denied, then this chat's own allowed, last so they win", () => {
    const rules = openCodeTools(toolEnv())?.rules ?? [];
    expect(rules).toEqual([
      { action: "awui-*", resource: "*", effect: "deny" },
      { action: `${render}_*`, resource: "*", effect: "allow" },
      { action: `${orchestrate}_*`, resource: "*", effect: "allow" },
    ]);
    // The deny first and the allow after it is what the last-match-wins check reads as "ours only".
    expect(rules.findIndex((r) => r.effect === "deny")).toBeLessThan(rules.findIndex((r) => r.effect === "allow"));
    expect(isAwuiRule(rules[0])).toBe(true);
    expect(isAwuiRule({ action: "edit", resource: "*", effect: "allow" })).toBe(false);
    expect(isAwuiRule(null)).toBe(false);
  });
});

