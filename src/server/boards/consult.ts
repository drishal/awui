// The consultation protocol, parsed strictly and only from a direct
// responder's settled final answer. Anything that is not exactly one envelope
// with exactly the known fields is refused; there is no best-effort parse, and
// quoted content elsewhere is never consulted.
import { BOARD_CONTROL_MAX_BYTES, BOARD_MAX_QUESTION_CHARS } from "../../shared/protocol.js";
import { CONSULT_MARKER_BEGIN, CONSULT_MARKER_END, type ConsultAsk } from "./types.js";

export type ParsedControl =
  | { kind: "plain" }
  | { kind: "invalid"; reason: string }
  | { kind: "consult"; requests: Array<{ to: string; question: string }> };

/** Marks the section of a synthesis prompt that carries consultant answers, so quoted text is never mistaken for a request. */
export const CONSULT_RESULTS_MARKER = "BOARD_CONSULTATION_RESULTS";

function invalid(reason: string): ParsedControl {
  return { kind: "invalid", reason };
}

/**
 * Classify a settled answer. `plain` means "not a control-looking answer at
 * all"; `invalid` means it opened the envelope but is not a usable document.
 */
export function parseControlDocument(text: string): ParsedControl {
  const trimmed = text.trim();
  if (!trimmed.startsWith(CONSULT_MARKER_BEGIN)) return { kind: "plain" };
  if (Buffer.byteLength(trimmed, "utf8") > BOARD_CONTROL_MAX_BYTES) return invalid(`The control document is larger than ${BOARD_CONTROL_MAX_BYTES / 1024} KiB`);
  if (trimmed.split(CONSULT_MARKER_BEGIN).length !== 2) return invalid("The answer carries more than one control envelope");
  const body = trimmed.slice(trimmed.indexOf(CONSULT_MARKER_BEGIN) + CONSULT_MARKER_BEGIN.length);
  const endAt = body.indexOf(CONSULT_MARKER_END);
  if (endAt < 0) return invalid("The control envelope is not closed");
  if (body.indexOf(CONSULT_MARKER_END, endAt + CONSULT_MARKER_END.length) >= 0) return invalid("The answer carries more than one control envelope");
  const trailing = body.slice(endAt + CONSULT_MARKER_END.length).trim();
  if (trailing.length > 0) return invalid("The control envelope must be the whole answer; there is text after it");

  let value: unknown;
  try {
    value = JSON.parse(body.slice(0, endAt).trim());
  } catch {
    return invalid("The control document's JSON is malformed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return invalid("The control document must be a JSON object");
  const keys = Object.keys(value);
  const unknownKey = keys.find((key) => key !== "version" && key !== "action" && key !== "requests");
  if (unknownKey) return invalid(`The control document has an unknown field: ${unknownKey}`);
  if (!("version" in value) || !("action" in value) || !("requests" in value)) return invalid("The control document needs version, action, and requests");
  const { version, action, requests } = value;
  if (version !== 1) return invalid("The control document's version must be 1");
  if (action !== "consult") return invalid("The control document's action must be \"consult\"");
  if (!Array.isArray(requests) || requests.length < 1 || requests.length > 3) return invalid("A control document asks one to three questions");
  const parsed: Array<{ to: string; question: string }> = [];
  for (const [i, raw] of requests.entries()) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return invalid(`Request ${i + 1} is not an object`);
    const requestKeys = Object.keys(raw);
    const bad = requestKeys.find((key) => key !== "to" && key !== "question");
    if (bad) return invalid(`Request ${i + 1} has an unknown field: ${bad}`);
    if (!("to" in raw) || !("question" in raw)) return invalid(`Request ${i + 1} needs a to and a question`);
    const { to, question } = raw;
    if (typeof to !== "string" || to.trim().length === 0 || to.length > 32) return invalid(`Request ${i + 1} has no valid target handle`);
    if (typeof question !== "string") return invalid(`Request ${i + 1} has no question`);
    const trimmedQuestion = question.trim();
    if (trimmedQuestion.length === 0) return invalid(`Request ${i + 1}'s question is empty`);
    if (trimmedQuestion.length > BOARD_MAX_QUESTION_CHARS) return invalid(`Request ${i + 1}'s question is longer than ${BOARD_MAX_QUESTION_CHARS} characters`);
    parsed.push({ to: to.trim(), question: trimmedQuestion });
  }
  return { kind: "consult", requests: parsed };
}

/** The handle a request names, normalized the way room handles are compared. */
export function normalizeHandle(handle: string): string {
  return handle.trim().toLowerCase();
}

export interface ConsultTarget {
  id: string;
  handle: string;
  enabled: boolean;
  consultable: boolean;
}

export interface ConsultAuthorization {
  accepted: Array<{ to: ConsultTarget; question: string }>;
  refused: Array<{ toHandle: string; question: string; reason: string }>;
}

/**
 * Resolve handles and enforce the room's allowlist and consultation budget.
 * The model never names membership ids; handles are matched case-insensitively
 * inside this room only.
 */
export function authorizeConsultRequests(input: {
  requests: ConsultAsk[];
  fromMemberId: string;
  members: ConsultTarget[];
  allowlist: string[];
  remaining: number;
  seen: Set<string>;
}): ConsultAuthorization {
  const byHandle = new Map(input.members.map((member) => [normalizeHandle(member.handle), member]));
  const allowed = new Set(input.allowlist);
  const accepted: ConsultAuthorization["accepted"] = [];
  const refused: ConsultAuthorization["refused"] = [];
  for (const request of input.requests) {
    const target = byHandle.get(normalizeHandle(request.to));
    if (!target) {
      refused.push({ toHandle: request.to, question: request.question, reason: `There is no member @${request.to} in this room` });
      continue;
    }
    if (target.id === input.fromMemberId) {
      refused.push({ toHandle: request.to, question: request.question, reason: "A bot cannot consult itself" });
      continue;
    }
    if (!target.enabled || !target.consultable) {
      refused.push({ toHandle: request.to, question: request.question, reason: `@${target.handle} is not open to consultations` });
      continue;
    }
    if (!allowed.has(target.id)) {
      refused.push({ toHandle: request.to, question: request.question, reason: `@${target.handle} is not on this bot's consultation allowlist` });
      continue;
    }
    if (accepted.length >= input.remaining) {
      refused.push({ toHandle: request.to, question: request.question, reason: "This turn has no consultation budget left" });
      continue;
    }
    accepted.push({ to: target, question: request.question });
  }
  return { accepted, refused };
}
