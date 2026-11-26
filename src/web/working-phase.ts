// What a running turn is doing, in a word or a sentence, for the fold's label:
// "Thinking", then the running call's own sentence ("Running npm test"), then
// "Writing" once the answer streams. Real states only, never a timer. Pure.
import { saysSomething, type Turn } from "./turns.js";
import { toolSentence } from "../shared/tool-row.js";

/** A phase change is held back until the last one has been up this long, so a burst of fast calls does not flicker. */
export const PHASE_HOLD_MS = 600;

/** Whether the turn is held by a question or an approval nobody has answered: a person, not the run, is the bottleneck. */
export function waitingOnYou(turn: Turn): boolean {
  return [...turn.process, ...(turn.answer ? [turn.answer] : []), ...turn.workAfter].some((item) => item.kind === "request" && item.outcome === undefined);
}

/** The turn's current phase; "Working" when nothing is known yet. */
export function workingPhase(turn: Turn, workspace: string): string {
  const items = [...turn.process, ...(turn.answer ? [turn.answer] : []), ...turn.workAfter];
  // A person is the bottleneck: while a request is unanswered the header says "Needs you" and the card says
  // "Waiting for approval", so the fold must not say the run is working over them.
  if (waitingOnYou(turn)) return "Waiting for you";
  // The newest call still running names the phase.
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind === "tool" && item.status === "running") return toolSentence(item, workspace).text;
  }
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    if (item?.kind !== "assistant" || !item.streaming) continue;
    if (saysSomething(item.text)) return "Writing";
    if (item.thinking.trim()) return "Thinking";
  }
  return "Working";
}

/** How long to wait before showing a new phase: nothing the first time (`lastChange` is 0), else what is left of the hold. */
export function phaseDelay(lastChange: number, now: number, holdMs = PHASE_HOLD_MS): number {
  return lastChange === 0 ? 0 : Math.max(0, lastChange + holdMs - now);
}
