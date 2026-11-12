// The awui server as atui reaches it: the same JSON API and event
// stream the browser uses (src/web/api.ts, src/web/stream.ts), read from a
// fetch body since a terminal app has no EventSource.
import { IDEMPOTENCY_KEY_HEADER, type ChatEvent } from "../shared/protocol.js";

/** The methods that have an effect: only these carry an idempotency key. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** A key for one logical mutating call; pass it again to retry that call (server/idempotency.ts). */
export function idempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `k${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export class ServerError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class Server {
  constructor(readonly base: string) {}

  async call<T>(path: string, init: { method?: string; body?: unknown; idempotencyKey?: string } = {}): Promise<T> {
    const method = init.method ?? (init.body === undefined ? "GET" : "POST");
    // A mutating call carries a key, so a repeat of this exact request (its answer lost on the
    // way back) is recognised instead of applied twice. A caller retrying it passes the same one.
    const key = MUTATING.has(method) ? (init.idempotencyKey ?? idempotencyKey()) : null;
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (key !== null) headers[IDEMPOTENCY_KEY_HEADER] = key;
    let res: Response;
    try {
      res = await fetch(this.base + path, {
        method,
        headers,
        body: init.body === undefined ? null : JSON.stringify(init.body),
      });
    } catch {
      throw new ServerError(0, "network", `Cannot reach the awui server at ${this.base}`);
    }
    if (!res.ok) {
      let data: { error?: string; code?: string } = {};
      try {
        data = (await res.json()) as typeof data;
      } catch {
        // non-JSON error body
      }
      throw new ServerError(res.status, data.code ?? `http_${res.status}`, data.error ?? res.statusText);
    }
    return (await res.json()) as T;
  }

  /** A binary resource (a prompt's image), or null when it is gone or the server is unreachable. */
  async bytes(path: string): Promise<Uint8Array | null> {
    try {
      const res = await fetch(this.base + path);
      return res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }
}

export type Connection = "connecting" | "connected" | "reconnecting";

export interface StreamHandlers {
  onEvent(event: ChatEvent): void;
  onState(state: Connection): void;
  /** The chat no longer exists (404) or needs a sign-in (401). */
  onGone(status: number): void;
}

const TIERS_MS = [500, 1000, 2000, 4000, 8000, 10_000];
const HEARTBEAT_DEAD_MS = 45_000;

/** Follows a chat's events, reconnecting with backoff and replaying from the last id; returns a stop function. */
export function followChat(server: Server, chatId: string, from: number | null, handlers: StreamHandlers): () => void {
  let lastId = from;
  let attempt = 0;
  let opened = false;
  let stopped = false;
  let controller: AbortController | null = null;
  let wake: (() => void) | null = null;

  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  const run = async () => {
    while (!stopped) {
      handlers.onState(opened ? "reconnecting" : "connecting");
      controller = new AbortController();
      let alive = Date.now();
      const watchdog = setInterval(() => {
        if (Date.now() - alive > HEARTBEAT_DEAD_MS) controller?.abort();
      }, 5000);
      try {
        const query = lastId !== null ? `?lastEventId=${lastId}` : "";
        const res = await fetch(`${server.base}/api/chats/${encodeURIComponent(chatId)}/events${query}`, {
          signal: controller.signal,
          headers: { accept: "text/event-stream" },
        });
        if (res.status === 404 || res.status === 401) {
          stopped = true;
          handlers.onGone(res.status);
          return;
        }
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        attempt = 0;
        opened = true;
        handlers.onState("connected");
        for await (const message of readEvents(res.body)) {
          alive = Date.now();
          if (message.event !== "chat") continue;
          let event: ChatEvent;
          try {
            event = JSON.parse(message.data) as ChatEvent;
          } catch {
            // Leave lastId untouched so a reconnect replays this frame.
            continue;
          }
          if (message.id) lastId = Number(message.id);
          handlers.onEvent(event);
          if (event.type === "disposed") {
            stopped = true;
            return;
          }
        }
      } catch {
        // dropped: back off and reconnect
      } finally {
        clearInterval(watchdog);
      }
      if (stopped) return;
      const tier = TIERS_MS[Math.min(attempt, TIERS_MS.length - 1)] as number;
      attempt += 1;
      await pause(tier * (0.5 + Math.random() * 0.5));
    }
  };
  void run();
  return () => {
    stopped = true;
    controller?.abort();
    wake?.();
  };
}

interface SseMessage {
  id: string | null;
  event: string;
  data: string;
}

/** Server-sent events from a response body (the server ends lines with \n). */
export async function* readEvents(body: AsyncIterable<Uint8Array>): AsyncGenerator<SseMessage> {
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | null = null;
  let event = "message";
  let data: string[] = [];
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl !== -1) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      nl = buffer.indexOf("\n");
      if (line === "") {
        if (data.length > 0) yield { id, event, data: data.join("\n") };
        id = null;
        event = "message";
        data = [];
        continue;
      }
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
      else if (field === "event") event = value;
      else if (field === "id") id = value;
    }
  }
}
