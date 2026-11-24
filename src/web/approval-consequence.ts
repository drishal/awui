// What approving an approval card does, in one plain sentence (ApprovalStack.tsx prints it above the
// payload). A harness names its request in its own words, so this reads the title for the kind of action
// and says nothing when it cannot tell: a wrong consequence is worse than none before a decision.

/** The action a title names, without its frame: "Allow tool: read" → "read", "Run this command?" → "Run this command". */
function actionOf(title: string): string {
  return title
    .replace(/^allow\s+/i, "")
    .replace(/^tool:\s*/i, "")
    .trim()
    .replace(/[?.!]+$/, "")
    .trim();
}

/**
 * The action's first word, lower-cased, cut where a separator or a camel case name turns over:
 * "web_fetch" → "web", "WebFetch" → "web", "readFile" → "read", "Run this command" → "run".
 */
function head(action: string): string {
  const letters = /^[A-Za-z]+/.exec(action)?.[0] ?? "";
  return (/^[A-Z]*[a-z]*/.exec(letters)?.[0] || letters).toLowerCase();
}

/** The verbs of one kind of action, as a harness or an agent names its tool. */
const KINDS: ReadonlyArray<readonly [readonly string[], string]> = [
  [["read", "view", "list", "ls", "glob", "grep", "search", "find", "cat", "open", "inspect"], "Reads files in this project"],
  [["write", "edit", "patch", "apply", "create", "mkdir", "insert", "replace", "save", "notebook"], "Changes files in this project"],
  [["bash", "shell", "run", "exec", "execute", "terminal", "command", "process", "test"], "Runs a command in this project"],
  [["web", "fetch", "http", "browse", "curl", "download", "url", "request"], "Reaches the network from this machine"],
  [["task", "agent", "delegate", "subagent", "spawn"], "Starts another agent to do work"],
  [["delete", "remove", "rm", "unlink", "trash"], "Deletes files in this project"],
];

/**
 * The consequence line's words, or null when the title does not name a kind of action this knows: an
 * agent's own tool title ("Open file with the editor", a custom ACP agent's name) stays unlabelled
 * rather than guessed at.
 */
export function approvalConsequence(title: string): string | null {
  const action = head(actionOf(title));
  if (!action) return null;
  return KINDS.find(([verbs]) => verbs.includes(action))?.[1] ?? null;
}
