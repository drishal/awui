// Delegation calls as subagent runs, one shape for every harness:
//  - omp's `task`: { context, tasks: [{ name, agent, task }] }; its details
//    carry `progress[]` (id, agent, status, recentTools, toolCount, tokens,
//    cost, durationMs) and, when it ran in the background, `async`; results
//    arrive later as an `async-result` message, and each agent's transcript is
//    `<parent session>/<id>.jsonl` (nested agents a level deeper).
//  - pi-subagents' `subagent`: { agent, task } | { tasks } | { chain }; its
//    details carry `results[]` (index, agent, exitCode, usage, model,
//    finalOutput, progress, sessionFile, transcriptPath) and live `progress[]`.
//  - Claude Code's `Task`/`Agent`: { subagent_type, description, prompt }; the
//    result text is its answer.
//  - OpenCode's `task` ({ subagent_type, description, prompt }) and
//    oh-my-opencode-slim's `subagent` ({ agent, description, prompt,
//    background }): each runs a child session; the adapter reports its
//    progress and result as rows keyed by that session's id.
//  - Grok's `spawn_subagent` ({ description, prompt, background }): the child
//    id, type, and model arrive on a later `subagent_spawned`, and the result
//    on `subagent_finished`. The description is the label; the prompt is the
//    child's own transcript. A retry is another child on the same call.
// Transcript paths stay on the server (keyed by tool call and run), so the
// browser can ask for a run's transcript but never names a file.
import type { SubagentRun, SubagentsInfo } from "../../shared/protocol.js";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

const MAX_OUTPUT_CHARS = 12_000;
const MAX_ACTIVITY = 4;
const MAX_FILES = 2_000;

/** Whether a tool delegates to subagents. */
export function isAgentTool(name: string): boolean {
  return /^(task|subagent|agent|delegate|spawn_agents?|spawn_subagent)$/i.test(name);
}

const bound = (text: string) => (text.length > MAX_OUTPUT_CHARS ? `${text.slice(0, MAX_OUTPUT_CHARS)}\n…` : text);

/** `${toolCallId}/${runId}` → the run's transcript file. */
const files = new Map<string, string>();

function rememberFile(toolCallId: string, runId: string, file: string | undefined): boolean {
  if (!file || !file.endsWith(".jsonl")) return false;
  const key = `${toolCallId}/${runId}`;
  files.delete(key);
  files.set(key, file);
  if (files.size > MAX_FILES) files.delete(files.keys().next().value as string);
  return true;
}

/** The transcript file a run's harness reported, if any. */
export function transcriptFile(toolCallId: string, runId: string): string | null {
  return files.get(`${toolCallId}/${runId}`) ?? null;
}

/**
 * The brief a call's arguments carry. A named agent (Claude, pi, omp) puts the
 * work in `prompt` or `task`. Grok's spawn has no agent yet: `description` is
 * the label and `prompt` is the full brief, which the child's transcript holds.
 */
function brief(raw: Obj): string {
  const named = str(raw.agent) ?? str(raw.subagent_type);
  if (named) return str(raw.task) ?? str(raw.assignment) ?? str(raw.prompt) ?? str(raw.description) ?? "";
  return str(raw.task) ?? str(raw.assignment) ?? str(raw.description) ?? str(raw.prompt) ?? "";
}

/** The runs a call's arguments describe, before anything has started. */
export function runsFromArgs(args: unknown): SubagentsInfo | null {
  if (!isObj(args)) return null;
  const one = (raw: Obj, i: number): SubagentRun => ({
    id: str(raw.name) ?? str(raw.id) ?? String(i),
    agent: str(raw.agent) ?? str(raw.subagent_type) ?? "agent",
    task: brief(raw),
    status: "pending",
  });
  for (const [key, mode] of [
    ["tasks", "parallel"],
    ["chain", "chain"],
  ] as const) {
    const list = args[key];
    if (Array.isArray(list) && list.length > 0) {
      return { mode, runs: list.filter(isObj).map(one), ...(args.async === true || args.background === true ? { background: true } : {}) };
    }
  }
  if (str(args.agent) || str(args.subagent_type) || str(args.task) || str(args.prompt) || str(args.description)) {
    // `background`: OpenCode's subagent tool (oh-my-opencode-slim) runs it on after the call returns.
    return { mode: "single", runs: [one(args, 0)], ...(args.async === true || args.background === true ? { background: true } : {}) };
  }
  return null;
}

