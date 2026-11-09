// Codex's own session files: one rollout JSONL per thread under
// $CODEX_HOME/sessions/YYYY/MM/DD/rollout-<timestamp>-<id>.jsonl. The app-server
// reports a live thread over JSON-RPC, but the file is what lets a resumed chat
// draw before its child has finished starting, and what Usage across chats sums
// up. Nothing here writes a session, and nothing here trusts the file's shape:
// Codex adds line types between versions, and unknown ones are skipped.
import { promises as fs } from "node:fs";
import path from "node:path";
import { boundText, editShape, isObj, toolCategory, toolPaths, toolSummary, type Obj } from "./agent-events.js";
import { htmlRenderRef, isHtmlRenderCall, splitRenderMarker } from "./render-token.js";
import { argsDiff, resultDiff } from "./tool-diff.js";
import type { ChatItem, ToolItem } from "../../shared/protocol.js";
import type { UsageEntry } from "./types.js";

/** Session files are read whole below this bound, as their first and last halves above it. */
export const MAX_ROLLOUT_BYTES = 8 * 1024 * 1024;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** Lines as objects; a torn append at the tail (a file being written) is just skipped. */
export function parseRollout(text: string): Obj[] {
  const lines: Obj[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isObj(parsed)) lines.push(parsed);
    } catch {
      // A half-written last line.
    }
  }
  return lines;
}

export interface RolloutMeta {
  id: string;
  cwd: string | null;
  at: Date | null;
  cliVersion: string | null;
}

/** The file's `session_meta` header: the id and the folder the thread belongs to. */
export function rolloutMeta(lines: Obj[]): RolloutMeta | null {
  for (const line of lines) {
    if (line.type !== "session_meta" || !isObj(line.payload)) continue;
    const p = line.payload;
    const id = str(p.id) || str(p.session_id);
    if (!id) continue;
    const at = typeof p.timestamp === "string" ? new Date(p.timestamp) : typeof line.timestamp === "string" ? new Date(line.timestamp) : null;
    return {
      id,
      cwd: path.isAbsolute(str(p.cwd)) ? str(p.cwd) : null,
      at: at && Number.isFinite(at.getTime()) ? at : null,
      cliVersion: str(p.cli_version) || null,
    };
  }
  return null;
}

/** The text a function or custom tool answered with: a string, or input_text blocks. */
function outputText(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output.map((part) => (isObj(part) ? str(part.text) : typeof part === "string" ? part : "")).filter(Boolean).join("\n");
  if (isObj(output) && typeof output.text === "string") return output.text;
  return "";
}

/** A response_item message's content as text (input_text and output_text blocks). */
function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => (isObj(block) && typeof block.text === "string" ? block.text : "")).filter(Boolean).join("\n");
}

function reasoningText(payload: Obj): string {
  const parts: string[] = [];
  for (const key of ["summary", "content"]) {
    const value = payload[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      if (typeof entry === "string") parts.push(entry);
      else if (isObj(entry) && typeof entry.text === "string") parts.push(entry.text);
    }
  }
  return parts.filter(Boolean).join("\n\n");
}

/** The shell line Codex actually ran: `/bin/bash -lc 'git status'` → `git status`. */
function shellCommand(command: string): string {
  const wrapped = /^\S*bash\S*\s+-l?c\s+([\s\S]+)$/.exec(command.trim());
  if (!wrapped?.[1]) return command.trim();
  const body = wrapped[1].trim();
  if ((body.startsWith("'") && body.endsWith("'")) || (body.startsWith('"') && body.endsWith('"'))) return body.slice(1, -1);
  return body;
}

function statusOf(raw: unknown): ToolItem["status"] {
  switch (raw) {
    case "inProgress":
      return "running";
    case "completed":
      return "done";
    default:
      return "error";
  }
}

