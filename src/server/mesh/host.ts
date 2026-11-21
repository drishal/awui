// The mesh task host (P1.5, daemon mode): the daemon-side store of inbound
// peer tasks. A P1 link was ephemeral — every chat it opened died with it. With
// a host, a task is a real chat created through the service's own ChatManager
// under a peer owner, so it shows in this node's own UI, raises its approvals
// there, and outlives any number of links. Ownership is by node id — the key,
// never the name — so the link that opened a task, or any later link
// authenticated with the same key, may drive and re-attach it, while a
// different key learns nothing but not_found. Everything here is bounded: one
// ring of each task's last events, one host-wide idempotency map, one
// live-task count per peer. Host tasks are not persisted: they die with the
// process, and the leader sees that as link_closed and then not_found.
import { randomBytes } from "node:crypto";
import type { ChatConfig, ChatItem, ChatStatus, InteractionAnswer, SendMode, WorkspaceInfo } from "../../shared/protocol.js";
import { ChatError, type Chat, type ChatOwner } from "../chats/chat.js";
import type { ChatManager } from "../chats/manager.js";
import type { HarnessEvent } from "../harness/types.js";
import type { HarnessRegistry } from "../harness/registry.js";
import { type Ceiling } from "./policy.js";
import { MeshErrorCode, MeshRpcError } from "./rpc.js";
import { permissionModeFor } from "./serve.js";

/** One task's event ring: the spec's bounds, its last 2000 payloads / 8 MiB total. */
const RING_MAX_EVENTS = 2000;
const RING_MAX_BYTES = 8 * 1024 * 1024;
/** How many (nodeId, clientRequestId) pairs the host remembers; a cycling peer cannot grow it without limit. */
const MAX_IDEMPOTENT = 512;
/** The detached-TTL sweep: often enough to be prompt, rarely enough to matter. */
const REAP_INTERVAL_MS = 60_000;

/**
 * A chat's own refusal, in the protocol's terms: a chat that has closed, and a
 * request somebody else already answered, are not_found (never a probe result
 * and never a denial with detail); every other veto — busy, not running, a
 * setting the harness refused — is an invalid_params carrying its reason.
 */
function chatError(error: unknown): MeshRpcError {
  if (error instanceof ChatError) {
    if (error.code === "chat_closed" || error.code === "request_resolved") return new MeshRpcError(MeshErrorCode.not_found, error.message, { code: "not_found" });
    return new MeshRpcError(MeshErrorCode.invalid_params, error.message, { code: "invalid_params" });
  }
  return new MeshRpcError(MeshErrorCode.internal_error, "internal error", { code: "internal_error" });
}

export interface TaskHostDeps {
  /** The service's own chat registry: a peer task is a real chat, owned by its peer, with no orchestration tools. */
  chats: Pick<ChatManager, "create">;
  registry: Pick<HarnessRegistry, "get" | "available">;
  /** A realpathed directory this node may open, as the workspace the task's chat runs in. */
  workspace: (real: string) => Promise<WorkspaceInfo>;
  /** Epoch milliseconds; injected so the detached TTL is testable. */
  clock: () => number;
  /** config.yml's mesh.detached_ttl_hours, read per sweep (1..720, default 24). */
  detachedTtlHours: () => number;
  /** Test seam: smaller ring bounds, so a replay gap can be produced in a test run. */
  ringBounds?: { maxEvents: number; maxBytes: number };
  log?: (message: string) => void;
}

/** task.open, as serve.ts has already checked it: resolved, clamped, and policy-bounded. */
export interface HostOpenRequest {
  /** The caller's own idempotency key; a retry on any link returns the same task. */
  clientRequestId: string;
  harness: string;
  /** The requested cwd, already resolved inside a policy root and stat'd as a directory. */
  cwd: string;
  /** The effective ceiling, already clamped to the policy's own. */
  ceiling: Ceiling;
  /** The policy's live-task bound for this peer. */
  maxTasks: number;
  model?: string;
  thinkingLevel?: string;
}

export interface HostOpenResult {
  remoteTaskId: string;
  config: ChatConfig;
  nativeId: string | null;
}

