// Grok's ACP session updates, folded once for the live child and for
// updates.jsonl. The two paths share this so a resumed chat and a running one
// cannot drift. Nothing here spawns a process or touches credentials.
import path from "node:path";
import type { ChatItem, ToolItem } from "../../shared/protocol.js";
import { boundText, editShape, isObj, stringifyArgs, toolCategory, toolPaths, toolSummary, type Obj } from "./agent-events.js";
import { ORCH_MCP_SERVER } from "./render-extension.js";
import { HTML_RENDER_MCP_SERVER, htmlRenderRef, isHtmlRenderCall, splitRenderMarker } from "./render-token.js";
import { runsFromArgs, runsFromDetails, settleRuns } from "./subagents.js";
import { resultDiff, unifiedDiff } from "./tool-diff.js";
import type { HarnessUsage, StepUsage, UsageEntry } from "./types.js";

/** Grok session ids are UUIDs. A path segment that fails this is not a session. */
export const SESSION_ID = /^[0-9a-f-]{36}$/i;

const MAX_PLAN_CHARS = 500;

export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id) && !id.includes("/") && !id.includes("..");
}

/** The group directory Grok uses when the encoded cwd fits in one file name. */
export function encodedCwd(cwd: string): string {
  return encodeURIComponent(path.resolve(cwd));
}

/** Epoch ms. Grok's jsonl stamps are seconds (a 10-digit clock); ISO strings also appear on summaries. */
export function epochMs(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  if (typeof value === "string" && value) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** USD from Grok's costUsdTicks (1e10 ticks per dollar). Missing or zero stays unpriced. */
export function costUsd(ticks: unknown): number | null {
  if (typeof ticks !== "number" || !Number.isSafeInteger(ticks) || ticks <= 0) return null;
  return ticks / 1e10;
}

export interface ParsedSummary {
  id: string;
  cwd: string;
  /** Set only when Grok generated one; the first-prompt fallback is not stored here. */
  generatedTitle: string | null;
  updatedAt: string | null;
  messageCount?: number;
}

/** summary.json, or null when it is not one of Grok's session summaries. */
export function parseSummary(raw: unknown): ParsedSummary | null {
  if (!isObj(raw)) return null;
  const info = isObj(raw.info) ? raw.info : null;
  const id = typeof info?.id === "string" ? info.id : typeof raw.id === "string" ? raw.id : "";
  const cwd = typeof info?.cwd === "string" ? info.cwd : typeof raw.cwd === "string" ? raw.cwd : "";
  if (!isSessionId(id) || !cwd) return null;
  const generated = typeof raw.generated_title === "string" ? raw.generated_title.trim() : "";
  const updated = typeof raw.updated_at === "string" ? raw.updated_at : typeof raw.last_active_at === "string" ? raw.last_active_at : null;
  const count = raw.num_messages;
  const messageCount = typeof count === "number" && Number.isInteger(count) && count >= 0 ? count : undefined;
  return { id, cwd, generatedTitle: generated || null, updatedAt: updated, ...(messageCount !== undefined ? { messageCount } : {}) };
}

function textOfBlock(block: unknown): string {
  if (typeof block === "string") return block;
  if (!isObj(block)) return "";
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (typeof block.text === "string" && block.type !== "diff") return block.text;
  if (block.type === "content") {
    if (typeof block.content === "string") return block.content;
    if (isObj(block.content)) {
      if (typeof block.content.text === "string") return block.content.text;
      if (typeof block.content.content === "string") return block.content.content;
    }
  }
  return "";
}

/** Text out of a chunk's `content` (one block, or a list of them). */
export function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOfBlock).filter(Boolean).join("\n");
  return textOfBlock(content);
}

interface DiffPiece {
  path: string;
  oldText: string;
  newText: string;
}

