// Pure turn accounting: every cap the plan puts on one user turn, the
// deterministic duplicate-consultation rule, the wall clock, and usage deltas.
// No I/O and no clock of its own — the caller passes `now`, so each decision is
// unit-testable without a fake timer.
import type { BoardUsage, SessionUsage } from "../../shared/protocol.js";
import type { RoomBudgets } from "./types.js";

/** One turn's counters. The runner creates it when a turn starts and asks before every invocation. */
export interface TurnBudget {
  readonly limits: RoomBudgets;
  readonly startedAt: number;
  invocations: number;
  consultRequests: number;
  readonly perMember: Map<string, number>;
  /** Normalized `from\0to\0question` keys already asked this turn. */
  readonly seen: Set<string>;
  expired: boolean;
}

export type BudgetDecision = { ok: true } | { ok: false; reason: string };

export function createTurnBudget(limits: RoomBudgets, startedAt: number): TurnBudget {
  return { limits, startedAt, invocations: 0, consultRequests: 0, perMember: new Map(), seen: new Set(), expired: false };
}

/** Whether one more invocation for this member fits the turn's total and per-member caps. */
export function invocationAllowed(budget: TurnBudget, memberId: string, now: number): BudgetDecision {
  if (budget.expired || now - budget.startedAt >= budget.limits.turnWallClockMs) return { ok: false, reason: `The turn's ${Math.round(budget.limits.turnWallClockMs / 1000)}s wall clock ran out` };
  if (budget.invocations >= budget.limits.maxInvocations) return { ok: false, reason: `The turn used its ${budget.limits.maxInvocations} invocations` };
  const used = budget.perMember.get(memberId) ?? 0;
  if (used >= budget.limits.maxInvocationsPerMember) return { ok: false, reason: `This bot already ran ${budget.limits.maxInvocationsPerMember} times this turn` };
  return { ok: true };
}

export function noteInvocation(budget: TurnBudget, memberId: string): void {
  budget.invocations += 1;
  budget.perMember.set(memberId, (budget.perMember.get(memberId) ?? 0) + 1);
}

/** Consultation requests this turn may still start (0 when the wall clock is gone). */
export function remainingConsultRequests(budget: TurnBudget, now: number): number {
  if (budget.expired || now - budget.startedAt >= budget.limits.turnWallClockMs) return 0;
  return Math.max(0, budget.limits.maxConsultRequests - budget.consultRequests);
}

export function noteConsultRequests(budget: TurnBudget, count: number): void {
  budget.consultRequests += count;
}

/** Deterministic loop detection: whitespace and case are noise; wording changes are caught by the invocation caps. */
export function duplicateKey(fromMemberId: string, toMemberId: string, question: string): string {
  return `${fromMemberId}\u0000${toMemberId}\u0000${question.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

export function markExpired(budget: TurnBudget): void {
  budget.expired = true;
}

export function wallClockExpired(budget: TurnBudget, now: number): boolean {
  return budget.expired || now - budget.startedAt >= budget.limits.turnWallClockMs;
}

export function emptyUsage(): BoardUsage {
  return { turns: 0, steps: 0, input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: null, unpriced: 0 };
}

/**
 * One invocation's share of a session's usage. Null cost on either side stays
 * null (never 0) and counts as unpriced: a harness that cannot price a model
 * must not make the room's total look cheaper than it was.
 */
export function usageDelta(before: SessionUsage | null, after: SessionUsage | null): BoardUsage {
  const from = (key: "turns" | "steps" | "input" | "cachedInput" | "cacheWrite" | "output"): number => {
    const a = after?.[key] ?? 0;
    const b = before?.[key] ?? 0;
    return Math.max(0, a - b);
  };
  let cost: number | null = null;
  if (after !== null && after.cost !== null) {
    cost = before?.cost !== null && before !== null ? Math.max(0, after.cost - before.cost) : after.cost;
  }
  return {
    turns: from("turns"),
    steps: from("steps"),
    input: from("input"),
    cachedInput: from("cachedInput"),
    cacheWrite: from("cacheWrite"),
    output: from("output"),
    cost,
    unpriced: cost === null ? 1 : 0,
  };
}

export function addUsage(a: BoardUsage, b: BoardUsage): BoardUsage {
  const cost = a.cost === null || b.cost === null ? null : a.cost + b.cost;
  return {
    turns: a.turns + b.turns,
    steps: a.steps + b.steps,
    input: a.input + b.input,
    cachedInput: a.cachedInput + b.cachedInput,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    output: a.output + b.output,
    cost,
    unpriced: a.unpriced + b.unpriced,
  };
}
