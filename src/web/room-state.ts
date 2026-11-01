// The client-side fold of a room's event stream: the same snapshot/replay
// contract as chat-state.ts, over Board's records. A room's transcript is
// id-keyed and ordered by `seq`, so a reconnect, a settled bot run, and an
// older-history page all reconcile without duplicating anything.
import type { BoardUsage, ChatItem, RoomBudgets, RoomEvent, RoomInfo, RoomPendingRequest, RoomRecord, RoomSnapshot, RoomTurnState, RoomTurnView } from "../shared/protocol.js";
import {
  BOARD_HISTORY_PAGE,
  BOARD_MAX_CONSULT_REQUESTS,
  BOARD_MAX_DIRECT_RESPONDERS,
  BOARD_MAX_INVOCATIONS,
  BOARD_MAX_INVOCATIONS_PER_MEMBER,
  BOARD_QUEUE_MAX,
  BOARD_TURN_WALL_CLOCK_MS,
} from "../shared/protocol.js";

export interface RoomState {
  roomId: string;
  room: RoomInfo;
  /** Oldest first, ordered by `seq`, at most one snapshot page plus what history added. */
  records: RoomRecord[];
  /** A snapshot filled a whole page, so older records may exist behind it. */
  hasOlder: boolean;
  /** Still displayed while it runs or waits; a settled turn is in the transcript. */
  activeTurn: RoomTurnView | null;
  /**
   * Live items of invocations that have no record yet, by invocation id. The
   * server opens a run's record at settle, so an invocation's own item/delta
   * events arrive nameless (invocationId only) — this keeps them until the
   * record that owns them lands, and a snapshot clears the map.
   */
  live: Record<string, ChatItem[]>;
  queued: RoomTurnView[];
  pending: RoomPendingRequest[];
  usage: BoardUsage;
  lastEventId: number;
  /** Why the room stopped streaming for good (archived, deleted, or disposed). */
  gone: string | null;
}

const LIVE_TURN_STATES: Partial<Record<RoomTurnState, true>> = { queued: true, running: true, waiting_for_user: true, stopping: true };

/** Whether a turn is still going (so Stop and the queue line make sense). Not a type guard: every turn is a RoomTurnView. */
export function isLiveTurn(turn: RoomTurnView | null): boolean {
  return turn !== null && LIVE_TURN_STATES[turn.state] === true;
}

/** The caps a room starts with (the plan's defaults), for a server that does not report them. */
export const DEFAULT_BUDGETS: RoomBudgets = {
  maxDirectResponders: BOARD_MAX_DIRECT_RESPONDERS,
  maxConsultRequests: BOARD_MAX_CONSULT_REQUESTS,
  maxInvocations: BOARD_MAX_INVOCATIONS,
  maxInvocationsPerMember: BOARD_MAX_INVOCATIONS_PER_MEMBER,
  turnWallClockMs: BOARD_TURN_WALL_CLOCK_MS,
  queueMax: BOARD_QUEUE_MAX,
};

/**
 * A room's caps with the defaults filling any field an older server omits, so
 * a rolling deploy (new web, old server) still draws and enforces something
 * sensible instead of reading `undefined`.
 */
export function budgetsOf(room: RoomInfo): RoomBudgets {
  return { ...DEFAULT_BUDGETS, ...(room.budgets ?? {}) };
}

export function roomStateFromSnapshot(snapshot: RoomSnapshot, roomId: string): RoomState {
  return {
    roomId,
    room: snapshot.room,
    records: [...snapshot.records],
    hasOlder: snapshot.records.length >= BOARD_HISTORY_PAGE,
    activeTurn: snapshot.activeTurn,
    live: {},
    queued: snapshot.queued,
    pending: snapshot.pending,
    usage: snapshot.usage,
    lastEventId: snapshot.lastEventId,
    gone: null,
  };
}

/** Where a record belongs: ascending `seq`, and a record already present is replaced where it is. */
function withRecord(records: RoomRecord[], record: RoomRecord): RoomRecord[] {
  const at = records.findIndex((r) => r.id === record.id);
  if (at >= 0) {
    const copy = records.slice();
    copy[at] = record;
    return copy;
  }
  const next = records.slice();
  let i = next.length;
  while (i > 0 && (next[i - 1] as RoomRecord).seq > record.seq) i -= 1;
  next.splice(i, 0, record);
  return next;
}

/** Whether this invocation already has a record that is not running: its late frames are stale. */
function settledRun(records: RoomRecord[], invocationId: string): boolean {
  return records.some((r) => r.kind === "bot_run" && r.invocationId === invocationId && r.status !== "running");
}

/** The bot run an invocation's items and deltas belong to; null once the run settled or is absent. */
function liveRun(records: RoomRecord[], invocationId: string): Extract<RoomRecord, { kind: "bot_run" }> | null {
  for (let i = records.length - 1; i >= 0; i -= 1) {
    const record = records[i] as RoomRecord;
    if (record.kind === "bot_run" && record.invocationId === invocationId) return record.status === "running" ? record : null;
  }
  return null;
}

function replaceItems(records: RoomRecord[], invocationId: string, update: (items: ChatItem[]) => ChatItem[]): RoomRecord[] {
  const run = liveRun(records, invocationId);
  if (!run) return records;
  const at = records.indexOf(run);
  const copy = records.slice();
  copy[at] = { ...run, items: update(run.items) };
  return copy;
}

