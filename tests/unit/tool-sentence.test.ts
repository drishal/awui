import { describe, expect, it } from "vitest";
import type { ToolItem } from "../../src/shared/protocol.js";
import { callTime, errorLine, orchestrationTool, toolSentence, toolWords } from "../../src/web/tool-sentence.js";

const WS = "/home/me/proj";
function tool(over: Partial<ToolItem> & Pick<ToolItem, "name" | "category">): ToolItem {
  return { kind: "tool", id: "t1", args: "{}", status: "done", output: "", truncated: false, summary: "", paths: [], ...over };
}
const args = (o: object) => JSON.stringify(o);

describe("toolWords", () => {
  it("turns snake, kebab and camel case into words", () => {
    expect(toolWords("list_issues")).toBe("list issues");
    expect(toolWords("resolve-library-id")).toBe("resolve library id");
    expect(toolWords("getPullRequest")).toBe("get pull request");
  });
});

describe("toolSentence: read", () => {
  const read = tool({ name: "read", category: "read", paths: [`${WS}/src/app.ts`], output: "a\nb\nc\n" });
  it("words the three states", () => {
    expect(toolSentence({ ...read, status: "running", output: "" }, WS).text).toBe("Reading src/app.ts");
    expect(toolSentence(read, WS).text).toBe("Read src/app.ts");
    expect(toolSentence({ ...read, status: "error", output: "ENOENT: no such file\nmore" }, WS).text).toBe("Couldn't read src/app.ts");
  });
  it("counts lines and says partial for a cut output", () => {
    expect(toolSentence(read, WS).facts).toEqual(["3 lines"]);
    expect(toolSentence({ ...read, truncated: true }, WS).facts).toEqual(["partial"]);
    expect(toolSentence({ ...read, output: "" }, WS).facts).toEqual([]);
  });
  it("keeps a path outside the project whole", () => {
    expect(toolSentence({ ...read, paths: ["/etc/hosts"] }, WS).target).toBe("/etc/hosts");
  });
  it("gives the error's first line on a failure and no facts", () => {
    const s = toolSentence({ ...read, status: "error", output: "\nENOENT: no such file\nat x" }, WS);
    expect(s.error).toBe("ENOENT: no such file");
    expect(s.facts).toEqual([]);
  });
});

describe("toolSentence: search", () => {
  const search = tool({ name: "grep", category: "search", args: args({ pattern: "quokka", path: `${WS}/src` }), output: "src/a.ts:1:quokka\nsrc/b.ts:2:quokka\n" });
  it("words the three states with the directory", () => {
    expect(toolSentence({ ...search, status: "running" }, WS).text).toBe("Searching for quokka in src");
    expect(toolSentence(search, WS).text).toBe("Searched for quokka in src");
    expect(toolSentence({ ...search, status: "error" }, WS).text).toBe("Couldn't search for quokka in src");
  });
  it("counts results, says no results, and does not count a cut output", () => {
    expect(toolSentence(search, WS).facts).toEqual(["2 results in 2 files"]);
    expect(toolSentence({ ...search, output: "x\n" }, WS).facts).toEqual(["1 result"]);
    expect(toolSentence({ ...search, output: "" }, WS).facts).toEqual(["no results"]);
    expect(toolSentence({ ...search, truncated: true }, WS).facts).toEqual([]);
    expect(toolSentence({ ...search, status: "running", output: "" }, WS).facts).toEqual([]);
  });
  it("leaves out the directory when it is the project itself", () => {
    expect(toolSentence({ ...search, args: args({ pattern: "x", path: WS }) }, WS).rest).toBeUndefined();
    expect(toolSentence({ ...search, args: args({ pattern: "x", path: "." }) }, WS).rest).toBeUndefined();
  });
});

describe("toolSentence: edit and write", () => {
  const edit = tool({ name: "edit", category: "edit", paths: [`${WS}/src/turns.ts`], diffStat: { added: 12, removed: 3 } });
  it("words edit and shows +a −r", () => {
    expect(toolSentence({ ...edit, status: "running" }, WS).text).toBe("Editing src/turns.ts");
    expect(toolSentence(edit, WS).text).toBe("Edited src/turns.ts");
    expect(toolSentence({ ...edit, status: "error" }, WS).text).toBe("Couldn't edit src/turns.ts");
    expect(toolSentence(edit, WS).facts).toEqual(["+12 −3"]);
    expect(toolSentence({ ...edit, diffStat: { added: 0, removed: 2 } }, WS).facts).toEqual(["−2"]);
    expect(toolSentence({ ...edit, diffStat: undefined }, WS).facts).toEqual([]);
  });
  it("words write and shows +a lines", () => {
    const write = tool({ name: "write", category: "write", paths: [`${WS}/notes.md`], diffStat: { added: 4, removed: 0 } });
    expect(toolSentence({ ...write, status: "running" }, WS).text).toBe("Writing notes.md");
    expect(toolSentence(write, WS).text).toBe("Wrote notes.md");
    expect(toolSentence({ ...write, status: "error" }, WS).text).toBe("Couldn't write notes.md");
    expect(toolSentence(write, WS).facts).toEqual(["+4"]);
  });
});

