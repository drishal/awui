// Board's internal contract: the stored shapes the store persists, the
// runtime shapes the scheduler keeps, and the interfaces between the modules
// (store, event log, session pool, manager). Everything here is settled
// before the modules are written, so store/CRUD and the run engine can be
// built against it independently; the wire shapes live in protocol.ts and
// never carry a native session id or internal chat id.
//
// One rule runs through all of it: the server is the only routing authority.
// Models ask through a parsed control document; quoted bot output never
// authorizes anything.
import type { z } from "zod";
import type {
  botCreateSchema,
  botPatchSchema,
  memberAddSchema,
  memberPatchSchema,
  roomCreateSchema,
  roomMessageSchema,
  roomPatchSchema,
  BoardUsage,
  BotProfile,
  ChatItem,
  InteractionAnswer,
  InteractionRequest,
  PushNote,
  RoomBudgets,
  RoomEvent,
  RoomInfo,
  RoomRecord,
  RoomSnapshot,
  RoomSummary,
  RoomTurnView,
  WorkspaceInfo,
} from "../../shared/protocol.js";
import type { ChatOwner, Chat } from "../chats/chat.js";
import type { ChatManager } from "../chats/manager.js";
import type { HarnessRegistry } from "../harness/registry.js";
import type { Workspaces } from "../workspaces.js";

export type { ChatOwner, RoomBudgets };

// ---- inputs (the routes parse; the manager takes them typed) --------------

export type BotCreateInput = z.infer<typeof botCreateSchema>;
export type BotPatchInput = z.infer<typeof botPatchSchema>;
export type RoomCreateInput = z.infer<typeof roomCreateSchema>;
export type RoomPatchInput = z.infer<typeof roomPatchSchema>;
export type MemberAddInput = z.infer<typeof memberAddSchema>;
export type MemberPatchInput = z.infer<typeof memberPatchSchema>;
export type RoomMessageInput = z.infer<typeof roomMessageSchema>;

// ---- the consultation protocol (§9) ----------------------------------------

/** The exact envelope a direct responder's whole final answer must be to ask for help. */
export const CONSULT_MARKER_BEGIN = "<<<AWUI_BOARD_CONTROL";
export const CONSULT_MARKER_END = "AWUI_BOARD_CONTROL";
/** One consult request as the control document carries it: a room handle and a bounded question. */
export interface ConsultAsk {
  to: string;
  question: string;
}

// ---- stored shapes (what the store writes) ---------------------------------

/** A bot profile as persisted: same as the wire shape, ids server-generated. */
export interface StoredBot extends BotProfile {}

/**
 * A bot's identity inside one room. `nativeSession` is server-only: the
 * harness session this membership owns (one per session revision), resumed
 * only through the BoardManager. `deliveredSeq` is the last room record the
 * member's own prompt envelope already carried, so history is sent once, not
 * every call.
 */
export interface StoredMembership {
  id: string;
  botId: string;
  handle: string;
  rank: number;
  canLead: boolean;
  consultable: boolean;
  consultants: string[];
  enabled: boolean;
  nativeSession: { harnessId: string; nativeId: string } | null;
  deliveredSeq: number;
  /** Increments on an explicit Reset session; the old native files are never touched. */
  sessionRevision: number;
}

export interface StoredRoom {
  id: string;
  name: string;
  topic: string | null;
  workspaceId: string;
  /**
   * The workspace's real path, kept so a restart can re-open and re-validate it
   * through Workspaces (whose ids are in-memory); never sent to the browser.
   */
  workspacePath: string;
  archived: boolean;
  leadMemberId: string | null;
  members: StoredMembership[];
  budgets: RoomBudgets;
  /**
   * Native sessions this room once owned but whose membership was removed:
   * ownership tombstones. They stay claimed forever so a removed member's
   * session can never reappear as an ordinary chat (plan §6.3).
   */
  tombstones?: Array<{ harnessId: string; nativeId: string }>;
  createdAt: number;
  updatedAt: number;
}

/** rooms.json's row: enough to list rooms without opening every config. */
export interface StoredRoomIndexEntry {
  id: string;
  name: string;
  archived: boolean;
  updatedAt: number;
}

/** A user turn waiting to run, as runtime.json keeps it across a restart. */
export interface StoredQueuedTurn {
  id: string;
  text: string;
  mentions: string[];
  clientId?: string;
  queuedAt: number;
}

/** The per-room state a restart needs: what was active or queued, and which cancellation generation owned it. */
export interface StoredRuntime {
  activeTurnId: string | null;
  queue: StoredQueuedTurn[];
  /** Bumped by every stop; late events from an older generation are ignored. */
  generation: number;
  /**
   * Recently posted clientId -> the turn as it stood, so a retried post answers
   * the first turn instead of creating a second (bounded by the manager).
   */
  clientTurns?: Array<{ clientId: string; turn: RoomTurnView }>;
}

