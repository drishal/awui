// Background jobs: commands and tasks an agent leaves running while it carries
// on, normalized from each harness's own shapes into BackgroundJob (protocol.ts).
//
//   - omp: a backgrounded `bash` result carries `details.async: {jobId, state}`;
//     its `wait` tool streams `details.jobs[]` (status, intent, and a job widget:
//     meters, stats, a spark of progress, written by omp); the job's end arrives
//     as an `async-result` message whose `details.jobs[]` say how it went.
//   - Claude Code: `Bash` with run_in_background answers with a task id
//     (`backgroundTaskId` in its structured result); the CLI later sends a
//     `task_notification` (and a `<task-notification>` prompt in its file);
//     `TaskStop` stops one.
//   - The bg_task extension (Pi): `bg_task` / `bg_status` results carry the task
//     (or the list of them) whole, and its `kendex-background-tasks:event`
//     message says when one exits.
//
// Pure, against recorded shapes. Everything is bounded: a job holds a short
// label, a tail of output, and a widget cut to a few blocks of a few items.
import type { BackgroundJob, JobBlock, JobTone, JobWidget } from "../../shared/protocol.js";
import { isObj, type Obj } from "./agent-events.js";

const LABEL_CHARS = 300;
const TITLE_CHARS = 200;
const OUTPUT_CHARS = 2000;
const WORD_CHARS = 120;
const MAX_JOBS = 20;
const MAX_BLOCKS = 6;
const MAX_ITEMS = 40;
const MAX_VALUES = 60;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const cut = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const oneLine = (text: string, max: number): string => cut(text.replace(/\s+/g, " ").trim(), max);
/** The end of what a job printed: the newest lines are the ones that say where it is. */
const tail = (text: string): string => (text.length > OUTPUT_CHARS ? `…${text.slice(-(OUTPUT_CHARS - 1))}` : text);

/** Each harness's words for a job's state, as ours; anything unknown is still running. */
function status(raw: unknown): BackgroundJob["status"] {
  const s = str(raw).toLowerCase();
  if (/^(completed|complete|done|success|succeeded|exited)$/.test(s)) return "done";
  if (/^(failed|error|errored|timeout|timed_out)$/.test(s)) return "failed";
  if (/^(cancelled|canceled|stopped|killed|aborted|interrupted)$/.test(s)) return "stopped";
  return "running";
}

const TONES = new Set<JobTone>(["success", "error", "warning", "info", "muted", "accent"]);
const tone = (v: unknown): { tone?: JobTone } => (TONES.has(v as JobTone) ? { tone: v as JobTone } : {});
const word = (v: unknown): string => oneLine(typeof v === "number" ? String(v) : str(v), WORD_CHARS);
const label = (v: unknown): { label?: string } => (word(v) ? { label: word(v) } : {});

/** One widget block in our shape, or null for a kind this does not draw. */
function block(raw: unknown): JobBlock | null {
  if (!isObj(raw)) return null;
  const items = (Array.isArray(raw.items) ? raw.items : []).filter(isObj).slice(0, MAX_ITEMS);
  switch (raw.kind) {
    case "meter": {
      const value = num(raw.value);
      if (value === undefined) return null;
      return { kind: "meter", ...label(raw.label), value: Math.max(0, Math.min(1, value)), ...(word(raw.text) ? { text: word(raw.text) } : {}), ...tone(raw.tone) };
    }
    case "stat":
      return items.length > 0 ? { kind: "stat", items: items.map((i) => ({ label: word(i.label), text: word(i.text ?? i.value), ...tone(i.tone) })) } : null;
    case "text":
      return word(raw.text) ? { kind: "text", text: word(raw.text) } : null;
    case "bars": {
      const bars = items.flatMap((i) => (num(i.value) === undefined ? [] : [{ label: word(i.label), value: num(i.value) as number, ...(word(i.text) ? { text: word(i.text) } : {}), ...tone(i.tone) }]));
      return bars.length > 0 ? { kind: "bars", ...label(raw.label), items: bars, ...(num(raw.max) !== undefined ? { max: num(raw.max) } : {}) } : null;
    }
    case "spark": {
      const values = (Array.isArray(raw.values) ? raw.values : []).flatMap((v) => (num(v) === undefined ? [] : [num(v) as number])).slice(-MAX_VALUES);
      if (values.length === 0) return null;
      return {
        kind: "spark",
        ...label(raw.label),
        values,
        ...(word(raw.last) ? { last: word(raw.last) } : {}),
        ...(num(raw.min) !== undefined ? { min: num(raw.min) } : {}),
        ...(num(raw.max) !== undefined ? { max: num(raw.max) } : {}),
      };
    }
    case "grid":
      return items.length > 0 ? { kind: "grid", ...label(raw.label), items: items.map((i) => ({ label: word(i.label), ...(word(i.text) ? { text: word(i.text) } : {}), ...tone(i.tone) })) } : null;
    default:
      return null;
  }
}

