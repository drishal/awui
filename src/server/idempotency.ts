// Idempotent mutating requests. A phone on a train can lose an answer after the
// server already acted on the request; without a key the retry starts a second
// chat or sends the same prompt twice. A client that cares sends an
// `Idempotency-Key` header; the first request runs and the shallow store below
// replays its answer instead of running it again. Per process and in memory on
// purpose: a restart forgets, which is why the window is short (ten minutes) and
// the store bounded (1000 answers of 64 KB at most). Nothing of an upload, a
// stream, or the orchestration surface goes through here.
import { createHash } from "node:crypto";
import type { NextFunction, Request, RequestHandler, Response } from "express";

/** The request header; IDEMPOTENCY_KEY_HEADER in protocol.ts is the same name for clients. */
export const IDEMPOTENCY_HEADER = "idempotency-key";
/** A key is the client's own word: long enough to be random, short enough to store. */
export const KEY_SHAPE = /^[A-Za-z0-9_.:-]{8,128}$/;
/** How long an answer may be replayed. */
export const DEFAULT_TTL_MS = 10 * 60 * 1000;
/** How many answers are remembered at once; the oldest leaves first. */
export const DEFAULT_MAX_ENTRIES = 1000;
/** An answer larger than this is not remembered (the request still ran, once). */
export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;
/** How long a repeat of a request that is still running waits for it before answering 409. */
export const DEFAULT_WAIT_MS = 30_000;
/** Only these have an effect to duplicate. */
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** An upload's body is the file itself, read raw by its route: not a JSON body to hash or replay. */
const UPLOAD_ROUTE = /^\/workspaces\/[^/]+\/upload$/;

/** What a repeat gets back: the first request's status, body, and content type. */
interface Answer {
  status: number;
  body: string;
  type: string;
}

interface Entry {
  /** "POST /api/chats": the key belongs to one route, and the same key on another is a mistake. */
  route: string;
  /** The body's digest, so the same key with another body is a mistake too. */
  hash: string;
  /** When the answer was stored, or when the request started while it still runs. */
  at: number;
  done: boolean;
  answer: Answer | null;
  /** Requests waiting for this one's answer instead of running their own. */
  wake: Array<() => void>;
}

export interface IdempotencyOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBodyBytes?: number;
  waitMs?: number;
  now?: () => number;
  /** Who the key belongs to: one device's key is never another's, so a session scopes it. */
  who?: (req: Request, res: Response) => string;
}

/**
 * The store and its middleware. Mount `handle` once, after `requireAuth` and after
 * the body parsers (the body it hashes is the parsed one).
 */
export class Idempotency {
  private readonly entries = new Map<string, Entry>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly maxBodyBytes: number;
  private readonly waitMs: number;
  private readonly now: () => number;
  private readonly who: (req: Request, res: Response) => string;

  constructor(options: IdempotencyOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
    this.waitMs = options.waitMs ?? DEFAULT_WAIT_MS;
    this.now = options.now ?? Date.now;
    this.who = options.who ?? (() => "local");
  }

  readonly handle: RequestHandler = (req, res, next) => {
    const key = req.get(IDEMPOTENCY_HEADER)?.trim() ?? "";
    if (key === "" || !MUTATING.has(req.method) || skipped(req)) return next();
    if (!KEY_SHAPE.test(key)) {
      res.status(400).json({ error: "An Idempotency-Key is 8 to 128 letters, digits, or _ . : -", code: "invalid_idempotency_key" });
      return;
    }
    const id = `${this.who(req, res)}\u0000${key}`;
    const route = `${req.method} ${req.baseUrl}${req.path}`;
    const hash = digest(req.body);
    this.sweep();
    const seen = this.entries.get(id);
    if (seen) {
      this.repeat(seen, id, route, hash, res, next);
      return;
    }
    const entry: Entry = { route, hash, at: this.now(), done: false, answer: null, wake: [] };
    this.makeRoom();
    this.entries.set(id, entry);
    this.capture(res, entry, next);
  };

