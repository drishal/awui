// Delegated work in Tern (the web UI's DelegatedTasks panel and TaskReview): one row a worker, and,
// opened, what it changed and the review that decides what happens to its patch. The words and the
// actions are the browser's (web/delegated-tasks.ts), the rows are atui/delegated.ts's, and the
// diff is Tern's own native diff of the same unified text the other clients draw — so a worker reads
// the same in all three. Tern draws it; app.ts keeps the selection, asks before a write, and sends.
import { span, ui, type Node } from "@stencil-hq/tern";
import type { FileChanges } from "../shared/review.js";
import type { ReviewAction, ReviewFacts } from "../web/delegated-tasks.js";
import { reviewWords, tasksMeta } from "../web/delegated-tasks.js";
import { ACTION_KEYS, clockNote, workerCount, type TaskRow } from "../atui/delegated.js";
import { unifiedDiff } from "../atui/format.js";

/** The scroll container's node id inside the layer, for `surface.scroll`. */
export const DELEGATED_SCROLL_ID = "layer.delegated.body";

/** A worker's status word as Tern's own colour. */
const TONE: Record<TaskRow["status"]["tone"], string> = { working: "accent", waiting: "warning", done: "success", failed: "error", quiet: "muted" };

export interface DelegatedCx {
  rows: TaskRow[];
  /** The cursor in the list. */
  selected: number;
  /** The worker whose own screen is drawn, or null for the list. */
  opened: TaskRow | null;
  review: ReviewFacts | null;
  /** The record is being read (its heads are checked on the server). */
  reading: boolean;
  actions: ReviewAction[];
  /** The worker's own edits, as its chat recorded them; null while they are being read. */
  changes: FileChanges[] | null;
  note: string;
  writing: boolean;
  /** The write waiting for its `y`. */
  confirming: string | null;
  busy: boolean;
  error: string | null;
  supports: (kind: string) => boolean;
  on: {
    close: () => void;
    back: () => void;
    select: (index: number) => void;
    open: (index: number) => void;
    act: (action: ReviewAction) => void;
    cancel: () => void;
    editNote: (from: number, to: number, text: string) => void;
    openChat: (chatId: string) => void;
  };
}

/** The review card: what the record is, then one button an action, and the note it carries. */
function reviewCard(cx: DelegatedCx, row: TaskRow): Node {
  const facts = cx.review;
  const buttons = cx.actions.map((action) =>
    ui.button({
      key: `act-${action.id}`,
      text: action.label,
      keys: [ACTION_KEYS[action.id]],
      size: "sm",
      variant: action.confirms ? "default" : "quiet",
      onClick: () => cx.on.act(action),
    }),
  );
  const why = cx.actions.find((action) => !action.enabled && action.why)?.why;
  return ui.card(
    { key: "review", head: [span("Review", "strong")], meta: [span(row.reviewable ? "managed checkout" : "", "muted")] },
    ui.col(
      { key: "r", gap: "sm" },
      facts ? ui.text({ key: "words" }, span(reviewWords(facts), "muted")) : ui.text({ key: "words" }, span(cx.reading ? "Checking the worker's recorded heads…" : "No review record for this worker.", "muted")),
      ...(why ? [ui.text({ key: "why" }, span(`Cannot apply: ${why}`, "warning"))] : []),
      ...(buttons.length > 0 ? [ui.row({ key: "acts", gap: "sm", wrap: true }, ...buttons)] : []),
      cx.writing
        ? ui.input({
            key: "note",
            text: cx.note,
            placeholder: "Review note (optional), sent with apply or keep",
            onEdit: (e) => cx.on.editNote(e.from, e.to, e.text),
          })
        : cx.note
          ? ui.text({ key: "note" }, span(`Note: ${cx.note}`, "muted"))
          : null,
    ),
  );
}

