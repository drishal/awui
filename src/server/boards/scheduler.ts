// One room's serial turn state: at most one active top-level turn, a bounded
// queue of user turns behind it, a cancellation generation that makes late
// asynchronous work from a stopped turn harmless, and the recent clientId ->
// turn map that keeps a retried post from posting twice.
import type { RoomTurnView } from "../../shared/protocol.js";
import type { StoredQueuedTurn, StoredRuntime } from "./types.js";

/** How many recent idempotency keys a room keeps (in memory and in runtime.json). */
const MAX_CLIENT_TURNS = 50;

export interface ActiveTurn {
  view: RoomTurnView;
  stored: StoredQueuedTurn;
  /** Resolved members in rank order; empty only if the lead vanished between queueing and running. */
  directMemberIds: string[];
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export class RoomScheduler {
  generation = 0;
  queued: StoredQueuedTurn[] = [];
  active: ActiveTurn | null = null;
  running = false;
  /** Every turn id ever queued by clientId, most recent last; bounded on write. */
  readonly clientTurns = new Map<string, RoomTurnView>();
  private activeDone: { promise: Promise<void>; resolve: () => void } | null = null;

  restore(runtime: StoredRuntime): void {
    this.generation = runtime.generation;
    this.queued = [...runtime.queue];
    for (const entry of runtime.clientTurns ?? []) this.clientTurns.set(entry.clientId, entry.turn);
    while (this.clientTurns.size > MAX_CLIENT_TURNS) {
      const oldest = this.clientTurns.keys().next().value;
      if (oldest === undefined) break;
      this.clientTurns.delete(oldest);
    }
  }

  remember(clientId: string | undefined, turn: RoomTurnView): void {
    if (!clientId) return;
    this.clientTurns.delete(clientId);
    this.clientTurns.set(clientId, turn);
    while (this.clientTurns.size > MAX_CLIENT_TURNS) {
      const oldest = this.clientTurns.keys().next().value;
      if (oldest === undefined) break;
      this.clientTurns.delete(oldest);
    }
  }

  /** Take the next queued turn as the active one; null when the queue is empty. */
  next(directMemberIds: string[]): ActiveTurn | null {
    const stored = this.queued.shift();
    if (!stored) return null;
    const now = Date.now();
    const view: RoomTurnView = {
      id: stored.id,
      state: "running",
      text: stored.text,
      mentions: [...stored.mentions],
      directMemberIds: [...directMemberIds],
      queuedAt: stored.queuedAt,
      startedAt: now,
      endedAt: null,
      invocationCount: 0,
      consultCount: 0,
    };
    this.active = { view, stored, directMemberIds };
    this.running = true;
    this.activeDone = deferred();
    this.remember(stored.clientId, view);
    return this.active;
  }

  /** The active turn is over (done, stopped, or failed); the pump may take the next. */
  finish(): void {
    this.running = false;
    this.active = null;
    const done = this.activeDone;
    this.activeDone = null;
    done?.resolve();
  }

  /** The active turn's settlement, for Stop to wait on; already resolved when nothing runs. */
  settled(): Promise<void> {
    return this.activeDone?.promise ?? Promise.resolve();
  }

  /** Update the view everywhere it is remembered (live state and the idempotency map). */
  update(view: RoomTurnView, clientId: string | undefined): void {
    if (this.active?.view.id === view.id) this.active.view = view;
    this.remember(clientId, view);
  }

  runtime(): StoredRuntime {
    return {
      activeTurnId: this.active?.view.id ?? null,
      queue: [...this.queued],
      generation: this.generation,
      clientTurns: [...this.clientTurns.entries()].map(([clientId, turn]) => ({ clientId, turn })),
    };
  }
}
