// One line for the worktree picker's notice: what a new checkout was seeded
// with, read from the create response's WorktreeSeedReport. Pure; the picker
// raises it as a toast, and nothing is said when the include file seeded none.

import type { WorktreeSeedReport } from "../shared/protocol.js";

/** How many entries the line names before it counts the rest. */
const MAX_NAMED = 6;

const named = (items: string[], extra: number): string => {
  const shown = items.slice(0, MAX_NAMED);
  const rest = items.length - shown.length + extra;
  return shown.join(", ") + (rest > 0 ? ` +${rest} more` : "");
};

/** A short seeded summary, or null when nothing was copied, linked, or skipped. */
export function worktreeSeedSummary(report: WorktreeSeedReport): string | null {
  const parts: string[] = [];
  if (report.copied.length > 0) parts.push(`copied ${named(report.copied, 0)}`);
  if (report.linked.length > 0) parts.push(`linked ${named(report.linked, 0)}`);
  if (report.skipped.length > 0 || report.more > 0) {
    parts.push(`skipped ${named(report.skipped.map((s) => `${s.path} (${s.reason})`), report.more)}`);
  }
  if (parts.length === 0) return null;
  return `Worktree seeded: ${parts.join("; ")}`;
}
