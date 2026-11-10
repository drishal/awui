// The room SSE fan-out, built the way chats/chat.ts builds its own: monotonic
// event ids per room, a bounded replay tail, and a fresh snapshot for a stream
// that is too far behind to replay. The log is in memory by design — records
// are the durable history; this is only what live viewers are owed.
import type { RoomEvent, RoomSnapshot } from "../../shared/protocol.js";
import type { RoomEventLog, RoomSubscriber } from "./types.js";

/** How many events a reconnecting room stream may replay before it gets a snapshot instead. */
const MAX_LOG_EVENTS = 400;
/** Rooms' logs are kept while any viewer or the manager holds them; this only guards a leak. */
const MAX_ROOMS_WITH_LOGS = 200;

interface RoomLog {
  entries: Array<{ id: number; event: RoomEvent }>;
  nextEventId: number;
}

export class RoomEventLogImpl implements RoomEventLog {
  private readonly logs = new Map<string, RoomLog>();
  private readonly subscribers = new Map<string, Set<RoomSubscriber>>();

  /** `onEmit`: told of every room that emitted, viewed or not (the overview's room summaries). */
  constructor(private readonly onEmit?: (roomId: string, event: RoomEvent) => void) {}

  private log(roomId: string): RoomLog {
    let log = this.logs.get(roomId);
    if (!log) {
      // Oldest-first insertion order: a room that has been quiet longest gets dropped first.
      if (this.logs.size >= MAX_ROOMS_WITH_LOGS) {
        const oldest = this.logs.keys().next().value;
        if (oldest !== undefined && oldest !== roomId) this.logs.delete(oldest);
      }
      log = { entries: [], nextEventId: 1 };
      this.logs.set(roomId, log);
    }
    return log;
  }

  emit(roomId: string, event: RoomEvent): void {
    const log = this.log(roomId);
    const id = log.nextEventId++;
    // A snapshot stands for everything before it, exactly as a chat's log does:
    // keep only the newest, so the tail holds at most one copy of the room.
    if (event.type === "snapshot") log.entries = [];
    log.entries.push({ id, event });
    if (log.entries.length > MAX_LOG_EVENTS) log.entries.splice(0, log.entries.length - MAX_LOG_EVENTS);
    for (const subscriber of this.subscribers.get(roomId) ?? []) subscriber.send(id, event);
    this.onEmit?.(roomId, event);
  }

  /** Whether a cursor is still inside the replay window (the manager takes a snapshot only otherwise). */
  canReplay(roomId: string, lastEventId: number | undefined): boolean {
    const log = this.logs.get(roomId);
    const oldest = log?.entries[0]?.id ?? log?.nextEventId ?? 1;
    const newest = (log?.nextEventId ?? 1) - 1;
    return lastEventId !== undefined && lastEventId >= oldest - 1 && lastEventId <= newest;
  }

  subscribe(roomId: string, subscriber: RoomSubscriber, lastEventId: number | undefined, snapshot: () => RoomSnapshot): () => void {
    const log = this.log(roomId);
    const oldest = log.entries[0]?.id ?? log.nextEventId;
    const canReplay = lastEventId !== undefined && lastEventId >= oldest - 1 && lastEventId <= log.nextEventId - 1;
    if (canReplay) {
      for (const entry of log.entries) if (entry.id > lastEventId) subscriber.send(entry.id, entry.event);
    } else {
      const fresh = snapshot();
      subscriber.send(fresh.lastEventId, { type: "snapshot", snapshot: fresh });
    }
    let set = this.subscribers.get(roomId);
    if (!set) {
      set = new Set();
      this.subscribers.set(roomId, set);
    }
    set.add(subscriber);
    return () => set?.delete(subscriber);
  }

  /**
   * A stream that was too far behind: send the snapshot the manager took, then
   * replay whatever was logged after it, so nothing in the gap is lost and the
   * ids stay monotonic.
   */
  subscribeWithSnapshot(roomId: string, subscriber: RoomSubscriber, snapshot: RoomSnapshot): () => void {
    const log = this.log(roomId);
    subscriber.send(snapshot.lastEventId, { type: "snapshot", snapshot });
    for (const entry of log.entries) if (entry.id > snapshot.lastEventId) subscriber.send(entry.id, entry.event);
    let set = this.subscribers.get(roomId);
    if (!set) {
      set = new Set();
      this.subscribers.set(roomId, set);
    }
    set.add(subscriber);
    return () => set?.delete(subscriber);
  }

  lastEventId(roomId: string): number {
    return (this.logs.get(roomId)?.nextEventId ?? 1) - 1;
  }

  /** The room is gone from view: nothing else will be emitted for it. */
  closeRoom(roomId: string): void {
    for (const subscriber of this.subscribers.get(roomId) ?? []) subscriber.close();
    this.subscribers.delete(roomId);
    this.logs.delete(roomId);
  }

  /** The current viewer count, for the manager's summaries (not part of the wire). */
  viewerCount(roomId: string): number {
    return this.subscribers.get(roomId)?.size ?? 0;
  }
}
