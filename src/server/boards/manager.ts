// Board's front door: durable CRUD over the store, the per-room schedulers,
// running turns through the session pool, and the ownership oracle ordinary
// chat surfaces filter by. Everything here is validated against the registry,
// the workspaces, and the room's own budgets before a model is called.
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  BOARD_HISTORY_PAGE,
  BOARD_MAX_BOTS,
  BOARD_MAX_INVOCATIONS,
  BOARD_MAX_INVOCATIONS_PER_MEMBER,
  BOARD_MAX_MEMBERS,
  BOARD_MAX_ROOMS,
  BOARD_MAX_DIRECT_RESPONDERS,
  BOARD_MAX_CONSULT_REQUESTS,
  BOARD_QUEUE_MAX,
  BOARD_TURN_WALL_CLOCK_MS,
  type BoardUsage,
  type BotProfile,
  type InteractionAnswer,
  type InteractionRequest,
  type RoomEvent,
  type RoomInfo,
  type RoomMemberView,
  type RoomPendingRequest,
  type RoomRecord,
  type RoomSnapshot,
  type RoomSummary,
  type RoomTurnState,
  type RoomTurnView,
  type WorkspaceInfo,
} from "../../shared/protocol.js";
import { ChatError, errorMessage } from "../chats/chat.js";
import { RoomEventLogImpl } from "./events.js";
import { BoardStoreImpl, usageOfRecords } from "./store.js";
import { RoomScheduler, type ActiveTurn } from "./scheduler.js";
import { TurnRunner, type RecordDraft, type TurnRunnerHost } from "./turn-runner.js";
import { addUsage, createTurnBudget, emptyUsage, markExpired, type TurnBudget } from "./budget.js";
import { BotSessionPoolImpl } from "./sessions.js";
import { noteRoom } from "../overview-events.js";
import type {
  BoardDeps,
  BoardManager,
  BoardStoreContents,
  BotCreateInput,
  BotInvokeRequest,
  BotPatchInput,
  MemberAddInput,
  MemberPatchInput,
  RoomBudgets,
  RoomCreateInput,
  RoomMessageInput,
  RoomPatchInput,
  RoomSubscriber,
  StoredBot,
  StoredMembership,
  StoredQueuedTurn,
  StoredRoom,
  StoredRoomIndexEntry,
} from "./types.js";

const MAX_PAGE = 100_000;
const MAX_EXPORT_CHARS = 2_000_000;

function defaultBudgets(): RoomBudgets {
  return {
    maxDirectResponders: BOARD_MAX_DIRECT_RESPONDERS,
    maxConsultRequests: BOARD_MAX_CONSULT_REQUESTS,
    maxInvocations: BOARD_MAX_INVOCATIONS,
    maxInvocationsPerMember: BOARD_MAX_INVOCATIONS_PER_MEMBER,
    turnWallClockMs: BOARD_TURN_WALL_CLOCK_MS,
    queueMax: BOARD_QUEUE_MAX,
  };
}

/** One live record per id, latest data, ordered by the latest version's seq (consultations update in place). */
function composeRecords(records: RoomRecord[]): RoomRecord[] {
  const byId = new Map<string, RoomRecord>();
  for (const record of records) byId.set(record.id, record);
  return [...byId.values()].sort((a, b) => a.seq - b.seq);
}

function terminal(state: RoomTurnState): boolean {
  return state === "done" || state === "failed" || state === "stopped" || state === "interrupted";
}

function handleFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return /^[a-z0-9]/.test(slug) ? slug : `bot${slug}`;
}

function queuedView(stored: StoredQueuedTurn, directMemberIds: string[]): RoomTurnView {
  return {
    id: stored.id,
    state: "queued",
    text: stored.text,
    mentions: [...stored.mentions],
    directMemberIds,
    queuedAt: stored.queuedAt,
    startedAt: null,
    endedAt: null,
    invocationCount: 0,
    consultCount: 0,
  };
}

function usageLine(usage: BoardUsage): string {
  return `${usage.input} in / ${usage.cachedInput} cached / ${usage.output} out · ${usage.cost === null ? "cost unavailable" : `$${usage.cost.toFixed(4)}`}`;
}

export class RoomManager implements BoardManager {
  private readonly deps: BoardDeps;
  private readonly store: BoardStoreImpl;
  private readonly pool: BotSessionPoolImpl;
  // Streamed items and deltas never change a summary (status, pending, activity come from records and the scheduler).
  private readonly events = new RoomEventLogImpl((roomId, event) => {
    if (event.type !== "item" && event.type !== "delta") this.summarySoon(roomId);
  });
  /** Rooms whose overview summary is due: one recompute per room per tick, however many events landed. */
  private readonly summariesDue = new Set<string>();
  private readonly bots = new Map<string, StoredBot>();
  private readonly rooms = new Map<string, StoredRoom>();
  private readonly schedulers = new Map<string, RoomScheduler>();
  private readonly lastSeqs = new Map<string, number>();
  private readonly owned = new Set<string>();
  private readonly pending = new Map<string, Map<string, RoomPendingRequest>>();
  /** Runs in flight, keyed by their record id (== invocationId): their opening record and the snapshot. */
  private readonly liveRuns = new Map<string, Map<string, RoomRecord>>();
  private readonly workspaceCache = new Map<string, WorkspaceInfo>();
  private readonly pumping = new Set<string>();
  private readonly turnTimers = new Map<string, NodeJS.Timeout>();
  private readonly appends = new Map<string, Promise<unknown>>();
  private started = false;

  constructor(deps: BoardDeps) {
    this.deps = deps;
    const log = deps.log ?? (() => undefined);
    this.store = new BoardStoreImpl({ dir: path.join(deps.stateDir, "boards"), log });
    this.pool = new BotSessionPoolImpl({ registry: deps.registry, chats: deps.chats, workspaces: deps.workspaces, log });
  }

  // ---- lifecycle ------------------------------------------------------------

