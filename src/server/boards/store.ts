// Board's own persistence, deliberately stronger than state-file.ts: a write
// that fails throws, because acknowledging a user message that is not on disk
// would lose paid work. Layout: <boards>/bots.json, rooms.json, schema.json and
// one directory per room with config.json, records.jsonl, and runtime.json.
// Every write is temp-file-plus-rename, mode 0600; the directory is 0700.
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ChatError, errorMessage } from "../chats/chat.js";
import type { BoardUsage, ChatItem, RoomRecord } from "../../shared/protocol.js";
import type {
  BoardStore,
  BoardStoreContents,
  RoomBudgets,
  StoredBot,
  StoredMembership,
  StoredQueuedTurn,
  StoredRoom,
  StoredRoomIndexEntry,
  StoredRuntime,
} from "./types.js";

/** The store layout this server writes and understands. Older versions are refused, not guessed at. */
export const BOARD_STORE_VERSION = 1;

const roomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

const usageSchema = z.object({
  turns: z.number().int().min(0),
  steps: z.number().int().min(0),
  input: z.number().min(0),
  cachedInput: z.number().min(0),
  cacheWrite: z.number().min(0),
  output: z.number().min(0),
  cost: z.number().nullable(),
  unpriced: z.number().int().min(0),
});

const botSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  harnessId: z.string().min(1).max(64),
  model: z.string().max(512).nullable(),
  thinkingLevel: z.string().max(32).nullable(),
  instructions: z.string().max(8000),
  role: z.string().max(64),
  accent: z.string().max(32).nullable(),
  permissionMode: z.string().max(64).nullable(),
  revision: z.number().int().min(1),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const budgetsSchema = z.object({
  maxDirectResponders: z.number().int().min(1),
  maxConsultRequests: z.number().int().min(0),
  maxInvocations: z.number().int().min(1),
  maxInvocationsPerMember: z.number().int().min(1),
  turnWallClockMs: z.number().int().min(1000),
  queueMax: z.number().int().min(0),
});

const membershipSchema = z.object({
  id: z.string().min(1).max(64),
  botId: z.string().min(1).max(64),
  handle: z.string().min(1).max(32),
  rank: z.number().int().min(0),
  canLead: z.boolean(),
  consultable: z.boolean(),
  consultants: z.array(z.string().min(1).max(64)),
  enabled: z.boolean(),
  nativeSession: z.object({ harnessId: z.string().min(1).max(64), nativeId: z.string().min(1).max(512) }).nullable(),
  deliveredSeq: z.number().int().min(0),
  sessionRevision: z.number().int().min(0),
});

