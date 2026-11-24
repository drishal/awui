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

/**
 * A key line that fits `width`: its hints ("↑↓ move", "Enter open", …) are joined with " · ", the last one (Esc) and the
 * first stay, and the ones between leave from the end backwards until the line fits, so a narrow pane drops whole hints
 * and never wraps or cuts one (the footer's own rule).
 */
export function fitHints(parts: readonly string[], width: number): string {
  const kept = [...parts];
  const line = () => kept.join(" · ");
  while (kept.length > 2 && line().length > width) kept.splice(kept.length - 2, 1);
  return line();
}

/** A price in dollars, one wording for the footer's chat total and a turn's Σ figure so the same sum never reads two ways: $0.028 under ten cents (a cent is too coarse for one call), $0.50 and $12.35 above; a hair of a cent is "<$0.001". */
export function spendLabel(usd: number): string {
  if (usd < 0.001) return "<$0.001";
  return `$${usd < 0.1 ? usd.toFixed(3) : usd.toFixed(2)}`;
}

/** What a chat has spent, for the footer: "$0.12 · cache 84%". Nothing is shown for what is unknown (no price, no cached input). */
export function spendWords(usage: { input: number; cachedInput: number; cost: number | null } | null | undefined): string {
  if (!usage) return "";
  const parts: string[] = [];
  if (usage.cost !== null && usage.cost > 0) parts.push(spendLabel(usage.cost));
  const read = usage.input + usage.cachedInput;
  if (usage.cachedInput > 0 && read > 0) parts.push(`cache ${Math.round((usage.cachedInput / read) * 100)}%`);
  return parts.join(" · ");
}