  async start(): Promise<void> {
    if (this.started) return;
    const contents: BoardStoreContents = await this.store.load();
    for (const bot of contents.bots) this.bots.set(bot.id, bot);
    for (const room of contents.rooms) {
      this.rooms.set(room.id, room);
      this.claimOwned(room);
    }
    const now = Date.now();
    for (const room of contents.rooms) {
      const scheduler = new RoomScheduler();
      const runtime = contents.runtimes[room.id];
      if (runtime) scheduler.restore(runtime);
      this.schedulers.set(room.id, scheduler);
      if (!runtime || (!runtime.activeTurnId && runtime.queue.length === 0)) continue;
      // Nothing paid resumes by itself. Every active or queued turn from the
      // previous process becomes a visible interrupted notice, and its queue is cleared.
      const drafts: RecordDraft[] = [];
      for (const queued of runtime.queue) {
        drafts.push({
          kind: "notice",
          id: randomUUID(),
          at: now,
          turnId: queued.id,
          level: "warning",
          text: `A queued turn was interrupted by a server restart and was not resumed: ${queued.text.slice(0, 120)}`,
        });
      }
      if (runtime.activeTurnId) {
        drafts.push({ kind: "notice", id: randomUUID(), at: now, turnId: runtime.activeTurnId, level: "warning", text: "A running turn was interrupted by a server restart; nothing was resumed." });
      }
      if (drafts.length > 0) await this.append(room.id, drafts);
      scheduler.queued = [];
      scheduler.active = null;
      scheduler.generation += 1;
      for (const [clientId, turn] of scheduler.clientTurns) {
        if (!terminal(turn.state)) scheduler.clientTurns.set(clientId, { ...turn, state: "interrupted", endedAt: now });
      }
      await this.store.saveRuntime(room.id, scheduler.runtime());
    }
    this.started = true;
  }

  async shutdown(): Promise<void> {
    // Every in-flight runner sees a generation it no longer owns and stops scheduling.
    for (const scheduler of this.schedulers.values()) scheduler.generation += 1;
    for (const timer of this.turnTimers.values()) clearTimeout(timer);
    this.turnTimers.clear();
    await Promise.allSettled([...this.rooms.keys()].map(async (roomId) => {
      await this.pool.disposeRoom(roomId);
      this.events.closeRoom(roomId);
    }));
    this.workspaceCache.clear();
  }

  // ---- helpers --------------------------------------------------------------

  private scheduler(roomId: string): RoomScheduler {
    let scheduler = this.schedulers.get(roomId);
    if (!scheduler) {
      scheduler = new RoomScheduler();
      this.schedulers.set(roomId, scheduler);
    }
    return scheduler;
  }

  private requireRoom(roomId: string): StoredRoom {
    const room = this.rooms.get(roomId);
    if (!room) throw new ChatError(404, "no_room", "No such room");
    return room;
  }

  private requireBot(botId: string): StoredBot {
    const bot = this.bots.get(botId);
    if (!bot) throw new ChatError(404, "no_bot", "No such bot profile");
    return bot;
  }

  private claimOwned(room: StoredRoom): void {
    for (const member of room.members) if (member.nativeSession) this.owned.add(`${member.nativeSession.harnessId}\u0000${member.nativeSession.nativeId}`);
    for (const tombstone of room.tombstones ?? []) this.owned.add(`${tombstone.harnessId}\u0000${tombstone.nativeId}`);
  }

  private indexEntry(room: StoredRoom): StoredRoomIndexEntry {
    return { id: room.id, name: room.name, archived: room.archived, updatedAt: room.updatedAt };
  }

  private async saveRoomsIndex(): Promise<void> {
    await this.store.saveRoomsIndex([...this.rooms.values()].map((room) => this.indexEntry(room)));
  }

  /** Persist a room's config and its list row; an index failure is not hidden behind the config write. */
  private async persistRoom(room: StoredRoom): Promise<void> {
    await this.store.saveRoomConfig(room);
    await this.saveRoomsIndex();
  }

  private async lastSeq(roomId: string): Promise<number> {
    const cached = this.lastSeqs.get(roomId);
    if (cached !== undefined) return cached;
    const newest = await this.store.readRecords(roomId, { limit: 1 });
    const seq = newest[0]?.seq ?? 0;
    this.lastSeqs.set(roomId, seq);
    return seq;
  }

