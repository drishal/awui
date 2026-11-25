// What a notice says about its chat. A title alone ("“ask please” needs you") stops saying which chat once two
// sessions share it: round 7 found three chats named "ask please", and a card for one of them floated over the
// approval card being answered for another. A shared title carries its project and its age — the two facts the
// sidebar tells the same chats apart by — before the verb. Pure, so the wording is tested without a browser.
import type { ProjectSession, WorkspaceInfo } from "../shared/protocol.js";
import { shortAgo } from "./turns.js";

/**
 * `“tidy the dock” finished` for a title nothing else shares, else `“ask please” · demo, 7m — needs you`, where
 * a project or an age the session does not know is left out rather than shown as an empty part.
 */
export function noticeText(
  session: ProjectSession,
  verb: string,
  sessions: readonly ProjectSession[],
  workspaces: readonly WorkspaceInfo[],
  now = Date.now(),
): string {
  const title = `“${session.title}”`;
  if (!sessions.some((other) => other.id !== session.id && other.title === session.title)) return `${title} ${verb}`;
  const project = workspaces.find((w) => w.id === session.workspaceId)?.name ?? "";
  const at = session.updatedAt ? new Date(session.updatedAt).getTime() : Number.NaN;
  const parts = [project, Number.isNaN(at) ? "" : shortAgo(at, now)].filter((part) => part !== "");
  return parts.length > 0 ? `${title} · ${parts.join(", ")} — ${verb}` : `${title} ${verb}`;
}
