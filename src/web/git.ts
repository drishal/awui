// The project's git status for the composer's git row: read when the chat
// opens, after each run, every few seconds while the agent works, and when
// the window comes back into focus. The direnv state rides along (the same
// reading, no second fetch): the composer's direnv row shows it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatStatus, DirenvState, GitStatus } from "../shared/protocol.js";
import { api } from "./api.js";

const WORKING_POLL_MS = 8000;
/** How many projects' last readings are kept: a tab visits a handful, and one status is a branch and its files. */
const KEPT_PROJECTS = 20;

/** One reading of a project's git state, as the row draws it. */
interface GitReading {
  status: GitStatus | null;
  direnv: DirenvState | null;
  at: number;
}

/**
 * The last reading of each project, kept outside the hook because the composer mounts again on every chat switch
 * (its key is the chat). A git status belongs to the project, not the chat: without a reading to draw, the dock
 * waits a round trip on each switch, so its branch lane arrived a frame after the transcript and pushed the
 * composer up when it landed. A different project never borrows one.
 */
const lastByProject = new Map<string, GitReading>();

/** Keep this project's reading, newest last, and forget the one read longest ago once a tab has too many. */
function rememberReading(project: string, reading: GitReading): void {
  lastByProject.delete(project);
  lastByProject.set(project, reading);
  // Map keeps insertion order, and one entry is added at a time, so dropping the first is the cap.
  const oldest = lastByProject.keys().next();
  if (lastByProject.size > KEPT_PROJECTS && !oldest.done) lastByProject.delete(oldest.value);
}

export function useGitStatus(chatId: string | null, status: ChatStatus | null, project?: string | null) {
  const [git, setGit] = useState<{ chatId: string; status: GitStatus | null; direnv: DirenvState | null; at: number } | null>(null);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    if (!chatId) return;
    const mine = ++seq.current;
    try {
      const res = await api<{ status: GitStatus | null; direnv?: DirenvState | null }>(`/api/chats/${chatId}/git`);
      if (mine === seq.current) {
        const reading: GitReading = { status: res.status, direnv: res.direnv ?? null, at: Date.now() };
        setGit({ chatId, ...reading });
        if (project) rememberReading(project, reading);
      }
    } catch {
      // keep what is shown
    }
  }, [chatId, project]);

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

  // This chat's own reading, else the project's last one (a switch shows the dock whole, not a lane late).
  const mine = git && git.chatId === chatId ? git : null;
  const shown = mine ?? (project ? lastByProject.get(project) : null) ?? null;
  return { git: shown?.status ?? null, direnv: shown?.direnv ?? null, at: shown?.at ?? 0, refresh };
}

// The git panel's words and grouping moved to shared/git-words.ts, so the web
// panel and both terminal clients word and sort a status alike; the web only
// adds the status's polling.
export {
  GROUP_LABEL,
  OPERATION_LABEL,
  groupFiles,
  stateLetter,
  type GitGroup,
  type GroupedFile,
} from "../shared/git-words.js";