export interface BoardStoreContents {
  schemaVersion: number;
  bots: StoredBot[];
  rooms: StoredRoom[];
  runtimes: Record<string, StoredRuntime>;
}

// ---- the store (store.ts implements; stronger than state-file.ts on purpose) --

/**
 * Board's own persistence. Unlike `state-file.ts` (side features, failures
 * swallowed), a refused or failed write must surface: a user message is not
 * acknowledged until its record is durable, and a malformed store is an
 * explicit room error, never a silent empty replacement.
 */
export interface BoardStore {
  /** Validate and load everything. Throws on a malformed or future-version store. */
  load(): Promise<BoardStoreContents>;
  saveBots(bots: StoredBot[]): Promise<void>;
  saveRoomsIndex(rooms: StoredRoomIndexEntry[]): Promise<void>;
  saveRoomConfig(room: StoredRoom): Promise<void>;
  /** Append settled records; resolves only once they are on disk. Seqs are already minted. */
  appendRecords(roomId: string, records: RoomRecord[]): Promise<void>;
  /** One page, newest last, ending before `before`'s seq when given. */
  readRecords(roomId: string, opts: { before?: number; limit: number }): Promise<RoomRecord[]>;
  saveRuntime(roomId: string, runtime: StoredRuntime): Promise<void>;
  /** The runtime as last persisted (null before the room ever ran). */
  readRuntime(roomId: string): Promise<StoredRuntime | null>;
}

// ---- the room event log (events.ts implements) ------------------------------

/** A room stream's consumer; the same shape as an ordinary chat's subscriber. */
export interface RoomSubscriber {
  send(id: number, event: RoomEvent): void;
  close(): void;
}

/**
 * Per-room SSE fan-out with the same semantics as `chats/chat.ts`'s EventLog:
 * monotonic event ids, a bounded replay tail, and a snapshot for anyone too
 * far back to replay.
 */
export interface RoomEventLog {
  /** Assign the next event id, keep a bounded tail, fan out. */
  emit(roomId: string, event: RoomEvent): void;
  subscribe(roomId: string, subscriber: RoomSubscriber, lastEventId: number | undefined, snapshot: () => RoomSnapshot): () => void;
  /** The last event id minted for a room (0 before any): what a snapshot's `lastEventId` carries. */
  lastEventId(roomId: string): number;
  /** The room is gone (deleted from view): close its subscribers. */
  closeRoom(roomId: string): void;
}

// ---- the bot session pool (sessions.ts implements) --------------------------

/** What an invocation needs to run: the member, its bot, the room's workspace, and the built prompt. */
export interface BotInvokeRequest {
  /** The runner's id for this run; projected item and request ids are namespaced with it. */
  invocationId: string;
  /**
   * True for a direct responder: its assistant text is withheld until the
   * settled answer is classified, so a control document never flashes as an answer.
   */
  bufferText: boolean;
  room: StoredRoom;
  member: StoredMembership;
  bot: StoredBot;
  workspace: WorkspaceInfo;
  /** The full server-built envelope (context.ts); the only prompt the harness ever sees. */
  prompt: string;
  owner: ChatOwner;
}

/** Where a live invocation's stream lands: the room's event flow, not the native chat's. */
export interface BotEventSink {
  /** Items with ids already namespaced `<invocationId>:<itemId>`, bounded to BOARD_MAX_RUN_ITEMS. */
  onItem(item: ChatItem): void;
  onDelta(itemId: string, field: "text" | "thinking" | "output", append: string): void;
  onStatus(status: "running" | "done" | "failed" | "stopped"): void;
  /** A request the bot's harness raised; the room surfaces it and only the user answers. */
  onRequest(request: InteractionRequest): void;
  onRequestResolved(requestId: string, outcome: string): void;
  /** The harness assigned the native session: persist the reference before anything else (a rejected promise fails the invocation). */
  onNativeSession(native: { harnessId: string; nativeId: string }): void | Promise<void>;
}

/** One finished invocation, as the turn runner records it. */
export interface BotRunResult {
  status: "done" | "failed" | "stopped";
  /** False when the harness refused the prompt, so the delivered-history cursor must not move. */
  accepted: boolean;
  items: ChatItem[];
  usage: BoardUsage | null;
  latencyMs: number | null;
  /** The model and effort in force at settlement, from the confirmed ChatConfig (not the profile's request). */
  model: string | null;
  thinkingLevel: string | null;
  /** The settled final assistant text: the only text consult parsing ever sees. */
  finalText: string;
  error?: string;
}

/** A run in flight: what Stop needs to reach. */
export interface BotRunHandle {
  invocationId: string;
  chat: Chat;
  done: Promise<BotRunResult>;
}

