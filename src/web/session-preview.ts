// One session's hover-card preview, fetched once per version of the session and kept
// for the page's life: the sidebar's card and the agent dashboard's cards share it, so
// opening the board does not read the same transcripts the sidebar just read. The read
// is the server's own bounded one (a live chat's state, else the harness's file, never
// starting the harness); a failure is remembered as "no preview" for the same version.
import type { ProjectSession, SessionPreview } from "../shared/protocol.js";
import { api } from "./api.js";

/** How many versions are remembered before the oldest goes. */
const CACHE_LIMIT = 200;

const cache = new Map<string, Promise<SessionPreview | null>>();

export function sessionPreview(s: ProjectSession): Promise<SessionPreview | null> {
  const key = `${s.id}@${s.updatedAt ?? ""}`;
  let hit = cache.get(key);
  if (!hit) {
    const q = new URLSearchParams({ harnessId: s.harnessId, workspaceId: s.workspaceId, sessionId: s.id });
    hit = api<SessionPreview>(`/api/sessions/preview?${q}`).catch(() => null);
    cache.set(key, hit);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value as string);
  }
  return hit;
}

export { previewLine } from "./preview-line.js";