const roomSchema = z.object({
  id: roomIdSchema,
  name: z.string().min(1).max(100),
  topic: z.string().max(500).nullable(),
  workspaceId: z.string().min(1).max(128),
  workspacePath: z.string().min(1).max(4096),
  archived: z.boolean(),
  leadMemberId: z.string().max(64).nullable(),
  members: z.array(membershipSchema).max(12),
  budgets: budgetsSchema,
  tombstones: z.array(z.object({ harnessId: z.string().min(1).max(64), nativeId: z.string().min(1).max(512) })).optional(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
});

const roomIndexSchema = z.object({
  id: roomIdSchema,
  name: z.string().min(1).max(100),
  archived: z.boolean(),
  updatedAt: z.number().int(),
});

const queuedTurnSchema = z.object({
  id: z.string().min(1).max(64),
  text: z.string().min(1).max(100_000),
  mentions: z.array(z.string().min(1).max(64)),
  clientId: z.string().min(1).max(128).optional(),
  queuedAt: z.number().int(),
});

const turnViewSchema = z.object({
  id: z.string().min(1).max(64),
  state: z.enum(["queued", "running", "waiting_for_user", "stopping", "stopped", "done", "failed", "interrupted"]),
  text: z.string(),
  mentions: z.array(z.string()),
  directMemberIds: z.array(z.string()),
  queuedAt: z.number().int(),
  startedAt: z.number().int().nullable(),
  endedAt: z.number().int().nullable(),
  invocationCount: z.number().int().min(0),
  consultCount: z.number().int().min(0),
  stopReason: z.string().optional(),
});

const runtimeSchema = z.object({
  activeTurnId: z.string().max(64).nullable(),
  queue: z.array(queuedTurnSchema),
  generation: z.number().int().min(0),
  /** Idempotency keys still worth answering, so a network retry after a restart does not post twice. */
  clientTurns: z.array(z.object({ clientId: z.string().min(1).max(128), turn: turnViewSchema })).optional(),
});

/** A projected ChatItem is already a protocol type; the store only checks its shape, never reshapes it. */
const chatItemSchema = z.custom<ChatItem>((value) => {
  if (typeof value !== "object" || value === null || !("kind" in value) || !("id" in value)) return false;
  return typeof value.kind === "string" && typeof value.id === "string";
}, "not a chat item");

const recordSchema: z.ZodType<RoomRecord> = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("user"),
    id: z.string().min(1).max(64),
    seq: z.number().int().min(1),
    at: z.number().int(),
    turnId: z.string().min(1).max(64),
    text: z.string(),
    mentions: z.array(z.string()),
  }),
  z.object({
    kind: z.literal("bot_run"),
    id: z.string().min(1).max(64),
    seq: z.number().int().min(1),
    at: z.number().int(),
    turnId: z.string().min(1).max(64),
    memberId: z.string().min(1).max(64),
    invocationId: z.string().min(1).max(64),
    consultOf: z.string().max(64).optional(),
    status: z.enum(["running", "done", "failed", "stopped"]),
    model: z.string().max(512).nullable(),
    thinkingLevel: z.string().max(32).nullable().optional(),
    items: z.array(chatItemSchema),
    usage: usageSchema.nullable(),
    latencyMs: z.number().int().min(0).nullable(),
    error: z.string().optional(),
  }),
  z.object({
    kind: z.literal("consultation"),
    id: z.string().min(1).max(64),
    seq: z.number().int().min(1),
    at: z.number().int(),
    turnId: z.string().min(1).max(64),
    fromMemberId: z.string().min(1).max(64),
    toMemberId: z.string().min(1).max(64),
    question: z.string(),
    outcome: z.enum(["requested", "refused", "answered", "failed"]),
    reason: z.string().optional(),
  }),
  z.object({
    kind: z.literal("notice"),
    id: z.string().min(1).max(64),
    seq: z.number().int().min(1),
    at: z.number().int(),
    turnId: z.string().max(64).nullable(),
    level: z.enum(["info", "warning", "error"]),
    text: z.string(),
  }),
]) as z.ZodType<RoomRecord>;

function corrupt(message: string): ChatError {
  return new ChatError(500, "board_store_corrupt", `The Board store cannot be read: ${message}`);
}

