// The mesh's leader side (P1): one live link per configured peer, made on demand and
// reused by every task that targets that machine. A link is a spawned transport (ssh
// or a container exec; an in-process pair in tests) carrying the wire protocol from
// rpc.ts, brought up through the mutual handshake and held to the pinned key from the
// first contact on — TOFU is an explicit opt-in for `peer add`, never a silent default.
// The manager owns nothing else: tasks, approvals, and transcripts stay where they
// always were (the orchestrator's records, the chat, the worker's own harness), and
// this module only keeps the pipe to the other machine warm and tells the holders of
// a connection when that pipe went away.
import type { Readable, Writable } from "node:stream";
import type { MeshConfig } from "../user-config.js";
import type { HarnessEvent } from "../harness/types.js";
import { clientHandshake } from "./handshake.js";
import type { NodeIdentity } from "./identity.js";
import type { PinStore } from "./pins.js";
import { mergePeers, type MeshPeerEntry } from "./peer-store.js";
import type { PeerTermEvent } from "./peer-terms.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "./rpc.js";
import { ASKABLE_RPC_TIMEOUT_MS, DEFAULT_RECONNECT_PLAN, type PeerReconnectPlan } from "./peer-adapter.js";
import { connectTls } from "./tls.js";
import { linkOf, spawnLink } from "./transport.js";
import type { PeerLink } from "./transport.js";

/** One spawned transport to a worker's `awui peer serve-stdio`. */
export interface PeerSpawn {
  /** What the worker writes (its stdout). */
  input: Readable;
  /** What the worker reads (its stdin). */
  output: Writable;
  kill(): void;
  /** The last of the worker's stderr, for an error about a link that never came up. */
  stderrTail?(): string;
}

/** One config.yml `mesh.peers[]` entry, as the parsed schema types it. */
type ConfigPeer = NonNullable<MeshConfig["peers"]>[number];

export interface PeerManagerDeps {
  identity: () => Promise<NodeIdentity>;
  pins: PinStore;
  /** config.yml's `mesh:` block, re-read at each connect, so a file change needs no restart. */
  config: () => MeshConfig | undefined;
  enabled: () => boolean;
  /** This node's own mesh name: what the handshake presents and the accept line names. */
  localName: () => string;
  /** How a link is started; the real transports by default, an in-process pair in tests. */
  spawn?: (peerName: string, link: PeerLink) => PeerSpawn;
  /**
   * Peers saved from the UI or CLI (mesh/peers.json), read per call and merged
   * with config's (config wins on a name clash); absent means config only.
   */
  savedPeers?: () => MeshPeerEntry[];
  /** How a dropped link under an unsettled task is retried; tests inject a faster plan. */
  reconnect?: { schedule?: number[]; giveUpMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> };
  log?: (message: string) => void;
  /**
   * Finding #3: how often a shared link with live tasks or terminals sends a
   * `peer.ping` keepalive (default 4 minutes, comfortably under the target's
   * 10-minute idle bound). A test injects milliseconds.
   */
  keepaliveMs?: number;
}

/** One file's shape on a peer, as `fs.stat` reports it: lstat, so a final symlink is never followed. */
export interface PeerFileStat {
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
  mode: number;
}

/** One row of a peer folder listing. */
export interface PeerFileEntry {
  name: string;
  type: PeerFileStat["type"];
  size: number;
}

export interface PeerFileListing {
  entries: PeerFileEntry[];
  truncated: boolean;
}

/** One chunk of a peer file, decoded from the wire's base64. */
export interface PeerFileContents {
  data: Buffer;
  size: number;
  eof: boolean;
}

export interface PeerFileWriteResult {
  size: number;
  mtimeMs: number;
}

/** One live task on a peer, as `task.list` reports it (its own words for state). */
export interface PeerTaskRow {
  remoteTaskId: string;
  harness: string;
  cwd: string;
  state: string;
  lastSeq: number;
  createdAt: number;
}

/** One task event from a worker, with the per-task sequence number it arrived under. */
export type PeerTaskListener = (event: HarnessEvent, seq: number) => void;

/** One entry of the configured outbound inventory, as a listing shows it. */
export interface PeerEntry {
  name: string;
  kind: "ssh" | "docker" | "tls";
  pinned: boolean;
}


/**
 * The caps field of a `peer.info` answer, exactly as serve()'s info() promises
 * it: `{allow: Cap[], ask: Cap[]}`, nothing else. A malformed answer is not
 * cached — an absent caps field means the peer predates the advertisement, and
 * the leader says nothing rather than something wrong.
 */
