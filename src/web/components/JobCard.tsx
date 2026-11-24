// One background job: what it is for, its command, its id and kind, a clock
// while it runs (its time once it ends), and its progress. omp hands a widget of
// its own (meters, stats, a spark of a count over time, a grid of passes and
// failures, a headline number), drawn here in the theme; a job without one shows
// a test run's progress read from its output, when it has printed one.
//
// Full above the composer, which is the one place live progress belongs; flat in
// the thread, where every call that watched the job would otherwise repeat the
// same bar — and run its own clock — once per call.
import { Fragment, useMemo, type CSSProperties } from "react";
import type { JobBlock, JobTone } from "../../shared/protocol.js";
import { useNow } from "../hooks.js";
import { IconCheck, IconStop, IconX, Spinner } from "../icons.js";
import { jobElapsed, type ChatJob } from "../jobs.js";
import { testProgress } from "../../shared/output-facts.js";
import { formatDuration } from "../turns.js";
import { TestMeter } from "./TestMeter.js";
import { Dot } from "./Dot.js";

const toneClass = (tone: JobTone | undefined) => (tone ? ` tone-${tone}` : "");

type StatBlock = Extract<JobBlock, { kind: "stat" }>;

/** The share of a widget's grid that failed: a meter measuring the same tests takes it as the red cap at its end,
 *  the way the dots below it already colour it. */
function failedShare(blocks: JobBlock[]): number {
  for (const block of blocks) {
    if (block.kind !== "grid" || block.items.length === 0) continue;
    return block.items.filter((item) => item.tone === "error").length / block.items.length;
  }
  return 0;
}

function Meter({ block, failed }: { block: Extract<JobBlock, { kind: "meter" }>; failed: number }) {
  // A meter over a run with failures is not one amber bar to its end: the passed share is green, the failed
  // share its red cap, and the rest the track, so the bar cannot say "all done, and wrong" at once.
  return (
    <div className={`job-meter${failed > 0 ? " has-failed" : toneClass(block.tone)}`}>
      <div className="job-block-top">
        <span>{block.label}</span>
        <span className="job-block-value">{block.text ?? `${Math.round(block.value * 100)}%`}</span>
      </div>
      <div
        className="job-track"
        role="progressbar"
        aria-label={block.label ?? "Progress"}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(block.value * 100)}
        style={{ "--share": block.value, "--failed": failed } as CSSProperties}
      >
        <span className="job-track-fill" />
        {failed > 0 ? <span className="job-track-fail" data-testid="job-track-fail" /> : null}
      </div>
    </div>
  );
}

function Spark({ block }: { block: Extract<JobBlock, { kind: "spark" }> }) {
  const max = block.max ?? Math.max(...block.values, 1);
  const min = block.min ?? 0;
  return (
    <div className="job-spark">
      <div className="job-spark-bars" aria-hidden="true">
        {block.values.map((v, i) => (
          <span key={i} style={{ "--h": Math.max(0.06, (v - min) / Math.max(1e-9, max - min)) } as CSSProperties} />
        ))}
      </div>
      <div className="job-spark-side">
        {block.last ? <strong>{block.last}</strong> : null}
        {block.label ? <span>{block.label}</span> : null}
      </div>
    </div>
  );
}

function Block({ block, failed }: { block: JobBlock; failed: number }) {
  switch (block.kind) {
    case "meter":
      return <Meter block={block} failed={failed} />;
    case "stat":
      return (
        <div className="job-stats">
          {block.items.map((item, i) => (
            <span key={i} className={`job-stat${toneClass(item.tone)}`}>
              <strong>{item.text}</strong> {item.label}
            </span>
          ))}
        </div>
      );
    case "text":
      return <div className="job-note">{block.text}</div>;
    case "bars": {
      const max = block.max ?? Math.max(...block.items.map((i) => i.value), 1);
      return (
        <div className="job-bars">
          {block.label ? <div className="job-block-label">{block.label}</div> : null}
          {block.items.map((item, i) => (
            <div key={i} className={`job-bar${toneClass(item.tone)}`}>
              <span className="job-bar-label">{item.label}</span>
              <span className="job-track">
                <span className="job-track-fill" style={{ "--share": max > 0 ? item.value / max : 0 } as CSSProperties} />
              </span>
              <span className="job-block-value">{item.text ?? item.value}</span>
            </div>
          ))}
        </div>
      );
    }
    case "spark":
      return <Spark block={block} />;
    case "grid":
      // Past twenty a square a test stops being a shape and becomes a texture: the meter and the counts carry the run.
      if (block.items.length > 20) return null;
      return (
        <div className="job-grid">
          {block.label ? <div className="job-block-label">{block.label}</div> : null}
          <div className="job-grid-cells">
            {block.items.map((item, i) => (
              <span key={i} className={`job-cell${toneClass(item.tone)}`} title={`${item.label}${item.text ? ` ${item.text}` : ""}`} />
            ))}
          </div>
        </div>
      );
  }
}