/** Write one file durably: a fresh temp file, fsync, then rename over the target. */
async function writeAtomicFile(file: string, text: string): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // mkdir's mode only applies to new directories; an existing one may have been loosened.
  await fs.chmod(dir, 0o700).catch(() => undefined);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await fs.open(tmp, "w", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(tmp, file);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJson(file: string): Promise<unknown | null> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw corrupt(`${path.basename(file)} is not JSON`);
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw corrupt(`${what}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  return parsed.data;
}

export interface BoardStoreOptions {
  /** `<stateDir>/boards`. */
  dir: string;
  log?: (line: string) => void;
}

export class BoardStoreImpl implements BoardStore {
  private readonly dir: string;
  private readonly log: (line: string) => void;
  /** One promise chain per file so two writes never race a rename. */
  private readonly chains = new Map<string, Promise<void>>();
  /** A room whose records ended mid-line is warned about once per read, not once per page. */
  private readonly truncatedWarned = new Set<string>();
  /** The schema is written with the first actual write: a server with no rooms never creates the folder. */
  private schemaReady = false;

  constructor(options: BoardStoreOptions) {
    this.dir = options.dir;
    this.log = options.log ?? (() => undefined);
  }

  private get botsFile(): string {
    return path.join(this.dir, "bots.json");
  }
  private get roomsFile(): string {
    return path.join(this.dir, "rooms.json");
  }
  private get schemaFile(): string {
    return path.join(this.dir, "schema.json");
  }
  private roomDir(roomId: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(roomId)) throw corrupt(`invalid room id ${JSON.stringify(roomId)}`);
    return path.join(this.dir, "rooms", roomId);
  }
  private configFile(roomId: string): string {
    return path.join(this.roomDir(roomId), "config.json");
  }
  private recordsFile(roomId: string): string {
    return path.join(this.roomDir(roomId), "records.jsonl");
  }
  private runtimeFile(roomId: string): string {
    return path.join(this.roomDir(roomId), "runtime.json");
  }

  /** Serialize writes to one file; a rejected write rejects its caller and the next one still runs. */
  private async serialized(file: string, run: () => Promise<void>): Promise<void> {
    const previous = this.chains.get(file) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const guarded = next.catch(() => undefined);
    this.chains.set(file, guarded);
    try {
      await next;
    } finally {
      if (this.chains.get(file) === guarded) this.chains.delete(file);
    }
  }

  /** A write that fails must say so with a Board error code, not a bare fs error. */
  private async serializedWrite(file: string, run: () => Promise<void>): Promise<void> {
    try {
      await this.serialized(file, run);
    } catch (error) {
      if (error instanceof ChatError) throw error;
      throw new ChatError(500, "board_store_write", `The Board store could not be written: ${errorMessage(error)}`);
    }
  }

  async load(): Promise<BoardStoreContents> {
    const schema = await readJson(this.schemaFile);
    if (schema === null) {
      // A missing folder (or an empty one) is a first run: nothing is created
      // until the first real write, so a server that never uses Board leaves no trace.
      const [bots, rooms, roomDirs] = await Promise.all([
        readJson(this.botsFile),
        readJson(this.roomsFile),
        fs.readdir(path.join(this.dir, "rooms")).catch(() => [] as string[]),
      ]);
      if (bots !== null || rooms !== null || roomDirs.length > 0) throw corrupt("schema.json is missing but Board state exists");
      return { schemaVersion: BOARD_STORE_VERSION, bots: [], rooms: [], runtimes: {} };
    }
    this.schemaReady = true;
    const { version } = parse(z.object({ version: z.number().int() }), schema, "schema.json");
    if (version > BOARD_STORE_VERSION) throw corrupt(`it was written by a newer awui (schema ${version}; this server reads ${BOARD_STORE_VERSION})`);
    if (version < BOARD_STORE_VERSION) throw corrupt(`schema ${version} is too old for this server (it reads ${BOARD_STORE_VERSION}) and is kept, not discarded`);

    const botsFile = await readJson(this.botsFile);
    const bots = botsFile === null ? [] : parse(z.object({ bots: z.array(botSchema).max(100) }), botsFile, "bots.json").bots;
    const indexFile = await readJson(this.roomsFile);
    const index = indexFile === null ? null : parse(z.object({ rooms: z.array(roomIndexSchema).max(50) }), indexFile, "rooms.json").rooms;

    const roomDirs = await fs.readdir(path.join(this.dir, "rooms"), { withFileTypes: true }).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    });
    if (index === null && roomDirs.length > 0) throw corrupt("rooms.json is missing but room folders exist");
    const ids = (index ?? []).map((entry) => entry.id);
    const rooms: StoredRoom[] = [];
    const runtimes: Record<string, StoredRuntime> = {};
    for (const id of ids) {
      const config = await readJson(this.configFile(id));
      if (config === null) throw corrupt(`room ${id} is listed in rooms.json but has no config.json`);
      const room = parse(roomSchema, config, `room ${id}/config.json`);
      if (room.id !== id) throw corrupt(`room ${id}/config.json names ${room.id}`);
      rooms.push(room);
      const runtime = await readJson(this.runtimeFile(id));
      if (runtime !== null) runtimes[id] = parse(runtimeSchema, runtime, `room ${id}/runtime.json`);
    }
    const known = new Set(ids);
    for (const entry of roomDirs) {
      if (entry.isDirectory() && !known.has(entry.name)) throw corrupt(`room folder ${entry.name} is not in rooms.json`);
    }
    return { schemaVersion: version, bots, rooms, runtimes };
  }

  /** Write the version file with the first save; a store that only reads never creates anything. */
  private async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    await writeAtomicFile(this.schemaFile, `${JSON.stringify({ version: BOARD_STORE_VERSION }, null, 2)}\n`);
    this.schemaReady = true;
  }

  async saveBots(bots: StoredBot[]): Promise<void> {
    await this.ensureSchema();
    const text = `${JSON.stringify({ bots }, null, 2)}\n`;
    await this.serializedWrite(this.botsFile, () => writeAtomicFile(this.botsFile, text));
  }

  async saveRoomsIndex(rooms: StoredRoomIndexEntry[]): Promise<void> {
    await this.ensureSchema();
    const text = `${JSON.stringify({ rooms }, null, 2)}\n`;
    await this.serializedWrite(this.roomsFile, () => writeAtomicFile(this.roomsFile, text));
  }

  async saveRoomConfig(room: StoredRoom): Promise<void> {
    await this.ensureSchema();
    const file = this.configFile(room.id);
    const text = `${JSON.stringify(room, null, 2)}\n`;
    await this.serializedWrite(file, async () => {
      await writeAtomicFile(file, text);
      // A room's records are appended with 0600; the folder is the owner's alone.
      await fs.chmod(this.roomDir(room.id), 0o700).catch(() => undefined);
    });
  }

  async appendRecords(roomId: string, records: RoomRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.ensureSchema();
    const file = this.recordsFile(roomId);
    const text = records.map((record) => `${JSON.stringify(record)}\n`).join("");
    await this.serializedWrite(file, async () => {
      await fs.mkdir(this.roomDir(roomId), { recursive: true, mode: 0o700 });
      await fs.chmod(this.roomDir(roomId), 0o700).catch(() => undefined);
      const handle = await fs.open(file, "a", 0o600);
      try {
        await handle.writeFile(text, "utf8");
        // A user message is acknowledged only once its record survives a crash.
        await handle.sync();
      } finally {
        await handle.close();
      }
    });
  }

  async readRecords(roomId: string, opts: { before?: number; limit: number }): Promise<RoomRecord[]> {
    const file = this.recordsFile(roomId);
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw new ChatError(500, "board_store_read", `The room's records cannot be read: ${errorMessage(error)}`);
    }
    if (text.length === 0) return [];
    // A crash can leave the last append half written. That one line is dropped
    // with a warning; a malformed *complete* line means the store is not ours.
    const truncatedTail = !text.endsWith("\n");
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    if (truncatedTail) {
      lines.pop();
      if (!this.truncatedWarned.has(roomId)) {
        this.truncatedWarned.add(roomId);
        this.log(`boards: room ${roomId} had a truncated final record (a crash during an append); it was ignored`);
      }
    }
    const records: RoomRecord[] = [];
    for (const [i, line] of lines.entries()) {
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch {
        throw corrupt(`room ${roomId}/records.jsonl line ${i + 1} is not JSON`);
      }
      records.push(parse(recordSchema, value, `room ${roomId}/records.jsonl line ${i + 1}`));
    }
    const before = opts.before;
    const page = before === undefined ? records : records.filter((record) => record.seq < before);
    return page.slice(-Math.max(1, opts.limit));
  }

  async saveRuntime(roomId: string, runtime: StoredRuntime): Promise<void> {
    await this.ensureSchema();
    const file = this.runtimeFile(roomId);
    const text = `${JSON.stringify(runtime, null, 2)}\n`;
    await this.serializedWrite(file, () => writeAtomicFile(file, text));
  }

  async readRuntime(roomId: string): Promise<StoredRuntime | null> {
    const value = await readJson(this.runtimeFile(roomId));
    return value === null ? null : parse(runtimeSchema, value, `room ${roomId}/runtime.json`);
  }

  /** The board's folder, so a test can assert modes and remove it. */
  get root(): string {
    return this.dir;
  }
}

/** The usage a room's records add up to, newest-record order irrelevant; exported for the manager's rollups. */
export function usageOfRecords(records: RoomRecord[]): BoardUsage {
  let usage: BoardUsage = { turns: 0, steps: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: null, unpriced: 0 };
  let cost = 0;
  let priced = true;
  let pricedAny = false;
  for (const record of records) {
    if (record.kind !== "bot_run" || !record.usage) continue;
    const add = record.usage;
    usage = {
      turns: usage.turns + add.turns,
      steps: usage.steps + add.steps,
      input: usage.input + add.input,
      cachedInput: usage.cachedInput + add.cachedInput,
      cacheWrite: usage.cacheWrite + add.cacheWrite,
      output: usage.output + add.output,
      cost: null,
      unpriced: usage.unpriced + add.unpriced,
    };
    if (add.cost === null) priced = false;
    else {
      cost += add.cost;
      pricedAny = true;
    }
  }
  usage.cost = priced && pricedAny ? cost : null;
  return usage;
}
