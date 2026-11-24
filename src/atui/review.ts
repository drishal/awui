// Review in a terminal, apart from the drawing: every changed file's edits
// as rows (a file's heading, each edit's heading, its diff lines), where the
// line cursor may stand (a line that takes a comment), moving it a line or a
// file at a time, and which rows fit on screen around it. The model is the
// web UI's (web/review.ts): the same comments, the same prompt.
import type { DiffLine } from "../shared/protocol.js";
import { commentable, commentKey, type FileChanges } from "../web/review.js";

export type ReviewRow =
  | { kind: "file"; file: number; path: string; added: number; removed: number }
  | { kind: "edit"; file: number; label: string }
  | { kind: "line"; file: number; path: string; key: string; line: DiffLine; /** A line of the file as it is now, shown from a gap: read-only, so the cursor skips it and no thread can pin to it. */ shown?: true };

export function reviewRows(files: FileChanges[]): ReviewRow[] {
  const rows: ReviewRow[] = [];
  files.forEach((f, file) => {
    rows.push({ kind: "file", file, path: f.path, added: f.added, removed: f.removed });
    for (const { tool, turn } of f.edits) {
      if (!tool.diff) continue;
      rows.push({ kind: "edit", file, label: `${turn > 0 ? `turn ${turn} · ` : ""}${tool.name}` });
      tool.diff.lines.forEach((line, i) => rows.push({ kind: "line", file, path: f.path, key: commentKey(tool.id, i), line }));
    }
  });
  return rows;
}

const stop = (row: ReviewRow | undefined): boolean => row?.kind === "line" && !row.shown && commentable(row.line);

/** The first row the cursor may stand on, or -1. */
export const firstStop = (rows: ReviewRow[]): number => rows.findIndex(stop);

/** The cursor `by` stops on (lines that take a comment), held at the ends. */
export function moveCursor(rows: ReviewRow[], at: number, by: number): number {
  let i = at;
  for (let n = 0; n < Math.abs(by); n++) {
    let next = i + Math.sign(by);
    while (next >= 0 && next < rows.length && !stop(rows[next])) next += Math.sign(by);
    if (next < 0 || next >= rows.length) break;
    i = next;
  }
  return i;
}

/** The cursor on the next (or previous) file's first line, held at the ends. */
export function moveFile(rows: ReviewRow[], at: number, by: 1 | -1): number {
  const file = (rows[at] as Extract<ReviewRow, { kind: "line" }> | undefined)?.file ?? 0;
  const target = rows.findIndex((r) => stop(r) && r.file === file + by);
  return target < 0 ? at : target;
}

/** The first row to draw so that `at` sits a third of the way down `height` rows (or the top or the end is reached). */
export function windowStart(total: number, at: number, height: number): number {
  return Math.max(0, Math.min(at - Math.floor(height / 3), total - height));
}

/** The most lines one gap opens: the rest stays folded, as the web's "Show all" bounds a huge file. */
export const GAP_LINES_MAX = 80;

/**
 * The file lines a gap row hides, as [first line, count]: right after a context or added line that carries its number in the file, and either
 * saying how many unchanged lines it folds ("12 unchanged lines") or sitting between two numbered lines. A truncated edit ("N more lines") has no place to read from.
 */
export function gapSpan(rows: ReviewRow[], at: number): { from: number; count: number } | null {
  const row = rows[at];
  if (row?.kind !== "line" || row.line.kind !== "gap") return null;
  const before = rows[at - 1];
  if (before?.kind !== "line" || before.file !== row.file || (before.line.kind !== "ctx" && before.line.kind !== "add") || before.line.line === undefined) return null;
  // The gap may say how many lines it folds; a bare hunk break does not, but the numbers either side of it do (the next kept line's number less the last one's).
  const said = Number(/^(\d+) unchanged lines?$/.exec(row.line.text)?.[1]);
  const next = rows[at + 1];
  const between = next?.kind === "line" && next.file === row.file && (next.line.kind === "ctx" || next.line.kind === "add") && next.line.line !== undefined && !row.line.text ? next.line.line - before.line.line - 1 : NaN;
  const count = Number.isFinite(said) ? said : between;
  if (!Number.isFinite(count) || count < 1) return null;
  return { from: before.line.line + 1, count };
}

/** The first gap at or after row `at` (in its file) that can open, or the nearest before it: what the review's `e` key opens. */
export function nearestGap(rows: ReviewRow[], at: number): number {
  const file = (rows[at] as { file?: number } | undefined)?.file;
  for (let i = at; i < rows.length && (rows[i] as { file?: number }).file === file; i++) if (gapSpan(rows, i)) return i;
  for (let i = at - 1; i >= 0 && (rows[i] as { file?: number }).file === file; i--) if (gapSpan(rows, i)) return i;
  return -1;
}

/** `rows` with each opened gap replaced by the file's own lines (as `ctx`, read-only), `lines` being those it read, by the gap row's key. */
export function openGaps(rows: ReviewRow[], opened: ReadonlyMap<string, string[]>): ReviewRow[] {
  const out: ReviewRow[] = [];
  rows.forEach((row, i) => {
    const text = row.kind === "line" ? opened.get(row.key) : undefined;
    const span = text ? gapSpan(rows, i) : null;
    if (row.kind !== "line" || !text || !span) return void out.push(row);
    text.forEach((line, n) => out.push({ kind: "line", file: row.file, path: row.path, key: `${row.key}+${n}`, line: { kind: "ctx", text: line, line: span.from + n }, shown: true }));
    if (span.count > text.length) out.push({ kind: "line", file: row.file, path: row.path, key: `${row.key}~`, line: { kind: "gap", text: `${span.count - text.length} more unchanged lines` } });
  });
  return out;
}
