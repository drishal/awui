// The branches of a Pi-family session file (Pi and omp): entries form a tree through parentId, and an
// edit or a retry appends the new path under an older entry, leaving the old one behind. This reads that
// tree without starting the harness: which paths there are (one per leaf), which one the chat is on (the
// file's last entry is its leaf), how far each shares the active path's prompts, and the entry chain to a
// leaf, for a fork of it. Pure over parsed entries; the adapters read the file and write the copy.
import { isObj, type Obj } from "./agent-events.js";
import type { BranchInfo } from "../../shared/protocol.js";

/** At most this many branches are listed (newest first after the active one). */
export const MAX_BRANCHES = 24;
const PROMPT_CHARS = 120;

const entryId = (entry: Obj): string | null => (typeof entry.id === "string" ? entry.id : null);

/** The entries that make the tree: not the title slot or the session header. */
export function treeEntries(entries: Obj[]): Obj[] {
  return entries.filter((entry) => entry.type !== "title" && entry.type !== "session" && entryId(entry) !== null);
}

/** A user prompt's words as one bounded line; null when the entry is not a user message. */
function promptOf(entry: Obj): string | null {
  if (entry.type !== "message" || !isObj(entry.message) || entry.message.role !== "user") return null;
  const content = entry.message.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (isObj(part) && typeof part.text === "string" ? part.text : "")).join(" ") : "";
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > PROMPT_CHARS ? `${line.slice(0, PROMPT_CHARS - 1).trimEnd()}…` : line;
}

/** The words of an assistant message as one bounded line, or null when it says none (a bare tool call). */
function replyOf(entry: Obj | undefined): string | null {
  if (!entry || entry.type !== "message" || !isObj(entry.message) || entry.message.role !== "assistant") return null;
  const content = entry.message.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => (isObj(part) && part.type === "text" && typeof part.text === "string" ? part.text : "")).join(" ") : "";
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return null;
  return line.length > PROMPT_CHARS ? `${line.slice(0, PROMPT_CHARS - 1).trimEnd()}…` : line;
}

/** The entries from the first one down to `leafId`, root first; empty when the id is not in the tree. */
export function chainTo(entries: Obj[], leafId: string): Obj[] {
  const byId = new Map<string, Obj>();
  for (const entry of entries) {
    const id = entryId(entry);
    if (id) byId.set(id, entry);
  }
  const chain: Obj[] = [];
  const seen = new Set<string>();
  let current = byId.get(leafId);
  while (current && !seen.has(entryId(current) ?? "")) {
    seen.add(entryId(current) ?? "");
    chain.push(current);
    const parent = current.parentId;
    current = typeof parent === "string" ? byId.get(parent) : undefined;
  }
  return chain.reverse();
}

/** The branches of the tree, the active one first, then the rest newest first (by file order); each leaf is one branch, and a path with no prompt is not listed. */
export function sessionBranches(all: Obj[]): BranchInfo[] {
  const entries = treeEntries(all);
  if (entries.length === 0) return [];
  const parents = new Set<string>();
  for (const entry of entries) if (typeof entry.parentId === "string") parents.add(entry.parentId);
  const activeLeaf = entryId(entries[entries.length - 1] as Obj) ?? "";
  const activePrompts = chainTo(entries, activeLeaf).filter((e) => promptOf(e) !== null).map((e) => entryId(e));
  const out: BranchInfo[] = [];
  // Newest leaves first: the file is append-only, so a later line is a later branch.
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const leaf = entries[i] as Obj;
    const id = entryId(leaf) as string;
    if (parents.has(id)) continue;
    const chain = chainTo(entries, id);
    const prompts = chain.filter((e) => promptOf(e) !== null);
    if (prompts.length === 0) continue;
    const active = id === activeLeaf;
    let shared = 0;
    while (shared < prompts.length && shared < activePrompts.length && entryId(prompts[shared] as Obj) === activePrompts[shared]) shared += 1;
    // The prompt that tells it from the active path; a branch that only answered differently shows its last one.
    const telling = active || shared >= prompts.length ? prompts[prompts.length - 1] : prompts[shared];
    // The first words of the reply after that prompt: the one thing that differs when two paths share every prompt.
    const after = chain.slice(chain.indexOf(telling as Obj) + 1);
    const answer = after.map(replyOf).find((text): text is string => text !== null);
    const at = typeof leaf.timestamp === "string" ? Date.parse(leaf.timestamp) : NaN;
    out.push({ leafId: id, active, turns: prompts.length, shared, prompt: promptOf(telling as Obj) ?? "", ...(answer ? { answer } : {}), ...(Number.isFinite(at) ? { at } : {}) });
  }
  out.sort((a, b) => Number(b.active) - Number(a.active));
  return out.slice(0, MAX_BRANCHES);
}