const STATUS_WORD: Record<ChatJob["status"], string> = { running: "Running", done: "Done", failed: "Failed", stopped: "Stopped" };

export function JobCard({ job, variant = "full" }: { job: ChatJob; variant?: "full" | "flat" }) {
  const running = job.status === "running";
  const now = useNow(running);
  const elapsed = jobElapsed(job, now);
  const widget = job.widget;
  // Flat: the head alone. The progress it would repeat is above the composer, and a
  // thread can hold a dozen calls that looked at the same job.
  const flat = variant === "flat";
  // A job without a widget of its own may still be a test run that printed its progress.
  const progress = useMemo(() => (!flat && !widget?.blocks.length && job.output ? testProgress(job.output) : null), [flat, widget, job.output]);
  const title = job.title ?? widget?.title ?? null;
  const stage = widget?.stage && widget.stage !== title ? widget.stage : null;
  const blocks = widget?.blocks ?? [];
  // The harness can state its tally as counts beside a grid of the same tests ("11 passed", "1 failed" over twelve
  // squares): then the head says it once and the pills under it and the stage sentence would say it twice more.
  const counts = blocks.find((block): block is StatBlock => block.kind === "stat");
  const counted = counts !== undefined && blocks.some((block) => block.kind === "grid");
  const failed = failedShare(blocks);
  return (
    <div className={`job-card is-${job.status}${flat ? " is-flat" : ""}`} data-testid="job-card" data-job={job.id}>
      <div className="job-head">
        <span className="job-mark" role="img" aria-label={STATUS_WORD[job.status]}>
          {running ? <Spinner size={13} /> : job.status === "done" ? <IconCheck size={13} draw /> : job.status === "stopped" ? <IconStop size={12} /> : <IconX size={13} />}
        </span>
        <span className="job-title">{title ?? job.label}</span>
        {counted ? (
          <span className="job-tally" data-testid="job-tally">
            {counts.items.map((item, i) => (
              <Fragment key={i}>
                {i > 0 ? <Dot /> : null}
                <span className={`job-tally-part${toneClass(item.tone)}`}>
                  <strong>{item.text}</strong> {item.label}
                </span>
              </Fragment>
            ))}
          </span>
        ) : widget?.headline ? (
          <span className="job-headline">
            <strong>{widget.headline.text}</strong> {widget.headline.label}
          </span>
        ) : null}
        <code className="job-id">{job.id}</code>
        {elapsed !== undefined ? <span className="job-time">{formatDuration(elapsed)}</span> : null}
      </div>
      {title && !flat ? (
        <div className="job-command" title={job.label}>
          <span aria-hidden="true">{job.kind === "task" ? "task" : "$"}</span> {job.label}
        </div>
      ) : null}
      {flat ? null : widget && widget.blocks.length > 0 ? (
        <div className="job-widget">
          {widget.blocks.map((block, i) => (counted && block.kind === "stat" ? null : <Block key={i} block={block} failed={failed} />))}
        </div>
      ) : progress ? (
        <TestMeter progress={progress} live={running} />
      ) : null}
      {stage && !flat && !counted ? <div className="job-stage">{stage}</div> : null}
      {job.status === "failed" && job.exitCode !== undefined ? <div className="job-stage is-failed">exit {job.exitCode}</div> : null}
    </div>
  );
}