function status(raw: unknown, exitCode?: number): SubagentRun["status"] {
  const s = String(raw ?? "").toLowerCase();
  if (/complete|success|done|finish/.test(s)) return "done";
  if (/fail|error/.test(s)) return "failed";
  if (/abort|cancel|stop|kill|interrupt/.test(s)) return "stopped";
  if (/run|active|start|detached/.test(s)) return "running";
  if (/pend|queue|wait/.test(s)) return "pending";
  if (exitCode !== undefined) return exitCode === 0 ? "done" : "failed";
  return "running";
}

function activity(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const lines = raw.flatMap((t) => {
    if (typeof t === "string") return [t];
    if (!isObj(t)) return [];
    const tool = str(t.tool) ?? str(t.name) ?? "tool";
    const args = str(t.args) ?? str(t.summary) ?? "";
    return [`${tool}${args ? ` ${args.replace(/\s+/g, " ").slice(0, 140)}` : ""}`];
  });
  return lines.length > 0 ? lines.slice(-MAX_ACTIVITY) : undefined;
}

/** The final assistant text in Pi-family messages. */
function lastAnswer(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i];
    if (!isObj(m) || m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const text = m.content.flatMap((b) => (isObj(b) && b.type === "text" && typeof b.text === "string" ? [b.text] : [])).join("\n");
    if (text.trim()) return text;
  }
  return undefined;
}

/**
 * omp's eval cells: an `agent()` in the cell's code spawns an agent, so the call
 * that runs it is a code run, not a delegation tool. Each cell's `statusEvents[]`
 * carries one row per agent (`op: "agent"`, its label as the id), live while the
 * cell runs and settled at its end. A cell without agents folds to nothing.
 */
function evalCells(details: Obj): { rows: Obj[]; cells: number } | null {
  const cells = (Array.isArray(details.cells) ? details.cells : []).filter(isObj);
  if (cells.length === 0) return null;
  const rows: Obj[] = [];
  let withAgents = 0;
  for (const cell of cells) {
    const events = Array.isArray(cell.statusEvents) ? cell.statusEvents.filter(isObj) : [];
    // A cell's shell steps sit in the same list; only an agent row names an agent and its own id.
    const agents = events.filter((e) => str(e.id) !== undefined && str(e.agent) !== undefined && (str(e.op) === undefined || str(e.op) === "agent"));
    if (agents.length > 0) withAgents += 1;
    rows.push(...agents);
  }
  return withAgents > 0 ? { rows, cells: withAgents } : null;
}

/** Whether a call's details hold agents a non-delegation tool launched (omp's eval). */
export function hasAgentCells(details: unknown): boolean {
  return isObj(details) && Array.isArray(details.cells) && evalCells(details) !== null;
}

/** The answer omp's eval agent reports through `yield`: its rows keep no output field. */
function yieldedAnswer(raw: Obj): string | undefined {
  const data = raw.extractedToolData;
  if (!isObj(data) || !Array.isArray(data.yield)) return undefined;
  const entries = data.yield.filter(isObj);
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const value = (entries[i] as Obj).data;
    if (typeof value === "string") {
      const text = value.trim();
      if (text) return text;
      continue;
    }
    if (value !== undefined) return JSON.stringify(value, null, 2);
  }
  return undefined;
}

