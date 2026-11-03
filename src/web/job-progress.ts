// The chat's live job strip (the status stack above the composer): how many
// delegated runs a turn's tools are driving, and which of them are queued,
// running, done, failed, or stopped. omp's TUI draws the same strip in place
// ("done 19/27 · passed 19 · failed 0"); here it is a chip of counts, read
// from the tool items' subagent snapshots (`SubagentRun[]`), so it costs no
// extra events.
import type { ChatItem, SubagentRun } from "../shared/protocol.js";

/** One job strip's worth of counts, or null when nothing is delegating. */
export interface JobProgress {
  /** Every run across every live-or-settled delegation call of the chat. */
  total: number;
  running: number;
  queued: number;
  done: number;
  failed: number;
  stopped: number;
  /** The still-unfinished runs, for "2 of 5" wording. */
  active: number;
  /** Backgrounded runs keep going while the chat is idle; the row reads as such. */
  mode: "inline" | "background";
}

/**
 * Totals over the chat's current items. Only a run still doing something
 * counts: a completed call's rows stay readable inside its own card, so the
 * strip exists while at least one run is pending or running and vanishes when
 * the last settles.
 *
 * A run's own status is not enough to call it alive: nothing settles the runs
 * of a call that was stopped or never got its result, and a background run
 * whose report never came stays "running" for good. So an inline run counts
 * only while the chat is busy and its call is still open, and a background
 * run only within the latest turn: the strip never outlives the work it shows.
 */
export function jobProgress(items: ChatItem[], busy: boolean): JobProgress | null {
  let total = 0;
  const counts: Record<SubagentRun["status"], number> = { pending: 0, running: 0, done: 0, failed: 0, stopped: 0 };
  let mode: JobProgress["mode"] = "inline";
  let latestTurn = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]?.kind === "user") {
      latestTurn = i;
      break;
    }
  }
  for (const [index, item] of items.entries()) {
    if (item.kind !== "tool" || !item.subagents) continue;
    if (item.subagents.background ? index < latestTurn : !busy || item.status !== "running") continue;
    const runs = item.subagents.runs;
    // Only calls still doing something: a settled call's rows are its own
    // card's history (failed or finished runs), not the strip's tally.
    if (!runs.some((r) => r.status === "pending" || r.status === "running")) continue;
    // A background call's tool item settles while its runs go on (their
    // results arrive as report items); key the strip off the runs, not the call.
    if (item.subagents.background) mode = "background";
    for (const run of runs) {
      total += 1;
      counts[run.status] += 1;
    }
  }
  const active = counts.pending + counts.running;
  if (total === 0 || active === 0) return null;
  return { total, running: counts.running, queued: counts.pending, done: counts.done, failed: counts.failed, stopped: counts.stopped, active, mode };
}

/** The strip's one line: "3 running jobs" with the rest as "1 queued · 1 failed" meta (omp words it done/total; we lead with what's moving). */
export function jobLine(p: JobProgress): { label: string; meta: string } {
  const label = p.running > 0 ? `${p.running} running ${p.mode === "background" ? "jobs" : "agents"}` : `${p.queued} queued ${p.mode === "background" ? "jobs" : "agents"}`;
  const states = [
    p.queued > 0 && p.running > 0 ? `${p.queued} queued` : "",
    p.done > 0 ? `${p.done}/${p.total} done` : "",
    p.failed > 0 ? `${p.failed} failed` : "",
    p.stopped > 0 ? `${p.stopped} stopped` : "",
  ].filter(Boolean);
  return { label, meta: states.join(" · ") };
}