function contentPieces(content: unknown): { text: string; diff: DiffPiece | null } {
  const blocks = Array.isArray(content) ? content : content === undefined || content === null ? [] : [content];
  const texts: string[] = [];
  let diff: DiffPiece | null = null;
  for (const block of blocks) {
    if (isObj(block) && block.type === "diff" && typeof block.path === "string") {
      diff = { path: block.path, oldText: typeof block.oldText === "string" ? block.oldText : "", newText: typeof block.newText === "string" ? block.newText : "" };
      continue;
    }
    const text = textOfBlock(block);
    if (text) texts.push(text);
  }
  return { text: texts.join("\n"), diff };
}


function toolName(update: Obj): string {
  const meta = isObj(update._meta) ? update._meta : null;
  const xai = meta && isObj(meta["x.ai/tool"]) ? meta["x.ai/tool"] : null;
  if (xai && typeof xai.name === "string" && xai.name) return xai.name;
  if (typeof update.title === "string" && update.title) return update.title;
  return "tool";
}

/** awui's own MCP servers: the ones whose calls the rest of awui reads by name. */
const AWUI_MCP_SERVERS: ReadonlySet<string> = new Set([HTML_RENDER_MCP_SERVER, ORCH_MCP_SERVER]);

/** Grok's qualified MCP tool name: `<server>__<tool>`, the tool segment allowed to start with a digit. */
const QUALIFIED_MCP_TOOL = /^([A-Za-z_][A-Za-z0-9_-]*)__([A-Za-z0-9][A-Za-z0-9_-]*)$/;

/**
 * How an MCP call reaches Grok: the qualified `server__tool` name, or the `use_tool`
 * dispatcher with `{ tool_name, tool_input }`. awui's own servers' calls are renamed to
 * the `mcp__server__tool` spelling the rest of awui reads (render-token.ts finds the
 * render tool by it, tool-sentence.ts the orchestration tools), so a rendered page and a
 * delegation keep their cards whichever spelling the build used; a user's own server
 * keeps Grok's name. Every other call is returned as it came.
 */
function mcpCall(name: string, rawArgs: unknown): { name: string; args: unknown } {
  const args = isObj(rawArgs) ? rawArgs : {};
  const target = name === "use_tool" && typeof args.tool_name === "string" ? args.tool_name : name;
  const match = QUALIFIED_MCP_TOOL.exec(target);
  const server = match?.[1];
  const tool = match?.[2];
  if (server === undefined || tool === undefined) return { name, args: rawArgs ?? {} };
  // The dispatcher carries the tool's own arguments in tool_input; a direct call carries them already.
  const inner = name === "use_tool" && isObj(args.tool_input) ? args.tool_input : rawArgs ?? {};
  return { name: AWUI_MCP_SERVERS.has(server) ? `mcp__${server}__${tool}` : target, args: inner };
}

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export interface UsageFold {
  at: number;
  model: string | null;
  step: StepUsage;
  /** Null when this call was not priced (OAuth often omits it). */
  cost: number | null;
  steps: number;
}

export type GrokFold =
  | { type: "user"; text: string; at: number }
  | { type: "delta"; field: "text" | "thinking"; delta: string }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown; at: number }
  | { type: "tool_update"; toolCallId: string; output: string }
  | { type: "tool_end"; toolCallId: string; output: string; isError: boolean; details?: unknown; at: number }
  /** `turnEnded`: this usage came with `turn_completed`, the harness's end of a turn. */
  | { type: "usage"; usage: UsageFold; turnEnded?: boolean }
  /** ACP `usage_update`: the harness's own context occupancy, when it sends one. */
  | { type: "context"; used: number; size: number }
  | { type: "notice"; text: string; at: number }
  /**
   * One child of a `spawn_subagent` call. The events name the child, not the
   * tool call; `GrokSubagentBook` joins them. A finish omits the type and the
   * label, which the spawn carried.
   */
  | {
      type: "subagent";
      phase: "spawned" | "finished";
      childId: string;
      agent?: string;
      task?: string;
      model?: string;
      /** The CLI's word (`running`, `completed`, `failed`, `cancelled`). */
      status: string;
      error?: string;
      toolCount?: number;
      tokens?: number;
      durationMs?: number;
      output?: string;
    }
  | { type: "ignore" };