describe("toolSentence: commands", () => {
  const bash = tool({ name: "bash", category: "command", args: args({ command: "npm test" }), output: "a\nb" });
  it("words the three states", () => {
    expect(toolSentence({ ...bash, status: "running" }, WS).text).toBe("Running npm test");
    expect(toolSentence(bash, WS).text).toBe("Ran npm test");
    expect(toolSentence({ ...bash, status: "error" }, WS).text).toBe("Couldn't run npm test");
  });
  it("counts output lines, or says no output", () => {
    expect(toolSentence(bash, WS).facts).toEqual(["2 lines"]);
    expect(toolSentence({ ...bash, output: "" }, WS).facts).toEqual(["no output"]);
    expect(toolSentence({ ...bash, status: "running", output: "" }, WS).facts).toEqual([]);
  });
  it("says exit N when the harness reported one, else the line count", () => {
    // OpenCode's shell result carries metadata.exit; Pi/omp/Claude bash results carry none.
    expect(toolSentence({ ...bash, exitCode: 0 }, WS).facts).toEqual(["2 lines"]);
    expect(toolSentence({ ...bash, exitCode: 2 }, WS).facts).toEqual(["exit 2"]);
    expect(toolSentence({ ...bash, status: "error", output: "boom", exitCode: 1 }, WS).facts).toEqual(["exit 1"]);
    // A parsed test run still wins over the bare code: the summary says more.
    expect(toolSentence({ ...bash, output: " Tests  1 failed | 1 passed (2)", exitCode: 1 }, WS).facts).toEqual(["1 passed", "1 failed"]);
  });
  it("takes the first line, skips a leading comment, and cuts at 60 characters", () => {
    expect(toolSentence({ ...bash, args: args({ command: "# check it\nrg -n listen src\nwc -l" }) }, WS).target).toBe("rg -n listen src");
    const long = toolSentence({ ...bash, args: args({ command: `echo ${"x".repeat(100)}` }) }, WS).target;
    expect(long).toHaveLength(60);
    expect(long.endsWith("…")).toBe(true);
  });
  it("falls back to the item's summary when the arguments do not parse", () => {
    expect(toolSentence({ ...bash, args: "not json", summary: "ls -la" }, WS).target).toBe("ls -la");
  });
});

describe("toolSentence: web", () => {
  it("fetches a host and path", () => {
    const fetch = tool({ name: "web_fetch", category: "web", args: args({ url: "https://example.com/docs/listen?x=1" }), output: "Example" });
    expect(toolSentence({ ...fetch, status: "running" }, WS).text).toBe("Fetching example.com/docs/listen");
    expect(toolSentence(fetch, WS).text).toBe("Fetched example.com/docs/listen");
    expect(toolSentence({ ...fetch, status: "error" }, WS).text).toBe("Couldn't fetch example.com/docs/listen");
    expect(toolSentence(fetch, WS).facts).toEqual([]);
  });
  it("searches the web for a query", () => {
    const search = tool({ name: "web_search", category: "web", args: args({ query: "quokka facts" }) });
    expect(toolSentence({ ...search, status: "running" }, WS).text).toBe("Searching the web for quokka facts");
    expect(toolSentence(search, WS).text).toBe("Searched the web for quokka facts");
    expect(toolSentence({ ...search, status: "error" }, WS).text).toBe("Couldn't search the web for quokka facts");
  });
});