/** A response item's own fields, as the app-server would have named them. */
function normalizedFromResponseItem(payload: Obj): Obj | null {
  switch (payload.type) {
    case "message": {
      const role = str(payload.role);
      if (role === "assistant") return { type: "agentMessage", id: str(payload.id), text: messageText(payload.content), phase: str(payload.phase) || null };
      return null;
    }
    case "reasoning":
      return { type: "reasoning", id: str(payload.id), summary: Array.isArray(payload.summary) ? payload.summary : [], content: Array.isArray(payload.content) ? payload.content : [] };
    case "function_call": {
      const name = str(payload.name) || "tool";
      const id = str(payload.call_id) || str(payload.id);
      let args: unknown = payload.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args) as unknown;
        } catch {
          args = { input: args };
        }
      }
      return { type: "toolCall", id, name, arguments: args ?? {}, output: null };
    }
    case "custom_tool_call":
      return { type: "toolCall", id: str(payload.call_id) || str(payload.id), name: str(payload.name) || "tool", arguments: { input: str(payload.input) }, output: null };
    case "web_search_call": {
      const action = isObj(payload.action) ? payload.action : {};
      return { type: "webSearch", id: str(payload.id), action, status: str(payload.status) || "completed" };
    }
    default:
      return null;
  }
}

/**
 * A rollout folded into the item shapes the app-server reports, so one mapper
 * draws a resumed chat and a live one. User prompts come from `user_message`
 * events (`response_item` user messages also carry injected context), answers
 * and calls from `response_item`, and a call's result is joined by call_id.
 */
export function rolloutItems(lines: Obj[]): Obj[] {
  const items: Obj[] = [];
  const byCall = new Map<string, Obj>();
  const sawPrompt = lines.some((line) => line.type === "event_msg" && isObj(line.payload) && line.payload.type === "user_message");
  for (const line of lines) {
    const payload = isObj(line.payload) ? line.payload : null;
    if (!payload) continue;
    if (line.type === "event_msg") {
      switch (payload.type) {
        case "user_message": {
          const images = Array.isArray(payload.images) ? payload.images.length : 0;
          const local = Array.isArray(payload.local_images) ? payload.local_images.length : 0;
          items.push({ type: "userMessage", id: `${items.length}`, content: [{ type: "text", text: str(payload.message) }], ...(images + local > 0 ? { imageCount: images + local } : {}) });
          break;
        }
        case "context_compacted":
          items.push({ type: "contextCompaction", id: `c${items.length}` });
          break;
        case "turn_aborted": {
          const reason = str(payload.reason);
          items.push({ type: "notice", level: "warning", text: reason ? `Run stopped (${reason})` : "Run stopped" });
          break;
        }
        case "mcp_tool_call_end": {
          const invocation = isObj(payload.invocation) ? payload.invocation : {};
          const id = str(payload.call_id);
          const result = isObj(payload.result) ? payload.result : {};
          const ok = isObj(result.Ok) ? result.Ok : null;
          const item: Obj = {
            type: "toolCall",
            id,
            name: `${str(invocation.server) || "mcp"}.${str(invocation.tool) || "tool"}`,
            arguments: invocation.arguments ?? {},
            output: ok ? outputText(ok.content) : JSON.stringify(result.Err ?? {}).slice(0, 400),
            ...(ok?.isError === true || !ok ? { isError: true } : {}),
          };
          byCall.set(id, item);
          items.push(item);
          break;
        }
        default:
          break;
      }
      continue;
    }
    if (line.type === "response_item") {
      // A prompt is the event above; a user message here carries injected context too.
      if (payload.type === "message" && str(payload.role) === "user") {
        if (!sawPrompt) {
          const text = messageText(payload.content);
          if (text && !/^<(environment_context|user_instructions|permissions instructions)/.test(text.trim())) items.push({ type: "userMessage", id: `${items.length}`, content: [{ type: "text", text }] });
        }
        continue;
      }
      if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
        const item = byCall.get(str(payload.call_id));
        if (item) item.output = outputText(payload.output);
        continue;
      }
      const item = normalizedFromResponseItem(payload);
      if (!item) continue;
      if (typeof item.id === "string" && item.id) byCall.set(item.id, item);
      items.push(item);
    }
  }
  return items;
}

