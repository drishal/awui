// The Agent Client Protocol's `session/update` vocabulary, folded once for every
// ACP agent config.yml defines: the live chat turns folds into HarnessEvents,
// and a loaded session's replay turns them into ChatItems. Nothing here spawns
// a process or reads credentials, so it is tested without one.
//
// ACP is a shared vocabulary, not one app's: an agent may send a variant this
// client does not know, so an unknown kind is a fold ("unknown") the chat notes
// once, never a crash.
import type { ChatItem, SlashCommand, ToolCategory, ToolItem } from "../../shared/protocol.js";
import { boundText, editShape, isObj, stringifyArgs, toolCategory, toolPaths, toolSummary, type Obj } from "./agent-events.js";
import { resultDiff, unifiedDiff } from "./tool-diff.js";

const MAX_PLAN_CHARS = 500;

const finite = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === "string" ? value : "");

function oneLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function textOfBlock(block: unknown): string {
  if (typeof block === "string") return block;
  if (!isObj(block)) return "";
  if (block.type === "text" && typeof block.text === "string") return block.text;
  // ACP wraps a content block in `{type: "content", content: {...}}` inside tool call content.
  if (block.type === "content") return textOfBlock(block.content);
  if (block.type === "resource_link") {
    const name = str(block.name) || str(block.uri);
    return name ? `[${name}](${str(block.uri)})` : "";
  }
  return "";
}

/** Text out of a chunk's `content` (one block, or a list of them). */
export function acpContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map(textOfBlock).filter(Boolean).join("\n");
  return textOfBlock(content);
}

/** ACP's coarse tool kinds, as the category a tool row draws. */
export function categoryOfKind(kind: unknown, name: string): ToolCategory {
  switch (kind) {
    case "read":
      return "read";
    case "edit":
    case "delete":
    case "move":
      return "edit";
    case "search":
      return "search";
    case "execute":
      return "command";
    case "fetch":
      return "web";
    default:
      return toolCategory(name);
  }
}

interface DiffPiece {
  path: string;
  oldText: string;
  newText: string;
}

/** The text and the file diff out of a tool call's `content`. */
function contentPieces(content: unknown): { text: string; diff: DiffPiece | null } {
  const blocks = Array.isArray(content) ? content : content === undefined || content === null ? [] : [content];
  const texts: string[] = [];
  let diff: DiffPiece | null = null;
  for (const block of blocks) {
    if (isObj(block) && block.type === "diff" && typeof block.path === "string") {
      diff = { path: block.path, oldText: str(block.oldText), newText: str(block.newText) };
      continue;
    }
    const text = textOfBlock(block);
    if (text) texts.push(text);
  }
  return { text: texts.join("\n"), diff };
}

/** The paths a tool call named for the user to follow (its `locations`), as given. */
function locationPaths(update: Obj): string[] {
  const out: string[] = [];
  for (const entry of Array.isArray(update.locations) ? update.locations : []) {
    const path = isObj(entry) ? str(entry.path) : "";
    if (path && path.length < 1024 && !out.includes(path)) out.push(path);
  }
  return out;
}

/** ACP's tool call name: its programmatic `name`, else the title it showed the user. */
function toolName(update: Obj): string {
  return str(update.name) || str(update.title) || "tool";
}

export type AcpFold =
  | { type: "user"; text: string; at: number }
  | { type: "delta"; field: "text" | "thinking"; delta: string }
  | { type: "tool_start"; toolCallId: string; name: string; args: unknown; category: ToolCategory; paths: string[]; at: number }
  | { type: "tool_update"; toolCallId: string; output: string }
  | { type: "tool_end"; toolCallId: string; output: string; isError: boolean; details?: unknown; at: number }
  /** `usage_update`: the occupancy and cumulative cost the agent reports, when it reports one. */
  | { type: "context"; used: number; size: number; costUsd: number | null }
  | { type: "config"; options: unknown }
  | { type: "commands"; commands: SlashCommand[] }
  | { type: "title"; title: string }
  | { type: "notice"; text: string; at: number }
  | { type: "unknown"; kind: string }
  | { type: "ignore" };

function planText(update: Obj): string {
  let text = "";
  if (Array.isArray(update.entries)) {
    text = update.entries
      .map((entry) => (isObj(entry) ? String(entry.content ?? entry.text ?? entry.title ?? "") : String(entry)))
      .filter(Boolean)
      .join("; ");
  } else if (typeof update.content === "string") text = update.content;
  return oneLine(text, MAX_PLAN_CHARS) || "Plan updated";
}

/** The cumulative cost an agent reported, in USD, or null when it priced nothing (or in another currency). */
function costUsd(value: unknown): number | null {
  if (!isObj(value)) return null;
  const amount = value.amount;
  const currency = str(value.currency).toUpperCase();
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount <= 0) return null;
  return currency === "USD" || currency === "" ? amount : null;
}

