// The git panel's words and grouping, shared by the web composer's panel and
// both terminal clients: the letter a file's state shows, the four groups a
// status splits into (a file with staged and unstaged changes is under both),
// and the name of an operation under way. Pure, so every client words and
// sorts a status alike; the web's status polling stays in web/git.ts.
import type { GitDiffSide, GitFile, GitFileState, GitStatus } from "./protocol.js";

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
