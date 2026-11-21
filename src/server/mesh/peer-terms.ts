// The mesh's leader side of remote terminals (P3 §1): proxies that look like
// the TerminalManager's own terminals to the rest of the server, so the
// existing terminal REST and SSE routes serve a peer's PTY unchanged. One
// proxy owns one term.open on one peer: input and resizes cross as term.input
// and term.resize, output arrives as numbered term.output frames, and the exit
// as term.exit. A dropped link is bridged the way a dropped task is
// (peer-adapter.ts): reconnect on the same backoff, term.attach with the last
// seq seen, replay folded by seq so nothing streams twice — and a terminal
// that is gone for good (not_found, a peer that predates attach) ends the
// stream as an exit instead of hanging the browser. The proxy keeps a local
// replay buffer so a subscriber that arrives late sees what the peer already
// printed, exactly as a local terminal replays its own history.
import { ASKABLE_RPC_TIMEOUT_MS, DEFAULT_RECONNECT_PLAN, type PeerReconnectPlan } from "./peer-adapter.js";
import type { PeerConnection, PeerManager } from "./manager.js";
import { MeshErrorCode, MeshRpcError } from "./rpc.js";
import type { PeerTerminalHandle, TerminalSubscriber } from "../terminal.js";

/** What a peer terminal's id is on this side: `peer:<peer>:<worker's termId>`, the spec's prefix. */
export const peerTerminalId = (peerName: string, termId: string): string => `peer:${peerName}:${termId}`;

/** The replay a late subscriber gets, the same 1 MiB a local terminal keeps. */
const REPLAY_CAP = 1024 * 1024;

/** One term.output/term.exit from the worker, as PeerConnection routes it. */
export type PeerTermEvent = { type: "output"; seq: number; data: string } | { type: "exit"; code: number; signal?: number };

export interface PeerTerminalsDeps {
  /** How a link to the named peer is made and shared (the mesh's PeerManager). */
  manager: Pick<PeerManager, "connect" | "reconnectPlan">;
}
export interface PeerTerminalOptions {
  /** A fresh connection to the same peer; absent means a lost link ends the terminal. */
  reconnect?: () => Promise<PeerConnection>;
  /** The retry plan; the manager's, so a test can run the window without waiting. */
  plan?: PeerReconnectPlan;
}

/**
 * PeerTerminals is the TerminalManager hook: every create request that names a
 * peer opens one terminal over the shared link and hands back its proxy.
 */
export class PeerTerminals {
  constructor(private readonly deps: PeerTerminalsDeps) {}

  async open(peer: string, peerCwd: string, cols: number, rows: number): Promise<{ id: string; createdAt: number; handle: PeerTerminalHandle }> {
    const connection = await this.deps.manager.connect(peer);
    const opened = await connection.rpc.request<unknown>("term.open", { cwd: peerCwd, cols, rows }, ASKABLE_RPC_TIMEOUT_MS);
    const record = typeof opened === "object" && opened !== null ? (opened as { termId?: unknown }) : null;
    if (record === null || typeof record.termId !== "string" || record.termId === "" || record.termId.length > 64) {
      throw new Error(`the peer "${peer}" opened a terminal without an id`);
    }
    const terminal = new PeerTerminal(connection, peer, record.termId, {
      reconnect: () => this.deps.manager.connect(peer),
      plan: this.deps.manager.reconnectPlan,
    });
    return { id: peerTerminalId(peer, record.termId), createdAt: Date.now(), handle: terminal };
  }
}

/**
 * One remote terminal as the routes see it. Everything it exposes mirrors a
 * local record: writes are bounded and chunked by the caller (TerminalManager),
 * a subscriber gets the replay and then live output, the last subscriber's
 * leaving closes the terminal, and `gone` fires once when the terminal can no
 * longer be reached from here.
 */
