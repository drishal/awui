// The mesh's terminal host (P3 §1, worker side): the daemon-side store of peer
// PTYs, keyed by term id and owned by node id exactly the way host tasks are.
// The spawn is the target's own TerminalManager — its shell, its environment,
// its kill path, its per-machine dims check — so nothing a caller sends can
// name a shell, an env var, or a command: the wire carries a cwd, columns and
// rows, and input bytes, and the target decides everything else. Output is
// coalesced (≤ 16 ms, ≤ 64 KiB a frame) into numbered term.output
// notifications, with a 1 MiB ring so a reconnecting link's term.attach can
// replay what it missed; a terminal no link has held for an hour is closed.
// The audit trail is byte counts: terminal content is the user's, never
// evidence. Daemon mode keeps terminals across link drops; an ephemeral
// worker's serve() disposes the host it was handed with the link.
import { promises as fs } from "node:fs";
import type { WorkspaceInfo } from "../../shared/protocol.js";
import { ChatError } from "../chats/chat.js";
import type { TerminalManager } from "../terminal.js";
import { HostLink } from "./host.js";
import { resolveInRoots, type PeerPolicy } from "./policy.js";
import { MeshErrorCode, MeshRpcError } from "./rpc.js";

/** The spec's per-node cap: at most 4 open terminals for one node id (and never more than max_tasks allows). */
export const MAX_TERMS_PER_NODE = 4;
/** One term.input's biggest payload, bytes: the same figure the wire schema spells out. */
export const MAX_INPUT_BYTES = 64 * 1024;
/** The scrollback ring one terminal keeps for term.attach, bytes. */
export const RING_MAX_BYTES = 1024 * 1024;
/** Output coalescing: one frame holds at most this many bytes… */
const COALESCE_MAX_BYTES = 64 * 1024;
/** …and never waits longer than this for more. */
const COALESCE_MS = 16;
/** A terminal with no attached link is closed after an hour (the spec's detached reaping). */
const DEFAULT_DETACHED_TTL_MS = 3_600_000;
/** The detached-TTL sweep: often enough to be prompt, rarely enough to matter. */
const REAP_INTERVAL_MS = 60_000;
/** Finding #5: at most 30 terminal openings per node id in any sliding minute, the local terminal's own pace. */
const MAX_CREATES_PER_MINUTE = 30;

export interface TermHostDeps {
  /** The target's own PTY spawner: the shell, the env, and the kill path are this machine's, never the caller's. */
  manager: TerminalManager;
  /** Epoch milliseconds; injected so the detached reaper is testable. */
  clock: () => number;
  /** A detached terminal is closed after this long (default 1 h). */
  detachedTtlMs?: number;
  /** Test seams: a faster coalescing window and smaller frames/ring, so bounds are provable in a run. */
  coalesce?: { maxMs: number; maxBytes: number };
  ringMaxBytes?: number;
  log?: (message: string) => void;
}

export interface TermOpenParams {
  cwd: string;
  cols: number;
  rows: number;
}

/** One entry of `term.list`: this peer's terminals, in the order they were opened. */
export interface HostTermEntry {
  termId: string;
  cwd: string;
  cols: number;
  rows: number;
  createdAt: number;
  exited: boolean;
  /** The seq of the last term.output sent; nothing was ever sent is 0. */
  lastSeq: number;
}

/**
 * One row of the owner's own listing (finding #2): a term.list entry plus the
 * peer it belongs to, keyed for the read-only view with its kill action.
 */
export interface HostTermOwnerRow extends HostTermEntry {
  /** The peer's handshake name, as its link authenticated. */
  peerName: string;
  nodeId: string;
}

/** `term.attach`'s answer: what the replay cost and whether the ring reached back that far. */
export interface HostTermAttachResult {
  replayed: number;
  gap: boolean;
}

interface RingEntry {
  seq: number;
  data: Buffer;
}

