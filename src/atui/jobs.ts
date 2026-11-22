// A chat's background jobs as the terminal words them, apart from the drawing: one
// line a job above the composer (its id, what it is, where it is, its clock), and a
// job's own widget as rows under the call that holds it (a meter's bar, a stat's
// figures, a spark's shape, a grid's pairs). The data is the browser's — web/jobs.ts
// folds every call's jobs into one list, and shared/output-facts.ts reads a test run's
// progress from a job whose harness hands over no widget. Pure.
import type { JobBlock } from "../shared/protocol.js";
import { jobElapsed, type ChatJob } from "../web/jobs.js";
import { testProgress } from "../shared/output-facts.js";
import { clip } from "./format.js";
import { durationLabel } from "./neat.js";

/** Cells in a meter: what one line has room for. */
const METER_CELLS = 10;
/** What a job's label is cut to. */
export const LABEL_CHARS = 60;
const SPARK = "▁▂▃▄▅▆▇█";

/** A share as a bar: what is done, then what is not. */
export function meter(value: number, cells = METER_CELLS): string {
  const filled = Math.round(Math.max(0, Math.min(1, value)) * cells);
  return "━".repeat(filled) + "░".repeat(cells - filled);
}

/** A widget block as terminal rows: a meter's bar, a stat's figures, a spark's shape, a grid's pairs. */
export function jobBlockLines(blocks: readonly JobBlock[]): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.kind) {
      case "meter":
        out.push([block.label, meter(block.value), block.text ?? `${Math.round(block.value * 100)}%`].filter(Boolean).join(" "));
        break;
      case "stat":
        out.push(block.items.map((item) => [item.text, item.label].filter(Boolean).join(" ")).join(" · "));
        break;
      case "text":
        out.push(block.text);
        break;
      case "bars": {
        const max = block.max ?? Math.max(...block.items.map((item) => item.value), 1);
        const rows = block.items.map((item) => `${item.label} ${meter(max > 0 ? item.value / max : 0, 6)} ${item.text ?? item.value}`);
        out.push(...(block.label ? [block.label, ...rows.map((row) => `  ${row}`)] : rows));
        break;
      }
      case "spark": {
        const min = block.min ?? 0;
        const max = block.max ?? Math.max(...block.values, 1);
        const shape = block.values.map((v) => SPARK[Math.min(7, Math.max(0, Math.round(((v - min) / Math.max(1e-9, max - min)) * 7)))]).join("");
        out.push([shape, block.last, block.label].filter(Boolean).join(" "));
        break;
      }
      case "grid":
        out.push([block.label, block.items.map((item) => `${item.label} ${item.text ?? ""}`.trim()).join(" · ")].filter(Boolean).join(": "));
        break;
    }
  }
  return out;
}

/**
 * One job on one line: its id, what it is, where it is (its widget's stage, or a test
 * run's own progress when the harness sends no widget), and its clock. Pure.
 */
export function jobLine(job: ChatJob, now: number): string {
  const elapsed = jobElapsed(job, now);
  const run = !job.widget?.blocks.length && job.output ? testProgress(job.output) : null;
  const stage =
    job.widget?.stage ??
    (run && run.total > 0 ? `${run.done}/${run.total} tests${run.failed > 0 ? ` · ${run.failed} failed` : ""}` : undefined) ??
    (job.status === "failed" ? "failed" : job.status === "stopped" ? "stopped" : undefined);
  return [job.id, clip(job.title ?? job.label, LABEL_CHARS), stage, elapsed !== undefined ? durationLabel(elapsed) : "", job.status === "failed" && job.exitCode !== undefined ? `exit ${job.exitCode}` : ""]
    .filter(Boolean)
    .join(" · ");
}