/** omp's job widget, bounded; null when it says nothing drawable. */
export function jobWidget(raw: unknown): JobWidget | null {
  if (!isObj(raw)) return null;
  const blocks = (Array.isArray(raw.blocks) ? raw.blocks : []).map(block).filter((b): b is JobBlock => b !== null).slice(0, MAX_BLOCKS);
  const headline = isObj(raw.headline) && word(raw.headline.text) ? { text: word(raw.headline.text), ...label(raw.headline.label) } : null;
  const title = word(raw.title);
  const stage = word(raw.stage);
  if (blocks.length === 0 && !headline && !title && !stage) return null;
  return { ...(title ? { title } : {}), ...(stage ? { stage } : {}), ...(headline ? { headline } : {}), blocks };
}

/** One of omp's job records (a `wait` result's or an `async-result`'s), ours. */
function ompJob(raw: Obj): BackgroundJob | null {
  const id = str(raw.id) || str(raw.jobId);
  if (!id) return null;
  const widget = jobWidget(raw.widget);
  const output = str(raw.resultText);
  const exit = num(raw.exitCode);
  return {
    id,
    kind: raw.type === "task" ? "task" : "shell",
    status: status(raw.status),
    label: oneLine(str(raw.label) || id, LABEL_CHARS),
    ...(str(raw.intent) ? { title: oneLine(str(raw.intent), TITLE_CHARS) } : {}),
    ...(num(raw.durationMs) !== undefined ? { durationMs: num(raw.durationMs) } : {}),
    ...(exit !== undefined ? { exitCode: exit } : {}),
    ...(output ? { output: tail(output) } : {}),
    ...(widget ? { widget } : {}),
  };
}

/** The bg_task extension's task record, ours. */
function bgTask(raw: Obj): BackgroundJob | null {
  const id = str(raw.id);
  if (!id) return null;
  const exit = num(raw.exitCode);
  const started = num(raw.startedAt);
  const s = status(raw.status);
  const updated = num(raw.updatedAt);
  return {
    id,
    kind: "shell",
    status: s,
    label: oneLine(str(raw.command) || id, LABEL_CHARS),
    ...(str(raw.title) ? { title: oneLine(str(raw.title), TITLE_CHARS) } : {}),
    ...(started !== undefined ? { startedAt: started } : {}),
    ...(s !== "running" && updated !== undefined ? { endedAt: updated } : {}),
    ...(exit !== undefined && exit !== null ? { exitCode: exit } : {}),
  };
}

/** Claude Code's answer to a backgrounded Bash names the task: in its structured result, else in its words. */
const CLAUDE_BACKGROUND = /Command running in background with ID: ([A-Za-z0-9_-]+)/;

/**
 * The jobs a call started or looked at, from its name, arguments, and result
 * (its streamed partial result while it runs). Null when it touched none.
 */
export function jobsFromCall(name: string, args: unknown, details: unknown, output: string): BackgroundJob[] | null {
  const a = isObj(args) ? args : {};
  const d = isObj(details) ? details : {};
  // omp's backgrounded bash (and its `wait`, which lists the jobs it waits on).
  if (isObj(d.async) && str(d.async.jobId)) {
    const async = d.async;
    return [
      {
        id: str(async.jobId),
        kind: async.type === "task" ? "task" : "shell",
        status: status(async.state),
        label: oneLine(str(a.command) || str(async.jobId), LABEL_CHARS),
        ...(str(a.i) || str(a.intent) ? { title: oneLine(str(a.i) || str(a.intent), TITLE_CHARS) } : {}),
      },
    ];
  }
  if (Array.isArray(d.jobs) && /^(wait|await|job|jobs)$/i.test(name)) {
    const jobs = d.jobs.filter(isObj).map(ompJob).filter((j): j is BackgroundJob => j !== null);
    return jobs.length > 0 ? jobs.slice(0, MAX_JOBS) : null;
  }
  // The bg_task extension: one task, or the list.
  if (/^bg_(task|status)$/.test(name)) {
    const raw = isObj(d.task) ? [d.task] : Array.isArray(d.tasks) ? d.tasks : [];
    const jobs = raw.filter(isObj).map(bgTask).filter((j): j is BackgroundJob => j !== null);
    return jobs.length > 0 ? jobs.slice(0, MAX_JOBS) : null;
  }
  // Claude Code: a backgrounded Bash, and TaskStop.
  if (name === "Bash" && a.run_in_background === true) {
    const id = str(d.backgroundTaskId) || CLAUDE_BACKGROUND.exec(output)?.[1] || "";
    if (!id) return null;
    return [{ id, kind: "shell", status: "running", label: oneLine(str(a.command) || id, LABEL_CHARS), ...(str(a.description) ? { title: oneLine(str(a.description), TITLE_CHARS) } : {}) }];
  }
  if (name === "TaskStop" && str(a.task_id) && /^Successfully stopped/i.test(str(d.message) || output)) {
    return [{ id: str(a.task_id), kind: "shell", status: "stopped", label: oneLine(str(d.command) || str(a.task_id), LABEL_CHARS) }];
  }
  return null;
}

