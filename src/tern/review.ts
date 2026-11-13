// The review in the Tern client: the web panel's Review as a Tern overlay —
// every file the chat changed, each edit's lines under it with the server's
// comment threads drawn at their lines, a cursor over the lines that take a
// comment, and the open ones sent to the agent as one prompt. The rows and
// the cursor are atui's review model (atui/review.ts), the placement the web's
// (web/review.ts), and the words the shared rule's (shared/review.ts); this
// file lays them out and holds the screen's own state. Tern never takes the
// keyboard: app.ts routes the keys and calls the state's review actions.
import { span, ui, type Node, type Spans } from "@stencil-hq/tern";
import type { ReviewThread } from "../shared/protocol.js";
import { commentable, type FileChanges, type OriginMarks } from "../shared/review.js";
import type { ReviewRow } from "../atui/review.js";
import type { PlacedThread } from "../web/review.js";

/** The screen's own state: null while closed (app.ts holds the signal). */
export interface ReviewScreenState {
  /** The cursor's row, over commentable lines. */
  at: number;
  /** The comment being written: which line (`toolId:index`) and, for a reply, which thread. */
  writing: { key: string; threadId?: string; text: string } | null;
}

export const reviewScreen = (at: number): ReviewScreenState => ({ at, writing: null });

/** A line row's node id, for `surface.reveal` when the cursor moves. */
export const rowId = (index: number): string => `layer.review.body.r${index}`;

/** The writing input's node id (it is the scroll's last row), for `surface.focus`. */
export const REVIEW_INPUT_ID = "layer.review.body.writing";

/** A line's number column: right-aligned in five cells, in mono. */
const lineNo = (line: { line?: number }): string => (line.line !== undefined ? String(line.line).padStart(5) : "     ");

export interface ReviewCx {
  screen: ReviewScreenState;
  rows: ReviewRow[];
  files: FileChanges[];
  placed: { placed: Map<string, PlacedThread[]>; detached: PlacedThread[] };
  marks: OriginMarks | null;
  /** How many threads are open and resolved, for the head and the send button. */
  open: number;
  resolved: number;
  /** A send is going out. */
  sending: boolean;
  on: {
    close: () => void;
    cursor: (at: number) => void;
    /** Comment on the cursor's line (a reply when the line has a thread). */
    comment: () => void;
    text: (text: string) => void;
    save: () => void;
    cancelWriting: () => void;
    resolve: (thread: ReviewThread) => void;
    remove: (thread: ReviewThread) => void;
    send: () => void;
  };
}

const SIGN: Record<string, string> = { add: "+", del: "-", ctx: " ", hunk: "", gap: "" };

/** A line's spans: sign and text in the side's colour, a hunk quiet. */
function lineSpans(row: Extract<ReviewRow, { kind: "line" }>): Spans {
  const line = row.line;
  if (line.kind === "hunk" || line.kind === "gap") return [span(line.text || "⋯", "muted")];
  const tone = line.kind === "add" ? "success" : line.kind === "del" ? "error" : "";
  return [span(`${SIGN[line.kind]} `, tone), span(line.text, tone)];
}

/** A file's heading: the path, its +/-, and how many of its lines the chat wrote and how many changed since. */
function fileHead(file: FileChanges, marks: OriginMarks | null): Spans {
  const counts = marks?.byPath.get(file.path);
  const attribution =
    counts && counts.agent + counts.changed > 0
      ? span(`  · ${counts.agent} from this chat${counts.changed > 0 ? `, ${counts.changed} changed since` : ""}`, "muted")
      : null;
  return [span(file.path, "strong"), span(`  +${file.added}`, "ins"), span(" "), span(`−${file.removed}`, "del"), ...(attribution ? [attribution] : [])];
}

