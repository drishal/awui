import { describe, expect, it } from "vitest";
import type { ChatItem, RoomEvent, RoomInfo, RoomMemberView, RoomRecord, RoomSnapshot, RoomTurnView } from "../../src/shared/protocol.js";
import { BOARD_HISTORY_PAGE } from "../../src/shared/protocol.js";
import { applyEvents, budgetsOf, DEFAULT_BUDGETS, findMember, isLiveTurn, liveInvocations, oldestSeq, prependRecords } from "../../src/web/room-state.js";

const member = (id: string, extra: Partial<RoomMemberView> = {}): RoomMemberView => ({
  id,
  botId: `bot-${id}`,
  name: id.toUpperCase(),
  handle: id,
  rank: 0,
  canLead: true,
  consultable: true,
  consultants: [],
  enabled: true,
  accent: null,
  harnessId: "pi",
  model: null,
  thinkingLevel: null,
  role: "",
  permissionMode: null,
  ...extra,
});

const room = (extra: Partial<RoomInfo> = {}): RoomInfo => ({
  id: "r1",
  name: "Stocks",
  topic: null,
  workspaceId: "w1",
  workspaceName: "project",
  archived: false,
  leadMemberId: "a",
  members: [member("a"), member("b", { rank: 1, canLead: false })],
  budgets: { maxDirectResponders: 4, maxConsultRequests: 4, maxInvocations: 8, maxInvocationsPerMember: 3, turnWallClockMs: 180_000, queueMax: 20 },
  ...extra,
});

const userRecord = (id = "u1", seq = 1): RoomRecord => ({ kind: "user", id, seq, at: 1, turnId: "t1", text: "hello", mentions: [] });

const run = (over: Partial<Extract<RoomRecord, { kind: "bot_run" }>> = {}): Extract<RoomRecord, { kind: "bot_run" }> => ({
  kind: "bot_run",
  id: "run1",
  seq: 2,
  at: 2,
  turnId: "t1",
  memberId: "a",
  invocationId: "inv1",
  status: "running",
  model: null,
  items: [],
  usage: null,
  latencyMs: null,
  ...over,
});

const assistant = (id: string, text = ""): ChatItem => ({ kind: "assistant", id, text, thinking: "", streaming: true });

const snapshot = (over: Partial<RoomSnapshot> = {}): RoomSnapshot => ({
  room: room(),
  records: [],
  activeTurn: null,
  queued: [],
  pending: [],
  usage: { turns: 0, steps: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: null, unpriced: 0 },
  lastEventId: 10,
  ...over,
});

const seed = (over: Partial<RoomSnapshot> = {}) => applyEvents(null, [{ type: "snapshot", snapshot: snapshot(over) }]);

const fold = (state: ReturnType<typeof seed>, events: RoomEvent[]) => applyEvents(state, events);

describe("budgets", () => {
  it("reads the room's caps as the server reports them", () => {
    const caps = budgetsOf(room({ budgets: { maxDirectResponders: 2, maxConsultRequests: 1, maxInvocations: 5, maxInvocationsPerMember: 2, turnWallClockMs: 60_000, queueMax: 5 } }));
    expect(caps.maxDirectResponders).toBe(2);
    expect(caps.queueMax).toBe(5);
  });

  it("fills the plan's defaults when an older server omits them (rolling deploy)", () => {
    // An old server's payload has no budgets at all, whatever the type says.
    const old = { ...room(), budgets: undefined } as unknown as RoomInfo;
    expect(budgetsOf(old)).toEqual(DEFAULT_BUDGETS);
    expect(budgetsOf(room())).toEqual(room().budgets);
  });
});