/** One progress or result row as a run, over what was known before. */
function merge(prior: SubagentRun | undefined, row: Obj, fallbackId: string): SubagentRun {
  const progress = isObj(row.progress) ? row.progress : {};
  const usage = isObj(row.usage) ? row.usage : {};
  const exitCode = num(row.exitCode);
  // pi-subagents redacts the brief in its details; the arguments' copy stays.
  // omp wraps the brief ("Complete assignment thoroughly: …") and keeps the original as `assignment`.
  const task = str(row.assignment) ?? (str(row.task) && !/^\[prompt redacted\]/.test(String(row.task)) ? String(row.task) : (prior?.task ?? ""));
  const output = str(row.finalOutput) ?? str(row.output) ?? str(row.result) ?? lastAnswer(row.messages) ?? yieldedAnswer(row);
  const tokens = num(row.tokens) ?? num(progress.tokens) ?? (num(usage.input) !== undefined ? (num(usage.input) ?? 0) + (num(usage.output) ?? 0) : undefined);
  const model = str(row.model) ?? str(progress.model) ?? str(row.resolvedModel) ?? prior?.model;
  const run: SubagentRun = {
    id: fallbackId,
    agent: str(row.agent) ?? prior?.agent ?? "agent",
    task,
    // A live row says how it is doing; a finished one only how it exited.
    status: (row.status ?? progress.status) !== undefined ? status(row.status ?? progress.status) : status(undefined, exitCode),
  };
  if (row.stopped === true || row.interrupted === true) run.status = "stopped";
  if (model) run.model = model;
  const toolCount = num(row.toolCount) ?? num(progress.toolCount) ?? (Array.isArray(row.toolCalls) ? row.toolCalls.length : undefined) ?? prior?.toolCount;
  if (toolCount !== undefined) run.toolCount = toolCount;
  if (tokens !== undefined) run.tokens = tokens;
  const cost = num(row.cost) ?? num(usage.cost) ?? prior?.cost;
  if (cost !== undefined) run.cost = cost;
  const duration = num(row.durationMs) ?? num(progress.durationMs) ?? prior?.durationMs;
  if (duration !== undefined) run.durationMs = duration;
  const recent = activity(row.recentTools ?? progress.recentTools) ?? (run.status === "running" ? prior?.activity : undefined);
  if (recent && run.status === "running") run.activity = recent;
  if (output) run.output = bound(output);
  else if (prior?.output) run.output = prior.output;
  const error = str(row.error) ?? str(progress.error) ?? str(row.errorMessage);
  if (error) run.error = error;
  if (prior?.transcript) run.transcript = true;
  return run;
}

/** Fold a call's details (a live update or its result) into its runs. */
export function runsFromDetails(toolCallId: string, details: unknown, prior: SubagentsInfo | null): SubagentsInfo | null {
  if (!isObj(details)) return prior;
  // pi-subagents' background launch: no rows yet, only the run's id; its notice comes later.
  const asyncId = str(details.asyncId);
  if (asyncId && prior) {
    return { ...prior, background: true, runs: prior.runs.map((r) => ({ ...r, ref: asyncId, status: r.status === "pending" ? "running" : r.status, transcript: true })) };
  }
  const rows: Obj[] = [];
  // Results are authoritative; progress fills in runs that have no result yet.
  const results = Array.isArray(details.results) ? details.results.filter(isObj) : [];
  const progress = Array.isArray(details.progress) ? details.progress.filter(isObj) : [];
  // Agents launched inside omp's eval cells report as the cell's own rows.
  const cells = results.length === 0 && progress.length === 0 ? evalCells(details) : null;
  if (results.length === 0 && progress.length === 0 && !cells) return prior;
  const keyOf = (row: Obj, i: number) => str(row.id) ?? (num(row.index) !== undefined ? String(row.index) : String(i));
  const seen = new Set<string>();
  for (const [i, row] of results.entries()) {
    seen.add(keyOf(row, i));
    rows.push(row);
  }
  for (const [i, row] of progress.entries()) if (!seen.has(keyOf(row, i))) rows.push(row);
  for (const [i, row] of (cells?.rows ?? []).entries()) if (!seen.has(keyOf(row, i))) rows.push(row);

  const before = prior?.runs ?? [];
  const used = new Set<SubagentRun>();
  const runs = rows.map((row, i) => {
    const key = keyOf(row, i);
    // A run the arguments named by position takes the id the harness gave it (omp's InclinedBoar).
    const match = before.find((r) => r.id === key) ?? before.find((r, at) => r.id === String(at) && at === (num(row.index) ?? i));
    if (match) used.add(match);
    const run = merge(match, row, key);
    if (rememberFile(toolCallId, run.id, str(row.transcriptPath) ?? str(row.sessionFile))) run.transcript = true;
    // omp names each run's transcript after its id (<session>/<id>.jsonl); the adapter finds it.
    if (str(row.id)) run.transcript = true;
    return run;
  });
  // Runs the arguments named that no row mentions yet stay as they were.
  for (const r of before) if (!used.has(r) && !runs.some((x) => x.id === r.id)) runs.push(r);
  const asyncState = isObj(details.async) ? details.async : null;
  // Eval's cells run one after another; agents inside one cell were launched together.
  const mode = str(details.mode) ?? (cells ? (cells.cells > 1 ? "chain" : "parallel") : prior?.mode);
  return {
    ...(mode ? { mode } : {}),
    ...(asyncState || details.background === true || prior?.background ? { background: true } : {}),
    runs,
  };
}

