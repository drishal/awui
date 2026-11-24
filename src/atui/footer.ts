/**
 * The composer footer's right side under a narrow pane: pi's statusline drops whole segments, lowest priority first,
 * and never wraps or cuts one mid-word. This is that decision as a pure function, so the footer and its test share it.
 */

/** One piece of the footer's right side: how wide it draws and how much it matters (1 is kept longest). */
export interface FooterSegment {
  id: string;
  width: number;
  rank: number;
}

/**
 * The ids that fit in `budget` cells. Segments leave from the least important (the highest rank) until the rest fit;
 * of equal rank the one drawn later goes first. A segment is never shrunk, and the most important one stays even when
 * it alone is wider than the budget (the context figure is the one thing a heavy chat must keep showing).
 */
export function fitFooter(segments: readonly FooterSegment[], budget: number): Set<string> {
  const kept = segments.filter((s) => s.width > 0);
  const total = () => kept.reduce((n, s) => n + s.width, 0);
  while (kept.length > 1 && total() > budget) {
    let drop = 0;
    kept.forEach((s, i) => {
      const worst = kept[drop] as FooterSegment;
      if (s.rank >= worst.rank) drop = i;
    });
    kept.splice(drop, 1);
  }
  return new Set(kept.map((s) => s.id));
}

/** What a chat has spent, for the footer: "$0.12 · cache 84%". Nothing is shown for what is unknown (no price, no cached input). */
export function spendWords(usage: { input: number; cachedInput: number; cost: number | null } | null | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.cost !== null && usage.cost > 0) parts.push(usage.cost < 0.01 ? "<$0.01" : `$${usage.cost.toFixed(2)}`);
  const read = usage.input + usage.cachedInput;
  if (usage.cachedInput > 0 && read > 0) parts.push(`cache ${Math.round((usage.cachedInput / read) * 100)}%`);
  return parts.join(" · ");
}
