import { describe, expect, it } from "vitest";
import type { AssistantItem, ToolItem } from "../../src/shared/protocol.js";
import { harnessGlyph, humanise, latestThoughtLine, neatRow, shortPath, sigmaFacts, splitComments, thinkingMeta, thoughtTitle, thoughtTokens, workRuns } from "../../src/atui/neat.js";

const tool = (over: Partial<ToolItem>): ToolItem => ({
  kind: "tool",
  id: "t:1",
  name: "read",
  args: "{}",
  status: "done",
  output: "",
  truncated: false,
  category: "read",
  summary: "",
  paths: [],
  ...over,
});

describe("atui rows, neat-render's way", () => {
  it("words reads, commands, searches, and fetches with their outcome", () => {
    expect(neatRow(tool({ args: JSON.stringify({ path: "/w/src/a.ts", offset: 1, limit: 20 }), paths: ["/w/src/a.ts"], output: "a\nb\n" }), "/w")).toEqual({ label: "Read", glue: " ", detail: "src/a.ts:1-20", facts: ["2 lines"] });
    const bash = neatRow(tool({ name: "bash", category: "command", args: JSON.stringify({ command: "# check the tests\nnpm test" }), status: "error", output: "1 failed\nCommand exited with code 2" }), "/w");
    expect(bash).toEqual({ label: "Bash", glue: " ", detail: "$ npm test", note: "check the tests", facts: ["exit 2", "2 lines"] });
    expect(neatRow(tool({ name: "bash", category: "command", args: JSON.stringify({ command: "ls" }), status: "error", output: "boom", exitCode: 1 }), "/w").facts).toEqual(["exit 1", "1 line"]);
    // A reported code beats guessing one from the output text.
    expect(neatRow(tool({ name: "bash", category: "command", args: JSON.stringify({ command: "ls" }), status: "error", output: "all good", exitCode: 2 }), "/w").facts).toEqual(["exit 2", "1 line"]);
    expect(neatRow(tool({ name: "bash", category: "command", args: JSON.stringify({ command: "ls" }), output: "x" }), "/w").facts).toEqual(["1 line"]);
    expect(neatRow(tool({ name: "grep", category: "search", args: JSON.stringify({ pattern: "listen", path: "/w/src" }), paths: ["/w/src"], output: "a\nb" }), "/w")).toMatchObject({ label: "Search", detail: "listen in src", facts: ["2 results"] });
    expect(neatRow(tool({ name: "web_fetch", category: "web", args: JSON.stringify({ urls: ["https://example.com/a/", "https://b.dev"] }) }), "/w")).toMatchObject({ label: "Fetch", detail: "example.com/a +1 more" });
    expect(neatRow(tool({ name: "web_search", category: "web", args: JSON.stringify({ query: "pi tui" }) }), "/w")).toMatchObject({ label: "Search", detail: "pi tui" });
  });

  it("names a tool it does not know by its words, and an MCP tool by its server", () => {
    expect(humanise("lsp_diagnostics")).toBe("LSP diagnostics");
    expect(neatRow(tool({ name: "lsp_diagnostics", category: "other", summary: "src/a.ts" }), "/w")).toMatchObject({ label: "LSP diagnostics", detail: "src/a.ts" });
    expect(neatRow(tool({ name: "mcp__context7__resolve-library-id", category: "other", summary: "react" }), "/w")).toMatchObject({ label: "Context7", detail: "resolve-library-id react" });
    expect(neatRow(tool({ name: "codemode", category: "other", args: JSON.stringify({ code: "const a = await read()\nreturn a" }) }), "/w")).toMatchObject({ label: "Codemode", detail: "const a = await read() …" });
  });

  it("names an edit Edit and its path, says its scale, and previews its changed lines", () => {
    const lines = [
      { kind: "ctx" as const, text: "far" },
      { kind: "ctx" as const, text: "near" },
      { kind: "del" as const, text: "a" },
      { kind: "add" as const, text: "b" },
      { kind: "ctx" as const, text: "after" },
      { kind: "ctx" as const, text: "far again" },
      { kind: "add" as const, text: "c" },
      { kind: "gap" as const, text: "" },
      { kind: "ctx" as const, text: "past the gap" },
    ];
    const row = neatRow(tool({ name: "edit", category: "edit", paths: ["/w/src/app.ts"], diffStat: { added: 2, removed: 1 }, diff: { lines, added: 2, removed: 1 } }), "/w");
    expect(row).toMatchObject({ label: "Edit", glue: " ", detail: "src/app.ts", facts: ["Added 2 lines, removed 1 line"] });
    expect(row.diff).toEqual([
      { marker: " ", text: "near" },
      { marker: "-", text: "a" },
      { marker: "+", text: "b" },
      { marker: " ", text: "after" },
      { marker: " ", text: "far again" },
      { marker: "+", text: "c" },
    ]);
    expect(neatRow(tool({ name: "write", category: "write", paths: ["/w/n.md"], diffStat: { added: 4, removed: 0 }, diff: { lines: [], added: 4, removed: 0 } }), "/w")).toMatchObject({ label: "Write", facts: ["Added 4 lines"] });
    expect(neatRow(tool({ name: "edit", category: "edit", paths: ["/w/a.ts"], status: "error" }), "/w").facts).toEqual(["failed"]);
  });

  it("splits a command's leading comments, but not a shebang or a command of only comments", () => {
    expect(splitComments("# look first\n# then list\nls -la")).toEqual({ note: "look first then list", command: "ls -la" });
    expect(splitComments("#!/bin/sh\necho hi")).toEqual({ command: "#!/bin/sh\necho hi" });
    expect(splitComments("# only a note")).toEqual({ command: "# only a note" });
    expect(splitComments("// js note\nconsole.log(1)", "//")).toEqual({ note: "js note", command: "console.log(1)" });
  });

  it("titles a thought by its bold heading or first sentence, and sizes it", () => {
    expect(thoughtTitle("**Inspecting the workflow**\n\nThe PR job runs…")).toBe("Inspecting the workflow");
    expect(thoughtTitle("```ts\ncode\n```\nThe server starts here. Then more.")).toBe("The server starts here.");
    expect(thoughtTokens("x".repeat(1360))).toBe("340");
    expect(thoughtTokens("x".repeat(6000))).toBe("1.5k");
  });

  it("hangs calls fired one after another off one tree, and leaves a lone call and an agent call their own row", () => {
    const call = (id: string, over: Partial<ToolItem> = {}) => tool({ id, ...over });
    const rows: Array<{ id: string; call: ToolItem | null }> = [
      { id: "a", call: call("a") },
      { id: "b", call: call("b") },
      { id: "say", call: null },
      { id: "c", call: call("c") },
      { id: "d", call: call("d") },
      { id: "agents", call: call("agents", { subagents: { runs: [] } as unknown as ToolItem["subagents"] }) },
      { id: "e", call: call("e") },
    ];
    const runs = workRuns(rows, (r) => r.call).map((r) => (r.kind === "tree" ? r.calls.map((c) => c.id).join("+") : r.row.id));
    expect(runs).toEqual(["a+b", "say", "c+d", "agents", "e"]);
  });

  it("words a thought as its time and size, and rolls a live one with its newest line", () => {
    const thought = (over: Partial<AssistantItem>): AssistantItem => ({ kind: "assistant", id: "a", text: "", thinking: "x".repeat(560), streaming: false, ...over });
    expect(thinkingMeta(thought({ at: 1000, endedAt: 3100 }))).toBe("2.1s ~140 tokens");
    // Under a quarter second the time says nothing.
    expect(thinkingMeta(thought({ at: 1000, endedAt: 1100 }))).toBe("~140 tokens");
    expect(thinkingMeta(thought({ at: 1000, streaming: true }), 4000)).toBe("3.0s ~140 tokens");
    expect(latestThoughtLine("First idea.\n\n> - then the second\n")).toBe("then the second");
  });

  it("closes a finished turn with its Σ: calls, the calls' own span, reasoning, failures", () => {
    const turn = {
      process: [
        tool({ id: "1", at: 1000, endedAt: 2000 }),
        { kind: "assistant", id: "t", text: "", thinking: "x".repeat(2560), streaming: false } as AssistantItem,
        tool({ id: "2", at: 2500, endedAt: 8500, status: "error" }),
      ],
      workAfter: [],
      answer: { kind: "assistant", id: "ans", text: "done", thinking: "", streaming: false } as AssistantItem,
      startedAt: 0,
      endedAt: 20_000,
    };
    expect(sigmaFacts(turn)).toEqual({ facts: ["2 calls", "7.5s", "~640 thought"], failed: "1 failed" });
    // Without the calls' times it falls back to the turn's; a turn with nothing to say says nothing.
    expect(sigmaFacts({ ...turn, process: [tool({ id: "1" })] }).facts).toEqual(["1 call", "20.0s"]);
    expect(sigmaFacts({ process: [], workAfter: [], answer: null, startedAt: 0, endedAt: 200 })).toEqual({ facts: [], failed: null });
  });

  it("shortens paths and marks the card with the harness", () => {
    expect(shortPath("/w/a/b/c/d/e.ts", "/w")).toBe("…/c/d/e.ts");
    expect(shortPath("/home/me/notes.md", "/w", "/home/me")).toBe("~/notes.md");
    expect(harnessGlyph("pi")).toBe("π");
    expect(harnessGlyph("fake")).toBe("F");
  });
});
