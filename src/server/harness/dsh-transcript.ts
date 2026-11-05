// DeepSeek Harness's own session log (v4 JSONL, one zstd frame per append)
// and its standard ACP session/update frames, folded once. The ACP surface
// deliberately replays no history, so a resumed chat is rebuilt from this
// file; the same parser feeds the sidebar and usage across chats. Nothing
// here spawns a process or touches credentials.
import { zstdDecompressSync } from "node:zlib";
import type { ChatItem, ToolItem, ToolDiff } from "../../shared/protocol.js";
import { boundText, editShape, isObj, stringifyArgs, toolCategory, toolPaths, toolSummary, type Obj } from "./agent-events.js";
import { htmlRenderRef, splitRenderMarker } from "./render-token.js";
import { lineDiff, parseUnified } from "./tool-diff.js";
import type { HarnessUsage, StepUsage, UsageEntry } from "./types.js";

/** A session id as DSH writes one: a bare UUID from the ACP app, `session-<uuid>` from the web app. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;
export function isSessionId(id: string): boolean {
  return SESSION_ID.test(id) && id !== "." && id !== "..";
}

/**
 * The project directory DSH files a workspace's sessions under: readable, one
 * path segment, separators collapsed to `-`, everything else escaped. It is
 * lossy (two paths can share a key), so a reader still checks the header's cwd.
 */
export function projectKey(cwd: string): string {
  let readable = "";
  let separatorRun = false;
  for (let i = 0; i < cwd.length; i += 1) {
    const code = cwd.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch === "/" || ch === "\\" || ch === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch;
      separatorRun = false;
    } else {
      readable += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/, "") || "root").slice(0, 251)}--`;
}

/** DSH's injective encoding of a session id as one path segment. */
export function sessionSegment(id: string): string {
  if (id === ".") return "~002E";
  if (id === "..") return "~002E~002E";
  let out = "";
  for (let i = 0; i < id.length; i += 1) {
    const code = id.charCodeAt(i);
    const ch = String.fromCharCode(code);
    if (ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch)) out += ch;
    else out += `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return out;
}

const ZSTD_MAGIC = 0xfd2fb528;
const ZSTD_MAGIC_BYTES = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export interface ZstdFrame {
  start: number;
  end: number;
}

/**
 * Locate the complete zstd frames in a concatenated container without
 * decompressing their blocks. DSH appends one frame per event batch, so a
 * single log is many frames and Node's one-shot decompressor stops at the
 * first. An incomplete final frame returns its start instead of failing; a
 * corrupt complete frame rejects.
 */
