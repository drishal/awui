// "Copy resume command": the line that resumes a session in its harness's own
// CLI from a terminal (`cd <project> && claude --resume <id>`). The server
// makes it, since session ids are opaque here and only the adapter knows its
// CLI. A menu asks for it as it opens, so the click can copy at once: a page
// may write the clipboard only inside the click, and a fetch in between can
// lose it. Where there is no clipboard (a plain-HTTP LAN page) the line is
// still shown, to copy by hand.
import { useEffect, useState } from "react";
import type { HandoverReclaim, ResumeCommand } from "../shared/protocol.js";
import { api, errorText } from "./api.js";

export interface SessionRef {
  harnessId: string;
  sessionId: string;
  workspaceId: string;
}

/** The session's resume command while `ref` is set (its menu is open): the line, or why there is none; both null while it loads. */
export function useResumeCommand(ref: SessionRef | null): { resume: ResumeCommand | null; why: string | null } {
  const [state, setState] = useState<{ resume: ResumeCommand | null; why: string | null }>({ resume: null, why: null });
  const key = ref ? `${ref.harnessId}\n${ref.sessionId}\n${ref.workspaceId}` : null;
  useEffect(() => {
    setState({ resume: null, why: null });
    if (!ref) return;
    let current = true;
    api<ResumeCommand>(`/api/sessions/resume-command?${new URLSearchParams({ ...ref })}`).then(
      (resume) => current && setState({ resume, why: null }),
      (error: unknown) => current && setState({ resume: null, why: errorText(error) }),
    );
    return () => {
      current = false;
    };
    // The key stands for the ref, which is a new object each render.
  }, [key]);
  return state;
}

/** Copy the line (call it from the click), and say what happened: the line itself, and to close the chat here first when awui has it open. */
export async function copyResumeCommand(resume: ResumeCommand): Promise<string> {
  const copied = await (navigator.clipboard?.writeText(resume.command).then(
    () => true,
    () => false,
  ) ?? Promise.resolve(false));
  const said = copied ? `Copied: ${resume.command}` : `To resume it in a terminal, run: ${resume.command}`;
  return resume.live ? `${said} — close the chat here first, so only one process writes the session.` : said;
}

/** Reclaiming a handed-off session: the lock goes, and the client learns the line the handover held. */
export async function reclaimHandover(ref: SessionRef): Promise<HandoverReclaim> {
  return api<HandoverReclaim>("/api/sessions/reclaim", { body: { ...ref } });
}
