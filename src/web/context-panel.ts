// Pure selectors for the right panel: the harness snapshot and current records decide what exists.
import type { ChatSnapshot, DelegatedTaskView, RaceSummary } from "../shared/protocol.js";

export type ContextSectionId = "agents" | "tasks" | "jobs" | "questions" | "races" | "opinions" | "review" | "memory";

const SECTION_IDS = ["agents", "tasks", "jobs", "questions", "races", "opinions", "review", "memory"] as const;
export function validatedFolds(raw: Partial<Record<ContextSectionId, boolean>>): Partial<Record<ContextSectionId, boolean>> {
  const out: Partial<Record<ContextSectionId, boolean>> = {};
  for (const id of SECTION_IDS) {
    if (typeof raw[id] === "boolean") out[id] = raw[id];
  }
  return out;
}
export type RunSummary = { key: string; toolId: string; id: string; label: string; agent: string; status: "pending" | "running" | "done" | "failed" | "stopped"; activity?: string | undefined };


export interface JobSummary { key: string; toolId: string; id: string; kind: "shell" | "task"; label: string; status: "running" | "done" | "failed" | "stopped"; detail?: string | undefined; }

export function runEntries(items: ChatSnapshot["items"]): RunSummary[] {
  const byKey = new Map<string, RunSummary>();
  // One job can be renamed on a later wait tool call. Keep the latest while preserving the first meaningful failure.
  for (const item of items) {
    if (item.kind !== "tool" || !item.subagents?.runs) continue;
    for (const run of item.subagents.runs) {
      const key = run.ref ?? run.id;
      const previous = byKey.get(key);
      if (previous && previous.status === run.status && previous.label === run.task) continue;
      byKey.set(key, { key, toolId: item.id, id: run.id, label: run.task, agent: run.agent, status: run.status, activity: run.activity?.[0], ...(run.error ? { failed: true } : {}) });
    }
  }
  return [...byKey.values()];
}

export function jobEntries(items: ChatSnapshot["items"]): JobSummary[] {
  const out = new Map<string, JobSummary>();
  for (const item of items) {
    if (item.kind !== "tool" || !item.jobs) continue;
    for (const job of item.jobs) {
      const key = `${item.id}/${job.id}`;
      if (out.has(key) && out.get(key)?.status === job.status) continue;
      out.set(key, { key, toolId: item.id, id: job.id, kind: job.kind, label: job.title || job.label, status: job.status, detail: job.output?.split("\n", 1)[0] });
    }
  }
  return [...out.values()];
}

export function taskAttention(tasks: DelegatedTaskView[]): number {
  return tasks.filter((task) => task.state !== "result_available").length;
}

export function raceCount(races: RaceSummary[] | null, workspaceId: string): number {
  return (races ?? []).filter((race) => race.workspaceId === workspaceId && !race.winnerChatId).length;
}

/** How a row's status reads: its tone picks the dot's colour, its word says the same thing in text. */
export type StatusTone = "working" | "waiting" | "done" | "failed" | "quiet";
export interface StatusReadout {
  tone: StatusTone;
  word: string;
}

export function runReadout(status: RunSummary["status"]): StatusReadout {
  switch (status) {
    case "pending":
      return { tone: "waiting", word: "Queued" };
    case "running":
      return { tone: "working", word: "Working" };
    case "done":
      return { tone: "done", word: "Done" };
    case "failed":
      return { tone: "failed", word: "Failed" };
    case "stopped":
      return { tone: "quiet", word: "Stopped" };
  }
}

export function jobReadout(status: JobSummary["status"]): StatusReadout {
  switch (status) {
    case "running":
      return { tone: "working", word: "Working" };
    case "done":
      return { tone: "done", word: "Done" };
    case "failed":
      return { tone: "failed", word: "Failed" };
    case "stopped":
      return { tone: "quiet", word: "Stopped" };
  }
}

/**
 * A delegated task's one status word. "Result available" is the protocol's state, not a
 * person's: the outcome says whether that result is a finished job or a failure.
 */
export function taskReadout(task: Pick<DelegatedTaskView, "state" | "outcome">): StatusReadout {
  switch (task.state) {
    case "working":
      return { tone: "working", word: "Working" };
    case "waiting_for_user":
      return { tone: "waiting", word: "Waiting for you" };
    case "waiting_for_children":
      return { tone: "waiting", word: "Waiting" };
    case "result_available":
      switch (task.outcome) {
        case "failed":
          return { tone: "failed", word: "Failed" };
        case "cancelled":
          return { tone: "quiet", word: "Cancelled" };
        case "interrupted":
          return { tone: "quiet", word: "Interrupted" };
        default:
          return { tone: "done", word: "Done" };
      }
  }
}

/** A token count as the panel writes it: 840 stays "840", 8 400 becomes "8.4k", never a raw six-digit figure. */
export function tokenCount(value: number | null): string {
  if (value === null) return "unknown";
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}