/** The worker's own screen: who it is, its review, and every file its chat recorded, diffed. */
function detail(cx: DelegatedCx, row: TaskRow): Node {
  const files = (cx.changes ?? []).map((file) =>
    ui.card(
      { key: `f-${file.path}`, head: [span(file.path, "strong")], meta: [span(`+${file.added} −${file.removed}`, "muted")] },
      ...file.edits.flatMap((edit, i) => (edit.tool.diff ? [ui.diff({ key: `d${i}`, path: file.path, text: unifiedDiff(file.path, edit.tool.diff), mode: "auto" })] : [])),
    ),
  );
  const facts = [
    { k: "Status", v: [span(`${row.word} · ${clockNote(row)}`, TONE[row.status.tone])] },
    ...(row.meta ? [{ k: "Agent", v: row.meta }] : []),
    ...(row.scope ? [{ k: "Scope", v: row.scope }] : []),
    ...(row.guard ? [{ k: "Guard", v: [span(row.guard, "warning")] }] : []),
  ];
  return ui.scroll(
    { key: "body", gap: "md" },
    ui.card(
      { key: "who", head: [span("Worker", "strong")], meta: [span(row.meta, "muted")], end: ui.text({ key: "clock" }, span(clockNote(row), "muted")) },
      cx.supports("kv") ? ui.kv({ key: "facts", layout: "grid", items: facts }) : ui.col({ key: "facts" }, facts.map((f, i) => ui.text({ key: `f${i}` }, span(`${f.k}  `, "muted"), ...(Array.isArray(f.v) ? f.v : [span(f.v)])))),
      ...(row.line ? [ui.text({ key: "line" }, span(row.line, "muted"))] : []),
      ...(row.task.asking ? [ui.text({ key: "asking" }, span("Waiting on you: o opens its chat, where the question is answered", "warning"))] : []),
    ),
    row.reviewable ? reviewCard(cx, row) : null,
    cx.changes === null
      ? ui.text({ key: "reading" }, span("Reading the worker's changes…", "muted"))
      : files.length > 0
        ? ui.col({ key: "files", gap: "sm" }, ...files)
        : ui.text({ key: "none" }, span(row.task.childChatId ? "The worker's chat recorded no file changes, or its chat has closed since." : "This worker has no chat of its own to read changes from.", "muted")),
  );
}

/** The list of workers: one row each, the cursor's row marked, and the keys underneath. */
function list(cx: DelegatedCx): Node {
  return ui.col(
    { key: "list", gap: "sm" },
    cx.rows.length > 0
      ? ui.list(
          {
            key: "l",
            selected: cx.rows[cx.selected] ? `layer.delegated.list.l.r${cx.selected}` : undefined,
            max: { lines: Math.max(3, cx.rows.length) },
            onSelect: (e) => {
              const n = Number(/\.r(\d+)$/.exec(e.item)?.[1] ?? -1);
              if (n >= 0) cx.on.select(n);
            },
            onActivate: (e) => {
              const n = Number(/\.r(\d+)$/.exec(e.item)?.[1] ?? -1);
              if (n >= 0) cx.on.open(n);
            },
          },
          cx.rows.map((row, i) =>
            ui.item({
              key: `r${i}`,
              label: row.title,
              detail: `${row.meta}${row.line ? ` · ${row.line}` : ""}`,
              value: [span(`${row.word} · ${row.elapsed}`, TONE[row.status.tone])],
              icon: "task",
            }),
          ),
        )
      : ui.text({ key: "none" }, span("This chat has delegated nothing. A worker appears here when its agent starts one.", "muted")),
  );
}

/** The delegated work overlay: the list, or one worker's own screen. */
export function delegatedNode(cx: DelegatedCx): Node {
  const row = cx.opened;
  const foot = cx.error
    ? [span(cx.error, "error")]
    : cx.confirming
      ? [span(`${cx.confirming}? y confirms · any other key cancels`, "warning")]
      : cx.busy
        ? [span("Working…", "muted")]
        : row
          ? [span(`${cx.actions.map((action) => `${ACTION_KEYS[action.id]} ${action.label.toLowerCase()}`).join(" · ")}${cx.actions.length > 0 ? " · n note · " : ""}o open chat · x cancel · Esc back`, "muted")]
          : [span("↑/↓ worker · Enter opens · o open its chat · x cancel · Esc closes", "muted")];
  return ui.overlay(
    {
      key: "delegated",
      anchor: "center",
      size: "lg",
      head: row ? row.title : "Delegated work",
      meta: [span(row ? row.meta : `${workerCount(cx.rows.length)} · ${tasksMeta(cx.rows.map((r) => r.task)) ?? "every worker has finished"}`, "muted")],
      end: row ? ui.button({ key: "back", text: "Back", keys: ["esc"], variant: "quiet", size: "sm", onClick: cx.on.back }) : ui.button({ key: "close", text: "Close", keys: ["esc"], variant: "quiet", size: "sm", onClick: cx.on.close }),
      foot: ui.text({ key: "keys" }, foot),
    },
    row ? detail(cx, row) : list(cx),
  );
}
