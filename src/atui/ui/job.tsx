// A chat's background jobs in the terminal: one line each above the composer, so a
// run left going is seen while it goes and its outcome for a moment after, and the
// same job's own blocks under the call that holds it. The data is the browser's —
// web/jobs.ts folds every call's jobs into one list (a wait or a list that saw the job
// later updates the call that started it), and web/tool-facts.ts reads a test run's
// progress from a job whose harness hands over no widget of its own. Only the draw is
// the terminal's: a bar or a spark where the browser has a chart.
import { createMemo, Index, Show } from "solid-js";
import type { ChatItem } from "../../shared/protocol.js";
import { chatJobs, jobElapsed, shownJobs, type ChatJob } from "../../web/jobs.js";
import { testProgress } from "../../web/tool-facts.js";
import { clip } from "../format.js";
import { durationLabel } from "../neat.js";
import { LABEL_CHARS, jobBlockLines, jobLine, meter } from "../jobs.js";
import { useTheme } from "./context.js";
import { Spinner } from "./fx.js";
import { tick } from "./ticker.js";

/** The clock a running job reads by: the one ticker, and the wall clock it wakes (a settled job's time does not change). */
const clock = (running: boolean): number => {
  if (running) tick();
  return Date.now();
};

/** A job's state as a mark: the spinner while it runs, a tick when it is done, a cross or a square after. */
function JobMark(p: { job: ChatJob }) {
  const t = useTheme();
  const failed = () => p.job.status === "failed";
  return (
    <Show when={p.job.status === "running"} fallback={<span style={{ fg: failed() ? t().danger : p.job.status === "done" ? t().ok : t().warn }}>{failed() ? "✗ " : p.job.status === "done" ? "✓ " : "■ "}</span>}>
      <Spinner />
    </Show>
  );
}

/**
 * The chat's jobs above the composer: every one still running (and one that just
 * ended, for a moment, so its outcome is seen), one line each, as the browser's strip.
 */
export function JobsStrip(p: { items: readonly ChatItem[] }) {
  const t = useTheme();
  const jobs = createMemo(() => shownJobs(chatJobs(p.items), clock(true)));
  return (
    <Show when={jobs().length > 0}>
      <box flexDirection="column" paddingLeft={1}>
        <Index each={jobs()}>
          {(job) => (
            <text wrapMode="none" truncate>
              <JobMark job={job()} />
              <span style={{ fg: job().status === "failed" ? t().danger : t().text2 }}>{jobLine(job(), clock(job().status === "running"))}</span>
            </text>
          )}
        </Index>
      </box>
    </Show>
  );
}

/**
 * The jobs a call holds, under its row: what each is for, its clock, its own widget
 * blocks (or a test run's progress read from its output), and where it is now.
 */
export function JobBlocks(p: { jobs: readonly ChatJob[] }) {
  const t = useTheme();
  const blocksOf = (job: ChatJob) => jobBlockLines(job.widget?.blocks ?? []);
  return (
    <box flexDirection="column" paddingLeft={4}>
      <Index each={p.jobs}>
        {(job) => {
          const run = createMemo(() => {
            const output = job().output;
            return !job().widget?.blocks.length && output ? testProgress(output) : null;
          });
          const blocks = createMemo(() => blocksOf(job()));
          const elapsed = createMemo(() => jobElapsed(job(), clock(job().status === "running")));
          // The command a job runs, when the title above it is a different thing (a description).
          const line = (): string | undefined => (job().title !== undefined && job().label !== job().id ? clip(job().label, 100) : undefined);
          return (
            <box flexDirection="column" border={["left"]} borderColor={job().status === "failed" ? t().danger : job().status === "running" ? t().accent : t().border} paddingLeft={1} marginTop={1}>
              <text wrapMode="none" truncate>
                <JobMark job={job()} />
                <span style={{ fg: t().text2 }}>{clip(job().title ?? job().label, LABEL_CHARS)}</span>
                <span style={{ fg: t().muted }}>{`  ${job().id}`}</span>
                <Show when={job().widget?.headline}>
                  {(head) => <span style={{ fg: t().text2 }}>{`  ${head().text}${head().label ? ` ${head().label}` : ""}`}</span>}
                </Show>
                <Show when={elapsed() !== undefined}>
                  <span style={{ fg: t().muted }}>{`  ${durationLabel(elapsed() as number)}`}</span>
                </Show>
                <Show when={job().status === "failed" && job().exitCode !== undefined}>
                  <span style={{ fg: t().danger }}>{`  exit ${job().exitCode}`}</span>
                </Show>
              </text>
              <Show when={line()}>{(text) => <text fg={t().muted} wrapMode="none" truncate>{`  ${text()}`}</text>}</Show>
              <Index each={blocks()}>
                {(text) => (
                  <text fg={t().text2} wrapMode="none" truncate>
                    {text()}
                  </text>
                )}
              </Index>
              <Show when={run()}>
                {(progress) => (
                  <text wrapMode="none" truncate>
                    <span style={{ fg: progress().failed > 0 ? t().danger : t().ok }}>{meter(Math.min(1, progress().done / Math.max(1, progress().total)))}</span>
                    <span style={{ fg: t().muted }}>{` ${progress().done}/${progress().total} tests`}</span>
                    <Show when={progress().failed > 0}>
                      <span style={{ fg: t().danger }}>{` · ${progress().failed} failed`}</span>
                    </Show>
                    <Show when={progress().current}>
                      {(now) => <span style={{ fg: t().muted }}>{` · ${clip(now(), 60)}`}</span>}
                    </Show>
                  </text>
                )}
              </Show>
              <Show when={job().widget?.stage}>
                {(stage) => <text fg={t().muted} wrapMode="none" truncate>{`  ${clip(stage(), 100)}`}</text>}
              </Show>
            </box>
          );
        }}
      </Index>
    </box>
  );
}