/**
 * Create-or-resume each membership's own native session and run one
 * invocation at a time through it. Applies model/thinking/permission while
 * idle and refuses a stale setting before spending the turn; ignores the
 * native history before the invocation (only items this run creates are
 * projected); detaches its subscription once settled so idle reaping still
 * works (a permanent viewer would pin the chat open).
 */
export interface BotSessionPool {
  invoke(req: BotInvokeRequest, sink: BotEventSink): Promise<BotRunHandle>;
  /** Abort every live invocation of a room; a bounded teardown reports a harness that refuses to stop. */
  abortRoom(roomId: string): Promise<void>;
  /** Drop the room's live chats (Reset session, room teardown). Native files stay. */
  disposeRoom(roomId: string): Promise<void>;
  /** Drop one membership's live chat only (Reset session, member removal). Native files stay. */
  disposeMember(roomId: string, memberId: string): Promise<void>;
  /** Answer a pending harness request of this room; `requestId` is the namespaced `<invocationId>:<requestId>` the room carries. Returns the outcome wording. */
  answer(roomId: string, requestId: string, answer: import("../../shared/protocol.js").InteractionAnswer): string;
}

// ---- the manager (manager.ts implements; what app.ts, index.ts, and tests see) --

export interface BoardDeps {
  registry: HarnessRegistry;
  workspaces: Workspaces;
  chats: ChatManager;
  /** The server's state folder; boards live under `<stateDir>/boards/`. */
  stateDir: string;
  log?: (line: string) => void;
  /** Room-level news (a turn done, failed, or waiting on a request), in place of per-chat ordinary news. */
  notify?: (note: { kind: PushNote["kind"]; roomId: string; title: string; body: string; request?: InteractionRequest }) => void;
}

/**
 * Board's front door. CRUD is validated against the registry and workspaces
 * (harness availability, model catalogs, capability honesty); running is
 * delegated to the per-room scheduler. Also the ownership oracle the
 * ordinary surfaces filter by: a board-owned native session never appears in
 * an ordinary session list, search, usage, or resume route.
 */
export interface BoardManager {
  /** Load the store and mark persisted active/queued turns interrupted; never auto-resume paid work. */
  start(): Promise<void>;
  /** Stop every scheduler and dispose room chats; runs before ChatManager.shutdown. */
  shutdown(): Promise<void>;

  listBots(): Promise<BotProfile[]>;
  createBot(input: BotCreateInput): Promise<BotProfile>;
  patchBot(id: string, input: BotPatchInput): Promise<BotProfile>;
  /** Only a profile no room uses; otherwise a 409 explains what to do instead. */
  deleteBot(id: string): Promise<void>;

  listRooms(): Promise<RoomSummary[]>;
  createRoom(input: RoomCreateInput): Promise<RoomInfo>;
  roomSnapshot(roomId: string): Promise<RoomSnapshot>;
  patchRoom(roomId: string, input: RoomPatchInput): Promise<RoomInfo>;
  addMember(roomId: string, input: MemberAddInput): Promise<RoomInfo>;
  patchMember(roomId: string, memberId: string, input: MemberPatchInput): Promise<RoomInfo>;
  removeMember(roomId: string, memberId: string): Promise<RoomInfo>;
  resetMemberSession(roomId: string, memberId: string): Promise<RoomInfo>;

  /** Persist the user message durably, then queue the turn. 202-shaped: the turn runs on its own. */
  postMessage(roomId: string, input: RoomMessageInput): Promise<{ turn: RoomTurnView; queued: RoomTurnView[] }>;
  stop(roomId: string): Promise<void>;
  cancelQueued(roomId: string, turnId: string): Promise<RoomTurnView[]>;
  /** `requestId` is the namespaced `<invocationId>:<requestId>` the room pending list carries. */
  answerRequest(roomId: string, requestId: string, answer: InteractionAnswer): Promise<void>;
  roomHistory(roomId: string, query: { before?: number; limit?: number }): Promise<RoomRecord[]>;
  roomUsage(roomId: string): Promise<BoardUsage & { byMember: Array<{ memberId: string; totals: BoardUsage }> }>;
  /** The whole room as Markdown, nested consultations included, from records only. */
  exportRoom(roomId: string): Promise<string>;
  /**
   * A live room stream. Async because a snapshot needs the persisted records;
   * the manager takes it before subscribing and replays from its lastEventId,
   * so nothing emitted in between is lost.
   */
  subscribe(roomId: string, subscriber: RoomSubscriber, lastEventId?: number): Promise<() => void>;

  /** The ordinary surfaces' filter: is this native session a board membership's own? */
  ownsNativeSession(harnessId: string, nativeId: string): boolean;
}
