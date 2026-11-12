// The bot session pool: each room membership owns one native harness session,
// created or resumed through ChatManager with an internal owner so ordinary
// surfaces keep it out. One invocation at a time per membership; the projection
// subscription lives only for the invocation, so idle reaping still works.
import { BOARD_MAX_RUN_ITEMS, type ChatEvent, type ChatItem, type ConfigPatch, type InteractionAnswer } from "../../shared/protocol.js";
import { ChatError, errorMessage, type Chat } from "../chats/chat.js";
import type { ChatManager } from "../chats/manager.js";
import type { HarnessAdapter } from "../harness/types.js";
import type { HarnessRegistry } from "../harness/registry.js";
import type { Workspaces } from "../workspaces.js";
import { usageDelta } from "./budget.js";
import type { BotEventSink, BotInvokeRequest, BotRunHandle, BotRunResult, BotSessionPool } from "./types.js";

/** Promise.withResolvers needs ES2024; this project compiles to ES2023. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * A run's record is bounded like every other harness payload: the first and
 * last items survive with an explicit marker for what was cut, so a huge run
 * cannot bloat a room record.
 */
export function boundRunItems(items: ChatItem[], invocationId: string, max = BOARD_MAX_RUN_ITEMS): ChatItem[] {
  // A room keeps a portable projection, and a picture's id names bytes this process holds (image-store.ts re-reads
  // them from a session file; a room has none). The row keeps its text; the thumbnail would only 404 after a restart.
  const portable = items.map((item) => {
    if (item.kind !== "tool" || !item.images) return item;
    const { images: _pictures, ...rest } = item;
    return rest;
  });
  if (portable.length <= max) return portable;
  const head = portable.slice(0, 100);
  const tail = portable.slice(-(max - 101));
  const omitted = portable.length - head.length - tail.length;
  const marker: ChatItem = {
    kind: "notice",
    id: `${invocationId}:truncated`,
    level: "warning",
    text: `${omitted} earlier run item${omitted === 1 ? "" : "s"} were omitted so this run stays bounded.`,
  };
  return [...head, marker, ...tail];
}

interface LiveInvocation {
  roomId: string;
  memberId: string;
  chat: Chat;
}

export interface BotSessionPoolOptions {
  registry: HarnessRegistry;
  chats: ChatManager;
  workspaces: Workspaces;
  log: (line: string) => void;
}

/** Input a bot's profile asks of its harness, applied only when the harness can honour it. */
function configPatchFor(req: BotInvokeRequest, chat: Chat): ConfigPatch {
  const config = chat.snapshot().config;
  const caps = chat.adapter.capabilities;
  const patch: ConfigPatch = {};
  if (req.bot.model !== null && config.model !== req.bot.model) patch.model = req.bot.model;
  if (req.bot.thinkingLevel !== null) {
    if (!caps.supportsThinkingLevel) throw new ChatError(422, "stale_setting", `${chat.adapter.displayName} has no thinking levels, so this bot's level cannot be applied`);
    const offered = config.thinkingLevels ?? [];
    if (offered.length > 0 && !offered.includes(req.bot.thinkingLevel)) {
      throw new ChatError(422, "stale_setting", `${chat.adapter.displayName} no longer offers the thinking level "${req.bot.thinkingLevel}"; edit the bot`);
    }
    if (config.thinkingLevel !== req.bot.thinkingLevel) patch.thinkingLevel = req.bot.thinkingLevel;
  }
  if (req.bot.permissionMode !== null) {
    if (!caps.supportsPermissionMode) throw new ChatError(422, "stale_setting", `${chat.adapter.displayName} has no permission modes, so this bot's mode cannot be applied`);
    const offered = config.permissionModes ?? [];
    if (offered.length > 0 && !offered.some((mode) => mode.id === req.bot.permissionMode)) {
      throw new ChatError(422, "stale_setting", `${chat.adapter.displayName} no longer offers the permission mode "${req.bot.permissionMode}"; edit the bot`);
    }
    if (config.permissionMode !== req.bot.permissionMode) patch.permissionMode = req.bot.permissionMode;
  }
  return patch;
}