export class PeerTerminal implements PeerTerminalHandle {
  private readonly subscribers = new Set<TerminalSubscriber>();
  private replay = "";
  private exited = false;
  private exit: { code: number; signal?: number } | null = null;
  private lastSeq = 0;
  private gone = false;
  private readonly goneListeners = new Set<() => void>();
  private reconnecting = false;
  private connection: PeerConnection;
  private offTerm: () => void;
  private offClose: () => void;
  private readonly reconnect: (() => Promise<PeerConnection>) | null;
  private readonly plan: PeerReconnectPlan;

  constructor(connection: PeerConnection, private readonly peerName: string, readonly termId: string, opts: PeerTerminalOptions = {}) {
    this.connection = connection;
    this.reconnect = opts.reconnect ?? null;
    this.plan = opts.plan ?? DEFAULT_RECONNECT_PLAN;
    this.offTerm = connection.onTermEvent(termId, (event) => this.onTermEvent(event));
    this.offClose = connection.onClose(() => this.onLinkLost());
  }

  write(data: string): void {
    if (this.gone || this.exited) return;
    // Fire and forget, as a local PTY write is: a terminal that cannot take it ends as an exit below.
    void this.connection.rpc
      .request("term.input", { termId: this.termId, data: Buffer.from(data, "utf8").toString("base64") })
      .catch((error: unknown) => {
        if (error instanceof MeshRpcError && error.code === MeshErrorCode.not_found) this.finish(-1);
      });
  }

  resize(cols: number, rows: number): void {
    if (this.gone || this.exited) return;
    void this.connection.rpc.request("term.resize", { termId: this.termId, cols, rows }).catch(() => undefined);
  }

  close(): void {
    this.setGone();
    if (!this.exited) void this.connection.rpc.request("term.close", { termId: this.termId }).catch(() => undefined);
  }

  subscribe(subscriber: TerminalSubscriber): () => void {
    this.subscribers.add(subscriber);
    if (this.replay !== "") subscriber.onOutput(this.replay);
    if (this.exited && this.exit !== null) subscriber.onExit(this.exit.code, this.exit.signal);
    return () => {
      this.subscribers.delete(subscriber);
      // The same ownership a local terminal answers: with nobody watching, the PTY is closed.
      if (this.subscribers.size === 0 && !this.gone) this.close();
    };
  }

  onGone(listener: () => void): void {
    this.goneListeners.add(listener);
    if (this.gone) listener();
  }

  /** One worker frame: newer seqs only, so a replay after a reconnect never streams twice. */
  private onTermEvent(event: PeerTermEvent): void {
    if (this.gone) return;
    if (event.type === "output") {
      if (event.seq <= this.lastSeq) return;
      this.lastSeq = event.seq;
      const text = Buffer.from(event.data, "base64").toString("utf8");
      this.replay = (this.replay + text).slice(-REPLAY_CAP);
      for (const subscriber of [...this.subscribers]) {
        try { subscriber.onOutput(text); } catch { /* one client does not stall the link */ }
      }
      return;
    }
    this.finish(event.code, event.signal);
  }

  /** The terminal ended: tell whoever watches, and drop the record from every holder. */
  private finish(code: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    this.exit = { code, ...(signal !== undefined ? { signal } : {}) };
    this.offTerm();
    this.offClose();
    for (const subscriber of [...this.subscribers]) {
      try { subscriber.onExit(code, signal); } catch { /* no noisy clients */ }
    }
    this.subscribers.clear();
    this.setGone();
  }

  /**
   * One visible line into the stream (finding #10): it joins the replay buffer
   * and reaches every live subscriber, exactly as a frame from the peer would,
   * so a warning the terminal itself prints can never be lost to a late join.
   */
  private emitNotice(text: string): void {
    this.replay = (this.replay + text).slice(-REPLAY_CAP);
    for (const subscriber of [...this.subscribers]) {
      try { subscriber.onOutput(text); } catch { /* one client does not stall the link */ }
    }
  }

