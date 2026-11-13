// Delegated work (the web UI's DelegatedTasks panel and TaskReview, in a terminal): one row a
// worker — its status, the agent that runs it, its clock, the write scope it was held to and what
// the guard saw — and, opened, what the worker changed and the review that decides what happens to
// it. Completion is not approval: Apply writes the patch into the lead checkout, Keep leaves it in
// its own checkout, Undo apply reverses an applied patch, and Remove worktree drops a kept one;
// each asks first. Cancel stops a worker that is still running. The words and the actions are
// web/delegated-tasks.ts's, the rows are atui/delegated.ts's, and the diff is the review's own
// rendering (atui/review.ts), so a worker reads the same here as in the browser.
import { createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { useKeyboard, useTerminalDimensions } from "@opentui/solid";
import type { ScrollBoxRenderable } from "@opentui/core";
import type { ChatSnapshot, DelegatedTaskView, IntegrationRecord } from "../../shared/protocol.js";
import { reviewActions, reviewWords, tasksMeta, type ReviewAction, type ReviewFacts } from "../../web/delegated-tasks.js";
import { collectChanges } from "../../web/review.js";
import { ACTION_KEYS, clockNote, moveRow, rowWindow, taskRows, workerCount, type TaskRow } from "../delegated.js";
import { clip } from "../format.js";
import { reviewRows } from "../review.js";
import { toneDot, toneOf } from "../rail.js";
import { useAtui, useTheme } from "./context.js";

const SIGN = { add: "+", del: "−", ctx: " ", hunk: "", gap: "" } as const;

/** The review record a worker's patch carries, as `/api/chats/:id/tasks/:taskId/review` answers it. */
interface ReviewAnswer {
  record: IntegrationRecord;
  headsMatch: boolean | null;
  reason: string | null;
}

const factsOf = (answer: ReviewAnswer | null): ReviewFacts | null =>
  answer
    ? {
        review: answer.record.review ? { decision: answer.record.review.decision, note: answer.record.review.note, by: answer.record.review.by, at: answer.record.review.at } : null,
        appliedAt: answer.record.appliedAt,
        discardedAt: answer.record.discardedAt,
        headsMatch: answer.headsMatch,
        reason: answer.reason,
      }
    : null;

export function DelegatedView(p: { onClose: () => void; initialTaskId?: string | null; onOpenChat: (chatId: string) => void }) {
  const app = useAtui();
  const t = useTheme();
  const size = useTerminalDimensions();
  const chat = () => app.chat();
  const harnessName = (id: string) => app.boot()?.harnesses.find((h) => h.id === id)?.displayName ?? id;

  // The chat's snapshot carries its workers and its `task` events keep them current, so it wins;
  // the read on opening is what a panel opened late falls back to when the snapshot has none yet.
  const [listed, setListed] = createSignal<DelegatedTaskView[]>(chat()?.delegated ?? []);
  const tasks = (): DelegatedTaskView[] => chat()?.delegated ?? listed();
  const [opened, setOpened] = createSignal<string | null>(p.initialTaskId ?? null);
  const [at, setAt] = createSignal(0);
  const [now, setNow] = createSignal(Date.now());
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  /** The write waiting for its `y`: an apply, a worktree's removal, a worker's cancel. Each asks first. */
  const [confirming, setConfirming] = createSignal<{ label: string; run: () => void } | null>(null);
  const [note, setNote] = createSignal("");
  const [writing, setWriting] = createSignal(false);
  const [review, setReview] = createSignal<ReviewAnswer | null>(null);
  const [reading, setReading] = createSignal(false);
  /** The worker's own edits, as its chat recorded them (null while the chat is being read). */
  const [changes, setChanges] = createSignal<ReturnType<typeof collectChanges> | null>(null);
  let scroller: ScrollBoxRenderable | undefined;

  const rows = createMemo<TaskRow[]>(() => taskRows(tasks(), now(), harnessName));
  const row = createMemo<TaskRow | null>(() => rows().find((r) => r.key === opened()) ?? null);
  const facts = createMemo(() => factsOf(review()));
  const actions = createMemo<ReviewAction[]>(() => {
    const known = facts();
    return known ? reviewActions(known) : [];
  });
  const diffRows = createMemo(() => reviewRows(changes() ?? []));
  const height = () => Math.max(4, size().height - 6);
  const width = () => Math.min(120, size().width - 6);
  const start = () => rowWindow(rows().length, at(), height());
  const tick = setInterval(() => setNow(Date.now()), 1000);
  onCleanup(() => clearInterval(tick));

  const readTasks = () => {
    const c = chat();
    if (!c) return;
    void app.server
      .call<{ tasks: DelegatedTaskView[] }>(`/api/chats/${c.chatId}/tasks`)
      .then((answer) => setListed(answer.tasks))
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
  };

  /** A worker's review record and the changes its chat recorded: what the detail screen shows. */
  const readDetail = (task: DelegatedTaskView) => {
    setReview(null);
    setChanges(null);
    setError(null);
    setNote("");
    const c = chat();
    if (!c) return;
    if (task.reviewable) {
      setReading(true);
      void app.server
        .call<ReviewAnswer>(`/api/chats/${c.chatId}/tasks/${task.id}/review`)
        .then((answer) => setReview(answer))
        .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        .finally(() => setReading(false));
    }
    if (task.childChatId) {
      void app.server
        .call<ChatSnapshot>(`/api/chats/${encodeURIComponent(task.childChatId)}`)
        .then((snapshot) => setChanges(collectChanges(snapshot.items, snapshot.workspace.path)))
        // A worker's chat is closed once its run settles and nothing holds it: its patch is still
        // reviewable, and the review screen says what it can do without the transcript.
        .catch(() => setChanges([]));
    } else setChanges([]);
  };

  onMount(readTasks);

  // The worker on screen is read once, when it appears: a panel opened from a rail row holds its
  // id before the chat's list has arrived, and a worker that finishes while it is open is re-read
  // by the action that changed it.
  let readFor: string | null = null;
  createEffect(() => {
    const target = row();
    if (!target || readFor === target.key) return;
    readFor = target.key;
    readDetail(target.task);
  });

  const openRow = (target: TaskRow) => {
    setOpened(target.key);
    setAt(rows().findIndex((r) => r.key === target.key));
    // Opened again later, the worker is read again: its record may have changed while it was closed.
    readFor = null;
  };

  /** One write against a worker: its cancel, or its review's decision. The server's refusal is shown as it came. */
  const call = async (taskId: string, path: string, body?: unknown) => {
    const c = chat();
    if (!c || busy()) return;
    setBusy(true);
    setError(null);
    try {
      // Always a POST: a cancel and a cleanup carry no body, and a bodyless call would be read as a GET.
      await app.server.call(`/api/chats/${c.chatId}/tasks/${taskId}/${path}`, { method: "POST", ...(body === undefined ? {} : { body }) });
      readTasks();
      const current = tasks().find((x) => x.id === taskId);
      if (current && current.id === opened()) {
        readFor = current.id;
        readDetail(current);
      }
    } catch (cause) {
      // A local-only refusal (403 local_only) and a moved head are the server's words, shown as they came.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
      setConfirming(null);
    }
  };

  const run = (action: ReviewAction) => {
    if (!action.enabled) return setError(action.why ?? "That action is not available now");
    setError(null);
    if (action.confirms) return setConfirming({ label: action.label, run: () => act(action) });
    return act(action);
  };

  const act = (action: ReviewAction) => {
    const taskId = opened();
    const workspaceId = review()?.record.workspaceId;
    if (!taskId) return;
    switch (action.id) {
      case "apply":
        return void call(taskId, "review", { workspaceId, decision: "apply", ...(note() ? { note: note() } : {}) });
      case "discard":
        return void call(taskId, "review", { workspaceId, decision: "discard", ...(note() ? { note: note() } : {}) });
      case "unreview":
        return void call(taskId, "unreview");
      case "cleanup":
        return void call(taskId, "review/cleanup");
    }
  };

  /** Stop a worker that is still running: the whole subtree, as the browser's Cancel does. */
  const cancelTask = (target: TaskRow) => {
    if (target.finished) return setError(`${target.title} has finished; there is nothing left to cancel`);
    setError(null);
    setConfirming({ label: `Cancel ${target.title}`, run: () => void call(target.key, "cancel") });
  };

  useKeyboard((key) => {
    if (key.defaultPrevented) return;
    key.preventDefault();
    if (writing()) {
      if (key.name === "escape") {
        setWriting(false);
        setNote("");
      } else if (key.name === "return") setWriting(false);
      return;
    }
    const pending = confirming();
    if (pending) {
      setConfirming(null);
      if (key.name === "y") return pending.run();
      return setError(null);
    }
    if (key.name === "escape" || key.name === "q") {
      const id = opened();
      if (id) {
        // Back to the list with the cursor on the worker that was open (its id, read before it is cleared).
        setOpened(null);
        setAt(Math.max(0, rows().findIndex((r) => r.key === id)));
        return;
      }
      return p.onClose();
    }
    const target = row();
    if (!target) {
      // The list: a cursor over the workers, and the two things a row offers.
      const list = rows();
      if (key.name === "down" || key.name === "j") return setAt((i) => moveRow(list.length, i, 1));
      if (key.name === "up" || key.name === "k") return setAt((i) => moveRow(list.length, i, -1));
      const current = list[at()];
      if (!current) return;
      if (key.name === "return") return openRow(current);
      if (key.name === "o") return current.task.childChatId ? p.onOpenChat(current.task.childChatId) : setError("This worker has no chat of its own yet");
      if (key.name === "x") return cancelTask(current);
      return;
    }
    // A worker's own screen: the files scroll, and the review's actions are one key each.
    if (key.name === "down") return scroller?.scrollBy(1);
    if (key.name === "up") return scroller?.scrollBy(-1);
    if (key.name === "pagedown") return scroller?.scrollBy(height());
    if (key.name === "pageup") return scroller?.scrollBy(-height());
    if (key.name === "home") return scroller?.scrollTo(0);
    if (key.name === "end") return scroller?.scrollTo(scroller.scrollHeight);
    if (key.name === "o") return target.task.childChatId ? p.onOpenChat(target.task.childChatId) : setError("This worker has no chat of its own yet");
    if (key.name === "x") return cancelTask(target);
    if (key.name === "n" && actions().length > 0) return setWriting(true);
    const action = actions().find((x) => ACTION_KEYS[x.id] === key.name);
    if (action) return run(action);
  });

  const taskLine = (target: TaskRow) => (
    // Never shrunk: the files below take the free space, and a shrunk header would overlap its own rows.
    <box flexDirection="column" flexShrink={0}>
      <box flexDirection="row">
        <text flexGrow={1} wrapMode="none" truncate>
          <b>{target.title}</b>
          <span style={{ fg: t().muted }}>{`  ${target.meta}`}</span>
        </text>
        <text flexShrink={0} fg={toneOf(t(), target.status.tone)}>{`${toneDot(target.status.tone)} ${target.word} `}</text>
        <text flexShrink={0} fg={t().muted}>{clockNote(target)}</text>
      </box>
      {target.scope ? <text fg={t().muted}>{`    ${target.scope}`}</text> : null}
      {target.guard ? <text fg={t().warn}>{`    ${target.guard}`}</text> : null}
      {target.line ? <text fg={t().text2} wrapMode="word">{`    ${clip(target.line, width() - 6)}`}</text> : null}
      {target.task.asking ? <text fg={t().warn}>{`    Waiting on you: o opens its chat, where the question is answered`}</text> : null}
    </box>
  );

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
      title=" Delegated work "
      titleColor={t().text}
      paddingLeft={1}
      paddingRight={1}
    >
      <text flexShrink={0} fg={t().text2} wrapMode="none" truncate>
        <b>{workerCount(rows().length)}</b>
        <span style={{ fg: t().muted }}>{`  ${tasksMeta(tasks()) ?? "every worker has finished"}`}</span>
      </text>
      <Show
        when={row()}
        fallback={
          <box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1}>
            <Show when={rows().length > 0} fallback={<text fg={t().muted}>This chat has delegated nothing. A worker appears here when its agent starts one.</text>}>
              <For each={rows().slice(start(), start() + height())}>
                {(target, i) => {
                  const index = () => start() + i();
                  return (
                    <box flexDirection="column" backgroundColor={index() === at() ? t().selection : undefined} onMouseDown={() => setAt(index())}>
                      <box flexDirection="row">
                        <text flexShrink={0} fg={index() === at() ? t().accent : t().border}>{index() === at() ? "▌" : " "}</text>
                        <text flexShrink={0} fg={toneOf(t(), target.status.tone)}>{`${toneDot(target.status.tone)} `}</text>
                        <text flexGrow={1} wrapMode="none" truncate fg={t().text}>{target.title}</text>
                        <text flexShrink={0} fg={t().muted} wrapMode="none" truncate>{` ${clip(target.meta, Math.max(10, width() - 46))}`}</text>
                        <text flexShrink={0} fg={toneOf(t(), target.status.tone)}>{` ${target.word}`}</text>
                        <text flexShrink={0} fg={t().muted}>{`  ${target.elapsed}`}</text>
                      </box>
                      {target.line ? <text fg={t().muted} wrapMode="none" truncate>{`    ${clip(target.line, width() - 8)}`}</text> : null}
                    </box>
                  );
                }}
              </For>
            </Show>
          </box>
        }
      >
        {(target) => (
          <box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1}>
            {taskLine(target())}
            <Show when={target().reviewable}>
              <box flexDirection="column" marginTop={1} flexShrink={0}>
                <text fg={t().muted}><b>Review</b></text>
                <Show when={review()} fallback={<text fg={t().muted}>{reading() ? "Checking the worker's recorded heads…" : "No review record for this worker."}</text>}>
                  <Show when={facts()}>{(known) => <text fg={t().text2} wrapMode="word">{reviewWords(known())}</text>}</Show>
                  <text>
                    <For each={actions()}>
                      {(action, i) => (
                        <span style={{ fg: action.enabled ? (action.confirms ? t().warn : t().accent) : t().muted }}>
                          {`${i() > 0 ? "  " : ""}${ACTION_KEYS[action.id]} ${action.label}${action.enabled ? "" : " (off)"}`}
                        </span>
                      )}
                    </For>
                    <Show when={note()}>
                      <span style={{ fg: t().muted }}>{`  note: ${clip(note(), width() - 20)}`}</span>
                    </Show>
                  </text>
                  <Show when={actions().some((a) => !a.enabled && a.why)}>
                    <text fg={t().muted} wrapMode="word">{`Cannot apply: ${actions().find((a) => !a.enabled)?.why ?? ""}`}</text>
                  </Show>
                </Show>
              </box>
            </Show>
            <box flexDirection="column" flexGrow={1} overflow="hidden" marginTop={1}>
              <Show when={changes() !== null} fallback={<text fg={t().muted}>Reading the worker's changes…</text>}>
                <Show
                  when={diffRows().length > 0}
                  fallback={<text fg={t().muted}>{target().task.childChatId ? "The worker's chat recorded no file changes, or its chat has closed since." : "This worker has no chat of its own to read changes from."}</text>}
                >
                  <scrollbox ref={(el) => (scroller = el as ScrollBoxRenderable)} flexGrow={1} verticalScrollbarOptions={{ visible: false }}>
                    <For each={diffRows()}>
                      {(diffRow) => {
                        if (diffRow.kind === "file") {
                          return (
                            <text wrapMode="none" truncate marginTop={1}>
                              <b style={{ fg: t().text }}>{diffRow.path}</b>
                              <span style={{ fg: t().ok }}>{`  +${diffRow.added}`}</span>
                              <span style={{ fg: t().danger }}>{` −${diffRow.removed}`}</span>
                            </text>
                          );
                        }
                        if (diffRow.kind === "edit") return <text fg={t().muted}>{`  ${diffRow.label}`}</text>;
                        const line = diffRow.line;
                        const tone = line.kind === "add" ? t().ok : line.kind === "del" ? t().danger : t().text2;
                        return (
                          <text wrapMode="none" truncate fg={tone}>
                            {`${line.line !== undefined ? String(line.line).padStart(5) : "     "} ${line.kind === "hunk" || line.kind === "gap" ? clip(line.text || "⋯", width() - 10) : `${SIGN[line.kind]} ${line.text}`}`}
                          </text>
                        );
                      }}
                    </For>
                  </scrollbox>
                </Show>
              </Show>
            </box>
          </box>
        )}
      </Show>
      <Show when={writing()}>
        <box flexDirection="row" flexShrink={0} marginTop={1} border={["top"]} borderColor={t().border}>
          <text flexShrink={0} fg={t().muted}>Review note: </text>
          <input
            focused
            flexGrow={1}
            placeholder="Optional, sent with apply or keep: Enter saves, Esc drops"
            textColor={t().text}
            backgroundColor={t().surface}
            focusedBackgroundColor={t().surface}
            value={note()}
            onInput={(value: string) => setNote(value)}
          />
        </box>
      </Show>
      <text flexShrink={0} fg={error() ? t().danger : confirming() ? t().warn : t().muted} marginTop={1} wrapMode="word">
        {error() ??
          (confirming()
            ? `${confirming()?.label}? y confirms · any other key cancels`
            : busy()
              ? "Working…"
              : row()
                ? "↑↓ scroll · a apply · k keep · u undo apply · d remove worktree · n note · o open chat · x cancel · Esc back"
                : "↑↓ worker · Enter opens · o open its chat · x cancel · Esc closes")}
      </text>
    </box>
  );
}
