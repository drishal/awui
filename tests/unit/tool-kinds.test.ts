import { describe, expect, it } from "vitest";
import type { ChatItem, ToolCategory } from "../../src/shared/protocol.js";
import { iconStack, monogram, serverHue, toolKinds, usedLabel } from "../../src/web/tool-kinds.js";

const tool = (name: string, category: ToolCategory): ChatItem => ({ kind: "tool", id: name, name, args: "{}", status: "done", output: "", truncated: false, category, summary: "", paths: [] });

describe("toolKinds", () => {
  it("lists each kind once, in first-use order", () => {
    const kinds = toolKinds([tool("read", "read"), tool("bash", "command"), tool("read", "read"), tool("grep", "search"), tool("bash", "command")]);
    expect(kinds.map((k) => k.key)).toEqual(["read", "command", "search"]);
  });
  it("counts each MCP server as its own kind", () => {
    const kinds = toolKinds([tool("mcp__linear__list_issues", "other"), tool("mcp__github__get_pr", "other"), tool("mcp__linear__get_issue", "other"), tool("lsp", "other")]);
    expect(kinds.map((k) => k.key)).toEqual(["mcp:linear", "mcp:github", "other"]);
    expect(kinds[0]?.server).toBe("linear");
  });
  it("skips what is not a tool", () => {
    expect(toolKinds([{ kind: "notice", id: "n", level: "info", text: "x" }])).toEqual([]);
  });
});

describe("a test run", () => {
  const bash = (output: string): ChatItem => ({ ...(tool("bash", "command") as object), args: '{"command":"npm test"}', output }) as ChatItem;
  it("is a kind of its own, only when the output reads as one", () => {
    const run = bash(" Test Files  1 passed (1)\n      Tests  3 passed (3)\n   Duration  200ms");
    expect(toolKinds([run])[0]).toEqual({ key: "test", category: "command", test: true });
    expect(toolKinds([bash("hello, all tests passed I think")])[0]?.key).toBe("command");
    expect(toolKinds([run, bash("ls"), run]).map((k) => k.key)).toEqual(["test", "command"]);
  });
});

describe("a todo or plan call", () => {
  it("is a kind of its own, whatever the harness calls the tool", () => {
    // Pi/omp's `todo`, Claude's `TodoWrite`, and a plan handed over for review.
    expect(toolKinds([tool("todo", "other")])[0]).toEqual({ key: "plan", category: "other", plan: true });
    expect(toolKinds([tool("TodoWrite", "other")])[0]?.key).toBe("plan");
    expect(toolKinds([tool("ExitPlanMode", "other")])[0]?.key).toBe("plan");
    // And it is one kind, not one per spelling.
    expect(toolKinds([tool("todo", "other"), tool("TodoWrite", "other")]).map((k) => k.key)).toEqual(["plan"]);
    // A tool whose name only reads like one stays its category.
    expect(toolKinds([tool("explain", "other")])[0]?.key).toBe("other");
  });
});

describe("iconStack", () => {
  const k = (key: string) => ({ key, category: "other" as const });
  it("shows three and counts the rest", () => {
    expect(iconStack([k("a"), k("b"), k("c"), k("d"), k("e")])).toEqual({ shown: [k("a"), k("b"), k("c")], more: 2 });
    expect(iconStack([k("a"), k("b")])).toEqual({ shown: [k("a"), k("b")], more: 0 });
  });
});

describe("server chips", () => {
  it("takes one letter, or two for a multi-word name", () => {
    expect(monogram("linear")).toBe("L");
    expect(monogram("git-hub")).toBe("GH");
    expect(monogram("context7")).toBe("C");
  });
  it("hashes a name to a stable slot", () => {
    expect(serverHue("linear")).toBe(serverHue("linear"));
    expect([0, 1, 2, 3]).toContain(serverHue("github"));
  });
});

describe("usedLabel", () => {
  it("is singular for one", () => {
    expect(usedLabel(1)).toBe("Used 1 tool");
    expect(usedLabel(6)).toBe("Used 6 tools");
  });
});

describe("the orchestration surface", () => {
  it("wears the agents mark, whichever bridge carried the call, and is one kind", () => {
    expect(toolKinds([tool("delegate_task", "other")])[0]).toEqual({ key: "agent", category: "agent" });
    // Not the MCP server's monogram: the same work under a different spelling is the same kind.
    expect(toolKinds([tool("delegate_task", "other"), tool("mcp__awui-orchestrate__thread_wait", "other")]).map((k) => k.key)).toEqual(["agent"]);
    // Another server's tool is still that server's, and a plain call is still its category.
    expect(toolKinds([tool("mcp__github__list_issues", "other")])[0]?.key).toBe("mcp:github");
    expect(toolKinds([tool("task_status_report", "other")])[0]?.key).toBe("other");
  });
});