export function infoCaps(info: unknown): { allow: string[]; ask: string[] } | null {
  if (typeof info !== "object" || info === null || Array.isArray(info)) return null;
  const caps = (info as { caps?: unknown }).caps;
  if (typeof caps !== "object" || caps === null || Array.isArray(caps)) return null;
  const record = caps as Record<string, unknown>;
  const strings = (value: unknown): string[] | null =>
    Array.isArray(value) ? value.filter((cap): cap is string => typeof cap === "string") : null;
  const allow = strings(record.allow);
  const ask = strings(record.ask);
  return allow === null || ask === null ? null : { allow, ask };
}
/** The link error codes whose message a worker's stderr tail can explain (a command that never ran). */
const TAIL_CODES = new Set<number>([MeshErrorCode.timeout, MeshErrorCode.link_closed]);

/**
 * One live connection to a peer. `task.event` and the term.* notifications are
 * routed per remote id (what nobody listens for is dropped), and when the link
 * goes — EOF, a protocol violation, our own close — every holder that asked to
 * know is told once, and the manager forgets the connection so the next use
 * reconnects.
 */
/**
 * One live connection to a peer. `task.event` and the term.* notifications are
 * routed per remote id (what nobody listens for is dropped), and when the link
 * goes — EOF, a protocol violation, our own close — every holder that asked to
 * know is told once, and the manager forgets the connection so the next use
 * reconnects.
 */
export interface PeerConnectionOpts {
  /** Told with the peer's `peer.info` answer whenever one completes, so the manager can cache its caps. */
  onInfo?: (peerName: string, info: unknown) => void;
  /**
   * Finding #3: while this link has tasks or terminals streaming, a quiet ping
   * every few minutes keeps the target's idle bound honest — a link that only
   * relays the target's own frames never writes from this side, and without a
   * ping the target would cut it mid-run. Unref'd, so it never holds the process.
   */
  keepaliveMs?: number;
}

export class PeerConnection {
  readonly rpc: RpcPeer;
  private readonly taskListeners = new Map<string, Set<PeerTaskListener>>();
  private readonly termListeners = new Map<string, Set<(event: PeerTermEvent) => void>>();
  private readonly closeListeners = new Set<() => void>();
  private readonly onInfo: (peerName: string, info: unknown) => void;
  private readonly keepalive: ReturnType<typeof setInterval>;
  private gone = false;

  constructor(
    /** Asked to drop this connection from the manager's cache once its link is gone. */
    private readonly forget: (connection: PeerConnection) => void,
    readonly name: string,
    readonly serverKey: Buffer,
    readonly sas: string,
    readonly paired: boolean,
    readonly policy: string,
    rpc: RpcPeer,
    private readonly kill: () => void,
    opts: PeerConnectionOpts = {},
  ) {
    this.rpc = rpc;
    this.onInfo = opts.onInfo ?? (() => undefined);
    rpc.onNotification((method, params) => this.deliver(method, params));
    // The one place a link's death is noticed: the cache is cleared before the holders are
    // told, so a listener reconnecting right away cannot get the dead connection back.
    void rpc.closed.then(() => {
      this.forget(this);
      this.markGone();
    });
    this.keepalive = setInterval(() => {
      if (this.gone || (this.taskListeners.size === 0 && this.termListeners.size === 0)) return;
      // Pings are liveness, not a decision: the target never audits them.
      void this.rpc.request("peer.ping", {}, 30_000).catch(() => undefined);
    }, opts.keepaliveMs ?? 4 * 60_000);
    this.keepalive.unref?.();
  }

  /** Whether the link is already gone; a gone link accepts nothing and answers nothing. */
  get closed(): boolean {
    return this.gone;
  }

  /** The worker's `peer.info` answer, unchecked: what the caller asked the far side about itself. The answer's caps reach the manager's cache (finding #1). */
  info(): Promise<unknown> {
    return this.rpc.request("peer.info", {}).then(
      (answer: unknown) => {
        this.onInfo(this.name, answer);
        return answer;
      },
      (error: unknown) => {
        throw error;
      },
    );
  }

  /** Events for one remote task, as the relay of that task's chat asked to see them. */
  onTaskEvent(remoteTaskId: string, listener: PeerTaskListener): () => void {
    const set = this.taskListeners.get(remoteTaskId) ?? new Set();
    set.add(listener);
    this.taskListeners.set(remoteTaskId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.taskListeners.delete(remoteTaskId);
    };
  }