interface HostTerm {
  termId: string;
  nodeId: string;
  cwd: string;
  /** The peer's handshake name, so the owner's own listing can say whose terminal this is. */
  peerName: string;
  cols: number;
  rows: number;
  createdAt: number;
  /** The synthetic workspace the target's TerminalManager holds this terminal under. */
  ws: WorkspaceInfo;
  /** The seq of the last term.output sent; a terminal's first frame is 1. */
  seq: number;
  ring: RingEntry[];
  ringBytes: number;
  exited: boolean;
  exit: { code: number; signal?: number } | null;
  /** The links currently receiving output; empty means detached, which is what the TTL reaper gates on. */
  subscribers: Set<HostLink>;
  /** When the last link detached, or null while one holds the terminal. */
  detachedSince: number | null;
  /** The chunks held for the next coalesced frame. */
  pending: Buffer[];
  pendingBytes: number;
  flushTimer: ReturnType<typeof setTimeout> | null;
  /** The manager subscription that feeds onOutput/onExit; held for the terminal's whole life. */
  unsubscribe: () => void;
}

/** The target's own refusal (a dims bound it will not honor, a spawn that failed), in the wire's terms. */
function ptyError(error: unknown): MeshRpcError {
  if (error instanceof ChatError) {
    if (error.status === 400) return new MeshRpcError(MeshErrorCode.invalid_params, error.message, { code: "invalid_params" });
    if (error.status === 409 || error.status === 429) return new MeshRpcError(MeshErrorCode.limit, error.message, { code: "limit" });
  }
  // A spawn failure is this machine's to diagnose locally; the peer gets no local detail.
  return new MeshRpcError(MeshErrorCode.internal_error, "the terminal could not be started on this machine", { code: "internal_error" });
}

const denied = (message: string): MeshRpcError => new MeshRpcError(MeshErrorCode.denied, message, { code: "denied" });

export class TermHost {
  private readonly terms = new Map<string, HostTerm>();
  private readonly clock: () => number;
  private readonly ttlMs: number;
  private readonly coalesceMs: number;
  private readonly coalesceBytes: number;
  private readonly ringMax: number;
  private readonly log: (message: string) => void;
  private readonly reaper: NodeJS.Timeout;
  /** term.open calls in flight per node id (finding #5): part of the per-node cap until the PTY lands or fails. */
  private readonly openingByNode = new Map<string, number>();
  /** Create times per node id in the last minute, for the 30/min open pace. */
  private readonly createTimes = new Map<string, number[]>();


  constructor(private readonly deps: TermHostDeps) {
    this.clock = deps.clock;
    this.ttlMs = deps.detachedTtlMs ?? DEFAULT_DETACHED_TTL_MS;
    this.coalesceMs = deps.coalesce?.maxMs ?? COALESCE_MS;
    this.coalesceBytes = deps.coalesce?.maxBytes ?? COALESCE_MAX_BYTES;
    this.ringMax = deps.ringMaxBytes ?? RING_MAX_BYTES;
    this.log = deps.log ?? (() => undefined);
    this.reaper = setInterval(() => void this.reap().catch((error: unknown) => this.log(`mesh terms: the TTL sweep failed: ${error instanceof Error ? error.message : String(error)}`)), REAP_INTERVAL_MS);
    this.reaper.unref();
  }

  /** One new link: its terminals hang from this handle and detach together at its close. */
  openLink(notify: (method: string, params: unknown) => void): HostLink {
    return new HostLink(notify);
  }