/** One entry of `task.list`: this peer's live tasks. */
export interface HostTaskEntry {
  remoteTaskId: string;
  harness: string;
  cwd: string;
  state: ChatStatus;
  lastSeq: number;
  createdAt: number;
}

/** `task.attach`'s answer: what replay cost, whether the buffer had a hole, and where the task stands. */
export interface HostAttachResult {
  replayed: number;
  gap: boolean;
  state: ChatStatus;
}

/**
 * One served link's presence on the host. Subscriptions are per link, so a
 * closed link detaches everything it held at once and the tasks live on;
 * anything a link may reach is named by its authenticated node id instead.
 */
export class HostLink {
  /** The remoteTaskIds this link watches, as the host's mirror of its own bookkeeping. */
  readonly subscribed = new Set<string>();

  constructor(readonly notify: (method: string, params: unknown) => void) {}
}

interface RingEntry {
  seq: number;
  event: HarnessEvent;
  bytes: number;
}

interface HostTask {
  remoteTaskId: string;
  nodeId: string;
  harness: string;
  cwd: string;
  chat: Chat;
  createdAt: number;
  /** The seq of the last task.event sent; a task's first event is 1. */
  seq: number;
  ring: RingEntry[];
  ringBytes: number;
  /** The links watching this task; empty means detached, which is what the TTL reaper gates on. */
  subscribers: Set<HostLink>;
  /** When the task last became settled (epoch ms), or null while a run is still going. */
  settledSince: number | null;
  /** Ends the chat subscription that keeps ChatManager's idle reaper away: the host's TTL is the only one that applies. */
  keepAlive: () => void;
  openResult: HostOpenResult;
}

export class TaskHost {
  private readonly tasks = new Map<string, HostTask>();
  /** (nodeId, clientRequestId) -> remoteTaskId, host-wide: a retried open lands on the same task from any link. */
  private readonly idempotent = new Map<string, string>();
  /** Opens in flight per node id: part of the per-peer cap until they land or fail. */
  private readonly opening = new Map<string, number>();
  private readonly ringMaxEvents: number;
  private readonly ringMaxBytes: number;
  private readonly log: (message: string) => void;
  private readonly reaper: NodeJS.Timeout;

