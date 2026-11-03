// Grok's ACP session updates, folded once for the live child and for
// updates.jsonl. The two paths share this so a resumed chat and a running one
// cannot drift. Nothing here spawns a process or touches credentials.
import path from "node:path";
import type { ChatItem, ToolItem } from "../../shared/protocol.js";
import { boundText, editShape, isObj, stringifyArgs, toolCategory, toolPaths, toolSummary, type Obj } from "./agent-events.js";
import { lineDiff, resultDiff } from "./tool-diff.js";
import type { HarnessUsage, StepUsage, UsageEntry } from "./types.js";

/** Grok session ids are UUIDs. A path segment that fails this is not a session. */
export const SESSION_ID = /^[0-9a-f-]{36}$/i;

const MAX_DIFF_LINES = 800;
const MAX_DIFF_CHARS = 40_000;
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

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * A unified diff parseUnified can read. Grok's tool results carry old/new text,
 * and the chat fold only understands a unified `details.diff`.
 */
export function unifiedDiff(filePath: string, oldText: string, newText: string): string {
  let oldLines = splitLines(oldText);
  let newLines = splitLines(newText);
  if (oldLines.length > MAX_DIFF_LINES) oldLines = oldLines.slice(0, MAX_DIFF_LINES);
  if (newLines.length > MAX_DIFF_LINES) newLines = newLines.slice(0, MAX_DIFF_LINES);
  const diff = lineDiff(oldLines, newLines);
  const body: string[] = [];
  let oldCount = 0;
  let newCount = 0;
  for (const line of diff) {
    if (line.kind === "add") {
      body.push(`+${line.text}`);
      newCount += 1;
    } else if (line.kind === "del") {
      body.push(`-${line.text}`);
      oldCount += 1;
    } else if (line.kind === "ctx") {
      body.push(` ${line.text}`);
      oldCount += 1;
      newCount += 1;
    }
    if (body.length >= MAX_DIFF_LINES) break;
  }
  const safe = filePath.replace(/[\r\n]/g, "");
  let text = `--- a/${safe}\n+++ b/${safe}\n@@ -1,${oldCount} +1,${newCount} @@\n${body.join("\n")}`;
  if (text.length > MAX_DIFF_CHARS) text = text.slice(0, MAX_DIFF_CHARS);
  return text;
}

function toolName(update: Obj): string {
  const meta = isObj(update._meta) ? update._meta : null;
  const xai = meta && isObj(meta["x.ai/tool"]) ? meta["x.ai/tool"] : null;
  if (xai && typeof xai.name === "string" && xai.name) return xai.name;
  if (typeof update.title === "string" && update.title) return update.title;
  return "tool";
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
  | { type: "usage"; usage: UsageFold }
  | { type: "notice"; text: string; at: number }
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
    return { type: "tool_start", toolCallId, name: toolName(update), args: update.rawInput ?? {}, at };
  }
  if (kind === "tool_call_update") {
    const toolCallId = typeof update.toolCallId === "string" && update.toolCallId ? update.toolCallId : "tool";
    const status = update.status;
    const pieces = contentPieces(update.content);
    const output = pieces.text || (typeof update.rawOutput === "string" ? update.rawOutput : "");
    if (status === "completed" || status === "failed") {
      const details = pieces.diff ? { diff: unifiedDiff(pieces.diff.path, pieces.diff.oldText, pieces.diff.newText) } : undefined;
      return { type: "tool_end", toolCallId, output, isError: status === "failed", ...(details ? { details } : {}), at };
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
    };
  }
  if (kind === "plan") return { type: "notice", text: planText(update), at };
  // hook_execution, background tasks, recaps, setup: noise, not conversation.
  return { type: "ignore" };
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

/** Chat items for a stored transcript. A tool still running at the end of the file failed with the session. */
export function itemsFromFolds(folds: GrokFold[]): ChatItem[] {
  const items: ChatItem[] = [];
  let assistant: Extract<ChatItem, { kind: "assistant" }> | null = null;
  const open = new Map<string, number>();
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
      open.set(fold.toolCallId, items.length);
      items.push(toolItem(fold));
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
      }
      const bounded = boundText(fold.type === "tool_end" ? fold.output : fold.output);
      if (fold.type === "tool_update") {
        item.output = bounded.text;
        item.truncated = bounded.truncated;
        continue;
      }
      const edits = item.category === "edit" || item.category === "write";
      const reported = edits ? resultDiff(fold.details, bounded.text) : null;
      if (!fold.isError && reported) Object.assign(item, editShape(reported, null));
      item.output = bounded.text;
      item.truncated = bounded.truncated;
      item.status = fold.isError ? "error" : "done";
      item.endedAt = fold.at;
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
    }
  }
  closeAssistant();
  return items;
}
