// The review model the server, the web UI, and atui share: what a comment is
// pinned to (a diff line, by path, side, number, and a short hash of its text),
// where that pin now sits after the agent edited the file again, and the one
// prompt a batch of open threads becomes. Collecting the diffs themselves stays
// in web/review.ts, which reads the conversation's turns.
import { MAX_REVIEW_LINE_CHARS, type DiffLine, type ReviewAnchor, type ReviewThread, type ToolItem } from "./protocol.js";

export interface FileEdit {
  tool: ToolItem;
  /** The turn's ordinal, as the fork counts them. */
  turn: number;
}

export interface FileChanges {
  path: string;
  edits: FileEdit[];
  added: number;
  removed: number;
}

/** The old flat comment (the panel before threads): a diff line's key and its text, kept for migration. */
export interface ReviewComment {
  /** `toolId:lineIndex`: the diff line it is on. */
  key: string;
  path: string;
  line: DiffLine;
  text: string;
}

export const commentKey = (toolId: string, index: number): string => `${toolId}:${index}`;

/** A line can take a comment when it is real code: not a hunk header or a fold. */
export const commentable = (line: DiffLine): line is DiffLine & { kind: ReviewAnchor["side"] } => line.kind === "add" || line.kind === "del" || line.kind === "ctx";

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "-", ctx: " ", hunk: "", gap: "" };

/**
 * A line's identity when its number is not enough: djb2 over its trimmed text, 8
 * hex characters. Deterministic and dependency-free, so the server, the browser,
 * and atui all derive the same hash for the same line.
 */
export function hashLine(text: string): string {
  const trimmed = text.trim();
  let hash = 5381;
  for (let i = 0; i < trimmed.length; i++) hash = (Math.imul(hash, 33) + trimmed.charCodeAt(i)) >>> 0;
  return hash.toString(16).padStart(8, "0");
}

/** One line a pin may be found at: its side, its file line, and its text's hash. */
export interface LineRef {
  side: ReviewAnchor["side"];
  line: number | null;
  hash: string;
}

/**
 * Every commentable line of every known edit of every path, by path, in edit
 * order. Later edits carry ctx lines of the file's present content, so the end
 * of each list is the newest thing known about the file: searching it back to
 * front follows a pin to where its line is now.
 */
export function buildLineIndex(files: FileChanges[]): Map<string, LineRef[]> {
  const index = new Map<string, LineRef[]>();
  for (const file of files) {
    const refs = index.get(file.path) ?? [];
    for (const { tool } of file.edits) {
      for (const line of tool.diff?.lines ?? []) {
        if (!commentable(line)) continue;
        refs.push({ side: line.kind, line: line.line ?? null, hash: hashLine(line.text) });
      }
    }
    index.set(file.path, refs);
  }
  return index;
}

/** Where a pin stands now: the line it is on (`line` is the stored one when it has not moved), or "stale". */
export type Reanchor = { line: number | null } | "stale";

/**
 * Follow a pin through the edits the index knows: the newest line with the same
 * text on the same side, or "stale" when no edit still has it. An unchanged pin
 * answers the anchor's own line; a different number is a move the client queues
 * so every device follows it. Best-effort by design: a stale pin is displayed as
 * changed, never moved or dropped, and the stored anchor is only rewritten when a
 * move is found.
 */
export function reanchor(anchor: ReviewAnchor, index: Map<string, LineRef[]>): Reanchor {
  const refs = index.get(anchor.path);
  if (!refs || refs.length === 0) return "stale";
  // Back to front: the list is in edit order, so the newest occurrence of the text is the file's present one.
  for (let i = refs.length - 1; i >= 0; i--) {
    const ref = refs[i];
    if (ref && ref.side === anchor.side && ref.hash === anchor.hash) return { line: ref.line };
  }
  return "stale";
}

/** The pin a diff line takes: its side, number, hash, and text. */
export function anchorOf(path: string, line: DiffLine): ReviewAnchor {
  const side = line.kind === "add" || line.kind === "del" ? line.kind : "ctx";
  return { path, side, line: line.line ?? null, hash: hashLine(line.text), text: line.text.trim().slice(0, MAX_REVIEW_LINE_CHARS) };
}

/** How a pin is named in a prompt: `path:line`, or a removed line said so. */
function anchorWhere(anchor: ReviewAnchor): string {
  if (anchor.line === null) return anchor.path;
  return anchor.side === "del" ? `${anchor.path} (removed line ${anchor.line})` : `${anchor.path}:${anchor.line}`;
}

/** The prompt one flat comment becomes: its line under it, in file order. */
export function reviewPrompt(comments: ReviewComment[]): string {
  const parts = comments.map((c) => `${anchorWhere(anchorOf(c.path, c.line))}\n    ${SIGN[c.line.kind]} ${c.line.text.trim()}\n${c.text.trim()}`);
  return `Review comments on your changes:\n\n${parts.join("\n\n")}`;
}

/**
 * The batch an "send the comments" press becomes: every open thread, numbered so
 * the agent can answer "comment 2" by its number, each under the line it pins.
 * `stale` names the threads whose line the sending client could no longer find:
 * they are still sent, marked as changed, because the note still says what should
 * differ. Resolved threads are left out and only counted.
 */
export function batchPrompt(threads: ReviewThread[], stale?: ReadonlySet<string>): string {
  const open = threads
    .filter((t) => t.status === "open")
    .sort((a, b) => a.anchor.path.localeCompare(b.anchor.path) || (a.anchor.line ?? 0) - (b.anchor.line ?? 0));
  const parts = open.map((thread, i) => {
    const changed = stale?.has(thread.id) ? " — the line has since changed" : "";
    const notes = thread.notes.map((note) => `   ${note.text.trim()}`).join("\n");
    return `${i + 1}. ${anchorWhere(thread.anchor)}${changed}\n    ${SIGN[thread.anchor.side]} ${thread.anchor.text}\n${notes}`;
  });
  const resolved = threads.filter((t) => t.status === "resolved").length;
  const footer = `${open.length} open thread${open.length === 1 ? "" : "s"} sent${resolved > 0 ? `; ${resolved} resolved thread${resolved === 1 ? "" : "s"} not included` : ""}`;
  return `Review comments on your changes:\n\n${parts.join("\n\n")}\n\n(${footer})`;
}
