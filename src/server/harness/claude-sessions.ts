// Claude Code session files, read-only: `<config>/projects/<cwd as dashes>/<id>.jsonl`.
// Each line is an entry; conversation entries form a tree through uuid /
// parentUuid, and the active branch is the walk from the last one. Between the
// messages sit entries the transcript never shows (attachments, hook output,
// titles, cost snapshots). This module turns one file into what the adapter
// needs: listing metadata, the transcript as Pi-family messages for
// historyToItems, the usage baseline, each call's usage, and a fork cut after
// the Nth prompt.
import { isObj, textOf, type Obj } from "./agent-events.js";
import { claudeTaskNotice } from "./jobs.js";
import { splitRenderMarker } from "./render-token.js";
import type { UsageEntry } from "./types.js";

/** Claude Code's project folder name: every character but [A-Za-z0-9] becomes "-". */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

export function parseEntries(text: string): Obj[] {
  const out: Obj[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isObj(entry)) out.push(entry);
    } catch {
      // A torn last line while the CLI appends; the rest still parses.
    }
  }
  return out;
}

const CONVERSATION_TYPES = new Set(["user", "assistant", "system", "attachment"]);

/** The active branch, root first: from the last conversation entry back through parentUuid. */
export function activeBranch(entries: Obj[]): Obj[] {
  const byId = new Map<string, Obj>();
  let leaf: Obj | undefined;
  for (const entry of entries) {
    if (typeof entry.uuid !== "string" || entry.isSidechain === true || !CONVERSATION_TYPES.has(String(entry.type))) continue;
    byId.set(entry.uuid, entry);
    leaf = entry;
  }
  const chain: Obj[] = [];
  const seen = new Set<string>();
  let current = leaf;
  while (current && typeof current.uuid === "string" && !seen.has(current.uuid)) {
    seen.add(current.uuid);
    chain.push(current);
    current = typeof current.parentUuid === "string" ? byId.get(current.parentUuid) : undefined;
  }
  return chain.reverse();
}

/**
 * What the model still sees: the active branch from the last compaction on.
 * After a compaction the CLI starts a new chain at the boundary (boundary →
 * summary), but in print mode it keeps appending to the old leaf, so the walk
 * from the leaf runs back through history the model no longer has. Cutting at
 * the last compact_boundary in file order handles both layouts. `head` is the
 * boundary and its summary, which a copy needs to keep the same context.
 */
export function visibleBranch(entries: Obj[]): { chain: Obj[]; compacted: boolean; head: Obj[] } {
  let boundary = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i] as Obj;
    if (e.type === "system" && e.subtype === "compact_boundary" && e.isSidechain !== true) {
      boundary = i;
      break;
    }
  }
  const branch = activeBranch(entries);
  if (boundary < 0) return { chain: branch, compacted: false, head: [] };
  const position = new Map(entries.map((e, i) => [e, i]));
  const boundaryEntry = entries[boundary] as Obj;
  const head = [boundaryEntry, ...entries.slice(boundary + 1).filter((e) => e.type === "user" && e.isCompactSummary === true && e.parentUuid === boundaryEntry.uuid)];
  const chain = branch.filter((e) => (position.get(e) ?? -1) > boundary && !head.includes(e));
  return { chain, compacted: true, head };
}

const INTERRUPTED = /^\[Request interrupted by user[^\]]*\]$/;

/** What a user entry is, as the transcript shows it. */
export type UserEntryKind =
  | { kind: "prompt"; text: string; content: unknown }
  | { kind: "tool_results"; results: Obj[] }
  | { kind: "command_output"; text: string }
  | { kind: "compact_summary" }
  | { kind: "hidden" };

const tag = (text: string, name: string): string | null => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? (m[1] ?? "").trim() : null;
};

export function classifyUser(entry: Obj): UserEntryKind {
  if (entry.isMeta === true || entry.isVisibleInTranscriptOnly === true) return { kind: "hidden" };
  if (entry.isCompactSummary === true) return { kind: "compact_summary" };
  const message = isObj(entry.message) ? entry.message : {};
  const content = message.content;
  if (Array.isArray(content)) {
    const results = content.filter((b): b is Obj => isObj(b) && b.type === "tool_result");
    if (results.length > 0) return { kind: "tool_results", results };
  }
  const text = textOf(content).trim();
  const hasImage = Array.isArray(content) && content.some((b) => isObj(b) && b.type === "image");
  if (!text && !hasImage) return { kind: "hidden" };
  if (INTERRUPTED.test(text)) return { kind: "hidden" };
  // A slash command is stored as tags; it reads as the command the user typed.
  const command = tag(text, "command-name");
  if (command !== null) {
    const args = tag(text, "command-args");
    const typed = `${command.startsWith("/") ? command : `/${command}`}${args ? ` ${args}` : ""}`;
    return { kind: "prompt", text: typed, content: typed };
  }
  const stdout = tag(text, "local-command-stdout");
  if (stdout !== null) return stdout ? { kind: "command_output", text: stdout } : { kind: "hidden" };
  if (/^<(local-command-caveat|local-command-stderr|system-reminder)>/.test(text)) return { kind: "hidden" };
  return { kind: "prompt", text, content };
}

