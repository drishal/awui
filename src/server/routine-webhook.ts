// A routine's webhook trigger, kept pure so it can be tested: what the sender signs,
// which requests count, and what the run's prompt carries. A hook is off until a
// routine enables one, and then only a request that signs the body with that routine's
// own secret (HMAC-SHA256, hex) and passes its filters starts a run. The receiver is
// the one /api route that is not a browser session: see docs/security.md for exactly
// what is reachable, and from where.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { RoutineHook } from "../shared/protocol.js";

/** A hook body is one event's JSON: bigger than this is not a delivery worth reading. */
export const MAX_HOOK_BODY = 64 * 1024;
/** How much of the body a prompt may carry (the bounded-payload rule, for the model's side). */
export const MAX_HOOK_IN_PROMPT = 4_000;
/** The prompt placeholder a hook's body is substituted into. */
export const HOOK_PLACEHOLDER = "{{webhook}}";
/** Deliveries remembered per routine, and for how long: the same delivery twice does not run twice. */
export const MAX_SEEN = 200;
export const SEEN_TTL_MS = 10 * 60_000;
/** Deliveries one routine may receive in an hour: a loop or a wrong sender cannot flood the agent. */
export const MAX_HOOKS_PER_HOUR = 60;

/** The header a sender signs with (`X-Awui-Signature: sha256=<hex>`), besides GitHub's own. */
export const SIGNATURE_HEADER = "x-awui-signature";
/** GitHub signs its webhooks this way, with the same HMAC and encoding. */
export const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";

/** The signature a sender must send for this body: `sha256=<hex>`. */
export function signatureOf(secret: string, raw: string): string {
  return `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`;
}

/** Whether a signature header means this body, in constant time. */
export function signatureMatches(secret: string, raw: string, header: string | undefined): boolean {
  const given = (header ?? "").trim().toLowerCase();
  if (!given.startsWith("sha256=")) return false;
  const want = signatureOf(secret, raw);
  const a = Buffer.from(given, "utf8");
  const b = Buffer.from(want, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** A value at a dotted path (`action`, `pull_request.merged`, `commits.0.id`), as a string. */
export function valueAtPath(body: unknown, path: string): string | null {
  if (!path.trim()) return null;
  let node: unknown = body;
  for (const part of path.split(".")) {
    if (node === null || node === undefined) return null;
    if (Array.isArray(node)) {
      const index = Number(part);
      node = Number.isInteger(index) ? node[index] : undefined;
      continue;
    }
    if (typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[part];
  }
  if (node === null || node === undefined) return null;
  if (typeof node === "string") return node;
  if (typeof node === "number" || typeof node === "boolean") return String(node);
  return JSON.stringify(node);
}

/**
 * Whether this delivery is the routine's to run: its header filter (a GitHub event, say)
 * and its body filter both have to agree, when either is set.
 */
export function hookMatches(hook: RoutineHook, header: (name: string) => string | undefined, body: unknown): boolean {
  if (hook.header && (header(hook.header) ?? "") !== hook.headerValue) return false;
  if (hook.path && valueAtPath(body, hook.path) !== hook.pathValue) return false;
  return true;
}

/**
 * What makes this delivery one of a kind: the sender's own delivery id (a header, for
 * GitHub `X-GitHub-Delivery`) or a value in the body. Null when the hook names neither,
 * and then a repeat is a second run.
 */
export function deliveryKey(hook: RoutineHook, header: (name: string) => string | undefined, body: unknown): string | null {
  const fromHeader = header("x-awui-dedupe") ?? header("x-github-delivery");
  if (fromHeader) return fromHeader.slice(0, 200);
  if (hook.dedupePath) return valueAtPath(body, hook.dedupePath)?.slice(0, 200) ?? null;
  return null;
}

/** The prompt a hook's run carries: the routine's own, with the body where `{{webhook}}` was. */
export function hookPrompt(prompt: string, body: unknown): string {
  if (!prompt.includes(HOOK_PLACEHOLDER)) return prompt;
  let text: string;
  try {
    text = JSON.stringify(body, null, 2) ?? "";
  } catch {
    text = "";
  }
  const bounded = text.length > MAX_HOOK_IN_PROMPT ? `${text.slice(0, MAX_HOOK_IN_PROMPT)}\n… (the delivery was longer; only its start is here)` : text;
  return prompt.split(HOOK_PLACEHOLDER).join(bounded);
}

/**
 * The receiver's memory: deliveries per routine for the last hour, and the ones already
 * seen. In this process only — a restart forgets them, which at worst runs a delivery a
 * second time (a routine run is idempotent in what it reads, not in what it does).
 */
export class HookGate {
  private readonly hits = new Map<string, number[]>();
  private readonly seen = new Map<string, Map<string, number>>();

  /** Whether this routine may receive a delivery now; records the one it allows. */
  allow(routineId: string, now = Date.now()): boolean {
    const recent = (this.hits.get(routineId) ?? []).filter((at) => now - at < 3_600_000);
    if (recent.length >= MAX_HOOKS_PER_HOUR) {
      this.hits.set(routineId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(routineId, recent);
    return true;
  }

  /** Whether this delivery was already taken: records it when it was not. */
  first(routineId: string, key: string | null, now = Date.now()): boolean {
    if (key === null) return true;
    const keys = this.seen.get(routineId) ?? new Map<string, number>();
    for (const [held, at] of keys) if (now - at > SEEN_TTL_MS) keys.delete(held);
    if (keys.has(key)) {
      this.seen.set(routineId, keys);
      return false;
    }
    keys.set(key, now);
    while (keys.size > MAX_SEEN) {
      const oldest = keys.keys().next().value;
      if (oldest === undefined) break;
      keys.delete(oldest);
    }
    this.seen.set(routineId, keys);
    return true;
  }
}