describe("toolSentence: MCP, agents, plan, unknown", () => {
  it("names an MCP call by its server and the tool's words", () => {
    const mcp = tool({ name: "mcp__linear__list_issues", category: "other" });
    expect(toolSentence({ ...mcp, status: "running" }, WS).text).toBe("Asking linear: list issues");
    expect(toolSentence(mcp, WS).text).toBe("Asked linear: list issues");
    expect(toolSentence({ ...mcp, status: "error" }, WS).text).toBe("Couldn't ask linear: list issues");
    expect(toolSentence(mcp, WS).code).toBe(false);
  });
  it("counts agents and their states", () => {
    const run = (agent: string, status: "done" | "failed" | "running") => ({ id: agent, agent, task: "t", status });
    const agents = tool({ name: "subagent", category: "agent", subagents: { runs: [run("scout", "done"), run("worker", "done"), run("critic", "running")] } });
    expect(toolSentence({ ...agents, status: "running" }, WS).text).toBe("Running 3 agents: scout, worker, critic");
    expect(toolSentence(agents, WS).text).toBe("Ran 3 agents: scout, worker, critic");
    expect(toolSentence(agents, WS).facts).toEqual(["2 done", "1 running"]);
    expect(toolSentence({ ...agents, status: "error" }, WS).text).toBe("Couldn't run 3 agents: scout, worker, critic");
    expect(toolSentence({ ...agents, subagents: { runs: [run("scout", "failed")] } }, WS).facts).toEqual(["1 failed"]);
  });
  it("updates the plan and counts finished steps from a whole list", () => {
    const todos = [{ content: "a", status: "completed" }, { content: "b", status: "in_progress" }, { content: "c", status: "pending" }];
    const plan = tool({ name: "TodoWrite", category: "other", args: args({ todos }) });
    expect(toolSentence({ ...plan, status: "running" }, WS).text).toBe("Updating the plan (3 steps)");
    expect(toolSentence(plan, WS).text).toBe("Updated the plan (3 steps)");
    expect(toolSentence(plan, WS).facts).toEqual(["1 of 3 done"]);
    expect(toolSentence({ ...plan, status: "error" }, WS).text).toBe("Couldn't update the plan (3 steps)");
  });
  it("shows no step count for a todo call that is not a whole list", () => {
    const ops = tool({ name: "todo_write", category: "other", args: args({ ops: [{ op: "done", task: "a" }] }) });
    expect(toolSentence(ops, WS).text).toBe("Updated the plan");
    expect(toolSentence(ops, WS).facts).toEqual([]);
  });
  it("words rpiv-todo's todo by its action, not as the whole plan", () => {
    const todo = (call: object, status: "running" | "done" | "error" = "done") => toolSentence({ ...tool({ name: "todo", category: "other", args: args(call) }), status }, WS);
    expect(todo({ action: "create", subject: "Ship the diff view" }).text).toBe("Added a todo: Ship the diff view");
    expect(todo({ action: "create", tasks: [{ subject: "a" }, { subject: "b" }, { subject: "c" }] }).text).toBe("Added 3 todos");
    expect(todo({ action: "update", id: 2, status: "in_progress" }).text).toBe("Updated #2 to in progress");
    expect(todo({ action: "update", id: 2, status: "in_progress" }, "running").text).toBe("Updating #2 to in progress");
    expect(todo({ action: "delete", id: 3 }, "error").text).toBe("Couldn't delete #3");
    expect(todo({ action: "get", id: 3 }).text).toBe("Read #3");
    expect(todo({ action: "list" }).text).toBe("Listed the todos");
    expect(todo({ action: "clear" }).text).toBe("Cleared the todos");
    // No count to claim: the list itself is the status stack's, not this call's.
    expect(todo({ action: "update", id: 2, status: "completed" }).facts).toEqual([]);
    // An `action` this tool does not take stays a plan call.
    expect(toolSentence(tool({ name: "todo", category: "other", args: args({ action: "rewind" }) }), WS).text).toBe("Updated the plan");
    // Another tool's `action` is not a todo's.
    expect(toolSentence(tool({ name: "bg_status", category: "other", args: args({ action: "list" }) }), WS).text).not.toMatch(/todo/);
    expect(toolSentence(tool({ name: "memory", category: "other", args: args({ action: "update", content: "x" }) }), WS).text).not.toMatch(/todo/);
  });
  it("uses an unknown tool by its words and invents no fact", () => {
    const odd = tool({ name: "lspDiagnostics", category: "other", output: "a\nb\nc" });
    expect(toolSentence({ ...odd, status: "running" }, WS).text).toBe("Using lsp diagnostics");
    expect(toolSentence(odd, WS).text).toBe("Used lsp diagnostics");
    expect(toolSentence({ ...odd, status: "error" }, WS).text).toBe("Couldn't use lsp diagnostics");
    expect(toolSentence(odd, WS).facts).toEqual([]);
  });
  it("reads a plain output as lines and claims no more", () => {
    const bash = tool({ name: "bash", category: "command", args: args({ command: "npm test" }), output: "a\nb" });
    expect(toolSentence(bash, WS).facts).toEqual(["2 lines"]);
    expect(toolSentence({ ...bash, status: "error" }, WS).facts).toEqual([]);
  });
});