function appendToItem(items: ChatItem[], targetId: string, field: "text" | "thinking" | "output", append: string): ChatItem[] {
  let touched = false;
  const next = items.map((item) => {
    if (item.id !== targetId) return item;
    if (field === "output") {
      if (item.kind !== "tool") return item;
      touched = true;
      return { ...item, output: item.output + append };
    }
    if (item.kind !== "assistant") return item;
    touched = true;
    return field === "text" ? { ...item, text: item.text + append } : { ...item, thinking: item.thinking + append };
  });
  // A delta that arrives before its item cannot invent one: deltas are never persisted, and the item event (or the next snapshot) carries the whole content.
  return touched ? next : items;
}

function applyOne(state: RoomState, event: RoomEvent): RoomState {
  switch (event.type) {
    case "record": {
      let record = event.record;
      const pending = record.kind === "bot_run" ? state.live[record.invocationId] : undefined;
      // Items streamed before the run's opening record arrived belong to it;
      // the opening record's own items (empty, or a settle's complete list) win.
      if (record.kind === "bot_run" && record.status === "running" && pending && pending.length > 0) {
        let items = pending;
        for (const item of record.items) items = withItem(items, item);
        record = { ...record, items };
      }
      const live = { ...state.live };
      if (record.kind === "bot_run") delete live[record.invocationId];
      return { ...state, records: withRecord(state.records, record), live };
    }
    case "item":
      // A running record (when the server emits one) owns its items; otherwise they wait for the settle.
      if (liveRun(state.records, event.invocationId)) {
        return { ...state, records: replaceItems(state.records, event.invocationId, (items) => withItem(items, event.item)) };
      }
      if (settledRun(state.records, event.invocationId)) return state;
      return { ...state, live: { ...state.live, [event.invocationId]: withItem(state.live[event.invocationId] ?? [], event.item) } };
    case "delta": {
      if (liveRun(state.records, event.invocationId)) {
        return { ...state, records: replaceItems(state.records, event.invocationId, (items) => appendToItem(items, event.itemId, event.field, event.append)) };
      }
      const items = state.live[event.invocationId];
      if (!items || settledRun(state.records, event.invocationId)) return state;
      return { ...state, live: { ...state.live, [event.invocationId]: appendToItem(items, event.itemId, event.field, event.append) } };
    }
    case "turn": {
      const rest = state.queued.filter((q) => q.id !== event.turn.id);
      // A terminal turn means every run it opened has settled: a record still
      // marked running (a stop that timed out, a missed settle) stops spinning.
      return {
        ...state,
        activeTurn: isLiveTurn(event.turn) ? event.turn : null,
        queued: rest,
        records: isLiveTurn(event.turn) ? state.records : settleRunning(state.records, event.turn.id, event.turn.state === "failed" ? "failed" : "stopped"),
      };
    }
    case "queue":
      return { ...state, queued: event.queued };
    case "request":
      return state.pending.some((p) => p.id === event.request.id) ? state : { ...state, pending: [...state.pending, event.request] };
    case "request_resolved":
      return { ...state, pending: state.pending.filter((p) => p.id !== event.requestId) };
    case "usage":
      return { ...state, usage: event.usage };
    case "room":
      return { ...state, room: event.room };
    case "disposed":
      return { ...state, gone: event.reason };
    default:
      return state;
  }
}

function settleRunning(records: RoomRecord[], turnId: string, status: "stopped" | "failed"): RoomRecord[] {
  let changed = false;
  const next = records.map((record) => {
    if (record.kind !== "bot_run" || record.turnId !== turnId || record.status !== "running") return record;
    changed = true;
    return { ...record, status };
  });
  return changed ? next : records;
}

function withItem(items: ChatItem[], item: ChatItem): ChatItem[] {
  const at = items.findIndex((i) => i.id === item.id);
  if (at < 0) return [...items, item];
  const copy = items.slice();
  copy[at] = item;
  return copy;
}

/** Snapshot replaces (a reconnect's page is the truth); a snapshot before any state seeds it. */
export function applyEvents(state: RoomState | null, events: RoomEvent[]): RoomState | null {
  let next = state;
  for (const event of events) {
    if (event.type === "snapshot") {
      next = roomStateFromSnapshot(event.snapshot, event.snapshot.room.id);
      continue;
    }
    if (next) next = applyOne(next, event);
  }
  return next;
}

/**
 * A room's snapshot carries only its newest page. Loading older history
 * prepends it; `exhausted` says the server returned nothing more.
 */
export function prependRecords(state: RoomState, older: RoomRecord[]): RoomState {
  let records = state.records;
  for (const record of older) records = withRecord(records, record);
  return { ...state, records, hasOlder: older.length >= BOARD_HISTORY_PAGE };
}

/** The oldest record's seq, for the history route's `before` cursor. */
export function oldestSeq(state: RoomState): number | null {
  return state.records[0]?.seq ?? null;
}

/** The invocations streaming without a record yet, oldest first. */
export function liveInvocations(state: RoomState): Array<{ invocationId: string; items: ChatItem[] }> {
  return Object.entries(state.live).map(([invocationId, items]) => ({ invocationId, items }));
}

/** A member by id, for attribution in the transcript. */
export function findMember(room: RoomInfo | null, memberId: string) {
  return room?.members.find((m) => m.id === memberId) ?? null;
}
