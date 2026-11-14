import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, migrateStateDir } from "../../src/server/config.js";
import { boundText, extensionMessage, historyToItems, NO_RESULT_TEXT, normalizeAgentEvent, outputDiffStat, piTodos, stringifyArgs, toolCategory, toolPaths, toolSummary } from "../../src/server/harness/agent-events.js";
import { buildOmpEnv } from "../../src/server/harness/omp.js";

describe("the state folder", () => {
  it("moves from its old name (agent-web-ui) to awui once, and never over an existing awui", () => {
    const base = mkdtempSync(path.join(tmpdir(), "awui-migrate-"));
    const old = path.join(base, "agent-web-ui");
    mkdirSync(old);
    writeFileSync(path.join(old, "cookie-secret"), "kept");
    const dir = path.join(base, "awui");
    expect(migrateStateDir(dir)).toBe("moved");
    expect(readFileSync(path.join(dir, "cookie-secret"), "utf8")).toBe("kept");
    expect(existsSync(old)).toBe(false);
    // Once there is an awui folder, an old one is left alone.
    mkdirSync(old);
    expect(migrateStateDir(dir)).toBeNull();
    expect(existsSync(old)).toBe(true);
    // Only the default name moves: an explicit other folder is never touched.
    expect(migrateStateDir(path.join(base, "custom"))).toBeNull();
  });
});