function planText(update: Obj): string {
  const entries = update.entries;
  let text = "";
  if (Array.isArray(entries)) {
    text = entries
      .map((entry) => (isObj(entry) ? String(entry.content ?? entry.text ?? entry.title ?? "") : String(entry)))
      .filter(Boolean)
      .join("; ");
  } else if (typeof update.content === "string") text = update.content;
  return oneLine(text, MAX_PLAN_CHARS) || "Plan updated";
}

/** One `session/update` payload (the object with `sessionUpdate`). */
export function foldSessionUpdate(update: unknown, at: number): GrokFold {
  if (!isObj(update) || typeof update.sessionUpdate !== "string") return { type: "ignore" };
  const kind = update.sessionUpdate;
  if (kind === "user_message_chunk") {
    const text = contentText(update.content);
    return text ? { type: "user", text, at } : { type: "ignore" };
  }
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const delta = contentText(update.content);
    if (!delta) return { type: "ignore" };
    return { type: "delta", field: kind === "agent_thought_chunk" ? "thinking" : "text", delta };
  }
  if (kind === "tool_call") {
    const toolCallId = typeof update.toolCallId === "string" && update.toolCallId ? update.toolCallId : "tool";
    const call = mcpCall(toolName(update), update.rawInput);
    return { type: "tool_start", toolCallId, name: call.name, args: call.args, at };
  }
  if (kind === "tool_call_update") {
    const toolCallId = typeof update.toolCallId === "string" && update.toolCallId ? update.toolCallId : "tool";
    const status = update.status;
    const pieces = contentPieces(update.content);
    const output = pieces.text || (typeof update.rawOutput === "string" ? update.rawOutput : "");
    if (status === "completed" || status === "failed") {
      // An awui MCP server answers on its last line with the page's reference; the card shows the text without it.
      const marked = splitRenderMarker(output);
      const details = {
        ...(pieces.diff ? { diff: unifiedDiff(pieces.diff.path, pieces.diff.oldText, pieces.diff.newText) } : {}),
        ...marked.details,
      };
      return { type: "tool_end", toolCallId, output: marked.text, isError: status === "failed", ...(Object.keys(details).length > 0 ? { details } : {}), at };
    }
    // Progress frames add locations and args and often no text; skip the empty ones.
    return output ? { type: "tool_update", toolCallId, output } : { type: "ignore" };
  }
  if (kind === "turn_completed") {
    const usage = isObj(update.usage) ? update.usage : {};
    const modelUsage = isObj(usage.modelUsage) ? usage.modelUsage : null;
    const modelKeys = modelUsage ? Object.keys(modelUsage) : [];
    const step: StepUsage = {
      input: finite(usage.inputTokens),
      output: finite(usage.outputTokens),
      cacheRead: finite(usage.cachedReadTokens),
      cacheWrite: finite(usage.cacheCreationTokens),
    };
    return {
      type: "usage",
      usage: {
        at,
        model: modelKeys.length === 1 ? (modelKeys[0] ?? null) : null,
        step,
        cost: costUsd(usage.costUsdTicks),
        steps: typeof usage.modelCalls === "number" && Number.isFinite(usage.modelCalls) ? usage.modelCalls : 1,
      },
      // The turn is over. `session/prompt` answers only at the end, and that answer
      // can never come (a dropped response left a chat "running" for hours); this
      // is the harness saying so on the wire, so it closes the turn too.
      turnEnded: true,
    };
  }
  if (kind === "usage_update") {
    const used = finite(update.used);
    const size = finite(update.size);
    // Grok 1.0.77 names this update but does not write it into updates.jsonl.
    // A build that does send it is the occupancy to trust, size included.
    return size > 0 ? { type: "context", used, size } : { type: "ignore" };
  }
  if (kind === "subagent_spawned" || kind === "subagent_finished") return subagentFold(update, kind);
  if (kind === "plan") return { type: "notice", text: planText(update), at };
  // hook_execution, background shell tasks, recaps, setup: noise, not conversation.
  return { type: "ignore" };
}

