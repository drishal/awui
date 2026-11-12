// The cold-resume hint: a chat idle past its prompt cache's expiry pays to rebuild that prefix
// with its next prompt, and compacting first is usually cheaper. Claude Code reports the cache
// window it wrote (the chat's usage carries it); a chat that reports none has its last activity
// as a fallback clock. Nothing here compacts anything by itself: the composer offers, the user
// decides, and "Don't ask again" is remembered per device.
import type { ChatItem, SessionUsage } from "../shared/protocol.js";

/** Below this much context, rebuilding the prefix is not worth a compaction (T3 Code's floor, Claude Code's idle default). */
export const COLD_RESUME_MIN_TOKENS = 200_000;
/** Claude's longest cache is an hour, plus slack: the guess when a chat does not say which window it wrote. */
export const COLD_RESUME_FALLBACK_MS = 70 * 60_000;
/** The device's answer to "Don't ask again". */
export const COLD_RESUME_OFF_KEY = "coldResumeOff";

export interface ColdResumeInput {
  /** The last thing the chat did, when it knows: a fallback clock for a chat that reports no cache expiry. */
  lastActivityAt?: number | null;
  usage?: SessionUsage | null;
  /** The context the next prompt would carry, when the harness reports it. */
  contextTokens?: number | null;
  /** Compacting is only offered where the harness can do it. */
  supportsCompact: boolean;
  /** The user's remembered "Don't ask again". */
  off?: boolean;
  now?: number;
}

export interface ColdResumeHint {
  /** How long ago the prompt cache stopped being readable. */
  agoMs: number;
  /** The context a compaction would shrink. */
  tokens: number;
}

/** The hint, or null when the chat is warm, small, unsupported, or dismissed. */
export function coldResumeHint(input: ColdResumeInput): ColdResumeHint | null {
  if (input.off || !input.supportsCompact) return null;
  const tokens = input.contextTokens ?? 0;
  if (tokens < COLD_RESUME_MIN_TOKENS) return null;
  const now = input.now ?? Date.now();
  const last = input.lastActivityAt ?? null;
  // The harness's own answer first: when its cache runs out. Without one, the clock starts at the
  // chat's last activity and runs for the longest window a provider keeps.
  const expiresAt = input.usage?.promptCacheExpiresAt ?? (last !== null ? last + (input.usage?.promptCacheTtlMs ?? COLD_RESUME_FALLBACK_MS) : null);
  if (expiresAt === null || now < expiresAt) return null;
  return { agoMs: now - expiresAt, tokens };
}

/**
 * When the chat last did anything, from what the harness dated: the newest item time it kept
 * (an answer's end, a prompt's own time). Null when none of them carries one.
 */
export function lastActivity(items: readonly ChatItem[]): number | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    if (!item) continue;
    const at = ("endedAt" in item ? item.endedAt : undefined) ?? ("at" in item ? item.at : undefined);
    if (typeof at === "number" && Number.isFinite(at)) return at;
  }
  return null;
}

/** "40m", "3h 12m", "2d 4h": a span of time, shortest form that stays readable. */
export function span(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${min % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** The hint's one line, in the words the composer shows. */
export function coldResumeText(hint: ColdResumeHint): string {
  return `The prompt cache expired ${span(hint.agoMs)} ago: the next prompt re-sends ${hint.tokens.toLocaleString()} tokens.`;
}
