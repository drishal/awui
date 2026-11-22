// Asking the agent to retry a failed tool call. awui never runs a harness's tools
// itself (the harness owns tools, approvals, and trust), so "retry" is a message:
// it names the call and says how it failed, and the agent decides. Pure.
import type { ChatStatus, ToolItem } from "../shared/protocol.js";
import { toolSentence } from "../shared/tool-row.js";

/** The call as the agent would have been running it: "running npm run e2e". */
function whatItWasDoing(item: ToolItem, workspace: string): string {
  const text = toolSentence({ ...item, status: "running" }, workspace).text;
  return text.charAt(0).toLowerCase() + text.slice(1);
}

/** The follow-up that asks for the retry: the call in words and its error's first line. */
export function retryPrompt(item: ToolItem, workspace = ""): string {
  const error = toolSentence(item, workspace).error;
  return `Retry the failed tool call (${whatItWasDoing(item, workspace)}).${error ? ` It failed with: ${error}` : ""}`;
}

/** The button's accessible name: it says which call it asks about. */
export function retryLabel(item: ToolItem, workspace = ""): string {
  return `Ask the agent to retry ${whatItWasDoing(item, workspace)}`;
}

/**
 * What the button can do now: send the prompt as the next one (idle), queue it as
 * a follow-up (the chat works and the harness takes follow-ups), or wait (disabled,
 * with the reason). Null when the chat is gone, so no button is drawn.
 */
export type RetryMode = "send" | "queue" | "blocked";

export function retryMode(status: ChatStatus, supportsFollowUp: boolean): RetryMode | null {
  if (status === "disposed") return null;
  if (status === "idle" || status === "error") return "send";
  return supportsFollowUp ? "queue" : "blocked";
}
