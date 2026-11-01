// Board's store is the one place a paid turn becomes durable. These tests pin
// the layout and modes, the atomic round trip, bounded paging, and the two
// failure rules: a truncated final line is a crash to tolerate (with a
// warning), a malformed complete record is not; a newer or partial store is an
// explicit error, never a silent empty replacement.
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BOARD_STORE_VERSION, BoardStoreImpl } from "../../src/server/boards/store.js";
import type { StoredBot, StoredRoom, StoredRuntime } from "../../src/server/boards/types.js";
import type { RoomRecord } from "../../src/shared/protocol.js";

const bot: StoredBot = {
  id: "bot-1",
  name: "Atlas",
  harnessId: "fake",
  model: null,
  thinkingLevel: null,
  instructions: "",
  role: "lead",
  accent: null,
  permissionMode: null,
  revision: 1,
  createdAt: 1,
  updatedAt: 1,
};

const room: StoredRoom = {
  id: "room-1",
  name: "Stocks",
  topic: null,
  workspaceId: "ws-1",
  workspacePath: "/proj",
  archived: false,
  leadMemberId: "m-1",
  members: [
    {
      id: "m-1",
      botId: "bot-1",
      handle: "atlas",
      rank: 0,
      canLead: true,
      consultable: true,
      consultants: [],
      enabled: true,
      nativeSession: { harnessId: "fake", nativeId: "native-1" },
      deliveredSeq: 0,
      sessionRevision: 0,
    },
  ],
  budgets: { maxDirectResponders: 4, maxConsultRequests: 4, maxInvocations: 8, maxInvocationsPerMember: 3, turnWallClockMs: 180_000, queueMax: 20 },
  tombstones: [{ harnessId: "fake", nativeId: "old-native" }],
  createdAt: 1,
  updatedAt: 1,
};

function record(seq: number): RoomRecord {
  return { kind: "user", id: `u-${seq}`, seq, at: seq, turnId: `t-${seq}`, text: `message ${seq}`, mentions: [] };
}

async function freshStore(log?: (line: string) => void) {
  const dir = await mkdtemp(path.join(tmpdir(), "awui-boards-"));
  const store = new BoardStoreImpl({ dir: path.join(dir, "boards"), ...(log ? { log } : {}) });
  return { dir, store, boardsDir: path.join(dir, "boards") };
}

