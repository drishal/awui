// A tool call worded as a sentence the way a person would report the work:
// "Read src/app.ts", "Searching for quokka in src", "Couldn't run npm test".
// Running uses the present participle, done the past tense, a failure "Couldn't …".
// The facts beside it ("412 lines", "+12 −3") are only what the item itself holds;
// nothing is guessed, so a call this module cannot read shows just its time.
// Pure, so the web tool card and its unit tests share it. atui keeps its own verb
// table (neat.ts) because the terminal prints it differently.
import type { ToolItem } from "../shared/protocol.js";
import { toolArgs, toolFacts } from "./tool-facts.js";
import { formatSpan } from "./turn-time.js";
import { relativePath } from "./turns.js";

export interface ToolSentence {
  /** "Read", "Searching for", "Couldn't read". */
  verb: string;
  /** What it acted on: a path, a pattern, a command, a server. */
  target: string;
  /** What follows the target: "in src", ": list issues", "(7 steps)". */
  rest?: string;
  /** True when the target is code (a path, a pattern, a command) and reads in the mono face. */
  code: boolean;
  /** What is known of the result: ["412 lines"]. Empty when nothing can be said. */
  facts: string[];
  /** The first line of the failure, for a call that errored. */
  error?: string;
  /** The whole sentence as plain words, for a name and for the live phase. */
  text: string;
}

type Args = Record<string, unknown>;
type Tense = "running" | "done" | "error";

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const COMMAND_CUT = 60;
const ERROR_CUT = 140;

