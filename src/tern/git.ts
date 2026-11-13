// Git in the Tern client: the web composer's git panel as a Tern overlay —
// the branch, upstream, and last commit; every changed file by group, its
// Stage/Unstage a native button and its path a click to the diff; the commit
// message in a native input, with Stage all / Unstage all beside Commit. The
// words and grouping are the panel's (shared/git-words.ts, atui/git.ts); this
// file only lays them out and holds the screen's own state (what is being
// typed, which diff is open). Tern never takes the keyboard: app.ts routes
// the keys and calls the server.
import { span, ui, type Node, type Spans } from "@stencil-hq/tern";
import type { GitFileDiff, GitDiffSide, GitStatus } from "../shared/protocol.js";
import { GROUP_LABEL, OPERATION_LABEL } from "../shared/git-words.js";
import { countsWords, gitRows, rowWords, stageAction, syncWords } from "../atui/git.js";
import { unifiedDiff } from "../atui/format.js";

/**
 * One native edit of the commit message: replace UTF-16 `[from, to)` with
 * `text`, the caret where Tern says. The message is a plain string, not a
 * draft, so this is all the editing it needs.
 */
export function editMessage(text: string, e: { from: number; to: number; text: string }): string {
  return text.slice(0, e.from) + e.text + text.slice(e.to);
}
/** The screen's own state: null while closed (app.ts holds the signal). */
export interface GitScreen {
  writing: boolean;
  message: string;
  /** The open diff: which file and side, what it says once read (null while it loads). */
  diff: { path: string; side: GitDiffSide; body: GitFileDiff | null } | null;
}

export const gitScreen = (): GitScreen => ({ writing: false, message: "", diff: null });

/** The commit message's input node id, for `surface.focus`. */
/** The commit message's input node id (ids derive from the tree's keys), for `surface.focus`. */
export const GIT_INPUT_ID = "layer.git.body.commit.message";

export interface GitCx {
  status: GitStatus | null;
  screen: GitScreen;
  /** The write in flight ("stage", "unstage", "commit"), or null. */
  busy: string | null;
  on: {
    close: () => void;
    /** Stage or unstage `paths` (the row's word, or Stage all / Unstage all). */
    write: (kind: "stage" | "unstage", paths: string[]) => void;
    commit: () => void;
    /** Edit the commit message (a native input's event); an empty `text` clears it. */
    message: (text: string) => void;
    /** Click the message field: it takes the keys. */
    focusMessage: () => void;
    /** Open a file's diff against HEAD (its side decides which). */
    diff: (path: string, side: GitDiffSide) => void;
    closeDiff: () => void;
    refresh: () => void;
  };
}

const tone = (state: string): string => (state === "conflict" ? "error" : state === "untracked" ? "warning" : "accent");

const FACT_W = 12;

/** The facts as one quiet line each, as the web panel's dl words them. */
function factsNode(s: GitStatus): Node[] {
  const counts = countsWords(s);
  const rows: Array<[string, Exclude<Spans, string>]> = [
    ["Branch", [span(`${s.branch ?? `detached at ${s.head ?? "?"}`}${s.operation ? ` · ${OPERATION_LABEL[s.operation]}` : ""}`, "strong")]],
    [
      "Upstream",
      s.upstream
        ? [span(s.upstream, "mono"), span(`  ${s.ahead === 0 && s.behind === 0 ? "up to date" : `${s.ahead} ahead, ${s.behind} behind`}`, "muted")]
        : [span("none: this branch has not been pushed", "muted")],
    ],
    [
      "Changes",
      counts.length > 0
        ? [span(counts.join(" · ")), ...(s.added || s.removed ? [span(`  +${s.added}`, "ins"), span(" "), span(`−${s.removed}`, "del")] : [])]
        : [span("working tree clean", "muted")],
    ],
  ];
  if (s.lastCommit) rows.push(["Last commit", [span(s.lastCommit.hash, "mono"), span(` ${s.lastCommit.subject}`), span(`  ${s.lastCommit.author}`, "muted")]]);
  if (s.stashes > 0) rows.push(["Stashes", [span(String(s.stashes))]]);
  return rows.map(([label, value], i) => ui.text({ key: `f${i}` }, span(`${label.padEnd(FACT_W)}`, "muted"), value));
}

