// The words for an agent-set status line (agent-status.ts on the server): one short
// phrase per state, and the line a reader sees. Pure, so the sidebar row, the hover
// card, and the chat header say the same thing and a test can pin the words.
import type { AgentStatusLine, AgentStatusState } from "../shared/protocol.js";

export const AGENT_STATUS_WORDS: Record<AgentStatusState, string> = {
  working: "working",
  blocked: "blocked",
  review: "ready for review",
  done: "done",
};

/** What a row says: the state's word, and the agent's own sentence when it wrote one. */
export function agentStatusText(line: AgentStatusLine): string {
  const word = AGENT_STATUS_WORDS[line.state];
  return line.comment ? `${word} · ${line.comment}` : word;
}
