// Owns every live chat in this process and guarantees one live writer per
// native session: `harnessId + nativeId -> chatId`. Another terminal or
// process running the same harness is NOT locked out (documented in README).
import { randomBytes, randomUUID } from "node:crypto";
import type { InteractionRequest, LimitAccount, PushNote, WorkspaceInfo } from "../../shared/protocol.js";
import { DeferredLiveChat } from "../harness/deferred.js";
import type { HarnessAdapter, LiveChat } from "../harness/types.js";
import { Chat, ChatError, errorMessage, type ChatOwner } from "./chat.js";
import { ChatCheckpoints, type Checkpoints } from "../checkpoints.js";
import { prepareSpawnEnv } from "../direnv.js";

const IDLE_DISPOSE_MS = 30 * 60_000;
const REAP_INTERVAL_MS = 60_000;

function key(harnessId: string, nativeId: string): string {
  return `${harnessId}\u0000${nativeId}`;
}

export class ChatManager {
  private chats = new Map<string, Chat>();
  private bySession = new Map<string, string>();
  private opening = new Map<string, Promise<Chat>>();
  private reaper: NodeJS.Timeout;
  /** Any chat's harness reported its subscription limits. */
  onLimits?: (account: LimitAccount) => void;
  /** File checkpoints before prompts, and where each session's list of them is kept. */
  checkpoints?: { service: Checkpoints; sessionsDir: string };
  /** A run started in any chat. */
  onRunStart?: (chat: Chat) => void;
  /**
   * The origin a chat's child POSTs its HTML page to (loopback). When set,
   * `renderFor` mints each chat a token in `AWUI_RENDER_URL`/`AWUI_RENDER_TOKEN`
   * and stamps it on the chat, so a render POST can be matched back to its chat.
   */
  render?: { baseUrl: string };
  /** Any chat finished a run, failed, or asks for an answer. */
  onNews?: (chat: Chat, kind: PushNote["kind"], body: string, request?: InteractionRequest) => void;
  /** A chat's chain reached a handoff step (Chat.onChainHandoff). */
  onChainHandoff?: Chat["onChainHandoff"];

  constructor(private readonly idleDisposeMs = IDLE_DISPOSE_MS) {
    this.reaper = setInterval(() => void this.reap(), REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  get(chatId: string): Chat {
    const chat = this.chats.get(chatId);
    if (!chat) throw new ChatError(404, "chat_not_found", "No such chat; it may have been closed");
    return chat;
  }

  /** The chat whose child was spawned with this render token, when one is live. */
  chatForRenderToken(token: string): Chat | undefined {
    for (const chat of this.chats.values()) {
      if (chat.render?.token === token) return chat;
    }
    return undefined;
  }

  /**
   * The env a chat's child needs for its render tool, and the token that
   * stamps it: one random token per chat, in `AWUI_RENDER_URL`/`AWUI_RENDER_TOKEN`,
   * so a render POST can be matched back to the chat that spawned the caller.
   * `null` when render is not wired (no origin) or the capability is off.
   */
  private renderFor(adapter: HarnessAdapter): { token: string; env: NodeJS.ProcessEnv } | null {
    if (!this.render || !adapter.capabilities.supportsHtmlRender) return null;
    const token = randomBytes(16).toString("hex");
    return { token, env: { AWUI_RENDER_TOKEN: token, AWUI_RENDER_URL: `${this.render.baseUrl}/api/render` } };
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
    chat.onNews = (c, kind, body, request) => this.onNews?.(c, kind, body, request);
    chat.onRunStart = (c) => this.onRunStart?.(c);
    chat.onChainHandoff = async (c, step, rest) => {
      if (!this.onChainHandoff) throw new Error("Handoffs cannot run here");
      await this.onChainHandoff(c, step, rest);
    };
    // Board-owned chats take no ordinary per-prompt checkpoints; a room-level design comes later.
    if (this.checkpoints && !chat.owner) {
      chat.checkpoints = new ChatCheckpoints(this.checkpoints.service, chat, this.checkpoints.sessionsDir);
      void chat.checkpoints.start();
    }
    if (chat.nativeId) this.claimSession(chat);
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
  }

  private forget(chat: Chat): void {
    this.chats.delete(chat.chatId);
    for (const [k, id] of this.bySession) if (id === chat.chatId) this.bySession.delete(k);
  }

  async create(adapter: HarnessAdapter, workspace: WorkspaceInfo, owner?: ChatOwner): Promise<Chat> {
    const problem = adapter.workspaceProblem(workspace.path);
    if (problem) throw new ChatError(422, "workspace_unsupported", problem);
    // A board-owned chat gets no render token: room-scoped HTML render needs its own ownership route first.
    const render = owner ? undefined : this.renderFor(adapter);
    let live;
    try {
      // The project's .envrc is evaluated off the event loop first; the spawn then finds it cached.
      await prepareSpawnEnv(workspace.path);
      live = await adapter.openChat({ cwd: workspace.path, renderEnv: render?.env });
    } catch (error) {
      throw new ChatError(502, "harness_init_failed", `${adapter.displayName} failed to start: ${errorMessage(error)}`);
    }
    const chat = await this.load(adapter, workspace, live, owner);
    if (render && this.render) chat.render = { token: render.token, baseUrl: this.render.baseUrl };
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

  async resume(adapter: HarnessAdapter, workspace: WorkspaceInfo, nativeId: string, owner?: ChatOwner): Promise<Chat> {
    const k = key(adapter.id, nativeId);
    const existing = this.liveChatFor(adapter.id, nativeId);
    if (existing) return existing;
    const inFlight = this.opening.get(k);
    if (inFlight) return inFlight;
    const problem = adapter.workspaceProblem(workspace.path);
    if (problem) throw new ChatError(422, "workspace_unsupported", problem);
    const open = (async () => {
      // A board-owned chat gets no render token: room-scoped HTML render needs its own ownership route first.
      const render = owner ? undefined : this.renderFor(adapter);
      const req = { cwd: workspace.path, resumeNativeId: nativeId, renderEnv: render?.env };
      // From the file when the adapter can read it: the chat shows now and the
      // harness starts behind it; the file read also proves the session is this project's.
      const transcript = adapter.readTranscript ? await adapter.readTranscript({ cwd: workspace.path, nativeId }).catch(() => null) : null;
      let live: LiveChat;
      if (transcript) {
        live = new DeferredLiveChat(nativeId, transcript, async () => {
          await prepareSpawnEnv(workspace.path);
          return adapter.openChat(req);
        }, (error) => `${adapter.displayName} failed to resume: ${errorMessage(error)}`);
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
      if (render && this.render) chat.render = { token: render.token, baseUrl: this.render.baseUrl };
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
      // A chat waiting to continue after a usage limit stays open until it does.
      if (idle && chat.continueAt === null && chat.subscriberCount === 0 && now - chat.lastSeen > this.idleDisposeMs) {
        await chat.dispose("Closed after being idle with no viewers").catch(() => undefined);
      }
    }
  }

  async shutdown(): Promise<void> {
    clearInterval(this.reaper);
    await Promise.allSettled([...this.chats.values()].map((c) => c.dispose("Server shutting down")));
  }
}
