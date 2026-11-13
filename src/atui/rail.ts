// The active-work rail as a terminal draws it, apart from the drawing: the cards of rows the
// server's records make (web/context-panel.ts groups them), the flat list the cursor walks, the
// one-line summary over them, and the colour a status word is drawn in. Pure, so the keys and
// the words are tested without a terminal.
import type { ContextCard, ContextCardRow, StatusTone } from "../web/context-panel.js";
import type { Theme } from "./theme.js";

/** One row of the rail, with the card it belongs to (its heading is drawn once, above its rows). */
export interface RailEntry {
  card: ContextCard;
  row: ContextCardRow;
}

/** Every row of every card, in the order the rail draws them: the cursor walks this list. */
export function railEntries(cards: ContextCard[]): RailEntry[] {
  return cards.flatMap((card) => card.rows.map((row) => ({ card, row })));
}

/**
 * What the rail says over its cards: how much is running, how much waits on a person, and what
 * failed. "Nothing is running" when there is nothing to count, so an idle chat says why the rail
 * is quiet rather than showing an empty figure.
 */
export function railSummary(cards: ContextCard[]): string {
  const rows = railEntries(cards).map((entry) => entry.row);
  const working = rows.filter((row) => row.status.tone === "working").length;
  const waiting = rows.filter((row) => row.status.tone === "waiting").length;
  const failed = rows.filter((row) => row.status.tone === "failed").length;
  const parts = [working > 0 ? `${working} working` : null, waiting > 0 ? `${waiting} ${waiting === 1 ? "needs you" : "need you"}` : null, failed > 0 ? `${failed} failed` : null].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Nothing is running";
}

/** The colour a row's status word and its dot are drawn in: the browser's reading, in the terminal's palette. */
export function toneOf(theme: Theme, tone: StatusTone): string {
  switch (tone) {
    case "working":
      return theme.accent;
    case "waiting":
      return theme.warn;
    case "done":
      return theme.ok;
    case "failed":
      return theme.danger;
    case "quiet":
      return theme.muted;
  }
}

/** The glyph a row's dot is drawn with: filled while it works or waits, hollow once it is quiet. */
export const toneDot = (tone: StatusTone): string => (tone === "quiet" || tone === "done" ? "○" : "●");
