// The files that carry the orchestration tools into a harness child, and the
// names those tools take on an MCP client: pi and omp load extensions/orchestrate.ts
// with -e only when the chat was given a token, and Claude Code, Codex, and DSH get
// awui's second MCP server instead. The tool names come from the catalogue, so an
// allow list cannot drift from what the server serves.
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ORCH_TOOLS } from "../../src/server/orchestration/tools.js";
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