/** `list_issues`, `listIssues`, `list-issues` → "list issues". */
export function toolWords(name: string): string {
  return name
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .split(/[_\-.\s]+/)
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

/** An MCP tool's name, `mcp__<server>__<tool>`, split in two. */
function mcpParts(name: string): { server: string; tool: string } | undefined {
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  return m ? { server: m[1] as string, tool: m[2] as string } : undefined;
}

/** Output lines, not counting the newline that ends it. */
function lineCount(output: string): number {
  const trimmed = output.replace(/\n+$/, "");
  return trimmed ? trimmed.split("\n").length : 0;
}

/** Words a failure's own line carries; a command's first line is usually its banner ("Running 1 test"), not the reason. */
const ERROR_WORDS = /\b(error|errors|fail(ed|ure)?|fatal|exception|denied|not found|no such|cannot|can't|unable|invalid|timed? ?out|refused|panic)\b/i;

/**
 * The line that says why a call failed, cut to a line a row can carry: the last line naming an error, else
 * the last line. A line too short to say anything (a `grep -c`'s "0") is no reason, and none is shown.
 */
export function errorLine(output: string): string | undefined {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.findLast((l) => ERROR_WORDS.test(l)) ?? lines[lines.length - 1];
  if (!line || !/[a-z]{3}/i.test(line)) return undefined;
  return line.length > ERROR_CUT ? `${line.slice(0, ERROR_CUT - 1)}…` : line;
}

/** A command's first line worth showing: the model's leading `# note` lines are skipped, a shebang is not a note. Cut to 60 characters. */
function commandLine(cmd: string): string {
  const lines = cmd.split("\n").map((l) => l.trim()).filter(Boolean);
  // Agents start most commands by changing into the project ("cd /home/me/app && …"); the row says what ran, not where.
  const line = (lines.find((l) => !l.startsWith("#") || l.startsWith("#!")) ?? lines[0] ?? "").replace(/^(?:cd\s+(?:"[^"]*"|'[^']*'|\S+)\s*(?:&&|;)\s*)+/, "");
  return line.length > COMMAND_CUT ? `${line.slice(0, COMMAND_CUT - 1)}…` : line;
}

function hostAndPath(url: string): string {
  return url.replace(/^[a-z][a-z\d+.-]*:\/\//i, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
}

const VERBS: Record<string, Record<Tense, string>> = {
  read: { running: "Reading", done: "Read", error: "Couldn't read" },
  search: { running: "Searching for", done: "Searched for", error: "Couldn't search for" },
  edit: { running: "Editing", done: "Edited", error: "Couldn't edit" },
  write: { running: "Writing", done: "Wrote", error: "Couldn't write" },
  command: { running: "Running", done: "Ran", error: "Couldn't run" },
  fetch: { running: "Fetching", done: "Fetched", error: "Couldn't fetch" },
  websearch: { running: "Searching the web for", done: "Searched the web for", error: "Couldn't search the web for" },
  mcp: { running: "Asking", done: "Asked", error: "Couldn't ask" },
  agents: { running: "Running", done: "Ran", error: "Couldn't run" },
  // Background jobs: a wait on them, a look at their list, one stopped.
  jobwait: { running: "Waiting on", done: "Waited on", error: "Couldn't wait on" },
  joblist: { running: "Checking", done: "Checked", error: "Couldn't check" },
  jobstop: { running: "Stopping", done: "Stopped", error: "Couldn't stop" },
  jobstart: { running: "Starting", done: "Started", error: "Couldn't start" },
  plan: { running: "Updating", done: "Updated", error: "Couldn't update" },
  // rpiv-todo's `todo`: one action on a numbered list, each worded as what it did.
  todo_create: { running: "Adding", done: "Added", error: "Couldn't add" },
  todo_update: { running: "Updating", done: "Updated", error: "Couldn't update" },
  todo_delete: { running: "Deleting", done: "Deleted", error: "Couldn't delete" },
  todo_get: { running: "Reading", done: "Read", error: "Couldn't read" },
  todo_list: { running: "Listing", done: "Listed", error: "Couldn't list" },
  todo_clear: { running: "Clearing", done: "Cleared", error: "Couldn't clear" },
  render: { running: "Rendering", done: "Rendered", error: "Couldn't render" },
  other: { running: "Using", done: "Used", error: "Couldn't use" },
};

/** "412 lines" for the output a read printed; "partial" when the harness cut it. */
function readFacts(item: ToolItem): string[] {
  const n = lineCount(item.output);
  if (n === 0) return [];
  return item.truncated ? ["partial"] : [plural(n, "line")];
}

/** "+12 −3" for an edit, from the diff the harness reported. */
export function changeFact(added: number, removed: number): string | undefined {
  const parts = [added > 0 ? `+${added}` : "", removed > 0 ? `−${removed}` : ""].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

/** The actions rpiv-todo's `todo` takes; any other `action` belongs to another tool. */
const TODO_ACTIONS = new Set(["create", "update", "list", "get", "delete", "clear"]);

/** A todo or plan call in any harness's spelling: Pi/omp's `todo`, Claude's `TodoWrite`, `ExitPlanMode`, `plan_mode_complete`. */
export function isPlanCall(name: string, hasPlan = false): boolean {
  return hasPlan || /todo|exitplanmode|plan_mode|(^|_)plan($|_)/i.test(name);
}

function todoCount(args: Args): { done: number; total: number } | undefined {
  if (!Array.isArray(args.todos)) return undefined;
  const todos = args.todos.filter((t): t is Args => typeof t === "object" && t !== null);
  return { done: todos.filter((t) => /done|complete/.test(String(t.status ?? ""))).length, total: todos.length };
}

/**
 * A call as a sentence. `workspace` makes paths project-relative. What
 * tool-facts.ts read from the output wins; when it read none, the basic counts
 * (lines, results, +a −r) stand in, except on a failure, whose output is the error.
 */
export function toolSentence(item: ToolItem, workspace: string): ToolSentence {
  const parsed = toolFacts(item);
  const tense: Tense = item.status;
  const args = toolArgs(item.args);
  const settled = item.status !== "running";
  const path = item.paths[0] ?? str(args.path) ?? str(args.file_path);
  const rel = (p: string) => relativePath(p, workspace);
  const make = (kind: string, target: string, code: boolean, rest: string | undefined, facts: string[]): ToolSentence => {
    const verb = (VERBS[kind] as Record<Tense, string>)[tense];
    // A failure's output is the error, so output-derived counts are dropped; a reported exit code is
    // metadata, not output, so it still reads beside the reason.
    const known = parsed.facts.length > 0 ? parsed.facts : item.status === "error" ? facts.filter((f) => f.startsWith("exit ")) : facts;
    // A run that finished with a failing test says which one, though the call itself did not fail.
    const error = parsed.error ?? (item.status === "error" ? errorLine(item.output) : undefined);
    const tail = rest ? (rest.startsWith(":") ? rest : ` ${rest}`) : "";
    return { verb, target, ...(rest ? { rest } : {}), code, facts: known, ...(error ? { error } : {}), text: `${verb}${target ? ` ${target}` : ""}${tail}` };
  };

  if (item.subagents) {
    const runs = item.subagents.runs;
    const names = [...new Set(runs.map((r) => r.agent).filter(Boolean))].slice(0, 3);
    const counts = (["done", "failed", "running"] as const).map((s) => [s, runs.filter((r) => r.status === s).length] as const).filter(([, n]) => n > 0);
    return make("agents", plural(runs.length, "agent"), false, names.length > 0 ? `: ${names.join(", ")}` : undefined, counts.map(([s, n]) => `${n} ${s}`));
  }
  if (item.htmlRender) return make("render", item.htmlRender.title, false, undefined, []);

  // A call about background jobs says which: the wait on them, the list looked at, the one stopped or started.
  const jobs = item.jobs ?? [];
  if (jobs.length > 0 && item.category !== "command") {
    const one = jobs.length === 1 ? jobs[0] : undefined;
    // One job is named by its id, then what it is for ("Waiting on bg_1: Running the e2e suite").
    const named = one ? one.id : plural(jobs.length, "job");
    const why = one?.title ? `: ${one.title}` : undefined;
    const finished = jobs.filter((j) => j.status !== "running").length;
    const counts = settled && jobs.length > 1 && finished > 0 ? [`${finished} of ${jobs.length} finished`] : [];
    if (/^(wait|await)$/i.test(item.name)) return make("jobwait", named, Boolean(one), why, counts);
    if (/stop|kill/i.test(item.name) || str(args.action) === "stop") return make("jobstop", named, Boolean(one), why, []);
    if (str(args.action) === "spawn" && one) return make("jobstart", one.title ?? one.label, false, "in the background", [one.id]);
    return make("joblist", jobs.length === 1 ? named : "background jobs", Boolean(one), why, counts.length > 0 ? counts : jobs.length > 1 ? [plural(jobs.length, "job")] : []);
  }

  const mcp = mcpParts(item.name);
  if (mcp) return make("mcp", mcp.server, false, `: ${toolWords(mcp.tool)}`, []);

  // rpiv-todo's `todo` acts on one numbered task, so the row says which action, not "the plan".
  // Other tools take an `action` too (bg_task, memory, subagent), so only a todo tool's is a todo's.
  const todoAction = /todo/i.test(item.name) ? str(args.action) : undefined;
  if (todoAction && TODO_ACTIONS.has(todoAction)) {
    if (todoAction === "list" || todoAction === "clear") return make(`todo_${todoAction}`, "the todos", false, undefined, []);
    if (todoAction === "create") {
      const batch = Array.isArray(args.tasks) ? args.tasks.filter((t) => typeof t === "object" && t !== null).length : 0;
      if (batch > 0) return make("todo_create", plural(batch, "todo"), false, undefined, []);
      const subject = str(args.subject);
      return make("todo_create", "a todo", false, subject ? `: ${subject}` : undefined, []);
    }
    const id = typeof args.id === "number" ? `#${args.id}` : "";
    const status = todoAction === "update" ? str(args.status) : undefined;
    return make(`todo_${todoAction}`, id || "a todo", false, status ? `to ${status.replace(/_/g, " ")}` : undefined, []);
  }

  if (isPlanCall(item.name, item.plan !== undefined)) {
    const todos = todoCount(args);
    return make("plan", "the plan", false, todos ? `(${plural(todos.total, "step")})` : undefined, todos && todos.total > 0 ? [`${todos.done} of ${todos.total} done`] : []);
  }

  switch (item.category) {
    case "read":
      return make("read", path ? rel(path) : item.summary, true, undefined, settled ? readFacts(item) : []);
    case "edit":
    case "write": {
      const stat = item.diffStat ?? item.diff;
      const change = stat ? changeFact(stat.added, stat.removed) : undefined;
      const facts = item.category === "write" ? (stat && stat.added > 0 ? [`+${stat.added}`] : []) : change ? [change] : [];
      return make(item.category, path ? rel(path) : item.summary, true, undefined, settled ? facts : []);
    }
    case "command": {
      const cmd = str(args.command) ?? str(args.cmd) ?? str(args.script) ?? str(args.code) ?? str(args.input) ?? item.summary;
      const n = lineCount(item.output);
      // A reported exit code says more than a line count (OpenCode reports one; a parsed test
      // run still wins, since its summary says the most). Success is the expected case, so a
      // clean 0 keeps the line count and only a failure's code — or any nonzero one — is a word.
      const exit = typeof item.exitCode === "number" && (item.status === "error" || item.exitCode !== 0) ? [`exit ${item.exitCode}`] : [];
      // Left running in the background: the row says so, and as which job.
      const background = item.jobs?.[0];
      if (background) return make("command", commandLine(cmd), true, undefined, settled ? [`in background · ${background.id}`] : []);
      return make("command", commandLine(cmd), true, undefined, settled ? (exit.length > 0 ? exit : [n > 0 ? plural(n, "line") : "no output"]) : []);
    }
    case "search": {
      const pattern = str(args.pattern) ?? str(args.query) ?? str(args.regex) ?? str(args.glob) ?? str(args.name) ?? str(args.q) ?? item.summary;
      const dir = str(args.path) ?? str(args.directory) ?? str(args.dir) ?? item.paths[0];
      const where = dir && rel(dir) !== "." && dir !== workspace ? rel(dir) : undefined;
      const n = lineCount(item.output);
      // A cut output cannot be counted, so it shows no count rather than a wrong one.
      const facts = !settled ? [] : n === 0 ? ["no results"] : item.truncated ? [] : [plural(n, "result")];
      return make("search", pattern, true, where ? `in ${where}` : undefined, facts);
    }
    case "web": {
      const url = str(args.url) ?? (Array.isArray(args.urls) ? str(args.urls[0]) : undefined);
      if (url) return make("fetch", hostAndPath(url), true, undefined, []);
      const query = str(args.query) ?? str(args.q) ?? (Array.isArray(args.queries) ? str(args.queries[0]) : undefined) ?? item.summary;
      return make("websearch", query, false, undefined, []);
    }
    case "agent":
      return make("agents", item.summary || toolWords(item.name), false, undefined, []);
    default:
      return make("other", toolWords(item.name), false, undefined, []);
  }
}

/** A call's time as a row shows it: milliseconds under a second, tenths under ten seconds, then the fold's "2m 5s". */
export function callTime(ms: number): string {
  return ms < 1000 ? `${Math.round(Math.max(0, ms))}ms` : formatSpan(ms);
}