describe("snapshot and reconnect", () => {
  it("seeds state from the first snapshot and takes the room id from it", () => {
    const state = seed({ records: [userRecord()] });
    expect(state).toMatchObject({ roomId: "r1", lastEventId: 10, gone: null });
    expect(state?.records.map((r) => r.id)).toEqual(["u1"]);
  });

  it("replaces everything on a reconnecting snapshot", () => {
    const first = seed({ records: [userRecord()] });
    const replayed = fold(first, [{ type: "snapshot", snapshot: snapshot({ records: [userRecord("u2", 3)], lastEventId: 20 }) }]);
    expect(replayed?.records.map((r) => r.id)).toEqual(["u2"]);
    expect(replayed?.lastEventId).toBe(20);
  });

  it("ignores events before any state (a stream that has not snapshotted yet)", () => {
    expect(applyEvents(null, [{ type: "usage", usage: { turns: 1, steps: 0, input: 1, cachedInput: 0, cacheWrite: 0, output: 1, cost: null, unpriced: 0 } }])).toBeNull();
  });

  it("says a full snapshot page may have older records behind it", () => {
    const full = Array.from({ length: BOARD_HISTORY_PAGE }, (_, i) => userRecord(`u${i}`, i + 1));
    expect(seed({ records: full })?.hasOlder).toBe(true);
    expect(seed({ records: [userRecord()] })?.hasOlder).toBe(false);
  });
});

describe("records", () => {
  it("upserts by id, so a running run settles in place", () => {
    const state = fold(seed({ records: [userRecord()] }), [{ type: "record", record: run() }]);
    const settled = fold(state, [{ type: "record", record: run({ status: "done" }) }]);
    expect(settled?.records).toHaveLength(2);
    expect(settled?.records[1]).toMatchObject({ id: "run1", status: "done" });
  });

  it("inserts by seq, not arrival order", () => {
    const state = fold(seed({ records: [userRecord("u1", 5)] }), [{ type: "record", record: userRecord("u2", 3) }]);
    expect(state?.records.map((r) => r.id)).toEqual(["u2", "u1"]);
    expect(state === null ? null : oldestSeq(state)).toBe(3);
  });
});

describe("items and deltas without a record yet", () => {
  it("keeps an invocation's items and deltas until its record lands", () => {
    let state = fold(seed(), [{ type: "item", invocationId: "inv9", item: assistant("inv9:i1", "a") }]);
    state = fold(state, [{ type: "delta", invocationId: "inv9", itemId: "inv9:i1", field: "text", append: "b" }]);
    expect(liveInvocations(state as NonNullable<typeof state>)).toEqual([{ invocationId: "inv9", items: [assistant("inv9:i1", "ab")] }]);
    state = fold(state, [{ type: "record", record: run({ id: "inv9:run", invocationId: "inv9", items: [assistant("inv9:i1", "ab")] }) }]);
    expect(liveInvocations(state as NonNullable<typeof state>)).toEqual([]);
    const rec = state?.records.find((r) => r.kind === "bot_run") as Extract<RoomRecord, { kind: "bot_run" }>;
    expect(rec.items[0]).toMatchObject({ text: "ab" });
  });

  it("moves items collected before the opening record into that record", () => {
    let state = fold(seed(), [{ type: "item", invocationId: "inv9", item: assistant("inv9:i1", "early") }]);
    state = fold(state, [{ type: "record", record: run({ id: "inv9", invocationId: "inv9", status: "running" }) }]);
    expect(liveInvocations(state as NonNullable<typeof state>)).toEqual([]);
    expect((state?.records[0] as Extract<RoomRecord, { kind: "bot_run" }>).items[0]).toMatchObject({ text: "early" });
    state = fold(state, [{ type: "delta", invocationId: "inv9", itemId: "inv9:i1", field: "text", append: "!" }]);
    expect((state?.records[0] as Extract<RoomRecord, { kind: "bot_run" }>).items[0]).toMatchObject({ text: "early!" });
  });

  it("ignores a live delta whose item has not arrived", () => {
    const state = fold(seed(), [{ type: "delta", invocationId: "inv9", itemId: "inv9:i1", field: "text", append: "ghost" }]);
    expect(liveInvocations(state as NonNullable<typeof state>)).toEqual([]);
  });

  it("ignores late frames for an invocation that already settled", () => {
    const settled = fold(seed({ records: [run({ status: "stopped", items: [assistant("i1", "a")] })] }), [{ type: "item", invocationId: "inv1", item: assistant("i1", "late") }]);
    expect(liveInvocations(settled as NonNullable<typeof settled>)).toEqual([]);
    expect((settled?.records[0] as Extract<RoomRecord, { kind: "bot_run" }>).items[0]).toMatchObject({ text: "a" });
  });

  it("drops live output when a snapshot replaces the page", () => {
    const live = fold(seed(), [{ type: "item", invocationId: "inv9", item: assistant("inv9:i1", "a") }]);
    const fresh = fold(live, [{ type: "snapshot", snapshot: snapshot({ lastEventId: 30 }) }]);
    expect(liveInvocations(fresh as NonNullable<typeof fresh>)).toEqual([]);
  });
});

