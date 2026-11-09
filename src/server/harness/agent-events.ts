// Normalization for Pi-family agent events and transcript messages. omp is a
// Pi fork and emits the same shapes over RPC, so both adapters share this.
// Inputs are untyped on purpose: SDK and wire types never leave the adapters.
import { MAX_IMAGES, type BackgroundJob, type ChatItem, type TodoItem, type ToolCategory, type ToolDiff, type ToolItem } from "../../shared/protocol.js";
import { argsDiff, resultDiff } from "./tool-diff.js";
import { imageRefs } from "../image-store.js";
import { applyReports, asyncReports, detailReports, hasAgentCells, isAgentTool, notifyReports, runsFromArgs, runsFromDetails, settleRuns, type AgentReport } from "./subagents.js";
import { htmlRenderRef, isHtmlRenderCall } from "./render-token.js";
import { planFromArgs } from "./plans.js";
import { applyJobReports, jobReports, jobsFromCall } from "./jobs.js";
import type { HarnessEvent, StepUsage, UsageEntry } from "./types.js";

export const MAX_TOOL_OUTPUT_CHARS = 16_000;
export const MAX_TOOL_ARGS_CHARS = 4_000;

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keep the head and tail of oversized output; payloads stay bounded on the wire. */
export function boundText(text: string, max = MAX_TOOL_OUTPUT_CHARS): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const half = Math.floor((max - 40) / 2);
  const omitted = text.length - half * 2;
  return { text: `${text.slice(0, half)}\n…[${omitted} chars omitted]…\n${text.slice(-half)}`, truncated: true };
}

export function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isObj(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Where to cut a Pi-family transcript to fork after its Nth user turn: the index
 * of the message that starts turn N+1, or the end when there is no such message.
 * Steering messages count as user turns, matching how the UI groups turns.
 */
export function forkCutIndex(messages: unknown[], throughTurns: number): number {
  let turn = 0;
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (isObj(message) && message.role === "user") {
      turn += 1;
      if (turn > throughTurns) return i;
    }
  }
  return messages.length;
}

/**
 * A "/" command that ran without a model turn: the command as the prompt
 * (marked, since the harness stores no turn for it) and its output as the
 * answer. Fenced, because it is terminal text (padded columns, bars) that
 * markdown would reflow.
 */
/**
 * An extension's displayed message (the custom role in Pi and omp) as a row.
 * Their terminal draws these through the extension's own renderer, which a
 * browser cannot run, and the raw text is often an envelope for the model
 * (pi-book's recall is <memory>…</memory>). So: the envelope's tag (or the
 * message's customType) as the label, its first line as the summary, and the
 * inner text behind a disclosure.
 */
export function extensionMessage(customType: unknown, content: unknown): { title: string; text: string; detail: string } | null {
  const raw = textOf(content).trim();
  if (!raw) return null;
  const envelope = /^<([A-Za-z][\w-]*)(?:\s[^>]*)?>\s*([\s\S]*?)\s*<\/\1>$/.exec(raw);
  const inner = (envelope ? (envelope[2] ?? "") : raw).trim();
  const label = envelope ? (envelope[1] as string) : typeof customType === "string" && customType ? customType : "Extension";
  const title = label.replace(/[-_]+/g, " ").replace(/^\w/, (c) => c.toUpperCase());
  const first = inner.split("\n").find((l) => l.trim()) ?? "";
  return { title, text: first.trim().slice(0, 160), detail: inner };
}