  /** Output and exit frames for one remote terminal, as its proxy asked to see them (P3). */
  onTermEvent(termId: string, listener: (event: PeerTermEvent) => void): () => void {
    const set = this.termListeners.get(termId) ?? new Set();
    set.add(listener);
    this.termListeners.set(termId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.termListeners.delete(termId);
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  close(): void {
    // Dropped from the cache before the link is torn down: a caller reconnecting
    // right after a close must never be handed this dying connection back.
    this.forget(this);
    this.rpc.close("closed by the leader");
    this.kill();
  }

  /** One worker notification routed to the task or terminal it names; a malformed one is dropped, never fatal to the link. */
  private deliver(method: string, params: unknown): void {
    const record = typeof params === "object" && params !== null && !Array.isArray(params) ? (params as Record<string, unknown>) : null;
    if (record === null) return;
    if (method === "term.output") {
      const termId = record.termId;
      const seq = record.seq;
      const data = record.data;
      if (typeof termId !== "string" || typeof seq !== "number" || typeof data !== "string") return;
      const listeners = this.termListeners.get(termId);
      if (listeners === undefined) return;
      for (const listener of [...listeners]) listener({ type: "output", seq, data });
      return;
    }
    if (method === "term.exit") {
      const termId = record.termId;
      const code = record.code;
      if (typeof termId !== "string" || typeof code !== "number") return;
      const listeners = this.termListeners.get(termId);
      if (listeners === undefined) return;
      const signal = typeof record.signal === "number" ? record.signal : undefined;
      for (const listener of [...listeners]) listener({ type: "exit", code, ...(signal !== undefined ? { signal } : {}) });
      return;
    }
    if (method !== "task.event") return;
    const remoteTaskId = record.remoteTaskId;
    const seq = record.seq;
    const event = record.event;
    if (typeof remoteTaskId !== "string" || typeof seq !== "number" || typeof event !== "object" || event === null || typeof (event as { type?: unknown }).type !== "string") return;
    const listeners = this.taskListeners.get(remoteTaskId);
    if (listeners === undefined) return;
    for (const listener of [...listeners]) listener(event as HarnessEvent, seq);
  }

  /** The link is gone: everyone waiting on it is told once, and nothing routes after this. */
  private markGone(): void {
    if (this.gone) return;
    this.gone = true;
    clearInterval(this.keepalive);
    for (const listener of [...this.closeListeners]) listener();
    this.closeListeners.clear();
    this.taskListeners.clear();
    this.termListeners.clear();
  }
}

export class PeerManager {
  private readonly live = new Map<string, PeerConnection>();
  /** One shared spawn per peer: a second caller while the first handshake runs rides its promise. */
  private readonly connecting = new Map<string, Promise<PeerConnection>>();
  /** Peer names known to hold an outbound pin, as of the last connect or pin: a listing's flag, never a promise. */
  private readonly pinnedNames = new Set<string>();

  /** The last `peer.info` caps answer per peer name (finding #1): what /api/mesh advertises without dialing anyone. */
  private readonly caps = new Map<string, { allow: string[]; ask: string[] }>();
  /** probeCaps calls in flight, and when each peer was last probed: a probe per peer at most once a minute. */
  private readonly probing = new Set<string>();
  private readonly probedAt = new Map<string, number>();
  /** How long a failed or fresh probe waits before another (the Peers panel polls every 3 s). */
  private static readonly PROBE_COOLDOWN_MS = 60_000;
  /** How a dropped link under an unsettled task is retried (peer-adapter.ts consumes it). */
  get reconnectPlan(): PeerReconnectPlan {
    const over = this.deps.reconnect ?? {};
    return {
      schedule: over.schedule ?? DEFAULT_RECONNECT_PLAN.schedule,
      giveUpMs: over.giveUpMs ?? DEFAULT_RECONNECT_PLAN.giveUpMs,
      now: over.now ?? DEFAULT_RECONNECT_PLAN.now,
      sleep: over.sleep ?? DEFAULT_RECONNECT_PLAN.sleep,
    };
  }

  constructor(private readonly deps: PeerManagerDeps) {}

  /** The outbound inventory — config's peers plus the saved ones — with no network and no link started: what a listing names and a delegation accepts. */
  peers(): PeerEntry[] {
    return this.entries().map((peer) => ({
      name: peer.name,
      kind: peer.ssh !== undefined ? "ssh" : peer.docker !== undefined ? "docker" : "tls",
      pinned: this.pinnedNames.has(peer.name),
    }));
  }

  /** Every peer this node knows how to reach, merged: config wins wherever both name the same machine. */
  private entries(): MeshPeerEntry[] {
    return mergePeers(this.deps.config()?.peers ?? [], this.deps.savedPeers?.() ?? []);
  }

  /** Writes (or rewrites) the outbound pin for a peer: what a TOFU first contact is confirmed into. */
  async pin(peerName: string, serverKey: Buffer): Promise<void> {
    await this.deps.pins.setOutbound(peerName, serverKey);
    this.pinnedNames.add(peerName);
  }

  /** One live connection per peer, shared by every caller: the first connect spawns, the rest reuse it. */
  /** Caches one peer's advertised caps from its `peer.info` answer, whatever link completed it. */
  noteInfo(peerName: string, info: unknown): void {
    const caps = infoCaps(info);
    if (caps !== null) this.caps.set(peerName, caps);
  }

  /** The last caps this peer advertised, or null before any probe answered (finding #1). */
  capsOf(peerName: string): { allow: string[]; ask: string[] } | null {
    return this.caps.get(peerName) ?? null;
  }

  /**
   * One background caps probe (finding #1): connect over the shared link and
   * ask `peer.info`, caching what it advertises. Never throws — an offline or
   * unpaired peer simply keeps whatever it last said — and never piles up: one
   * probe per peer at a time, and a cooldown before the next, so a panel
   * polling /api/mesh every few seconds cannot spawn a probe storm.
   */
  async probeCaps(peerName: string): Promise<void> {
    if (this.probing.has(peerName)) return;
    const last = this.probedAt.get(peerName);
    if (last !== undefined && Date.now() - last < PeerManager.PROBE_COOLDOWN_MS) return;
    this.probing.add(peerName);
    this.probedAt.set(peerName, Date.now());
    try {
      const connection = await this.connect(peerName);
      await connection.info();
    } catch {
      // Unreachable, off, or not accepted yet: the cache keeps the last good answer.
    } finally {
      this.probing.delete(peerName);
    }
  }

  connect(peerName: string, opts: { tofu?: boolean } = {}): Promise<PeerConnection> {
    const existing = this.live.get(peerName);
    if (existing) return Promise.resolve(existing);
    const inflight = this.connecting.get(peerName);
    if (inflight) return inflight;
    const opened = this.open(peerName, opts).finally(() => this.connecting.delete(peerName));
    this.connecting.set(peerName, opened);
    return opened;
  }

  /** How long one task.list call may wait: the worker answers from memory, so this is a hang guard, not a budget. */
  private static readonly FILE_RPC_MS = 30_000;
  /** The wire's own bounds (spec P1.5 §3), held here too so a caller's bug cannot become a peer's problem. */
  private static readonly MAX_READ_BYTES = 512 * 1024;
  private static readonly MAX_LIST_ENTRIES = 1_000;

  /**
   * `fs.stat` on the peer: what the file is, without following its final symlink. The
   * worker's policy (`fs.read`) decides; this side only shapes the request.
   */
  async stat(peerName: string, target: string): Promise<PeerFileStat> {
    const connection = await this.connect(peerName);
    return (await connection.rpc.request("fs.stat", { path: target }, ASKABLE_RPC_TIMEOUT_MS)) as PeerFileStat;
  }

  /** `fs.list` on the peer: one folder's names, dotfiles included, never recursive. */
  async list(peerName: string, target: string, limit?: number): Promise<PeerFileListing> {
    const connection = await this.connect(peerName);
    const bounded = limit === undefined ? undefined : Math.max(1, Math.min(limit, PeerManager.MAX_LIST_ENTRIES));
    return (await connection.rpc.request("fs.list", { path: target, ...(bounded !== undefined ? { limit: bounded } : {}) }, ASKABLE_RPC_TIMEOUT_MS)) as PeerFileListing;
  }

  /** `fs.read` on the peer: one bounded chunk, decoded from base64. */
  async read(peerName: string, target: string, opts: { offset?: number; length?: number } = {}): Promise<PeerFileContents> {
    const connection = await this.connect(peerName);
    const length = opts.length === undefined ? PeerManager.MAX_READ_BYTES : Math.max(1, Math.min(opts.length, PeerManager.MAX_READ_BYTES));
    const answer = (await connection.rpc.request(
      "fs.read",
      { path: target, offset: Math.max(0, opts.offset ?? 0), length },
      ASKABLE_RPC_TIMEOUT_MS,
    )) as { data: unknown; size?: unknown; eof?: unknown };
    if (typeof answer?.data !== "string") throw new Error(`the peer "${peerName}" answered fs.read without data`);
    return { data: Buffer.from(answer.data, "base64"), size: typeof answer.size === "number" ? answer.size : 0, eof: answer.eof === true };
  }

  /** `fs.write` on the peer: atomic on the far side (temp file, fsync, rename); mode and the mtime guard travel along. */
  async write(peerName: string, target: string, data: Buffer, opts: { mode: "create" | "overwrite"; expectMtimeMs?: number }): Promise<PeerFileWriteResult> {
    const connection = await this.connect(peerName);
    return (await connection.rpc.request(
      "fs.write",
      {
        path: target,
        data: data.toString("base64"),
        mode: opts.mode,
        ...(opts.expectMtimeMs !== undefined ? { expectMtimeMs: opts.expectMtimeMs } : {}),
      },
      ASKABLE_RPC_TIMEOUT_MS,
    )) as PeerFileWriteResult;
  }
  // ---- handoff over the link (P3 §2): one bundle each way, in bounded chunks ----

  /** One handoff wire call's wait: a finish runs a fetch of up to the bundle cap on the far side. */
  private static readonly HANDOFF_RPC_MS = 10 * 60_000;

  /** handoff.begin: names the repo, size, and sha256 the worker must end up holding. */
  async handoffBegin(peerName: string, params: { repoCwd: string; size: number; sha256: string }): Promise<{ uploadId: string }> {
    const connection = await this.connect(peerName);
    return (await connection.rpc.request("handoff.begin", params, PeerManager.HANDOFF_RPC_MS)) as { uploadId: string };
  }

  /** handoff.chunk: one ordered slice, raw bytes in, base64 on the wire. */
  async handoffChunk(peerName: string, uploadId: string, index: number, data: Buffer): Promise<void> {
    const connection = await this.connect(peerName);
    await connection.rpc.request("handoff.chunk", { uploadId, index, data: data.toString("base64") }, PeerManager.HANDOFF_RPC_MS);
  }

  /** handoff.finish: verify, fetch, and the worktree the peer's copy of the work landed in. */
  async handoffFinish(peerName: string, uploadId: string): Promise<{ worktree: string }> {
    const connection = await this.connect(peerName);
    return (await connection.rpc.request("handoff.finish", { uploadId }, PeerManager.HANDOFF_RPC_MS)) as { worktree: string };
  }

  /** handoff.abort: the leader's cleanup when its own upload failed mid-way. */
  async handoffAbort(peerName: string, uploadId: string): Promise<void> {
    const connection = await this.connect(peerName);
    await connection.rpc.request("handoff.abort", { uploadId }, PeerManager.FILE_RPC_MS);
  }

  /** handoff.export: a bundle of a peer worktree's HEAD, ready to page back. */
  async handoffExport(peerName: string, worktree: string): Promise<{ exportId: string; size: number; sha256: string; head: string }> {
    const connection = await this.connect(peerName);
    return (await connection.rpc.request("handoff.export", { worktree }, PeerManager.HANDOFF_RPC_MS)) as { exportId: string; size: number; sha256: string; head: string };
  }

  /** handoff.read: one ordered slice of an export, decoded from base64. */
  async handoffRead(peerName: string, exportId: string, index: number): Promise<Buffer> {
    const connection = await this.connect(peerName);
    const page = (await connection.rpc.request("handoff.read", { exportId, index }, PeerManager.HANDOFF_RPC_MS)) as { data: unknown; eof?: unknown };
    if (typeof page?.data !== "string") throw new Error(`the peer "${peerName}" answered handoff.read without data`);
    return Buffer.from(page.data, "base64");
  }

  /** `task.list` on the peer: its own live tasks for this caller, for `awui peer tasks`. */
  async taskList(peerName: string): Promise<PeerTaskRow[]> {
    const connection = await this.connect(peerName);
    const rows = await connection.rpc.request("task.list", {}, PeerManager.FILE_RPC_MS);
    if (!Array.isArray(rows)) return [];
    // The worker's own words for state and cwd; a row without the fields a listing shows is dropped, not guessed at.
    return rows.filter((row): row is PeerTaskRow =>
      typeof row === "object" && row !== null &&
      typeof (row as PeerTaskRow).remoteTaskId === "string" && (row as PeerTaskRow).remoteTaskId !== "" &&
      typeof (row as PeerTaskRow).harness === "string" &&
      typeof (row as PeerTaskRow).cwd === "string" &&
      typeof (row as PeerTaskRow).state === "string" &&
      typeof (row as PeerTaskRow).lastSeq === "number" &&
      typeof (row as PeerTaskRow).createdAt === "number");
  }

  /** The entry for a peer name, case-insensitively (the schema keeps names unique that way), from the merged list. */
  private findEntry(peerName: string): ConfigPeer | null {
    return this.entries().find((peer) => peer.name.toLowerCase() === peerName.toLowerCase()) ?? null;
  }

  private async open(peerName: string, opts: { tofu?: boolean }): Promise<PeerConnection> {
    if (!this.deps.enabled()) throw new Error("The mesh is turned off: set mesh.enabled true in config.yml to reach peers");
    const entry = this.findEntry(peerName);
    if (entry === null) throw new Error(`No mesh peer called "${peerName}" is configured`);
    const link = linkOf(entry);
    const identity = await this.deps.identity();
    const pin = await this.deps.pins.outbound(entry.name);
    if (pin !== null) this.pinnedNames.add(entry.name);
    let rpc: RpcPeer;
    let kill: () => void;
    let stderrTail: (() => string) | undefined;
    /** A TLS link folds its session's exporter value into the handshake; stdio links sign the P1 transcript. */
    let binding: Buffer | undefined;
    if (link.kind === "tls") {
      // Direct TLS (P2): dial the peer's own listener; the certificate is never
      // the trust — the pin and the binding are (see tls.ts).
      const dialed = await connectTls(link.address, { timeoutMs: 10_000 });
      binding = dialed.binding;
      rpc = new RpcPeer(dialed.link, dialed.link, { role: "client", log: (message) => this.log(message) });
      kill = () => dialed.link.destroy();
    } else {
      const spawn = this.deps.spawn ?? ((_name: string, l: PeerLink) => spawnLink(l, this.deps.localName()));
      const child = spawn(entry.name, link);
      rpc = new RpcPeer(child.input, child.output, { role: "client", log: (message) => this.log(message) });
      kill = child.kill;
      stderrTail = () => child.stderrTail?.() ?? "";
    }
    rpc.start();
    let connection: PeerConnection;
    try {
      const outcome = await clientHandshake(rpc, {
        identity,
        name: this.deps.localName(),
        hops: 0,
        expectedServerKey: pin?.publicKey ?? null,
        tofu: opts.tofu === true,
        binding,
      });
      if (!outcome.paired && opts.tofu !== true) {
        // Not paired is the normal first-contact state. The fix is a command on the target, and
        // a link that will refuse every task is worth nothing to the caller, so it never leaves here.
        throw new Error(
          `Peer "${entry.name}" has not accepted this machine yet. On the target, run: awui peer accept ${this.deps.localName()} --policy worker`,
        );
      }
      connection = new PeerConnection(
        (candidate) => {
          if (this.live.get(entry.name) === candidate) this.live.delete(entry.name);
        },
        entry.name,
        outcome.serverKey,
        outcome.sas,
        outcome.paired,
        outcome.policy,
        rpc,
        kill,
        {
          // Finding #1: every completed peer.info feeds the caps cache /api/mesh
          // advertises; finding #3: the link's quiet periods get a keepalive ping.
          onInfo: (name, info) => this.noteInfo(name, info),
          keepaliveMs: this.deps.keepaliveMs,
        },
      );
    } catch (error) {
      // The handshake closes the rpc on its own failures; the child is this spawn's to stop.
      rpc.close("connect failed");
      kill();
      // A worker that never came up (no awui on the far side, a bad path) says why on stderr;
      // that tail is the only diagnostic the caller of a dead link ever gets.
      const tail = stderrTail?.() ?? "";
      if (tail !== "" && error instanceof MeshRpcError && TAIL_CODES.has(error.code)) {
        throw new Error(`${error.message}\n${entry.name}'s stderr: ${tail}`);
      }
      throw error;
    }
    this.live.set(entry.name, connection);
    return connection;
  }

  private log(message: string): void {
    (this.deps.log ?? (() => undefined))(message);
  }
}