  private async append(roomId: string, drafts: Array<RecordDraft & { seq?: number }>): Promise<RoomRecord[]> {
    if (drafts.length === 0) return [];
    const previous = this.appends.get(roomId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      let seq = await this.lastSeq(roomId);
      const records = drafts.map((draft) => {
        // A run reserves its seq when it starts, so the live record and the
        // settled one keep the same place in the room's order.
        if (draft.seq !== undefined) {
          seq = Math.max(seq, draft.seq);
          return { ...draft, seq: draft.seq } as RoomRecord;
        }
        seq += 1;
        return { ...draft, seq } as RoomRecord;
      });
      await this.store.appendRecords(roomId, records);
      this.lastSeqs.set(roomId, seq);
      for (const record of records) {
        if (record.kind === "bot_run") this.liveRuns.get(roomId)?.delete(record.id);
        this.events.emit(roomId, { type: "record", record });
      }
      return records;
    });
    this.appends.set(roomId, run.catch(() => undefined));
    return run;
  }

  /** Take the next room seq for a run's opening record; the append at settle uses the same number. */
  private reserveSeq(roomId: string): Promise<number> {
    const previous = this.appends.get(roomId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const seq = (await this.lastSeq(roomId)) + 1;
      this.lastSeqs.set(roomId, seq);
      return seq;
    });
    this.appends.set(roomId, run.then(() => undefined, () => undefined));
    return run;
  }

  private async readAll(roomId: string): Promise<RoomRecord[]> {
    return composeRecords(await this.store.readRecords(roomId, { limit: MAX_PAGE }));
  }

  private async persistRuntime(roomId: string): Promise<void> {
    await this.store.saveRuntime(roomId, this.scheduler(roomId).runtime());
  }

  private emitTurn(roomId: string, turn: RoomTurnView): void {
    this.events.emit(roomId, { type: "turn", turn: { ...turn, mentions: [...turn.mentions], directMemberIds: [...turn.directMemberIds] } });
  }

  private emitRoom(room: StoredRoom): void {
    void this.roomInfo(room).then((info) => this.events.emit(room.id, { type: "room", room: info })).catch(() => undefined);
  }

  private roomNotify(roomId: string, kind: "done" | "error" | "ask", title: string, body: string, request?: InteractionRequest): void {
    this.deps.notify?.({ kind, roomId, title, body, ...(request ? { request } : {}) });
  }

  /** Resolve and re-validate a room's workspace; ids are in-memory, so a restart re-opens the stored path. */
  private async resolveWorkspace(room: StoredRoom): Promise<WorkspaceInfo> {
    const cached = this.workspaceCache.get(room.id);
    if (cached && cached.id === room.workspaceId) return cached;
    let workspace: WorkspaceInfo;
    try {
      workspace = await this.deps.workspaces.get(room.workspaceId);
    } catch {
      try {
        workspace = await this.deps.workspaces.open(room.workspacePath);
      } catch (error) {
        throw new ChatError(404, "missing_project", `This room's project folder cannot be opened: ${errorMessage(error)}`);
      }
      if (workspace.id !== room.workspaceId) throw new ChatError(409, "workspace_changed", "This room's project folder moved; open it again in the app before running the room");
    }
    this.workspaceCache.set(room.id, workspace);
    return workspace;
  }

  private async workspaceName(room: StoredRoom): Promise<string> {
    try {
      const workspace = await this.resolveWorkspace(room);
      return workspace.name;
    } catch {
      return path.basename(room.workspacePath) || "project";
    }
  }

  private validLead(room: StoredRoom): StoredMembership | undefined {
    const member = room.leadMemberId ? room.members.find((candidate) => candidate.id === room.leadMemberId) : undefined;
    return member && member.enabled && member.canLead ? member : undefined;
  }

  private memberView(member: StoredMembership): RoomMemberView {
    const bot = this.bots.get(member.botId);
    return {
      id: member.id,
      botId: member.botId,
      name: bot?.name ?? member.handle,
      handle: member.handle,
      rank: member.rank,
      canLead: member.canLead,
      consultable: member.consultable,
      consultants: [...member.consultants],
      enabled: member.enabled,
      accent: bot?.accent ?? null,
      harnessId: bot?.harnessId ?? "",
      model: bot?.model ?? null,
      thinkingLevel: bot?.thinkingLevel ?? null,
      role: bot?.role ?? "",
      permissionMode: bot?.permissionMode ?? null,
    };
  }

  private async roomInfo(room: StoredRoom): Promise<RoomInfo> {
    const workspaceName = await this.workspaceName(room);
    const members = [...room.members]
      .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id))
      .map((member) => this.memberView(member));
    return {
      id: room.id,
      name: room.name,
      topic: room.topic,
      workspaceId: room.workspaceId,
      workspaceName,
      archived: room.archived,
      leadMemberId: this.validLead(room)?.id ?? null,
      members,
      budgets: { ...room.budgets },
    };
  }

  private directMembers(room: StoredRoom, mentions: string[]): StoredMembership[] {
    const unique = [...new Set(mentions)];
    if (unique.length !== mentions.length) throw new ChatError(400, "duplicate_mentions", "A bot can be addressed only once");
    if (unique.length > room.budgets.maxDirectResponders) {
      throw new ChatError(400, "too_many_mentions", `This room runs at most ${room.budgets.maxDirectResponders} bots per turn`);
    }
    const selected: StoredMembership[] = [];
    if (unique.length === 0) {
      const lead = this.validLead(room);
      if (!lead) throw new ChatError(409, "no_lead", "This room has no enabled lead: pick one before sending");
      selected.push(lead);
    } else {
      for (const id of unique) {
        const member = room.members.find((candidate) => candidate.id === id);
        if (!member) throw new ChatError(400, "unknown_member", "A mentioned bot is not a member of this room");
        if (!member.enabled) throw new ChatError(400, "disabled_member", `@${member.handle} is disabled`);
        selected.push(member);
      }
    }
    return selected.sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  }

  private queuedViews(room: StoredRoom, scheduler: RoomScheduler): RoomTurnView[] {
    return scheduler.queued.map((stored) => {
      let direct: StoredMembership[] = [];
      try {
        direct = this.directMembers(room, stored.mentions);
      } catch {
        // A member was disabled or removed while queued: the row still shows, with no responders.
      }
      return queuedView(stored, direct.map((member) => member.id));
    });
  }

  // ---- bots -----------------------------------------------------------------

  async listBots(): Promise<BotProfile[]> {
    return [...this.bots.values()].sort((a, b) => a.createdAt - b.createdAt).map((bot) => ({ ...bot }));
  }

  async createBot(input: BotCreateInput): Promise<BotProfile> {
    if (this.bots.size >= BOARD_MAX_BOTS) throw new ChatError(409, "too_many_bots", `At most ${BOARD_MAX_BOTS} bot profiles are kept`);
    const adapter = this.deps.registry.get(input.harnessId);
    if (!adapter) throw new ChatError(404, "unknown_harness", "Unknown harness");
    if (!(await this.deps.registry.available(adapter.id))) throw new ChatError(422, "harness_unavailable", `${adapter.displayName} is unavailable right now`);
    if (input.permissionMode && !adapter.capabilities.supportsPermissionMode) throw new ChatError(422, "unsupported_setting", `${adapter.displayName} has no permission modes`);
    if (input.thinkingLevel && !adapter.capabilities.supportsThinkingLevel) throw new ChatError(422, "unsupported_setting", `${adapter.displayName} has no thinking levels`);
    const now = Date.now();
    const bot: StoredBot = {
      id: randomUUID(),
      name: input.name,
      harnessId: adapter.id,
      model: input.model ?? null,
      thinkingLevel: input.thinkingLevel ?? null,
      instructions: input.instructions ?? "",
      role: input.role ?? "",
      accent: input.accent ?? null,
      permissionMode: input.permissionMode ?? null,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveBots([...this.bots.values(), bot]);
    this.bots.set(bot.id, bot);
    return { ...bot };
  }

  /** Rooms whose memberships use this profile and have a run in flight. */
  private botBusy(botId: string): boolean {
    for (const room of this.rooms.values()) {
      for (const member of room.members) {
        if (member.botId === botId && this.memberBusy(room.id, member.id)) return true;
      }
    }
    return false;
  }

  /** A membership is busy from the moment its turn selects it, not only once its chat is open. */
  private memberBusy(roomId: string, memberId: string): boolean {
    return this.pool.isInvoking(roomId, memberId) || (this.scheduler(roomId).active?.directMemberIds.includes(memberId) ?? false);
  }

  async patchBot(id: string, input: BotPatchInput): Promise<BotProfile> {
    const bot = this.requireBot(id);
    if (this.botBusy(id)) throw new ChatError(409, "bot_busy", "This bot is running; change it after the turn");
    const adapter = this.deps.registry.get(bot.harnessId);
    if (adapter) {
      if (input.permissionMode && !adapter.capabilities.supportsPermissionMode) throw new ChatError(422, "unsupported_setting", `${adapter.displayName} has no permission modes`);
      if (input.thinkingLevel && !adapter.capabilities.supportsThinkingLevel) throw new ChatError(422, "unsupported_setting", `${adapter.displayName} has no thinking levels`);
    }
    const next: StoredBot = {
      ...bot,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.model !== undefined ? { model: input.model } : {}),
      ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      ...(input.role !== undefined ? { role: input.role } : {}),
      ...(input.accent !== undefined ? { accent: input.accent } : {}),
      ...(input.permissionMode !== undefined ? { permissionMode: input.permissionMode } : {}),
      revision: bot.revision + 1,
      updatedAt: Date.now(),
    };
    const bots = [...this.bots.values()].map((existing) => (existing.id === id ? next : existing));
    await this.store.saveBots(bots);
    this.bots.set(id, next);
    for (const room of this.rooms.values()) if (room.members.some((member) => member.botId === id)) this.emitRoom(room);
    return { ...next };
  }

  async deleteBot(id: string): Promise<void> {
    const bot = this.requireBot(id);
    const usedBy = [...this.rooms.values()].filter((room) => room.members.some((member) => member.botId === id));
    if (usedBy.length > 0) {
      throw new ChatError(409, "bot_in_use", `"${bot.name}" is a member of ${usedBy.length} room${usedBy.length === 1 ? "" : "s"}; remove it there first`);
    }
    const bots = [...this.bots.values()].filter((existing) => existing.id !== id);
    await this.store.saveBots(bots);
    this.bots.delete(id);
  }

  // ---- rooms and memberships ------------------------------------------------

  async listRooms(): Promise<RoomSummary[]> {
    const summaries = await Promise.all([...this.rooms.values()].map((room) => this.roomSummary(room)));
    // Most recently active first; a room that never ran sorts by name after the others.
    return summaries.sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.name.localeCompare(b.name));
  }

  private async roomSummary(room: StoredRoom): Promise<RoomSummary> {
    const records = await this.readAll(room.id);
    const scheduler = this.scheduler(room.id);
    const pending = this.pending.get(room.id)?.size ?? 0;
    const last = records[records.length - 1];
    const activity = Math.max(last?.at ?? 0, scheduler.active?.view.startedAt ?? 0);
    return {
      id: room.id,
      name: room.name,
      topic: room.topic,
      archived: room.archived,
      leadName: this.validLead(room)?.handle ?? null,
      memberCount: room.members.length,
      status: scheduler.running ? (pending > 0 ? "waiting" : "running") : scheduler.queued.length > 0 ? "queued" : "idle",
      pendingCount: pending,
      lastActivityAt: activity > 0 ? activity : null,
      usage: usageOfRecords(records),
    };
  }

  async createRoom(input: RoomCreateInput): Promise<RoomInfo> {
    if (this.rooms.size >= BOARD_MAX_ROOMS) throw new ChatError(409, "too_many_rooms", `At most ${BOARD_MAX_ROOMS} rooms are kept`);
    const workspace = await this.deps.workspaces.get(input.workspaceId);
    const reopened = await this.deps.workspaces.open(workspace.path);
    if (reopened.id !== workspace.id) throw new ChatError(409, "workspace_changed", "That workspace has changed; open it again");
    if (input.members.length === 0) throw new ChatError(400, "no_members", "A room needs at least one member");
    if (input.members.some((member) => member.consultants.length > 0)) {
      throw new ChatError(400, "consultants_not_ready", "Add the members first, then set each one's consultation allowlist");
    }
    const handles = new Set<string>();
    const members: StoredMembership[] = [];
    for (const [index, entry] of input.members.entries()) {
      const bot = this.requireBot(entry.botId);
      const adapter = this.deps.registry.get(bot.harnessId);
      if (!adapter) throw new ChatError(422, "unknown_harness", `${bot.name}'s harness is not registered`);
      if (!(await this.deps.registry.available(adapter.id))) throw new ChatError(422, "harness_unavailable", `${adapter.displayName} is unavailable right now`);
      const derived = handleFromName(bot.name);
      let handle = entry.handle ?? derived;
      if (handles.has(handle.toLowerCase())) {
        // A handle the user typed must be unique; a derived one just gets a suffix.
        if (entry.handle !== undefined) throw new ChatError(409, "handle_taken", `@${entry.handle} is already used in this room`);
        let suffix = 2;
        while (handles.has(handle.toLowerCase())) handle = `${derived.slice(0, 28)}-${suffix++}`;
      }
      handles.add(handle.toLowerCase());
      members.push({
        id: randomUUID(),
        botId: bot.id,
        handle,
        rank: entry.rank ?? index,
        canLead: entry.canLead ?? true,
        consultable: entry.consultable ?? true,
        consultants: [],
        enabled: true,
        nativeSession: null,
        deliveredSeq: 0,
        sessionRevision: 0,
      });
    }
    let lead: StoredMembership | undefined;
    if (input.leadBotId) {
      const matches = members.filter((member) => member.botId === input.leadBotId);
      if (matches.length !== 1) throw new ChatError(400, "bad_lead", "Name exactly one member as the lead");
      lead = matches[0];
      if (!lead || !lead.canLead) throw new ChatError(400, "bad_lead", "That member cannot be the lead");
    } else {
      // members[0] is the default lead only when it may lead; otherwise the first that may.
      lead = members[0]?.canLead ? members[0] : members.find((member) => member.canLead);
    }
    const now = Date.now();
    const room: StoredRoom = {
      id: randomUUID(),
      name: input.name,
      topic: input.topic ?? null,
      workspaceId: workspace.id,
      workspacePath: workspace.path,
      archived: false,
      leadMemberId: lead?.id ?? null,
      members,
      budgets: defaultBudgets(),
      createdAt: now,
      updatedAt: now,
    };
    // In the map before the index is written: the index is taken from the map.
    this.rooms.set(room.id, room);
    try {
      await this.persistRoom(room);
    } catch (error) {
      this.rooms.delete(room.id);
      throw error;
    }
    this.schedulers.set(room.id, new RoomScheduler());
    await this.store.saveRuntime(room.id, this.scheduler(room.id).runtime());
    return this.roomInfo(room);
  }

  async roomSnapshot(roomId: string): Promise<RoomSnapshot> {
    const room = this.requireRoom(roomId);
    const scheduler = this.scheduler(roomId);
    const records = await this.readAll(roomId);
    const live = [...(this.liveRuns.get(roomId)?.values() ?? [])];
    return {
      room: await this.roomInfo(room),
      records: [...records.slice(-BOARD_HISTORY_PAGE), ...live].sort((a, b) => a.seq - b.seq),
      activeTurn: scheduler.active ? { ...scheduler.active.view } : null,
      queued: this.queuedViews(room, scheduler),
      pending: [...(this.pending.get(roomId)?.values() ?? [])],
      usage: usageOfRecords(records),
      lastEventId: this.events.lastEventId(roomId),
    };
  }

  async patchRoom(roomId: string, input: RoomPatchInput): Promise<RoomInfo> {
    const room = this.requireRoom(roomId);
    if (input.leadMemberId !== undefined) {
      const member = room.members.find((candidate) => candidate.id === input.leadMemberId);
      if (!member) throw new ChatError(400, "unknown_member", "That bot is not a member of this room");
      if (!member.enabled || !member.canLead) throw new ChatError(400, "bad_lead", "@" + member.handle + " cannot be the lead");
      room.leadMemberId = member.id;
    }
    if (input.archived === true && this.scheduler(roomId).running) throw new ChatError(409, "busy", "Stop the room's turn before archiving it");
    if (input.name !== undefined) room.name = input.name;
    if (input.topic !== undefined) room.topic = input.topic;
    if (input.archived !== undefined) room.archived = input.archived;
    if (input.budgets) {
      room.budgets = {
        maxDirectResponders: input.budgets.maxDirectResponders ?? room.budgets.maxDirectResponders,
        maxConsultRequests: input.budgets.maxConsultRequests ?? room.budgets.maxConsultRequests,
        maxInvocations: input.budgets.maxInvocations ?? room.budgets.maxInvocations,
        maxInvocationsPerMember: input.budgets.maxInvocationsPerMember ?? room.budgets.maxInvocationsPerMember,
        turnWallClockMs: input.budgets.turnWallClockMs ?? room.budgets.turnWallClockMs,
        queueMax: input.budgets.queueMax ?? room.budgets.queueMax,
      };
    }
    room.updatedAt = Date.now();
    await this.persistRoom(room);
    this.emitRoom(room);
    return this.roomInfo(room);
  }

  async addMember(roomId: string, input: MemberAddInput): Promise<RoomInfo> {
    const room = this.requireRoom(roomId);
    if (room.members.length >= BOARD_MAX_MEMBERS) throw new ChatError(409, "room_full", `A room holds at most ${BOARD_MAX_MEMBERS} bots`);
    const bot = this.requireBot(input.botId);
    const adapter = this.deps.registry.get(bot.harnessId);
    if (!adapter || !(await this.deps.registry.available(adapter.id))) throw new ChatError(422, "harness_unavailable", `${bot.name}'s harness is unavailable right now`);
    if (room.members.some((member) => member.handle.toLowerCase() === input.handle.toLowerCase())) throw new ChatError(409, "handle_taken", `@${input.handle} is already used in this room`);
    for (const id of input.consultants) {
      if (!room.members.some((member) => member.id === id)) throw new ChatError(400, "bad_consultants", "A consultation allowlist names a member that is not in this room");
    }
    const member: StoredMembership = {
      id: randomUUID(),
      botId: bot.id,
      handle: input.handle,
      rank: input.rank ?? Math.max(-1, ...room.members.map((existing) => existing.rank)) + 1,
      canLead: input.canLead ?? false,
      consultable: input.consultable ?? true,
      consultants: [...new Set(input.consultants)],
      enabled: true,
      nativeSession: null,
      deliveredSeq: 0,
      sessionRevision: 0,
    };
    room.members.push(member);
    room.updatedAt = Date.now();
    await this.persistRoom(room);
    this.emitRoom(room);
    return this.roomInfo(room);
  }

  async patchMember(roomId: string, memberId: string, input: MemberPatchInput): Promise<RoomInfo> {
    const room = this.requireRoom(roomId);
    const member = room.members.find((candidate) => candidate.id === memberId);
    if (!member) throw new ChatError(404, "unknown_member", "No such member in this room");
    const nextHandle = input.handle;
    if (nextHandle !== undefined && room.members.some((other) => other.id !== member.id && other.handle.toLowerCase() === nextHandle.toLowerCase())) {
      throw new ChatError(409, "handle_taken", `@${nextHandle} is already used in this room`);
    }
    if (input.consultants !== undefined) {
      const unique = [...new Set(input.consultants)];
      if (unique.includes(member.id)) throw new ChatError(400, "bad_consultants", "A bot cannot consult itself");
      for (const id of unique) if (!room.members.some((other) => other.id === id)) throw new ChatError(400, "bad_consultants", "A consultation allowlist names a member that is not in this room");
      member.consultants = unique;
    }
    if (input.enabled === false && this.memberBusy(room.id, member.id)) throw new ChatError(409, "member_busy", "@" + member.handle + " is running; stop the turn first");
    if (input.handle !== undefined) member.handle = input.handle;
    if (input.rank !== undefined) member.rank = input.rank;
    if (input.canLead !== undefined) member.canLead = input.canLead;
    if (input.consultable !== undefined) member.consultable = input.consultable;
    if (input.enabled !== undefined) member.enabled = input.enabled;
    if (room.leadMemberId === member.id && (!member.enabled || !member.canLead)) room.leadMemberId = null;
    room.updatedAt = Date.now();
    await this.persistRoom(room);
    this.emitRoom(room);
    return this.roomInfo(room);
  }

  async removeMember(roomId: string, memberId: string): Promise<RoomInfo> {
    const room = this.requireRoom(roomId);
    const member = room.members.find((candidate) => candidate.id === memberId);
    if (!member) throw new ChatError(404, "unknown_member", "No such member in this room");
    if (this.memberBusy(roomId, member.id)) {
      throw new ChatError(409, "member_busy", "This bot is running; stop the turn before removing it");
    }
    await this.pool.disposeMember(roomId, member.id);
    if (member.nativeSession) {
      room.tombstones = [...(room.tombstones ?? []), member.nativeSession];
      this.owned.add(`${member.nativeSession.harnessId}\u0000${member.nativeSession.nativeId}`);
    }
    room.members = room.members.filter((candidate) => candidate.id !== member.id);
    for (const other of room.members) other.consultants = other.consultants.filter((id) => id !== member.id);
    if (room.leadMemberId === member.id) room.leadMemberId = null;
    room.updatedAt = Date.now();
    await this.persistRoom(room);
    this.emitRoom(room);
    return this.roomInfo(room);
  }

  async resetMemberSession(roomId: string, memberId: string): Promise<RoomInfo> {
    const room = this.requireRoom(roomId);
    const member = room.members.find((candidate) => candidate.id === memberId);
    if (!member) throw new ChatError(404, "unknown_member", "No such member in this room");
    if (this.memberBusy(roomId, member.id)) throw new ChatError(409, "member_busy", "@" + member.handle + " is running; stop the turn first");
    await this.pool.disposeMember(roomId, member.id);
    if (member.nativeSession) {
      // The old native session stays the room's forever: it must never reappear as an ordinary chat.
      room.tombstones = [...(room.tombstones ?? []), member.nativeSession];
      this.owned.add(`${member.nativeSession.harnessId}\u0000${member.nativeSession.nativeId}`);
    }
    member.sessionRevision += 1;
    member.nativeSession = null;
    member.deliveredSeq = 0;
    room.updatedAt = Date.now();
    await this.persistRoom(room);
    this.emitRoom(room);
    return this.roomInfo(room);
  }

  // ---- running --------------------------------------------------------------

  async postMessage(roomId: string, input: RoomMessageInput): Promise<{ turn: RoomTurnView; queued: RoomTurnView[] }> {
    const room = this.requireRoom(roomId);
    if (room.archived) throw new ChatError(409, "archived", "This room is archived; unarchive it to send");
    const scheduler = this.scheduler(roomId);
    if (input.clientId) {
      const remembered = scheduler.clientTurns.get(input.clientId);
      if (remembered) return { turn: remembered, queued: this.queuedViews(room, scheduler) };
    }
    const direct = this.directMembers(room, input.mentions);
    if (scheduler.queued.length >= room.budgets.queueMax) {
      throw new ChatError(429, "queue_full", `This room already has ${room.budgets.queueMax} queued turns`);
    }
    const now = Date.now();
    const turnId = randomUUID();
    const mentions = direct.map((member) => member.id);
    // Durable before it is acknowledged: a paid turn must never be lost to a crash.
    await this.append(roomId, [{ kind: "user", id: randomUUID(), at: now, turnId, text: input.text, mentions }]);
    const stored: StoredQueuedTurn = { id: turnId, text: input.text, mentions, ...(input.clientId ? { clientId: input.clientId } : {}), queuedAt: now };
    scheduler.queued.push(stored);
    const view = queuedView(stored, mentions);
    scheduler.remember(input.clientId, view);
    await this.persistRuntime(roomId);
    this.events.emit(roomId, { type: "queue", queued: this.queuedViews(room, scheduler) });
    void this.pump(roomId);
    return { turn: view, queued: this.queuedViews(room, scheduler) };
  }

  private async pump(roomId: string): Promise<void> {
    if (this.pumping.has(roomId)) return;
    this.pumping.add(roomId);
    try {
      for (;;) {
        const room = this.rooms.get(roomId);
        if (!room) return;
        const scheduler = this.scheduler(roomId);
        if (scheduler.running || scheduler.queued.length === 0) return;
        let direct: StoredMembership[];
        try {
          direct = this.directMembers(room, scheduler.queued[0]?.mentions ?? []);
        } catch (error) {
          const dropped = scheduler.queued.shift();
          if (dropped) {
            scheduler.remember(dropped.clientId, { ...queuedView(dropped, []), state: "failed", stopReason: errorMessage(error), endedAt: Date.now() });
            await this.append(roomId, [{ kind: "notice", id: randomUUID(), at: Date.now(), turnId: dropped.id, level: "error", text: `A queued turn could not start: ${errorMessage(error)}` }]);
          }
          await this.persistRuntime(roomId);
          this.events.emit(roomId, { type: "queue", queued: this.queuedViews(room, scheduler) });
          continue;
        }
        let workspace: WorkspaceInfo;
        try {
          workspace = await this.resolveWorkspace(room);
        } catch (error) {
          const dropped = scheduler.queued.shift();
          if (dropped) {
            scheduler.remember(dropped.clientId, { ...queuedView(dropped, direct.map((member) => member.id)), state: "failed", stopReason: errorMessage(error), endedAt: Date.now() });
            await this.append(roomId, [{ kind: "notice", id: randomUUID(), at: Date.now(), turnId: dropped.id, level: "error", text: `The room cannot run: ${errorMessage(error)}` }]);
          }
          await this.persistRuntime(roomId);
          continue;
        }
        const active = scheduler.next(direct.map((member) => member.id));
        if (!active) return;
        const generation = scheduler.generation;
        const budget = createTurnBudget(room.budgets, Date.now());
        await this.persistRuntime(roomId);
        this.emitTurn(roomId, active.view);
        this.events.emit(roomId, { type: "queue", queued: this.queuedViews(room, scheduler) });
        const timer = setTimeout(() => {
          markExpired(budget);
          void this.pool.abortRoom(roomId).catch((error: unknown) => this.deps.log?.(`boards: wall-clock stop failed: ${errorMessage(error)}`));
        }, room.budgets.turnWallClockMs);
        timer.unref();
        this.turnTimers.set(roomId, timer);
        let state: RoomTurnState;
        try {
          const runner = new TurnRunner(this.host(room, active, budget, generation, workspace));
          state = await runner.run();
        } catch (error) {
          await this.append(roomId, [{ kind: "notice", id: randomUUID(), at: Date.now(), turnId: active.view.id, level: "error", text: `The turn failed: ${errorMessage(error)}` }]).catch(() => undefined);
          state = "failed";
        } finally {
          clearTimeout(timer);
          this.turnTimers.delete(roomId);
        }
        if (budget.expired && state === "done") state = "stopped";
        await this.finishTurn(room, active, state, budget);
      }
    } finally {
      this.pumping.delete(roomId);
      const scheduler = this.schedulers.get(roomId);
      // A post that arrived between the loop's last check and the flag clearing starts the pump again.
      if (scheduler && !scheduler.running && scheduler.queued.length > 0) void this.pump(roomId);
    }
  }

  private async finishTurn(room: StoredRoom, active: ActiveTurn, state: RoomTurnState, budget: TurnBudget): Promise<void> {
    const scheduler = this.scheduler(room.id);
    active.view.state = state;
    active.view.endedAt = Date.now();
    active.view.invocationCount = budget.invocations;
    active.view.consultCount = budget.consultRequests;
    if (state === "stopped" && !active.view.stopReason) active.view.stopReason = "Stopped";
    scheduler.update(active.view, active.stored.clientId);
    this.liveRuns.delete(room.id);
    // Settle the runtime on disk before the scheduler forgets the turn: a reader that sees
    // no active turn (a snapshot, then a restart) must not find this finished turn still
    // active in runtime.json. finish() clears it, and the write after it repairs one that
    // a queueing post raced in with while the old turn was still set.
    await this.store.saveRuntime(room.id, { ...scheduler.runtime(), activeTurnId: null });
    scheduler.finish();
    await this.persistRuntime(room.id);
    this.emitTurn(room.id, active.view);
    this.events.emit(room.id, { type: "queue", queued: this.queuedViews(room, scheduler) });
    const handles = active.directMemberIds
      .map((id) => room.members.find((member) => member.id === id)?.handle)
      .filter((handle): handle is string => handle !== undefined)
      .map((handle) => `@${handle}`)
      .join(" ");
    if (state === "failed") this.roomNotify(room.id, "error", room.name, `The turn failed${active.view.stopReason ? `: ${active.view.stopReason}` : ""}`);
    else if (state === "done") this.roomNotify(room.id, "done", room.name, `${handles || "The room"} finished`);
    else if (state === "stopped") this.roomNotify(room.id, "done", room.name, `${handles || "The room"} was stopped`);
  }

  private host(room: StoredRoom, active: ActiveTurn, budget: TurnBudget, generation: number, workspace: WorkspaceInfo): TurnRunnerHost {
    const manager = this;
    const pendingForRoom = (): Map<string, RoomPendingRequest> => {
      let map = manager.pending.get(room.id);
      if (!map) {
        map = new Map();
        manager.pending.set(room.id, map);
      }
      return map;
    };
    return {
      room,
      active,
      budget,
      isCurrent: () => manager.scheduler(room.id).generation === generation && manager.rooms.has(room.id),
      member: (id) => room.members.find((member) => member.id === id),
      bot: (member) => manager.bots.get(member.botId),
      workspace: () => workspace,
      historyAfter: async (seq) => (await manager.store.readRecords(room.id, { limit: MAX_PAGE })).filter((record) => record.seq > seq),
      append: (drafts) => manager.append(room.id, drafts),
      emit: (event: RoomEvent) => manager.events.emit(room.id, event),
      updateTurn: async (state, stopReason) => {
        active.view.state = state;
        active.view.invocationCount = budget.invocations;
        active.view.consultCount = budget.consultRequests;
        if (stopReason !== undefined) active.view.stopReason = stopReason;
        manager.scheduler(room.id).update(active.view, active.stored.clientId);
        await manager.persistRuntime(room.id);
        manager.emitTurn(room.id, active.view);
      },
      persistNative: async (memberId, native) => {
        const member = room.members.find((candidate) => candidate.id === memberId);
        if (!member) return;
        member.nativeSession = native;
        manager.owned.add(`${native.harnessId}\u0000${native.nativeId}`);
        // Native references change on every first run; the list row's order should not.
        await manager.store.saveRoomConfig(room);
      },
      advanceDelivered: async (memberId, seq) => {
        const member = room.members.find((candidate) => candidate.id === memberId);
        if (!member || seq <= member.deliveredSeq) return;
        member.deliveredSeq = seq;
        await manager.store.saveRoomConfig(room);
      },
      invoke: (request: BotInvokeRequest, sink) => manager.pool.invoke(request, sink),
      reserveSeq: () => manager.reserveSeq(room.id),
      startLiveRun: (record) => {
        let runs = manager.liveRuns.get(room.id);
        if (!runs) {
          runs = new Map();
          manager.liveRuns.set(room.id, runs);
        }
        runs.set(record.id, record);
        manager.events.emit(room.id, { type: "record", record });
      },
      endLiveRun: (recordId) => {
        manager.liveRuns.get(room.id)?.delete(recordId);
      },
      notify: (kind, title, body, request) => manager.roomNotify(room.id, kind, title, body, request),
      addPending: (request) => {
        pendingForRoom().set(request.id, request);
        manager.events.emit(room.id, { type: "request", request });
      },
      removePending: (requestId, outcome) => {
        pendingForRoom().delete(requestId);
        manager.events.emit(room.id, { type: "request_resolved", requestId, outcome });
      },
      pendingCount: () => manager.pending.get(room.id)?.size ?? 0,
      pendingEntries: () => [...(manager.pending.get(room.id)?.entries() ?? [])],
    };
  }

  async stop(roomId: string): Promise<void> {
    const room = this.requireRoom(roomId);
    const scheduler = this.scheduler(roomId);
    // Late callbacks from the stopped turn compare this and drop themselves.
    scheduler.generation += 1;
    const active = scheduler.active;
    const hadActive = active !== null;
    if (active) {
      active.view.state = "stopping";
      scheduler.update(active.view, active.stored.clientId);
      await this.persistRuntime(roomId);
      this.emitTurn(roomId, active.view);
    }
    const queued = [...scheduler.queued];
    scheduler.queued = [];
    const now = Date.now();
    for (const stored of queued) {
      scheduler.remember(stored.clientId, { ...queuedView(stored, []), state: "stopped", stopReason: "Stopped before it started", endedAt: now });
    }
    if (queued.length > 0) {
      await this.append(roomId, [
        { kind: "notice", id: randomUUID(), at: now, turnId: null, level: "info", text: `Stopped ${queued.length} queued turn${queued.length === 1 ? "" : "s"} before they ran.` },
      ]);
    }
    await this.persistRuntime(roomId);
    this.events.emit(roomId, { type: "queue", queued: [] });
    try {
      await this.pool.abortRoom(roomId);
    } catch (error) {
      await this.append(roomId, [{ kind: "notice", id: randomUUID(), at: Date.now(), turnId: scheduler.active?.view.id ?? null, level: "warning", text: `Stop did not finish cleanly: ${errorMessage(error)}` }]);
    }
    if (hadActive) {
      await scheduler.settled();
      if (scheduler.active && scheduler.active.view.state !== "stopped") {
        scheduler.active.view.state = "stopped";
        await this.persistRuntime(roomId);
        this.emitTurn(roomId, scheduler.active.view);
      }
    }
  }

  async cancelQueued(roomId: string, turnId: string): Promise<RoomTurnView[]> {
    const room = this.requireRoom(roomId);
    const scheduler = this.scheduler(roomId);
    const at = scheduler.queued.findIndex((stored) => stored.id === turnId);
    if (at < 0) {
      if (scheduler.active?.view.id === turnId) throw new ChatError(409, "turn_running", "That turn is already running; stop it instead");
      throw new ChatError(404, "no_turn", "That turn is no longer queued");
    }
    const [stored] = scheduler.queued.splice(at, 1);
    if (stored) scheduler.remember(stored.clientId, { ...queuedView(stored, []), state: "stopped", stopReason: "Cancelled before it started", endedAt: Date.now() });
    await this.persistRuntime(roomId);
    const queued = this.queuedViews(room, scheduler);
    this.events.emit(roomId, { type: "queue", queued });
    return queued;
  }

  async answerRequest(roomId: string, requestId: string, answer: InteractionAnswer): Promise<void> {
    this.requireRoom(roomId);
    const pending = this.pending.get(roomId)?.get(requestId);
    if (!pending) throw new ChatError(409, "request_resolved", "That request was already answered or cancelled");
    this.pool.answer(roomId, requestId, answer);
  }

  // ---- reading --------------------------------------------------------------

  async roomHistory(roomId: string, query: { before?: number; limit?: number }): Promise<RoomRecord[]> {
    this.requireRoom(roomId);
    const limit = Math.min(BOARD_HISTORY_PAGE, Math.max(1, query.limit ?? BOARD_HISTORY_PAGE));
    return composeRecords(await this.store.readRecords(roomId, { ...(query.before !== undefined ? { before: query.before } : {}), limit }));
  }

  async roomUsage(roomId: string): Promise<BoardUsage & { byMember: Array<{ memberId: string; totals: BoardUsage }> }> {
    this.requireRoom(roomId);
    const records = await this.readAll(roomId);
    const byMember = new Map<string, BoardUsage>();
    for (const record of records) {
      if (record.kind !== "bot_run" || !record.usage) continue;
      byMember.set(record.memberId, addUsage(byMember.get(record.memberId) ?? emptyUsage(), record.usage));
    }
    return {
      ...usageOfRecords(records),
      byMember: [...byMember.entries()].map(([memberId, totals]) => ({ memberId, totals })),
    };
  }

  async exportRoom(roomId: string): Promise<string> {
    const room = this.requireRoom(roomId);
    const records = await this.readAll(roomId);
    const lines: string[] = [`# ${room.name}`, ""];
    if (room.topic) lines.push(`_${room.topic}_`, "");
    lines.push(`- Workspace: ${await this.workspaceName(room)}`, `- Lead: ${this.validLead(room)?.handle ?? "(none)"}`, "");
    let turnSeen = 0;
    for (const record of records) {
      switch (record.kind) {
        case "user": {
          turnSeen += 1;
          const handles = record.mentions
            .map((id) => room.members.find((member) => member.id === id)?.handle)
            .filter((handle): handle is string => handle !== undefined)
            .map((handle) => `@${handle}`)
            .join(" ");
          lines.push("", `## Turn ${turnSeen} — ${new Date(record.at).toISOString()}`, `**You**${handles ? ` → ${handles}` : ""}`, "", quoteText(record.text), "");
          break;
        }
        case "bot_run": {
          const handle = room.members.find((member) => member.id === record.memberId)?.handle ?? record.memberId;
          lines.push("", `### @${handle} — ${record.status}${record.consultOf ? " (consultation answer)" : ""}`, "", `- Model: ${record.model ?? "harness default"}`, `- Latency: ${record.latencyMs === null ? "unknown" : `${record.latencyMs} ms`}`);
          lines.push(`- Effort: ${record.thinkingLevel ?? "harness default"}`);
          if (record.usage) lines.push(`- Usage: ${usageLine(record.usage)}`);
          if (record.error) lines.push(`- Error: ${record.error}`);
          lines.push("");
          for (const item of record.items) {
            if (item.kind === "assistant" && item.text.trim().length > 0) lines.push(item.text, "");
            else if (item.kind === "tool") lines.push(`- \`${item.name}\` ${item.summary}`, "", fenced(item.output));
            else if (item.kind === "notice") lines.push(`> system (${item.level}): ${item.text}`);
          }
          break;
        }
        case "consultation": {
          const from = room.members.find((member) => member.id === record.fromMemberId)?.handle ?? record.fromMemberId;
          const to = room.members.find((member) => member.id === record.toMemberId)?.handle ?? record.toMemberId;
          lines.push("", `#### Consultation @${from} → @${to}: ${record.outcome}`, "", quoteText(record.question));
          if (record.reason) lines.push(`_${record.reason}_`);
          break;
        }
        case "notice":
          lines.push("", `> system (${record.level}): ${record.text}`);
          break;
      }
    }
    const text = `${lines.join("\n").trim()}\n`;
    return text.length > MAX_EXPORT_CHARS ? `${text.slice(0, MAX_EXPORT_CHARS)}\n\n[export truncated]\n` : text;
  }

  /**
   * Publish a room's summary to the overview stream after it emitted, whether or not
   * anyone is viewing it, so the sidebar follows turns and approvals in other rooms.
   * Computed from the room's own records and scheduler, never a harness projection.
   */
  private summarySoon(roomId: string): void {
    if (this.summariesDue.has(roomId)) return;
    this.summariesDue.add(roomId);
    setImmediate(() => {
      this.summariesDue.delete(roomId);
      const room = this.rooms.get(roomId);
      if (room) void this.roomSummary(room).then(noteRoom).catch(() => undefined);
    });
  }

  async subscribe(roomId: string, subscriber: RoomSubscriber, lastEventId?: number): Promise<() => void> {
    this.requireRoom(roomId);
    if (this.events.canReplay(roomId, lastEventId)) {
      return this.events.subscribe(roomId, subscriber, lastEventId, () => {
        throw new Error("A replayed room stream never needs a snapshot");
      });
    }
    // Snapshot first, then subscribe: the log replays whatever landed after the
    // snapshot, so events emitted in the gap are not lost.
    const snapshot = await this.roomSnapshot(roomId);
    return this.events.subscribeWithSnapshot(roomId, subscriber, snapshot);
  }

  ownsNativeSession(harnessId: string, nativeId: string): boolean {
    return this.owned.has(`${harnessId}\u0000${nativeId}`);
  }
}

function quoteText(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function fenced(output: string): string {
  const bounded = output.length > 1_500 ? `${output.slice(0, 1_500)}\n[output truncated]` : output;
  return ["```", bounded.replace(/```/g, "'''"), "```"].join("\n");
}
