// Active work (the web UI's context panel, in a terminal): the chat's workers, runs, jobs, the
// requests waiting on a person, its comparisons, second opinions, review comments, and the
// context window, as cards of rows with a status word each. The grouping is web/context-panel.ts's
// (contextCards), so both clients and the browser agree on what exists and how it reads; this
// file only draws it and maps a row to the screen that row is about. C-x p opens it, and the
// composer's context figure opens it too. ↑/↓ (j/k) a row, Enter opens it (a worker's review, a
// call's turn, a comment's review, a chat, the Info tab), o opens the chat a row is about, Esc
// closes.
import { createMemo, createSignal, For, onMount, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { RaceSummary, ReviewThread, SecondOpinion } from "../../shared/protocol.js";
import { contextCards, gitSummaryLine, type ContextCard, type ContextCardRow } from "../../web/context-panel.js";
import { clip } from "../format.js";
import { moveRow, rowWindow } from "../delegated.js";
import { railEntries, railSummary, toneDot, toneOf, type RailEntry } from "../rail.js";
import { useAtui, useTheme } from "./context.js";

export interface RailActions {
  /** Open a chat by its id, in a tab of its own (a worker's, a parent's, an opinion's). */
  onChat: (chatId: string) => void;
  /** Open the delegated work panel on this worker (its review lives there). */
  onTask: (taskId: string) => void;
  /** Bring a tool call's turn into view in the transcript. */
  onTool: (toolId: string) => void;
  /** Open Review at this chat's comments. */
  onReview: () => void;
  /** The Info tab: the context window, the session's tokens, git, and the limits. */
  onUsage: () => void;
  onClose: () => void;
}

export function ContextRailView(p: RailActions) {
  const app = useAtui();
  const t = useTheme();
  const size = useTerminalDimensions();
  const chat = () => app.chat();
  // The project's records this chat's rail reads, asked once when it opens (the web panel does the same).
  const [races, setRaces] = createSignal<RaceSummary[] | null>(null);
  const [opinions, setOpinions] = createSignal<SecondOpinion[] | null>(null);
  const [threads, setThreads] = createSignal<ReviewThread[] | null>(null);
  const [note, setNote] = createSignal<string | null>(null);

  onMount(() => {
    const c = chat();
    if (!c) return;
    void app.server.call<{ races: RaceSummary[] }>("/api/races").then((r) => setRaces(r.races)).catch(() => setRaces([]));
    void app.server.call<{ opinions: SecondOpinion[] }>(`/api/chats/${c.chatId}/second-opinion`).then((r) => setOpinions(r.opinions)).catch(() => setOpinions([]));
    void app.server.call<{ threads: ReviewThread[] }>(`/api/chats/${c.chatId}/review-threads`).then((r) => setThreads(r.threads)).catch(() => setThreads([]));
  });

  const cards = createMemo<ContextCard[]>(() => {
    const c = chat();
    if (!c) return [];
    return contextCards({ chat: c, races: races(), opinions: opinions(), threads: threads() });
  });
  const entries = createMemo(() => railEntries(cards()));
  const [at, setAt] = createSignal(0);
  const here = () => entries()[at()] as RailEntry | undefined;
  // The rows are drawn with their headings, so the window is measured in drawn lines, not rows.
  const height = () => Math.max(6, size().height - 10);
  const width = () => Math.min(110, size().width - 6);
  const start = () => rowWindow(entries().length, at(), height());

  const open = (row: ContextCardRow) => {
    if (row.taskId) return p.onTask(row.taskId);
    switch (row.target.kind) {
      case "chat":
        return p.onChat(row.target.chatId);
      case "tool":
        return p.onTool(row.target.toolId);
      case "review":
        return p.onReview();
      case "usage":
        return p.onUsage();
      case "questions":
        return p.onClose();
      case "race":
        return setNote("A comparison opens in the browser: its chats and their diffs are the web UI's Race panel.");
    }
  };

  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    key.preventDefault();
    const list = entries();
    if (key.name === "escape" || key.name === "q") return p.onClose();
    if (key.name === "down" || key.name === "j") return setAt((i) => moveRow(list.length, i, 1));
    if (key.name === "up" || key.name === "k") return setAt((i) => moveRow(list.length, i, -1));
    if (key.name === "pagedown") return setAt((i) => moveRow(list.length, i, Math.floor(height() / 2)));
    if (key.name === "pageup") return setAt((i) => moveRow(list.length, i, -Math.floor(height() / 2)));
    if (key.name === "home") return setAt(0);
    if (key.name === "end") return setAt(moveRow(list.length, list.length, 0));
    const row = here()?.row;
    if (!row) return;
    if (key.name === "return") return open(row);
    // The chat behind a row: a worker's child chat, an opinion's, the chat this chat was delegated from.
    if (key.name === "o") {
      if (row.target.kind === "chat") return p.onChat(row.target.chatId);
      return setNote("This row is not a chat: Enter opens what it is about.");
    }
  });

  const shown = () => entries().slice(start(), start() + height());

  return (
    <box
      position="absolute"
      top={1}
      left={Math.max(0, Math.floor((size().width - width()) / 2))}
      width={width()}
      height={Math.max(8, size().height - 2)}
      zIndex={15}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={t().border}
      backgroundColor={t().surface}
      title=" Active work "
      titleColor={t().text}
      paddingLeft={1}
      paddingRight={1}
    >
      <box flexDirection="row" flexShrink={0}>
        <text flexGrow={1} wrapMode="none" truncate>
          <b>{clip(chat()?.title || "New chat", width() - 40)}</b>
          <span style={{ fg: t().muted }}>{`  ${chat()?.harnessId ?? ""} · ${chat()?.workspace.name ?? ""}`}</span>
        </text>
        <text flexShrink={0} fg={t().muted}>
          {gitSummaryLine(app.git()) ?? ""}
        </text>
      </box>
      <text flexShrink={0} fg={t().text2}>
        {railSummary(cards())}
      </text>
      <box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1}>
        <For each={shown()}>
          {(entry, i) => {
            const index = () => start() + i();
            const first = () => index() === 0 || entries()[index() - 1]?.card.id !== entry.card.id;
            return (
              <box flexDirection="column" flexShrink={0}>
                <Show when={first()}>
                  <text flexShrink={0} fg={t().muted} marginTop={index() === 0 ? 0 : 1}>
                    <b>{`${entry.card.label}${entry.card.count > 0 ? ` (${entry.card.count})` : ""}`}</b>
                    <Show when={entry.card.attention}>
                      <span style={{ fg: entry.card.attention === "warn" ? t().warn : t().accent }}>{" ●"}</span>
                    </Show>
                  </text>
                </Show>
                <box flexDirection="row" backgroundColor={index() === at() ? t().selection : undefined} onMouseDown={() => setAt(index())}>
                  <text flexShrink={0} fg={index() === at() ? t().accent : t().border}>
                    {index() === at() ? "▌" : " "}
                  </text>
                  <text flexShrink={0} fg={toneOf(t(), entry.row.status.tone)}>{`${toneDot(entry.row.status.tone)} `}</text>
                  <text flexGrow={1} wrapMode="none" truncate fg={t().text}>
                    {entry.row.title}
                  </text>
                  <text flexShrink={0} fg={t().muted} wrapMode="none" truncate>
                    {` ${clip(entry.row.meta, Math.max(12, width() - 52))}`}
                  </text>
                  <text flexShrink={0} fg={toneOf(t(), entry.row.status.tone)}>{`  ${entry.row.status.word}`}</text>
                </box>
                <Show when={entry.row.note}>
                  {(text) => <text fg={t().muted}>{`      ${clip(text(), width() - 8)}`}</text>}
                </Show>
              </box>
            );
          }}
        </For>
        <Show when={entries().length === 0}>
          <text fg={t().muted}>Nothing to show: this chat has no workers, runs, or comments yet.</text>
        </Show>
      </box>
      <text flexShrink={0} fg={note() ? t().warn : t().muted} marginTop={1}>
        {note() ?? "↑↓ row · Enter opens · o opens the chat · Esc closes"}
      </text>
    </box>
  );
}
