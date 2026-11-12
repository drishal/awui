// Review: every file the agent edited or wrote in this chat, each edit's diff
// in order, and a thread of comments on any line. The threads live on the server
// (review-threads.ts), so they follow the line when the agent edits the file
// again, survive the chat being closed, and ride in the next batch until they are
// resolved. The panel only draws them and asks for changes.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiError, api, errorText } from "../api.js";
import type { ChatItem, ReviewThread } from "../../shared/protocol.js";
import { IconCheck, IconX } from "../icons.js";
import { anchorOf, batchPrompt, buildLineIndex, collectChanges, commentable, commentKey, placeThreads, reanchor, type PlacedThread, type ReviewComment } from "../review.js";
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
  sendLabel,
  sendBlocked,
  onSend,
  onClose,
}: {
  chatId: string;
  items: ChatItem[];
  workspace: string;
  /** "Send", or "Send as follow-up" while the agent works. */
  sendLabel: string;
  /** Why the comments cannot go now. */
  sendBlocked: string | null;
  onSend: (prompt: string) => Promise<boolean>;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const files = useMemo(() => collectChanges(items, workspace), [items, workspace]);
  const storageKey = `review.${chatId}`;
  const threadsPath = `/api/chats/${chatId}/review-threads`;
  const [threads, setThreads] = useState<ReviewThread[]>([]);
  const [composing, setComposing] = useState<Composing | null>(null);
  const [showResolved, setShowResolved] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const send = async () => {
    setSending(true);
    const ok = await onSend(batchPrompt(threads, staleIds));
    setSending(false);
    if (ok) onClose();
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
        <footer className="review-foot">
          <span className="muted">
            {open.length === 0 && resolved.length === 0 ? "No comments yet" : `${open.length} open`}
            {resolved.length > 0 ? ` · ${resolved.length} resolved` : null}
          </span>
          {resolved.length > 0 ? (
            <button type="button" className="btn btn-small" aria-pressed={showResolved} onClick={() => setShowResolved((on) => !on)}>
              {showResolved ? "Open only" : "All"}
            </button>
          ) : null}
          <button type="button" className="btn btn-small btn-primary" disabled={open.length === 0 || sending || sendBlocked !== null} title={sendBlocked ?? undefined} onClick={() => void send()}>
            {open.length > 1 ? `Send ${open.length} comments` : sendLabel}
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
