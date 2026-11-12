// The review panel's model: every edit and write in the chat, by file in the
// order they were first touched. The rest of the model — what a comment pins to,
// how a pin follows an edited line, and the prompt a batch becomes — is
// shared/review.ts, which the server and atui run too.
import type { ChatItem } from "../shared/protocol.js";
import type { FileChanges } from "../shared/review.js";
import { buildTurns, relativePath } from "./turns.js";

export {
  anchorOf,
  batchPrompt,
  buildLineIndex,
  commentable,
  commentKey,
  hashLine,
  reanchor,
  reviewPrompt,
  type FileChanges,
  type FileEdit,
  type LineRef,
  type Reanchor,
  type ReviewComment,
} from "../shared/review.js";


export function collectChanges(items: ChatItem[], workspace: string): FileChanges[] {
  const turnOf = new Map<string, number>();
  for (const turn of buildTurns(items, "idle")) for (const item of [...turn.process, ...turn.workAfter]) turnOf.set(item.id, turn.through);
  const files = new Map<string, FileChanges>();
  for (const item of items) {
    if (item.kind !== "tool" || (item.category !== "edit" && item.category !== "write") || item.status !== "done" || !item.diff) continue;
    const path = relativePath(item.paths[0] ?? item.summary, workspace);
    const file = files.get(path) ?? { path, edits: [], added: 0, removed: 0 };
    file.edits.push({ tool: item, turn: turnOf.get(item.id) ?? 0 });
    file.added += item.diff.added;
    file.removed += item.diff.removed;
    files.set(path, file);
  }
  return [...files.values()];
}
