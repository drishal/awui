// Review changes (the web UI's Review, in a terminal): every file this chat
// changed, each edit's lines under it with a line cursor, and the comment
// threads the server keeps on those lines — a note added, a thread resolved or
// deleted, and all the open ones sent to the agent as one prompt. ↑/↓ (j/k) a
// line, ]/[ a file, Enter or c comments (or replies, when the line has a
// thread), r resolves or reopens it, x deletes it, S sends, Esc closes. The
// threads are the web panel's, so the same review is on every device
// (atui/review.ts lays the rows out).
import { createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { ReviewThread } from "../../shared/protocol.js";
import { anchorOf, collectChanges, placeThreads } from "../../web/review.js";
import { readMarks, type OriginMarks } from "../attribution.js";
import { clip } from "../format.js";
import { mix } from "../fx.js";
import { firstStop, moveCursor, moveFile, reviewRows, windowStart, type ReviewRow } from "../review.js";
import { useAtui, useTheme } from "./context.js";

const SIGN = { add: "+", del: "-", ctx: " ", hunk: "", gap: "" } as const;

export function ReviewView(p: { onClose: () => void }) {
  const app = useAtui();
  const t = useTheme();
  const size = useTerminalDimensions();
  const chat = () => app.chat();
  const chatId = () => chat()?.chatId ?? "";
  const files = createMemo(() => {
    const c = chat();
    return c ? collectChanges(c.items, c.workspace.path) : [];
  });
  const rows = createMemo(() => reviewRows(files()));
  // The server's threads, where the lines they pin to are now drawn.
  const placed = createMemo(() => placeThreads(files(), app.reviewComments(chatId())));
  const [at, setAt] = createSignal(firstStop(rows()));
  const [writing, setWriting] = createSignal<{ key: string; threadId?: string; draft: string } | null>(null);
  // Which lines the agent wrote and which have changed since (shared/review.ts's rule over the server's present-file read).
  const [sending, setSending] = createSignal(false);
  // Which lines the agent wrote and which have changed since (shared/review.ts's rule over the server's present-file read).
  const [marks, setMarks] = createSignal<OriginMarks | null>(null);
  let marksRead = 0;
  createEffect(() => {
    const c = chat();
    const list = c ? collectChanges(c.items, c.workspace.path) : [];
    if (!c || list.length === 0) return setMarks(null);
    const mine = ++marksRead;
    void readMarks(app.server, c.chatId, list).then((m) => mine === marksRead && setMarks(m));
  });
  const height = () => Math.max(6, size().height - 8);
  const start = () => windowStart(rows().length, Math.max(0, at()), height());
  const shown = () => rows().slice(start(), start() + height());
  /** Whether the line a comment key sits on (`toolId:index`) reads as changed by someone else since. */
  const lineChanged = (key: string): boolean => {
    const at = key.lastIndexOf(":");
    return marks()?.byTool.get(key.slice(0, at))?.get(Number(key.slice(at + 1))) === "changed";
  };
  const current = () => rows()[at()] as Extract<ReviewRow, { kind: "line" }> | undefined;
  const onLine = () => {
    const row = current();
    return row ? (placed().placed.get(row.key) ?? []) : [];
  };
  const open = createMemo(() => app.reviewComments(chatId()).filter((thread) => thread.status === "open"));
  const resolved = createMemo(() => app.reviewComments(chatId()).filter((thread) => thread.status === "resolved"));
  const staleIds = () => [...placed().placed.values()].flat().concat(placed().detached).filter((entry) => entry.stale).map((entry) => entry.thread.id);

  onMount(() => {
    const c = chat();
    if (!c) return;
    void app.loadReview(c.chatId);
    // A pin the agent's later edits moved to another line is queued to the server, so a batched prompt names it.
    void app.reanchorReview(c.chatId);
  });

  const save = async () => {
    const w = writing();
    const row = current();
    setWriting(null);
    const c = chat();
    if (!w || !row || !w.draft.trim() || !c) return;
    if (w.threadId) await app.replyReviewThread(c.chatId, w.threadId, w.draft.trim());
    else await app.createReviewThread(c.chatId, anchorOf(row.path, row.line), w.draft.trim());
  };

  const toggleResolve = async (thread: ReviewThread) => {
    const c = chat();
    if (c) await app.resolveReviewThread(c.chatId, thread.id, thread.status === "open" ? "resolved" : "open");
  };

  const remove = async (thread: ReviewThread) => {
    const c = chat();
    if (c) await app.deleteReviewThread(c.chatId, thread.id);
  };

  const send = async () => {
    const c = chat();
    if (!c || open().length === 0 || sending()) return;
    setSending(true);
    await app.sendReview(c.chatId, staleIds());
    setSending(false);
  };

  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    const w = writing();
    if (w) {
      // The comment box has the keys but these two.
      if (key.name === "escape") {
        key.preventDefault();
        setWriting(null);
      } else if (key.name === "return") {
        key.preventDefault();
        void save();
      }
      return;
    }
    key.preventDefault();
    const list = rows();
    if (key.name === "escape" || key.name === "q") p.onClose();
    else if (key.name === "down" || key.name === "j") setAt((i) => moveCursor(list, i, 1));
    else if (key.name === "up" || key.name === "k") setAt((i) => moveCursor(list, i, -1));
    else if (key.name === "pagedown") setAt((i) => moveCursor(list, i, Math.floor(height() / 2)));
    else if (key.name === "pageup") setAt((i) => moveCursor(list, i, -Math.floor(height() / 2)));
    else if (key.name === "]" || key.name === "n") setAt((i) => moveFile(list, i, 1));
    else if (key.name === "[" || key.name === "p") setAt((i) => moveFile(list, i, -1));
    else if ((key.name === "return" || key.name === "c") && current()) {
      const row = current() as Extract<ReviewRow, { kind: "line" }>;
      // A line that already has a thread takes the note into it; an empty one starts a thread.
      const existing = onLine().find((entry) => entry.thread.status === "open");
      setWriting({ key: row.key, ...(existing ? { threadId: existing.thread.id } : {}), draft: "" });
    } else if (key.name === "r" && onLine()[0]) void toggleResolve((onLine()[0] as { thread: ReviewThread }).thread);
    else if (key.name === "x" && onLine()[0]) void remove((onLine()[0] as { thread: ReviewThread }).thread);
    else if (key.name === "s" && key.shift) void send();
  });

  const lineColor = (kind: string) => (kind === "add" ? t().ok : kind === "del" ? t().danger : t().text2);

  return (
    <box flexGrow={1} flexDirection="column" backgroundColor={app.glass() ? undefined : t().bg} paddingLeft={2} paddingRight={2}>
      <box flexDirection="row" flexShrink={0} marginTop={1}>
        <text flexGrow={1} fg={t().text}>
          <b>Review changes</b>
          <span style={{ fg: t().muted }}>{`  ${files().length} ${files().length === 1 ? "file" : "files"} · ${open().length} open${resolved().length > 0 ? ` · ${resolved().length} resolved` : ""}`}</span>
        </text>
      </box>
      <Show when={files().length > 0} fallback={<text flexGrow={1} fg={t().muted}>The agent has not edited any files in this chat.</text>}>
        <box flexDirection="column" flexGrow={1} marginTop={1} overflow="hidden">
          <For each={shown()}>
            {(row, i) => {
              const index = () => start() + i();
              const here = () => index() === at();
              if (row.kind === "file") {
                return (
                  <text wrapMode="none" truncate marginTop={index() === 0 ? 0 : 1}>
                    <b style={{ fg: t().text }}>{row.path}</b>
                    <span style={{ fg: t().ok }}>{`  +${row.added}`}</span>
                    <span style={{ fg: t().danger }}>{` −${row.removed}`}</span>
                    <Show when={marks()?.byPath.get(row.path)}>
                      {(counts) => (
                        <span style={{ fg: t().muted }}>{`  · ${counts().agent} from this chat${counts().changed > 0 ? `, ${counts().changed} changed since` : ""}`}</span>
                      )}
                    </Show>
                  </text>
                );
              }
              if (row.kind === "edit") return <text fg={t().muted}>{`  ${row.label}`}</text>;
              const threads = () => placed().placed.get(row.key) ?? [];
              return (
                <box flexDirection="column">
                  <box flexDirection="row" backgroundColor={here() ? mix(t().bg, t().selection, 0.85) : undefined} onMouseDown={() => setAt(index())}>
                    <text flexShrink={0} fg={here() ? t().accent : t().border}>
                      {here() ? "▌" : " "}
                    </text>
                    <text flexShrink={0} fg={t().muted}>
                      {`${row.line.line !== undefined ? String(row.line.line).padStart(5) : "     "} `}
                    </text>
                    <text flexGrow={1} wrapMode="none" truncate fg={lineColor(row.line.kind)}>
                      {row.line.kind === "hunk" || row.line.kind === "gap" ? clip(row.line.text || "⋯", 120) : `${SIGN[row.line.kind]} ${row.line.text}`}
                    </text>
                    <Show when={lineChanged(row.key)}>
                      <text flexShrink={0} fg={t().warn}>↯ changed since</text>
                    </Show>
                  </box>
                  <For each={threads()}>
                    {(entry) => {
                      const done = () => entry.thread.status === "resolved";
                      return (
                        <text fg={done() ? t().muted : t().warn} wrapMode="word">
                          {`        ${done() ? "✓" : "✎"} ${entry.thread.notes.map((note) => note.text).join(" · ")}${entry.stale ? "  (line changed since)" : ""}`}
                        </text>
                      );
                    }}
                  </For>
                  <Show when={writing()?.key === row.key}>
                    <box flexDirection="row" paddingLeft={8} border={["left"]} borderColor={t().accent}>
                      <input
                        focused
                        flexGrow={1}
                        placeholder={writing()?.threadId ? "Add to the thread: Enter saves, Esc drops" : "What should change here? Enter saves, Esc drops"}
                        textColor={t().text}
                        backgroundColor={t().surface}
                        focusedBackgroundColor={t().surface}
                        value={writing()?.draft ?? ""}
                        onInput={(value: string) => setWriting((w) => (w ? { ...w, draft: value } : w))}
                      />
                    </box>
                  </Show>
                </box>
              );
            }}
          </For>
        </box>
      </Show>
      <text flexShrink={0} fg={t().muted} marginBottom={1}>
        {sending()
          ? "Sending…"
          : `↑↓ line · ]/[ file · Enter comment · r resolve · x delete · S send ${open().length} · Esc close`}
      </text>
    </box>
  );
}