/** Tool paths a command's own actions name (a read's file, a search's folder). */
function actionPaths(item: Obj): string[] {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : [];
  const out: string[] = [];
  for (const action of actions) {
    if (!isObj(action)) continue;
    const p = str(action.path) || str(action.name);
    if (p && p.length < 1024) out.push(p);
  }
  return out;
}

function mcpOutput(item: Obj): string {
  const result = isObj(item.result) ? item.result : null;
  if (result) return outputText(result.content);
  const error = isObj(item.error) ? item.error : null;
  return error ? str(error.message) : "";
}

/**
 * The app-server's thread items (and the rollout's normalized ones) as chat
 * items. Bounded like every other harness's history: one row per call, its
 * output cut head and tail, and an edit's diff worked out from what it carried.
 */
export function itemsToChatItems(items: Obj[]): ChatItem[] {
  const out: ChatItem[] = [];
  let n = 0;
  for (const item of items) {
    const at = typeof item.startedAtMs === "number" ? item.startedAtMs : undefined;
    const stamp = at !== undefined ? { at } : {};
    switch (item.type) {
      case "userMessage": {
        const content = Array.isArray(item.content) ? item.content : [];
        const text = content.map((c) => (isObj(c) && (c.type === "text" || c.type === "input_text") ? str(c.text) : "")).filter(Boolean).join("\n");
        const images = typeof item.imageCount === "number" ? item.imageCount : content.filter((c) => isObj(c) && (c.type === "image" || c.type === "localImage")).length;
        if (!text && images === 0) break;
        out.push({ kind: "user", id: `hu${n++}`, text, ...(images > 0 ? { imageCount: images } : {}), ...stamp });
        break;
      }
      case "agentMessage": {
        const text = str(item.text);
        if (!text) break;
        out.push({ kind: "assistant", id: `ha${n++}`, text, thinking: "", streaming: false, ...stamp });
        break;
      }
      case "reasoning": {
        const thinking = reasoningText(item);
        if (!thinking) break;
        out.push({ kind: "assistant", id: `ha${n++}`, text: "", thinking, streaming: false, ...stamp });
        break;
      }
      case "commandExecution": {
        const command = shellCommand(str(item.command)) || str(item.command);
        const tool: ToolItem = {
          kind: "tool",
          id: `t:${str(item.id) || `c${n++}`}`,
          name: "shell",
          args: JSON.stringify({ command, cwd: str(item.cwd) }),
          status: statusOf(item.status),
          output: boundText(str(item.aggregatedOutput)).text,
          truncated: boundText(str(item.aggregatedOutput)).truncated,
          category: "command",
          summary: command,
          paths: actionPaths(item),
          ...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
          ...stamp,
          ...(typeof item.completedAtMs === "number" ? { endedAt: item.completedAtMs } : {}),
        };
        out.push(tool);
        break;
      }
      case "fileChange": {
        const changes = Array.isArray(item.changes) ? item.changes : [];
        const paths = changes.filter(isObj).map((c) => str(c.path)).filter(Boolean);
        const diff = resultDiff({ changes }, "");
        const status = str(item.status);
        out.push({
          kind: "tool",
          id: `t:${str(item.id) || `f${n++}`}`,
          name: "apply_patch",
          args: JSON.stringify({ files: paths }),
          status: status === "completed" ? "done" : status === "inProgress" ? "running" : "error",
          output: status === "completed" ? `Applied to ${paths.length} file${paths.length === 1 ? "" : "s"}` : status,
          truncated: false,
          category: "edit",
          summary: paths.join(", "),
          paths,
          ...(diff ? editShape(diff, null) : {}),
          ...stamp,
          ...(typeof item.completedAtMs === "number" ? { endedAt: item.completedAtMs } : {}),
        });
        break;
      }
      case "mcpToolCall": {
        const name = `${str(item.server) || "mcp"}.${str(item.tool) || "tool"}`;
        const args = item.arguments ?? {};
        const failure = isObj(item.error);
        const marked = splitRenderMarker(mcpOutput(item));
        const category = toolCategory(str(item.tool) || name);
        const page = isHtmlRenderCall(name, args) ? htmlRenderRef(marked.details) : undefined;
        out.push({
          kind: "tool",
          id: `t:${str(item.id) || `m${n++}`}`,
          name,
          args: JSON.stringify(args),
          status: failure || str(item.status) === "failed" ? "error" : statusOf(item.status),
          output: boundText(marked.text).text,
          truncated: boundText(marked.text).truncated,
          category,
          summary: toolSummary(args, str(item.tool) || name),
          paths: toolPaths(args),
          ...(page ? { htmlRender: page } : {}),
          ...stamp,
          ...(typeof item.completedAtMs === "number" ? { endedAt: item.completedAtMs } : {}),
        });
        break;
      }
      case "dynamicToolCall": {
        const args = item.arguments ?? {};
        const content = Array.isArray(item.contentItems) ? item.contentItems : [];
        const output = content.map((c) => (isObj(c) ? str(c.text) : "")).filter(Boolean).join("\n");
        out.push({
          kind: "tool",
          id: `t:${str(item.id) || `d${n++}`}`,
          name: str(item.tool) || "tool",
          args: JSON.stringify(args),
          status: item.success === false ? "error" : statusOf(item.status),
          output: boundText(output).text,
          truncated: boundText(output).truncated,
          category: toolCategory(str(item.tool)),
          summary: toolSummary(args, str(item.tool)),
          paths: toolPaths(args),
          ...stamp,
        });
        break;
      }
      case "webSearch": {
        const action = isObj(item.action) ? item.action : {};
        const query = str(action.query) || str(action.url);
        out.push({
          kind: "tool",
          id: `t:${str(item.id) || `w${n++}`}`,
          name: "web_search",
          args: JSON.stringify({ query }),
          status: statusOf(item.status),
          output: str(item.status),
          truncated: false,
          category: "web",
          summary: query,
          paths: [],
          ...stamp,
        });
        break;
      }
      case "imageView":
        out.push({
          kind: "tool",
          id: `t:${str(item.id) || `i${n++}`}`,
          name: "view_image",
          args: JSON.stringify({ path: str(item.path) }),
          status: "done",
          output: "",
          truncated: false,
          category: "read",
          summary: str(item.path),
          paths: [str(item.path)].filter(Boolean),
          ...stamp,
        });
        break;
      case "plan":
        out.push({
          kind: "tool",
          id: `t:${str(item.id) || `p${n++}`}`,
          name: "update_plan",
          args: "{}",
          status: "done",
          output: boundText(str(item.text)).text,
          truncated: boundText(str(item.text)).truncated,
          category: "other",
          summary: "Plan",
          paths: [],
          ...stamp,
        });
        break;
      case "contextCompaction":
        out.push({ kind: "notice", id: `hn${n++}`, level: "info", text: "Earlier conversation was compacted", ...stamp });
        break;
      case "notice":
        out.push({ kind: "notice", id: `hn${n++}`, level: item.level === "error" ? "error" : "warning", text: str(item.text) });
        break;
      case "toolCall": {
        // Rollout-only: a function or custom tool the app-server names differently
        // (exec_command, apply_patch, update_plan, browser `run`).
        const name = str(item.name) || "tool";
        const args = item.arguments ?? {};
        const category = toolCategory(name);
        const output = boundText(str(item.output)).text;
        const edits = category === "edit" || category === "write";
        const reported = isObj(item.arguments) ? argsDiff(item.arguments) : null;
        out.push({
          kind: "tool",
          id: `t:${str(item.id) || `x${n++}`}`,
          name,
          args: JSON.stringify(args),
          status: item.output === null || item.output === undefined ? "running" : item.isError === true ? "error" : "done",
          output,
          truncated: boundText(str(item.output)).truncated,
          category,
          summary: toolSummary(args, name),
          paths: toolPaths(args),
          ...(edits ? editShape(reported, output || null) : {}),
          ...stamp,
        });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

interface Tokens {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

function readTokens(value: unknown): Tokens | null {
  if (!isObj(value)) return null;
  const input = value.input_tokens;
  const output = value.output_tokens;
  if (typeof input !== "number" || typeof output !== "number") return null;
  return {
    input: Math.max(0, input - num(value.cached_input_tokens) - num(value.cache_write_input_tokens)),
    cached: num(value.cached_input_tokens),
    cacheWrite: num(value.cache_write_input_tokens),
    output,
  };
}

/**
 * Every model call the file recorded, one entry each. Newer rollouts write a
 * `token_usage_record` per request; older ones only a `token_count` snapshot,
 * whose `last_token_usage` is that request's own count.
 */
export function rolloutUsage(lines: Obj[]): UsageEntry[] {
  let model: string | null = null;
  for (const line of lines) {
    if (line.type === "turn_context" && isObj(line.payload) && str(line.payload.model)) model = str(line.payload.model);
  }
  const records: UsageEntry[] = [];
  let usedRecords = false;
  for (const line of lines) {
    if (line.type !== "token_usage_record") continue;
    const payload = isObj(line.payload) ? line.payload : null;
    const tokens = payload ? readTokens(payload.usage) : null;
    if (!tokens || tokens.input + tokens.cached + tokens.cacheWrite + tokens.output === 0) continue;
    usedRecords = true;
    const at = typeof line.timestamp === "string" ? new Date(line.timestamp).getTime() : Date.now();
    records.push({ at: Number.isFinite(at) ? at : Date.now(), model, input: tokens.input, cachedInput: tokens.cached, cacheWrite: tokens.cacheWrite, output: tokens.output, cost: null });
  }
  if (usedRecords) return records;
  for (const line of lines) {
    const payload = isObj(line.payload) ? line.payload : null;
    if (!payload || payload.type !== "token_count" || !isObj(payload.info)) continue;
    const tokens = readTokens(payload.info.last_token_usage);
    if (!tokens || tokens.input + tokens.cached + tokens.cacheWrite + tokens.output === 0) continue;
    const at = typeof line.timestamp === "string" ? new Date(line.timestamp).getTime() : Date.now();
    records.push({ at: Number.isFinite(at) ? at : Date.now(), model, input: tokens.input, cachedInput: tokens.cached, cacheWrite: tokens.cacheWrite, output: tokens.output, cost: null });
  }
  return records;
}

/** The rollout file a thread's id names, newest folders first. */
export async function findRolloutFile(sessionsDir: string, nativeId: string): Promise<string | null> {
  if (!/^[0-9a-f-]{8,64}$/i.test(nativeId)) return null;
  const years = await fs.readdir(sessionsDir).catch(() => [] as string[]);
  for (const year of years.filter((name) => /^\d{4}$/.test(name)).sort().reverse()) {
    const months = await fs.readdir(path.join(sessionsDir, year)).catch(() => [] as string[]);
    for (const month of months.filter((name) => /^\d{2}$/.test(name)).sort().reverse()) {
      const days = await fs.readdir(path.join(sessionsDir, year, month)).catch(() => [] as string[]);
      for (const day of days.filter((name) => /^\d{2}$/.test(name)).sort().reverse()) {
        const dir = path.join(sessionsDir, year, month, day);
        const names = await fs.readdir(dir).catch(() => [] as string[]);
        const match = names.find((name) => name.endsWith(".jsonl") && name.includes(nativeId));
        if (match) return path.join(dir, match);
      }
    }
  }
  return null;
}

/** A rollout's text, whole below the bound and as its ends above it. */
export async function readRolloutText(file: string): Promise<string | null> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return null;
  if (stat.size <= MAX_ROLLOUT_BYTES) return fs.readFile(file, "utf8").catch(() => null);
  const half = MAX_ROLLOUT_BYTES / 2;
  const handle = await fs.open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const head = Buffer.alloc(half);
    const tail = Buffer.alloc(half);
    const headRead = await handle.read(head, 0, half, 0);
    const tailRead = await handle.read(tail, 0, half, stat.size - half);
    const headText = head.subarray(0, headRead.bytesRead).toString("utf8");
    const tailText = tail.subarray(0, tailRead.bytesRead).toString("utf8");
    // Start at the first whole line, end at the last.
    return `${headText.slice(headText.indexOf("\n") + 1)}\n${tailText.slice(tailText.indexOf("\n") + 1)}`;
  } finally {
    await handle.close().catch(() => undefined);
  }
}