/**
 * A job reporting in, from a message the harness injects (omp's `async-result`,
 * the bg_task extension's event, the `background-task` record Claude's file
 * gives): which jobs, and how they stand. Empty for any other message.
 */
export function jobReports(customType: unknown, content: unknown, details: unknown): BackgroundJob[] {
  const d = isObj(details) ? details : {};
  if (customType === "async-result" && Array.isArray(d.jobs)) {
    // The output is the message itself: omp wraps the job's result in a notice.
    const text = typeof content === "string" ? content.replace(/^\s*<system-notice>\s*/, "").replace(/<\/system-notice>\s*$/, "") : "";
    const jobs = d.jobs.filter(isObj).map(ompJob).filter((j): j is BackgroundJob => j !== null);
    return jobs.length === 1 && text && !jobs[0]?.output ? [{ ...(jobs[0] as BackgroundJob), output: tail(text) }] : jobs;
  }
  if (customType === "kendex-background-tasks:event" && isObj(d.task)) {
    const job = bgTask(d.task);
    const out = str(d.outputTail);
    return job ? [{ ...job, ...(out ? { output: tail(out) } : {}) }] : [];
  }
  if (customType === "background-task" && Array.isArray(d.jobs)) {
    return d.jobs.filter(isObj).flatMap((j): BackgroundJob[] => (str(j.id) ? [{ id: str(j.id), kind: "shell", status: status(j.status), label: oneLine(str(j.label) || str(j.id), LABEL_CHARS), ...(str(j.title) ? { title: oneLine(str(j.title), TITLE_CHARS) } : {}) }] : []));
  }
  return [];
}

/** A Claude Code task's state (a `task_notification` or `task_updated` frame), as a report. */
export function claudeTaskReport(id: string, state: string, summary: string): BackgroundJob {
  return { id, kind: "shell", status: status(state), label: id, ...(summary.trim() ? { title: oneLine(summary, TITLE_CHARS) } : {}) };
}

/** Claude Code's `<task-notification>` (its file's record of a background task ending) as a report. */
export function claudeTaskNotice(text: string): BackgroundJob | null {
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim() ?? "";
  const id = tag("task-id");
  return id ? claudeTaskReport(id, tag("status"), tag("summary")) : null;
}

/**
 * A report folded into what a call holds: the report's fields win, but a
 * finished job never goes back to running (a late, stale snapshot), and a
 * widget or output it does not carry stays as last seen.
 */
export function mergeJob(prior: BackgroundJob, report: BackgroundJob): BackgroundJob {
  if (prior.status !== "running" && report.status === "running") return prior;
  const label = report.label === report.id && prior.label !== prior.id ? prior.label : report.label;
  return { ...prior, ...report, label };
}

/** Apply reports to a call's jobs; null when none of them is this call's. */
export function applyJobReports(jobs: BackgroundJob[], reports: BackgroundJob[], at: number | undefined): BackgroundJob[] | null {
  let changed = false;
  const next = jobs.map((job) => {
    const report = reports.find((r) => r.id === job.id);
    if (!report) return job;
    changed = true;
    const merged = mergeJob(job, report);
    // When the report ends it, that is when it ended (a harness that says no time of its own).
    return merged.status !== "running" && job.status === "running" && merged.endedAt === undefined && at !== undefined ? { ...merged, endedAt: at } : merged;
  });
  return changed ? next : null;
}
