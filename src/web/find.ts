// Find in chat (T3 Code's thread find): Ctrl+F searches the transcript as
// drawn, highlights every match, and steps through them. A match inside a
// folded "Worked for …" process opens that fold first, which the browser's own
// find cannot do. Matching is pure here; the component walks the DOM's text
// and paints with the CSS Custom Highlight API, so the page is never rewritten.
import { toolSentence } from "./tool-sentence.js";
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
      // What the row says: its sentence, the facts beside it, and a failure's line.
      const sentence = toolSentence(item, "");
      parts.push(item.name, item.summary, sentence.text, sentence.facts.join(" "), sentence.error ?? "");
    }
    else if (item.kind === "notice") parts.push(item.text);
  }
  if (turn.answer?.thinking) parts.push(turn.answer.thinking);
  return parts.join("\n");
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
