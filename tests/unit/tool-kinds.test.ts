import { describe, expect, it } from "vitest";
import type { ChatItem, ToolCategory, ToolItem } from "../../src/shared/protocol.js";
import { toolCategory, toolKindOf } from "../../src/server/harness/agent-events.js";
import { iconStack, monogram, rowMark, serverHue, toolKind, toolKinds, usedLabel } from "../../src/web/tool-kinds.js";

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
  it("reads awui's per-chat servers on OpenCode as one awui chip", () => {
    // OpenCode names a server's tool `<server>_<tool>`; the id is the chat's, the server is awui's.
    expect(toolKinds([tool("awui-r-0123456789abcdef_render_html", "other")])[0]).toEqual({ key: "mcp:awui", category: "other", server: "awui" });
    // A delegation through the same servers is still an agent call, not a chip.
    expect(toolKinds([tool("awui-o-0123456789abcdef_delegate_task", "other")])[0]).toEqual({ key: "agent", category: "agent" });
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

  it("wears the flask on its row, not the command's terminal mark", () => {
    // The flat line skin draws the row's own glyph; a settled command whose output is a test tally
    // must wear the same test mark its chip does, and a plan call its checklist.
    const run = bash(" Test Files  1 passed (1)\n      Tests  8 passed (8)\n   Duration  200ms") as Extract<ChatItem, { kind: "tool" }>;
    expect(rowMark(toolKind(run))).toEqual({ category: "command", test: true, plan: false });
    expect(rowMark(toolKind(tool("todo", "other") as Extract<ChatItem, { kind: "tool" }>))).toEqual({ category: "other", test: false, plan: true });
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

describe("the server decides the kind", () => {
  const call = (over: Partial<ToolItem> & Pick<ToolItem, "name">): ToolItem => ({
    kind: "tool",
    id: "t:1",
    args: "{}",
    status: "done",
    output: "",
    truncated: false,
    category: "other",
    summary: "",
    paths: [],
    ...over,
  });

  it("fixes the names the category map used to miss", () => {
    expect(toolCategory("NotebookEdit")).toBe("edit");
    expect(toolCategory("apply_diff")).toBe("edit");
    expect(toolCategory("delete_file")).toBe("edit");
    expect(toolCategory("move_file")).toBe("edit");
    // A notebook read is still a read, and a plain tool is still other.
    expect(toolCategory("NotebookRead")).toBe("read");
    expect(toolCategory("explain")).toBe("other");
    expect(toolKindOf(call({ name: "NotebookEdit", category: "edit" }))).toBe("edit");
  });

  it("names an MCP server, and a delegation stays an agent", () => {
    expect(toolKindOf(call({ name: "mcp__github__list_issues", category: "search" }))).toBe("mcp:github");
    // awui's own per-chat servers on OpenCode are one kind, whichever bridge carried the call.
    expect(toolKindOf(call({ name: "awui-r-0123456789abcdef_render_html" }))).toBe("mcp:awui");
    expect(toolKindOf(call({ name: "delegate_task" }))).toBe("agent");
    expect(toolKindOf(call({ name: "mcp__awui-orchestrate__thread_wait" }))).toBe("agent");
  });

  it("tells a plan from a todo list, whatever the harness calls the tool", () => {
    expect(toolKindOf(call({ name: "todo" }))).toBe("todo");
    expect(toolKindOf(call({ name: "TodoWrite" }))).toBe("todo");
    expect(toolKindOf(call({ name: "ExitPlanMode", plan: "# Plan" }))).toBe("plan");
    expect(toolKindOf(call({ name: "plan_mode_complete", plan: "# Plan" }))).toBe("plan");
    // Codex's plan item carries no argument; its text arrives on the result and sets `plan`.
    expect(toolKindOf(call({ name: "update_plan", plan: "1. read\n2. edit" }))).toBe("plan");
    expect(toolKindOf(call({ name: "explain" }))).toBe("other");
  });

  it("calls a background-job surface a job, and leaves a command's own row alone", () => {
    expect(toolKindOf(call({ name: "wait" }))).toBe("job");
    expect(toolKindOf(call({ name: "bg_task", args: JSON.stringify({ action: "spawn" }) }))).toBe("job");
    expect(toolKindOf(call({ name: "TaskStop" }))).toBe("job");
    expect(toolKindOf(call({ name: "bash", category: "command", args: JSON.stringify({ run_in_background: true }) }))).toBe("command");
  });

  it("reads a finished command's output for a test run, and nothing else", () => {
    const run = call({ name: "bash", category: "command", args: JSON.stringify({ command: "npm test" }), output: " Test Files  1 passed (1)\n      Tests  3 passed (3)" });
    expect(toolKindOf(run)).toBe("test");
    expect(toolKindOf({ ...run, output: "" })).toBe("command");
    // A running call's output is partial, so it claims nothing yet.
    expect(toolKindOf({ ...run, status: "running" })).toBe("command");
  });

  it("names a published page and a question", () => {
    expect(toolKindOf(call({ name: "render_html" }))).toBe("render");
    expect(toolKindOf(call({ name: "ask" }))).toBe("ask");
    // Another harness's own `ask` is not omp's form.
    expect(toolKindOf(call({ name: "ask", category: "read" }))).toBe("read");
  });

  it("is what the clients' chips are read from", () => {
    expect(toolKind(call({ name: "read", category: "read", toolKind: "test" }))).toEqual({ key: "test", category: "command", test: true });
    expect(toolKind(call({ name: "TodoWrite", toolKind: "todo" }))).toEqual({ key: "plan", category: "other", plan: true });
    expect(toolKind(call({ name: "mcp__linear__list_issues", category: "search", toolKind: "mcp:linear" }))).toEqual({ key: "mcp:linear", category: "search", server: "linear" });
  });
});