export class BotSessionPoolImpl implements BotSessionPool {
  private readonly registry: HarnessRegistry;
  private readonly chats: ChatManager;
  private readonly workspaces: Workspaces;
  private readonly log: (line: string) => void;
  /** In-flight invocations, what Stop and an approval answer reach. */
  private readonly live = new Map<string, LiveInvocation>();
  /** Every chat this pool opened, by room and member: Reset and teardown dispose them. */
  private readonly roomChats = new Map<string, Map<string, { chat: Chat; memberId: string }>>();

  constructor(options: BotSessionPoolOptions) {
    this.registry = options.registry;
    this.chats = options.chats;
    this.workspaces = options.workspaces;
    this.log = options.log;
  }

  private remember(roomId: string, memberId: string, chat: Chat): void {
    let chats = this.roomChats.get(roomId);
    if (!chats) {
      chats = new Map();
      this.roomChats.set(roomId, chats);
    }
    chats.set(chat.chatId, { chat, memberId });
  }

  /** A chat's existence is not enough: the workspace must still be one this server may open. */
  private async openChat(req: BotInvokeRequest, adapter: HarnessAdapter): Promise<Chat> {
    const problem = adapter.workspaceProblem(req.workspace.path);
    if (problem) throw new ChatError(422, "workspace_unsupported", problem);
    const native = req.member.nativeSession;
    if (native && native.harnessId !== adapter.id) {
      // A profile edited to another harness must not inherit a session it does not own.
      throw new ChatError(409, "session_harness_mismatch", "This membership's session belongs to another harness; reset the session first");
    }
    if (native) {
      try {
        return await this.chats.resume(adapter, req.workspace, native.nativeId, req.owner);
      } catch (error) {
        throw new ChatError(409, "session_unavailable", `This membership's ${adapter.displayName} session cannot be resumed: ${errorMessage(error)}`);
      }
    }
    try {
      return await this.chats.create(adapter, req.workspace, req.owner);
    } catch (error) {
      if (error instanceof ChatError) throw error;
      throw new ChatError(502, "harness_init_failed", `${adapter.displayName} failed to start: ${errorMessage(error)}`);
    }
  }

