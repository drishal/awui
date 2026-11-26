// What a sidebar row says about its session besides its title: the one muted subline under the title —
// the project it is out of, the status its agent set, or a branch that is not the folder's trunk — and
// nothing else. Pure, so the flat Recent list, the sections above it, and the grouped Projects list all
// state a session the same way, and the rules are unit-tested without a DOM.
import type { AgentStatusState, ProjectSession } from "../shared/protocol.js";
import { agentStatusText } from "./agent-status.js";
import type { ProjectTag } from "./recent-view.js";
import { isTrunkBranch } from "./session-groups.js";

/** The one muted line under a title. */
export type RowSubline =
  /** The project the row is out of: its badge and name, and its branch when that is not the trunk. */
  | { kind: "tag"; tag: ProjectTag }
  /** The line the row's own agent set for itself: its words, its state, and when it wrote it. */
  | { kind: "agent"; text: string; state: AgentStatusState; line: string; at: number }
  /** The branch the row's project is checked out on, when it is not one it treats as its trunk. */
  | { kind: "branch"; text: string };

/**
 * The subline a row shows, or null when it has nothing to add (the row is then one line):
 *  - out of its project (`tag`), say which project — the flat list, and the sections above the folders;
 *  - inside its project, the agent's own status line, else a branch that is not the trunk one. Inside a
 *    project on `main` the branch is the folder head's fact, so repeating it says nothing.
 */
export function rowSubline(s: ProjectSession, opts: { tag?: ProjectTag | null; branch?: string | null }): RowSubline | null {
  if (opts.tag) return { kind: "tag", tag: opts.tag };
  if (s.agentStatus) {
    const { state, comment, at } = s.agentStatus;
    return { kind: "agent", text: comment || agentStatusText(s.agentStatus), state, line: agentStatusText(s.agentStatus), at };
  }
  const branch = opts.branch ?? null;
  return branch !== null && !isTrunkBranch(branch) ? { kind: "branch", text: branch } : null;
}
