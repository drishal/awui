// Free context rotation: a session whose context is nearly full can be left behind
// for a fresh one that carries the newest turns verbatim and one line per older turn
// — no model call, no summary, no cost. The harness writes the new session from the
// seed (harness/handoff.ts); the old session file is never touched. This module holds
// the threshold and the words; the decision to rotate is the user's.
import type { ChatSnapshot } from "../shared/protocol.js";
import { lastActivity } from "./cold-resume.js";

/** From this share of the context window, a fresh session is worth offering. */
export const ROTATION_PERCENT = 80;
/** The device's answer to "Don't ask again". */
export const ROTATION_OFF_KEY = "rotationOff";

export interface RotationInput {
  /** The context window's fill, as the harness reports it. */
  percent: number | null;
  /** The harness can write a new session from a transcript (the handoff seed); without it, only compaction helps. */
  supported: boolean;
  /** A run is going: the offer waits, since rotating mid-run would leave the old run writing. */
  busy: boolean;
  /** The user's remembered "Don't ask again". */
  off?: boolean;
  /** The chat's last activity, so the offer can say how full and how old it is; null when unknown. */
  since?: number | null;
  now?: number;
}

/** The offer, or null when the context is not near full, the harness cannot seed a session, or the user said no. */
export function rotationHint(input: RotationInput): { percent: number; ageMs: number | null } | null {
  if (input.off || !input.supported || input.busy) return null;
  const percent = input.percent;
  if (percent === null || !Number.isFinite(percent) || percent < ROTATION_PERCENT) return null;
  const ageMs = input.since != null && input.now != null ? Math.max(0, input.now - input.since) : null;
  return { percent: Math.round(percent), ageMs };
}

/** The offer in words: what is full, what a fresh session keeps, and what it gives up. */
export function rotationText(hint: { percent: number; ageMs: number | null }): string {
  const kept = `A fresh session keeps the newest turns word for word and one line for each older turn — no summary, no extra model call.`;
  return `This session's context is ${hint.percent}% full. ${kept} This one stays open as it is.`;
}

/**
 * Whether this chat can rotate at all: the harness writes a new session from a
 * transcript, a session exists to carry, and something was said in it.
 */
export function rotationSupported(chat: Pick<ChatSnapshot, "capabilities" | "sessionId">): boolean {
  return chat.capabilities.supportsHandoff && chat.sessionId !== null;
}

/** The offer for a whole chat snapshot: null when it is not worth putting to the user. */
export function chatRotation(chat: Pick<ChatSnapshot, "capabilities" | "sessionId" | "context" | "status" | "items">, opts: { off?: boolean; now?: number } = {}) {
  return rotationHint({
    percent: chat.context?.percent ?? null,
    supported: rotationSupported(chat),
    busy: chat.status !== "idle" && chat.status !== "error",
    ...(opts.off !== undefined ? { off: opts.off } : {}),
    since: lastActivity(chat.items),
    now: opts.now ?? Date.now(),
  });
}
