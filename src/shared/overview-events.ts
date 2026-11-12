// Bounded overview deltas from the lightweight server stream. Only already-known
// rows are patched; additions, project moves, and stale gaps use a full API refresh.
import type { OverviewEvent, ProjectSession, RoomSummary, SessionsOverview } from "./protocol.js";

export function mergeSessionOverview(overview: SessionsOverview, event: OverviewEvent): { overview: SessionsOverview; refresh: boolean } {
  if (event.type === "snapshot") return { overview, refresh: true };
  if (event.type === "room") return { overview, refresh: false };
  // An agent's status line patches its one row and touches nothing else: a chat that
  // has not persisted its session yet is not in the list, and its line waits for a refresh.
  if (event.type === "agent-status") {
    const at = overview.sessions.findIndex((s) => s.id === event.sessionId);
    if (at < 0) return { overview, refresh: false };
    const sessions = overview.sessions.slice();
    const next: ProjectSession = { ...(sessions[at] as ProjectSession) };
    if (event.agentStatus) next.agentStatus = event.agentStatus;
    else delete next.agentStatus;
    sessions[at] = next;
    return { overview: { ...overview, sessions }, refresh: false };
  }
  const at = overview.sessions.findIndex((s) => s.id === `${event.harnessId}:${event.nativeId}`);
  if (at < 0) return { overview, refresh: true };
  const current = overview.sessions[at] as ProjectSession;
  const next: ProjectSession = {
    ...current,
    // A resumed chat has no live title until the harness names it: keep the saved one.
    title: event.title || current.title,
    updatedAt: event.updatedAt,
    ...(event.messageCount !== undefined ? { messageCount: event.messageCount } : {}),
    ...(event.disposed ? { status: "disposed" as const } : { liveChatId: event.liveChatId, status: event.status }),
  };
  // A non-disposal update always includes waiting state, including its absence.
  delete next.asking;
  if (event.asking) next.asking = true;
  if (event.disposed) {
    delete next.liveChatId;
    delete next.asking;
  }
  const sessions = overview.sessions.slice();
  sessions[at] = next;
  return { overview: { ...overview, sessions }, refresh: false };
}

export function mergeRoomOverview(rooms: RoomSummary[], event: OverviewEvent): RoomSummary[] {
  if (event.type !== "room") return rooms;
  const at = rooms.findIndex((room) => room.id === event.room.id);
  if (at < 0) return [...rooms, event.room];
  const next = rooms.slice();
  next[at] = { ...rooms[at], ...event.room };
  return next;
}
