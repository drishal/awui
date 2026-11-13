// The git panel in a terminal, apart from the drawing: the rows it shows (a
// group's heading, then its files), where the cursor may stand (a file row),
// moving it a row or a group at a time, and the words a row and the header
// carry. The words and the grouping are the web panel's (shared/git-words.ts),
// so the two clients read a status alike.
import type { GitStatus } from "../shared/protocol.js";
import { groupFiles, stateLetter, type GroupedFile, type GitGroup } from "../shared/git-words.js";

export type GitRow =
  | { kind: "group"; group: GitGroup; count: number }
  | { kind: "file"; group: GitGroup; entry: GroupedFile };

export function gitRows(status: GitStatus): GitRow[] {
  const rows: GitRow[] = [];
  for (const { group, files } of groupFiles(status.files)) {
    rows.push({ kind: "group", group, count: files.length });
    for (const entry of files) rows.push({ kind: "file", group, entry });
  }
  return rows;
}

const stop = (row: GitRow | undefined): boolean => row?.kind === "file";

/** The first row the cursor may stand on, or -1 (a clean tree has none). */
export const firstStop = (rows: GitRow[]): number => rows.findIndex(stop);

/** The cursor `by` files along, skipping group headings, held at the ends. */
export function moveCursor(rows: GitRow[], at: number, by: number): number {
  let i = at;
  for (let n = 0; n < Math.abs(by); n++) {
    let next = i + Math.sign(by);
    while (next >= 0 && next < rows.length && !stop(rows[next])) next += Math.sign(by);
    if (next < 0 || next >= rows.length) break;
    i = next;
  }
  return i;
}

/** The cursor on the next (or previous) group's first file, held at the ends. */
export function moveGroup(rows: GitRow[], at: number, by: 1 | -1): number {
  const row = rows[at];
  if (row?.kind !== "file") return at;
  const headings = rows.flatMap((r, i) => (r.kind === "group" ? [i] : []));
  const mine = headings.findIndex((i) => (rows[i] as Extract<GitRow, { kind: "group" }>).group === row.group);
  if (mine < 0) return at;
  const next = headings[mine + by];
  if (next === undefined) return at;
  const first = rows.findIndex((r, i) => i > (next as number) && r.kind === "file");
  return first < 0 ? at : first;
}

/** The changed counts, as the web panel's facts word them: staged, changed, new, conflicts. */
export function countsWords(status: GitStatus): string[] {
  const { conflicts, staged, changed, untracked } = status.counts;
  return [
    conflicts ? `${conflicts} conflicted` : "",
    staged ? `${staged} staged` : "",
    changed ? `${changed} changed` : "",
    untracked ? `${untracked} untracked` : "",
  ].filter(Boolean);
}

/** A file row's own words: its state letter, its path with a rename's source, its +/- as the badge words them, and a note when there are no line counts. */
export function rowWords(row: Extract<GitRow, { kind: "file" }>): { letter: string; path: string; added: string; removed: string; note: string } {
  const { file, state, lines } = row.entry;
  const moved = file.from && row.entry.side !== "unstaged" ? `${file.from} → ` : "";
  const counted = lines !== null && lines.added !== null && lines.removed !== null;
  return {
    letter: stateLetter(state),
    path: `${moved}${file.path}`,
    added: counted ? `+${lines.added}` : "",
    removed: counted ? `−${lines.removed}` : "",
    note: counted ? "" : state === "untracked" ? "new" : state === "conflict" ? "conflict" : lines !== null ? "binary" : "",
  };
}

/** What Enter does to a row: a staged file goes back out of the index, anything else goes in. */
export function stageAction(row: Extract<GitRow, { kind: "file" }>): "stage" | "unstage" {
  return row.entry.side === "staged" ? "unstage" : "stage";
}

/** Every path one write covers: the row's file, and a rename's source with it. */
export const rowPaths = (row: Extract<GitRow, { kind: "file" }>): string[] => [row.entry.file.path];
