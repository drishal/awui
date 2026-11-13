import { IDEMPOTENCY_KEY_HEADER } from "../shared/protocol.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const unauthorizedListeners = new Set<() => void>();
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** The methods that have an effect: only these carry an idempotency key. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * A key for one logical mutating call, for a caller that may retry it: the server replays the
 * first answer instead of running the request twice (server/idempotency.ts). `crypto.randomUUID`
 * is missing on plain-HTTP LAN pages, where the fallback is still unique.
 */
export function idempotencyKey(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  return uuid ?? `k${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export interface ApiInit {
  method?: string;
  body?: unknown;
  /** Send this key again to retry the same call; a fresh one is minted when it is absent. */
  idempotencyKey?: string;
}

/** What one fetch answered, as text: shared by the callers of one read, each parsing its own copy. */
interface Answer {
  ok: boolean;
  status: number;
  statusText: string;
  text: string;
}

/**
 * Reads still on the wire, by path. A page asks for the same thing from several places at once (the
 * sidebar, a panel, and the shell each want the session list as it opens), and each used to cost the server
 * and the network a full answer. A repeat that arrives while the first is out joins it. Any change clears the
 * list, at its start and its end, so a read made after a change never takes an answer that began before it.
 */
const reading = new Map<string, Promise<Answer>>();

async function send(path: string, method: string, headers: Record<string, string>, body: string | null): Promise<Answer> {
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body, credentials: "same-origin", cache: "no-store" });
  } catch {
    throw new ApiError(0, "network", "Cannot reach the server");
  }
  return { ok: res.ok, status: res.status, statusText: res.statusText, text: await res.text().catch(() => "") };
}

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  // Every mutating call carries a key, so a repeat of this exact request (its answer lost on
  // the way back) is recognised instead of applied twice.
  const key = MUTATING.has(method) ? (init.idempotencyKey ?? idempotencyKey()) : null;
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (key !== null) headers[IDEMPOTENCY_KEY_HEADER] = key;
  const body = init.body === undefined ? null : JSON.stringify(init.body);
  let answer: Answer;
  if (method === "GET" && body === null) {
    let pending = reading.get(path);
    if (!pending) {
      pending = send(path, method, headers, body);
      reading.set(path, pending);
      const mine = pending;
      const done = () => {
        if (reading.get(path) === mine) reading.delete(path);
      };
      mine.then(done, done);
    }
    answer = await pending;
  } else {
    if (key !== null) reading.clear();
    try {
      answer = await send(path, method, headers, body);
    } finally {
      if (key !== null) reading.clear();
    }
  }
  if (!answer.ok) {
    let data: { error?: string; code?: string } = {};
    try {
      data = JSON.parse(answer.text) as typeof data;
    } catch {
      // non-JSON error body
    }
    if (answer.status === 401 && path !== "/api/login") for (const l of unauthorizedListeners) l();
    throw new ApiError(answer.status, data.code ?? `http_${answer.status}`, data.error ?? answer.statusText);
  }
  return JSON.parse(answer.text) as T;
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
