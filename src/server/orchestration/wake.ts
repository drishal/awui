// The message a parent agent gets when a delegated child it was not watching finishes: one bounded
// report per task, coalesced into a single prompt per parent. The wording lives here so a settled
// task, a task a restart marked interrupted, and a retry all say the same thing, and so the bound is
// testable without a chat. The orchestrator owns the ledger and the timer; this file only composes.
import { MAX_ERROR_CHARS, MAX_RESULT_CHARS, formatElapsed, type StoredTask } from "./types.js";
import { scopeNote } from "./scope.js";

/** Reports queued for one parent within this window flush as one prompt (a council's three arrive together). */
export const WAKE_COALESCE_MS = 2_500;
/** A delivery that failed (a busy chat, a refusal) is tried again after this, at most MAX_WAKE_ATTEMPTS times in all. */
export const WAKE_RETRY_MS = 5_000;
export const MAX_WAKE_ATTEMPTS = 3;
/** One wake prompt, however many tasks it reports. */
export const MAX_WAKE_CHARS = 6_000;

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 20)).trimEnd()}\n[… cut to fit]`;
}

/** One task's report: the envelope, what it was, its answer, and how to read or continue it. */
function reportBlock(task: StoredTask): string {
  const elapsed = formatElapsed((task.endedAt ?? Date.now()) - task.createdAt);
  const lines = [`[awui delegate ${task.id} · ${task.outcome ?? task.state} · ${task.harnessId} · ${elapsed}]`, `"${task.title}"`];
  const note = scopeNote(task.scope);
  if (note) lines.push(`[${note}]`);
  const finalText = (task.result?.finalText ?? "").trim();
  if (finalText !== "") lines.push(clip(finalText, MAX_RESULT_CHARS));
  if (task.result?.error) lines.push(`Error: ${clip(task.result.error, MAX_ERROR_CHARS)}`);
  lines.push(`thread_read("${task.id}") for more; thread_send("${task.id}", …) to continue it.`);
  return lines.join("\n");
}

/**
 * The one prompt reporting `tasks`, in the order they finished, at most MAX_WAKE_CHARS. A task that
 * would overflow the rest of the budget ends the message: a report cut in the middle of its envelope
 * would be noise, and the task is still readable with thread_read.
 */
export function wakeReport(tasks: StoredTask[]): string {
  const blocks: string[] = [];
  let budget = MAX_WAKE_CHARS;
  for (const task of tasks) {
    const block = reportBlock(task);
    if (block.length > budget) {
      if (blocks.length === 0) blocks.push(clip(block, Math.max(200, budget)));
      break;
    }
    blocks.push(block);
    budget -= block.length + 2;
    if (budget <= 0) break;
  }
  // A task left out is marked delivered with the rest, so the message must say it exists.
  const left = tasks.length - blocks.length;
  if (left > 0) blocks.push(`[${left} more finished task${left === 1 ? "" : "s"} did not fit here: ask task_status for them]`);
  return blocks.join("\n\n");
}
