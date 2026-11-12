// Review: every file the agent edited or wrote in this chat, each edit's diff
// in order, and a thread of comments on any line. The threads live on the server
// (review-threads.ts), so they follow the line when the agent edits the file
// again, survive the chat being closed, and ride in the next batch until they are
// resolved. The panel only draws them and asks for changes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, errorText } from "../api.js";
import type { ChatItem, ChatSnapshot, ChatStatus, HarnessStatus, ProjectSession, ReviewSendResult, ReviewThread } from "../../shared/protocol.js";
import { IconCheck, IconX } from "../icons.js";
import { anchorOf, buildLineIndex, collectChanges, commentable, commentKey, placeThreads, reanchor, type PlacedThread, type ReviewComment } from "../review.js";
import { useAttribution } from "../attribution.js";
import { load, save } from "../storage.js";
import { FileLink } from "./FileLink.js";
import { DiffBadge, DiffView } from "./ToolBody.js";
import { Dot } from "./Dot.js";

/** The line an editor is open on: a new comment, or a reply in an existing thread. */
interface Composing {
  key: string;
  anchor: ReviewThread["anchor"];
  threadId?: string;
}

function NoteEditor({ initial, label, onSubmit, onCancel }: { initial: string; label: string; onSubmit: (text: string) => void; onCancel: () => void }) {
  const [text, setText] = useState(initial);
  return (
    <div className="review-note is-editing">
      <textarea
        className="input review-input"
        autoFocus
        rows={3}
        aria-label={label}
        placeholder="What should change here?"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onCancel();
          } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && text.trim()) {
            e.preventDefault();
            onSubmit(text);
          }
        }}
      />
      <div className="review-note-actions">
        <button type="button" className="btn btn-small" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn btn-small btn-primary" disabled={!text.trim()} onClick={() => onSubmit(text)}>
          {label}
        </button>
      </div>
    </div>
  );
}