describe("items and deltas", () => {
  it("upserts an item inside the run that owns the invocation", () => {
    const state = fold(seed({ records: [run()] }), [{ type: "item", invocationId: "inv1", item: assistant("i1", "a") }]);
    const rec = state?.records[0] as Extract<RoomRecord, { kind: "bot_run" }>;
    expect(rec.items.map((i) => i.id)).toEqual(["i1"]);
    expect(rec.items[0]).toMatchObject({ text: "a" });
  });

  it("appends deltas to the named field of the named item", () => {
    let state = fold(seed({ records: [run()] }), [{ type: "item", invocationId: "inv1", item: assistant("i1", "a") }]);
    state = fold(state, [{ type: "delta", invocationId: "inv1", itemId: "i1", field: "text", append: "b" }]);
    state = fold(state, [{ type: "delta", invocationId: "inv1", itemId: "i1", field: "thinking", append: "t" }]);
    const rec = state?.records[0] as Extract<RoomRecord, { kind: "bot_run" }>;
    expect(rec.items[0]).toMatchObject({ text: "ab", thinking: "t" });
  });

  it("appends tool output only to a tool item", () => {
    const tool: ChatItem = { kind: "tool", id: "c1", name: "bash", args: "", status: "running", output: "", truncated: false, category: "command", summary: "", paths: [] };
    let state = fold(seed({ records: [run()] }), [{ type: "item", invocationId: "inv1", item: tool }]);
    state = fold(state, [{ type: "delta", invocationId: "inv1", itemId: "c1", field: "output", append: "x" }]);
    state = fold(state, [{ type: "delta", invocationId: "inv1", itemId: "c1", field: "text", append: "ignored" }]);
    const rec = state?.records[0] as Extract<RoomRecord, { kind: "bot_run" }>;
    expect(rec.items[0]).toMatchObject({ output: "x" });
  });

  it("never invents an item for a delta that arrives first", () => {
    const state = fold(seed({ records: [run()] }), [{ type: "delta", invocationId: "inv1", itemId: "i1", field: "text", append: "ghost" }]);
    expect((state?.records[0] as Extract<RoomRecord, { kind: "bot_run" }>).items).toEqual([]);
  });

  it("drops late deltas after the run settled (Stop's trailing frames)", () => {
    let state = fold(seed({ records: [run()] }), [{ type: "item", invocationId: "inv1", item: assistant("i1", "a") }]);
    // A settled record carries the run's items, as the server persists them.
    state = fold(state, [{ type: "record", record: run({ status: "stopped", items: [assistant("i1", "a")] }) }]);
    state = fold(state, [{ type: "delta", invocationId: "inv1", itemId: "i1", field: "text", append: "late" }]);
    expect((state?.records[0] as Extract<RoomRecord, { kind: "bot_run" }>).items[0]).toMatchObject({ text: "a" });
  });

  it("leaves other invocations alone", () => {
    const state = fold(seed({ records: [run()] }), [{ type: "item", invocationId: "inv-other", item: assistant("i1") }]);
    expect((state?.records[0] as Extract<RoomRecord, { kind: "bot_run" }>).items).toEqual([]);
  });
});

