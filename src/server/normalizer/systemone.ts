// The one System One request builder and the one reply reader every decision backend shares.
//
// All four backends (a local Clef-flash the operator runs, Cloudflare Workers AI's Clef-flash,
// TypeSafe's Jev, and Command Code's Provider API in front of Jev) speak the same shape: `POST`
// `{ model, state, questions }`, `Authorization: Bearer <key>`, and a reply of `answers` plus
// `usage`. Only the URL, the model id and the key differ, so the difference lives in one table in
// service.ts and everything that could drift between vendors lives here, once.
//
// Two header rules are load-bearing, and both were learned the hard way:
//   - Every request says `User-Agent: awui-normalizer/1`. Command Code's Cloudflare edge refuses a
//     browser-like client with Error 1010 (`browser_signature_banned`) before any model is called;
//     a plain one gets through. The read maps that refusal to a sentence that says so.
//   - No request ever sets `x-cmd-zdr`. Jev has no zero-data-retention upstream, and commanding it
//     is refused with 422. That is why the settings copy says "remote" without promising deletion.
//
// The module is pure: it builds a request object and reads one back. The caller fetches, so a test
// never stubs a network here and the egress invariant (only service.ts calls fetch) stays visible.
import type { NormalizerBackend } from "../../shared/protocol.js";

/** One Noul: a single probability that a statement holds, with no confidence field of its own. */
export interface NoulQuestion {
  type: "noul";
  instructions: string;
  criteria: { true: string; false: string };
}

/** One Choice: a closed set of answers, answered with a probability for each one. */
export interface ChoiceQuestion {
  type: "choice";
  instructions: string;
  criteria: Record<string, string>;
}

export type SystemOneQuestion = NoulQuestion | ChoiceQuestion;

/** `state` may be a JSON object or a string; awui always sends an object. */
export interface SystemOneRequest {
  model: string;
  state: Record<string, unknown>;
  questions: Record<string, SystemOneQuestion>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export interface ChoiceAnswer {
  type: "choice";
  choice: string;
  /** Documented for a Choice, absent on a Noul. Recorded, never the gate (see service.ts). */
  confidence?: number;
  probabilities: Record<string, number>;
}

export type SystemOneAnswer = NoulAnswer | ChoiceAnswer;

export interface SystemOneReply {
  model: string;
  answers: Record<string, SystemOneAnswer>;
  usage: { input_tokens: number; output_tokens: number };
}

/** The name every request carries (see the header). Command Code requires a non-browser one. */
export const SYSTEM_ONE_USER_AGENT = "awui-normalizer/1";

/** Where one backend's request goes, as which model, with which key, and for how long. */
export interface BackendCall {
  backend: NormalizerBackend;
  url: string;
  model: string;
  /** null for a local endpoint that takes no key. Never stored on anything a route can read. */
  key: string | null;
  timeoutMs: number;
  /** Whether the state leaves this machine: the redaction path, and the settings copy, read it. */
  remote: boolean;
}

/** A request ready for `fetch`: the URL, the headers, and the body as the API takes it. */
export interface SystemOneCall {
  url: string;
  headers: Record<string, string>;
  body: SystemOneRequest;
}

export function buildSystemOneRequest(call: BackendCall, state: Record<string, unknown>, questions: Record<string, SystemOneQuestion>): SystemOneCall {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": SYSTEM_ONE_USER_AGENT,
  };
  // Deliberately no `x-cmd-zdr`: Jev has no ZDR-capable upstream and Command Code refuses the header.
  if (call.key) headers.authorization = `Bearer ${call.key}`;
  return { url: call.url, headers, body: { model: call.model, state, questions } };
}

const isObj = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** One answer, or null when it is malformed: a missing choice, no probability for it, a NaN noul. */
function answerOf(raw: unknown): SystemOneAnswer | null {
  if (!isObj(raw)) return null;
  if (raw.type === "noul") {
    const noul = finite(raw.noul);
    return noul === null ? null : { type: "noul", noul };
  }
  if (raw.type !== "choice" || typeof raw.choice !== "string" || raw.choice === "" || !isObj(raw.probabilities)) return null;
  const probabilities: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw.probabilities)) {
    const probability = finite(value);
    if (probability !== null) probabilities[key] = probability;
  }
  // The selected option must carry a probability of its own: without one there is nothing to gate on.
  if (probabilities[raw.choice] === undefined) return null;
  const confidence = finite(raw.confidence);
  return { type: "choice", choice: raw.choice, probabilities, ...(confidence === null ? {} : { confidence }) };
}

/**
 * A reply's own fields, or null when the body is not one. Workers AI's REST API documents a
 * `{ success, errors, messages, result }` envelope; a bare body is documented by the others. The
 * unwrap is defensive rather than claimed, so a backend that does not wrap needs nothing here.
 */
export function readSystemOneReply(json: unknown): SystemOneReply | null {
  if (!isObj(json)) return null;
  const inner = isObj(json.answers) ? json : isObj(json.result) ? json.result : json;
  if (!isObj(inner.answers) || Array.isArray(inner.answers)) return null;
  const answers: Record<string, SystemOneAnswer> = {};
  for (const [id, raw] of Object.entries(inner.answers)) {
    const answer = answerOf(raw);
    if (answer) answers[id] = answer;
  }
  const usage = isObj(inner.usage) ? inner.usage : {};
  return {
    model: typeof inner.model === "string" ? inner.model : "",
    answers,
    usage: { input_tokens: finite(usage.input_tokens) ?? 0, output_tokens: finite(usage.output_tokens) ?? 0 },
  };
}

/**
 * What `lastError` may say of a failed request: the status and one class of failure. Never the
 * body — a provider's error page can quote the request back, which is the tool output.
 */
export function replyErrorOf(status: number, body: string): string {
  if (/browser_signature|error 1010/i.test(body)) return "blocked by the provider's edge (User-Agent); this is a client-header issue, not a key issue";
  if (status === 401 || status === 403) return `HTTP ${status}: the provider refused the key`;
  if (status === 404) return "HTTP 404: no such model or endpoint at that URL";
  if (status === 422) return "HTTP 422: the provider refused the request's shape";
  if (status === 429) return "HTTP 429: the provider is rate limiting";
  if (status >= 500) return `HTTP ${status}: the provider failed`;
  return `HTTP ${status}`;
}
