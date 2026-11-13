// Pure selectors for the right panel: the harness snapshot and current records decide what exists.
import type { ChatSnapshot, DelegatedTaskView, GitStatus, InteractionKind, RaceSummary, ReviewThread, SecondOpinion } from "../shared/protocol.js";

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

/** The project line the panel's summary card draws: the branch, the files it would show in review, and any operation under way. */
export interface GitSummary {
  branch: string;
  files: number;
  operation: GitStatus["operation"];
  /** Lines against HEAD, as the diff badges draw them. */
  added: number;
  removed: number;
}

export function gitSummary(status: GitStatus | null): GitSummary | null {
  if (!status) return null;
  return {
    branch: status.branch ?? `detached at ${status.head ?? "?"}`,
    files: status.files.length + status.more,
    operation: status.operation,
    added: status.added,
    removed: status.removed,
  };
}

/** A token count as the panel writes it: 840 stays "840", 8 400 becomes "8.4k", never a raw six-digit figure. */
export function tokenCount(value: number | null): string {
  if (value === null) return "unknown";
  if (value < 1000) return String(value);
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (value < 1_000_000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** The words a rail card's heading uses, so both terminal clients and the browser name a group the same way. */
export const CONTEXT_LABELS: Record<ContextSectionId, string> = {
  agents: "Agents and lineage",
  tasks: "Delegated work",
  jobs: "Background jobs",
  questions: "Questions and permissions",
  races: "Comparisons and races",
  opinions: "Second opinions",
  review: "Review comments",
  memory: "Context and usage",
};

/** How a pending request reads under its title: an approval asks for a yes, the rest ask for words. */
const REQUEST_NOUN: Record<InteractionKind, string> = { confirm: "Approval", select: "Choice", input: "Question", editor: "Editor" };

/**
 * Where a rail row goes when it is opened. The clients draw their own screens, so the row
 * names the thing (a chat, a call, a comment) and each client maps it to the screen it has.
 */
export type ContextTarget =
  | { kind: "chat"; chatId: string }
  | { kind: "tool"; toolId: string }
  | { kind: "review"; threadId: string }
  | { kind: "race"; raceId: string }
  | { kind: "usage" }
  | { kind: "questions" };

/** One row of a rail card: a title, the small print under it, its status word, and its target. */
export interface ContextCardRow {
  key: string;
  title: string;
  meta: string;
  status: StatusReadout;
  target: ContextTarget;
  /** A third line for a caveat that would otherwise be a paragraph (rare on purpose). */
  note?: string;
  /** The delegated task this row is about, when the client can open its review from here. */
  taskId?: string;
}

/** One card of the rail: a group of rows with the count its heading carries. */
export interface ContextCard {
  id: ContextSectionId;
  label: string;
  count: number;
  /** A dot beside the heading when something inside wants attention. */
  attention: "accent" | "warn" | false;
  rows: ContextCardRow[];
}

export interface ContextCardsInput {
  chat: Pick<ChatSnapshot, "items" | "pending" | "delegated" | "lineage" | "workspace" | "context">;
  /** The project's comparisons as `/api/races` answered, or null before the read comes back. */
  races: RaceSummary[] | null;
  opinions: SecondOpinion[] | null;
  threads: ReviewThread[] | null;
}

/** Rows a card draws before it leaves the rest to its own screen (the transcript's tool call, the review). */
const CARD_ROWS = 8;

/**
 * The rail as groups of rows, for a client that draws cards instead of the browser's sections:
 * the same snapshot, records, and words as ContextPanel.tsx, and nothing of its own. A group
 * with nothing in it is left out; only the context card always stands, as it does in the browser.
 */
export function contextCards(input: ContextCardsInput): ContextCard[] {
  const chat = input.chat;
  const cards: ContextCard[] = [];
  const runs = runEntries(chat.items);
  const jobs = jobEntries(chat.items);
  const tasks = chat.delegated ?? [];
  const inWorkspace = (input.races ?? []).filter((race) => race.workspaceId === chat.workspace.id);

  const agents: ContextCardRow[] = [];
  if (chat.lineage) {
    agents.push({
      key: `lineage:${chat.lineage.taskId}`,
      title: `Delegated from ${chat.lineage.parentTitle ?? "another chat"}`,
      meta: `Depth ${chat.lineage.depth}`,
      status: { tone: "quiet", word: "Parent" },
      target: { kind: "chat", chatId: chat.lineage.parentChatId },
    });
  }
  for (const run of runs.slice(-CARD_ROWS)) {
    agents.push({
      key: `run:${run.key}`,
      title: run.label || run.agent,
      meta: `Agent · ${run.agent}${run.activity ? ` · ${run.activity}` : ""}`,
      status: runReadout(run.status),
      target: { kind: "tool", toolId: run.toolId },
    });
  }
  if (agents.length > 0) cards.push({ id: "agents", label: CONTEXT_LABELS.agents, count: agents.length, attention: runs.some((run) => run.status === "failed") ? "accent" : false, rows: agents });

  if (tasks.length > 0) {
    cards.push({
      id: "tasks",
      label: CONTEXT_LABELS.tasks,
      count: tasks.length,
      attention: taskAttention(tasks) > 0 ? "accent" : false,
      // A worker with a review waiting is a row that opens that review; a running one can be cancelled there.
      rows: tasks.map((task) => ({
        key: `task:${task.id}`,
        title: task.title || task.id,
        meta: `Agent · ${task.harnessId ?? "delegated"}`,
        status: taskReadout(task),
        target: task.childChatId ? { kind: "chat", chatId: task.childChatId } : { kind: "tool", toolId: task.id },
        ...(task.reviewable && task.state === "result_available" ? { note: "Finished in its own checkout: its review applies or keeps the patch." } : {}),
        taskId: task.id,
      })),
    });
  }

  if (jobs.length > 0) {
    cards.push({
      id: "jobs",
      label: CONTEXT_LABELS.jobs,
      count: jobs.length,
      attention: jobs.some((job) => job.status === "failed") ? "accent" : false,
      rows: jobs.slice(-CARD_ROWS).map((job) => ({
        key: `job:${job.key}`,
        title: job.label,
        meta: job.kind === "shell" ? "Shell job" : "Task job",
        status: jobReadout(job.status),
        target: { kind: "tool", toolId: job.toolId },
      })),
    });
  }

  if (chat.pending.length > 0) {
    cards.push({
      id: "questions",
      label: CONTEXT_LABELS.questions,
      count: chat.pending.length,
      attention: "accent",
      rows: chat.pending.map((request) => ({
        key: `request:${request.id}`,
        title: request.title,
        meta: REQUEST_NOUN[request.kind],
        status: { tone: "waiting", word: "Needs you" },
        target: { kind: "questions" },
      })),
    });
  }

  if (inWorkspace.length > 0) {
    cards.push({
      id: "races",
      label: CONTEXT_LABELS.races,
      count: inWorkspace.length,
      attention: false,
      rows: inWorkspace.slice(0, CARD_ROWS).map((race) => ({
        key: `race:${race.id}`,
        title: race.prompt || "Comparison",
        meta: `${race.members.length} ${race.members.length === 1 ? "chat" : "chats"}`,
        status: race.winnerChatId
          ? { tone: "done", word: "Chosen" }
          : race.members.some((member) => member.status === "running")
            ? { tone: "working", word: "Working" }
            : { tone: "waiting", word: "Awaiting review" },
        target: { kind: "race", raceId: race.id },
      })),
    });
  }

  const opinions = input.opinions ?? [];
  if (opinions.length > 0) {
    cards.push({
      id: "opinions",
      label: CONTEXT_LABELS.opinions,
      count: opinions.length,
      attention: false,
      rows: opinions.map((opinion) => ({
        key: `opinion:${opinion.id}`,
        title: opinion.ask || `Second opinion from turn ${opinion.turn}`,
        meta: `Asked ${opinion.to}`,
        status: { tone: opinion.report ? "done" : "working", word: opinion.report ? "Replied" : "Working" },
        // The opinion runs in an ordinary chat of this project: that chat holds the reply.
        target: { kind: "chat", chatId: opinion.chatId },
      })),
    });
  }

  const threads = input.threads ?? [];
  if (threads.length > 0) {
    cards.push({
      id: "review",
      label: CONTEXT_LABELS.review,
      count: threads.length,
      attention: false,
      rows: threads.slice(0, 12).map((thread) => ({
        key: `thread:${thread.id}`,
        title: `${thread.anchor.path}:${thread.anchor.line ?? "?"}`,
        meta: thread.notes[0]?.text ?? "Comment thread",
        status: { tone: thread.status === "open" ? "waiting" : "quiet", word: thread.status === "open" ? "Open" : "Resolved" },
        target: { kind: "review", threadId: thread.id },
      })),
    });
  }

  const context = chat.context ?? null;
  cards.push({
    id: "memory",
    label: CONTEXT_LABELS.memory,
    count: 0,
    attention: context?.percent != null && context.percent >= 80 ? "warn" : false,
    rows: [
      {
        key: "usage",
        title: "Context used",
        meta: context ? `${tokenCount(context.tokens)} of ${tokenCount(context.window)} tokens` : "This harness has not reported a context window",
        status: { tone: "quiet", word: context?.percent == null ? "—" : `${Math.round(context.percent)}%` },
        target: { kind: "usage" },
      },
    ],
  });
  return cards;
}

/** How a project line reads: the branch, any operation under way, and the files it would show. */
export function gitSummaryLine(status: GitStatus | null): string | null {
  const summary = gitSummary(status);
  if (!summary) return null;
  const files = summary.files === 0 ? "clean" : `${summary.files} ${summary.files === 1 ? "file" : "files"} +${summary.added} −${summary.removed}`;
  const operation = summary.operation ? ` · ${summary.operation} in progress` : "";
  return `${summary.branch}${operation} · ${files}`;
}
