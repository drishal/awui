// The files that carry the orchestration tools into a harness child, and the
// names those tools take on an MCP client: pi and omp load extensions/orchestrate.ts
// with -e only when the chat was given a token, and Claude Code, Codex, and DSH get
// awui's second MCP server instead. The tool names come from the catalogue, so an
// allow list cannot drift from what the server serves.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ORCH_INSTRUCTIONS, ORCH_TOOLS } from "../../src/server/orchestration/tools.js";
import { orchestrateExtension, orchestrateExtensionArgs, orchestrateMcpServer, ORCH_MCP_SERVER } from "../../src/server/harness/render-extension.js";
import { orchestrationMcpToolNames } from "../../src/server/harness/render-token.js";

const extensions = path.join(import.meta.dirname, "..", "..", "extensions");

describe("the orchestration tools' files", () => {
  it("finds the extension and the MCP server in the source tree", () => {
    expect(orchestrateExtension()).toBe(path.join(extensions, "orchestrate.ts"));
    expect(orchestrateMcpServer()).toBe(path.join(extensions, "orchestrate-mcp.mjs"));
  });

  it("loads the extension only for a child that was given a token", () => {
    expect(orchestrateExtensionArgs(undefined)).toEqual([]);
    expect(orchestrateExtensionArgs({ AWUI_ORCH_URL: "http://127.0.0.1:4783/api/orchestration" })).toEqual([]);
    expect(orchestrateExtensionArgs({ AWUI_ORCH_URL: "http://127.0.0.1:4783/api/orchestration", AWUI_ORCH_TOKEN: "t0ken" })).toEqual(["-e", path.join(extensions, "orchestrate.ts")]);
  });

  it("names every catalogue tool as an MCP client does, under its own server", () => {
    expect(ORCH_MCP_SERVER).toBe("awui-orchestrate");
    const names = orchestrationMcpToolNames();
    expect(names).toHaveLength(ORCH_TOOLS.length);
    expect(names).toContain("mcp__awui-orchestrate__delegate_task");
    expect(names).toContain("mcp__awui-orchestrate__thread_wait");
  });
});

describe("what awui tells a harness about its tools", () => {
  it("names every tool, says whose they are, and stays under Codex's 4,000-byte instruction limit", () => {
    expect(ORCH_INSTRUCTIONS).toContain("awui is the web UI running this chat");
    for (const tool of ORCH_TOOLS) expect(ORCH_INSTRUCTIONS).toContain(tool.name);
    expect(Buffer.byteLength(ORCH_INSTRUCTIONS)).toBeLessThan(4000);
  });
});

describe("how the Pi/omp extension introduces the tools", () => {
  it("registers each as awui's: a branded label and description, a prompt line, and one guideline naming them all", async () => {
    const registered: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(JSON.stringify({ tools: ORCH_TOOLS, instructions: ORCH_INSTRUCTIONS }), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    process.env.AWUI_ORCH_URL = "http://127.0.0.1:1/api/orchestration";
    process.env.AWUI_ORCH_TOKEN = "t0ken";
    delete (globalThis as Record<symbol, unknown>)[Symbol.for("awui-orchestrate.loaded")];
    try {
      const mod = (await import("../../extensions/orchestrate.js")) as { default: (pi: { registerTool(tool: Record<string, unknown>): void }) => void };
      mod.default({ registerTool: (tool) => registered.push(tool) });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.AWUI_ORCH_URL;
      delete process.env.AWUI_ORCH_TOKEN;
      delete (globalThis as Record<symbol, unknown>)[Symbol.for("awui-orchestrate.loaded")];
    }
    expect(registered).toHaveLength(ORCH_TOOLS.length);
    for (const tool of registered) {
      expect(tool.label).toBe(`awui · ${String(tool.name)}`);
      expect(String(tool.description)).toMatch(/^awui: /);
      expect(String(tool.promptSnippet)).toMatch(/^awui: /);
      expect(String(tool.description)).toContain(String(tool.promptSnippet));
    }
    const guidelines = registered.flatMap((tool) => (tool.promptGuidelines as string[] | undefined) ?? []);
    expect(guidelines).toHaveLength(1);
    expect(guidelines[0]).toBe(ORCH_INSTRUCTIONS);
  });
});
