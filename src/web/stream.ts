// SSE client with an explicit reconnect policy, because phones sleep tabs:
// jittered backoff 0.5s→10s (then stay at the cap), a heartbeat watchdog,
// pause while offline, immediate retry on `online` / tab visible. A new
// EventSource does not send Last-Event-ID, so the last id goes in the query.
// One core serves both resources — a chat (/api/chats/:id/events, frames named
// `chat`) and a Board room (/api/rooms/:id/events, frames named `room`) — which
// differ only in URL, frame name, gone-probe, and which frame ends the stream.
import type { ChatEvent, OverviewEvent, RoomEvent } from "../shared/protocol.js";

export type ConnectionState = "connecting" | "connected" | "reconnecting" | "disconnected";

const TIERS_MS = [500, 1000, 2000, 4000, 8000, 10_000];
const HEARTBEAT_DEAD_MS = 45_000;

export interface StreamHandlers<E> {
  onEvent(event: E): void;
  onState(state: ConnectionState): void;
  /** The stream's resource no longer exists (404) or the browser is signed out (401). */
  onGone(status: number): void;
}

/** What differs between one stream and another. */
interface StreamShape<E> {
  /** The SSE frame name the server sends, one JSON `E` per frame. */
  readonly eventName: string;
  /** The stream's URL for its id; `from` is the caller's lastEventId, or null from nothing. */
  url(id: string, from: number | null): string;
  /** A cheap GET that answers 404/401 when the resource is gone for good. */
  probe(id: string): string;
  /** Whether this frame means the stream itself is over (nothing to reconnect to). */
  terminal?(event: E): boolean;
}

/** The connection policy both resources share; a subclass only names its shape. */
abstract class ReconnectingStream<E> {
  private es: EventSource | null = null;
  private lastId: number | null = null;
  private attempt = 0;
  private retryTimer: number | null = null;
  private watchdog: number | null = null;
  private lastAlive = Date.now();
  private stopped = false;
  private opened = false;

  /**
   * `from` is the lastEventId of a snapshot the caller already holds: the
   * server then replays only what came after it, instead of sending that
   * whole snapshot again (1.7 MB for a long chat).
   */
  protected constructor(
    private readonly shape: StreamShape<E>,
    private readonly id: string,
    private readonly handlers: StreamHandlers<E>,
    from: number | null = null,
  ) {
    this.lastId = from;
  }

  start(): void {
    window.addEventListener("online", this.onOnline);
    window.addEventListener("offline", this.onOffline);
    document.addEventListener("visibilitychange", this.onVisible);
    this.watchdog = window.setInterval(() => {
      if (this.es && Date.now() - this.lastAlive > HEARTBEAT_DEAD_MS) this.reconnectNow();
    }, 5000);
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    window.removeEventListener("online", this.onOnline);
    window.removeEventListener("offline", this.onOffline);
    document.removeEventListener("visibilitychange", this.onVisible);
    if (this.watchdog !== null) window.clearInterval(this.watchdog);
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.es?.close();
    this.es = null;
  }

  /** A caller got a new snapshot while a reconnect was pending: replay after it. */
  resumeFrom(id: number): void {
    if (this.es) return;
    this.lastId = Math.max(this.lastId ?? 0, id);
  }

  private setState(state: ConnectionState): void {
    if (!this.stopped) this.handlers.onState(state);
  }

  private connect(): void {
    if (this.stopped) return;
    if (!navigator.onLine) {
      this.setState("disconnected");
      return;
    }
    this.setState(this.attempt === 0 && !this.opened ? "connecting" : "reconnecting");
    const es = new EventSource(this.shape.url(this.id, this.lastId));
    this.es = es;
    this.lastAlive = Date.now();
    es.addEventListener("open", () => {
      this.opened = true;
      this.attempt = 0;
      this.lastAlive = Date.now();
      this.setState("connected");
    });
    es.addEventListener(this.shape.eventName, (message) => {
      const msg = message as MessageEvent<string>;
      this.lastAlive = Date.now();
      let event: E;
      try {
        event = JSON.parse(msg.data) as E;
      } catch {
        // Leave lastId untouched so a reconnect replays this frame.
        return;
      }
      if (msg.lastEventId) this.lastId = Number(msg.lastEventId);
      this.handlers.onEvent(event);
      if (this.shape.terminal?.(event) === true) this.stop();
    });
    es.addEventListener("heartbeat", () => {
      this.lastAlive = Date.now();
    });
    es.addEventListener("error", () => {
      if (this.es !== es) return;
      es.close();
      this.es = null;
      void this.afterError();
    });
  }

  /** Distinguish "gone" (404/401) from a transient drop before retrying. */
  private async afterError(): Promise<void> {
    if (this.stopped) return;
    try {
      const res = await fetch(this.shape.probe(this.id), { cache: "no-store", credentials: "same-origin" });
      if (res.status === 404 || res.status === 401) {
        this.setState("disconnected");
        this.handlers.onGone(res.status);
        this.stop();
        return;
      }
    } catch {
      // network down: fall through to backoff
    }
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    if (!navigator.onLine) {
      this.setState("disconnected");
      return;
    }
    const tier = TIERS_MS[Math.min(this.attempt, TIERS_MS.length - 1)] as number;
    this.attempt += 1;
    const delay = tier * (0.5 + Math.random() * 0.5);
    this.setState("reconnecting");
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
  }

  private reconnectNow(): void {
    if (this.stopped) return;
    this.es?.close();
    this.es = null;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.attempt = 0;
    this.connect();
  }

  private onOnline = () => this.reconnectNow();

  private onOffline = () => {
    this.es?.close();
    this.es = null;
    if (this.retryTimer !== null) window.clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.setState("disconnected");
  };

  private onVisible = () => {
    if (document.visibilityState === "visible" && !this.es) this.reconnectNow();
  };
}

/** The ordinary chat's stream: `chat` frames on /api/chats/:id/events, ended by `disposed`. */
export class ChatStream extends ReconnectingStream<ChatEvent> {
  constructor(chatId: string, handlers: StreamHandlers<ChatEvent>, from: number | null = null) {
    super(
      {
        eventName: "chat",
        url: (id, lastId) => `/api/chats/${encodeURIComponent(id)}/events${lastId !== null ? `?lastEventId=${lastId}` : ""}`,
        probe: (id) => `/api/chats/${encodeURIComponent(id)}`,
        terminal: (event) => event.type === "disposed",
      },
      chatId,
      handlers,
      from,
    );
  }
}

/** Lightweight session/room metadata stream: no transcript is sent on it. */
export class OverviewStream extends ReconnectingStream<OverviewEvent> {
  constructor(handlers: StreamHandlers<OverviewEvent>, from: number | null = null) {
    super(
      {
        eventName: "chat",
        url: (_id, lastId) => `/api/overview/events${lastId !== null ? `?lastEventId=${lastId}` : ""}`,
        probe: () => "/api/sessions",
      },
      "overview",
      handlers,
      from,
    );
  }
}

/** A Board room's stream: `room` frames on /api/rooms/:id/events, ended by `disposed`. */
export class RoomStream extends ReconnectingStream<RoomEvent> {
  constructor(roomId: string, handlers: StreamHandlers<RoomEvent>, from: number | null = null) {
    super(
      {
        eventName: "room",
        url: (id, lastId) => `/api/rooms/${encodeURIComponent(id)}/events${lastId !== null ? `?lastEventId=${lastId}` : ""}`,
        probe: (id) => `/api/rooms/${encodeURIComponent(id)}`,
        terminal: (event) => event.type === "disposed",
      },
      roomId,
      handlers,
      from,
    );
  }
}
