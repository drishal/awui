// Pi-family session files (Pi and omp): JSONL with an optional title slot, a
// session header, then entries that form a tree through parentId. Forking a
// chat keeps the active branch's ancestor chain through the Nth user turn; a
// plain line prefix would drag along abandoned branches.
import { randomBytes } from "node:crypto";
import { isObj, type Obj } from "./agent-events.js";
import { toolRecordText, type SeedEntry } from "./handoff.js";
import { parseJsonlLine, scanJsonlLines } from "./jsonl.js";

/** Time-ordered session id, the shape both harnesses mint for new sessions. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16);
  for (let i = 0; i < 6; i += 1) bytes[i] = Number((BigInt(now) >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** File name prefix omp/Pi use for a session started now: ISO with : and . as -. */
export function sessionFileTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** The file's active branch, root first. Session files are append-only, so the last entry is the leaf. */
function activeBranch(entries: Obj[]): Obj[] {
  const byId = new Map<string, Obj>();
  for (const entry of entries) if (typeof entry.id === "string") byId.set(entry.id, entry);
  const chain: Obj[] = [];
  const seen = new Set<string>();
  let current: Obj | undefined = entries[entries.length - 1];
  while (current && typeof current.id === "string" && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  return chain.reverse();
}

export interface ForkOptions {
  /** Keep everything up to and including turn N (1-based). */
  throughTurns: number;
  /** Id for the copy; also used by the caller for the file name. */
  id: string;
  now: Date;
  cwd: string;
  /** The source session's id, recorded so the copy knows where it came from. */
  parentSession: string;
}

/**
 * The body of a forked session file: the title slot and header rewritten for the
 * copy, then the kept entries unchanged. Entries whose referenced entry was cut
 * with the rest of the branch (a compaction's firstKeptEntryId, say) are dropped.
 */
export function forkSessionText(text: string, options: ForkOptions): string {
  let slot: string | null = null;
  let header: Obj | null = null;
  const entries: Obj[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // A half-written trailing line: the source was being appended to.
    }
    if (!isObj(parsed)) continue;
    if (header === null && parsed.type === "title" && slot === null) {
      slot = line;
      continue;
    }
    if (header === null && parsed.type === "session") {
      header = parsed;
      continue;
    }
    entries.push(parsed);
  }
  const branch = activeBranch(entries);
  let cut = branch.length;
  let turn = 0;
  for (let i = 0; i < branch.length; i += 1) {
    const entry = branch[i];
    if (!entry || entry.type !== "message") continue;
    const message = entry.message;
    if (!isObj(message) || message.role !== "user") continue;
    turn += 1;
    if (turn > options.throughTurns) {
      cut = i;
      break;
    }
  }
  const keptIds = new Set(branch.slice(0, cut).map((entry) => String(entry.id ?? "")));
  const kept = branch.slice(0, cut).filter((entry) => {
    const refs = [entry.firstKeptEntryId, entry.fromId, entry.targetId, entry.parentId];
    return refs.every((ref) => typeof ref !== "string" || keptIds.has(ref));
  });
  const out = {
    type: "session",
    version: typeof header?.version === "number" ? header.version : 3,
    id: options.id,
    timestamp: options.now.toISOString(),
    cwd: options.cwd,
    ...(typeof header?.title === "string" ? { title: header.title, titleSource: header.titleSource ?? "auto" } : {}),
    parentSession: options.parentSession,
    // Prompt-cache affinity survives only because a fork keeps model, system prompt, and tools.
    ...(typeof header?.providerPromptCacheKey === "string" ? { providerPromptCacheKey: header.providerPromptCacheKey } : {}),
  };
  const lines = [slot, JSON.stringify(out), ...kept.map((entry) => JSON.stringify(entry))];
  return `${lines.filter((line): line is string => typeof line === "string").join("\n")}\n`;
}

/** Usage of a message no model produced: zero, in the shape session totals add up. */
const NO_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

/**
 * A new session file holding a handoff transcript: a v3 header, then one
 * message entry per line chained through parentId (both harnesses rebuild
 * context by walking from the leaf). Assistant entries carry zero usage and a
 * "handoff" model so session totals and provider replay treat them as foreign.
 * Tool records become assistant text; a foreign tool call cannot be replayed.
 */