  async invoke(req: BotInvokeRequest, sink: BotEventSink): Promise<BotRunHandle> {
    const adapter = this.registry.get(req.bot.harnessId);
    if (!adapter) throw new ChatError(422, "unknown_harness", `No harness "${req.bot.harnessId}" is registered`);
    if (!(await this.registry.available(adapter.id))) throw new ChatError(422, "harness_unavailable", `${adapter.displayName} is unavailable right now`);
    const chat = await this.openChat(req, adapter);
    this.remember(req.room.id, req.member.id, chat);

    // Model, effort, and permission come from the bot's profile but are applied
    // here and confirmed: a stale setting fails the invocation before the turn
    // is spent, instead of silently running with a different configuration.
    const patch = configPatchFor(req, chat);
    if (Object.keys(patch).length > 0) await chat.setConfig(patch);
    const confirmed = chat.snapshot().config;
    if (req.bot.model !== null && confirmed.model !== req.bot.model) {
      throw new ChatError(422, "stale_setting", `${adapter.displayName} did not accept the model "${req.bot.model}". Change the bot's model in Members → Profile (the picker lists what ${adapter.displayName} offers here).`);
    }
    if (req.bot.thinkingLevel !== null && confirmed.thinkingLevel !== req.bot.thinkingLevel) {
      throw new ChatError(422, "stale_setting", `${adapter.displayName} did not accept the thinking level "${req.bot.thinkingLevel}". Change it in Members → Profile.`);
    }

    let nativePersisted = req.member.nativeSession?.nativeId ?? null;
    const persistNative = async (): Promise<void> => {
      const nativeId = chat.nativeId;
      if (!nativeId || nativeId === nativePersisted) return;
      // Persist before anything else: a session assigned by the harness but not
      // recorded would be unowned, and could reappear as an ordinary chat.
      await sink.onNativeSession({ harnessId: adapter.id, nativeId });
      nativePersisted = nativeId;
    };
    await persistNative();

    const before = chat.snapshot();
    const projected = new Map<string, ChatItem>();
    const accepted = { value: false };
    const startedAt = Date.now();
    const result = deferred<BotRunResult>();
    let finished = false;

    const project = (event: ChatEvent): void => {
      switch (event.type) {
        case "item": {
          // The invocation prompt is a native user item; the room already has its
          // own user record and must not echo the internal envelope.
          if (event.item.kind === "user") return;
          // Requests are answered by their room-scoped id, so the item carries it too.
          const scoped = event.item.kind === "request" ? { ...event.item, request: { ...event.item.request, id: `${req.invocationId}:${event.item.request.id}` } } : event.item;
          const item = { ...scoped, id: `${req.invocationId}:${scoped.id}` } as ChatItem;
          projected.set(item.id, item);
          const buffered = req.bufferText && item.kind === "assistant";
          if (!buffered) sink.onItem(item);
          return;
        }
        case "delta":
          // A direct responder's whole assistant item is buffered until its
          // answer is classified: a control document must never flash as a
          // user-facing answer, and deltas to an unseen item would leave a ghost.
          if (req.bufferText) return;
          sink.onDelta(`${req.invocationId}:${event.itemId}`, event.field, event.append);
          return;
        case "request":
          sink.onRequest({ ...event.request, id: `${req.invocationId}:${event.request.id}` });
          return;
        case "request_resolved":
          sink.onRequestResolved(`${req.invocationId}:${event.requestId}`, event.outcome, event.denialReason);
          return;
        case "title":
          if (event.sessionId) void persistNative().catch((error: unknown) => this.log(`boards: could not record a native session: ${errorMessage(error)}`));
          return;
        case "disposed":
          if (!finished) finish("failed", "The chat was closed before the run settled");
          return;
        default:
          return;
      }
    };

    // Snapshot first, then subscribe from its lastEventId: anything emitted
    // between the two replays instead of being lost.
    const unsubscribe = chat.subscribe({ send: (_id, event) => project(event), close: () => undefined }, before.lastEventId);

    const finish = (status: BotRunResult["status"], error?: string): void => {
      if (finished) return;
      finished = true;
      unsubscribe();
      const after = chat.snapshot();
      // Only what this invocation emitted: the subscription started after the snapshot.
      const items = boundRunItems([...projected.values()], req.invocationId);
      const finalAssistant = [...items].reverse().find((item) => item.kind === "assistant" && item.text.trim().length > 0);
      const runResult: BotRunResult = {
        status,
        accepted: accepted.value,
        items,
        usage: usageDelta(before.usage, after.usage),
        latencyMs: Date.now() - startedAt,
        model: after.config.model,
        thinkingLevel: after.config.thinkingLevel,
        finalText: finalAssistant?.kind === "assistant" ? finalAssistant.text : "",
        ...(error ? { error } : {}),
      };
      this.live.delete(req.invocationId);
      result.resolve(runResult);
    };

    this.live.set(req.invocationId, { roomId: req.room.id, memberId: req.member.id, chat });

    // The run goes on without the caller: Stop reaches the chat through `live`.
    void (async () => {
      try {
        await chat.send(req.prompt, "normal");
        accepted.value = true;
        await persistNative();
      } catch (error) {
        finish("failed", errorMessage(error));
        return;
      }
      try {
        // waitSettled resolves at its 20s cap even when the chat is still running (a bot
        // waiting on an approval is running); a run is over only at a terminal status.
        // The turn's wall clock is the real bound: it aborts the room's chats.
        await this.waitTerminal(chat);
      } catch (error) {
        finish("failed", errorMessage(error));
        return;
      }
      await persistNative().catch((error: unknown) => {
        // A session id that could not be written is a failure of the invocation,
        // not a silent unowned session.
        finish("failed", `Could not record this bot's native session: ${errorMessage(error)}`);
      });
      if (finished) return;
      // A harness error surfaces as an assistant item's error (or a chat in error): both fail the invocation.
      const errored = [...projected.values()].reverse().find((item) => item.kind === "assistant" && item.error);
      const error = errored?.kind === "assistant" ? errored.error : chat.status === "error" ? "The harness reported an error" : undefined;
      finish(error ? "failed" : "done", error);
    })();

    return { invocationId: req.invocationId, chat, done: result.promise };
  }

