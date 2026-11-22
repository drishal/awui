// When a turn happened and how fast it went, as the quiet text on hover: a clock
// time on the prompt, and "24s · 52 tok/s · first token 1.2s" on the answer's row.
// Pure and locale-aware (the browser's own by default), so unit tests give the
// locale and a fixed `now`. Nothing is invented: a part whose inputs the harness
// did not report is left out, and a turn with none of them shows nothing.
import type { Turn } from "./turns.js";
import { formatDuration } from "../shared/time-words.js";

const DAY_MS = 86_400_000;

/** The days between two moments' calendar dates, in the local zone (a day is a date change, not 24 hours, so DST cannot skew it). */
function calendarDays(from: number, to: number): number {
  const a = new Date(from);
  const b = new Date(to);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY_MS);
}

/** "3:41 pm": the locale's short clock time, with a 12-hour locale's AM/PM in lower case and a plain space. */
function clock(at: number, locale: string | undefined): string {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" })
    .format(at)
    .replace(/[  ]/g, " ")
    .replace(/\b(AM|PM)\b/, (m) => m.toLowerCase());
}

/**
 * When a prompt was sent, as short as it can be and still be unambiguous: "3:41 pm" today,
 * "Mon 3:41 pm" within the last week, "Oct 12, 3:41 pm" before that (with the year once it is not this one).
 */
export function formatWhen(at: number, now = Date.now(), locale?: string): string {
  const days = calendarDays(at, now);
  const time = clock(at, locale);
  if (days === 0) return time;
  if (days > 0 && days < 7) return `${new Intl.DateTimeFormat(locale, { weekday: "short" }).format(at)} ${time}`;
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  const date = new Intl.DateTimeFormat(locale, sameYear ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" }).format(at);
  return `${date}, ${time}`;
}

/** The full local date and time, for a title attribute. */
export function formatFullWhen(at: number, locale?: string): string {
  return new Date(at).toLocaleString(locale);
}

/** A span of time: tenths of a second under ten seconds ("1.2s"), where a whole second hides what is worth seeing, else the fold's "2m 5s". */
export function formatSpan(ms: number): string {
  return ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatDuration(ms);
}

/** What is known about how a turn went; each field is absent when the harness did not report its inputs. */
export interface TurnTiming {
  /** Prompt to the end of the last work. */
  durationMs?: number;
  /** Output tokens over the time the model spent generating them. */
  tokensPerSecond?: number;
  /** Prompt to the first thing the model wrote (thinking counts). */
  firstTokenMs?: number;
}

/**
 * How fast a turn went. `outputTokens` and `generationMs` are the turn's own
 * (not the session's); no harness reports them per message yet, so callers
 * leave them out and the rate stays unknown rather than borrowing the session's average.
 */
export function turnTiming(turn: Turn, tokens?: { outputTokens: number; generationMs: number }): TurnTiming {
  const timing: TurnTiming = {};
  if (turn.startedAt !== undefined && turn.endedAt !== undefined && turn.endedAt > turn.startedAt) timing.durationMs = turn.endedAt - turn.startedAt;
  if (tokens && tokens.outputTokens > 0 && tokens.generationMs > 0) timing.tokensPerSecond = tokens.outputTokens / (tokens.generationMs / 1000);
  // The first assistant item (answer, interim reply, or thought) is created when the model's first output arrives.
  const promptAt = turn.prompt?.at;
  if (promptAt !== undefined) {
    let first: number | undefined;
    for (const item of [...turn.process, ...(turn.answer ? [turn.answer] : []), ...turn.workAfter]) {
      if (item.kind === "assistant" && item.at !== undefined && (first === undefined || item.at < first)) first = item.at;
    }
    if (first !== undefined && first >= promptAt) timing.firstTokenMs = first - promptAt;
  }
  return timing;
}

/** The answer row's text: "24s · 52 tok/s · first token 1.2s", or null when nothing is known. */
export function timingLabel(timing: TurnTiming): string | null {
  const parts: string[] = [];
  if (timing.durationMs !== undefined) parts.push(formatSpan(timing.durationMs));
  if (timing.tokensPerSecond !== undefined) parts.push(`${Math.round(timing.tokensPerSecond)} tok/s`);
  if (timing.firstTokenMs !== undefined) parts.push(`first token ${formatSpan(timing.firstTokenMs)}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}
