// Find in chat (T3 Code's thread find): Ctrl+F searches the transcript as
// drawn, highlights every match, and steps through them. A match inside a
// folded "Worked for …" process opens that fold first, which the browser's own
// find cannot do. Matching is pure here; the component walks the DOM's text
// and paints with the CSS Custom Highlight API, so the page is never rewritten.
import { toolSentence } from "../shared/tool-row.js";
import type { Turn } from "./turns.js";

/** Where `needle` starts in `haystack`, case-insensitively, without overlaps. */
export function findOffsets(haystack: string, needle: string): number[] {
  const q = needle.toLowerCase();
  if (!q) return [];
  const h = haystack.toLowerCase();
  const out: number[] = [];
  for (let at = h.indexOf(q); at >= 0; at = h.indexOf(q, at + q.length)) out.push(at);
  return out;
}

/** The text a turn's fold holds: what is hidden while it is closed. */
function processText(turn: Turn): string {
  const parts: string[] = [];
  for (const item of [...turn.process, ...turn.workAfter]) {
    if (item.kind === "assistant") parts.push(item.text, item.thinking);
    else if (item.kind === "tool") {
      // What the row says: its sentence, the facts beside it, and a failure's line. Not the tool's raw name or summary: they are not drawn, so a match there would be counted but never seen ("edit" and "Edited" are one call, not two).
      const sentence = toolSentence(item, "");
      parts.push(sentence.text, sentence.facts.join(" "), sentence.error ?? "");
    }
    else if (item.kind === "notice") parts.push(item.text);
  }
  if (turn.answer?.thinking) parts.push(turn.answer.thinking);
  return parts.join("\n");
}

/** Where in a turn a match can be: its visible prompt and answer, or the work its fold holds. */
export interface TurnMatch {
  /** The turn's index among the transcript's turns (the box to scroll to). */
  index: number;
  turnId: string;
  count: number;
  /** The first match with some of the text around it, on one line. */
  snippet: string;
  /** The match is inside the work (a closed fold hides it), not in the prompt or the answer. */
  inWork: boolean;
}

/** A line of `text` around its first match of `needle`, `radius` characters either side, whitespace folded to single spaces. */
export function findSnippet(text: string, needle: string, radius = 36): string {
  const at = findOffsets(text, needle)[0];
  if (at === undefined) return "";
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + needle.length + radius);
  // Markdown marks (bold, code spans) are noise in a one-line snippet.
  const flat = text.slice(from, to).replace(/\s+/g, " ").replace(/\*\*|__|`/g, "").trim();
  return `${from > 0 ? "…" : ""}${flat}${to < text.length ? "…" : ""}`;
}

/**
 * Every turn that mentions `query`, in transcript order, with how many times, a line around the first match, and whether
 * it sits in the work (atui's find is a list of these, where the web's marks the page itself).
 */
export function findTurns(turns: readonly Turn[], query: string, radius = 36): TurnMatch[] {
  if (!query.trim()) return [];
  const out: TurnMatch[] = [];
  turns.forEach((turn, index) => {
    const visible = [turn.prompt?.text ?? "", turn.answer?.text ?? ""].join("\n");
    const work = processText(turn);
    const inVisible = findOffsets(visible, query).length;
    const inWork = findOffsets(work, query).length;
    if (inVisible + inWork === 0) return;
    out.push({ index, turnId: turn.id, count: inVisible + inWork, snippet: findSnippet(inVisible > 0 ? visible : work, query, radius), inWork: inVisible === 0 });
  });
  return out;
}

/** Turns whose fold holds a match: they open so their matches can be shown. */
export function foldsToOpen(turns: readonly Turn[], query: string): string[] {
  if (!query.trim()) return [];
  return turns.filter((t) => t.prompt && findOffsets(processText(t), query).length > 0).map((t) => t.id);
}

/** The next match to show, from `current`, wrapping around; -1 when there are none. */
export function stepMatch(current: number, count: number, step: 1 | -1): number {
  if (count === 0) return -1;
  if (current < 0) return step === 1 ? 0 : count - 1;
  return (current + step + count) % count;
}