describe("loadConfig", () => {
  it("defaults to 127.0.0.1:4783 and the home directory", () => {
    const c = loadConfig({ HOME: "/home/x" });
    expect(c.port).toBe(4783);
    expect(c.host).toBe("127.0.0.1");
    expect(c.harnesses).toEqual(["pi", "omp", "hermes", "claude", "codex", "opencode", "grok", "dsh", "awui"]);
  });

  it("binds 127.0.0.1 unless HOST=0.0.0.0, and rejects anything else", () => {
    expect(loadConfig({}).host).toBe("127.0.0.1");
    expect(loadConfig({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
    for (const bad of ["192.168.1.5", "::", "localhost"]) expect(() => loadConfig({ HOST: bad })).toThrow(ConfigError);
    expect(loadConfig({ XDG_STATE_HOME: "/st" }).credentialsFile).toBe("/st/awui/credentials.json");
    expect(loadConfig({ AUTH_CREDENTIALS_FILE: "/run/secrets/awui" }).credentialsFile).toBe("/run/secrets/awui");
  });

  it("takes a login from AUTH_USERNAME/AUTH_PASSWORD, with set-password's rules", () => {
    expect(loadConfig({}).login).toBeNull();
    expect(loadConfig({ AUTH_USERNAME: "drishal", AUTH_PASSWORD: "" }).login).toBeNull();
    expect(loadConfig({ AUTH_USERNAME: " drishal ", AUTH_PASSWORD: "long enough" }).login).toEqual({
      username: "drishal",
      password: "long enough",
    });
    expect(() => loadConfig({ AUTH_PASSWORD: "long enough" })).toThrow(/AUTH_USERNAME/);
    expect(() => loadConfig({ AUTH_USERNAME: "two words", AUTH_PASSWORD: "long enough" })).toThrow(ConfigError);
    expect(loadConfig({ AUTH_USERNAME: "drishal", AUTH_PASSWORD: "short" }).login).toEqual({ username: "drishal", password: "short" });
  });

  it("validates PORT", () => {
    expect(loadConfig({ PORT: "5000" }).port).toBe(5000);
    for (const bad of ["80", "70000", "abc", "4783.5"]) expect(() => loadConfig({ PORT: bad })).toThrow(ConfigError);
  });

  it("normalizes ALLOWED_HOSTS and rejects junk", () => {
    expect(loadConfig({ ALLOWED_HOSTS: "Box.Tail.ts.net, other:8443" }).allowedHosts).toEqual(["box.tail.ts.net", "other:8443"]);
    expect(() => loadConfig({ ALLOWED_HOSTS: "http://x/y" })).toThrow(ConfigError);
  });

  it("splits WORKSPACE_ROOTS on the path delimiter and expands ~", () => {
    const c = loadConfig({ WORKSPACE_ROOTS: "/a:~/b" });
    expect(c.workspaceRoots[0]).toBe("/a");
    expect(c.workspaceRoots[1]?.endsWith("/b")).toBe(true);
    expect(c.workspaceRoots[1]?.startsWith("~")).toBe(false);
  });

  it("uses XDG dirs for theme and state", () => {
    const c = loadConfig({ XDG_CONFIG_HOME: "/cfg", XDG_STATE_HOME: "/st" });
    expect(c.themeFile).toBe("/cfg/awui/theme.yml");
    expect(c.themeFileExplicit).toBe(false);
    expect(c.stateDir).toBe("/st/awui");
  });
});

describe("omp environment isolation", () => {
  it("strips Pi's overrides and maps omp's own onto omp's names", () => {
    const base = { PATH: "/bin", PI_CODING_AGENT_DIR: "/pi", PI_CODING_AGENT_SESSION_DIR: "/pi-s", OMP_AGENT_DIR: "/o" };
    expect(buildOmpEnv(base, null, null)).toEqual({ PATH: "/bin" });
    expect(buildOmpEnv(base, "/o", "/o-s")).toEqual({ PATH: "/bin", PI_CODING_AGENT_DIR: "/o", PI_CODING_AGENT_SESSION_DIR: "/o-s" });
  });
});

describe("agent event normalization", () => {
  it("maps streaming, tools, queue, and settle events", () => {
    expect(normalizeAgentEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "hm" } }, "agent_settled")).toEqual([
      { type: "assistant_delta", field: "thinking", delta: "hm" },
    ]);
    expect(normalizeAgentEvent({ type: "tool_execution_end", toolCallId: "1", result: { content: [{ type: "text", text: "ok" }] }, isError: false }, "x")).toEqual([
      { type: "tool_end", toolCallId: "1", output: "ok", isError: false },
    ]);
    expect(normalizeAgentEvent({ type: "retry_fallback_applied", from: "anthropic/opus", to: "openai/gpt", role: "default", reason: "Rate limited" }, "x")).toEqual([
      { type: "notice", level: "warning", text: "Switched anthropic/opus to openai/gpt: Rate limited" },
    ]);
    expect(normalizeAgentEvent({ type: "retry_fallback_applied" }, "x")).toEqual([{ type: "notice", level: "warning", text: "Switched another model" }]);
    expect(normalizeAgentEvent({ type: "agent_settled" }, "agent_settled")).toEqual([{ type: "settled" }]);
    expect(normalizeAgentEvent({ type: "session_settled" }, "session_settled")).toEqual([{ type: "settled" }]);
    expect(normalizeAgentEvent({ type: "agent_end" }, "agent_settled")).toEqual([]);
    expect(normalizeAgentEvent({ type: "message_end", message: { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" } }, "x")).toEqual([
      { type: "assistant_end", text: "", thinking: "", error: "boom" },
    ]);
  });

  it("rebuilds the active branch with tool results attached", () => {
    const items = historyToItems([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "thinking", thinking: "t" }, { type: "text", text: "a" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }] },
      { role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "data" }], isError: false },
      { role: "compactionSummary", summary: "s" },
      { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: {} }] },
    ]);
    expect(items.map((i) => i.kind)).toEqual(["user", "assistant", "tool", "notice", "tool"]);
    expect(items[2]).toMatchObject({ status: "done", output: "data" });
    // A call the transcript never got a result for is over, and says why instead of spinning.
    // OpenCode's shell result carries its exit in the details; a bash result without one stays without.
    const withExit = historyToItems([
      { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "shell", arguments: { command: "echo hi" } }] },
      { role: "toolResult", toolCallId: "c3", content: [{ type: "text", text: "hi\n" }], isError: false, details: { exit: 0 } },
      { role: "assistant", content: [{ type: "toolCall", id: "c4", name: "bash", arguments: { command: "ls" } }] },
      { role: "toolResult", toolCallId: "c4", content: [{ type: "text", text: "x" }], isError: false },
    ]);
    expect(withExit[0]).toMatchObject({ name: "shell", status: "done", exitCode: 0 });
    expect(withExit[1]).not.toHaveProperty("exitCode");
    expect(items[4]).toMatchObject({ status: "done", output: NO_RESULT_TEXT });
  });

  it("categorizes tools for per-turn counts", () => {
    const cases: Record<string, string> = {
      read: "read", view: "read", edit: "edit", ast_edit: "edit", apply_patch: "edit", write: "write",
      bash: "command", eval: "command", grep: "search", glob: "search", find: "search", ast_grep: "search",
      ls: "search", web_search: "web", web_fetch: "web", ask: "other", todo: "other",
    };
    for (const [name, category] of Object.entries(cases)) expect(toolCategory(name), name).toBe(category);
  });

  it("summarizes calls by command, path, or query and lists paths", () => {
    expect(toolSummary({ command: "npm  test\n--watch" })).toBe("npm test --watch");
    expect(toolSummary({ path: "src/a.ts" })).toBe("src/a.ts");
    expect(toolSummary({ paths: ["a", "b", "c"] })).toBe("a +2");
    expect(toolSummary({ pattern: "TODO" })).toBe("TODO");
    // Searches say what they look for, and where unless it is the working directory.
    expect(toolSummary({ pattern: "*.gguf", target: "files", path: "." })).toBe("*.gguf");
    expect(toolSummary({ pattern: "TODO", path: "src" })).toBe("TODO in src");
    expect(toolPaths({ pattern: "x", target: "content", path: "." })).toEqual(["."]);
    expect(toolPaths({ target: "docs/README.md" })).toEqual(["docs/README.md"]);
    expect(toolPaths({ file_path: "/x/y.ts", edits: [{ path: "z.ts" }, "w.ts"] })).toEqual(["/x/y.ts", "z.ts", "w.ts"]);
    expect(toolPaths("nope")).toEqual([]);
    // A tool device or a URL names no workspace file: it must not read as a changed file.
    expect(toolPaths({ path: "xd://render_html", content: "{}" })).toEqual([]);
    expect(toolPaths({ path: "https://example.com/x" })).toEqual([]);
    // omp's patch block names its file in the header: the header shows the file, not the JSON.
    expect(toolSummary({ i: "do it", input: "[src/a.ts#AB12]\nPUT 1.=2:\n+x\n" })).toBe("src/a.ts");
    expect(toolPaths({ i: "do it", input: "[src/a.ts#AB12]\nPUT 1.=2:\n+x\n" })).toEqual(["src/a.ts"]);
  });

  it("sums up a todo call in words, not its JSON", () => {
    const todos = [
      { content: "a", status: "completed" },
      { content: "b", status: "in_progress", activeForm: "Doing b" },
      { content: "c", status: "pending" },
    ];
    expect(toolSummary({ todos })).toBe("1/3 todos done · Doing b");
    expect(toolSummary({ _i: "x", ops: [{ op: "init", list: [{ phase: "P", items: ["a", "b"] }, { phase: "Q", items: ["c"] }] }] })).toBe("Planned 3 tasks");
    expect(toolSummary({ ops: [{ op: "done", task: "a" }, { op: "done", task: "b" }] })).toBe("Done: a, b");
    expect(toolSummary({ op: "init", list: [{ phase: "Fix", items: ["one"] }] })).toBe("Planned 1 task");
    // Pi's flat init, and the op a model left out.
    expect(toolSummary({ op: "init", items: ["a", "b"] })).toBe("Planned 2 tasks");
    expect(toolSummary({ list: [{ phase: "P", items: ["a"] }] })).toBe("Planned 1 task");
    expect(toolSummary({ items: ["a"], phase: "P" })).toBe("Added 1 task");
    // rpiv-todo's `todo`: one action on a numbered list, not a whole-list payload.
    expect(toolSummary({ action: "create", subject: "Ship the diff view" }, "todo")).toBe("Added a todo: Ship the diff view");
    expect(toolSummary({ action: "create", tasks: [{ subject: "a" }, { subject: "b" }] }, "todo")).toBe("Added 2 todos");
    expect(toolSummary({ action: "update", id: 2, status: "in_progress" }, "todo")).toBe("Updated #2 to in progress");
    expect(toolSummary({ action: "get", id: 3 }, "todo")).toBe("Read #3");
    expect(toolSummary({ action: "delete", id: 3 }, "todo")).toBe("Deleted #3");
    expect(toolSummary({ action: "list" }, "todo")).toBe("Listed the todos");
    expect(toolSummary({ action: "clear" }, "todo")).toBe("Cleared the todos");
    // A create with no subject still says what it did, and claims nothing it was not given.
    expect(toolSummary({ action: "create", subject: "" }, "todo")).toBe("Added a todo");
    // Another tool's `action` is its own: bg_task, memory, and subagent take create, list, update, clear too.
    expect(toolSummary({ action: "list" }, "bg_status")).not.toMatch(/todo/);
    expect(toolSummary({ action: "clear" }, "bg_task")).not.toMatch(/todo/);
    expect(toolSummary({ action: "update", content: "x" }, "memory")).not.toMatch(/todo/);
    expect(toolSummary({ action: "list" })).not.toMatch(/todo/);
    expect(toolCategory("todo_write")).toBe("other");
  });

  it("reads a Pi chat's todos from its newest todo result", () => {
    const result = (details: unknown, isError = false) => ({ role: "toolResult", toolName: "todo", isError, details });
    const phases = (status: string) => [{ name: "Tasks", tasks: [{ content: "Inspect", status }] }];
    expect(piTodos([])).toEqual([]);
    expect(
      piTodos([
        result({ op: "init", phases: phases("in_progress") }),
        { role: "assistant", content: [] },
        result({ op: "done", phases: phases("completed") }),
        result({ op: "done" }, true),
      ]),
    ).toEqual([{ phase: "Tasks", text: "Inspect", status: "completed" }]);
    // Pi's example extension keeps `{text, done}`.
    expect(piTodos([result({ todos: [{ id: 1, text: "a", done: true }, { id: 2, text: "b", done: false }] })])).toEqual([
      { text: "a", status: "completed" },
      { text: "b", status: "pending" },
    ]);
    // rpiv-todo (`@ssk_dev/rpiv-todo-lean`): `{action, params, tasks: [{id, subject, status}], nextId}`, tombstones hidden.
    expect(
      piTodos([
        result({
          action: "update",
          params: { action: "update", id: 2, status: "in_progress" },
          tasks: [
            { id: 1, subject: "Read the code", status: "completed" },
            { id: 2, subject: "Write the fix", status: "in_progress" },
            { id: 3, subject: "Gone", status: "deleted" },
            { id: 4, subject: "Run the tests", status: "pending" },
          ],
          nextId: 5,
        }),
      ]),
    ).toEqual([
      { text: "Read the code", status: "completed" },
      { text: "Write the fix", status: "in_progress" },
      { text: "Run the tests", status: "pending" },
    ]);
    // An op result with no `tasks` (an older build) keeps the newer shapes from being read as this one.
    expect(piTodos([result({ op: "done" })])).toEqual([]);
  });

  it("takes an edit's count from its output only in the bracketed form", () => {
    expect(outputDiffStat("Edited src/app.ts (+1 -1)")).toEqual({ added: 1, removed: 1 });
    expect(outputDiffStat("# Fake README\nhello")).toBeNull();
    // Code the output quotes is no count.
    expect(outputDiffStat("  12→  i = x+1-2;")).toBeNull();
  });

  it("shows an edit's patch block verbatim instead of raw JSON", () => {
    const patch = "[f#AB12]\nSWAP 21.=22:\n+theme: \n+  dark: x\n";
    expect(stringifyArgs({ i: "do it", input: patch }, true)).toBe(patch);
    expect(stringifyArgs({ i: "do it", input: patch })).toContain('"input"');
    expect(stringifyArgs({ path: "f.ts" }, true)).toContain("f.ts");
  });

  it("keeps harness timestamps on rebuilt history", () => {
    const items = historyToItems([
      { role: "user", content: "hi", timestamp: 1000 },
      { role: "assistant", content: [{ type: "toolCall", id: "c", name: "edit", arguments: { path: "f.ts" } }], timestamp: 2000 },
      { role: "toolResult", toolCallId: "c", content: [], isError: false, timestamp: 5000 },
    ]);
    expect(items[0]).toMatchObject({ at: 1000 });
    expect(items[1]).toMatchObject({ kind: "tool", category: "edit", summary: "f.ts", paths: ["f.ts"], at: 2000, endedAt: 5000 });
  });

  it("bounds text by keeping head and tail", () => {
    const b = boundText("a".repeat(10_000) + "b".repeat(10_000), 1000);
    expect(b.truncated).toBe(true);
    expect(b.text.length).toBeLessThan(1100);
    expect(b.text.startsWith("a")).toBe(true);
    expect(b.text.endsWith("b")).toBe(true);
  });

});

