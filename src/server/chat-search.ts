// Search every chat: the words, all of them in one message, across every
// session the sidebar can list, in every harness and project. A session's
// prompts, answers, and tool targets (a command, a path) are read once per
// version of it, from the live chat or the harness's own file (never starting
// the harness: Hermes keeps no file, so only its titles and live chats are
// searched) and kept as plain text. Bounded: a time budget, a cap on hits,
// and each session's text cut, so a search over a long history stays quick.
import type { ChatItem, ChatSearch, ChatSearchHit, ChatSearchKind, ChatSearchResult, ProjectSession, WorkspaceInfo } from "../shared/protocol.js";

/** One piece of a chat a search looks at. */
export interface SearchEntry {
  kind: Exclude<ChatSearchKind, "title">;
  turn: number;
  text: string;
}

/** A session the search may read, and how. */
export interface SearchTarget {
  session: ProjectSession;
  /** Its items, or null when they cannot be read without starting the harness. */
  read: () => Promise<ChatItem[] | null>;
}

/** A message's text past this is not searched. */
const ENTRY_CHARS = 20_000;
/** A session's searchable text, in all. */
const SESSION_CHARS = 400_000;
/** Characters of context on each side of a match. */
const CONTEXT = 70;
const HITS_SHOWN = 3;
const MAX_RESULTS = 120;
const BUDGET_MS = 3000;
const PARALLEL = 6;
/**
 * What is kept between searches: bounded by text, since that is what costs memory. The text of
 * 700 real sessions came to 8.5 M characters, so this holds every session of a large history;
 * a count cap of 400 once lay below the number of sessions, so each search evicted what the
 * next one needed and could never finish.
 */
const CACHED_CHARS = 60_000_000;
const CACHED_SESSIONS = 5000;

const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

