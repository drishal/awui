// `@` in a room addresses members by handle, and what the composer sends is
// structured: member ids, never handles, because the server must not infer
// routing authority from text a model or a paste could have written. This
// module is the pure half — finding the mention under the caret, completing it,
// and resolving the final draft's tokens to ids in one deterministic order.
import type { RoomMemberView } from "../shared/protocol.js";
import { BOARD_MAX_MEMBERS } from "../shared/protocol.js";

/** Longest handle the wire allows (BOARD_HANDLE_PATTERN); a longer run is not a handle. */
const HANDLE_CHARS = 32;
const TOKEN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

export interface MentionRange {
  /** Index of the `@` in the draft. */
  start: number;
  /** The caret, where the handle being typed ends. */
  end: number;
  /** What has been typed after the `@` (may be empty). */
  query: string;
}

/**
 * The mention being typed at `caret`, or null. An `@` only starts a mention at
 * the start of the draft or after whitespace, so `me@example.com` stays an
 * address and a mid-word `@` opens nothing.
 */
export function mentionRange(text: string, caret: number): MentionRange | null {
  let at = -1;
  for (let i = Math.min(caret, text.length) - 1; i >= 0; i -= 1) {
    const ch = text[i] as string;
    if (ch === "@") {
      at = i;
      break;
    }
    if (/\s/.test(ch)) return null;
    if (!/[A-Za-z0-9_-]/.test(ch)) return null;
  }
  if (at < 0) return null;
  const query = text.slice(at + 1, caret);
  if (query.length > HANDLE_CHARS) return null;
  if (at > 0 && !/\s/.test(text[at - 1] as string)) return null;
  return { start: at, end: caret, query };
}

/** The room's enabled members a typed prefix could mean, in rank order (ties by id). */
export function matchMembers(members: readonly RoomMemberView[], query: string): RoomMemberView[] {
  const q = query.toLowerCase();
  return members
    .filter((m) => m.enabled && m.handle.toLowerCase().startsWith(q))
    .sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Replace the mention under the caret with `@handle ` and say where the caret lands. */
export function insertMention(text: string, range: MentionRange, handle: string): { text: string; caret: number } {
  const before = text.slice(0, range.start);
  const after = text.slice(range.end);
  const insertion = `@${handle}${/^\s/.test(after) ? "" : " "}`;
  return { text: before + insertion + after, caret: before.length + insertion.length };
}

export interface MentionToken {
  handle: string;
  start: number;
  end: number;
}

/** Every `@handle`-shaped token in the draft, left to right (rendering and diagnostics). */
export function mentionTokens(text: string): MentionToken[] {
  const tokens: MentionToken[] = [];
  const re = /(^|\s)@([A-Za-z0-9][A-Za-z0-9_-]{0,31})/g;
  for (const match of text.matchAll(re)) {
    const handle = match[2] as string;
    if (!TOKEN.test(handle)) continue;
    const start = (match.index ?? 0) + (match[1] as string).length;
    tokens.push({ handle, start, end: start + handle.length + 1 });
  }
  return tokens;
}

/**
 * The structured mentions for a draft: handles resolve case-insensitively to
 * enabled members, duplicates collapse, and the result is in room rank order
 * (the server runs direct responders serially in that order). Unknown or
 * disabled handles are reported, never silently dropped into a broadcast.
 */
export function resolveMentions(text: string, members: readonly RoomMemberView[]): { ids: string[]; unknown: string[] } {
  const byHandle = new Map<string, RoomMemberView>();
  for (const member of members) {
    const key = member.handle.toLowerCase();
    // Handles are unique per room case-insensitively; the first (lowest rank) wins if a stale client disagrees.
    if (member.enabled && !byHandle.has(key)) byHandle.set(key, member);
  }
  const ids: string[] = [];
  const unknown: string[] = [];
  for (const token of mentionTokens(text)) {
    const member = byHandle.get(token.handle.toLowerCase());
    if (!member) {
      if (!unknown.includes(token.handle)) unknown.push(token.handle);
      continue;
    }
    if (!ids.includes(member.id) && ids.length < BOARD_MAX_MEMBERS) ids.push(member.id);
  }
  const ranked = members.filter((m) => ids.includes(m.id)).sort((a, b) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { ids: ranked.map((m) => m.id), unknown };
}

/** A handle suggestion for a member name: safe letters, digits, `_` and `-`, lowercased, never empty. */
export function handleFrom(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, HANDLE_CHARS)
    .toLowerCase();
  return slug || "bot";
}