describe("extension messages", () => {
  // pi-book's recall, as Pi stores it (customType book-recall, display: true).
  const recall = "<memory>\nYour memory book: notes about the user and this project.\n- prefers tabs\n</memory>";

  it("shows an envelope as its tag's label, the first line as summary, and the inside as detail", () => {
    expect(extensionMessage("book-recall", recall)).toEqual({
      title: "Memory",
      text: "Your memory book: notes about the user and this project.",
      detail: "Your memory book: notes about the user and this project.\n- prefers tabs",
    });
    // No envelope: the customType names it.
    expect(extensionMessage("book-recall", "plain words\nmore")).toEqual({ title: "Book recall", text: "plain words", detail: "plain words\nmore" });
    expect(extensionMessage("x", "  ")).toBeNull();
  });

  it("reaches the chat the same way live and from history", () => {
    const live = normalizeAgentEvent({ type: "message_start", message: { role: "custom", customType: "book-recall", display: true, content: recall } }, "agent_settled");
    expect(live).toEqual([{ type: "notice", level: "info", title: "Memory", text: "Your memory book: notes about the user and this project.", detail: expect.stringContaining("- prefers tabs") }]);
    const stored = historyToItems([{ role: "custom", customType: "book-recall", display: true, content: recall, timestamp: 1 }]);
    expect(stored[0]).toMatchObject({ kind: "notice", title: "Memory", detail: expect.not.stringContaining("<memory>") });
    // A hidden one (display: false) stays out of the chat.
    expect(historyToItems([{ role: "custom", customType: "book-recall", display: false, content: recall }])).toEqual([]);
  });
});
