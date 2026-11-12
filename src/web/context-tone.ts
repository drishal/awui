// The context ring's colour: quiet until the window is 75 % full, the warning
// tone from there, and danger from 90 %. Pure, so a unit test pins the two lines
// and the ring (ContextRing.tsx) only maps the tone onto its CSS classes; the
// colours themselves are CSS tokens (--warn, --danger), never values here.
import type { ContextUsage } from "../shared/protocol.js";

/** The share of the window where the ring turns amber. */
export const CONTEXT_WARN_PERCENT = 75;
/** The share of the window where the ring turns red. */
export const CONTEXT_DANGER_PERCENT = 90;

export type ContextTone = "ok" | "warn" | "danger";

/** How full the context is, as the ring's tone. */
export function contextTone(percent: number): ContextTone {
  if (percent >= CONTEXT_DANGER_PERCENT) return "danger";
  if (percent >= CONTEXT_WARN_PERCENT) return "warn";
  return "ok";
}

/**
 * Whether the harness reported enough for the ring to be drawn: a percentage
 * is the one figure every harness that knows its window also knows. A zero (or
 * a fraction of a percent) stays hidden, since an empty ring reads like a
 * spinner.
 */
export function hasContextFigure(context: ContextUsage | null): context is ContextUsage & { percent: number } {
  return context !== null && context.percent !== null && context.percent >= 0.5;
}