export function commandOutputEvents(command: string, output: string): HarnessEvent[] {
  // Terminal colours and hyperlinks (CSI and OSC sequences) would show as junk in a browser.
  const plain = output.replace(/\x1b(?:\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, "");
  const text = plain.trim() || "(no output)";
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = "`".repeat(Math.max(3, longest + 1));
  return [
    { type: "user_message", text: command, command: true },
    { type: "assistant_start" },
    { type: "assistant_end", text: `${fence}text\n${text}\n${fence}`, thinking: "" },
  ];
}

/**
 * Every assistant message's usage (pi-ai's: Pi and omp share it), for usage
 * across sessions: its time (the message's own, else the entry's), model, and
 * tokens, and its cost where pi-ai priced it.
 */
export function usageEntries(messages: Array<{ message: unknown; at: number }>): UsageEntry[] {
  const out: UsageEntry[] = [];
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  for (const { message, at } of messages) {
    if (!isObj(message) || message.role !== "assistant" || !isObj(message.usage)) continue;
    const u = message.usage;
    const reported = isObj(u.cost) && typeof u.cost.total === "number" && Number.isFinite(u.cost.total) ? u.cost.total : null;
    const entry: UsageEntry = {
      at: typeof message.timestamp === "number" ? message.timestamp : at,
      model: typeof message.model === "string" && message.model ? message.model : null,
      input: n(u.input),
      cachedInput: n(u.cacheRead),
      cacheWrite: n(u.cacheWrite),
      output: n(u.output),
      // Pi and omp write an all-zero cost for a model their route has no price for
      // (claude-opus-5-5 through the Pi provider, say). A genuinely free model writes
      // the same zeros, so a zero carries no price at all: counting it as unpriced
      // keeps the report from charging a paid model $0.00.
      cost: reported ? reported : null,
    };
    if (entry.input + entry.cachedInput + entry.cacheWrite + entry.output > 0) out.push(entry);
  }
  return out;
}

/** pi-ai's per-message `usage` (Pi and omp share it). */
function stepUsage(raw: unknown): StepUsage | null {
  if (!isObj(raw)) return null;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const usage = { input: n(raw.input), output: n(raw.output), cacheRead: n(raw.cacheRead), cacheWrite: n(raw.cacheWrite) };
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite > 0 ? usage : null;
}

function imageCount(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  return content.filter((b) => isObj(b) && b.type === "image").length;
}

export function stringifyArgs(args: unknown, verbatimInput = false): string {
  let text: string;
  // omp's edit calls carry a hashline patch block (or a context excerpt) in
  // `input`: show it verbatim, not wrapped in JSON.
  if (verbatimInput && isObj(args) && typeof args.input === "string" && (args.input as string).trim()) {
    text = args.input as string;
  } else {
    try {
      text = typeof args === "string" ? args : JSON.stringify(args, null, 2) ?? "";
    } catch {
      text = String(args);
    }
  }
  return boundText(text, MAX_TOOL_ARGS_CHARS).text;
}

/** Coarse tool kind, used for per-turn counts ("3 reads, 2 edits") and changed files. */
export function toolCategory(name: string): ToolCategory {
  const n = name.toLowerCase();
  // A todo list is no file: todo_write is not a write.
  if (/todo/.test(n)) return "other";
  if (isAgentTool(name)) return "agent";
  if (/web|fetch|browse|url|http/.test(n)) return "web";
  if (/(^|_)(edit|ast_edit|apply_patch|patch|multi_?edit|str_replace|replace)($|_)/.test(n)) return "edit";
  if (/(^|_)(write|create|new_file|save)($|_)/.test(n)) return "write";
  if (/grep|glob|find|search|(^|_)ls($|_)|list|lsp/.test(n)) return "search";
  if (/(^|_)(read|view|cat|open)($|_)/.test(n)) return "read";
  if (/bash|shell|exec|run|eval|terminal|command|python|ssh/.test(n)) return "command";
  return "other";
}

const PATH_KEYS = ["path", "file_path", "filePath", "file", "filename", "target", "target_file", "target_directory", "notebook_path"];

/** File paths named in tool arguments, as given (absolute or relative). */
export function toolPaths(args: unknown): string[] {
  if (!isObj(args)) return [];
  const out: string[] = [];
  for (const key of PATH_KEYS) {
    const v = args[key];
    // `target` is a path for some tools and a mode for others (Hermes search_files: content | files).
    if (key === "target" && typeof v === "string" && !/[/.]/.test(v)) continue;
    if (typeof v === "string" && v && v.length < 1024) out.push(v);
  }
  // omp's patch block names its file in a `[path#hash]` header.
  if (typeof args.input === "string") {
    const header = /^\[(.+?)#\w+\]/m.exec(args.input as string);
    if (header?.[1]) out.push(header[1] as string);
  }
  for (const key of ["paths", "files", "edits"]) {
    const v = args[key];
    if (!Array.isArray(v)) continue;
    for (const entry of v.slice(0, 50)) {
      if (typeof entry === "string" && entry.length < 1024) out.push(entry);
      else if (isObj(entry)) {
        const p = entry.path ?? entry.file_path ?? entry.file;
        if (typeof p === "string" && p.length < 1024) out.push(p);
      }
    }
  }
  return [...new Set(out)];
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 160);

export interface DiffStat {
  added: number;
  removed: number;
}

/**
 * Added/removed lines an edit tool's output states as `(+1 -1)`, for a
 * harness that reports no diff. Only that bracketed form: output often quotes
 * code, where `x+1-2` is no count.
 */
export function outputDiffStat(output: string): DiffStat | null {
  const m = /\(\+(\d+)\s+[-−](\d+)\)/.exec(output);
  return m ? { added: Number(m[1]), removed: Number(m[2]) } : null;
}

/** The diff and its counts for an edit or write, from its result when the harness reported one, else its arguments. */
export function editShape(diff: ToolDiff | null, output: string | null): Pick<ToolItem, "diff" | "diffStat"> {
  if (diff) return { diff, diffStat: { added: diff.added, removed: diff.removed } };
  const stat = output === null ? null : outputDiffStat(output);
  return stat ? { diffStat: stat } : {};
}
/**
 * A shell call's exit code from its result's structured side, when the harness reported one.
 * OpenCode's shell result carries it as `metadata.exit` (which toolDetails spreads onto
 * `details`); Pi/omp/Claude bash results carry no code, so those calls stay without one
 * and their rows keep reading the output instead of guessing.
 */
export function exitCodeOf(details: unknown): number | null {
  if (!isObj(details)) return null;
  const exit = details.exit;
  return typeof exit === "number" && Number.isInteger(exit) ? exit : null;
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The op a todo call without one performs, as Pi's todo tool infers it: a
 * `list` is an init, `items` with a `phase` an append, bare `items` an init.
 */
function todoKind(op: Obj): string {
  if (typeof op.op === "string") return op.op;
  if (Array.isArray(op.list)) return "init";
  if (Array.isArray(op.items)) return typeof op.phase === "string" ? "append" : "init";
  return "";
}

/** omp's and Pi's todo phases (`[{name, tasks: [{content, status}]}]`), flattened. */
export function todoPhaseItems(phases: unknown): TodoItem[] {
  const out: TodoItem[] = [];
  for (const phase of Array.isArray(phases) ? phases : []) {
    if (!isObj(phase)) continue;
    const name = typeof phase.name === "string" ? phase.name : undefined;
    for (const task of Array.isArray(phase.tasks) ? phase.tasks : []) {
      if (!isObj(task) || typeof task.content !== "string") continue;
      out.push({ ...(name ? { phase: name } : {}), text: task.content.slice(0, 500), status: String(task.status ?? "pending") });
    }
  }
  return out.slice(0, 100);
}

/**
 * The list a Pi todo extension holds: its newest successful `todo` result's
 * details, which carry the whole list after every op (the extension rebuilds
 * its own state the same way).
 */
export function piTodos(messages: unknown[]): TodoItem[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isObj(m) || m.role !== "toolResult" || m.toolName !== "todo" || m.isError === true || !isObj(m.details)) continue;
    if (Array.isArray(m.details.phases)) return todoPhaseItems(m.details.phases);
    // Pi's example todo extension: `{todos: [{text, done}]}`.
    if (Array.isArray(m.details.todos)) {
      return m.details.todos
        .filter(isObj)
        .map((t) => ({ text: String(t.text ?? "").slice(0, 500), status: t.done === true ? "completed" : "pending" }))
        .slice(0, 100);
    }
    // rpiv-todo (`todo` with an `action`): the whole numbered list, tombstones included.
    if (Array.isArray(m.details.tasks)) {
      return (m.details.tasks as unknown[])
        .filter(isObj)
        .flatMap((t): TodoItem[] => (t.status === "deleted" || typeof t.subject !== "string" ? [] : [{ text: t.subject.slice(0, 500), status: String(t.status ?? "pending") }]))
        .slice(0, 100);
    }
  }
  return [];
}

/** The actions rpiv-todo's `todo` takes; any other `action` belongs to another tool. */
const TODO_ACTIONS = new Set(["create", "update", "list", "get", "delete", "clear"]);

/** rpiv-todo's `todo`: one action on a numbered list (`{action, id?, subject?, status?, tasks?}`), in words. */
function todoActionSummary(args: Obj): string | null {
  const action = typeof args.action === "string" ? args.action : "";
  if (!TODO_ACTIONS.has(action)) return null;
  if (action === "list") return "Listed the todos";
  if (action === "clear") return "Cleared the todos";
  if (action === "create") {
    const batch = Array.isArray(args.tasks) ? args.tasks.filter(isObj).length : 0;
    if (batch > 0) return `Added ${plural(batch, "todo")}`;
    const subject = typeof args.subject === "string" ? oneLine(args.subject) : "";
    return subject ? `Added a todo: ${subject}` : "Added a todo";
  }
  const id = typeof args.id === "number" ? `#${args.id}` : "";
  if (action === "update") {
    const status = typeof args.status === "string" && args.status.trim() ? ` to ${args.status.replace(/_/g, " ")}` : "";
    return `Updated ${id || "a todo"}${status}`;
  }
  return `${action === "delete" ? "Deleted" : "Read"} ${id || "a todo"}`;
}

/**
 * A todo call in words: Claude Code's and Hermes's whole list (`todos`) as
 * its progress and current item; omp's and Pi's operations (`ops`, or one
 * `op`, which Pi lets a model leave out) as what they did; rpiv-todo's single
 * action (`action`) as the one thing it did.
 */
function todoSummary(args: Obj, name: string | undefined): string | null {
  // `action` is a common argument (bg_task, memory, subagent take one too), so it is a todo's only on a todo tool.
  const action = name !== undefined && /todo/i.test(name) ? todoActionSummary(args) : null;
  if (action) return action;
  if (Array.isArray(args.todos) && args.todos.every(isObj)) {
    const todos = args.todos as Obj[];
    const done = todos.filter((t) => /done|complete/.test(String(t.status))).length;
    const current = todos.find((t) => /progress|active/.test(String(t.status)));
    const label = current ? String(current.activeForm ?? current.content ?? current.text ?? "") : "";
    return oneLine(`${done}/${plural(todos.length, "todo")} done${label ? ` · ${label}` : ""}`);
  }
  const single = typeof args.op === "string" || Array.isArray(args.list) || Array.isArray(args.items);
  const ops = Array.isArray(args.ops) ? args.ops.filter(isObj) : single ? [args] : null;
  if (!ops || ops.length === 0) return null;
  const parts = ops.map((op) => {
    const kind = todoKind(op);
    const items = Array.isArray(op.list)
      ? op.list.reduce((n: number, phase) => n + (isObj(phase) && Array.isArray(phase.items) ? phase.items.length : 0), 0)
      : Array.isArray(op.items)
        ? op.items.length
        : 0;
    const what = typeof op.task === "string" ? op.task : typeof op.text === "string" ? op.text : "";
    if (kind === "init" || kind === "replace") return `Planned ${plural(items, "task")}`;
    if (kind === "done" || kind === "complete") return `Done: ${what}`;
    if (kind === "start" || kind === "progress") return `Started: ${what}`;
    if (kind === "add" || kind === "append") return `Added ${what || plural(Array.isArray(op.items) ? op.items.length : 1, "task")}`;
    return what ? `${kind}: ${what}` : kind;
  });
  // "Done: a · Done: b" reads as "Done: a, b".
  const merged: string[] = [];
  for (const part of parts.filter(Boolean)) {
    const prev = merged[merged.length - 1];
    const lead = /^(Done|Started): /.exec(part)?.[0];
    if (lead && prev?.startsWith(lead)) merged[merged.length - 1] = `${prev}, ${part.slice(lead.length)}`;
    else merged.push(part);
  }
  return oneLine(merged.join(" · "));
}

/**
 * One-line description of a call: its command, else what a search looks for
 * (and where, unless that is just the working directory), else its path, else
 * its query. Every harness's tools go through this, so a grep reads the same
 * in Pi, omp, Hermes, and Claude Code. The tool's name, when known, tells a
 * todo's `action` from another tool's.
 */
export function toolSummary(args: unknown, name?: string): string {
  if (typeof args === "string") return oneLine(args);
  if (!isObj(args)) return "";
  const todo = todoSummary(args, name);
  if (todo) return todo;
  const paths = toolPaths(args);
  for (const key of ["command", "cmd", "script", "code"]) {
    if (typeof args[key] === "string") return oneLine(args[key] as string);
  }
  for (const key of ["pattern", "query", "glob", "regex", "q"]) {
    if (typeof args[key] !== "string" || !(args[key] as string).trim()) continue;
    const where = paths.find((p) => p !== "." && p !== "./");
    return oneLine(where ? `${args[key] as string} in ${where}` : (args[key] as string));
  }
  if (paths.length > 0) return paths.length > 1 ? `${paths[0]} +${paths.length - 1}` : (paths[0] as string);
  // A page or a document by its name (render_html's title), never its whole body flattened into the line.
  for (const key of ["url", "prompt", "description", "title"]) {
    if (typeof args[key] === "string" && (args[key] as string).trim()) return (args[key] as string).replace(/\s+/g, " ").trim().slice(0, 160);
  }
  try {
    return formatArgObject(args).slice(0, 160);
  } catch {
    return "";
  }
}

/** A call's args as `a: 1, b: [x, y] · c: …` — readable in the one-line summary, full form in the card. */
function formatArgObject(obj: Obj): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([key, value]) => {
      const text =
        typeof value === "string"
          ? value.replace(/\s+/g, " ").trim()
          : Array.isArray(value)
            ? `[${value.map((x) => (typeof x === "string" ? x : JSON.stringify(x) ?? "")).join(", ")}]`
            : isObj(value)
              ? `{${formatArgObject(value)}}`
              : String(value);
      return `${key}: ${text}`;
    })
    .filter((v) => v !== "")
    .join(", ");
}
export function toolResultText(result: unknown): string {
  if (result === undefined || result === null) return "";
  if (typeof result === "string") return result;
  if (isObj(result) && "content" in result) {
    const text = textOf(result.content);
    if (text) return text;
    const images = imageCount(result.content);
    if (images) return `[${images} image${images === 1 ? "" : "s"}]`;
    return "";
  }
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}

