// The transcript's right-hand gutter: one tick per turn, coloured by what
// the turn did, with the visible stretch marked, so it doubles as a
// scrollbar; and which turn's prompt to pin at the top while you read inside
// it. Pure: positions in, cells out.
import type { Turn } from "../web/turns.js";

export type TurnTone = "live" | "failed" | "edited" | "rendered" | "plain" | "found";

/** What a turn did (a turn the last find matched is "found", set by the caller, not here), as its tick's colour: running, failed, changed files, published a page, or just talked. */
export function turnTone(turn: Turn): TurnTone {
  if (turn.live) return "live";
  const failed = turn.errors.length > 0 || Boolean(turn.answer?.error && turn.answer.error !== "Stopped") || turn.process.some((i) => i.kind === "tool" && i.status === "error");
  if (failed) return "failed";
  if (turn.changedFiles.length > 0) return "edited";
  if (turn.renders.length > 0) return "rendered";
  return "plain";
}

export interface MinimapCell {
  /** The turn this row stands for, when one starts within it. */
  tone: TurnTone | null;
  /** Within the part of the transcript on screen. */
  inView: boolean;
}

/**
 * `rows` gutter cells for a transcript `contentHeight` lines tall, of which
 * `viewHeight` lines from `viewTop` are on screen; `tops` are where each
 * turn starts. A turn shorter than a row still gets its tick (the later
 * turn wins a shared row, so the newest work always shows).
 */
export function minimapCells(tops: Array<{ top: number; tone: TurnTone }>, contentHeight: number, viewTop: number, viewHeight: number, rows: number): MinimapCell[] {
  const n = Math.max(0, Math.floor(rows));
  const total = Math.max(1, contentHeight, viewHeight);
  const scale = n / total;
  const cells: MinimapCell[] = Array.from({ length: n }, (_, i) => {
    const from = i / scale;
    const to = (i + 1) / scale;
    return { tone: null, inView: to > viewTop && from < viewTop + viewHeight };
  });
  for (const t of tops) {
    const row = Math.min(n - 1, Math.max(0, Math.floor(t.top * scale)));
    const cell = cells[row];
    if (cell) cell.tone = t.tone;
  }
  return cells;
}

/** The scroll offset a click on gutter row `row` asks for: that point of the transcript, centred. */
export function rowToScroll(row: number, rows: number, contentHeight: number, viewHeight: number): number {
  const point = ((row + 0.5) / Math.max(1, rows)) * contentHeight;
  return Math.max(0, Math.min(contentHeight - viewHeight, Math.round(point - viewHeight / 2)));
}

/**
 * The turn whose prompt has scrolled off the top while its work and answer
 * are still on screen: the last one starting above the view, provided the
 * next one has not started yet. Null at the very top or between turns.
 */
export function pinnedTurn(tops: number[], viewTop: number): number | null {
  let at: number | null = null;
  for (let i = 0; i < tops.length; i++) {
    if ((tops[i] as number) < viewTop) at = i;
    else break;
  }
  if (at === null) return null;
  const next = tops[at + 1];
  return next !== undefined && next <= viewTop + 1 ? null : at;
}