describe("helpers", () => {
  it("cuts a long error line", () => {
    expect(errorLine("x".repeat(300))).toHaveLength(140);
    expect(errorLine("\n  \n")).toBeUndefined();
  });
  it("finds the line that says why, not a command's banner", () => {
    expect(errorLine("Running 1 test using 1 worker\n  ✘ 1 failed\n  Error: port 4791 is already in use\n  at global-setup.ts:71")).toBe("Error: port 4791 is already in use");
    expect(errorLine("compiling...\nsegmentation fault")).toBe("segmentation fault");
    // A grep -c that found nothing exits 1 with "0": no reason to show.
    expect(errorLine("0\n")).toBeUndefined();
  });
  it("leaves out the cd into the project a command starts with", () => {
    const bash = (command: string) => toolSentence(tool({ name: "bash", category: "command", args: args({ command }), output: "" }), WS).target;
    expect(bash("cd /home/me/app && git status --short")).toBe("git status --short");
    expect(bash('cd "/tmp/a b"; cd src && ls')).toBe("ls");
    expect(bash("cdk deploy")).toBe("cdk deploy");
  });
  it("words a call's time", () => {
    expect(callTime(760)).toBe("760ms");
    expect(callTime(1200)).toBe("1.2s");
    expect(callTime(38_000)).toBe("38s");
  });
});

describe("calls about background jobs", () => {
  const job = { id: "bg_1", kind: "shell" as const, status: "running" as const, label: "npm run test:e2e", title: "Running the e2e suite" };
  const call = (name: string, extra: Partial<ToolItem>) => ({ kind: "tool" as const, id: "t:1", name, args: "{}", status: "done" as const, output: "", truncated: false, category: "other" as const, summary: "", paths: [], ...extra });
  it("names a wait's job by its id and what it is for", () => {
    expect(toolSentence(call("wait", { status: "running", jobs: [job] }), "/w").text).toBe("Waiting on bg_1: Running the e2e suite");
    expect(toolSentence(call("wait", { jobs: [job, { ...job, id: "bg_2", status: "done" }] }), "/w")).toMatchObject({ text: "Waited on 2 jobs", facts: ["1 of 2 finished"] });
  });
  it("says a command was left running in the background, as which job", () => {
    expect(toolSentence(call("bash", { category: "command", args: JSON.stringify({ command: "npm run test:e2e" }), jobs: [job] }), "/w").facts).toEqual(["in background · bg_1"]);
  });
});

describe("the orchestration surface", () => {
  const call = (name: string, a: object = {}, extra: Partial<ToolItem> = {}) => tool({ name, category: "other", args: args(a), ...extra });
  it("names the tool whichever bridge carried it, and nothing else", () => {
    expect(orchestrationTool("delegate_task")).toBe("delegate_task");
    expect(orchestrationTool("mcp__awui-orchestrate__thread_wait")).toBe("thread_wait");
    // The render server's tool and an ordinary MCP tool are not the orchestration surface.
    expect(orchestrationTool("mcp__awui__render_html")).toBeUndefined();
    expect(orchestrationTool("mcp__github__list_issues")).toBeUndefined();
    expect(orchestrationTool("read")).toBeUndefined();
  });
  it("words a delegation as who it went to, with the task's title", () => {
    const delegation = call("delegate_task", { brief: "Summarise the readme\nand its links", harness: "pi", title: "Readme summary" });
    expect(toolSentence(delegation, WS).text).toBe("Delegated to pi: Readme summary");
    expect(toolSentence({ ...delegation, status: "running" }, WS).text).toBe("Delegating to pi: Readme summary");
    expect(toolSentence({ ...delegation, status: "error" }, WS).text).toBe("Couldn't delegate to pi: Readme summary");
    // No harness named: a profile, else any agent; no title: the brief's first line.
    expect(toolSentence(call("delegate_task", { brief: "Check the lockfile" }), WS).text).toBe("Delegated to another agent: Check the lockfile");
    expect(toolSentence(call("delegate_task", { brief: "x", profile: "reviewer" }), WS).target).toBe("reviewer");
    // The MCP spelling reads the same as the extension's.
    expect(toolSentence(call("mcp__awui-orchestrate__delegate_task", { brief: "x", harness: "omp" }), WS).text).toBe("Delegated to omp: x");
  });
  it("names the task each follow-up call touched", () => {
    const mcp = (name: string, a: object) => call(`mcp__awui-orchestrate__${name}`, a);
    expect(toolSentence(call("task_status", { taskId: "ab12" }), WS).text).toBe("Checked task ab12");
    expect(toolSentence(call("task_status"), WS).text).toBe("Checked its tasks");
    expect(toolSentence(call("task_cancel", { taskId: "ab12" }), WS).text).toBe("Stopped task ab12");
    expect(toolSentence(call("thread_send", { taskId: "ab12", text: "go on" }), WS).text).toBe("Messaged task ab12");
    expect(toolSentence(mcp("thread_read", { taskId: "ab12" }), WS).text).toBe("Read task ab12");
    expect(toolSentence(mcp("thread_wait", { taskIds: ["ab12", "cd34"] }), WS).text).toBe("Waited on 2 tasks");
    expect(toolSentence({ ...mcp("thread_wait", { taskIds: ["ab12"] }), status: "running" }, WS).text).toBe("Waiting on task ab12");
    expect(toolSentence(call("list_profiles"), WS).text).toBe("Listed the agents");
  });
});