function assistantParts(message: Obj): { text: string; thinking: string } {
  const content = Array.isArray(message.content) ? message.content : [];
  const text: string[] = [];
  const thinking: string[] = [];
  for (const block of content) {
    if (!isObj(block)) continue;
    if (block.type === "text" && typeof block.text === "string") text.push(block.text);
    if (block.type === "thinking" && typeof block.thinking === "string" && block.redacted !== true) {
      thinking.push(block.thinking);
    }
  }
  return { text: text.join("\n"), thinking: thinking.join("\n") };
}

function assistantError(message: Obj): string | undefined {
  if (message.stopReason === "error") {
    return typeof message.errorMessage === "string" && message.errorMessage ? message.errorMessage : "Request failed";
  }
  if (message.stopReason === "aborted") return "Stopped";
  return undefined;
}

/**
 * Translate one Pi-family session event. `settledType` differs by harness:
 * Pi emits `agent_settled`, omp emits `session_settled`.
 */
export function normalizeAgentEvent(event: unknown, settledType: string): HarnessEvent[] {
  if (!isObj(event) || typeof event.type !== "string") return [];
  switch (event.type) {
    case "agent_start":
      return [{ type: "busy" }];
    case "message_start": {
      const message = event.message;
      if (!isObj(message)) return [];
      if (message.role === "user") {
        const images = imageRefs(message.content);
        return [{ type: "user_message", text: textOf(message.content), imageCount: imageCount(message.content), ...(images.length > 0 ? { images } : {}) }];
      }
      if (message.role === "assistant") {
        return [{ type: "assistant_start", ...(typeof message.model === "string" ? { model: message.model } : {}) }];
      }
      if (message.role === "custom") {
        const reports = [...asyncReports(message.customType, message.content, message.details), ...notifyReports(message.customType, message.content)];
        const jobs = jobReports(message.customType, message.content, message.details);
        const shown = message.display === true ? extensionMessage(message.customType, message.content) : null;
        return [
          ...(reports.length > 0 ? [{ type: "subagent_reports" as const, reports }] : []),
          ...(jobs.length > 0 ? [{ type: "job_reports" as const, jobs }] : []),
          ...(shown ? [{ type: "notice" as const, level: "info" as const, ...shown }] : []),
        ];
      }
      return [];
    }
    case "message_update": {
      const ame = event.assistantMessageEvent;
      if (!isObj(ame) || typeof ame.delta !== "string" || !ame.delta) return [];
      if (ame.type === "text_delta") return [{ type: "assistant_delta", field: "text", delta: ame.delta }];
      if (ame.type === "thinking_delta") return [{ type: "assistant_delta", field: "thinking", delta: ame.delta }];
      return [];
    }
    case "message_end": {
      const message = event.message;
      if (!isObj(message) || message.role !== "assistant") return [];
      const { text, thinking } = assistantParts(message);
      const error = assistantError(message);
      const usage = stepUsage(message.usage);
      return [{ type: "assistant_end", text, thinking, ...(error ? { error } : {}), ...(usage ? { usage } : {}) }];
    }
    case "tool_execution_start":
      return [
        {
          type: "tool_start",
          toolCallId: String(event.toolCallId),
          name: String(event.toolName ?? "tool"),
          args: event.args,
        },
      ];
    case "tool_execution_update":
      return [
        {
          type: "tool_update",
          toolCallId: String(event.toolCallId),
          output: toolResultText(event.partialResult),
          ...(isObj(event.partialResult) && event.partialResult.details !== undefined ? { details: event.partialResult.details } : {}),
        },
      ];
    case "tool_execution_end": {
      // A read of a picture answers with an image block; the picture is kept here so the row can show it,
      // and the browser still only ever sees an id (/api/images/<id>).
      const images = isObj(event.result) ? imageRefs(event.result.content).slice(0, MAX_IMAGES) : [];
      return [
        {
          type: "tool_end",
          toolCallId: String(event.toolCallId),
          output: toolResultText(event.result),
          isError: event.isError === true,
          ...(isObj(event.result) && event.result.details !== undefined ? { details: event.result.details } : {}),
          ...(images.length > 0 ? { images } : {}),
        },
      ];
    }
    case "queue_update": {
      const steering = Array.isArray(event.steering) ? event.steering.map(String) : [];
      const followUp = Array.isArray(event.followUp) ? event.followUp.map(String) : [];
      return [{ type: "queue", queue: { steering, followUp } }];
    }
    case "compaction_start":
      return [{ type: "compacting", active: true }];
    case "compaction_end": {
      const out: HarnessEvent[] = [{ type: "compacting", active: false }];
      if (typeof event.errorMessage === "string" && event.errorMessage) {
        out.push({ type: "notice", level: "error", text: `Compaction failed: ${event.errorMessage}` });
      } else if (event.aborted === true) {
        out.push({ type: "notice", level: "warning", text: "Compaction cancelled" });
      } else {
        const reason = event.reason === "manual" ? "Compacted conversation" : "Compacted conversation automatically";
        out.push({ type: "notice", level: "info", text: reason });
      }
      return out;
    }
    case "auto_retry_start": {
      const seconds = typeof event.delayMs === "number" ? Math.round(event.delayMs / 1000) : 0;
      const text = `Retrying (attempt ${String(event.attempt)}/${String(event.maxAttempts)}) in ${seconds}s: ${String(
        event.errorMessage ?? "error",
      )}`;
      return [{ type: "notice", level: "warning", text }];
    }
    case "auto_retry_end":
      return event.success === false
        ? [{ type: "notice", level: "error", text: `Retries exhausted: ${String(event.finalError ?? "error")}` }]
        : [];
    case "retry_fallback_applied": {
      // omp moved the request to its next candidate model (a rate limit, an outage, a rejected tier): the run goes on, on another model.
      const to = typeof event.to === "string" && event.to ? event.to : "another model";
      const from = typeof event.from === "string" && event.from ? `${event.from} to ` : "";
      const reason = typeof event.reason === "string" && event.reason ? `: ${event.reason}` : "";
      return [{ type: "notice", level: "warning", text: `Switched ${from}${to}${reason}` }];
    }
    case "session_info_changed":
      return typeof event.name === "string" && event.name ? [{ type: "title", title: event.name }] : [];
    case "thinking_level_changed":
      return typeof event.level === "string" ? [{ type: "config", config: { thinkingLevel: event.level } }] : [];
    default:
      if (event.type === settledType) return [{ type: "settled" }];
      return [];
  }
}

