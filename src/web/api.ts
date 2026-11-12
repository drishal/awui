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

export async function api<T>(path: string, init: ApiInit = {}): Promise<T> {
  const method = init.method ?? (init.body === undefined ? "GET" : "POST");
  // Every mutating call carries a key, so a repeat of this exact request (its answer lost on
  // the way back) is recognised instead of applied twice.
  const key = MUTATING.has(method) ? (init.idempotencyKey ?? idempotencyKey()) : null;
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["content-type"] = "application/json";
  if (key !== null) headers[IDEMPOTENCY_KEY_HEADER] = key;
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: init.body === undefined ? null : JSON.stringify(init.body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "network", "Cannot reach the server");
  }
  if (!res.ok) {
    let data: { error?: string; code?: string } = {};
    try {
      data = (await res.json()) as typeof data;
    } catch {
      // non-JSON error body
    }
    if (res.status === 401 && path !== "/api/login") for (const l of unauthorizedListeners) l();
    throw new ApiError(res.status, data.code ?? `http_${res.status}`, data.error ?? res.statusText);
  }
  return (await res.json()) as T;
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}
