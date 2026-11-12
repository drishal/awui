// The decision gate's one record: a delegated worker's `request_decision` parks on it, the person
// answers it through the worker's own chat as a regular request item, and the recorded verdict —
// with a denial's corrective reason — is what the parked call returns and what a retry with the
// same decisionId finds. Pure: the bounds, the parse, the prune, and the store file, testable
// without a chat. The orchestrator owns the ledger and the parked callers; Chat owns the
// transcript item and never delivers a gate answer to the harness, which did not ask for it.
import { z } from "zod";
import { interactionAnswerSchema, MAX_DENIAL_REASON_CHARS, type InteractionAnswer, type InteractionRequest } from "../../shared/protocol.js";
import { isObj, readJson, writeJsonChecked } from "../state-file.js";

/** Records in the file, and how old a resolved row may get before it is pruned at load and at each write. */
export const MAX_DECISIONS = 200;
export const MAX_DECISION_AGE_MS = 7 * 24 * 60 * 60_000;
export const DECISION_SCHEMA_VERSION = 1;

/** Bounds for one decision, as the tool's schema and the store's parse both keep them. */
export const MAX_DECISION_ID_CHARS = 128;
export const MAX_DECISION_QUESTION_CHARS = 200;
export const MAX_DECISION_MESSAGE_CHARS = 2_000;
export const MAX_DECISION_OPTION_CHARS = 200;
export const MAX_DECISION_OPTIONS = 6;
export const MAX_DECISION_OUTCOME_CHARS = 200;

/** A server-originated request id carries this prefix: a harness never mints one, so the watcher
 * and a parent's thread_wait can tell a worker's decision question from a harness approval. */
export const GATE_REQUEST_PREFIX = "dc-";

export type DecisionState = "pending" | "answered";
export type DecisionKind = "confirm" | "select";

/** One decision while it stands, as the state folder keeps it: the caller-stable id, what was
 * asked, and the recorded answer once the person gave one. An unresolved row survives a restart
 * as it stands — never auto-answered, because only the person may answer it. */
export interface StoredDecision {
  /** Server-minted record id; the request on the worker's chat is `dc-<id>`. */
  id: string;
  /** The caller's own stable id: a retry with it finds this record instead of asking twice. */
  decisionId: string;
  taskId: string;
  parentChatId: string;
  childChatId: string | null;
  childSessionId: string | null;
  question: string;
  message: string | null;
  kind: DecisionKind;
  options: string[];
  state: DecisionState;
  answer: InteractionAnswer | null;
  /** The human wording of the answer ("Approved", "Denied", "Chose …"), as the transcript keeps it. */
  outcome: string | null;
  denialReason: string | null;
  createdAt: number;
  answeredAt: number | null;
}

/** What a tool call sees: the record without the chat and task ids the caller already knows. */
export interface DecisionView {
  id: string;
  decisionId: string;
  question: string;
  message: string | null;
  kind: DecisionKind;
  options: string[];
  state: DecisionState;
  answer: InteractionAnswer | null;
  outcome: string | null;
  denialReason: string | null;
  createdAt: number;
  answeredAt: number | null;
}

export function decisionViewOf(decision: StoredDecision): DecisionView {
  return {
    id: decision.id,
    decisionId: decision.decisionId,
    question: decision.question,
    message: decision.message,
    kind: decision.kind,
    options: decision.options,
    state: decision.state,
    answer: decision.answer,
    outcome: decision.outcome,
    denialReason: decision.denialReason,
    createdAt: decision.createdAt,
    answeredAt: decision.answeredAt,
  };
}

/** The request a pending decision puts on the worker's chat: a regular confirm or select, drawn
 * by the same approval card as any harness question, answered through the same route. */
export function gateRequestOf(decision: StoredDecision): InteractionRequest {
  return {
    id: `${GATE_REQUEST_PREFIX}${decision.id}`,
    kind: decision.kind === "select" ? "select" : "confirm",
    title: decision.question,
    ...(decision.message !== null ? { message: decision.message } : {}),
    ...(decision.kind === "select" && decision.options.length > 0 ? { options: decision.options } : {}),
    createdAt: decision.createdAt,
  };
}

const decisionShape = {
  id: z.string().min(1).max(64),
  decisionId: z.string().min(1).max(MAX_DECISION_ID_CHARS),
  taskId: z.string().min(4).max(16),
  parentChatId: z.string().min(1).max(128),
  childChatId: z.string().min(1).max(128).nullable(),
  childSessionId: z.string().max(512).nullable(),
  question: z.string().min(1).max(MAX_DECISION_QUESTION_CHARS),
  message: z.string().max(MAX_DECISION_MESSAGE_CHARS).nullable(),
  kind: z.enum(["confirm", "select"]),
  options: z.array(z.string().min(1).max(MAX_DECISION_OPTION_CHARS)).max(MAX_DECISION_OPTIONS),
  state: z.enum(["pending", "answered"]),
  answer: interactionAnswerSchema.nullable(),
  outcome: z.string().max(MAX_DECISION_OUTCOME_CHARS).nullable(),
  denialReason: z.string().max(MAX_DENIAL_REASON_CHARS).nullable(),
  createdAt: z.number(),
  answeredAt: z.number().nullable(),
};

export const storedDecisionSchema = z.object(decisionShape);

/** One row from the file, or null when it is malformed: the record is awui's own, so a bad row is dropped and counted. */
export function parseStoredDecision(value: unknown): StoredDecision | null {
  const parsed = storedDecisionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Resolved rows older than a week pruned, then the oldest resolved rows past the cap; a pending
 * row is never dropped, because an unresolved decision is the worker's blocked work. */
export function pruneDecisions(decisions: StoredDecision[], now: number): StoredDecision[] {
  const live = decisions.filter((decision) => decision.state === "pending" || (decision.answeredAt ?? decision.createdAt) >= now - MAX_DECISION_AGE_MS);
  live.sort((a, b) => b.createdAt - a.createdAt);
  while (live.length > MAX_DECISIONS) {
    let victim = -1;
    for (let i = live.length - 1; i >= 0; i--) {
      if (live[i]?.state === "answered") {
        victim = i;
        break;
      }
    }
    if (victim < 0) break;
    live.splice(victim, 1);
  }
  return live;
}

/** The decisions' one file in the state folder: read leniently, written whole through a checked
 * temp-and-rename (a write that fails rejects, so an unanswered decision never reports an answer). */
export class DecisionStore {
  constructor(private readonly file: string | null) {}

  /** Every well-formed record, pruned; `dropped` counts rows that could not be read. */
  async read(): Promise<{ decisions: StoredDecision[]; dropped: number }> {
    const raw = await readJson(this.file);
    const rows = isObj(raw) && Array.isArray(raw.decisions) ? raw.decisions : [];
    const decisions: StoredDecision[] = [];
    let dropped = 0;
    for (const row of rows) {
      const decision = parseStoredDecision(row);
      if (decision) decisions.push(decision);
      else dropped += 1;
    }
    return { decisions: pruneDecisions(decisions, Date.now()), dropped };
  }

  /** Write the lot, pruned first; a failure rejects. */
  async write(decisions: StoredDecision[]): Promise<void> {
    await writeJsonChecked(this.file, { schemaVersion: DECISION_SCHEMA_VERSION, decisions: pruneDecisions(decisions, Date.now()) });
  }
}
