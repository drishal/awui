// Owns every live chat in this process and guarantees one live writer per
// native session: `harnessId + nativeId -> chatId`. Another terminal or
// process running the same harness is NOT locked out (documented in README).
import { randomBytes, randomUUID } from "node:crypto";
import type { ChatConfig, ChatLineage, DelegatedTaskView, InteractionRequest, LimitAccount, Plan, PushNote, WorkspaceInfo } from "../../shared/protocol.js";
import { DeferredLiveChat } from "../harness/deferred.js";
import type { HarnessAdapter, LiveChat } from "../harness/types.js";
import { Chat, ChatError, errorMessage, type ChatOwner } from "./chat.js";
import { ChatCheckpoints, type Checkpoints } from "../checkpoints.js";
import { prepareSpawnEnv } from "../direnv.js";
import { noteChatDisposed, noteSessionOfChat } from "../overview-events.js";
import { closeRenderPages } from "../render-browser.js";

const IDLE_DISPOSE_MS = 30 * 60_000;
const REAP_INTERVAL_MS = 60_000;
/**
 * How long a chat's orchestration token works: long enough for a day's work, short
 * enough that a leaked one goes stale. Restarting the chat (a resume) mints a new one,
 * and an expired token answers a clear error rather than silently failing tool calls.
 */
const ORCH_TOKEN_TTL_MS = 12 * 60 * 60_000;

/** One tool family's token and the environment that carries it to the child. */
interface ChatTools {
  token: string;
  env: NodeJS.ProcessEnv;
}

function key(harnessId: string, nativeId: string): string {
  return `${harnessId}\u0000${nativeId}`;
}

/** Both tool families' variables as one environment for the spawn; nothing at all when neither is wired. */
function toolEnvFor(tools: { render?: ChatTools; orchestration?: ChatTools } | undefined): NodeJS.ProcessEnv | undefined {
  if (!tools) return undefined;
  const env = { ...tools.render?.env, ...tools.orchestration?.env };
  return Object.keys(env).length > 0 ? env : undefined;
}

export class ChatManager {
  private chats = new Map<string, Chat>();
  private bySession = new Map<string, string>();
  private opening = new Map<string, Promise<Chat>>();
  private reaper: NodeJS.Timeout;
  /** Any chat's harness reported its subscription limits. */
  onLimits?: (account: LimitAccount) => void;
  /** Return limits for this harness's own registry source, not a global wildcard. */
  limitedSources?: (source: string) => Promise<string[]>;
  checkpoints?: { service: Checkpoints; sessionsDir: string };
  /** A run started in any chat. */
  onRunStart?: (chat: Chat) => void;
  /**
   * The origin a chat's child POSTs its HTML page to (loopback). When set,
   * `toolsFor` mints each chat a token in `AWUI_RENDER_URL`/`AWUI_RENDER_TOKEN`
   * and stamps it on the chat, so a render POST can be matched back to its chat.
   */
  render?: { baseUrl: string };
  /**
   * The origin a chat's child calls its orchestration tools on (loopback, as `render`
   * is). When set, every chat that may use them is spawned with its own token in
   * `AWUI_ORCH_URL`/`AWUI_ORCH_TOKEN`, stamped on the chat so a call names one chat.
   * `enabled` reads config.yml's switch at each spawn (index.ts), so turning it off leaves the
   * next child with no tools at all instead of tools that answer orch_off.
   */
  orchestration?: { baseUrl: string; enabled?: () => boolean };
  /** Any chat finished a run, failed, or asks for an answer. */
  onNews?: (chat: Chat, kind: PushNote["kind"], body: string, request?: InteractionRequest) => void;
  /** A chat's chain reached a handoff step (Chat.onChainHandoff). */
  onChainHandoff?: Chat["onChainHandoff"];
  /**
   * The orchestration record a chat belongs to, as the orchestrator knows it: a delegated
   * child keeps its lineage chip across a reap or a restart, and a reopened parent its panel.
   */
  lineageFor?: (chat: Chat) => ChatLineage | undefined;
  /**
   * Whether a session is a delegated child's, for a resume: the chat does not exist yet, so its
   * lineage cannot be read, and the orchestrator's records are what know it.
   */
  delegatedSession?: (harnessId: string, nativeId: string) => boolean;
  tasksFor?: (chat: Chat) => DelegatedTaskView[];
  /** The one plan belonging to this chat's stable native session, if any. */
  planFor?: (chat: Chat) => Plan | null;
  /** A denial explanation belongs to this manager's delegated worker, not an arbitrary chat. */
  onDenied?: Chat["onDenied"];
  /**
   * A chat was registered (opened, created, or resumed). The orchestrator delivers reports still
   * owed to a parent here: they were written while it was closed, or by the process before this one.
   */
  onRegistered?: (chat: Chat) => void;
  /**
   * A session handed to a native CLI (handover.ts): the exact line that took it over.
   * A resume refuses it — whichever side path asked (a PR watch, a guest poll, a guest
   * message's release) — unless the caller is the owner's own reclaim, so the second
   * writer the lock exists to prevent cannot start from a route nobody watched.
   */
  handedOver?: (sessionId: string) => string | null;
  /**
   * The model list a resumed chat shows while its harness is still starting (the saved catalog's answer
   * for that harness and folder; null when there is none). Only the list: which model the session is on
   * is the harness's to say, so none is named until it is up.
   */
  placeholderConfig?: (adapterId: string, cwd: string) => Promise<ChatConfig | null>;
  /** A resumed chat's harness came up and listed its models: the catalog can keep them for the next resume's placeholder. */
  configLearned?: (adapterId: string, cwd: string, config: ChatConfig) => void;
  /**
   * Hibernation for idle finished chats. When set, the reaper parks (disposes) a chat that has
   * been hidden — unviewed and unread — past `afterMs`: its harness child goes, its session's
   * native id stays, and opening it again resumes the same native session. The hook records the
   * parked mark (session-marks.ts), so lists can say why the live chat is gone.
   */
  hibernate?: { afterMs: number; onParked?: (chat: Chat) => void };

