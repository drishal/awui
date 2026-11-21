import { randomUUID } from "node:crypto";
// The leader's harness adapter for a remote mesh task (P1): a delegated task whose
// child chat actually runs on a paired peer. The adapter and its live chat are thin
// relays — everything arrives as ordinary HarnessEvents over the peer link, so the
// Chat, the Orchestrator's watcher, and the approval cards (approvals at the origin,
// where the person sits) all work unchanged. The one honest limit is what the relay
// cannot do: no forks, no handoff seeds, no local session files, no models of its own
// to list — the worker's harness owns all of that, and the adapter says so instead of
// inventing placeholders.
import {
  asHarnessId,
  type ChatConfig,
  type ChatItem,
  type ConfigPatch,
  type ContextUsage,
  type HarnessCapabilities,
  type HarnessId,
  type ImageAttachment,
  type InteractionAnswer,
  type ModelInfo,
  type SlashCommand,
  type TodoItem,
} from "../../shared/protocol.js";
import { ChatError } from "../chats/chat.js";
import { MeshErrorCode, MeshRpcError } from "./rpc.js";
import type {
  HarnessAdapter,
  HarnessUsage,
  HarnessDiscovery,
  HarnessEvent,
  HarnessEventListener,
  LiveChat,
  NativeSessionSummary,
  OpenChatRequest,
  RecentNativeSession,
} from "../harness/types.js";
import type { PeerConnection, PeerManager } from "./manager.js";
import type { Ceiling } from "./policy.js";

/** What a remote chat is opened with, beside the peer and harness it runs on. */
export interface PeerChatOptions {
  model?: string;
  thinkingLevel?: string;
  /** The permission ceiling to ask for; the worker clamps it to what its policy grants. */
  ceiling?: Ceiling;
  /** The delegation's idempotency key: the worker answers a repeat with the same remote task. */
  clientRequestId?: string;
}

/**
 * How a dropped link under an unsettled task is retried (spec P1.5 §4): a schedule of
 * waits between attempts, a total time after which the run is ended instead of retried,
 * and the clock both read — the clock is injectable so tests can run the whole window
 * without waiting two real minutes.
 */
export interface PeerReconnectPlan {
  /** Milliseconds to wait before attempt n (0-based); the last entry repeats. */
  schedule: number[];
  /** Time from link loss, in milliseconds, after which reconnecting gives up. */
  giveUpMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

/** The spec's schedule: 1, 2, 4, 8, 16, 30 s between attempts, and no attempt after 2 minutes. */
export const DEFAULT_RECONNECT_PLAN: PeerReconnectPlan = {
  schedule: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000],
  giveUpMs: 120_000,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** What a PeerLiveChat needs beyond its first connection to survive a dropped link. */
export interface PeerLiveChatOptions {
  /** A fresh connection to the same peer (the manager's connect, so the link is shared). */
  reconnect?: () => Promise<PeerConnection>;
  /** The retry plan; the manager's, so config.yml could one day shape it. */
  plan?: PeerReconnectPlan;
}

/**
 * How long a leader waits on a request that may be sitting in the target's
 * ask-approval queue (P2 §2): an approval waits five minutes there before it
 * expires, so six minutes on this side hears the real answer — expiry, deny,
 * or allow — instead of a timeout that would orphan the call. task.open,
 * task.prompt, the fs.* methods, and (when it exists) term.open use it.
 */
export const ASKABLE_RPC_TIMEOUT_MS = 6 * 60_000;

/** Every optional feature is off: the relay offers nothing the worker's harness does not. */

const NO_FEATURES: HarnessCapabilities = {
  // Relayed verbatim as task.prompt {mode}; the worker's harness answers for itself.
  supportsSteer: true,
  supportsFollowUp: true,
  supportsThinkingLevel: false,
  supportsCompact: false,
  supportsExtensions: false,
  supportsInteractiveRequests: false,
  supportsRename: false,
  supportsModelSelection: false,
  supportsFork: false,
  supportsHandoff: false,
  supportsRewind: false,
  supportsHtmlRender: false,
  supportsQueueEdit: false,
  supportsPermissionMode: false,
  supportsResumeCommand: false,
  jobsSurviveRestart: false,
  supportsAccountSelection: false,
  supportsProjectFolders: false,
  webOnly: false,
  readOnlyHarness: false,
};

/** A config as the worker's task.open replies with it, checked before it is trusted. */
function isChatConfig(value: unknown): value is ChatConfig {
  return typeof value === "object" && value !== null && Array.isArray((value as { models: unknown }).models);
}

export class PeerHarnessAdapter implements HarnessAdapter {
  readonly id: HarnessId;
  readonly displayName: string;
  readonly cliCommand = "awui";
  readonly capabilities: HarnessCapabilities = NO_FEATURES;

