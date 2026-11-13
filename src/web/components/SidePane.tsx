// A chat beside the main one (T3 Code's split view): to watch two runs at
// once, or set two harnesses the same task. It has its own stream (the URL
// still names the main chat), its conversation, and its composer: send,
// steer, stop, answer, model and thinking, handoff. What branches a chat
// (Fork, Undo, Edit or Retry where the harness cannot replace a prompt in
// place) is the main pane's: Make main swaps the two. Empty, it lists the
// sessions to pick one from.
import { useEffect, useMemo, useRef, useState } from "react";
import { plainTitle } from "../plain-title.js";
import type { ChatSnapshot, HarnessStatus, ProjectSession, SessionsOverview, UsageLimits } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { projectScoped } from "../harness-policy.js";
import { chatActions } from "../chat-actions.js";
import { StatusWord } from "./StatusWord.js";
import { STATUS_LABEL, useChatStream } from "../chat-stream.js";
import type { ChatState } from "../chat-state.js";
import { harnessColor } from "../harness-colors.js";
import { IconSearch, IconSwap, IconX, Spinner } from "../icons.js";
import { sentAttachments } from "../images.js";
import { isBusy } from "../session-groups.js";
import { ago } from "../turns.js";
import { Composer } from "./Composer.js";
import { Conversation } from "./Conversation.js";
import { Dot, dotted } from "./Dot.js";
import { LineageChip } from "./LineageChip.js";

/** Sessions the picker lists at first; a search reaches the rest. */
const PICKS = 30;

function Picker({
  overview,
  harnesses,
  taken,
  onPick,
}: {
  overview: SessionsOverview;
  harnesses: HarnessStatus[];
  /** The main chat's session: it is already on screen. */
  taken: { chatId: string | null; sessionId: string | null };
  onPick: (s: ProjectSession) => void;
}) {
  const [query, setQuery] = useState("");
  const name = (id: string) => harnesses.find((h) => h.id === id)?.displayName ?? id;
  const project = (id: string) => overview.workspaces.find((w) => w.id === id)?.name ?? "";
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    const live = (s: ProjectSession) => (s.liveChatId ? (isBusy(s.status ?? "idle") ? 0 : 1) : 2);
    return overview.sessions
      .filter((s) => projectScoped(harnesses, s.harnessId) && !s.archived && (!q || `${s.title} ${name(s.harnessId)} ${project(s.workspaceId)}`.toLowerCase().includes(q)))
      .sort((a, b) => live(a) - live(b) || (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, q ? 80 : PICKS);
  }, [overview, query]);
  return (
    <div className="side-picker">
      <h2>Open a chat beside</h2>
      <p className="muted">Watch two runs at once, or give two harnesses the same task.</p>
      <label className="side-picker-search">
        <IconSearch size={14} />
        <input type="search" autoFocus aria-label="Find a chat to open beside" placeholder="Find a chat…" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <ul className="side-picker-list" aria-label="Chats">
        {list.map((s) => {
          const here = (taken.sessionId !== null && s.id === taken.sessionId) || (s.liveChatId !== undefined && s.liveChatId === taken.chatId);
          return (
            <li key={s.id} style={harnessColor(s.harnessId)}>
              <button type="button" disabled={here} title={here ? "Already open on the left" : undefined} onClick={() => onPick(s)}>
                <span className={`side-pick-dot${s.liveChatId ? (isBusy(s.status ?? "idle") ? " is-busy" : " is-live") : ""}`} aria-hidden="true" />
                <span className="side-pick-title">{s.title || "New chat"}</span>
                <span className="side-pick-meta">
                  <span className="badge badge-harness">{name(s.harnessId)}</span>
                  {dotted([project(s.workspaceId), s.updatedAt ? ago(Date.parse(s.updatedAt)) : null])}
                </span>
              </button>
            </li>
          );
        })}
        {list.length === 0 ? <li className="side-picker-none muted">No chat matches</li> : null}
      </ul>
    </div>
  );
}

