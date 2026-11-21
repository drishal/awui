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

/** Every optional feature is off: the relay offers nothing the worker's harness does not. */
const NO_FEATURES: HarnessCapabilities = {
  supportsSteer: false,
  supportsFollowUp: false,
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
    });
    const record = typeof opened === "object" && opened !== null ? (opened as { remoteTaskId?: unknown; config?: unknown; nativeId?: unknown }) : null;
    if (record === null || typeof record.remoteTaskId !== "string" || record.remoteTaskId === "") {
      throw new ChatError(502, "harness_init_failed", `The peer "${this.peerName}" opened a task without an id`);
    }
    const chat = new PeerLiveChat(connection, this.peerName, record.remoteTaskId, isChatConfig(record.config) ? record.config : null);
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
  private readonly offTask: () => void;
  private readonly offClose: () => void;
  private configValue: ChatConfig | null;

  constructor(
    private readonly connection: PeerConnection,
    private readonly peerName: string,
    readonly remoteTaskId: string,
    config: ChatConfig | null,
  ) {
    this.configValue = config;
    this.offTask = connection.onTaskEvent(remoteTaskId, (event, seq) => {
      if (seq <= this.lastSeq) return;
      this.lastSeq = seq;
      this.observe(event);
      this.emit(event);
    });
    this.offClose = connection.onClose(() => {
      // A link that dies under an open task ends the run honestly: fatal, then settled, the
      // same two events a local harness that lost its child would owe the chat.
      if (this.disposed) return;
      this.emit({ type: "fatal", message: `link to ${this.peerName} lost` });
      this.emit({ type: "settled" });
    });
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
    await this.connection.rpc.request("task.prompt", { remoteTaskId: this.remoteTaskId, text, mode });
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
