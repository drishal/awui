// Lightweight live status for tabs and the sidebar: no transcripts, room records,
// or harness credentials cross this channel. The replay tail is in memory;
// stale clients refresh the ordinary session and room lists, not a second transcript.
import type { Chat } from "./chats/chat.js";
import type { AgentStatusLine, OverviewEvent, RoomSummary, SessionsOverview } from "../shared/protocol.js";

type Listener = { send(id: number, event: OverviewEvent): void; close(): void };

export function sessionEvent(overview: SessionsOverview, nativeId: string, harnessId: string): OverviewEvent | null {
  const saved = overview.sessions.find((s) => s.id === `${harnessId}:${nativeId}`);
  if (!saved || saved.harnessId !== harnessId) return null;
  return { type: "session", nativeId, harnessId: saved.harnessId, workspaceId: saved.workspaceId, title: saved.title, updatedAt: saved.updatedAt, messageCount: saved.messageCount, liveChatId: saved.liveChatId, status: saved.status, asking: saved.asking, ...(saved.status === "disposed" ? { disposed: true as const } : {}) };
}

class OverviewLog {
  private entries: Array<{ id: number; event: OverviewEvent }> = [];
  private nextId = 1;
  private listeners = new Set<Listener>();

  emit(event: OverviewEvent): void {
    const id = this.nextId++;
    this.entries.push({ id, event });
    if (this.entries.length > 500) this.entries.splice(0, this.entries.length - 500);
    for (const listener of this.listeners) listener.send(id, event);
  }

  /** Replay means no snapshot needed. Otherwise the client reloads once from this cursor. */
  subscribe(listener: Listener, lastEventId: number | undefined): () => void {
    const oldest = this.entries[0]?.id ?? this.nextId;
    const replay = lastEventId !== undefined && lastEventId >= oldest - 1 && lastEventId <= this.nextId - 1;
    if (!replay) listener.send(this.nextId - 1, { type: "snapshot" });
    if (lastEventId !== undefined) for (const entry of this.entries) if (entry.id > lastEventId) listener.send(entry.id, entry.event);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    for (const listener of this.listeners) listener.close();
    this.listeners.clear();
  }
}

const log = new OverviewLog();
const roomListeners = new Map<string, string>();
const notes = new WeakMap<object, string>();

/** Publishes only summaries; preserving no chat/room data after user closure is important. */
export const overviewEvents = { subscribe: log.subscribe.bind(log), close: log.close.bind(log) };

export function noteChat(chat: Chat): void {
  if (chat.owner || chat.side) return;
  const nativeId = chat.sessionId;
  if (!nativeId) return;
  notes.set(chat, nativeId);
  emitChat(chat, false);
}

export function noteSessionOfChat(chat: Chat): void {
  if (chat.owner || chat.side || !chat.sessionId) return;
  notes.set(chat, chat.sessionId);
  emitChat(chat, false);
}

export function noteChatDisposed(chat: Chat): void {
  if (chat.owner || chat.side) return;
  const nativeId = notes.get(chat) ?? chat.sessionId;
  if (!nativeId) return;
  const harnessId = chat.harnessId;
  const workspaceId = chat.workspace.id;
  overviewEventsNote({ type: "session", nativeId, harnessId, workspaceId, title: chat.title, updatedAt: new Date(chat.talkedAt ?? chat.lastActivity).toISOString(), status: "disposed", disposed: true as const });
}

function emitChat(chat: Chat, disposed: boolean): void {
  const nativeId = chat.sessionId;
  if (!nativeId) return;
  overviewEventsNote({ type: "session", nativeId, harnessId: chat.harnessId, workspaceId: chat.workspace.id, title: chat.title, updatedAt: new Date(chat.talkedAt ?? chat.lastActivity).toISOString(), liveChatId: chat.chatId, status: chat.status, ...(chat.pendingCount > 0 ? { asking: true as const } : {}), ...(disposed ? { disposed: true as const } : {}) });
}

function overviewEventsNote(event: OverviewEvent): void {
  if (event.type !== "room" && event.type !== "session") return;
  // Normalized content prohibits user transcript, only metadata (Server Summary objects copied).
  log.emit(event);
}

/** One session's agent-set status line: metadata only, so the sidebar and the chat header keep up. */
export function noteAgentStatus(sessionId: string, agentStatus: AgentStatusLine | null): void {
  log.emit({ type: "agent-status", sessionId, agentStatus });
}

/** Room emit is content-deduplicated because replay/snapshot clients observe same event. */
export function noteRoom(room: RoomSummary): void {
  const encoded = JSON.stringify(room);
  if (roomListeners.get(room.id) === encoded) return;
  roomListeners.set(room.id, encoded);
  if (roomListeners.size > 500) roomListeners.delete(roomListeners.keys().next().value as string);
  log.emit({ type: "room", room: { ...room } });
}