export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): { frames: ZstdFrame[]; tornStart?: number } {
  const frames: ZstdFrame[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`corrupt DeepSeek session log: invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`corrupt DeepSeek session log: reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`corrupt DeepSeek session log: reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

/**
 * Drop a partial leading frame (the tail half of an oversized read): find the
 * first magic that starts a structurally complete run of frames. Compressed
 * bytes can contain the magic by chance, so each candidate is scanned.
 */
export function resyncZstd(buffer: Buffer): Buffer {
  let at = buffer.indexOf(ZSTD_MAGIC_BYTES);
  while (at >= 0) {
    try {
      const { frames } = scanZstdFrames(buffer.subarray(at));
      if (frames.length > 0) return buffer.subarray(at);
    } catch {
      // A false positive or a torn candidate: try the next magic.
    }
    at = buffer.indexOf(ZSTD_MAGIC_BYTES, at + 4);
  }
  return Buffer.alloc(0);
}

/** One frame's plaintext, or "" when the frame is corrupt (its events are lost, not the rest). */
function decodeFrame(buffer: Buffer, frame: ZstdFrame): string {
  try {
    return zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString("utf8");
  } catch {
    return "";
  }
}

/** The transcript budget: past this, the head and tail are kept and the middle dropped. */
export const MAX_SESSION_TEXT_BYTES = 8 * 1024 * 1024;

/**
 * Decode a concatenated-frame log to text, keeping the head and tail when it
 * is larger than `maxBytes`. Each frame is a complete batch of lines, so the
 * cut never splits an event.
 */
export function decodeSessionLog(buffer: Buffer, maxBytes = MAX_SESSION_TEXT_BYTES): string {
  if (buffer.length === 0 || maxBytes <= 0) return "";
  let frames: ZstdFrame[];
  try {
    frames = scanZstdFrames(buffer).frames;
  } catch {
    return "";
  }
  if (frames.length === 0) return "";
  const headBudget = Math.max(1, Math.floor(maxBytes / 2));
  let headEnd = 0;
  let headLength = 0;
  const head: string[] = [];
  while (headEnd < frames.length) {
    const text = decodeFrame(buffer, frames[headEnd] as ZstdFrame);
    if (head.length > 0 && headLength + text.length > headBudget) break;
    head.push(text);
    headLength += text.length;
    headEnd += 1;
  }
  if (headEnd >= frames.length) return head.join("");
  const tailBudget = Math.max(1, maxBytes - headLength);
  const tail: string[] = [];
  let tailStart = frames.length;
  let tailLength = 0;
  while (tailStart > headEnd) {
    const text = decodeFrame(buffer, frames[tailStart - 1] as ZstdFrame);
    if (tail.length > 0 && tailLength + text.length > tailBudget) break;
    tail.unshift(text);
    tailLength += text.length;
    tailStart -= 1;
  }
  let text = head.join("");
  if (tail.length > 0) {
    // Frames are whole line batches; keep the head's complete lines and append the tail's.
    text = text.slice(0, text.lastIndexOf("\n") + 1);
    text += tail.join("");
  }
  return text;
}

/** One durable session event as written: the header has no `data`; everything else does. */
export type DshEvent = Obj & { type: string };

/** Parse a log's lines; an incomplete or corrupt line (a bounded read) is skipped. */
export function eventsFromText(text: string): DshEvent[] {
  const events: DshEvent[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (isObj(row) && typeof row.type === "string") events.push(row as DshEvent);
  }
  return events;
}

export interface DshHeader {
  id: string;
  cwd: string;
  version: number;
  createdAt: number | null;
  origin: string | null;
  isSeeded: boolean;
  parentSession: string | null;
}

/** The `session` header line, or null when this is not one of DSH's logs. */
export function headerFrom(events: DshEvent[]): DshHeader | null {
  for (const event of events) {
    if (event.type !== "session") continue;
    const id = typeof event.id === "string" ? event.id : "";
    const cwd = typeof event.cwd === "string" ? event.cwd : "";
    if (!isSessionId(id) || !cwd) return null;
    return {
      id,
      cwd,
      version: typeof event.version === "number" && Number.isFinite(event.version) ? event.version : 0,
      createdAt: typeof event.createdAt === "number" && Number.isFinite(event.createdAt) ? event.createdAt : null,
      origin: typeof event.origin === "string" ? event.origin : null,
      isSeeded: event.isSeeded === true,
      parentSession: typeof event.parentSession === "string" ? event.parentSession : null,
    };
  }
  return null;
}

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (isObj(block) && block.type === "text" && typeof block.text === "string") parts.push(block.text);
  }
  return parts.join("\n");
}

function imageCountOf(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let count = 0;
  for (const block of content) if (isObj(block) && block.type === "image") count += 1;
  return count;
}

const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const timeOf = (event: DshEvent): number | undefined => (typeof event.time === "number" && Number.isFinite(event.time) ? event.time : undefined);

/** The latest title DSH wrote (generated or its first-prompt fallback), or null. */
export function titleFromEvents(events: DshEvent[]): string | null {
  let title: string | null = null;
  for (const event of events) {
    if (event.type !== "session/title" || !isObj(event.data)) continue;
    const text = typeof event.data.title === "string" ? event.data.title.trim() : "";
    if (text) title = text;
  }
  return title;
}

const oneLine = (text: string, max: number): string => text.replace(/\s+/g, " ").trim().slice(0, max);

/** The first human prompt, for a session that has no title yet. */
export function firstPrompt(events: DshEvent[]): string | null {
  for (const event of events) {
    if (event.type !== "user/message" || !isObj(event.data)) continue;
    const text = textOfContent(event.data.content).trim();
    if (text) return oneLine(text, 80);
  }
  return null;
}

/** How many conversation messages a log holds (prompts and committed answers). */
export function messageCount(events: DshEvent[]): number {
  let count = 0;
  for (const event of events) if (event.type === "user/message" || event.type === "assistant/message") count += 1;
  return count;
}

export interface DshUsage {
  usage: HarnessUsage;
  entries: UsageEntry[];
  /** The last call's prompt + answer tokens, for the context chip before ACP reports one. */
  lastTokens: number | null;
  /** The window the last request named. */
  contextWindow: number | null;
}

/**
 * Token totals from the committed assistant messages. DSH prices nothing on
 * this surface, so every entry's cost stays null rather than a made-up zero.
 */
export function usageFromEvents(events: DshEvent[]): DshUsage {
  let turns = 0;
  let input = 0;
  let cachedInput = 0;
  let cacheWrite = 0;
  let output = 0;
  let steps = 0;
  let lastTokens: number | null = null;
  let contextWindow: number | null = null;
  let lastModel: string | null = null;
  const entries: UsageEntry[] = [];
  for (const event of events) {
    if (event.type === "turn/start") {
      turns += 1;
      continue;
    }
    if (event.type === "request/context" && isObj(event.data)) {
      if (typeof event.data.contextWindow === "number" && Number.isFinite(event.data.contextWindow)) contextWindow = event.data.contextWindow;
      if (typeof event.data.model === "string" && event.data.model) lastModel = event.data.model;
      continue;
    }
    if (event.type !== "assistant/message" || !isObj(event.data) || !isObj(event.data.usage)) continue;
    const usage = event.data.usage;
    const message = isObj(event.data.message) ? event.data.message : {};
    const source = isObj(message.source) ? message.source : {};
    const model = typeof source.model === "string" && source.model ? source.model : lastModel;
    if (model) lastModel = model;
    const step: StepUsage = {
      input: finite(usage.inputTokens),
      output: finite(usage.outputTokens),
      cacheRead: finite(usage.cacheReadTokens),
      cacheWrite: finite(usage.cacheWriteTokens),
    };
    steps += 1;
    input += step.input;
    cachedInput += step.cacheRead;
    cacheWrite += step.cacheWrite;
    output += step.output;
    lastTokens = finite(usage.totalTokens) || step.input + step.cacheRead + step.output;
    entries.push({
      at: timeOf(event) ?? 0,
      model,
      input: step.input,
      cachedInput: step.cacheRead,
      cacheWrite: step.cacheWrite,
      output: step.output,
      cost: null,
    });
  }
  return {
    usage: { turns, steps, input, cachedInput, cacheWrite, output, cost: null },
    entries,
    lastTokens,
    contextWindow,
  };
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/**
 * A DSH tool result's `meta.diffs` (old/new text per file) as the ToolDiff the
 * chat cards draw. The live ACP surface carries only the result's text, so
 * this is what a resumed transcript can show and a running one cannot.
 */
function diffFromMeta(meta: Obj, item: ToolItem): ToolDiff | null {
  const diffs = Array.isArray(meta.diffs) ? meta.diffs : [];
  for (const entry of diffs) {
    if (!isObj(entry) || typeof entry.oldText !== "string" || typeof entry.newText !== "string") continue;
    const file = typeof entry.path === "string" ? entry.path : typeof meta.path === "string" ? meta.path : (item.paths[0] ?? "file");
    const oldLines = splitLines(entry.oldText).slice(0, 2000);
    const newLines = splitLines(entry.newText).slice(0, 2000);
    const body = lineDiff(oldLines, newLines)
      .map((line) => `${line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}${line.text}`)
      .join("\n");
    if (!body) return null;
    const safe = file.replace(/[\r\n]/g, "");
    return parseUnified(`--- a/${safe}\n+++ b/${safe}\n@@ -1 +1 @@\n${body}`);
  }
  return null;
}

function argsOf(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function makeTool(id: string, name: string, rawArgs: unknown, at: number | undefined): ToolItem {
  const args = argsOf(rawArgs);
  const category = toolCategory(name);
  const edits = category === "edit" || category === "write";
  return {
    kind: "tool",
    id: `t:${id}`,
    name,
    args: stringifyArgs(args, edits),
    status: "running",
    output: "",
    truncated: false,
    category,
    summary: toolSummary(args, name),
    paths: toolPaths(args),
    ...(edits ? editShape(null, null) : {}),
    ...(at !== undefined ? { at } : {}),
  };
}

/** A tool result's text, its diff (history only), and a render page's reference. */
function applyResult(item: ToolItem, event: DshEvent): void {
  const data = isObj(event.data) ? event.data : {};
  const message = isObj(data.message) ? data.message : {};
  const meta = isObj(data.meta) ? data.meta : {};
  const marked = splitRenderMarker(textOfContent(message.content));
  const bounded = boundText(marked.text);
  item.output = bounded.text;
  item.truncated = bounded.truncated;
  item.status = message.isError === true ? "error" : "done";
  const at = timeOf(event);
  if (at !== undefined) item.endedAt = at;
  if (item.status === "done") {
    const diff = diffFromMeta(meta, item);
    if (diff) Object.assign(item, editShape(diff, null));
    const render = marked.details ? htmlRenderRef(marked.details) : undefined;
    if (render) item.htmlRender = render;
  }
}

/**
 * Chat items for a stored transcript. A call still running at the end of the
 * log failed with the session, as in Grok's reader.
 */
export function itemsFromEvents(events: DshEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const open = new Map<string, number>();
  const calls = new Map<string, { name: string; args: unknown; at: number | undefined }>();
  let n = 0;
  for (const event of events) {
    if (event.type === "user/message") {
      if (!isObj(event.data)) continue;
      const text = textOfContent(event.data.content);
      const imageCount = imageCountOf(event.data.content);
      if (!text && imageCount === 0) continue;
      const at = timeOf(event);
      items.push({ kind: "user", id: `u${++n}`, text, ...(imageCount > 0 ? { imageCount } : {}), ...(at !== undefined ? { at } : {}) });
      continue;
    }
    if (event.type === "tool/call") {
      if (!isObj(event.data)) continue;
      const callId = typeof event.data.callId === "string" ? event.data.callId : "";
      if (!callId) continue;
      calls.set(callId, { name: typeof event.data.name === "string" ? event.data.name : "tool", args: argsOf(event.data.arguments), at: timeOf(event) });
      continue;
    }
    if (event.type === "assistant/message") {
      if (!isObj(event.data)) continue;
      const message = isObj(event.data.message) ? event.data.message : {};
      const blocks = Array.isArray(message.content) ? message.content : [];
      const thinking: string[] = [];
      const text: string[] = [];
      for (const block of blocks) {
        if (!isObj(block)) continue;
        if (block.type === "reasoning" && typeof block.text === "string") thinking.push(block.text);
        else if (block.type === "text" && typeof block.text === "string") text.push(block.text);
      }
      const at = timeOf(event);
      const source = isObj(message.source) ? message.source : {};
      if (text.length > 0 || thinking.length > 0) {
        items.push({
          kind: "assistant",
          id: `a${++n}`,
          text: text.join("\n"),
          thinking: thinking.join("\n"),
          streaming: false,
          ...(typeof source.model === "string" && source.model ? { model: source.model } : {}),
          ...(at !== undefined ? { at } : {}),
        });
      }
      for (const block of blocks) {
        if (!isObj(block) || block.type !== "tool-call") continue;
        const callId = typeof block.id === "string" && block.id ? block.id : `call-${++n}`;
        const name = typeof block.name === "string" && block.name ? block.name : "tool";
        const rawArgs = argsOf(block.arguments);
        calls.set(callId, { name, args: rawArgs, at });
        open.set(callId, items.length);
        items.push(makeTool(callId, name, rawArgs, at));
      }
      continue;
    }
    if (event.type === "tool/result") {
      if (!isObj(event.data)) continue;
      const message = isObj(event.data.message) ? event.data.message : {};
      const callId = typeof message.toolCallId === "string" ? message.toolCallId : typeof event.data.toolCallId === "string" ? event.data.toolCallId : "";
      if (!callId) continue;
      let index = open.get(callId);
      let item = index !== undefined ? items[index] : undefined;
      if (!item || item.kind !== "tool") {
        const known = calls.get(callId);
        const tool = makeTool(callId, known?.name ?? "tool", known?.args ?? {}, known?.at ?? timeOf(event));
        index = items.length;
        item = tool;
        items.push(tool);
        open.set(callId, index);
      }
      applyResult(item, event);
      open.delete(callId);
    }
  }
  for (const index of open.values()) {
    const item = items[index];
    if (item && item.kind === "tool" && item.status === "running") {
      item.status = "error";
      item.endedAt = item.at;
    }
  }
  return items;
}

// ---- the live ACP surface -----------------------------------------------------

/** One standard `session/update` payload, as the live chat consumes it. */
export type AcpFold =
  | { type: "delta"; field: "text" | "thinking"; delta: string }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown; at: number }
  | { type: "tool_update"; toolCallId: string; output: string }
  | { type: "tool_end"; toolCallId: string; output: string; isError: boolean; at: number }
  | { type: "usage"; used: number; size: number }
  | { type: "config"; options: unknown }
  | { type: "ignore" };

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => textOfBlock(block)).filter(Boolean).join("\n");
  return textOfBlock(content);
}

function textOfBlock(block: unknown): string {
  if (typeof block === "string") return block;
  if (!isObj(block)) return "";
  if (block.type === "text" && typeof block.text === "string") return block.text;
  if (block.type === "content") return contentText(block.content);
  return "";
}

/** A tool result's text from ACP's `content: [{type:"content", content:{…}}]`. */
function toolContentText(content: unknown): string {
  if (!Array.isArray(content)) return contentText(content);
  return content.map((entry) => (isObj(entry) && entry.type === "content" ? contentText(entry.content) : textOfBlock(entry))).filter(Boolean).join("\n");
}

/** The update object inside a `session/update` frame, or null. */
export function updateOf(frame: Obj): Obj | null {
  if (frame.method !== "session/update") return null;
  const params = isObj(frame.params) ? frame.params : null;
  if (!params) return null;
  if (isObj(params.update)) return params.update;
  if (typeof params.sessionUpdate === "string") return params;
  return null;
}

/**
 * One `session/update` payload. DSH emits committed assistant blocks, not
 * provider deltas: a message's reasoning arrives as one thought chunk and its
 * text as one or more message chunks, each already whole.
 */
export function foldAcpUpdate(update: unknown, at: number): AcpFold {
  if (!isObj(update) || typeof update.sessionUpdate !== "string") return { type: "ignore" };
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const delta = contentText(update.content);
    if (!delta) return { type: "ignore" };
    return { type: "delta", field: kind === "agent_thought_chunk" ? "thinking" : "text", delta };
  }
  if (kind === "tool_call") {
    const toolCallId = typeof update.toolCallId === "string" && update.toolCallId ? update.toolCallId : "tool";
    const name = typeof update.title === "string" && update.title ? update.title : "tool";
    return { type: "tool_start", toolCallId, name, args: update.rawInput ?? {}, at };
  }
  if (kind === "tool_call_update") {
    const toolCallId = typeof update.toolCallId === "string" && update.toolCallId ? update.toolCallId : "tool";
    const output = toolContentText(update.content) || (typeof update.rawOutput === "string" ? update.rawOutput : "");
    const status = update.status;
    if (status === "completed" || status === "failed") return { type: "tool_end", toolCallId, output, isError: status === "failed", at };
    return output ? { type: "tool_update", toolCallId, output } : { type: "ignore" };
  }
  if (kind === "usage_update") {
    const used = finite(update.used);
    const size = finite(update.size);
    return size > 0 ? { type: "usage", used, size } : { type: "ignore" };
  }
  if (kind === "config_option_update") return { type: "config", options: update.configOptions };
  // Commands, modes, plans, and terminals are outside DSH's automation surface.
  return { type: "ignore" };
}