/** A thread at its line: its notes as one quiet block, ticked when resolved, "line changed since" when stale. */
function threadNode(entry: PlacedThread, i: number): Node {
  const thread = entry.thread;
  const done = thread.status === "resolved";
  return ui.text(
    { key: `t${i}` },
    span(done ? "✓ " : "✎ ", done ? "muted" : "accent"),
    span(thread.notes.map((n) => n.text.trim()).join(" · "), done ? "muted" : ""),
    entry.stale ? span("  (line changed since)", "warning") : null,
  );
}

/** The review overlay: files and their edits' lines, threads at their lines, the writing box, and the keys. */
export function reviewNode(cx: ReviewCx): Node {
  const { rows } = cx;
  const body: Node[] = [];
  if (rows.length === 0) body.push(ui.text({ key: "empty" }, span("The agent has not edited any files in this chat.", "muted")));
  rows.forEach((row, i) => {
    const here = i === cx.screen.at && row.kind === "line";
    if (row.kind === "file") {
      body.push(ui.text({ key: `r${i}`, truncate: "end" }, fileHead(cx.files[row.file] as FileChanges, cx.marks)));
      return;
    }
    if (row.kind === "edit") {
      body.push(ui.text({ key: `r${i}` }, span(`  ${row.label}`, "muted")));
      return;
    }
    const line = row.line;
    // The "changed" mark reads the same `toolId:index` key the grouping does.
    const at = row.key.lastIndexOf(":");
    const changed = cx.marks?.byTool.get(row.key.slice(0, at))?.get(Number(row.key.slice(at + 1))) === "changed";
    body.push(
      ui.row(
        {
          key: `r${i}`,
          gap: "sm",
          align: "center",
          ...(commentable(line) ? { onClick: () => cx.on.comment(), title: "Comment on this line" } : {}),
        },
        ui.text({ key: "g" }, span(commentable(line) ? (here ? "▌" : " ") : " ", here ? "accent" : "muted")),
        ui.text(
          { key: "l", grow: 1, truncate: "end" },
          [
            span(lineNo(line), "mono"),
            span(" "),
            ...lineSpans(row),
            ...(changed ? [span("  ↯ changed since", "warning")] : []),
          ],
        ),
      ),
    );
    (cx.placed.placed.get(row.key) ?? []).forEach((entry: PlacedThread, j: number) => body.push(threadNode(entry, j)));
  });
  if (cx.placed.detached.length > 0) {
    body.push(ui.text({ key: "detached-h" }, span("Lines these changes no longer show", "strong")));
    cx.placed.detached.forEach((entry, j) => body.push(threadNode(entry, j)));
  }
  if (cx.screen.writing) {
    body.push(
      ui.input({
        key: "writing",
        text: cx.screen.writing.text,
        cursor: cx.screen.writing.text.length,
        placeholder: cx.screen.writing.threadId ? "Add to the thread: Enter saves, Esc drops" : "What should change here? Enter saves, Esc drops",
        aria: "Comment",
        onEdit: (e) => cx.on.text(e.text),
      }),
    );
  }
  return ui.overlay(
    {
      key: "review",
      anchor: "center",
      size: "lg",
      head: "Review changes",
      meta: `${cx.files.length} ${cx.files.length === 1 ? "file" : "files"} · ${cx.open} open${cx.resolved > 0 ? ` · ${cx.resolved} resolved` : ""}`,
      end: ui.button({ key: "close", text: "Close", keys: ["esc"], variant: "quiet", size: "sm", onClick: cx.on.close }),
      foot: ui.row(
        { key: "keys", gap: "sm" },
        ui.text({ key: "k", grow: 1, truncate: "end" }, span(cx.sending ? "Sending…" : "↑↓ line · ]/[ file · Enter comment · r resolve · x delete · S send · Esc closes", "muted")),
        ui.button({
          key: "send",
          text: cx.open === 1 ? "Send 1 comment" : `Send ${cx.open} comments`,
          disabled: cx.open === 0 ? "No open comments to send" : cx.sending ? "Sending…" : undefined,
          busy: cx.sending,
          onClick: cx.on.send,
        }),
      ),
    },
    ui.scroll({ key: "body", gap: "xs" }, body),
  );
}