  constructor(
    private readonly manager: PeerManager,
    private readonly peerName: string,
    private readonly harness: string,
    private readonly remoteCwd: string,
    private readonly opts: PeerChatOptions = {},
  ) {
    this.id = asHarnessId(`peer:${peerName}:${harness}`);
    this.displayName = `${harness} @${peerName}`;
  }

  async discover(): Promise<HarnessDiscovery> {
    // A peer task is only created for a configured peer, so the adapter is always "installed";
    // whether the far side answers is what connect() says, at open time.
    return { available: true, warnings: [], overrides: {} };
  }

  workspaceProblem(): string | null {
    return null;
  }

  // The sessions, models, and directories of the worker's harness are not this machine's
  // to name; nothing here could return an honest path, so every caller is told that.
  async resolveAgentDir(): Promise<string> {
    throw new ChatError(501, "unsupported", `${this.displayName} runs on the peer "${this.peerName}"; it has no agent directory on this machine`);
  }

  async resolveSessionDir(): Promise<string> {
    throw new ChatError(501, "unsupported", `${this.displayName} keeps its sessions on the peer "${this.peerName}", not here`);
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  async listThinkingLevels(): Promise<string[]> {
    return [];
  }

  async listSessions(): Promise<NativeSessionSummary[]> {
    return [];
  }

  async listRecentSessions(): Promise<RecentNativeSession[]> {
    return [];
  }

  async forkSession(): Promise<{ nativeId: string }> {
    throw new ChatError(501, "unsupported", "A remote peer chat has no session here to fork");
  }

  async seedChat(): Promise<LiveChat> {
    throw new ChatError(501, "unsupported", "A handoff seed cannot be started on a remote peer");
  }

  async openChat(_req: OpenChatRequest): Promise<LiveChat> {
    // The local cwd is ignored by design: the chat runs where the peer's project is.
    const connection = await this.manager.connect(this.peerName);
    const opened = await connection.rpc.request<unknown>("task.open", {
      // The worker requires an id (its idempotency key); a fresh one per open when the caller gave none.
      clientRequestId: this.opts.clientRequestId ?? randomUUID(),
      harness: this.harness,
      cwd: this.remoteCwd,
      ...(this.opts.model !== undefined ? { model: this.opts.model } : {}),
      ...(this.opts.thinkingLevel !== undefined ? { thinkingLevel: this.opts.thinkingLevel } : {}),
      ...(this.opts.ceiling !== undefined ? { ceiling: this.opts.ceiling } : {}),
      hops: 0,
    }, ASKABLE_RPC_TIMEOUT_MS);
    const record = typeof opened === "object" && opened !== null ? (opened as { remoteTaskId?: unknown; config?: unknown; nativeId?: unknown }) : null;
    if (record === null || typeof record.remoteTaskId !== "string" || record.remoteTaskId === "") {
      throw new ChatError(502, "harness_init_failed", `The peer "${this.peerName}" opened a task without an id`);
    }
    const chat = new PeerLiveChat(connection, this.peerName, record.remoteTaskId, isChatConfig(record.config) ? record.config : null, {
      reconnect: () => this.manager.connect(this.peerName),
      plan: this.manager.reconnectPlan,
    });
    if (typeof record.nativeId === "string" && record.nativeId !== "" && record.nativeId.length <= 256) chat.seedNativeId(record.nativeId);
    return chat;
  }

  async shutdown(): Promise<void> {}
}

/**
 * One remote task's chat, as the leader sees it. The worker numbers the events per task;
 * a number at or below the last one seen is a duplicate or a late reply and is dropped,
 * so a reconnecting stream can never fold the same answer twice. The chat's own session
 * name and title are kept from the events that carry them, and the requests the worker
 * raises are answered by id — an answer for an id nobody waits for is false, exactly as
 * a local harness answers.
 */
export class PeerLiveChat implements LiveChat {
  private readonly listeners = new Set<HarnessEventListener>();
  private nativeIdValue: string | null = null;
  private titleValue: string | null = null;
  private lastSeq = 0;
  private readonly pendingIds = new Set<string>();
  private disposed = false;
  /** Set once the run itself has ended; a link lost after it needs no reconnecting. */
  private settled = false;
  /** True between a link loss and a reattach, so a second close never starts a second loop. */
  private reconnecting = false;
  private connection: PeerConnection;
  private offTask: () => void;
  private offClose: () => void;
  private configValue: ChatConfig | null;
  private readonly reconnect: (() => Promise<PeerConnection>) | null;
  private readonly plan: PeerReconnectPlan;

