// A chat's background jobs, folded from the calls that hold them (ToolItem.jobs:
// the call that started a job, the waits and lists that looked at it later, a
// report updating them all), and which of them the status stack shows. Pure:
// the composer and the conversation draw them.
import type { BackgroundJob, ChatItem } from "../shared/protocol.js";

export interface ChatJob extends BackgroundJob {
  /** The call that first held it: its start, for the time it began when the harness says none. */
  toolId: string;
  /** When that call ran (epoch ms). */
  seenAt?: number;
}

/** How long a finished job stays on show, so its end is seen before it goes. */
export const FINISHED_SHOWN_MS = 12_000;
/** A job still "running" this long after it began has lost its report (a restarted harness): it is not shown as live. */
export const STALE_AFTER_MS = 12 * 3600_000;

/** One snapshot folded into the last: newer fields win, but a finished job never goes back to running. */
function fold(prior: ChatJob, next: BackgroundJob): ChatJob {
  if (prior.status !== "running" && next.status === "running") return prior;
  const label = next.label === next.id && prior.label !== prior.id ? prior.label : next.label;
  return { ...prior, ...next, label, toolId: prior.toolId, ...(prior.seenAt !== undefined ? { seenAt: prior.seenAt } : {}) };
}

/** Every job the chat's calls hold, in the order they were first seen. */
export function chatJobs(items: readonly ChatItem[]): ChatJob[] {
  const byId = new Map<string, ChatJob>();
  for (const item of items) {
    if (item.kind !== "tool" || !item.jobs) continue;
    for (const job of item.jobs) {
      const prior = byId.get(job.id);
      byId.set(job.id, prior ? fold(prior, job) : { ...job, toolId: item.id, ...(item.at !== undefined ? { seenAt: item.at } : {}) });
    }
  }
  return [...byId.values()];
}

/** When it began: the harness's word, else the call that started it. */
export const jobStart = (job: ChatJob): number | undefined => job.startedAt ?? job.seenAt;

/** How long it ran (or has run, by `now`). */
export function jobElapsed(job: ChatJob, now: number): number | undefined {
  if (job.durationMs !== undefined) return job.durationMs;
  const start = jobStart(job);
  if (start === undefined) return undefined;
  const end = job.status === "running" ? now : (job.endedAt ?? now);
  return Math.max(0, end - start);
}

/**
 * The jobs to show above the composer: every one still running (unless it began
 * so long ago that its end must have been lost), and one that just finished,
 * for a moment, so its outcome is seen. Running ones first.
 */
export function shownJobs(jobs: readonly ChatJob[], now: number): ChatJob[] {
  const shown = jobs.filter((job) => {
    const start = jobStart(job);
    if (job.status === "running") return start === undefined || now - start < STALE_AFTER_MS;
    return job.endedAt !== undefined && now - job.endedAt < FINISHED_SHOWN_MS;
  });
  return [...shown.filter((j) => j.status === "running"), ...shown.filter((j) => j.status !== "running")];
}