/** One changed file: its letter and path (a click opens its diff), its +/-, and its Stage word. */
function fileNode(cx: GitCx, index: number, path: string): Node | null {
  const row = gitRows(cx.status as GitStatus).find((r) => r.kind === "file" && r.entry.file.path === path);
  if (!row || row.kind !== "file") return null;
  const words = rowWords(row);
  const kind = stageAction(row);
  return ui.row(
    { key: `r${index}`, gap: "sm", align: "center" },
    ui.text(
      { key: "p", grow: 1, truncate: "end", title: `Diff ${path} (${row.entry.side})`, onClick: () => cx.on.diff(row.entry.file.path, row.entry.side) },
      span(`${words.letter} `, tone(row.entry.state)),
      span(words.path, "mono"),
      words.note ? span(`  (${words.note})`, "muted") : null,
    ),
    ui.text({ key: "n" }, [span(words.added, "ins"), span(" "), span(words.removed, "del")]),
    ui.button({ key: "act", text: kind === "unstage" ? "Unstage" : "Stage", size: "sm", variant: "quiet", busy: cx.busy === "stage" || cx.busy === "unstage", disabled: cx.busy !== null ? "A write is running" : undefined, onClick: () => cx.on.write(kind, [row.entry.file.path]) }),
  );
}

/** The Git overlay: facts, the commit card, then every group's files (or the open diff). */
export function gitNode(cx: GitCx): Node {
  const s = cx.status;
  const staged = s?.counts.staged ?? 0;
  const groups =
    s === null
      ? [ui.text({ key: "none" }, span(cx.busy === null ? "Reading the project's status…" : "…", "muted"))]
      : gitRows(s).map((row, i) =>
          row.kind === "group"
            ? ui.text({ key: `r${i}` }, span(`${GROUP_LABEL[row.group]} `, "strong"), span(String(row.count), "muted"))
            : fileNode(cx, i, row.entry.file.path),
        );
  return ui.overlay(
    {
      key: "git",
      anchor: "center",
      size: "lg",
      head: "Git",
      ...(s ? { meta: `${s.branch ?? `detached ${s.head ?? ""}`} · ${syncWords(s)}` } : {}),
      end: ui.button({ key: "close", text: "Close", keys: ["esc"], variant: "quiet", size: "sm", onClick: cx.on.close }),
      foot: ui.text({ key: "keys" }, span(cx.screen.diff ? "Esc back to the files · Esc closes" : "Click a path for its diff · click a file's Stage word to stage it · Esc closes", "muted")),
    },
    ui.scroll(
      { key: "body", gap: "sm" },
      s ? factsNode(s) : null,
      s
        ? ui.card(
            { key: "commit", head: [span("Commit", "strong"), span(`  ${staged} staged`, "muted")] },
            cx.screen.writing
              ? ui.input({
                  key: "message",
                  text: cx.screen.message,
                  cursor: cx.screen.message.length,
                  placeholder: "Commit message",
                  aria: "Commit message",
                  onFocus: cx.on.focusMessage,
                  onEdit: (e) => cx.on.message(editMessage(cx.screen.message, e)),
                })
              : staged > 0
                ? ui.text({ key: "hint", onClick: cx.on.focusMessage, title: "Click, then type the message" }, span("Write a message and press Enter", "muted"))
                : ui.text({ key: "hint" }, span("Stage a change, then commit", "muted")),
            ui.row(
              { key: "acts", gap: "sm" },
              ui.button({
                key: "go",
                text: staged > 0 ? `Commit ${staged}` : "Commit",
                disabled: staged === 0 ? "Stage a change first" : !cx.screen.message.trim() ? "Write a message first" : cx.busy !== null ? "A write is running" : undefined,
                busy: cx.busy === "commit",
                onClick: cx.on.commit,
              }),
              ui.button({ key: "all", text: "Stage all", variant: "quiet", size: "sm", busy: cx.busy === "stage", disabled: cx.busy !== null ? "A write is running" : undefined, onClick: () => cx.on.write("stage", s.files.filter((f) => f.staged === "conflict" || f.unstaged).map((f) => f.path)) }),
              ui.button({ key: "none", text: "Unstage all", variant: "quiet", size: "sm", busy: cx.busy === "unstage", disabled: staged === 0 ? "Nothing staged" : cx.busy !== null ? "A write is running" : undefined, onClick: () => cx.on.write("unstage", s.files.filter((f) => f.staged).map((f) => f.path)) }),
            ),
          )
        : null,
      cx.screen.diff
        ? ui.col(
            { key: "diff", gap: "xs" },
            ui.text(
              { key: "h" },
              span(cx.screen.diff.path, "mono"),
              span(`  ·  ${cx.screen.diff.side === "staged" ? "staged" : cx.screen.diff.side === "untracked" ? "untracked" : "not staged"}`, "muted"),
            ),
            cx.screen.diff.body === null
              ? ui.text({ key: "wait" }, span("Reading the diff…", "muted"))
              : cx.screen.diff.body.diff
                ? ui.diff({ key: "d", text: unifiedDiff(cx.screen.diff.path, cx.screen.diff.body.diff), path: cx.screen.diff.path })
                : ui.text({ key: "note" }, span(cx.screen.diff.body.note ?? "No changes to show", "muted")),
          )
        : null,
      ...groups,
      s && s.files.length === 0 && !cx.screen.diff ? ui.text({ key: "clean" }, span("Nothing to commit — the working tree is clean", "success")) : null,
    ),
  );
}