export function seedSessionText(options: { id: string; cwd: string; now: Date; entries: SeedEntry[] }): string {
  const lines = [JSON.stringify({ type: "session", version: 3, id: options.id, timestamp: options.now.toISOString(), cwd: options.cwd })];
  let parentId: string | null = null;
  let at = options.now.getTime();
  for (const entry of options.entries) {
    let message: Obj;
    if (entry.role === "user") {
      message = { role: "user", content: [{ type: "text", text: entry.text }] };
    } else {
      const content: Obj[] = [];
      if (entry.role === "tool") content.push({ type: "text", text: toolRecordText(entry) });
      else {
        if (entry.thinking) content.push({ type: "thinking", thinking: entry.thinking });
        if (entry.text) content.push({ type: "text", text: entry.text });
      }
      message = { role: "assistant", content, api: "handoff", provider: "handoff", model: "handoff", usage: NO_USAGE, stopReason: "stop" };
    }
    const id = randomBytes(4).toString("hex");
    lines.push(JSON.stringify({ type: "message", id, parentId, timestamp: new Date(at).toISOString(), message: { ...message, timestamp: at } }));
    parentId = id;
    at += 1;
  }
  return `${lines.join("\n")}\n`;
}

/** Every message entry in a Pi-family session's file, on any branch, with the entry's time: for usage across sessions. */
export function fileMessages(text: string): Array<{ message: unknown; at: number }> {
  const out: Array<{ message: unknown; at: number }> = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"message"')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // a torn last line while the harness appends
    }
    if (!isObj(parsed) || parsed.type !== "message") continue;
    const at = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
    out.push({ message: parsed.message, at: Number.isFinite(at) ? at : 0 });
  }
  return out;
}

/**
 * `fileMessages` straight from the file, a line at a time (a 60 MB session is never held as one string),
 * plus its first line parsed: omp's header, with the session's cwd and title.
 */
export async function readFileMessages(file: string, usageOnly = false): Promise<{ head: Obj | null; messages: Array<{ message: unknown; at: number }> }> {
  const messages: Array<{ message: unknown; at: number }> = [];
  let head: Obj | null = null;
  let seen = false;
  const take = (line: string) => {
    if (!seen) {
      seen = true;
      head = parseJsonlLine(line);
    }
    if (!line.includes('"message"')) return;
    // A usage read needs only an assistant message's usage block: the user and tool-result lines (the bulk
    // of a long session) are never parsed, and what is kept is the few fields the report reads.
    if (usageOnly && !line.includes('"usage"')) return;
    const parsed = parseJsonlLine(line);
    if (!parsed || parsed.type !== "message") return;
    const at = typeof parsed.timestamp === "string" ? Date.parse(parsed.timestamp) : NaN;
    let message = parsed.message;
    if (usageOnly && isObj(message)) message = { role: message.role, usage: message.usage, model: message.model, timestamp: message.timestamp };
    messages.push({ message, at: Number.isFinite(at) ? at : 0 });
  };
  const { tail } = await scanJsonlLines(file, take);
  if (tail.trim()) take(tail);
  return { head, messages };
}

/**
 * The messages a Pi-family session's file holds on its active branch, as the
 * harness's get_messages would list them, read without starting it: after
 * the latest compaction, its summary, then the entries it kept (from
 * firstKeptEntryId) and everything after it. Branch summaries and displayed
 * custom messages come through in the roles historyToItems reads.
 */
export function branchMessages(text: string): unknown[] {
  const parsed: Obj[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (isObj(entry)) parsed.push(entry);
    } catch {
      // a torn last line while the harness appends
    }
  }
  return branchMessagesOfEntries(parsed);
}

/** `branchMessages` over entries already parsed (a streamed read): leading title lines and the one header are not entries. */
export function branchMessagesOfEntries(parsed: Obj[]): unknown[] {
  const entries: Obj[] = [];
  let sawHeader = false;
  for (const entry of parsed) {
    if (!sawHeader && (entry.type === "title" || entry.type === "session")) {
      if (entry.type === "session") sawHeader = true;
      continue;
    }
    entries.push(entry);
  }
  const branch = activeBranch(entries);
  let compaction = -1;
  for (let i = branch.length - 1; i >= 0; i -= 1) {
    if (branch[i]?.type === "compaction") {
      compaction = i;
      break;
    }
  }
  let range = branch;
  const out: unknown[] = [];
  if (compaction >= 0) {
    const entry = branch[compaction] as Obj;
    const kept = branch.findIndex((e) => e.id === entry.firstKeptEntryId);
    out.push({ role: "compactionSummary", summary: entry.summary, ...(typeof entry.timestamp === "string" ? { timestamp: Date.parse(entry.timestamp) } : {}) });
    range = [...(kept >= 0 && kept < compaction ? branch.slice(kept, compaction) : []), ...branch.slice(compaction + 1)];
  }
  for (const entry of range) {
    if (entry.type === "message" && isObj(entry.message)) out.push(entry.message);
    else if (entry.type === "branch_summary") out.push({ role: "branchSummary", summary: entry.summary });
    else if (entry.type === "custom_message") {
      out.push({ role: "custom", customType: entry.customType, content: entry.content, display: entry.display === true, ...(entry.details !== undefined ? { details: entry.details } : {}) });
    }
  }
  return out;
}