const withRuns = (runs: ToolItem["subagents"] | null) => (runs ? { subagents: runs } : {});
const withPlan = (plan: string | null) => (plan ? { plan } : {});

/** What a call that never got a result says, in place of its output: a cancelled question, an interrupted run. */
export const NO_RESULT_TEXT = "No result: the run ended before this call answered.";

/** Rebuild display items from the active branch's message list. */
export function historyToItems(messages: unknown[]): ChatItem[] {
  const items: ChatItem[] = [];
  const tools = new Map<string, ToolItem>();
  // Tool calls that are the render tool, decided from their raw args at the call.
  const renderCalls = new Set<string>();
  let n = 0;
  const nextId = (prefix: string) => `h${prefix}${n++}`;
  const report = (reports: AgentReport[]) => {
    for (const tool of tools.values()) {
      const next = tool.subagents ? applyReports(tool.subagents, reports) : null;
      if (next) tool.subagents = next;
    }
  };
  // Each call's raw arguments: a job's start is read from them with its result.
  const toolArgs = new Map<string, unknown>();
  const reportJobs = (jobs: BackgroundJob[], at: number | undefined) => {
    for (const tool of tools.values()) {
      const next = tool.jobs ? applyJobReports(tool.jobs, jobs, at) : null;
      if (next) tool.jobs = next;
    }
  };
  for (const raw of messages) {
    if (!isObj(raw)) continue;
    const at = typeof raw.timestamp === "number" ? raw.timestamp : undefined;
    const stamp = at !== undefined ? { at } : {};
    switch (raw.role) {
      case "user": {
        const count = imageCount(raw.content);
        const images = imageRefs(raw.content);
        items.push({
          kind: "user",
          id: nextId("u"),
          text: textOf(raw.content),
          ...(count ? { imageCount: count } : {}),
          ...(images.length > 0 ? { images } : {}),
          ...stamp,
        });
        break;
      }
      case "assistant": {
        const { text, thinking } = assistantParts(raw);
        const error = assistantError(raw);
        if (text || thinking || error) {
          items.push({
            kind: "assistant",
            id: nextId("a"),
            text,
            thinking,
            streaming: false,
            ...(error ? { error } : {}),
            ...(typeof raw.model === "string" ? { model: raw.model } : {}),
            ...stamp,
          });
        }
        const content = Array.isArray(raw.content) ? raw.content : [];
        for (const block of content) {
          if (!isObj(block) || block.type !== "toolCall") continue;
          const id = String(block.id);
          const name = String(block.name ?? "tool");
          const category = toolCategory(name);
          const edits = category === "edit" || category === "write";
          const tool: ToolItem = {
            kind: "tool",
            id: `t:${id}`,
            name,
            args: stringifyArgs(block.arguments, category === "edit"),
            status: "running",
            output: "",
            truncated: false,
            category,
            summary: toolSummary(block.arguments, name),
            paths: toolPaths(block.arguments),
            ...(edits ? editShape(argsDiff(block.arguments), null) : {}),
            ...(category === "agent" ? withRuns(runsFromArgs(block.arguments)) : {}),
            ...withPlan(planFromArgs(name, block.arguments)),
            ...stamp,
          };
          if (isHtmlRenderCall(name, block.arguments)) renderCalls.add(id);
          toolArgs.set(id, block.arguments);
          tools.set(id, tool);
          items.push(tool);
        }
        break;
      }
      case "toolResult": {
        const tool = tools.get(String(raw.toolCallId));
        const bounded = boundText(toolResultText(raw));
        if (tool) {
          tool.output = bounded.text;
          tool.truncated = bounded.truncated;
          tool.status = raw.isError === true ? "error" : "done";
          if (at !== undefined) tool.endedAt = at;
          if (tool.category === "edit" || tool.category === "write") {
            const reported = resultDiff(raw.details, toolResultText(raw));
            Object.assign(tool, reported ? editShape(reported, null) : tool.diff ? {} : editShape(null, bounded.text));
            if (tool.status === "error") delete tool.diffStat;
          }
          if (tool.category === "agent" || hasAgentCells(raw.details)) {
            const runs = runsFromDetails(String(raw.toolCallId), raw.details, tool.subagents ?? null);
            if (runs) tool.subagents = settleRuns(runs, bounded.text, tool.status === "error");
          }
          // A render call's page reference survives in its result's details, so a reload re-arms the frame.
          const page = renderCalls.has(String(raw.toolCallId)) ? htmlRenderRef(raw.details) : undefined;
          if (page) tool.htmlRender = page;
          // A shell call's exit rides on the item when the harness reported one (OpenCode does).
          if (tool.category === "command") {
            const exitCode = exitCodeOf(raw.details);
            if (exitCode !== null) tool.exitCode = exitCode;
            else delete tool.exitCode;
          }
          // A picture the call returned (a read of a screenshot) rides on the row, so history shows it too.
          const images = imageRefs(raw.content).slice(0, MAX_IMAGES);
          if (images.length > 0) tool.images = images;
          const jobs = jobsFromCall(tool.name, toolArgs.get(String(raw.toolCallId)), raw.details, toolResultText(raw));
          if (jobs) {
            // A started job is stamped with its call's time; a later look (a wait, a list) says how it stands.
            tool.jobs = jobs.map((j) => (j.status === "running" && j.startedAt === undefined && tool.at !== undefined ? { ...j, startedAt: tool.at } : j));
            reportJobs(jobs.filter((j) => j.status !== "running"), at);
          }
        }
        // A wait or a proc read reports on background runs another call started.
        const reports = detailReports(raw.details);
        if (reports.length > 0) report(reports);
        break;
      }
      case "compactionSummary":
        items.push({ kind: "notice", id: nextId("n"), level: "info", text: "Earlier conversation was compacted", ...stamp });
        break;
      case "branchSummary":
        items.push({ kind: "notice", id: nextId("n"), level: "info", text: "Returned from another branch (summarized)" });
        break;
      case "custom": {
        const reports = [...asyncReports(raw.customType, raw.content, raw.details), ...notifyReports(raw.customType, raw.content)];
        if (reports.length > 0) report(reports);
        const jobs = jobReports(raw.customType, raw.content, raw.details);
        if (jobs.length > 0) reportJobs(jobs, at);
        if (raw.display === true) {
          const shown = extensionMessage(raw.customType, raw.content);
          if (shown) items.push({ kind: "notice", id: nextId("n"), level: "info", ...shown, ...stamp });
        }
        break;
      }
      default:
        break;
    }
  }
  // A tool call without a result in a settled transcript was interrupted: no spinner, and a note where its output was.
  // The same for a task (subagent) a call still shows running: the transcript is settled, so its run loop is over
  // and it can never report again. A shell job still can (a backgrounded command outlives the settle).
  const now = Date.now();
  for (const tool of tools.values()) {
    if (tool.jobs?.some((j) => j.kind === "task" && j.status === "running")) {
      tool.jobs = tool.jobs.map((j) => (j.kind === "task" && j.status === "running" ? { ...j, status: "stopped", endedAt: now } : j));
    }
    if (tool.status !== "running") continue;
    tool.status = "done";
    if (!tool.output) tool.output = NO_RESULT_TEXT;
  }
  return items;
}