/** How long ago a thread last went to an agent, in words. */
function sentAgo(at: number): string {
  const minutes = Math.max(1, Math.round((Date.now() - at) / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

export function ReviewPanel({
  chatId,
  items,
  workspace,
  workspaceId,
  harnessId,
  status,
  followUp,
  harnesses,
  onSent,
  onClose,
}: {
  chatId: string;
  items: ChatItem[];
  workspace: string;
  workspaceId: string;
  /** This chat's harness, the default for a new chat's picker. */
  harnessId: string;
  status: ChatStatus;
  /** Whether this chat takes a follow-up while it runs. */
  followUp: boolean;
  harnesses: HarnessStatus[];
  /** The chat that got the prompt, when it is not this one, so the app can show it. */
  onSent: (targetChatId: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const files = useMemo(() => collectChanges(items, workspace), [items, workspace]);
  // Which of these lines the agent wrote, and which have been changed outside this chat since.
  const origins = useAttribution(chatId, files);
  const storageKey = `review.${chatId}`;
  const threadsPath = `/api/chats/${chatId}/review-threads`;
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [composing, setComposing] = useState<Composing | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Sending is two steps: what goes (the footer's count) and where it goes.
  const [picking, setPicking] = useState(false);
  const [where, setWhere] = useState<"chat" | "new" | "session">("chat");
  const [newHarness, setNewHarness] = useState(harnessId);
  const [session, setSession] = useState("");
  const [chats, setChats] = useState<ProjectSession[] | null>(null);

  const fail = (e: unknown) => setError(errorText(e));
  const replace = (thread: ReviewThread) => setThreads((list) => [thread, ...list.filter((t) => t.id !== thread.id)]);

  /** The comments this device kept before threads: each becomes a thread, and the key is cleared once all are saved. */
  const migrate = useCallback(async () => {
    const legacy = load<ReviewComment[]>(storageKey, []);
    if (legacy.length === 0) return;
    let saved = 0;
    for (const comment of legacy) {
      if (!commentable(comment.line)) continue;
      try {
        await api<ReviewThread>(threadsPath, { body: { anchor: anchorOf(comment.path, comment.line), text: comment.text.trim() } });
        saved++;
      } catch (e) {
        // A pin another device already made is not a loss; anything else keeps the key for the next open.
        if (!(e instanceof ApiError) || e.code !== "duplicate") return;
      }
    }
    save(storageKey, null);
    if (saved > 0) setError(null);
  }, [storageKey, threadsPath]);

  const reload = useCallback(async () => {
    try {
      const body = await api<{ threads: ReviewThread[] }>(threadsPath);
      setThreads(body.threads);
    } catch (e) {
      fail(e);
    }
  }, [threadsPath]);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  useEffect(() => {
    void migrate().then(reload);
  }, [migrate, reload]);

  // A pin whose line moved comes back at its new number: one batched write per pass, and
  // the local copy follows at once so the next pass has nothing to send.
  useEffect(() => {
    const index = buildLineIndex(files);
    const moves: Array<{ id: string; line: number }> = [];
    for (const thread of threads) {
      // A removed line's number is the old file's: it stays where it was pinned (as the store keeps it).
      if (thread.anchor.side === "del") continue;
      const at = reanchor(thread.anchor, index);
      if (at !== "stale" && at.line !== null && at.line !== thread.anchor.line) moves.push({ id: thread.id, line: at.line });
    }
    if (moves.length === 0) return;
    const moved = new Map(moves.map((move) => [move.id, move.line]));
    setThreads((list) => list.map((t) => (moved.has(t.id) ? { ...t, anchor: { ...t.anchor, line: moved.get(t.id) ?? t.anchor.line } } : t)));
    // Best-effort: a failure leaves the pins where they are, and the next diff change tries again.
    void api(`${threadsPath}/reanchor`, { body: { moves } }).catch(() => undefined);
  }, [files, threads, threadsPath]);

  const { placed, detached } = useMemo(() => placeThreads(files, threads), [files, threads]);
  const open = threads.filter((t) => t.status === "open");
  const resolved = threads.filter((t) => t.status === "resolved");
  const busy = status !== "idle" && status !== "error";
  const staleIds = useMemo(() => new Set([...placed.values()].flat().concat(detached).filter((p) => p.stale).map((p) => p.thread.id)), [placed, detached]);
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);

  const createThread = async (c: Composing, text: string) => {
    setComposing(null);
    try {
      replace(await api<ReviewThread>(threadsPath, { body: { anchor: c.anchor, text: text.trim() } }));
      setError(null);
    } catch (e) {
      fail(e);
    }
  };

  const reply = async (threadId: string, text: string) => {
    setComposing(null);
    try {
      replace(await api<ReviewThread>(`${threadsPath}/${threadId}/notes`, { body: { text: text.trim() } }));
      setError(null);
    } catch (e) {
      fail(e);
    }
  };

  const setStatus = async (thread: ReviewThread, status: ReviewThread["status"]) => {
    try {
      replace(await api<ReviewThread>(`${threadsPath}/${thread.id}/status`, { body: { status } }));
      setError(null);
    } catch (e) {
      fail(e);
    }
  };

  const remove = async (thread: ReviewThread) => {
    try {
      await api(`${threadsPath}/${thread.id}`, { method: "DELETE" });
      setThreads((list) => list.filter((t) => t.id !== thread.id));
      setError(null);
    } catch (e) {
      fail(e);
    }
  };

  /** The chats of this project the picker offers: open ones, and sessions a resume would open. */
  const loadChats = async () => {
    if (chats !== null) return;
    try {
      const body = await api<{ sessions: ProjectSession[] }>("/api/sessions");
      setChats(body.sessions.filter((s) => s.workspaceId === workspaceId));
    } catch (e) {
      fail(e);
    }
  };

  /** The chat a "session" pick sends to: the live one, else the same session resumed here (one writer per session). */
  const sessionChat = async (): Promise<string> => {
    const chosen = (chats ?? []).find((c) => c.id === session);
    if (!chosen) throw new Error("Pick a chat to send to");
    if (chosen.liveChatId) return chosen.liveChatId;
    const resumed = await api<ChatSnapshot>("/api/chats/resume", { body: { harnessId: chosen.harnessId, sessionId: chosen.id, workspaceId } });
    return resumed.chatId;
  };

  /** Where the batch went, in words for the notice. */
  const describe = (id: string): string => {
    if (id === chatId) return "this chat";
    return (chats ?? []).find((c) => c.liveChatId === id || c.id === id)?.title ?? "a new chat";
  };

  const send = async () => {
    setSending(true);
    try {
      const target = where === "chat" ? chatId : where === "session" ? await sessionChat() : null;
      const stale = [...staleIds];
      // The prompt is composed server-side from the stored threads, so the batch and its marks cannot drift.
      const result = target
        ? await api<ReviewSendResult>(`${threadsPath}/send`, { body: { target: { kind: "chat", chatId: target }, stale } })
        : await api<ReviewSendResult>(`${threadsPath}/send`, { body: { target: { kind: "new", harnessId: newHarness }, stale } });
      setNotice(`Sent ${result.sent} ${result.sent === 1 ? "comment" : "comments"} to ${describe(result.targetChatId)}`);
      setPicking(false);
      setError(null);
      await reload();
      if (result.targetChatId !== chatId) onSent(result.targetChatId);
    } catch (e) {
      fail(e);
    } finally {
      setSending(false);
    }
  };

  const card = (entry: PlacedThread, key?: string) => (
    <ThreadCard
      key={entry.thread.id}
      entry={entry}
      replyOpen={composing?.threadId === entry.thread.id}
      onReply={() => setComposing({ key: key ?? composing?.key ?? "", anchor: entry.thread.anchor, threadId: entry.thread.id })}
      onStatus={(status) => void setStatus(entry.thread, status)}
      onDelete={() => void remove(entry.thread)}
      onSendReply={(text) => void reply(entry.thread.id, text)}
      onCancelReply={() => setComposing(null)}
    />
  );

  const visible = (entries: PlacedThread[] | undefined) => (entries ?? []).filter((e) => showResolved || e.thread.status === "open");
  return (
    <dialog
      ref={ref}
      className="review"
      aria-label="Review changes"
      onCancel={(e) => {
        e.preventDefault();
        if (composing) setComposing(null);
        else if (picking) setPicking(false);
        else onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="review-body">
        <header className="review-head">
          <div>
            <h2>Review changes</h2>
            <p className="muted">
              {files.length} {files.length === 1 ? "file" : "files"} <DiffBadge added={added} removed={removed} />
              <Dot />
              click a line to comment
            </p>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
            <IconX size={16} />
          </button>
        </header>
        {error ? (
          <p className="review-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="review-files">
          {files.length === 0 ? <p className="review-empty muted">The agent has not edited any files in this chat.</p> : null}
          {files.map((f) => (
            <section key={f.path} className="review-file" data-testid="review-file">
              <h3 className="review-path">
                <FileLink path={f.path}>
                  <code>{f.path}</code>
                </FileLink>
                <DiffBadge added={f.added} removed={f.removed} />
                {(() => {
                  const counts = origins.byPath.get(f.path);
                  if (!counts || counts.agent + counts.changed === 0) return null;
                  return (
                    <span className="review-attribution muted" data-testid="review-attribution" title="Lines this chat's edits wrote, and how many have changed since (marked with a dot in the gutter; a changed line gets an amber ring). Who changed a line outside this chat is not recorded here: an editor and a command of the agent's look the same">
                      {counts.agent} from this chat{counts.changed > 0 ? ` · ${counts.changed} changed since` : ""}
                    </span>
                  );
                })()}
              </h3>
              {f.edits.map(({ tool, turn }) => {
                if (!tool.diff) return null;
                const notes = new Map<number, React.ReactNode>();
                tool.diff.lines.forEach((line, i) => {
                  const key = commentKey(tool.id, i);
                  const cards = visible(placed.get(key));
                  const here = composing?.key === key;
                  if (cards.length === 0 && !here) return;
                  notes.set(
                    i,
                    <div className="review-threads" key="threads">
                      {cards.map((entry) => card(entry, key))}
                      {here && composing ? <NoteEditor key="new" initial="" label="Comment" onSubmit={(text) => void createThread(composing, text)} onCancel={() => setComposing(null)} /> : null}
                    </div>,
                  );
                });
                return (
                  <div key={tool.id} className="review-edit">
                    <div className="review-edit-head muted">
                      {turn > 0 ? (
                        <>
                          Turn {turn}
                          <Dot />
                        </>
                      ) : null}
                      {tool.name}
                    </div>
                    <DiffView
                      diff={tool.diff}
                      expanded
                      notes={notes}
                      origins={origins.byTool.get(tool.id)}
                      onLine={(i, line) => {
                        if (!commentable(line)) return;
                        const key = commentKey(tool.id, i);
                        const already = visible(placed.get(key))[0];
                        // A line that already has a thread opens its reply box; an empty one starts a comment.
                        if (already) setComposing({ key, anchor: already.thread.anchor, threadId: already.thread.id });
                        else setComposing({ key, anchor: anchorOf(f.path, line) });
                      }}
                    />
                  </div>
                );
              })}
            </section>
          ))}
          {visible(detached).length > 0 ? (
            <section className="review-file" data-testid="review-detached">
              <h3 className="review-path">
                <span>Lines these changes no longer show</span>
              </h3>
              <div className="review-threads">{visible(detached).map((entry) => card(entry))}</div>
            </section>
          ) : null}
        </div>
        {picking ? (
          <div className="review-send">
            <fieldset>
              <legend>Send {open.length} {open.length === 1 ? "comment" : "comments"} to</legend>
              <label>
                <input
                  type="radio"
                  name="review-target"
                  checked={where === "chat"}
                  disabled={busy && !followUp}
                  onChange={() => setWhere("chat")}
                />
                This chat
                <span className="muted">{busy ? (followUp ? " — it is working, so they queue as a follow-up" : " — wait until it is idle") : null}</span>
              </label>
              <label>
                <input type="radio" name="review-target" checked={where === "new"} onChange={() => { setWhere("new"); void loadChats(); }} />
                A new chat
                <select aria-label="New chat's harness" value={newHarness} onChange={(e) => setNewHarness(e.target.value)}>
                  {harnesses.filter((h) => h.available).map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <input type="radio" name="review-target" checked={where === "session"} onChange={() => { setWhere("session"); void loadChats(); }} />
                Another chat of this project
                <select aria-label="Chat to send to" value={session} onChange={(e) => setSession(e.target.value)}>
                  <option value="">{chats === null ? "Loading…" : "Choose a chat"}</option>
                  {(chats ?? []).map((c) => {
                    const blocked = c.status !== undefined && c.status !== "idle" && c.status !== "error" && !(harnesses.find((h) => h.id === c.harnessId)?.capabilities.supportsFollowUp ?? false);
                    return (
                      <option key={c.id} value={c.id} disabled={blocked}>
                        {c.title || "New chat"}
                        {c.status === "running" ? " · working" : c.liveChatId ? "" : " · resumes it"}
                      </option>
                    );
                  })}
                </select>
              </label>
            </fieldset>
            <div className="review-send-actions">
              <button type="button" className="btn btn-small" onClick={() => setPicking(false)}>
                Back
              </button>
              <button
                type="button"
                className="btn btn-small btn-primary"
                disabled={sending || (where === "session" && !session) || (where === "chat" && busy && !followUp)}
                onClick={() => void send()}
              >
                {sending ? "Sending…" : "Send"}
              </button>
            </div>
          </div>
        ) : null}
        <footer className="review-foot">
          <span className="muted" role="status">
            {open.length === 0 && resolved.length === 0 ? "No comments yet" : `${open.length} open`}
            {resolved.length > 0 ? ` · ${resolved.length} resolved` : null}
            {notice !== null ? ` · ${notice}` : null}
          </span>
          {resolved.length > 0 ? (
            <button type="button" className="btn btn-small" aria-pressed={showResolved} onClick={() => setShowResolved((on) => !on)}>
              {showResolved ? "Open only" : "All"}
            </button>
          ) : null}
          <button type="button" className="btn btn-small btn-primary" disabled={open.length === 0 || sending || picking} onClick={() => setPicking(true)}>
            {open.length === 1 ? "Send 1 comment" : `Send ${open.length} comments`}
          </button>
        </footer>
      </div>
    </dialog>
  );
}

function ThreadCard({
  entry,
  replyOpen,
  onReply,
  onStatus,
  onDelete,
  onSendReply,
  onCancelReply,
}: {
  entry: PlacedThread;
  replyOpen: boolean;
  onReply: () => void;
  onStatus: (status: ReviewThread["status"]) => void;
  onDelete: () => void;
  onSendReply: (text: string) => void;
  onCancelReply: () => void;
}) {
  const { thread, stale } = entry;
  const [note, ...replies] = thread.notes;
  if (thread.status === "resolved") {
    return (
      <div className="review-note is-resolved">
        <p>
          <IconCheck size={12} className="review-tick" />
          <s>{note?.text}</s>
          {replies.length > 0 ? <span className="muted"> +{replies.length}</span> : null}
        </p>
        <div className="review-note-actions">
          <button type="button" className="link-btn" onClick={() => onStatus("open")}>
            Reopen
          </button>
          <button type="button" className="link-btn" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="review-note">
      {note ? <p>{note.text}</p> : null}
      {replies.map((r, i) => (
        <p key={`${r.id}-${i}`} className="review-reply">
          {r.text}
        </p>
      ))}
      {stale ? <span className="review-stale">line changed since</span> : null}
      {replyOpen ? <NoteEditor initial="" label="Reply" onSubmit={onSendReply} onCancel={onCancelReply} /> : null}
      <div className="review-note-actions">
        {thread.lastSentAt !== undefined ? (
          <span className="muted review-sent" title={new Date(thread.lastSentAt).toLocaleString()}>
            sent {sentAgo(thread.lastSentAt)}
          </span>
        ) : null}
        <button type="button" className="link-btn" onClick={onReply}>
          Reply
        </button>
        <button type="button" className="link-btn" onClick={() => onStatus("resolved")}>
          Resolve
        </button>
        <button type="button" className="link-btn" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  );
}