  constructor(private readonly deps: TaskHostDeps) {
    this.ringMaxEvents = deps.ringBounds?.maxEvents ?? RING_MAX_EVENTS;
    this.ringMaxBytes = deps.ringBounds?.maxBytes ?? RING_MAX_BYTES;
    this.log = deps.log ?? (() => undefined);
    this.reaper = setInterval(() => void this.reap().catch((error: unknown) => this.log(`mesh host: the TTL sweep failed: ${error instanceof Error ? error.message : String(error)}`)), REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  /** One new link. The host holds it only to fan events out and to detach on close. */
  openLink(notify: (method: string, params: unknown) => void): HostLink {
    return new HostLink(notify);
  }

  /** The link's stream ended: drop every subscription it holds. Its tasks are NOT disposed — that is the point of a host. */
  closeLink(link: HostLink): void {
    for (const id of link.subscribed) {
      const task = this.tasks.get(id);
      task?.subscribers.delete(link);
    }
    link.subscribed.clear();
  }

  /**
   * Opens one task: a real chat under a peer owner, held to the clamped
   * ceiling, subscribed to this link for its events. Idempotent host-wide on
   * (nodeId, clientRequestId), so a retry over a NEW link after the old one
   * died mid-answer returns the same task instead of a second chat.
   */
  async open(link: HostLink, nodeId: string, peerName: string, req: HostOpenRequest): Promise<HostOpenResult> {
    const key = `${nodeId}\0${req.clientRequestId}`;
    const remembered = this.idempotent.get(key);
    if (remembered !== undefined) {
      const task = this.tasks.get(remembered);
      if (task !== undefined) {
        // A retry on a new link must also stream: subscribe it, as the first open did.
        task.subscribers.add(link);
        link.subscribed.add(remembered);
        return task.openResult;
      }
    }
    let live = this.opening.get(nodeId) ?? 0;
    for (const task of this.tasks.values()) if (task.nodeId === nodeId) live++;
    if (live >= req.maxTasks) {
      throw new MeshRpcError(MeshErrorCode.limit, `this peer already holds ${live} live tasks and the policy allows ${req.maxTasks}`, { code: "limit" });
    }
    // Counted before the first await, so concurrent opens cannot all see room for one.
    this.opening.set(nodeId, (this.opening.get(nodeId) ?? 0) + 1);
    try {
      return await this.openCounted(link, nodeId, peerName, req, key);
    } finally {
      const left = (this.opening.get(nodeId) ?? 1) - 1;
      if (left <= 0) this.opening.delete(nodeId);
      else this.opening.set(nodeId, left);
    }
  }

  private async openCounted(link: HostLink, nodeId: string, peerName: string, req: HostOpenRequest, key: string): Promise<HostOpenResult> {
    const adapter = this.deps.registry.get(req.harness);
    if (adapter === undefined) throw new MeshRpcError(MeshErrorCode.denied, `harness "${req.harness}" is not registered on this node`, { code: "denied" });
    if (!(await this.deps.registry.available(req.harness))) {
      throw new MeshRpcError(MeshErrorCode.denied, `harness "${req.harness}" is not available on this node`, { code: "denied" });
    }
    const remoteTaskId = `rt_${randomBytes(6).toString("hex")}`;
    // The peer owner is what makes the chat a peer's: no orchestration tools, kept out of ordinary surfaces, and
    // approvable in this node's own UI. It rides the create, so the chat knows its task from the first event.
    let chat: Chat;
    try {
      chat = await this.deps.chats.create(adapter, await this.deps.workspace(req.cwd), { kind: "peer", peerId: nodeId, peerName, remoteTaskId }, { delegated: true });
    } catch (error) {
      // A chat that could not start is this node's failure to report, never the peer's to diagnose.
      this.log(`mesh host: opening a chat failed: ${error instanceof Error ? error.message : String(error)}`);
      throw new MeshRpcError(MeshErrorCode.internal_error, "internal error", { code: "internal_error" });
    }
    const config = chat.snapshot().config;
    const mode = permissionModeFor(req.harness, req.ceiling, config.permissionModes?.map((m) => m.id));
    if (!mode.ok) {
      await chat.dispose(`the ceiling "${req.ceiling}" cannot be enforced`).catch(() => undefined);
      throw new MeshRpcError(MeshErrorCode.denied, `the requested ceiling cannot be enforced: ${mode.reason}`, { code: "denied" });
    }
    try {
      if (mode.mode !== null) await chat.setConfig({ permissionMode: mode.mode });
      if (req.model !== undefined || req.thinkingLevel !== undefined) {
        await chat.setConfig({
          ...(req.model !== undefined ? { model: req.model } : {}),
          ...(req.thinkingLevel !== undefined ? { thinkingLevel: req.thinkingLevel } : {}),
        });
      }
    } catch (error) {
      await chat.dispose("the harness refused the requested config").catch(() => undefined);
      throw new MeshRpcError(
        MeshErrorCode.invalid_params,
        `the harness refused the requested config: ${error instanceof Error ? error.message : String(error)}`,
        { code: "invalid_params" },
      );
    }
    const task: HostTask = {
      remoteTaskId,
      nodeId,
      harness: req.harness,
      cwd: req.cwd,
      chat,
      createdAt: this.deps.clock(),
      seq: 0,
      ring: [],
      ringBytes: 0,
      subscribers: new Set(),
      // A fresh chat holds no run, so the detached clock starts now; the first busy event clears it.
      settledSince: this.deps.clock(),
      keepAlive: chat.subscribe({ send: () => undefined, close: () => undefined }),
      openResult: { remoteTaskId, config: chat.snapshot().config, nativeId: chat.nativeId },
    };
    // The relay: raw harness events, in harness order, before the chat folds them — the same stream P1 served.
    chat.onHarnessEvent = (event) => this.onEvent(task, event);
    task.subscribers.add(link);
    link.subscribed.add(remoteTaskId);
    this.tasks.set(remoteTaskId, task);
    this.idempotent.set(key, remoteTaskId);
    // Evict only keys whose task is gone; a live task's key is dropped when the task closes.
    if (this.idempotent.size > MAX_IDEMPOTENT) {
      for (const [k, id] of this.idempotent) {
        if (this.idempotent.size <= MAX_IDEMPOTENT) break;
        if (!this.tasks.has(id)) this.idempotent.delete(k);
      }
    }
    return task.openResult;
  }

  /** One prompt, steering message, or queued follow-up on a task this node id owns. */
  async prompt(nodeId: string, remoteTaskId: string, mode: "prompt" | "steer" | "followUp", text: string): Promise<void> {
    const task = this.taskOf(nodeId, remoteTaskId);
    const sendMode: SendMode = mode === "prompt" ? "normal" : mode;
    try {
      await task.chat.send(text, sendMode);
    } catch (error) {
      throw chatError(error);
    }
  }

  /**
   * Answer one of the task's requests. First answer wins, whichever side gave
   * it (the peer over the wire, this node's own UI on the chat); the other
   * side's answer arrives at a resolved request and gets not_found.
   */
  async answer(nodeId: string, remoteTaskId: string, requestId: string, answer: InteractionAnswer): Promise<{ answered: true }> {
    const task = this.taskOf(nodeId, remoteTaskId);
    try {
      task.chat.answer(requestId, answer);
      return { answered: true };
    } catch (error) {
      if (error instanceof ChatError && (error.code === "request_resolved" || error.code === "chat_closed")) {
        throw new MeshRpcError(MeshErrorCode.not_found, "that request is not pending on the task", { code: "not_found" });
      }
      throw chatError(error);
    }
  }

  /** Abort the task's run; resolves when the chat is idle again. */
  async abort(nodeId: string, remoteTaskId: string): Promise<void> {
    const task = this.taskOf(nodeId, remoteTaskId);
    try {
      await task.chat.abort();
    } catch (error) {
      throw chatError(error);
    }
  }

  /** Dispose the task: the one request the wire offers that ends a run for good. */
  async close(nodeId: string, remoteTaskId: string): Promise<void> {
    await this.disposeTask(this.taskOf(nodeId, remoteTaskId), "closed by the peer");
  }

  /** The task's transcript as ChatItems (the leader's history refresh after a gap). */
  history(nodeId: string, remoteTaskId: string): ChatItem[] {
    return this.taskOf(nodeId, remoteTaskId).chat.snapshot().items;
  }

  /** Read the task's config, or set model/thinking level (serve has already refused everything else). */
  async config(nodeId: string, remoteTaskId: string, patch?: { model?: string; thinkingLevel?: string }): Promise<ChatConfig> {
    const task = this.taskOf(nodeId, remoteTaskId);
    try {
      if (patch !== undefined && (patch.model !== undefined || patch.thinkingLevel !== undefined)) {
        await task.chat.setConfig({
          ...(patch.model !== undefined ? { model: patch.model } : {}),
          ...(patch.thinkingLevel !== undefined ? { thinkingLevel: patch.thinkingLevel } : {}),
        });
      }
      return task.chat.snapshot().config;
    } catch (error) {
      throw chatError(error);
    }
  }

  /**
   * Subscribe this link to the task and replay every buffered event past
   * `afterSeq`, in order, then live. `gap` says the buffer no longer holds
   * everything after `afterSeq` — the leader then refreshes with task.history.
   * Synchronous on purpose: nothing can interleave the replay with a new event.
   */
  attach(link: HostLink, nodeId: string, remoteTaskId: string, afterSeq: number): HostAttachResult {
    const task = this.taskOf(nodeId, remoteTaskId);
    const ring = task.ring;
    // An empty ring missed nothing only when the caller is already up to date; else it dropped everything.
    const oldest = ring.length > 0 ? ring[0]!.seq : task.seq + 1;
    const gap = afterSeq + 1 < oldest;
    link.subscribed.add(task.remoteTaskId);
    task.subscribers.add(link);
    let replayed = 0;
    for (const entry of ring) {
      if (entry.seq <= afterSeq) continue;
      link.notify("task.event", { remoteTaskId: task.remoteTaskId, seq: entry.seq, event: entry.event });
      replayed++;
    }
    return { replayed, gap, state: task.chat.status };
  }

  /** This peer's live tasks, in the order they were opened. */
  list(nodeId: string): HostTaskEntry[] {
    const entries: HostTaskEntry[] = [];
    for (const task of this.tasks.values()) {
      if (task.nodeId !== nodeId) continue;
      entries.push({ remoteTaskId: task.remoteTaskId, harness: task.harness, cwd: task.cwd, state: task.chat.status, lastSeq: task.seq, createdAt: task.createdAt });
    }
    return entries;
  }

  /**
   * The detached-TTL sweep: a task with no attached link that has been settled
   * longer than mesh.detached_ttl_hours is disposed. A task still running, or
   * still holding work of its own (a request nobody answered, background jobs,
   * a queue), keeps running — closing a link must never drop work. Public so a
   * daemon can sweep on shutdown and a test can sweep on a fake clock.
   */
  async reap(): Promise<void> {
    const ttlMs = Math.max(1, this.deps.detachedTtlHours()) * 3_600_000;
    const now = this.deps.clock();
    for (const task of [...this.tasks.values()]) {
      if (task.subscribers.size > 0) continue;
      if (task.settledSince === null) continue;
      const chat = task.chat;
      if (chat.status !== "idle" && chat.status !== "error") continue;
      if (chat.pendingCount > 0 || chat.chainLength > 0 || chat.hasDeferredWork) continue;
      if (now - task.settledSince < ttlMs) continue;
      await this.disposeTask(task, `reaped: detached and settled longer than the ${this.deps.detachedTtlHours()}h TTL`);
    }
  }

  /** Dispose every host task (the mesh was turned off; the process is going down). Idempotent. */
  async disposeAll(reason: string): Promise<void> {
    await Promise.allSettled([...this.tasks.values()].map((task) => this.disposeTask(task, reason)));
  }

  /** Stop the sweep and dispose every task: what a daemon calls on its way out. */
  async shutdown(reason: string): Promise<void> {
    clearInterval(this.reaper);
    await this.disposeAll(reason);
  }

  /** The task, only for the node id that owns it: another key answers not_found, never a denial to probe with. */
  private taskOf(nodeId: string, remoteTaskId: string): HostTask {
    const task = this.tasks.get(remoteTaskId);
    if (task === undefined || task.nodeId !== nodeId) {
      throw new MeshRpcError(MeshErrorCode.not_found, `no task "${remoteTaskId}" is open for this peer`, { code: "not_found" });
    }
    return task;
  }

  /** Drop every record of one task, then dispose its chat. Subscribers stay subscribed to nothing: the id is gone from the map. */
  private async disposeTask(task: HostTask, reason: string): Promise<void> {
    this.tasks.delete(task.remoteTaskId);
    for (const [key, id] of this.idempotent) if (id === task.remoteTaskId) this.idempotent.delete(key);
    for (const link of task.subscribers) link.subscribed.delete(task.remoteTaskId);
    task.subscribers.clear();
    task.chat.onHarnessEvent = undefined;
    task.keepAlive();
    await task.chat.dispose(reason).catch((error: unknown) => this.log(`mesh host: disposing a task failed: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** One raw harness event: number it, remember it in the ring, and fan it out to every attached link. */
  private onEvent(task: HostTask, event: HarnessEvent): void {
    try {
      const seq = task.seq + 1;
      task.seq = seq;
      if (event.type === "busy" || (event.type === "compacting" && event.active)) task.settledSince = null;
      else if (event.type === "settled" || event.type === "fatal") task.settledSince = this.deps.clock();
      const payload = { remoteTaskId: task.remoteTaskId, seq, event };
      const bytes = Buffer.byteLength(JSON.stringify(payload));
      // One payload bigger than the whole ring could never be replayed anyway; live links still get it.
      if (bytes <= this.ringMaxBytes) {
        task.ring.push({ seq, event, bytes });
        task.ringBytes += bytes;
        while (task.ring.length > this.ringMaxEvents || task.ringBytes > this.ringMaxBytes) {
          const dropped = task.ring.shift();
          if (dropped === undefined) break;
          task.ringBytes -= dropped.bytes;
        }
      }
      for (const link of task.subscribers) link.notify("task.event", payload);
    } catch (error) {
      // The relay is bookkeeping: a failure in it must never break the chat's own event handling.
      this.log(`mesh host: relaying an event failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