/** The slash commands an `available_commands_update` lists, bounded and named as ACP names them. */
export function commandsFrom(raw: unknown): SlashCommand[] {
  const out: SlashCommand[] = [];
  for (const entry of Array.isArray(raw) ? raw.slice(0, 200) : []) {
    if (!isObj(entry)) continue;
    const name = str(entry.name).replace(/^\//, "").slice(0, 64);
    if (!name) continue;
    const description = oneLine(str(entry.description), 200);
    const hint = isObj(entry.input) ? oneLine(str(entry.input.hint), 100) : "";
    out.push({ name, source: "agent", ...(description ? { description } : {}), ...(hint ? { hint } : {}) });
  }
  return out;
}

/** One `session/update` payload (the object with `sessionUpdate`). */
export function foldAcpUpdate(update: unknown, at: number): AcpFold {
  if (!isObj(update) || typeof update.sessionUpdate !== "string") return { type: "ignore" };
  const kind = update.sessionUpdate;
  if (kind === "user_message_chunk") {
    const text = acpContentText(update.content);
    return text ? { type: "user", text, at } : { type: "ignore" };
  }
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const delta = acpContentText(update.content);
    if (!delta) return { type: "ignore" };
    return { type: "delta", field: kind === "agent_thought_chunk" ? "thinking" : "text", delta };
  }
  if (kind === "tool_call") {
    const toolCallId = str(update.toolCallId) || "tool";
    const name = toolName(update);
    const args = update.rawInput ?? {};
    const paths = locationPaths(update);
    return { type: "tool_start", toolCallId, name, args, category: categoryOfKind(update.kind, name), paths, at };
  }
  if (kind === "tool_call_update") {
    const toolCallId = str(update.toolCallId) || "tool";
    const status = update.status;
    const pieces = contentPieces(update.content);
    const output = pieces.text || str(update.rawOutput);
    if (status === "completed" || status === "failed") {
      const details = pieces.diff ? { diff: unifiedDiff(pieces.diff.path, pieces.diff.oldText, pieces.diff.newText) } : undefined;
      return { type: "tool_end", toolCallId, output, isError: status === "failed", ...(details ? { details } : {}), at };
    }
    // Progress frames add locations and args and often no text; skip the empty ones.
    return output ? { type: "tool_update", toolCallId, output } : { type: "ignore" };
  }
  if (kind === "usage_update") {
    const size = finite(update.size);
    if (size <= 0) return { type: "ignore" };
    return { type: "context", used: finite(update.used), size, costUsd: costUsd(update.cost) };
  }
  if (kind === "config_option_update") return { type: "config", options: update.configOptions };
  if (kind === "available_commands_update") return { type: "commands", commands: commandsFrom(update.availableCommands) };
  if (kind === "session_info_update") {
    const title = str(update.title);
    return title ? { type: "title", title: oneLine(title, 200) } : { type: "ignore" };
  }
  if (kind === "plan") return { type: "notice", text: planText(update), at };
  if (kind === "notice") {
    const title = str(update.title);
    const description = str(update.description);
    const text = [title, description].filter(Boolean).join(": ");
    return text ? { type: "notice", text: oneLine(text, MAX_PLAN_CHARS), at } : { type: "ignore" };
  }
  // current_mode_update, auto_approved, compaction, whatever a newer agent adds:
  // the chat notes the first unknown kind and carries on.
  return { type: "unknown", kind };
}

function toolItem(fold: Extract<AcpFold, { type: "tool_start" }>): ToolItem {
  const edits = fold.category === "edit" || fold.category === "write";
  const paths = fold.paths.length > 0 ? fold.paths : toolPaths(fold.args);
  return {
    kind: "tool",
    id: `t:${fold.toolCallId}`,
    name: fold.name,
    args: stringifyArgs(fold.args),
    status: "running",
    output: "",
    truncated: false,
    category: fold.category,
    summary: toolSummary(fold.args, fold.name),
    paths,
    ...(edits ? editShape(null, null) : {}),
    at: fold.at,
  };
}

/** Chat items for a session's replayed updates. A tool still running at the end of the replay failed with it. */
export function itemsFromAcpFolds(folds: AcpFold[]): ChatItem[] {
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
        index = items.length;
        item = toolItem({ type: "tool_start", toolCallId: fold.toolCallId, name: "tool", args: {}, category: "other", paths: [], at: fold.at });
        items.push(item);
        open.set(fold.toolCallId, index);
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

/** The update object inside a `session/update` frame, or null. */
export function acpUpdateOf(frame: Obj): Obj | null {
  if (frame.method !== "session/update") return null;
  const params = isObj(frame.params) ? frame.params : null;
  if (!params) return null;
  return isObj(params.update) ? params.update : null;
}
