// The words a comparison (race) uses for a member's state and for what a cleanup did,
// shared by the web's Race panel and atui's comparison sheet so both say the same thing.
import type { RaceMemberView } from "../shared/protocol.js";

export const STATUS_WORD: Record<RaceMemberView["status"], string> = { running: "running", settled: "finished", failed: "failed", closed: "chat closed" };

/** Why a cleanup would keep this loser, in the panel's words. */
export function loserState(member: RaceMemberView): string {
  if (member.status === "running") return "still running";
  if (member.dirty) return "has uncommitted work";
  if ((member.unmerged ?? 0) > 0) return `${member.unmerged} unmerged commit${member.unmerged === 1 ? "" : "s"}`;
  if (member.status === "closed") return "clean, chat closed";
  return "clean";
}

/** What a cleanup did to one member (its `reason`, when it kept something). */
export const CLEANUP_WORD: Record<string, string> = {
  running: "kept: still running",
  uncommitted: "kept: uncommitted work",
  moved: "kept: its HEAD moved off the branch",
  unmerged: "kept: unmerged commits",
  branch_kept: "worktree removed, branch kept",
  worktree_gone: "worktree was already gone",
  worktree_refused: "kept: git refused to remove it",
  outside_project: "kept: its worktree is outside the project",
};