/** A queued_command attachment's text: what was put in the turn while it ran. */
function queuedText(entry: Obj): string | null {
  if (entry.type !== "attachment" || !isObj(entry.attachment) || entry.attachment.type !== "queued_command") return null;
  const prompt = entry.attachment.prompt;
  return typeof prompt === "string" && prompt.trim() ? prompt : null;
}

const TASK_NOTIFICATION = /^\s*<task-notification>/;

/**
 * A message the user sent mid-turn (steer or follow-up) is stored as a
 * queued_command attachment. So is Claude Code telling the model that a
 * background task finished (`<task-notification>`), which is no prompt: it
 * neither shows as one nor counts as a turn (see taskNotice).
 */
function queuedPrompt(entry: Obj): string | null {
  const text = queuedText(entry);
  return text === null || TASK_NOTIFICATION.test(text) ? null : text;
}

/** A background task's notification, as the line Claude Code shows for it: its summary. */
function taskNotice(entry: Obj): string | null {
  const text = queuedText(entry);
  if (text === null || !TASK_NOTIFICATION.test(text)) return null;
  return tag(text, "summary") || "A background task finished";
}

/** The text of a prompt the user sent (typed, a command, or injected mid-turn), or null. */
export function promptText(entry: Obj): string | null {
  const queued = queuedPrompt(entry);
  if (queued !== null) return queued;
  if (entry.type !== "user") return null;
  const kind = classifyUser(entry);
  return kind.kind === "prompt" ? kind.text : null;
}

const ms = (raw: unknown): number | undefined => {
  const t = typeof raw === "string" ? Date.parse(raw) : typeof raw === "number" ? raw : NaN;
  return Number.isFinite(t) ? t : undefined;
};

function toolResultContent(block: Obj): Obj[] {
  const c = block.content;
  if (typeof c === "string") return [{ type: "text", text: c }];
  if (Array.isArray(c)) {
    return c.flatMap((b): Obj[] => (isObj(b) && b.type === "text" ? [{ type: "text", text: String(b.text ?? "") }] : isObj(b) && b.type === "image" ? [{ type: "image" }] : []));
  }
  return [];
}

/** A Claude image block (`source: {type: "base64", media_type, data}`) in the Pi-family shape, data kept. */
function piImage(block: Obj): Obj {
  const source = isObj(block.source) ? block.source : {};
  return source.type === "base64" && typeof source.data === "string" && typeof source.media_type === "string"
    ? { type: "image", data: source.data, mimeType: source.media_type }
    : { type: "image" };
}

/** User content in the Pi-family shape: text and image blocks. */
function userContent(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.flatMap((b): Obj[] => (isObj(b) && b.type === "text" ? [{ type: "text", text: String(b.text ?? "") }] : isObj(b) && b.type === "image" ? [piImage(b)] : []));
}

/**
 * The active branch as Pi-family messages (user / assistant with toolCall
 * blocks / toolResult / compactionSummary), the shape historyToItems reads.
 * Claude Code stores one assistant entry per content block; entries sharing a
 * message id become one message again.
 */