describe("turns, queue, requests, usage", () => {
  const turn = (over: Partial<RoomTurnView> = {}) => ({
    id: "t1",
    state: "running" as const,
    text: "hi",
    mentions: [],
    directMemberIds: ["a"],
    queuedAt: 1,
    startedAt: 2,
    endedAt: null,
    invocationCount: 0,
    consultCount: 0,
    ...over,
  });

  it("shows a live turn and clears it once it settles", () => {
    const live = fold(seed(), [{ type: "turn", turn: turn() }]);
    expect(isLiveTurn(live?.activeTurn ?? null)).toBe(true);
    const done = fold(live, [{ type: "turn", turn: turn({ state: "done", endedAt: 5 }) }]);
    expect(done?.activeTurn).toBeNull();
  });

  it("removes a turn from the queue when it starts", () => {
    const queued = fold(seed(), [{ type: "queue", queued: [turn({ state: "queued" })] }]);
    expect(queued?.queued).toHaveLength(1);
    const started = fold(queued, [{ type: "turn", turn: turn() }]);
    expect(started?.queued).toEqual([]);
    expect(started?.activeTurn?.id).toBe("t1");
  });

  it("stops a still-running card when its turn ends without a settle record", () => {
    const state = fold(seed({ records: [run()] }), [{ type: "turn", turn: turn({ state: "stopped", endedAt: 9 }) }]);
    expect((state?.records[0] as Extract<RoomRecord, { kind: "bot_run" }>).status).toBe("stopped");
  });

  it("settles a failed turn's runs as failed", () => {
    const state = fold(seed({ records: [run()] }), [{ type: "turn", turn: turn({ state: "failed", endedAt: 9 }) }]);
    expect((state?.records[0] as Extract<RoomRecord, { kind: "bot_run" }>).status).toBe("failed");
  });

  it("dedupes a request and drops it once resolved", () => {
    const request = { id: "inv1:q1", turnId: "t1", memberId: "a", invocationId: "inv1", request: { id: "q1", kind: "confirm" as const, title: "Run it?", createdAt: 1 } };
    let state = fold(seed(), [{ type: "request", request }]);
    state = fold(state, [{ type: "request", request }]);
    expect(state?.pending).toHaveLength(1);
    state = fold(state, [{ type: "request_resolved", requestId: "inv1:q1", outcome: "approved" }]);
    expect(state?.pending).toEqual([]);
  });

  it("replaces usage and the room's shape", () => {
    const usage = { turns: 2, steps: 3, input: 5, cachedInput: 1, cacheWrite: 0, output: 7, cost: 0.02, unpriced: 0 };
    let state = fold(seed(), [{ type: "usage", usage }]);
    expect(state?.usage).toEqual(usage);
    state = fold(state, [{ type: "room", room: room({ name: "Renamed", leadMemberId: null }) }]);
    expect(state?.room.name).toBe("Renamed");
    expect(findMember(state?.room ?? null, "a")).not.toBeNull();
    expect(findMember(state?.room ?? null, "missing")).toBeNull();
  });

  it("records why a disposed room is gone", () => {
    expect(fold(seed(), [{ type: "disposed", reason: "archived" }])?.gone).toBe("archived");
  });
});

describe("older history", () => {
  it("prepends pages in seq order without duplicating a record the snapshot already had", () => {
    const state = seed({ records: [userRecord("u3", 3)] });
    if (!state) throw new Error("no state");
    const older = prependRecords(state, [userRecord("u1", 1), userRecord("u2", 2), userRecord("u3", 3)]);
    expect(older.records.map((r) => r.id)).toEqual(["u1", "u2", "u3"]);
    expect(older.hasOlder).toBe(false);
  });

  it("keeps asking while a page came back full", () => {
    const state = seed();
    if (!state) throw new Error("no state");
    const page = Array.from({ length: BOARD_HISTORY_PAGE }, (_, i) => userRecord(`u${i}`, i + 1));
    expect(prependRecords(state, page).hasOlder).toBe(true);
  });
});