describe("the board store", () => {
  it("initializes an empty folder with the current schema and round-trips everything", async () => {
    const { store, boardsDir } = await freshStore();
    const empty = await store.load();
    expect(empty.schemaVersion).toBe(BOARD_STORE_VERSION);
    expect(empty).toMatchObject({ bots: [], rooms: [], runtimes: {} });
    // Nothing is created until the first write: a server that never uses Board leaves no trace.
    await expect(readFile(path.join(boardsDir, "schema.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    await store.saveBots([bot]);
    expect((await readFile(path.join(boardsDir, "schema.json"), "utf8")).length).toBeGreaterThan(0);
    await store.saveRoomConfig(room);
    await store.saveRoomsIndex([{ id: room.id, name: room.name, archived: false, updatedAt: 1 }]);
    await store.appendRecords(room.id, [record(1), record(2)]);
    const runtime: StoredRuntime = {
      activeTurnId: "t-2",
      queue: [{ id: "t-3", text: "queued", mentions: [], queuedAt: 3 }],
      generation: 2,
      clientTurns: [{ clientId: "c1", turn: { id: "t-3", state: "queued", text: "queued", mentions: [], directMemberIds: [], queuedAt: 3, startedAt: null, endedAt: null, invocationCount: 0, consultCount: 0 } }],
    };
    await store.saveRuntime(room.id, runtime);

    const loaded = await new BoardStoreImpl({ dir: boardsDir }).load();
    expect(loaded.bots).toEqual([bot]);
    expect(loaded.rooms).toEqual([room]);
    expect(loaded.runtimes[room.id]).toEqual(runtime);
    expect(await store.readRecords(room.id, { limit: 10 })).toEqual([record(1), record(2)]);
  });

  it("writes directories 0700 and files 0600", async () => {
    const { store, boardsDir } = await freshStore();
    await store.load();
    await store.saveBots([bot]);
    await store.saveRoomConfig(room);
    await store.appendRecords(room.id, [record(1)]);
    const mode = async (target: string) => (await stat(target)).mode & 0o777;
    expect(await mode(boardsDir)).toBe(0o700);
    expect(await mode(path.join(boardsDir, "bots.json"))).toBe(0o600);
    expect(await mode(path.join(boardsDir, "rooms", room.id))).toBe(0o700);
    expect(await mode(path.join(boardsDir, "rooms", room.id, "records.jsonl"))).toBe(0o600);
  });

  it("pages backwards with an exclusive seq and keeps the newest in the page", async () => {
    const { store } = await freshStore();
    await store.load();
    await store.saveRoomConfig(room);
    await store.appendRecords(room.id, [1, 2, 3, 4, 5].map(record));
    expect((await store.readRecords(room.id, { limit: 2 })).map((r) => r.seq)).toEqual([4, 5]);
    expect((await store.readRecords(room.id, { before: 4, limit: 2 })).map((r) => r.seq)).toEqual([2, 3]);
    expect((await store.readRecords(room.id, { before: 1, limit: 2 }))).toEqual([]);
  });

  it("tolerates only a truncated final line, and warns about it", async () => {
    const warnings: string[] = [];
    const { store, boardsDir } = await freshStore((line) => warnings.push(line));
    await store.load();
    await store.saveRoomConfig(room);
    await store.appendRecords(room.id, [record(1)]);
    const file = path.join(boardsDir, "rooms", room.id, "records.jsonl");
    await writeFile(file, `${JSON.stringify(record(1))}\n{"kind":"user","id":"half`, "utf8");
    expect(await store.readRecords(room.id, { limit: 10 })).toEqual([record(1)]);
    expect(warnings.some((line) => /truncated/.test(line))).toBe(true);
  });

  it("refuses a malformed complete record instead of skipping it", async () => {
    const { store, boardsDir } = await freshStore();
    await store.load();
    await store.saveRoomConfig(room);
    const file = path.join(boardsDir, "rooms", room.id, "records.jsonl");
    await writeFile(file, `${JSON.stringify(record(1))}\n{"kind":"user"}\n`, "utf8");
    await expect(store.readRecords(room.id, { limit: 10 })).rejects.toMatchObject({ code: "board_store_corrupt" });
  });

  it("refuses a newer schema, a missing schema beside state, and a room folder missing from the index", async () => {
    const one = await freshStore();
    await mkdir(one.boardsDir, { recursive: true });
    await writeFile(path.join(one.boardsDir, "schema.json"), JSON.stringify({ version: BOARD_STORE_VERSION + 1 }));
    await expect(one.store.load()).rejects.toMatchObject({ code: "board_store_corrupt" });

    const two = await freshStore();
    await mkdir(two.boardsDir, { recursive: true });
    await writeFile(path.join(two.boardsDir, "bots.json"), JSON.stringify({ bots: [] }));
    await expect(two.store.load()).rejects.toMatchObject({ code: "board_store_corrupt" });

    const three = await freshStore();
    await three.store.load();
    await mkdir(path.join(three.boardsDir, "rooms", "stray"), { recursive: true });
    await expect(three.store.load()).rejects.toMatchObject({ code: "board_store_corrupt" });
  });

  it("throws a Board write error when a write cannot land", async () => {
    const { store, boardsDir } = await freshStore();
    await store.load();
    // A file where the room's folder belongs makes every mkdir/rename for that room fail.
    await mkdir(path.join(boardsDir, "rooms"), { recursive: true });
    await writeFile(path.join(boardsDir, "rooms", room.id), "not a directory", "utf8");
    await expect(store.saveRoomConfig(room)).rejects.toMatchObject({ code: "board_store_write" });
  });

  it("keeps the previous file when a write fails", async () => {
    const { store, boardsDir } = await freshStore();
    await store.load();
    await store.saveBots([bot]);
    const file = path.join(boardsDir, "bots.json");
    await writeFile(file, "not json", "utf8");
    // A later valid write replaces the corrupt content atomically rather than appending to it.
    await store.saveBots([{ ...bot, name: "Renamed" }]);
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ bots: [{ name: "Renamed" }] });
  });
});