  constructor(private readonly idleDisposeMs = IDLE_DISPOSE_MS) {
    this.reaper = setInterval(() => void this.reap(), REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  get(chatId: string): Chat {
    const chat = this.chats.get(chatId);
    if (!chat) throw new ChatError(404, "chat_not_found", "No such chat; it may have been closed");
    return chat;
  }

  /** The live chat, or undefined when it was closed: for callers that record a chat they do not own (a race's members). */
  peek(chatId: string): Chat | undefined {
    return this.chats.get(chatId);
  }

  /** The chat whose child was spawned with this render token, when one is live. */
  chatForRenderToken(token: string): Chat | undefined {
    for (const chat of this.chats.values()) {
      if (chat.render?.token === token) return chat;
    }
    return undefined;
  }

  /**
   * Tokens minted for a child that is still starting. The child's bridge fetches the tool catalogue
   * the moment it loads, before the chat exists to be stamped, so the catalogue (which names nothing
   * of any chat) is served to a reserved token too. A call still needs the stamped chat.
   */
  private readonly reservedOrch = new Map<string, number>();

  /** Whether this token was minted for a child that has not been stamped yet (or is live): enough to read the catalogue. */
  knowsOrchToken(token: string): boolean {
    const until = this.reservedOrch.get(token);
    if (until !== undefined && until > Date.now()) return true;
    return this.chatForOrchToken(token) !== undefined;
  }

  /** The chat whose child was spawned with this orchestration token, when one is live. */
  chatForOrchToken(token: string): Chat | undefined {
    for (const chat of this.chats.values()) {
      if (chat.orchestration?.token === token) return chat;
    }
    return undefined;
  }

  /**
   * The env a chat's child needs for its tools, and the token that stamps each family:
   * one random token per chat per family, so a call can be matched back to the chat that
   * spawned the caller. A family is left out when its origin is not wired, when the
   * adapter cannot host the tool, or (orchestration) when the harness is a read-only
   * surface that must never be armed with it.
   */
  private toolsFor(adapter: HarnessAdapter): { render?: ChatTools; orchestration?: ChatTools } {
    const tools: { render?: ChatTools; orchestration?: ChatTools } = {};
    if (this.render && adapter.capabilities.supportsHtmlRender) {
      const token = randomBytes(16).toString("hex");
      tools.render = { token, env: { AWUI_RENDER_TOKEN: token, AWUI_RENDER_URL: `${this.render.baseUrl}/api/render` } };
    }
    // Off in config.yml means no tools at all for the next child, not tools that can only say no.
    const surface = this.orchestration;
    if (surface && (surface.enabled?.() ?? true) && !adapter.capabilities.readOnlyHarness) {
      const token = randomBytes(16).toString("hex");
      tools.orchestration = { token, env: { AWUI_ORCH_TOKEN: token, AWUI_ORCH_URL: `${surface.baseUrl}/api/orchestration` } };
      // Held for a minute: long enough for the child to start, short enough that a failed spawn leaves nothing.
      this.reservedOrch.set(token, Date.now() + 60_000);
      for (const [held, until] of this.reservedOrch) if (until <= Date.now()) this.reservedOrch.delete(held);
    }
    return tools;
  }

  /** Stamp the tokens on a chat whose child is running: how a call is matched back to it. */
  private stampTools(chat: Chat, tools: { render?: ChatTools; orchestration?: ChatTools } | undefined): void {
    if (!tools) return;
    if (tools.render && this.render) chat.render = { token: tools.render.token, baseUrl: this.render.baseUrl };
    if (tools.orchestration) this.reservedOrch.delete(tools.orchestration.token);
    if (tools.orchestration && this.orchestration) chat.orchestration = { token: tools.orchestration.token, baseUrl: this.orchestration.baseUrl, expiresAt: Date.now() + ORCH_TOKEN_TTL_MS };
  }

  list(): Chat[] {
    return [...this.chats.values()];
  }

  liveChatFor(harnessId: string, nativeId: string): Chat | undefined {
    const chatId = this.bySession.get(key(harnessId, nativeId));
    return chatId ? this.chats.get(chatId) : undefined;
  }

  private register(chat: Chat): void {
    this.chats.set(chat.chatId, chat);
    chat.onSession = (c) => this.claimSession(c);
    chat.onDisposed = (c) => this.forget(c);
    chat.onLimits = (account) => this.onLimits?.(account);
    if (this.limitedSources) chat.limitedFor = (source) => this.limitedSources?.(source) ?? Promise.resolve([]);
    chat.onNews = (c, kind, body, request) => this.onNews?.(c, kind, body, request);
    chat.onDenied = (c, request, reason) => this.onDenied?.(c, request, reason);
    chat.onRunStart = (c) => this.onRunStart?.(c);
    chat.onChainHandoff = async (c, step, rest) => {
      if (!this.onChainHandoff) throw new Error("Handoffs cannot run here");
      await this.onChainHandoff(c, step, rest);
    };
    // A delegated child's lineage and a parent's task list live in the orchestrator's records,
    // not in the chat: stamp them here so a resumed chat shows what it is.
    chat.lineage = this.lineageFor?.(chat);
    if (this.tasksFor && this.tasksFor(chat).length > 0) chat.delegated = () => this.tasksFor?.(chat) ?? [];
    if (this.planFor && !chat.plan) chat.plan = () => this.planFor?.(chat) ?? null;
    // Board-owned chats take no ordinary per-prompt checkpoints (a room-level design comes later),
    // and neither does a side thread: it is a look at one block, not a run whose files go back.
    if (this.checkpoints && !chat.owner && !chat.side) {
      chat.checkpoints = new ChatCheckpoints(this.checkpoints.service, chat, this.checkpoints.sessionsDir);
      void chat.checkpoints.start();
    }
    if (chat.nativeId) this.claimSession(chat);
    // Last, so whatever the chat reads from the records is already stamped on it.
    this.onRegistered?.(chat);
  }

  private claimSession(chat: Chat): void {
    if (!chat.nativeId) return;
    const k = key(chat.harnessId, chat.nativeId);
    const owner = this.bySession.get(k);
    if (owner && owner !== chat.chatId) {
      // Two live instances must never write one session file; close the newcomer.
      void chat.dispose("Session already open in another chat").catch(() => undefined);
      return;
    }
    this.bySession.set(k, chat.chatId);
    noteSessionOfChat(chat);
  }

  private forget(chat: Chat): void {
    noteChatDisposed(chat);
    void closeRenderPages(chat.chatId);
    this.chats.delete(chat.chatId);
    for (const [k, id] of this.bySession) if (id === chat.chatId) this.bySession.delete(k);
  }

  async create(adapter: HarnessAdapter, workspace: WorkspaceInfo, owner?: ChatOwner, spawn?: { delegated?: boolean }): Promise<Chat> {
    const problem = adapter.workspaceProblem(workspace.path);
    if (problem) throw new ChatError(422, "workspace_unsupported", problem);
    // A board-owned chat gets neither token: a room's scope for these tools is its own question.
    const tools = owner ? undefined : this.toolsFor(adapter);
    let live;
    try {
      // The project's .envrc is evaluated off the event loop first; the spawn then finds it cached.
      await prepareSpawnEnv(workspace.path);
      live = await adapter.openChat({ cwd: workspace.path, toolEnv: toolEnvFor(tools), ...(spawn?.delegated ? { delegated: true } : {}) });
    } catch (error) {
      throw new ChatError(502, "harness_init_failed", `${adapter.displayName} failed to start: ${errorMessage(error)}`);
    }
    const chat = await this.load(adapter, workspace, live, owner);
    this.stampTools(chat, tools);
    this.register(chat);
    return chat;
  }

  /**
   * Register an already-open seeded chat (handoff target). Unlike create, the
   * LiveChat arrives started; load still attaches history/config the same way.
   */
  async seedOpen(adapter: HarnessAdapter, workspace: WorkspaceInfo, live: LiveChat): Promise<Chat> {
    const problem = adapter.workspaceProblem(workspace.path);
    if (problem) throw new ChatError(422, "workspace_unsupported", problem);
    const chat = await this.load(adapter, workspace, live);
    this.register(chat);
    return chat;
  }

  /**
   * Build the chat from a started harness session. If that fails (a history too
   * big for the transport, say), the session is closed again rather than left
   * running with nothing attached to it.
   */
  private async load(adapter: HarnessAdapter, workspace: WorkspaceInfo, live: LiveChat, owner?: ChatOwner): Promise<Chat> {
    try {
      return await Chat.open(randomUUID(), adapter, workspace, live, owner);
    } catch (error) {
      await live.dispose().catch(() => undefined);
      throw new ChatError(502, "harness_load_failed", `${adapter.displayName} could not load this session: ${errorMessage(error)}`);
    }
  }

  /**
   * Open the session's one live chat, or hand back the one already open. A session
   * locked by a handover is refused here rather than in each caller: `reclaim` is the
   * owner's own resume after taking the lock, and nothing else passes it.
   */
  async resume(adapter: HarnessAdapter, workspace: WorkspaceInfo, nativeId: string, owner?: ChatOwner, options?: { reclaim?: boolean }): Promise<Chat> {
    const k = key(adapter.id, nativeId);
    const existing = this.liveChatFor(adapter.id, nativeId);
    if (existing) return existing;
    const inFlight = this.opening.get(k);
    if (inFlight) return inFlight;
    // One live writer (rule 2): a session handed to a terminal CLI stays locked even when
    // the caller never asked about handovers, so a poll or a release cannot respawn it.
    if (options?.reclaim !== true) {
      const command = this.handedOver?.(`${adapter.id}:${nativeId}`) ?? null;
      if (command !== null) throw new ChatError(409, "session_handed", `This session was handed to a terminal (${command || "its command is no longer retained"}); reclaim it before resuming it here`);
    }
    const problem = adapter.workspaceProblem(workspace.path);
    if (problem) throw new ChatError(422, "workspace_unsupported", problem);
    const open = (async () => {
      // A board-owned chat gets no render token: room-scoped HTML render needs its own ownership route first.
      // A board-owned chat gets neither token: a room's scope for these tools is its own question.
      const tools = owner ? undefined : this.toolsFor(adapter);
      // A resume is a chat restart, so its orchestration token is minted afresh with a new lifetime.
      // A delegated child's session is still one (the orchestrator's record names it), so the child
      // respawns the way it was spawned.
      const delegated = this.delegatedSession?.(adapter.id, nativeId) === true;
      const req = { cwd: workspace.path, resumeNativeId: nativeId, toolEnv: toolEnvFor(tools), ...(delegated ? { delegated: true } : {}) };
      // From the file when the adapter can read it: the chat shows now and the
      // harness starts behind it; the file read also proves the session is this project's.
      const transcript = adapter.readTranscript ? await adapter.readTranscript({ cwd: workspace.path, nativeId }).catch(() => null) : null;
      let live: LiveChat;
      if (transcript) {
        const placeholder = await this.placeholderConfig?.(adapter.id, workspace.path).catch(() => null);
        live = new DeferredLiveChat(nativeId, transcript, async () => {
          await prepareSpawnEnv(workspace.path);
          const real = await adapter.openChat(req);
          void real.getConfig().then((config) => this.configLearned?.(adapter.id, workspace.path, config), () => undefined);
          return real;
        }, (error) => `${adapter.displayName} failed to resume: ${errorMessage(error)}`, placeholder ?? null);
      } else {
        const known = await adapter.listSessions(workspace.path);
        if (!known.some((s) => s.nativeId === nativeId)) {
          throw new ChatError(404, "session_not_found", "That session is not in this workspace's session list");
        }
        try {
          await prepareSpawnEnv(workspace.path);
          live = await adapter.openChat(req);
        } catch (error) {
          throw new ChatError(502, "harness_init_failed", `${adapter.displayName} failed to resume: ${errorMessage(error)}`);
        }
      }
      const chat = await this.load(adapter, workspace, live, owner);
      this.stampTools(chat, tools);
      this.register(chat);
      return chat;
    })();
    this.opening.set(k, open);
    try {
      return await open;
    } finally {
      this.opening.delete(k);
    }
  }

  private async reap(): Promise<void> {
    const now = Date.now();
    for (const chat of this.chats.values()) {
      const idle = chat.status === "idle" || chat.status === "error";
      // The harness's own vetoes: a chat waiting on an answer or an approval (the child that can
      // take the answer is the only place it goes), one whose chain has more to run, and one
      // waiting to continue after a usage limit all stay open until they are done.
      if (chat.pendingCount > 0 || chat.continueAt !== null || chat.chainLength > 0) continue;
      if (idle && chat.subscriberCount === 0 && now - chat.lastSeen > this.idleDisposeMs) {
        await chat.dispose("Closed after being idle with no viewers").catch(() => undefined);
      }
    }
    await this.park();
  }

  /**
   * Park one candidate: hidden long enough, idle, and resumable. Called from the reaper's own
   * pass, so two ticks cannot race — the map no longer holds a chat once its dispose lands, and
   * a chat re-registered in the same tick is a different, unhidden one by the time park runs.
   */
  private async park(): Promise<void> {
    const surface = this.hibernate;
    if (!surface || surface.afterMs <= 0) return;
    const now = Date.now();
    for (const chat of [...this.chats.values()]) {
      // The adapter must read the transcript back: parking a chat whose history lives only
      // behind its process would reopen it empty. Real resume, or no park.
      if (!chat.adapter.readTranscript) continue;
      // Hidden means unviewed (no streams attached): a chat someone is watching is not
      // this scheduler's to take away.
      if (chat.unviewedSince === null) continue;
      const idle = chat.status === "idle" || chat.status === "error";
      if (!idle || chat.subscriberCount > 0) continue;
      // The same vetoes the idle dispose takes, plus the child's own deferred work: queued
      // messages, background jobs, subagents still out — a closed chat loses all of them.
      if (chat.pendingCount > 0 || chat.continueAt !== null || chat.chainLength > 0 || chat.hasDeferredWork) continue;
      if (now - chat.lastSeen <= surface.afterMs) continue;
      await chat.dispose("Hibernated: parked after being idle, unviewed, and unread").catch(() => undefined);
      surface.onParked?.(chat);
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.allSettled([...this.chats.values()].map((c) => c.dispose("Server shutting down")));
  }
}