  constructor(
    connection: PeerConnection,
    private readonly peerName: string,
    readonly remoteTaskId: string,
    config: ChatConfig | null,
    opts: PeerLiveChatOptions = {},
  ) {
    this.connection = connection;
    this.configValue = config;
    this.reconnect = opts.reconnect ?? null;
    this.plan = opts.plan ?? DEFAULT_RECONNECT_PLAN;
    this.offTask = connection.onTaskEvent(remoteTaskId, this.onTask);
    this.offClose = connection.onClose(() => this.onLinkLost());
  }

  /** One task event from the worker: newer seqs only, so a replay after a reconnect never folds twice. */
  private readonly onTask = (event: HarnessEvent, seq: number): void => {
    if (seq <= this.lastSeq) return;
    this.lastSeq = seq;
    this.observe(event);
    this.emit(event);
  };

  /** The link died under this chat: reconnect while the run is unsettled, else end it as P1 did. */
  private onLinkLost(): void {
    if (this.disposed || this.reconnecting) return;
    // No reconnect wiring (a caller that opted out) or a run that already ended: fatal, then
    // settled, the same two events a local harness that lost its child would owe the chat.
    if (this.reconnect === null || this.settled) {
      this.emit({ type: "fatal", message: `link to ${this.peerName} lost` });
      this.emit({ type: "settled" });
      return;
    }
    this.reconnecting = true;
    void this.reconnectLoop();
  }

  /**
   * The P1.5 recovery: retry the link on the backoff schedule and reattach with
   * `task.attach {remoteTaskId, afterSeq: lastSeen}`, so the worker replays exactly what
   * was missed. `not_found` means the task is gone on the peer (closed, or an ephemeral P1
   * worker that disposed its chats with the link), and -32601 means the peer does not know
   * attach at all — both end the run as P1 did. A `gap` answer (the worker's buffer does
   * not reach back to the last seq seen) has no replay to trust, and a LiveChat relay has
   * no channel to push a history refresh through, so the honest report is one notice.
   */
  private async reconnectLoop(): Promise<void> {
    const startedAt = this.plan.now();
    for (let attempt = 0; this.plan.now() - startedAt < this.plan.giveUpMs; attempt++) {
      await this.plan.sleep(this.plan.schedule[Math.min(attempt, this.plan.schedule.length - 1)] ?? 30_000);
      if (this.disposed) return;
      let fresh: PeerConnection | null = null;
      let dropTask: (() => void) | null = null;
      try {
        dropTask = null;
        fresh = await this.reconnect!();
        // Subscribed before the attach, so the replayed events (which may arrive before or
        // after the answer) are routed, not dropped; the seq filter absorbs the overlap.
        const offTask = fresh.onTaskEvent(this.remoteTaskId, this.onTask);
        dropTask = offTask;
        const attached = await fresh.rpc.request<unknown>("task.attach", { remoteTaskId: this.remoteTaskId, afterSeq: this.lastSeq });
        if (fresh.closed) throw new MeshRpcError(MeshErrorCode.link_closed, "the fresh link closed before the attach finished", { code: "link_closed" });
        if ((attached as { gap?: unknown } | null)?.gap === true) {
          this.emit({ type: "notice", level: "warning", text: `Reconnected to ${this.peerName}, but events were missed while the link was down; the record may have gaps` });
        }
        if (fresh.closed) throw new MeshRpcError(MeshErrorCode.link_closed, "the fresh link closed under the reattached task", { code: "link_closed" });
        if (this.disposed) {
          // The chat was thrown away while the attach was in flight: the fresh link is the
          // manager's to keep or drop, but it is no longer this chat's.
          fresh.close();
          return;
        }
        const offClose = fresh.onClose(() => this.onLinkLost());
        this.offTask = offTask;
        this.offClose = offClose;
        this.connection = fresh;
        this.reconnecting = false;
        this.emit({ type: "notice", level: "info", text: `reconnected to ${this.peerName}` });
        return;
      } catch (error) {
        dropTask?.();
        dropTask = null;
        // The connection is the manager's one shared link to this peer: only a link-level
        // failure closes it, never one task's refusal (other tasks stream over it too).
        const linkLevel = !(error instanceof MeshRpcError) || error.code === MeshErrorCode.link_closed || error.code === MeshErrorCode.timeout;
        if (linkLevel) fresh?.close();
        if (
          error instanceof MeshRpcError &&
          (error.code === MeshErrorCode.not_found ||
            error.code === MeshErrorCode.method_not_found ||
            error.code === MeshErrorCode.denied ||
            error.code === MeshErrorCode.not_paired)
        ) {
          // The task is gone on the peer, or the peer predates attach (P1, ephemeral): end the
          // run instead of retrying, exactly as a lost link ended it in P1.
          this.reconnecting = false;
          this.emit({ type: "fatal", message: `link to ${this.peerName} lost: ${error.message}` });
          this.emit({ type: "settled" });
          return;
        }
        // Anything else (a link that would not come up, a denial, a timeout) is worth another
        // attempt within the window; the run is still going on the far side.
      }
    }
    this.reconnecting = false;
    this.emit({ type: "fatal", message: `link to ${this.peerName} lost: no reconnection within ${Math.round(this.plan.giveUpMs / 1000)} s` });
    this.emit({ type: "settled" });
  }