/** A call's runs once it ended without details worth folding: Claude Code's answer text, or a failure. */
export function settleRuns(info: SubagentsInfo, output: string, isError: boolean): SubagentsInfo {
  if (info.background) return info;
  const open = info.runs.filter((r) => r.status === "pending" || r.status === "running");
  if (open.length === 0) return info;
  return {
    ...info,
    runs: info.runs.map((r) =>
      r.status === "pending" || r.status === "running"
        ? { ...r, status: isError ? "failed" : "done", ...(open.length === 1 && output.trim() && !r.output ? { output: bound(output) } : {}) }
        : r,
    ),
  };
}

export interface AgentReport {
  id: string;
  status: SubagentRun["status"];
  durationMs?: number;
  output?: string;
  model?: string;
}

/** The answer inside omp's `<task-result …>` text: its `<output>`, else its `<preview>`. */
function resultBody(text: string): string | undefined {
  const m = /<output>([\s\S]*?)(?:<\/output>|$)/.exec(text) ?? /<preview[^>]*>([\s\S]*?)(?:<\/preview>|$)/.exec(text);
  return m?.[1]?.trim() || undefined;
}

/** omp's job snapshots (`jobs[]` in a wait, a proc read or kill, a background delivery) as reports on its task runs. */
function jobReports(jobs: unknown): AgentReport[] {
  if (!Array.isArray(jobs)) return [];
  return jobs.filter(isObj).flatMap((job): AgentReport[] => {
    const id = str(job.id) ?? str(job.jobId);
    if (job.type !== "task" || !id) return [];
    const data = isObj(job.schema) ? job.schema.data : undefined;
    const output = data !== undefined ? (typeof data === "string" ? data : JSON.stringify(data, null, 2)) : resultBody(String(job.resultText ?? ""));
    const model = str(job.resolvedModel);
    return [
      {
        id,
        status: job.status === undefined ? "done" : status(job.status),
        ...(num(job.durationMs) !== undefined ? { durationMs: num(job.durationMs) } : {}),
        ...(output ? { output: bound(output) } : {}),
        ...(model ? { model } : {}),
      },
    ];
  });
}

/** Reports on task runs in any tool result's details (omp's wait, read proc://, write proc://…/kill). */
export function detailReports(details: unknown): AgentReport[] {
  if (!isObj(details)) return [];
  return [...jobReports(details.jobs), ...(isObj(details.proc) ? jobReports(details.proc.jobs) : [])];
}

/**
 * omp's background delivery (an `async-result` message): which task runs
 * finished, how, and a preview of what they said.
 */
