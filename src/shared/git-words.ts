// The git panel's words and grouping, shared by the web composer's panel and
// both terminal clients: the letter a file's state shows, the four groups a
// status splits into (a file with staged and unstaged changes is under both),
// and the name of an operation under way. Pure, so every client words and
// sorts a status alike; the web's status polling stays in web/git.ts.
import type { GitDiffSide, GitFile, GitFileState, GitStatus } from "./protocol.js";
import { ago } from "../web/turns.js";

const LETTER: Record<GitFileState, string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  copied: "C",
  typechange: "T",
  untracked: "U",
  conflict: "!",
};

export const stateLetter = (s: GitFileState): string => LETTER[s];

/**
 * The colour a file's state shows in, as the web panel's letter badges draw them:
 * work the index does not know about (M, T) is the attention colour, new files
 * (A, U, C) the success one, a deletion or a conflict danger, a rename info.
 */
export type StateTone = "warn" | "ok" | "danger" | "info" | "muted";

const TONE: Record<GitFileState, StateTone> = {
  modified: "warn",
  typechange: "warn",
  added: "ok",
  copied: "ok",
  untracked: "ok",
  deleted: "danger",
  conflict: "danger",
  renamed: "info",
};

export const stateTone = (s: GitFileState): StateTone => TONE[s];

export type GitGroup = "conflicts" | "staged" | "changed" | "untracked";

export const GROUP_LABEL: Record<GitGroup, string> = {
  conflicts: "Conflicts",
  staged: "Staged",
  changed: "Changed",
  untracked: "Untracked",
};

export interface GroupedFile {
  file: GitFile;
  /** What this group shows of it: its state, its lines, and which diff. */
  state: GitFileState;
  lines: { added: number | null; removed: number | null } | null;
  side: GitDiffSide;
}

/** As `git status` lists them: a file with staged and unstaged changes is under both. */
export function groupFiles(files: GitFile[]): Array<{ group: GitGroup; files: GroupedFile[] }> {
  const groups: Record<GitGroup, GroupedFile[]> = { conflicts: [], staged: [], changed: [], untracked: [] };
  for (const f of files) {
    if (f.staged === "conflict") groups.conflicts.push({ file: f, state: "conflict", lines: null, side: "unstaged" });
    else if (f.unstaged === "untracked") groups.untracked.push({ file: f, state: "untracked", lines: null, side: "untracked" });
    else {
      if (f.staged) groups.staged.push({ file: f, state: f.staged, lines: f.stagedLines ?? null, side: "staged" });
      if (f.unstaged) groups.changed.push({ file: f, state: f.unstaged, lines: f.unstagedLines ?? null, side: "unstaged" });
    }
  }
  return (Object.keys(groups) as GitGroup[]).filter((g) => groups[g].length > 0).map((group) => ({ group, files: groups[group] }));
}

export const OPERATION_LABEL: Record<NonNullable<GitStatus["operation"]>, string> = {
  merge: "Merging",
  rebase: "Rebasing",
  "cherry-pick": "Cherry-picking",
  revert: "Reverting",
  bisect: "Bisecting",
};

/** The branch's name, or where a detached HEAD stands. */
export const branchWords = (status: Pick<GitStatus, "branch" | "head">): string => status.branch ?? `detached at ${status.head ?? "?"}`;

/** How far the branch is from its upstream, as the row's sync chip words it: ↑N, ↓N, or that it has none. */
export function syncWordsOf(status: Pick<GitStatus, "upstream" | "ahead" | "behind">): string {
  if (!status.upstream) return "not pushed";
  if (status.ahead === 0 && status.behind === 0) return "even";
  return [status.ahead > 0 ? `↑${status.ahead}` : "", status.behind > 0 ? `↓${status.behind}` : ""].filter(Boolean).join(" ");
}

/** One line of what changed: "N changed · M new", conflicts and staged when there are any. */
export function countsLine(status: Pick<GitStatus, "files" | "counts">): string {
  if (status.files.length === 0) return "clean";
  const { conflicts, staged, changed, untracked } = status.counts;
  return [
    conflicts ? plural(conflicts, "conflict") : "",
    staged ? `${staged} staged` : "",
    changed ? `${changed} changed` : "",
    untracked ? `${untracked} new` : "",
  ].filter(Boolean).join(" · ");
}

/** The last commit as one phrase: "init · by t · 4m ago". */
export function commitWords(lastCommit: { subject: string; author: string; at: number }, now = Date.now()): string {
  return `${lastCommit.subject} · by ${lastCommit.author} · ${ago(lastCommit.at, now)}`;
}

/** A count with its noun: "1 conflict", "3 conflicts". */
function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`;
}