  /** The same key again: its answer if there is one, a wait while it runs, or a refusal. */
  private repeat(seen: Entry, id: string, route: string, hash: string, res: Response, next: NextFunction): void {
    if (seen.route !== route || seen.hash !== hash) {
      res.status(422).json({ error: "That Idempotency-Key was used for a different request", code: "idempotency_key_reused" });
      return;
    }
    if (seen.answer) {
      replay(res, seen.answer);
      return;
    }
    if (seen.done) {
      // Its answer was not worth keeping (a 5xx, or one too big): the key is spent, so run it again.
      this.entries.delete(id);
      next();
      return;
    }
    // Still running: the answer to wait for is better than a second copy of the request.
    void this.wait(seen).then(
      (answer) => {
        if (answer) replay(res, answer);
        else next();
      },
      () => {
        res.status(409).json({ error: "That request is still running", code: "request_in_progress" });
      },
    );
  }

  private wait(entry: Entry): Promise<Answer | null> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      const wake = () => {
        if (timer) clearTimeout(timer);
        resolve(entry.answer);
      };
      // Bounded: a request that never answers must not hold this client forever.
      timer = setTimeout(() => {
        entry.wake = entry.wake.filter((other) => other !== wake);
        reject(new Error("still running"));
      }, this.waitMs);
      timer.unref?.();
      entry.wake.push(wake);
    });
  }

  /** Record what the route answers, so the same key gets that answer instead of a second run. */
  private capture(res: Response, entry: Entry, next: NextFunction): void {
    const end = res.end.bind(res) as Response["end"];
    let body = "";
    res.end = ((chunk?: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string") body = chunk;
      else if (chunk instanceof Uint8Array) body = Buffer.from(chunk).toString("utf8");
      const tooBig = Buffer.byteLength(body) > this.maxBodyBytes;
      this.finish(entry, tooBig ? null : { status: res.statusCode, body, type: String(res.getHeader("content-type") ?? "application/json") });
      return (end as (chunk?: unknown, ...rest: unknown[]) => Response)(chunk, ...rest);
    }) as Response["end"];
    next();
  }

  private finish(entry: Entry, answer: Answer | null): void {
    if (entry.done) return;
    entry.done = true;
    // A 5xx is a failure rather than an answer: a client may try again and must get a fresh attempt.
    entry.answer = answer && answer.status < 500 ? answer : null;
    entry.at = this.now();
    const wake = entry.wake;
    entry.wake = [];
    for (const resolve of wake) resolve();
  }

  /** Forget answers past their window (checked when a key arrives: nothing here runs on a timer). */
  private sweep(): void {
    const now = this.now();
    for (const [id, entry] of this.entries) if (entry.done && now - entry.at > this.ttlMs) this.entries.delete(id);
  }

  /** Room for one more: the oldest stored answer leaves first, and a running request is never dropped. */
  private makeRoom(): void {
    while (this.entries.size >= this.maxEntries) {
      let oldest: string | null = null;
      for (const [id, entry] of this.entries) {
        if (!entry.done) continue;
        oldest = id;
        break;
      }
      if (oldest === null) return;
      this.entries.delete(oldest);
    }
  }
}

/** Answers this middleware must not touch: a stream cannot be replayed, and an upload's body is the file itself. */
function skipped(req: Request): boolean {
  // The orchestration surface is its own token-authenticated channel with its own rules.
  if (req.path.startsWith("/orchestration/")) return true;
  if (UPLOAD_ROUTE.test(req.path)) return true;
  if ((req.get("accept") ?? "").includes("text/event-stream")) return true;
  const type = (req.get("content-type") ?? "").toLowerCase();
  return type !== "" && !type.startsWith("application/json");
}

/** A body's identity: the parsed JSON as written, so a replay must repeat it exactly. */
function digest(body: unknown): string {
  return createHash("sha256").update(body === undefined ? "" : JSON.stringify(body)).digest("base64url");
}

function replay(res: Response, answer: Answer): void {
  res.setHeader("Idempotent-Replay", "true");
  res.status(answer.status);
  if (answer.body === "") res.end();
  else res.type(answer.type).send(answer.body);
}
