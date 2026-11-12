// The review panel's model: every edit and write in the chat, by file in the
// order they were first touched. The rest of the model — what a comment pins to,
// how a pin follows an edited line, and the prompt a batch becomes — is
// shared/review.ts, which the server and atui run too.
import type { ChatItem, ReviewAnchor, ReviewThread } from "../shared/protocol.js";
import { buildLineIndex, commentKey, reanchor, type FileChanges } from "../shared/review.js";
import { buildTurns, relativePath } from "./turns.js";

export {
  anchorOf,
  batchPrompt,
  buildLineIndex,
  commentable,
  commentKey,
  hashLine,
  reanchor,
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

/** A comment thread where a diff line can draw it, and whether its line is still there. */
export interface PlacedThread {
  thread: ReviewThread;
  /** The line it is drawn under: the pin's line now, or where it was pinned when nothing matches. */
  line: number | null;
  /** No edit still has the line's text: drawn with a "line changed since" badge, never moved. */
  stale: boolean;
}

/**
 * Threads under the diff lines they belong to, keyed `toolId:lineIndex`, and the
 * ones no edit shows any more (a path the chat's items no longer carry). A thread
 * is drawn once, on the newest edit that still shows its line, so an edit made
 * again does not show the same comment twice.
 */
export function placeThreads(files: FileChanges[], threads: ReviewThread[]): { placed: Map<string, PlacedThread[]>; detached: PlacedThread[] } {
  const index = buildLineIndex(files);
  const placed = new Map<string, PlacedThread[]>();
  const detached: PlacedThread[] = [];
  for (const thread of threads) {
    const at = reanchor(thread.anchor, index);
    const stale = at === "stale";
    const entry: PlacedThread = { thread, line: stale ? thread.anchor.line : at.line, stale };
    const key = newestLineKey(files, thread.anchor, entry.line);
    if (!key) {
      detached.push(entry);
      continue;
    }
    const list = placed.get(key);
    if (list) list.push(entry);
    else placed.set(key, [entry]);
  }
  return { placed, detached };
}

/** The newest edit of the path that still shows `side` at `line`. */
function newestLineKey(files: FileChanges[], anchor: ReviewAnchor, line: number | null): string | null {
  const file = files.find((f) => f.path === anchor.path);
  if (!file) return null;
  for (let e = file.edits.length - 1; e >= 0; e--) {
    const edit = file.edits[e];
    if (!edit) continue;
    const lines = edit.tool.diff?.lines ?? [];
    for (let i = 0; i < lines.length; i++) {
      const at = lines[i];
      if (at && at.kind === anchor.side && (at.line ?? null) === line) return commentKey(edit.tool.id, i);
    }
  }
  return null;
}