export function SidePane({
  initial,
  generation,
  overview,
  harnesses,
  maxChars,
  limits,
  main,
  draftRef,
  openSnapshot,
  onMakeMain,
  onOpenChat,
  onClose,
  onSignedOut,
}: {
  /** A chat to show at once (Open beside); none: the picker. */
  initial: ChatSnapshot | null;
  /** Bumped each time `initial` is handed over again; with a null `initial` it returns the pane to its picker. */
  generation: number;
  overview: SessionsOverview;
  harnesses: HarnessStatus[];
  maxChars: number;
  limits: UsageLimits | null;
  main: { chatId: string | null; sessionId: string | null; snapshot: ChatSnapshot | null };
  /** Register the still-mounted side editor's bounded draft save handler. */
  draftRef: { current: (() => void) | null };
  /** A session's chat, live or resumed (App's fetchSession). */
  openSnapshot: (s: ProjectSession) => Promise<ChatSnapshot>;
  /** Swap: this chat to the main pane (and the main one here). */
  onMakeMain: (chat: ChatState) => void;
  /** Show another chat by id: a delegated child's parent, from its header's chip. */
  onOpenChat: (chatId: string) => void;
  onClose: () => void;
  onSignedOut: () => void;
}) {
  const { chat, setChat, conn } = useChatStream({ onSignedOut, hash: false });
  const [opening, setOpening] = useState<ProjectSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A slow earlier pick must not replace the chat the user picked next.
  const picking = useRef(0);
  useEffect(() => {
    if (initial) setChat(initial);
    else {
      picking.current += 1;
      setOpening(null);
      setChat(null);
    }
  }, [initial, generation]);
  useEffect(() => () => void (picking.current += 1), []);

  const pick = async (s: ProjectSession) => {
    const seq = ++picking.current;
    setOpening(s);
    setError(null);
    try {
      const snapshot = await openSnapshot(s);
      if (seq === picking.current) setChat(snapshot);
    } catch (e) {
      if (seq === picking.current) setError(errorText(e));
    } finally {
      if (seq === picking.current) setOpening(null);
    }
  };
  const clear = () => {
    picking.current += 1;
    setOpening(null);
    setChat(null);
  };

  const fail = (e: unknown) => setError(errorText(e));
  const actions = chat ? chatActions(chat, setChat, { fail, onReplaced: (next) => setChat(next) }) : null;
  const harness = chat ? harnesses.find((h) => h.id === chat.harnessId) : undefined;
  const hasPrompt = chat ? chat.items.some((i) => i.kind === "user") : false;
  // In place (Hermes, Pi and omp through /rewind-to): Edit and Retry work here. Otherwise the main pane branches.
  const inPlace = chat?.capabilities.supportsRewind ?? false;
  const rewind = async (through: number, images: Awaited<ReturnType<typeof sentAttachments>>, text: string): Promise<boolean> => {
    if (!chat) return false;
    try {
      await api(`/api/chats/${chat.chatId}/rewind`, { body: { turn: through, text, ...(images.length > 0 ? { images } : {}) } });
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  return (
    <section className="side-pane" data-pane="side" aria-label="Chat beside">
      <header className="side-head">
        {chat ? (
          <div className="side-title">
            <h2 title={plainTitle(chat.title || "New chat")}>{plainTitle(chat.title || "New chat")}</h2>
            <div className="chat-sub">
              <span className="badge badge-harness" style={harnessColor(chat.harnessId)}>
                {harness?.displayName ?? chat.harnessId}
              </span>
              <span className={`status status-${chat.status}`} data-testid="side-status">
                <StatusWord text={STATUS_LABEL[chat.status] ?? chat.status} />
              </span>
              {chat.lineage ? <LineageChip lineage={chat.lineage} onOpen={onOpenChat} /> : null}
              {conn !== "connected" && conn !== "connecting" ? <span className="muted">
                  <Dot />
                  {conn}
                </span> : null}
              <span className="chat-path">{chat.workspace.name}</span>
            </div>
          </div>
        ) : (
          <div className="side-title">
            <h2>Beside</h2>
          </div>
        )}
        {chat ? (
          <button type="button" className="btn btn-small btn-ghost" onClick={() => onMakeMain(chat)} title="Swap: this chat on the left, the left one here">
            <IconSwap size={14} /> Make main
          </button>
        ) : null}
        {chat ? (
          <button type="button" className="icon-btn" aria-label="Pick another chat beside" title="Pick another chat" onClick={clear}>
            <IconSearch size={15} />
          </button>
        ) : null}
        <button type="button" className="icon-btn" aria-label="Close the chat beside" onClick={onClose}>
          <IconX size={15} />
        </button>
      </header>
      {error ? (
        <div className="banner banner-error" role="alert">
          <span>{error}</span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      ) : null}
      <div className="side-body">
        {opening ? (
          <p className="side-opening muted">
            <Spinner size={13} /> Opening {opening.title || "the chat"}…
          </p>
        ) : !chat ? (
          <Picker overview={overview} harnesses={harnesses} taken={main} onPick={(s) => void pick(s)} />
        ) : (
          <>
            {hasPrompt ? (
              <Conversation
                chatId={chat.chatId}
                items={chat.items}
                status={chat.status}
                workspace={chat.workspace.path}
                canFork={false}
                onFork={() => undefined}
                models={chat.config.models}
                checkpoints={[]}
                onRestore={() => undefined}
                onSend={(text) => void actions?.send(text, "normal")}
                asking={chat.pending.length > 0}
                pane="side"
                promptActions={{
                  inPlace,
                  retry: (through, item) => {
                    if (!inPlace) return onMakeMain(chat);
                    void (item.images?.length ? sentAttachments(item.images) : Promise.resolve([])).then((images) => rewind(through, images, item.text));
                  },
                  edit: async (through, item, text) => {
                    if (!inPlace) {
                      onMakeMain(chat);
                      return false;
                    }
                    return rewind(through, item.images?.length ? await sentAttachments(item.images) : [], text);
                  },
                }}
              />
            ) : (
              <div className="side-empty">
                <p className="muted">What should {harness?.displayName ?? "the agent"} do here?</p>
              </div>
            )}
            {actions ? (
              <Composer
                key={chat.chatId}
                draftTransfer={draftRef}
                side
                chat={chat}
                harnesses={harnesses}
                maxChars={maxChars}
                onSend={actions.send}
                onRefreshModels={actions.refreshModels}
                onStop={actions.stop}
                onAnswer={actions.answer}
                onConfig={actions.configure}
                onHandoff={actions.handoff}
                limits={limits}
              />
            ) : null}
          </>
        )}
      </div>
    </section>
  );
}