  /** Wait until the chat reaches a terminal status (idle, error, disposed). The turn's wall clock bounds it: Stop aborts the room's chats, which settles them. */
  private async waitTerminal(chat: Chat): Promise<void> {
    while (chat.status !== "idle" && chat.status !== "error" && chat.status !== "disposed") {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  private async settleChats(entries: Array<{ chat: Chat }>, what: string): Promise<void> {
    const pending = entries.filter(({ chat }) => chat.status !== "disposed");
    if (pending.length === 0) return;
    // Track completion per chat: a chat can look idle while its harness still
    // refuses to let go, and then the status is not the signal that matters.
    const finished = new Set<string>();
    const aborts = pending.map(async ({ chat }) => {
      await chat.abort().catch(() => undefined);
      finished.add(chat.chatId);
    });
    const timer = deferred<void>();
    const timeout = setTimeout(() => timer.resolve(), 5_000);
    timeout.unref();
    try {
      await Promise.race([Promise.all(aborts), timer.promise]);
    } finally {
      clearTimeout(timeout);
    }
    const stuck = pending.filter(({ chat }) => !finished.has(chat.chatId));
    if (stuck.length > 0) {
      throw new ChatError(504, "stop_timeout", `${what}: ${stuck.length} bot${stuck.length === 1 ? "" : "s"} did not stop within 5s; partial state was kept`);
    }
  }

  async abortRoom(roomId: string): Promise<void> {
    const entries = [...(this.roomChats.get(roomId)?.values() ?? [])];
    await this.settleChats(entries, "Stop timed out");
  }

  async disposeRoom(roomId: string): Promise<void> {
    const entries = [...(this.roomChats.get(roomId)?.values() ?? [])];
    this.roomChats.delete(roomId);
    for (const { chat } of entries) {
      if (chat.status !== "disposed") await chat.dispose("The room was closed").catch(() => undefined);
    }
    for (const [invocationId, live] of this.live) if (live.roomId === roomId) this.live.delete(invocationId);
  }

  async disposeMember(roomId: string, memberId: string): Promise<void> {
    const entries = [...(this.roomChats.get(roomId)?.values() ?? [])].filter((entry) => entry.memberId === memberId);
    for (const { chat } of entries) {
      if (chat.status !== "disposed") await chat.dispose("The membership's session was reset").catch(() => undefined);
      this.roomChats.get(roomId)?.delete(chat.chatId);
    }
    for (const [invocationId, live] of this.live) if (live.roomId === roomId && live.memberId === memberId) this.live.delete(invocationId);
  }

  answer(roomId: string, requestId: string, answer: InteractionAnswer, denialReason?: string): string {
    const sep = requestId.indexOf(":");
    if (sep <= 0) throw new ChatError(404, "no_request", "No such request in this room");
    const invocationId = requestId.slice(0, sep);
    const raw = requestId.slice(sep + 1);
    const live = this.live.get(invocationId);
    if (!live || live.roomId !== roomId) throw new ChatError(409, "request_not_live", "That bot run is no longer waiting for an answer");
    return live.chat.answer(raw, answer, denialReason);
  }

  /** Whether a membership has a run in flight right now (CRUD refuses changes then). */
  isInvoking(roomId: string, memberId: string): boolean {
    for (const live of this.live.values()) if (live.roomId === roomId && live.memberId === memberId) return true;
    return false;
  }

  /** Whether a room's membership has a live chat (the manager's Reset path uses it). */
  hasLiveChat(roomId: string, memberId: string): boolean {
    for (const entry of this.roomChats.get(roomId)?.values() ?? []) if (entry.memberId === memberId && entry.chat.status !== "disposed") return true;
    return false;
  }
}
