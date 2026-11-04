// The project's git status for the composer's git row: read when the chat
// opens, after each run, every few seconds while the agent works, and when
// the window comes back into focus. The direnv state rides along (the same
// reading, no second fetch): the composer's direnv row shows it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatStatus, DirenvState, GitDiffSide, GitFile, GitFileState, GitStatus } from "../shared/protocol.js";
import { api } from "./api.js";

const WORKING_POLL_MS = 8000;

export function useGitStatus(chatId: string | null, status: ChatStatus | null) {
  const [git, setGit] = useState<{ chatId: string; status: GitStatus | null; direnv: DirenvState | null; at: number } | null>(null);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    if (!chatId) return;
    const mine = ++seq.current;
    try {
      const res = await api<{ status: GitStatus | null; direnv?: DirenvState | null }>(`/api/chats/${chatId}/git`);
      if (mine === seq.current) setGit({ chatId, status: res.status, direnv: res.direnv ?? null, at: Date.now() });
    } catch {
      // keep what is shown
    }
  }, [chatId]);

  const working = status === "running" || status === "stopping" || status === "compacting";
  useEffect(() => {
    void refresh();
  }, [refresh, working]);

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => void refresh(), WORKING_POLL_MS);
    return () => window.clearInterval(timer);
  }, [working, refresh]);

  useEffect(() => {
    const onFocus = () => document.visibilityState === "visible" && void refresh();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [refresh]);

  return { git: git && git.chatId === chatId ? git.status : null, direnv: git && git.chatId === chatId ? git.direnv : null, at: git?.at ?? 0, refresh };
}

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