const MAX_SUBAGENT_ERROR = 2_000;
const MAX_SUBAGENT_OUTPUT = 12_000;

function clipText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? `${trimmed.slice(0, max)}\n…` : trimmed;
}

function countOf(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** `subagent_spawned` / `subagent_finished`. A child id that is not one of Grok's session ids is dropped. */
function subagentFold(update: Obj, kind: "subagent_spawned" | "subagent_finished"): GrokFold {
  const childId = typeof update.child_session_id === "string" ? update.child_session_id : typeof update.subagent_id === "string" ? update.subagent_id : "";
  if (!isSessionId(childId)) return { type: "ignore" };
  const agent = clipText(update.subagent_type, 80);
  const task = clipText(update.description, 500);
  const model = clipText(update.model, 80);
  if (kind === "subagent_spawned") {
    return { type: "subagent", phase: "spawned", childId, status: "running", ...(agent ? { agent } : {}), ...(task ? { task } : {}), ...(model ? { model } : {}) };
  }
  const error = clipText(update.error, MAX_SUBAGENT_ERROR);
  const output = clipText(update.output, MAX_SUBAGENT_OUTPUT);
  const toolCount = countOf(update.tool_calls);
  const tokens = countOf(update.tokens_used);
  const durationMs = countOf(update.duration_ms);
  const status = typeof update.status === "string" && update.status.trim() ? update.status.trim() : "completed";
  return {
    type: "subagent",
    phase: "finished",
    childId,
    status,
    ...(agent ? { agent } : {}),
    ...(task ? { task } : {}),
    ...(model ? { model } : {}),
    ...(error ? { error } : {}),
    ...(output ? { output } : {}),
    ...(toolCount !== undefined ? { toolCount } : {}),
    ...(tokens !== undefined ? { tokens } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
  };
}

/** The update object inside a `session/update` or `_x.ai/session/update` frame, or null. */
export function updateOf(frame: Obj): Obj | null {
  if (frame.method !== "session/update" && frame.method !== "_x.ai/session/update") return null;
  const params = isObj(frame.params) ? frame.params : null;
  if (!params) return null;
  if (isObj(params.update)) return params.update;
  if (typeof params.sessionUpdate === "string") return params;
  return null;
}

/** Folds from updates.jsonl text. Incomplete trailing lines (a bounded read) are skipped. */
export function foldsFromJsonl(text: string): GrokFold[] {
  const folds: GrokFold[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(row)) continue;
    const update = updateOf(row);
    if (!update) continue;
    const fold = foldSessionUpdate(update, epochMs(row.timestamp));
    if (fold.type !== "ignore") folds.push(fold);
  }
  return folds;
}

/** The first user prompt in a jsonl head: one line, cut to 80, for a session with no generated title. */
export function firstPrompt(jsonlHead: string): string | null {
  for (const fold of foldsFromJsonl(jsonlHead)) {
    if (fold.type === "user" && fold.text.trim()) return oneLine(fold.text, 80);
  }
  return null;
}

export function emptyUsage(): HarnessUsage {
  return { turns: 0, steps: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: 0 };
}

/**
 * Tokens in the window after one turn.
 * Grok's `inputTokens` already include `cachedReadTokens` (`totalTokens` is
 * input plus output). Adding the cache again pushed a large turn past the
 * window, and the ring clamped that to 100%. A payload whose cache is larger
 * than its input reports the cache on top instead.
 */
export function contextTokens(step: StepUsage): number {
  const cache = step.cacheRead + step.cacheWrite;
  if (cache > step.input) return step.input + cache;
  return step.input + step.output;
}

/** Add one turn. One unpriced turn makes the session total unpriced from then on. */
export function addTurn(total: HarnessUsage, turn: UsageFold, incomplete: { value: boolean }): HarnessUsage {
  if (turn.cost === null) incomplete.value = true;
  const cost = incomplete.value || total.cost === null ? null : total.cost + (turn.cost ?? 0);
  return {
    turns: total.turns + 1,
    steps: total.steps + turn.steps,
    input: total.input + turn.step.input,
    cachedInput: total.cachedInput + turn.step.cacheRead,
    cacheWrite: total.cacheWrite + turn.step.cacheWrite,
    output: total.output + turn.step.output,
    cost,
  };
}

export function usageFromFolds(folds: GrokFold[]): { usage: HarnessUsage; entries: UsageEntry[]; last: UsageFold | null } {
  let usage = emptyUsage();
  const incomplete = { value: false };
  const entries: UsageEntry[] = [];
  let last: UsageFold | null = null;
  for (const fold of folds) {
    if (fold.type !== "usage") continue;
    last = fold.usage;
    usage = addTurn(usage, fold.usage, incomplete);
    entries.push({
      at: fold.usage.at,
      model: fold.usage.model,
      input: fold.usage.step.input,
      cachedInput: fold.usage.step.cacheRead,
      cacheWrite: fold.usage.step.cacheWrite,
      output: fold.usage.step.output,
      cost: fold.usage.cost,
    });
  }
  return { usage, entries, last };
}

interface SubagentRunState {
  id: string;
  agent: string;
  task: string;
  /** The CLI's word, which runsFromDetails maps onto the card's status. */
  status: string;
  model?: string;
  toolCount?: number;
  tokens?: number;
  durationMs?: number;
  error?: string;
  output?: string;
}

interface SpawnToolState {
  background: boolean;
  ended: boolean;
  /** The label from the call's arguments, used when the spawn event omits one. */
  task: string;
  runs: SubagentRunState[];
}

function spawnLabel(args: unknown): string {
  if (!isObj(args)) return "";
  const description = typeof args.description === "string" ? args.description.trim() : "";
  if (description) return description.slice(0, 500);
  const prompt = typeof args.prompt === "string" ? args.prompt.replace(/\s+/g, " ").trim() : "";
  return prompt.slice(0, 200);
}

function isSpawn(name: string): boolean {
  return name.toLowerCase() === "spawn_subagent";
}

/**
 * Joins `subagent_spawned` / `subagent_finished` to the `spawn_subagent` call
 * they belong to. The events carry the child session id and not the tool call
 * id. A foreground call can retry (two children, one call). A background call
 * returns before the child finishes, so the join survives the tool ending.
 * The snapshot is the whole set of rows, which runsFromDetails folds.
 */
export class GrokSubagentBook {
  private readonly tools = new Map<string, SpawnToolState>();
  private readonly order: string[] = [];
  private readonly childTool = new Map<string, string>();

  /**
   * Note a tool boundary, or fold one subagent event. Returns the call to
   * update and a full progress/results snapshot, or null when this fold is
   * not a subagent report.
   */
  ingest(fold: GrokFold): { toolCallId: string; details: Record<string, unknown> } | null {
    if (fold.type === "tool_start") {
      this.noteTool(fold.toolCallId, fold.name, fold.args);
      return null;
    }
    if (fold.type === "tool_end") {
      this.noteEnd(fold.toolCallId);
      return null;
    }
    if (fold.type !== "subagent") return null;
    const toolCallId = fold.phase === "finished" ? (this.childTool.get(fold.childId) ?? this.target()) : this.target();
    if (!toolCallId) return null;
    const tool = this.tools.get(toolCallId);
    if (!tool) return null;
    this.childTool.set(fold.childId, toolCallId);
    const prior = tool.runs.find((run) => run.id === fold.childId);
    const run: SubagentRunState = prior ?? { id: fold.childId, agent: fold.agent ?? "agent", task: fold.task ?? tool.task, status: fold.status };
    if (fold.agent) run.agent = fold.agent;
    if (fold.task) run.task = fold.task;
    else if (!run.task) run.task = tool.task;
    run.status = fold.status;
    if (fold.model) run.model = fold.model;
    if (fold.toolCount !== undefined) run.toolCount = fold.toolCount;
    if (fold.tokens !== undefined) run.tokens = fold.tokens;
    if (fold.durationMs !== undefined) run.durationMs = fold.durationMs;
    if (fold.error) run.error = fold.error;
    if (fold.output) run.output = fold.output;
    if (!prior) tool.runs.push(run);
    return this.snapshot(toolCallId);
  }

  private noteTool(toolCallId: string, name: string, args: unknown): void {
    if (!isSpawn(name) || this.tools.has(toolCallId)) return;
    const background = isObj(args) && (args.background === true || args.run_in_background === true);
    this.tools.set(toolCallId, { background, ended: false, task: spawnLabel(args), runs: [] });
    this.order.push(toolCallId);
  }

  private noteEnd(toolCallId: string): void {
    const tool = this.tools.get(toolCallId);
    if (tool) tool.ended = true;
  }

  /** The spawn still open, else the latest one (a finish racing the tool's own result). */
  private target(): string | null {
    for (let i = this.order.length - 1; i >= 0; i -= 1) {
      const id = this.order[i];
      const tool = id !== undefined ? this.tools.get(id) : undefined;
      if (tool && !tool.ended) return id ?? null;
    }
    return this.order[this.order.length - 1] ?? null;
  }

  private snapshot(toolCallId: string): { toolCallId: string; details: Record<string, unknown> } | null {
    const tool = this.tools.get(toolCallId);
    if (!tool || tool.runs.length === 0) return null;
    const rows = tool.runs.map((run, index) => {
      const row: Record<string, unknown> = { id: run.id, index, agent: run.agent, task: run.task, status: run.status };
      if (run.model) row.model = run.model;
      if (run.toolCount !== undefined) row.toolCount = run.toolCount;
      if (run.tokens !== undefined) row.tokens = run.tokens;
      if (run.durationMs !== undefined) row.durationMs = run.durationMs;
      if (run.error) row.error = run.error;
      if (run.output) row.output = run.output;
      return row;
    });
    const running = rows.filter((row) => row.status === "running" || row.status === "pending");
    const done = rows.filter((row) => row.status !== "running" && row.status !== "pending");
    return {
      toolCallId,
      details: {
        ...(tool.background ? { background: true } : {}),
        ...(running.length > 0 ? { progress: running } : {}),
        ...(done.length > 0 ? { results: done } : {}),
      },
    };
  }
}

function toolItem(fold: Extract<GrokFold, { type: "tool_start" }>): ToolItem {
  const category = toolCategory(fold.name);
  const edits = category === "edit" || category === "write";
  return {
    kind: "tool",
    id: `t:${fold.toolCallId}`,
    name: fold.name,
    args: stringifyArgs(fold.args),
    status: "running",
    output: "",
    truncated: false,
    category,
    summary: toolSummary(fold.args, fold.name),
    paths: toolPaths(fold.args),
    ...(edits ? editShape(null, null) : {}),
    at: fold.at,
  };
}

function attachSubagents(item: ToolItem, toolCallId: string, details: Record<string, unknown>): void {
  const runs = runsFromDetails(toolCallId, details, item.subagents ?? null);
  if (runs) item.subagents = runs;
}

/** Chat items for a stored transcript. A tool still running at the end of the file failed with the session. */
export function itemsFromFolds(folds: GrokFold[]): ChatItem[] {
  const items: ChatItem[] = [];
  let assistant: Extract<ChatItem, { kind: "assistant" }> | null = null;
  const open = new Map<string, number>();
  const toolAt = new Map<string, number>();
  const subagents = new GrokSubagentBook();
  /** Calls the render tool made, whose result carries a page the chat shows. */
  const renderCalls = new Set<string>();
  let n = 0;
  const closeAssistant = () => {
    if (assistant?.streaming) {
      assistant.streaming = false;
      assistant.endedAt = assistant.at;
    }
    assistant = null;
  };
  for (const fold of folds) {
    if (fold.type === "user") {
      closeAssistant();
      items.push({ kind: "user", id: `u${++n}`, text: fold.text, at: fold.at });
    } else if (fold.type === "delta") {
      if (!assistant) {
        assistant = { kind: "assistant", id: `a${++n}`, text: "", thinking: "", streaming: true, at: Date.now() };
        items.push(assistant);
      }
      assistant[fold.field] += fold.delta;
    } else if (fold.type === "tool_start") {
      closeAssistant();
      subagents.ingest(fold);
      const started = toolItem(fold);
      if (isHtmlRenderCall(fold.name, fold.args)) renderCalls.add(fold.toolCallId);
      if (started.category === "agent") {
        const runs = runsFromArgs(fold.args);
        if (runs) started.subagents = runs;
      }
      open.set(fold.toolCallId, items.length);
      toolAt.set(fold.toolCallId, items.length);
      items.push(started);
    } else if (fold.type === "subagent") {
      const linked = subagents.ingest(fold);
      const index = linked ? toolAt.get(linked.toolCallId) : undefined;
      const item = index !== undefined ? items[index] : undefined;
      if (linked && item && item.kind === "tool") attachSubagents(item, linked.toolCallId, linked.details);
    } else if (fold.type === "tool_update" || fold.type === "tool_end") {
      let index = open.get(fold.toolCallId);
      let item = index !== undefined ? items[index] : undefined;
      if (!item || item.kind !== "tool") {
        if (fold.type !== "tool_end") continue;
        const started: Extract<GrokFold, { type: "tool_start" }> = { type: "tool_start", toolCallId: fold.toolCallId, name: "tool", args: {}, at: fold.at };
        index = items.length;
        item = toolItem(started);
        items.push(item);
        open.set(fold.toolCallId, index);
        toolAt.set(fold.toolCallId, index);
      }
      const bounded = boundText(fold.output);
      if (fold.type === "tool_update") {
        item.output = bounded.text;
        item.truncated = bounded.truncated;
        continue;
      }
      const edits = item.category === "edit" || item.category === "write";
      const reported = edits ? resultDiff(fold.details, bounded.text) : null;
      if (!fold.isError && reported) Object.assign(item, editShape(reported, null));
      // The live chat shows a page only for a call the render tool made; history agrees.
      const page = renderCalls.delete(fold.toolCallId) ? htmlRenderRef(fold.details) : undefined;
      if (page) item.htmlRender = page;
      item.output = bounded.text;
      item.truncated = bounded.truncated;
      item.status = fold.isError ? "error" : "done";
      item.endedAt = fold.at;
      // A background child keeps running after this result. An inline one that
      // is still open failed with the call (its own finish never arrived).
      subagents.ingest(fold);
      if (item.subagents) item.subagents = settleRuns(item.subagents, bounded.text, fold.isError);
      open.delete(fold.toolCallId);
    } else if (fold.type === "notice") {
      items.push({ kind: "notice", id: `n${++n}`, level: "info", text: fold.text, at: fold.at });
    }
  }
  for (const index of open.values()) {
    const item = items[index];
    if (item && item.kind === "tool" && item.status === "running") {
      item.status = "error";
      item.endedAt = item.at;
      if (item.subagents && !item.subagents.background) item.subagents = settleRuns(item.subagents, item.output, true);
    }
  }
  closeAssistant();
  return items;
}