  /** The one-way door every proxy owns: gone is once, and after it nothing else happens. */
  private setGone(): void {
    if (this.gone) return;
    this.gone = true;
    this.offTerm();
    this.offClose();
    for (const listener of [...this.goneListeners]) listener();
    this.goneListeners.clear();
  }

  /** The link died under this terminal: reconnect while it lives, else end the stream as an exit. */
  private onLinkLost(): void {
    if (this.gone || this.reconnecting) return;
    if (this.reconnect === null) {
      this.finish(-1);
      return;
    }
    this.reconnecting = true;
    void this.reconnectLoop();
  }

  /**
   * The recovery a dropped task gets (peer-adapter.ts), shaped for a terminal:
   * retry the link on the backoff schedule, then term.attach with the last seq
   * seen, so the worker replays exactly what was missed. A terminal that no
   * longer exists, or a worker that predates attach, ends the stream as an
   * exit; anything else is worth another attempt within the window.
   */
  private async reconnectLoop(): Promise<void> {
    const startedAt = this.plan.now();
    for (let attempt = 0; this.plan.now() - startedAt < this.plan.giveUpMs; attempt++) {
      await this.plan.sleep(this.plan.schedule[Math.min(attempt, this.plan.schedule.length - 1)] ?? 30_000);
      if (this.gone || this.exited) return;
      let fresh: PeerConnection | null = null;
      let dropTerm: (() => void) | null = null;
      try {
        fresh = await this.reconnect!();
        // Subscribed before the attach, so the replayed frames are routed, not dropped;
        // the seq filter absorbs the overlap either way.
        const offTerm = fresh.onTermEvent(this.termId, (event) => this.onTermEvent(event));
        dropTerm = offTerm;
        if (fresh.closed) throw new MeshRpcError(MeshErrorCode.link_closed, "the fresh link closed before the attach finished", { code: "link_closed" });
        const attached = (await fresh.rpc.request("term.attach", { termId: this.termId, afterSeq: this.lastSeq })) as { gap?: unknown } | null;
        // Finding #10: a gap means the ring no longer reaches back to where
        // this side last read — scrollback was lost while the link was down,
        // and silence would read as intact history. One visible line, the same
        // warning a reattached task carries.
        if (attached?.gap === true) this.emitNotice(`\r\n[awui: reconnected, but earlier output was lost while the link was down]\r\n`);
        if (fresh.closed) throw new MeshRpcError(MeshErrorCode.link_closed, "the fresh link closed under the reattached terminal", { code: "link_closed" });
        if (this.gone || this.exited) {
          // The terminal was closed or ended while the attach was in flight: the fresh link
          // is the manager's to keep or drop, but it is no longer this terminal's.
          dropTerm();
          return;
        }
        const offClose = fresh.onClose(() => this.onLinkLost());
        this.offTerm = offTerm;
        this.offClose = offClose;
        this.connection = fresh;
        this.reconnecting = false;
        return;
      } catch (error) {
        dropTerm?.();
        const linkLevel = !(error instanceof MeshRpcError) || error.code === MeshErrorCode.link_closed || error.code === MeshErrorCode.timeout;
        if (linkLevel) fresh?.close();
        if (
          error instanceof MeshRpcError &&
          (error.code === MeshErrorCode.not_found ||
            error.code === MeshErrorCode.method_not_found ||
            error.code === MeshErrorCode.denied ||
            error.code === MeshErrorCode.not_paired)
        ) {
          // The terminal is gone on the peer, or the peer predates attach: end the
          // stream as an exit instead of retrying, exactly as a lost link ended a task.
          this.reconnecting = false;
          this.finish(-1);
          return;
        }
        // Anything else (a link that would not come up, a timeout) is worth another
        // attempt within the window; the terminal keeps running on the far side.
      }
    }
    this.reconnecting = false;
    this.finish(-1);
  }
}