  /**
   * term.open: one PTY in a resolved policy root, spawned by the target's own
   * TerminalManager — so the shell and environment are the worker user's, and
   * the dims bound is the machine's own. The opening link is subscribed at
   * once; per node id at most 4 terminals (and never more than the policy's
   * max_tasks) are live. Finding #5: the bound counts opens in flight too —
   * the check and its counter are synchronous, so concurrent opens cannot all
   * see room for one — and one node id may open at most 30 a minute, the local
   * terminal's own pace.
   */
  async open(link: HostLink, nodeId: string, peerName: string, policy: PeerPolicy, home: string, params: TermOpenParams): Promise<{ termId: string; createdAt: number }> {
    const resolved = await resolveInRoots(policy, params.cwd, home);
    if (!resolved.ok) throw denied(`the requested cwd is refused: ${resolved.reason}`);
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(resolved.real);
    } catch {
      // A cwd that does not exist is refused just below.
    }
    if (stat === null || !stat.isDirectory()) throw denied("the requested cwd is not an existing directory");
    const cap = Math.min(MAX_TERMS_PER_NODE, Math.max(1, policy.maxTasks));
    let live = 0;
    for (const term of this.terms.values()) if (term.nodeId === nodeId && !term.exited) live++;
    const opening = this.openingByNode.get(nodeId) ?? 0;
    if (live + opening >= cap) {
      throw new MeshRpcError(MeshErrorCode.limit, `this peer already holds ${live + opening} live or opening terminals and the policy allows ${cap}`, { code: "limit" });
    }
    this.takeCreateSlot(nodeId);
    // The synthetic workspace keys the manager's own per-workspace caps to this node id; the
    // path is already realpathed by resolveInRoots, so the manager's own check passes.
    const ws: WorkspaceInfo = { id: `mesh-term:${nodeId}`, path: resolved.real, name: peerName };
    // Counted before the first await of the spawn, so concurrent opens cannot
    // all pass the cap: the slot is held until the PTY lands or fails.
    this.openingByNode.set(nodeId, opening + 1);
    let made: { id: string; createdAt: number };
    try {
      made = await this.deps.manager.create(ws, params.cols, params.rows);
    } catch (error) {
      throw ptyError(error);
    } finally {
      const left = (this.openingByNode.get(nodeId) ?? 1) - 1;
      if (left <= 0) this.openingByNode.delete(nodeId);
      else this.openingByNode.set(nodeId, left);
    }
    const term: HostTerm = {
      termId: made.id,
      nodeId,
      peerName,
      cwd: resolved.real,
      cols: params.cols,
      rows: params.rows,
      createdAt: made.createdAt,
      ws,
      seq: 0,
      ring: [],
      ringBytes: 0,
      exited: false,
      exit: null,
      subscribers: new Set(),
      detachedSince: null,
      pending: [],
      pendingBytes: 0,
      flushTimer: null,
      unsubscribe: () => undefined,
    };
    term.unsubscribe = this.deps.manager.subscribe(ws, made.id, {
      onOutput: (chunk) => this.onOutput(term, chunk),
      onExit: (code, signal) => this.onExit(term, code, signal),
    });
    this.terms.set(term.termId, term);
    term.subscribers.add(link);
    link.subscribed.add(term.termId);
    return { termId: term.termId, createdAt: term.createdAt };
  }

  /**
   * One of this node's 30-per-minute create slots; a refused or failed open
   * still spends it, exactly as a refused fs.write spends its write slot. The
   * window reads the injected clock, so a test can move it.
   */
  private takeCreateSlot(nodeId: string): void {
    const now = this.clock();
    const times: number[] = [];
    for (const at of this.createTimes.get(nodeId) ?? []) if (now - at < 60_000) times.push(at);
    if (times.length >= MAX_CREATES_PER_MINUTE) {
      this.createTimes.set(nodeId, times);
      throw new MeshRpcError(MeshErrorCode.limit, `this peer already opened ${MAX_CREATES_PER_MINUTE} terminals in the last minute`, { code: "limit" });
    }
    times.push(now);
    this.createTimes.set(nodeId, times);
  }

  /** term.input: bytes to the terminal's PTY, at most MAX_INPUT_BYTES; an exited terminal eats them silently. */
  async input(nodeId: string, termId: string, dataBase64: string): Promise<void> {
    const term = this.termOf(nodeId, termId);
    const data = Buffer.from(dataBase64, "base64");
    if (data.length > MAX_INPUT_BYTES) {
      throw new MeshRpcError(MeshErrorCode.limit, `one term.input is bounded to ${MAX_INPUT_BYTES} bytes`, { code: "limit" });
    }
    if (term.exited) return;
    try {
      this.deps.manager.write(term.ws, termId, data.toString("utf8"));
    } catch (error) {
      throw ptyError(error);
    }
  }

  /** term.resize: the same dims the target's own terminals answer. */
  async resize(nodeId: string, termId: string, cols: number, rows: number): Promise<void> {
    const term = this.termOf(nodeId, termId);
    if (term.exited) return;
    try {
      this.deps.manager.resize(term.ws, termId, cols, rows);
    } catch (error) {
      throw ptyError(error);
    }
    term.cols = cols;
    term.rows = rows;
  }

  /** term.close: the one request that ends a terminal for good; the PTY's own exit event follows. */
  async close(nodeId: string, termId: string): Promise<void> {
    this.disposeTerm(this.termOf(nodeId, termId));
  }

  /**
   * term.attach: replay the ring past this seq, in order, then stream live.
   * Synchronous on purpose: nothing can interleave the replay with a new frame.
   * `gap` says the ring no longer reaches back to afterSeq.
   */
  attach(link: HostLink, nodeId: string, termId: string, afterSeq: number): HostTermAttachResult {
    const term = this.termOf(nodeId, termId);
    // Whatever the PTY printed while nobody watched joins the replay, in order, before it.
    this.flush(term);
    const oldest = term.ring.length > 0 ? term.ring[0]!.seq : term.seq + 1;
    const gap = afterSeq + 1 < oldest;
    link.subscribed.add(term.termId);
    term.subscribers.add(link);
    term.detachedSince = null;
    let replayed = 0;
    for (const entry of term.ring) {
      if (entry.seq <= afterSeq) continue;
      link.notify("term.output", { termId: term.termId, seq: entry.seq, data: entry.data.toString("base64") });
      replayed++;
    }
    return { replayed, gap };
  }

  /** term.list: this peer's terminals, live and exited, in the order they were opened. */
  list(nodeId: string): HostTermEntry[] {
    const entries: HostTermEntry[] = [];
    for (const term of this.terms.values()) {
      if (term.nodeId !== nodeId) continue;
      entries.push({ termId: term.termId, cwd: term.cwd, cols: term.cols, rows: term.rows, createdAt: term.createdAt, exited: term.exited, lastSeq: term.seq });
    }
    return entries;
  }

  /** Every terminal every peer holds, the owner's read-only listing (finding #2, SPEC-P3 §1). */
  listAll(): HostTermOwnerRow[] {
    const entries: HostTermOwnerRow[] = [];
    for (const term of this.terms.values()) {
      entries.push({ termId: term.termId, peerName: term.peerName, nodeId: term.nodeId, cwd: term.cwd, cols: term.cols, rows: term.rows, createdAt: term.createdAt, exited: term.exited, lastSeq: term.seq });
    }
    return entries;
  }

  /**
   * The owner's kill (finding #2): close one terminal by id alone — the
   * owner-facing route has no node id — exactly as the peer's own term.close
   * would. False when no such terminal is open.
   */
  closeById(termId: string): boolean {
    const term = this.terms.get(termId);
    if (term === undefined) return false;
    this.disposeTerm(term);
    return true;
  }

  /**
   * The link's stream ended: drop every subscription it holds. A live terminal
   * starts its detached clock; an exited one is disposed at once, its output
   * having nowhere left to go.
   */
  closeLink(link: HostLink): void {
    for (const id of link.subscribed) {
      const term = this.terms.get(id);
      if (term === undefined) continue;
      term.subscribers.delete(link);
      if (term.subscribers.size > 0) continue;
      if (term.exited) this.disposeTerm(term);
      else term.detachedSince = this.clock();
    }
    link.subscribed.clear();
  }

  /**
   * The detached-TTL sweep: a terminal no link has held for the TTL is
   * closed, as is every exited terminal nobody attached any more. A terminal
   * still attached keeps running. Public so a test can sweep on a fake clock.
   */
  async reap(): Promise<void> {
    const now = this.clock();
    for (const term of [...this.terms.values()]) {
      if (term.subscribers.size > 0) continue;
      if (term.exited) {
        this.disposeTerm(term);
        continue;
      }
      if (term.detachedSince !== null && now - term.detachedSince >= this.ttlMs) {
        this.disposeTerm(term);
      }
    }
  }

  /** Close every terminal (the mesh was turned off; an ephemeral link ended). Idempotent. */
  async disposeAll(): Promise<void> {
    for (const term of [...this.terms.values()]) this.disposeTerm(term);
  }

  /** Stop the sweep and close every terminal: what a daemon calls on its way out. */
  async shutdown(): Promise<void> {
    clearInterval(this.reaper);
    await this.disposeAll();
  }

  /** The terminal, only for the node id that owns it: another key answers not_found, never a denial to probe with. */
  private termOf(nodeId: string, termId: string): HostTerm {
    const term = this.terms.get(termId);
    if (term === undefined || term.nodeId !== nodeId) {
      throw new MeshRpcError(MeshErrorCode.not_found, `no terminal "${termId}" is open for this peer`, { code: "not_found" });
    }
    return term;
  }

  /** Drop every record of one terminal and close its PTY. Idempotent per call site by map membership. */
  private disposeTerm(term: HostTerm): void {
    if (!this.terms.delete(term.termId)) return;
    for (const link of term.subscribers) link.subscribed.delete(term.termId);
    term.subscribers.clear();
    if (term.flushTimer !== null) {
      clearTimeout(term.flushTimer);
      term.flushTimer = null;
    }
    term.pending.length = 0;
    term.pendingBytes = 0;
    // The manager's own close kills the process tree; the exit event it triggers finds the
    // record already gone and tells nobody, exactly as the local UI's own Close does.
    try {
      this.deps.manager.close(term.ws, term.termId);
    } catch {
      // Already evicted by the manager's own 60 s replay window: nothing left to close.
    }
  }

  /** One PTY chunk: hold it for the next coalesced frame, flushing early only when a frame is already full. */
  private onOutput(term: HostTerm, chunk: string): void {
    if (this.terms.get(term.termId) !== term) return;
    const buf = Buffer.from(chunk, "utf8");
    term.pending.push(buf);
    term.pendingBytes += buf.length;
    if (term.pendingBytes >= this.coalesceBytes) {
      this.flush(term);
      return;
    }
    if (term.flushTimer === null) {
      term.flushTimer = setTimeout(() => {
        term.flushTimer = null;
        this.flush(term);
      }, this.coalesceMs);
      term.flushTimer.unref?.();
    }
  }

  /** Number and send the pending output, in frames of at most the frame bound, remembered in the ring and fanned out to every attached link. */
  private flush(term: HostTerm): void {
    if (term.flushTimer !== null) {
      clearTimeout(term.flushTimer);
      term.flushTimer = null;
    }
    if (term.pending.length === 0) return;
    const data = Buffer.concat(term.pending);
    term.pending.length = 0;
    term.pendingBytes = 0;
    for (let at = 0; at < data.length; at += this.coalesceBytes) {
      const frame = data.subarray(at, Math.min(at + this.coalesceBytes, data.length));
      const seq = term.seq + 1;
      term.seq = seq;
      // One frame bigger than the whole ring could never be replayed anyway; live links still get it.
      if (frame.length <= this.ringMax) {
        term.ring.push({ seq, data: Buffer.from(frame) });
        term.ringBytes += frame.length;
        while (term.ringBytes > this.ringMax) {
          const dropped = term.ring.shift();
          if (dropped === undefined) break;
          term.ringBytes -= dropped.data.length;
        }
      }
      const payload = { termId: term.termId, seq, data: frame.toString("base64") };
      for (const link of term.subscribers) link.notify("term.output", payload);
    }
  }

  /** The PTY ended: flush what it last printed, tell every link, and drop the record when nobody is left to tell. */
  private onExit(term: HostTerm, code: number, signal?: number): void {
    if (this.terms.get(term.termId) !== term || term.exited) return;
    this.flush(term);
    term.exited = true;
    term.exit = { code, ...(signal !== undefined ? { signal } : {}) };
    for (const link of term.subscribers) link.notify("term.exit", { termId: term.termId, code, ...(signal !== undefined ? { signal } : {}) });
    if (term.subscribers.size === 0) this.disposeTerm(term);
  }
}