/** An answer as it reads, not as it is written: emphasis, code ticks, heading and quote marks, and link syntax out. */
export function plainMarkdown(text: string): string {
  return text
    .replace(/^\s*```.*$/gm, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/`+([^`]*)`+/g, "$1")
    .replace(/^\s{0,3}(#{1,6}|>)\s+/gm, "");
}

/** The searchable pieces of a chat, in order: prompts (not commands), answers, and the tools' targets. */
export function searchEntries(items: ChatItem[]): SearchEntry[] {
  const out: SearchEntry[] = [];
  let turn = 0;
  let budget = SESSION_CHARS;
  const add = (kind: SearchEntry["kind"], raw: string) => {
    if (budget <= 0) return;
    const text = collapse(raw.slice(0, ENTRY_CHARS));
    if (!text) return;
    budget -= text.length;
    out.push({ kind, turn: Math.max(1, turn), text });
  };
  for (const item of items) {
    if (item.kind === "user") {
      if (item.command) continue;
      turn += 1;
      add("prompt", item.text);
    } else if (item.kind === "assistant") add("answer", plainMarkdown(item.text));
    else if (item.kind === "tool") add("tool", [item.summary, ...item.paths.filter((p) => p !== item.summary)].join(" "));
  }
  return out;
}

/** The query's words, lowercased and deduplicated, longest first (so a word inside another is marked as the longer). */
export function queryWords(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8).sort((a, b) => b.length - a.length);
}

/**
 * Where `words` all appear in `text`: a snippet around the first word's
 * first place, with every word marked inside it. Null when one is missing.
 */
export function matchText(text: string, words: string[]): { snippet: string; ranges: Array<[number, number]> } | null {
  if (words.length === 0) return null;
  const lower = text.toLowerCase();
  let first = Number.POSITIVE_INFINITY;
  for (const w of words) {
    const at = lower.indexOf(w);
    if (at < 0) return null;
    first = Math.min(first, at);
  }
  // Cut at a space where one is near, so the snippet does not open or close mid-word.
  let from = Math.max(0, first - CONTEXT);
  if (from > 0) {
    const space = text.indexOf(" ", from);
    if (space >= 0 && space < first) from = space + 1;
  }
  let to = Math.min(text.length, first + CONTEXT * 2);
  if (to < text.length) {
    const space = text.lastIndexOf(" ", to);
    if (space > first) to = space;
  }
  const snippet = `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
  const body = snippet.toLowerCase();
  const ranges: Array<[number, number]> = [];
  for (const w of words) {
    for (let at = body.indexOf(w); at >= 0; at = body.indexOf(w, at + w.length)) {
      if (!ranges.some(([a, b]) => at < b && at + w.length > a)) ranges.push([at, at + w.length]);
    }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  return { snippet, ranges };
}

/** A session's hits: its title first, then its entries in order. */
export function sessionHits(title: string, entries: SearchEntry[], words: string[]): ChatSearchHit[] {
  const hits: ChatSearchHit[] = [];
  const named = matchText(collapse(title), words);
  if (named) hits.push({ kind: "title", turn: null, ...named });
  for (const e of entries) {
    const m = matchText(e.text, words);
    if (m) hits.push({ kind: e.kind, turn: e.turn, ...m });
  }
  return hits;
}

/** The searcher, with each session's text kept between searches (the newest version of each). */
export class ChatSearcher {
  private cache = new Map<string, { version: string; entries: SearchEntry[] | null; chars: number }>();
  private cachedChars = 0;
  private warming = false;

  private remember(id: string, version: string, entries: SearchEntry[] | null): void {
    const held = this.cache.get(id);
    if (held) this.cachedChars -= held.chars;
    this.cache.delete(id);
    const chars = entries?.reduce((sum, e) => sum + e.text.length, 0) ?? 0;
    this.cache.set(id, { version, entries, chars });
    this.cachedChars += chars;
    while (this.cache.size > 1 && (this.cache.size > CACHED_SESSIONS || this.cachedChars > CACHED_CHARS)) {
      const oldest = this.cache.keys().next().value as string;
      this.cachedChars -= this.cache.get(oldest)?.chars ?? 0;
      this.cache.delete(oldest);
    }
  }

  /**
   * A search that ran out of time leaves sessions unread: read them now, one at a time and
   * without the time budget, so the next search finds them and finishes. One pass at a time.
   */
  private warm(targets: SearchTarget[]): void {
    if (this.warming) return;
    this.warming = true;
    void (async () => {
      try {
        for (const target of targets) await this.entriesOf(target);
      } finally {
        this.warming = false;
      }
    })();
  }

  private async entriesOf(target: SearchTarget): Promise<SearchEntry[] | null> {
    const { session } = target;
    // A live chat changes under its version: read it each time (it is in memory).
    const version = session.liveChatId ? null : `${session.updatedAt ?? ""}`;
    const hit = version === null ? undefined : this.cache.get(session.id);
    if (hit && hit.version === version) return hit.entries;
    const items = await target.read().catch(() => null);
    const entries = items ? searchEntries(items) : null;
    if (version !== null) this.remember(session.id, version, entries);
    return entries;
  }

  /** `targets` newest first; the results keep that order. */
  async search(query: string, targets: SearchTarget[], workspaces: WorkspaceInfo[], budgetMs = BUDGET_MS): Promise<ChatSearch> {
    const words = queryWords(query);
    const started = Date.now();
    const found: Array<ChatSearchResult | null> = new Array(targets.length).fill(null);
    let scanned = 0;
    let next = 0;
    let outOfTime = false;
    let count = 0;
    const worker = async () => {
      while (next < targets.length && count < MAX_RESULTS) {
        if (Date.now() - started > budgetMs) {
          outOfTime = true;
          return;
        }
        const i = next++;
        const target = targets[i] as SearchTarget;
        const entries = await this.entriesOf(target);
        scanned += 1;
        const hits = sessionHits(target.session.title, entries ?? [], words);
        if (hits.length === 0) continue;
        found[i] = { session: target.session, hits: hits.slice(0, HITS_SHOWN), more: Math.max(0, hits.length - HITS_SHOWN) };
        count += 1;
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, targets.length) }, worker));
    if (outOfTime) this.warm(targets);
    const results = found.filter((r): r is ChatSearchResult => r !== null).slice(0, MAX_RESULTS);
    const used = new Set(results.map((r) => r.session.workspaceId));
    return {
      results,
      workspaces: workspaces.filter((w) => used.has(w.id)),
      scanned,
      total: targets.length,
      truncated: outOfTime || count >= MAX_RESULTS,
    };
  }
}
