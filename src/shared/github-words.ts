// The GitHub panel's words, shared by the web panel and both terminal
// clients: whether a check failed, the tally a header shows, a PR number
// read from its URL, how far the branch is from its upstream, and a stack
// layer's state. Pure, so every client words a PR alike.
import type { GitHubCheckView, PrStack, PrStackLayer } from "./protocol.js";

/** A check that has not passed and is not merely queued: the panel's failing rule (gh's buckets say pass/fail/pending/…). */
export const checkFailed = (state: string): boolean => /fail|error|cancel|timeout/i.test(state);

export interface CheckTally {
  /** The checks that passed, as the stack's tally counts them (`pass` exactly). */
  pass: number;
  fail: number;
  total: number;
  /** The failing checks' names, first first, for "failing: build, lint". */
  failing: string[];
}

export function checkTally(checks: readonly GitHubCheckView[]): CheckTally {
  const failing = checks.filter((c) => checkFailed(c.state));
  return {
    pass: checks.filter((c) => c.state === "pass").length,
    fail: failing.length,
    total: checks.length,
    failing: failing.map((c) => c.name),
  };
}

/** The one line a header shows for the checks: nothing when there are none, the tally, then the failing names. */
export function checkWords(checks: readonly GitHubCheckView[]): string {
  if (checks.length === 0) return "No reported checks are available for the current PR.";
  const tally = checkTally(checks);
  const base = `${tally.pass}/${tally.total} checks passing`;
  return tally.failing.length > 0 ? `${base} · failing: ${tally.failing.join(", ")}` : base;
}

/** The PR number a URL ends with (`/pull/42`), or null when it names none. */
export function prNumberOf(url: string): number | null {
  const match = /\/pull\/(\d+)$/.exec(url);
  return match ? Number(match[1]) : null;
}

/** The branch's sync, as the web panel writes it: the work not yet upstream, or the quiet word when it is even. */
export function upstreamWords(status: { upstream: string | null; ahead: number }): string {
  if (!status.upstream) return "No upstream yet. The first push sets it to the current branch on origin.";
  if (status.ahead === 0) return "Everything recorded on the upstream branch.";
  return `${status.ahead} local commit${status.ahead === 1 ? "" : "s"} not on upstream.`;
}

/** A layer's state in one word for the panel's own colours: open builds, merged lands, closed ends. */
export function layerWord(state: string): string {
  switch (state.toUpperCase()) {
    case "OPEN":
      return "open";
    case "MERGED":
      return "merged";
    case "CLOSED":
      return "closed";
    case "DRAFT":
      return "draft";
    default:
      return state.toLowerCase();
  }
}

/** A layer's checks as the row shows them: "2/3 checks" only when some are reported. */
export const layerChecks = (layer: PrStackLayer): string =>
  layer.checks.length > 0 ? `${layer.checks.filter((c) => c.state === "pass").length}/${layer.checks.length} checks` : "";

/** Whether a stack still has a layer a merge can land (open or draft); the merge button disables without one. */
export const mergeable = (stack: PrStack): boolean => stack.layers.some((l) => l.state === "OPEN" || l.state === "DRAFT");

/** What a merge left behind, as one notice: a layer that would not merge, then the checkouts that would not archive. */
export function mergeNotes(result: { refusal: { pr: number; message: string } | null; archiveRefusals: Array<{ pr: number; message: string }> }): string {
  const notes: string[] = [];
  if (result.refusal) notes.push(`#${result.refusal.pr} could not be merged: ${result.refusal.message}`);
  for (const refusal of result.archiveRefusals) notes.push(`#${refusal.pr}'s checkout could not be archived: ${refusal.message}`);
  return notes.join(" · ");
}