  /** The worker's session id as task.open reported it; a later "session" event still wins. */
  seedNativeId(id: string): void {
    if (this.nativeIdValue === null) this.nativeIdValue = id;
  }

  get nativeId(): string | null {
    return this.nativeIdValue;
  }

  get title(): string | null {
    return this.titleValue;
  }

  private emit(event: HarnessEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  /** What the relay keeps for itself from the events: the session's name, its title, and which requests still wait. */
  private observe(event: HarnessEvent): void {
    if (event.type === "session") this.nativeIdValue = event.nativeId;
    else if (event.type === "title") this.titleValue = event.title;
    else if (event.type === "request") this.pendingIds.add(event.request.id);
    else if (event.type === "request_cancelled") this.pendingIds.delete(event.requestId);
    else if (event.type === "settled" || event.type === "fatal") this.settled = true;
  }

  subscribe(listener: HarnessEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async getConfig(): Promise<ChatConfig> {
    const fresh = await this.connection.rpc.request<unknown>("task.config", { remoteTaskId: this.remoteTaskId });
    if (isChatConfig(fresh)) {
      this.configValue = fresh;
      return fresh;
    }
    const cached = this.configValue;
    if (cached !== null) return cached;
    throw new Error(`The peer "${this.peerName}" did not answer about its task's config`);
  }

  async history(): Promise<ChatItem[]> {
    const items = await this.connection.rpc.request<unknown>("task.history", { remoteTaskId: this.remoteTaskId });
    return Array.isArray(items) ? (items as ChatItem[]) : [];
  }

  async getContextUsage(): Promise<ContextUsage | null> {
    return null;
  }

  async getUsage(): Promise<HarnessUsage | null> {
    return null;
  }

  async getTodos(): Promise<TodoItem[]> {
    return [];
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [];
  }

  /** One message to the task; the wire has no image channel, so attachments are refused rather than dropped. */
  private async send(text: string, mode: "prompt" | "steer" | "followUp", images?: ImageAttachment[]): Promise<void> {
    if (images !== undefined && images.length > 0) throw new Error("A remote peer task cannot take image attachments");
    await this.connection.rpc.request("task.prompt", { remoteTaskId: this.remoteTaskId, text, mode }, ASKABLE_RPC_TIMEOUT_MS);
  }

  async prompt(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.send(text, "prompt", images);
  }

  async steer(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.send(text, "steer", images);
  }

  async followUp(text: string, images?: ImageAttachment[]): Promise<void> {
    await this.send(text, "followUp", images);
  }

  async abort(): Promise<void> {
    await this.connection.rpc.request("task.abort", { remoteTaskId: this.remoteTaskId });
  }

  async setConfig(patch: ConfigPatch): Promise<void> {
    // Model and thinking only; a permission mode is never the caller's to set on a peer
    // task — the worker's policy ceiling is the one thing that decides it.
    const allowed: Record<string, unknown> = {};
    if (patch.model !== undefined) allowed.model = patch.model;
    if (patch.thinkingLevel !== undefined) allowed.thinkingLevel = patch.thinkingLevel;
    await this.connection.rpc.request("task.config", { remoteTaskId: this.remoteTaskId, patch: allowed });
  }

  async refreshModels(): Promise<void> {}

  async compact(): Promise<void> {}

  async rename(): Promise<void> {}

  answer(requestId: string, answer: InteractionAnswer): boolean {
    if (this.connection.closed || !this.pendingIds.has(requestId)) return false;
    this.pendingIds.delete(requestId);
    // Fire and forget: the worker's own request_resolved event closes the card, and a link
    // that died mid-answer is reported by the events, not by this call.
    void this.connection.rpc.request("task.answer", { remoteTaskId: this.remoteTaskId, requestId, answer }).catch(() => undefined);
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.offTask();
    this.offClose();
    this.listeners.clear();
    // The link can already be gone; a close nobody answers is the task's end either way.
    await this.connection.rpc.request("task.close", { remoteTaskId: this.remoteTaskId }).catch(() => undefined);
  }
}