export function transcriptMessages(entries: Obj[]): Obj[] {
  const out: Obj[] = [];
  let assistant: { id: string; message: Obj } | null = null;
  const toolNames = new Map<string, string>();
  const { chain, compacted } = visibleBranch(entries);
  if (compacted) out.push({ role: "compactionSummary" });
  for (const entry of chain) {
    const at = ms(entry.timestamp);
    const stamp = at === undefined ? {} : { timestamp: at };
    if (entry.type === "assistant" && isObj(entry.message)) {
      const message = entry.message;
      const id = typeof message.id === "string" ? message.id : String(entry.uuid);
      if (!assistant || assistant.id !== id) {
        assistant = { id, message: { role: "assistant", content: [], ...(typeof message.model === "string" && message.model !== "<synthetic>" ? { model: message.model } : {}), ...stamp } };
        out.push(assistant.message);
      }
      const content = assistant.message.content as Obj[];
      for (const block of Array.isArray(message.content) ? message.content : []) {
        if (!isObj(block)) continue;
        if (block.type === "text" && typeof block.text === "string") content.push({ type: "text", text: block.text });
        else if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) content.push({ type: "thinking", thinking: block.thinking });
        else if (block.type === "tool_use") {
          const callId = String(block.id);
          toolNames.set(callId, String(block.name ?? "tool"));
          content.push({ type: "toolCall", id: callId, name: String(block.name ?? "tool"), arguments: block.input ?? {} });
        }
      }
      continue;
    }
    const queued = queuedPrompt(entry);
    if (queued !== null) {
      assistant = null;
      out.push({ role: "user", content: queued, ...stamp });
      continue;
    }
    const notice = taskNotice(entry);
    if (notice !== null) {
      // A displayed custom message is a notice row in historyToItems, inside the turn it arrived in.
      // Its task's id and state ride along, so the call that started it is told how it ended.
      const job = claudeTaskNotice(queuedText(entry) ?? "");
      out.push({ role: "custom", customType: "background-task", display: true, content: notice, ...(job ? { details: { jobs: [{ id: job.id, status: job.status, label: job.label, ...(job.title ? { title: job.title } : {}) }] } } : {}), ...stamp });
      continue;
    }
    if (entry.type !== "user") continue;
    const kind = classifyUser(entry);
    if (kind.kind === "hidden" || kind.kind === "compact_summary") continue;
    assistant = null;
    if (kind.kind === "tool_results") {
      for (const block of kind.results) {
        const callId = String(block.tool_use_id);
        // An edit's structuredPatch rides on the entry, which holds one result; render_html's page, on its result's last line.
        const content = toolResultContent(block);
        const lastText = [...content].reverse().find((c) => c.type === "text" && typeof c.text === "string");
        const marked = lastText ? splitRenderMarker(lastText.text as string) : null;
        if (marked?.details && lastText) lastText.text = marked.text;
        const details = marked?.details ? { details: marked.details } : kind.results.length === 1 && isObj(entry.toolUseResult) ? { details: entry.toolUseResult } : {};
        out.push({ role: "toolResult", toolCallId: callId, toolName: toolNames.get(callId) ?? "tool", content, isError: block.is_error === true, ...details, ...stamp });
      }
    } else if (kind.kind === "command_output") {
      out.push({ role: "assistant", content: [{ type: "text", text: `\`\`\`text\n${kind.text}\n\`\`\`` }], ...stamp });
    } else {
      out.push({ role: "user", content: userContent(kind.content), ...stamp });
    }
  }
  return out;
}

export interface SessionMeta {
  sessionId: string;
  cwd: string;
  title: string;
  firstPrompt: string;
  updatedAt: Date | null;
  prompts: number;
}

/** The running totals behind a listing's metadata: small and plain, so a listing can resume it from a file's saved byte offset. */
export interface MetaFold {
  cwd: string;
  sessionId: string;
  customTitle: string;
  aiTitle: string;
  firstPrompt: string;
  prompts: number;
  last: number | undefined;
}

export const newMetaFold = (): MetaFold => ({ cwd: "", sessionId: "", customTitle: "", aiTitle: "", firstPrompt: "", prompts: 0, last: undefined });

/** One entry into the totals: first cwd and session id, newest titles, latest time, prompt count and the first prompt. */
export function foldMetaEntry(fold: MetaFold, entry: Obj): void {
  if (!fold.cwd && typeof entry.cwd === "string") fold.cwd = entry.cwd;
  if (!fold.sessionId && typeof entry.sessionId === "string") fold.sessionId = entry.sessionId;
  if (entry.type === "custom-title" && typeof entry.customTitle === "string" && entry.customTitle.trim()) fold.customTitle = entry.customTitle.trim();
  if (entry.type === "ai-title" && typeof entry.aiTitle === "string" && entry.aiTitle.trim()) fold.aiTitle = entry.aiTitle.trim();
  const at = ms(entry.timestamp);
  if (at !== undefined) fold.last = Math.max(fold.last ?? 0, at);
  const prompt = entry.isSidechain === true ? null : promptText(entry);
  if (prompt !== null) {
    fold.prompts += 1;
    if (!fold.firstPrompt) fold.firstPrompt = prompt.replace(/\s+/g, " ").trim();
  }
}

/** The totals as the listing's metadata; null for a file with no prompt in it. */
export function finishMeta(fold: MetaFold, fallbackId: string): SessionMeta | null {
  if (fold.prompts === 0) return null;
  return {
    sessionId: fold.sessionId || fallbackId,
    cwd: fold.cwd,
    title: fold.customTitle || fold.aiTitle || fold.firstPrompt.slice(0, 80) || "Untitled",
    firstPrompt: fold.firstPrompt,
    updatedAt: fold.last === undefined ? null : new Date(fold.last),
    prompts: fold.prompts,
  };
}

