// The project's git status for the composer's git row: read when the chat
// opens, after each run, every few seconds while the agent works, and when
// the window comes back into focus. The direnv state rides along (the same
// reading, no second fetch): the composer's direnv row shows it.
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChatStatus, DirenvState, GitStatus } from "../shared/protocol.js";
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