export function asyncReports(customType: unknown, content: unknown, details: unknown): AgentReport[] {
  if (customType !== "async-result") return [];
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (isObj(b) && typeof b.text === "string" ? b.text : "")).join("\n") : "";
  const out = new Map<string, AgentReport>();
  for (const report of jobReports(isObj(details) ? details.jobs : undefined)) out.set(report.id, report);
  for (const m of text.matchAll(/<task-result id="([^"]+)"[^>]*?status="([^"]+)"[^>]*>([\s\S]*?)(?:<\/task-result>|$)/g)) {
    const id = m[1] as string;
    const prior = out.get(id);
    const body = resultBody(m[3] as string);
    out.set(id, { ...prior, id, status: status(m[2]), ...(prior?.output ? {} : body ? { output: bound(body) } : {}) });
  }
  return [...out.values()];
}

/**
 * pi-subagents' background completion (a `subagent-notify` message):
 * "Background task completed: **scout** …", a preview of the answer, and the
 * run's async directory, which ends in its run id; several come as a
 * numbered list.
 */
export function notifyReports(customType: unknown, content: unknown): AgentReport[] {
  if (customType !== "subagent-notify") return [];
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((b) => (isObj(b) && typeof b.text === "string" ? b.text : "")).join("\n") : "";
  const single = /^(?:Detached foreground|Background) task (\w+): \*\*([^*]+)\*\*/.exec(text);
  const grouped = /^Background tasks (\w+) \(\d+\):/.exec(text);
  if (!single && !grouped) return [];
  const blocks = single ? [text] : text.split(/\n(?=\d+\. )/).slice(1);
  return blocks.flatMap((block): AgentReport[] => {
    const dir = /async directory: (\S+)/.exec(block)?.[1];
    const id = dir?.replace(/\/+$/, "").split("/").pop();
    if (!id) return [];
    const agent = /\*\*([^*]+)\*\*/.exec(block)?.[1] ?? (/^\d+\. (\S+)/.exec(block)?.[1] ?? "");
    const preview = block
      .split("\n")
      .slice(1)
      .filter((l) => !/^(Retention-managed async directory|Workflow run|Child runs|Reconciled detached child|Session|Parallel handoff):/.test(l))
      .join("\n")
      .trim()
      // The preview opens with the agent's name ("scout:"), which the row already shows.
      .replace(new RegExp(`^${agent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*\\n`), "");
    return [{ id, status: status(single ? single[1] : (grouped?.[1] ?? "completed")), ...(preview && preview !== "(no output)" ? { output: bound(preview) } : {}) }];
  });
}

/** Apply background reports to a call's runs; null when none of them is this call's. */
export function applyReports(info: SubagentsInfo, reports: AgentReport[]): SubagentsInfo | null {
  let touched = false;
  const runs = info.runs.map((r): SubagentRun => {
    const report = reports.find((x) => x.id === r.id || (r.ref !== undefined && x.id === r.ref));
    if (!report) return r;
    touched = true;
    // Still running: keep what it was doing.
    const { activity, ...rest } = r;
    return {
      ...rest,
      ...(report.status === "running" && activity ? { activity } : {}),
      status: report.status,
      ...(report.durationMs !== undefined ? { durationMs: report.durationMs } : {}),
      ...(report.output ? { output: report.output } : {}),
      ...(report.model ? { model: report.model } : {}),
    };
  });
  return touched ? { ...info, runs } : null;
}

/** A pi-subagents transcript (records of `{ recordType: "message", message }`) as Pi-family messages. */
export function transcriptRecords(text: string): unknown[] | null {
  const out: unknown[] = [];
  let records = false;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(entry) || typeof entry.recordType !== "string") return records ? out : null;
    records = true;
    if (entry.recordType !== "message" || !isObj(entry.message)) continue;
    const m = entry.message;
    if (m.role === "system") continue;
    // The launcher's audit copy of the prompt; the real brief follows it.
    if (m.role === "user" && /^\[prompt redacted\]/.test(JSON.stringify(m.content).replace(/^\[\{"type":"text","text":"/, ""))) continue;
    out.push({ ...m, ...(typeof entry.ts === "number" ? { timestamp: entry.ts } : {}) });
  }
  return records ? out : null;
}