/** Listing metadata: the newest custom title, else Claude's own, else the first prompt. */
export function sessionMeta(entries: Obj[], fallbackId: string): SessionMeta | null {
  const fold = newMetaFold();
  for (const entry of entries) foldMetaEntry(fold, entry);
  return finishMeta(fold, fallbackId);
}

export interface UsageBaseline {
  turns: number;
  steps: number;
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  cost: number;
}

/**
 * Session totals so far. Tokens are summed from the assistant messages' own
 * usage (one message spans several entries, so each id counts once, at its
 * largest output); the CLI's cost-state snapshot is written only now and then,
 * so it supplies the cost alone. Turns and model calls are counted on the branch.
 */
export function usageBaseline(entries: Obj[]): UsageBaseline {
  const base: UsageBaseline = { turns: 0, steps: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: 0 };
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const calls = new Map<string, Obj>();
  for (const entry of entries) {
    if (entry.type === "cost-state") base.cost = n(entry.totalCostUSD);
    if (entry.type !== "assistant" || entry.isSidechain === true || !isObj(entry.message)) continue;
    const { id, usage, model } = entry.message;
    if (typeof id !== "string" || !isObj(usage) || model === "<synthetic>") continue;
    const seen = calls.get(id);
    if (!seen || n(usage.output_tokens) >= n(seen.output_tokens)) calls.set(id, usage);
  }
  for (const usage of calls.values()) {
    base.input += n(usage.input_tokens);
    base.cachedInput += n(usage.cache_read_input_tokens);
    base.cacheWrite += n(usage.cache_creation_input_tokens);
    base.output += n(usage.output_tokens);
  }
  base.steps = calls.size;
  for (const entry of visibleBranch(entries).chain) if (promptText(entry) !== null) base.turns += 1;
  return base;
}

/**
 * Each model call's tokens, for usage across sessions: one per message id
 * (a streamed message is written several times; the fullest copy counts), on
 * any branch, without the synthetic ones. The files price no single call, so
 * the cost is unknown.
 */
export function usageOfEntries(entries: Obj[]): UsageEntry[] {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const calls = new Map<string, UsageEntry>();
  for (const entry of entries) {
    if (entry.type !== "assistant" || !isObj(entry.message)) continue;
    const { id, usage, model } = entry.message;
    if (typeof id !== "string" || !isObj(usage) || model === "<synthetic>") continue;
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
    const call: UsageEntry = {
      at: Number.isFinite(at) ? at : 0,
      model: typeof model === "string" ? model : null,
      input: n(usage.input_tokens),
      cachedInput: n(usage.cache_read_input_tokens),
      cacheWrite: n(usage.cache_creation_input_tokens),
      output: n(usage.output_tokens),
      cost: null,
    };
    const seen = calls.get(id);
    if (!seen || call.output >= seen.output) calls.set(id, call);
  }
  return [...calls.values()];
}

/** The newest TodoWrite list on the branch (Claude Code's own todos). */
export function latestTodos(entries: Obj[]): unknown[] | null {
  let todos: unknown[] | null = null;
  for (const entry of visibleBranch(entries).chain) {
    if (entry.type !== "assistant" || !isObj(entry.message) || !Array.isArray(entry.message.content)) continue;
    for (const block of entry.message.content) {
      if (isObj(block) && block.type === "tool_use" && block.name === "TodoWrite" && isObj(block.input) && Array.isArray(block.input.todos)) todos = block.input.todos;
    }
  }
  return todos;
}

/**
 * A new session file holding the visible branch through the Nth prompt
 * (1-based): every kept entry with the new session id, nothing past the cut.
 * Entries keep their uuids, which are unique per file. A compacted session's
 * copy starts with its boundary and summary, and the first kept entry is
 * re-parented onto them, so the copy is one chain with the same context.
 */
export function forkSessionText(entries: Obj[], throughTurns: number, newId: string): string {
  const { chain, head } = visibleBranch(entries);
  let cut = chain.length;
  let prompts = 0;
  for (let i = 0; i < chain.length; i += 1) {
    if (promptText(chain[i] as Obj) === null) continue;
    prompts += 1;
    if (prompts > throughTurns) {
      cut = i;
      break;
    }
  }
  const kept = chain.slice(0, cut);
  if (!kept.some((e) => promptText(e) !== null)) throw new Error("There is nothing before that turn to fork");
  const lines = [...head, ...kept].map((entry, i) => {
    const relinked = i === head.length && head.length > 0 ? { parentUuid: (head[head.length - 1] as Obj).uuid } : {};
    return JSON.stringify({ ...entry, ...relinked, sessionId: newId });
  });
  return `${lines.join("\n")}\n`;
}
