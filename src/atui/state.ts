// atui's state and actions: the same things the web App holds and does
// (bootstrap, the session list, the shown chat and its event stream, limits,
// git, the open tabs), as Solid signals, talking to the server through
// client.ts. Tabs are the web UI's (web/tabs.ts): a chat opened takes over the
// shown tab unless asked for a new one, a tab switched away from keeps its
// chat to come back to at once, and a run that finishes in a tab not shown
// marks it.
import { batch, createEffect, createMemo, createSignal, on, untrack } from "solid-js";
import type {
  Bootstrap,
  ChatEvent,
  ChatSnapshot,
  CheckpointPreview,
  CheckpointRestored,
  GitStatus,
  ImageAttachment,
  InteractionAnswer,
  ProjectSession,
  RunResult,
  RunShell,
  SendMode,
  SessionPreview,
  SessionsOverview,
  ThemeInfo,
  UsageLimits,
  UsageReport,
  UserItem,
  WorkspaceInfo,
} from "../shared/protocol.js";
import { IMAGE_MIME_TYPES } from "../shared/protocol.js";
import { applyEvents, type ChatState } from "../web/chat-state.js";
import type { ReviewAnchor, ReviewSendResult, ReviewThread } from "../shared/protocol.js";
import { closeTab as closeTabIn, findTab, markUnread, NO_TABS, placeChat, placeTab, runningChats, syncActive, type Tab, type TabState } from "../web/tabs.js";
import { appCommand } from "../web/commands.js";
import { isBusy } from "../web/session-groups.js";
import { newsBetween, type News } from "./assist.js";
import { imageModeFrom, imageProtocol, type ImageMode } from "./images.js";
import { followChat, idempotencyKey, Server, ServerError, type Connection } from "./client.js";
import { themeFrom, type Theme } from "./theme.js";

export interface AtuiOptions {
  cwd: string;
  harness?: string;
  /** Attach to a live chat. */
  chatId?: string;
  /** Resume a session: its id, or true for the project's newest one in the harness. */
  resume?: string | true;
  /** Vim navigation, when the command line says (else the remembered choice). */
  vim?: boolean;
  /** How prompt images are drawn (--images); else $ATUI_IMAGES, else asked of the terminal. */
  images?: ImageMode;
  /** No fills behind the transcript, composer, and status line (the remembered choice, else off). */
  glass?: boolean;
  /** Tell the desktop (a terminal notification) that a background session finished or asks; none in tests. */
  notify?: (title: string, body: string) => void;
  /** false (--no-herdr): in a herdr pane, report nothing to herdr (main.tsx does the reporting). */
  herdr?: boolean;
}

/** A toast in the corner: a background session's news, for a few seconds. */
export interface Toast extends News {
  id: number;
}

const TOAST_MS = 6000;
/** Context samples kept for the status line's sparkline. */
const CONTEXT_SAMPLES = 24;

export type Banner = { level: "info" | "warning" | "error"; text: string } | null;

const SESSIONS_MS = 4000;
/** A session open in herdr opened a second time within this resumes here anyway. */
const HERDR_AGAIN_MS = 10_000;
const LIMITS_MS = 5 * 60_000;
const GIT_WORKING_MS = 8000;

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createAtui(server: Server, opts: AtuiOptions) {
  const [boot, setBoot] = createSignal<Bootstrap | null>(null);
  const [theme, setTheme] = createSignal<Theme>(themeFrom(null));
  const [harnessId, setHarnessId] = createSignal<string | null>(null);
  const [workspace, setWorkspace] = createSignal<WorkspaceInfo | null>(null);
  const [overview, setOverview] = createSignal<SessionsOverview>({ workspaces: [], sessions: [], errors: [] });
  const [chat, setChat] = createSignal<ChatState | null>(null);
  const [conn, setConn] = createSignal<Connection | "idle">("idle");
  const [limits, setLimits] = createSignal<UsageLimits | null>(null);
  const [git, setGit] = createSignal<GitStatus | null>(null);
  const [banner, setBanner] = createSignal<Banner>(null);
  /** A session being opened (or a chat being handed off), for the screen shown until it arrives. */
  const [opening, setOpening] = createSignal<{ title: string; harnessId: string } | null>(null);
  const [toasts, setToasts] = createSignal<Toast[]>([]);
  const [contextHistory, setContextHistory] = createSignal<number[]>([]);
  const [glass, setGlass] = createSignal(opts.glass ?? false);
  const [tabs, setTabs] = createSignal<TabState>(NO_TABS);
  /** Each tab's chat as last shown, by tab key: a switch back shows it at once, and its stream replays what it missed. */
  const tabCache = new Map<string, ChatState>();
  /** The protocol prompt images are drawn with, or null when they are off. */
  const imageMode = imageProtocol(opts.images ?? imageModeFrom(undefined, process.env), process.env);

  const fail = (error: unknown) => setBanner({ level: "error", text: message(error) });
  const harness = createMemo(() => boot()?.harnesses.find((h) => h.id === (chat()?.harnessId ?? harnessId())) ?? null);
  const busy = createMemo(() => isBusy(chat()?.status));

  // ---- the shown chat's stream: events coalesced into one update per frame --------------

  let stopStream: (() => void) | null = null;
  let queued: ChatEvent[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  /** Keep the shown tab's chat, to come back to it. */
  const remember = () => {
    const { tabs: list, active } = tabs();
    const shown = chat();
    const tab = list[active];
    if (shown && tab && tab.chatId === shown.chatId) tabCache.set(tab.key, shown);
  };

  const show = (snapshot: ChatSnapshot, { newTab = false }: { newTab?: boolean } = {}) => {
    remember();
    setTabs((st) => placeChat(st, snapshot, { newTab }));
    follow(snapshot);
  };

  /**
   * Show a chat and stream it from where its snapshot left off; a tab's cached
   * chat (`fresh`) shows at once and is replaced by the server's snapshot.
   */
  const follow = (snapshot: ChatState, { fresh = false }: { fresh?: boolean } = {}) => {
    stopStream?.();
    queued = [];
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = null;
    batch(() => {
      setChat(snapshot);
      setWorkspace(snapshot.workspace);
      setGit(null);
      setBanner(null);
    });
    const chatId = snapshot.chatId;
    stopStream = followChat(server, chatId, fresh ? null : snapshot.lastEventId, {
      onEvent: (event) => {
        queued.push(event);
        flushTimer ??= setTimeout(() => {
          flushTimer = null;
          const events = queued;
          queued = [];
          setChat((prev) => (prev && prev.chatId === chatId ? applyEvents(prev, events) : prev));
        }, 16);
      },
      onState: setConn,
      onGone: (status) => {
        setChat((prev) => (prev && prev.chatId === chatId ? { ...prev, status: "disposed", gone: status === 401 ? "Sign-in needed" : "This chat was closed" } : prev));
      },
    });
    void refreshGit();
  };

  // ---- loading --------------------------------------------------------------------------

  let lastSessions: ProjectSession[] | null = null;
  let busyBefore = new Set<string>();
  let toastId = 0;
  const toastTimers = new Set<ReturnType<typeof setTimeout>>();
  const dismissToast = (id: number) => setToasts((list) => list.filter((x) => x.id !== id));

  /** A background session finished, failed, or asks: a toast, and the desktop's own notification. */
  const announce = (news: News[]) => {
    for (const n of news) {
      const toast = { ...n, id: ++toastId };
      setToasts((list) => [...list.slice(-2), toast]);
      const timer = setTimeout(() => {
        toastTimers.delete(timer);
        dismissToast(toast.id);
      }, TOAST_MS);
      toastTimers.add(timer);
      opts.notify?.(n.kind === "asking" ? "Needs you" : n.kind === "failed" ? "Failed" : "Done", n.title);
    }
  };

  const refreshSessions = async () => {
    try {
      const ws = workspace();
      const next = await server.call<SessionsOverview>(`/api/sessions${ws ? `?path=${encodeURIComponent(ws.path)}` : ""}`);
      announce(newsBetween(lastSessions, next.sessions, chat()?.sessionId ?? null));
      lastSessions = next.sessions;
      setOverview(next);
      // A tab not shown whose run just finished gets a mark.
      const busyNow = runningChats(next.sessions);
      const finished = new Set([...busyBefore].filter((id) => !busyNow.has(id) && id !== chat()?.chatId));
      busyBefore = busyNow;
      setTabs((st) => markUnread(st, finished));
    } catch {
      // keep the last list
    }
  };

  const refreshLimits = async () => {
    try {
      setLimits(await server.call<UsageLimits>("/api/limits"));
    } catch {
      // the panel keeps what it had
    }
  };

  const refreshGit = async () => {
    const c = chat();
    if (!c) return setGit(null);
    try {
      const res = await server.call<{ status: GitStatus | null }>(`/api/chats/${c.chatId}/git`);
      if (chat()?.chatId === c.chatId) setGit(res.status);
    } catch {
      // keep what is shown
    }
  };

  const timers: Array<ReturnType<typeof setInterval>> = [];

  const init = async () => {
    const b = await server.call<Bootstrap>("/api/bootstrap");
    // A web-only harness (the awui chat surface) never appears in a terminal.
    b.harnesses = b.harnesses.filter((h) => !h.capabilities.webOnly);
    const t = await server.call<ThemeInfo>("/api/theme").catch(() => null);
    batch(() => {
      setBoot(b);
      setTheme(themeFrom(t));
    });
    const wanted = opts.harness ? b.harnesses.find((h) => h.id === opts.harness || h.displayName.toLowerCase() === opts.harness?.toLowerCase()) : undefined;
    if (opts.harness && !wanted) throw new Error(`No harness "${opts.harness}"; known: ${b.harnesses.map((h) => h.id).join(", ")}`);
    const pick = wanted ?? b.harnesses.find((h) => h.available);
    if (pick) setHarnessId(pick.id);
    try {
      setWorkspace(await server.call<WorkspaceInfo>("/api/workspaces/open", { body: { path: opts.cwd } }));
    } catch (error) {
      setBanner({ level: "warning", text: `${message(error)}: pick a session from the list, or start atui in a project folder` });
    }
    await refreshSessions();
    if (opts.chatId) show(await server.call<ChatSnapshot>(`/api/chats/${encodeURIComponent(opts.chatId)}`));
    else if (opts.resume) {
      const ws = workspace();
      const target =
        opts.resume === true
          ? overview().sessions.find((s) => s.harnessId === harnessId() && s.workspaceId === ws?.id)
          : overview().sessions.find((s) => s.id === opts.resume || s.id.endsWith(`:${opts.resume}`));
      if (!target) throw new Error(opts.resume === true ? "No session to resume in this project" : `No session "${opts.resume}"`);
      await openSession(target);
    }
    void refreshLimits();
    timers.push(
      setInterval(() => void refreshSessions(), SESSIONS_MS),
      setInterval(() => void refreshLimits(), LIMITS_MS),
      setInterval(() => {
        if (busy()) void refreshGit();
      }, GIT_WORKING_MS),
    );
  };

  // What the effects below follow, as memos: `on()` runs again whenever its source's signals change, and the
  // chat signal changes with every streamed event, so each must see a value that changes only when the thing does.
  // (Read straight from chat(), the sparkline's history was emptied on every event, and the list's refresh was
  // pushed back by each one, never running while a run streamed.)
  const chatId = createMemo(() => chat()?.chatId);
  const listKey = createMemo(() => {
    const c = chat();
    return c ? `${c.chatId}:${isBusy(c.status)}:${c.title}:${c.sessionId}` : "";
  });
  const tabKey = createMemo(() => {
    const c = chat();
    return c ? `${c.chatId}:${c.title}:${c.sessionId}` : "";
  });
  const contextPercent = createMemo(() => chat()?.context?.percent ?? null);

  // The list follows the shown chat: a run starting or settling, a new title, a session id.
  let listTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      listKey,
      (key) => {
        if (!key) return;
        clearTimeout(listTimer);
        listTimer = setTimeout(() => void refreshSessions(), 400);
      },
    ),
  );

  // The context share over this chat's life, for the status line's sparkline.
  createEffect(on(chatId, () => setContextHistory([])));
  createEffect(
    on(
      contextPercent,
      (percent) => {
        if (percent === null) return;
        setContextHistory((h) => (h[h.length - 1] === percent ? h : [...h, percent].slice(-CONTEXT_SAMPLES)));
      },
    ),
  );

  // ---- lookups for the composer and pickers ---------------------------------------------

  /** Files in the project for an @mention, best first. */
  const searchFiles = async (query: string): Promise<string[]> => {
    const ws = workspace();
    if (!ws) return [];
    try {
      return (await server.call<{ files: string[] }>(`/api/workspaces/${encodeURIComponent(ws.id)}/files?q=${encodeURIComponent(query)}`)).files;
    } catch {
      return [];
    }
  };

  /** Usage across chats over the last `days` days, by the terminal's own days (the web UI's dialog asks the same route). Rejects with the server's message. */
  const usageReport = (days: number): Promise<UsageReport> => server.call<UsageReport>(`/api/usage?days=${days}&tz=${new Date().getTimezoneOffset()}`);

  const previews = new Map<string, Promise<SessionPreview | null>>();
  /** A session's last exchange for the history picker; asked once per session while atui runs. */
  const preview = (s: ProjectSession): Promise<SessionPreview | null> => {
    const key = `${s.id}@${s.updatedAt ?? ""}`;
    let hit = previews.get(key);
    if (!hit) {
      const q = new URLSearchParams({ harnessId: s.harnessId, workspaceId: s.workspaceId, sessionId: s.id });
      hit = server.call<SessionPreview>(`/api/sessions/preview?${q}`).catch(() => null);
      previews.set(key, hit);
    }
    return hit;
  };

  const images = new Map<string, Promise<Uint8Array | null>>();
  /** A prompt's image bytes, fetched once. */
  const image = (id: string): Promise<Uint8Array | null> => {
    let hit = images.get(id);
    if (!hit) {
      hit = server.bytes(`/api/images/${encodeURIComponent(id)}`);
      images.set(id, hit);
    }
    return hit;
  };

  // ---- actions ----------------------------------------------------------------------------

  const enterWorkspace = async (ws: WorkspaceInfo): Promise<WorkspaceInfo> => {
    if (ws.id === workspace()?.id) return ws;
    const opened = await server.call<WorkspaceInfo>("/api/workspaces/open", { body: { path: ws.path } });
    setWorkspace(opened);
    return opened;
  };

  // ---- tabs ----------------------------------------------------------------------------

  /** The shown tab's title and session follow its chat. */
  createEffect(
    on(
      tabKey,
      () => {
        const c = untrack(chat);
        if (c) setTabs((st) => syncActive(st, c));
      },
    ),
  );

  /** Bring tab `index` to the front: its cached chat at once, else the live chat, else its session resumed. */
  const switchTab = async (index: number) => {
    const st = tabs();
    const tab = st.tabs[index];
    if (!tab || index === st.active) return;
    remember();
    setTabs({ active: index, tabs: st.tabs.map((t, i) => (i === index && t.unread ? { ...t, unread: undefined } : t)) });
    const cached = tabCache.get(tab.key);
    if (cached && cached.chatId === tab.chatId && cached.status !== "disposed") return follow(cached, { fresh: true });
    if (!tab.chatId && !tab.sessionId) return blank();
    setOpening({ title: tab.title, harnessId: tab.harnessId });
    try {
      if (tab.chatId) {
        try {
          return follow(await server.call<ChatSnapshot>(`/api/chats/${tab.chatId}`));
        } catch (error) {
          if (!(error instanceof ServerError && error.status === 404) || !tab.sessionId) throw error;
        }
      }
      const ws = await server.call<WorkspaceInfo>("/api/workspaces/open", { body: { path: tab.workspacePath } });
      const snapshot = await server.call<ChatSnapshot>("/api/chats/resume", { body: { harnessId: tab.harnessId, workspaceId: ws.id, sessionId: tab.sessionId } });
      // The resumed chat has a new id: the tab follows it.
      setTabs((now) => ({ ...now, tabs: now.tabs.map((t) => (t.key === tab.key ? { ...t, chatId: snapshot.chatId } : t)) }));
      follow(snapshot);
    } catch (error) {
      fail(error);
    } finally {
      setOpening(null);
    }
  };

  /** Close tab `index`; closing the shown one shows its neighbour, or an empty new chat when it was the last. */
  const closeTab = (index: number) => {
    const before = tabs();
    const closing = before.tabs[index];
    if (!closing) return;
    tabCache.delete(closing.key);
    const after = closeTabIn(before, index);
    if (index !== before.active) return setTabs(after);
    // Nothing shown for a moment, so the switch below does not take the closed tab for the shown one.
    setTabs({ ...after, active: -1 });
    if (after.tabs[after.active]) void switchTab(after.active);
    else blank();
  };

  const stepTab = (by: 1 | -1) => {
    const { tabs: list, active } = tabs();
    if (list.length < 2) return;
    void switchTab((active + by + list.length) % list.length);
  };

  /** A session a herdr pane runs, opened once: opening it again soon after resumes it here anyway. */
  let herdrAsked: { id: string; at: number } | null = null;

  const openSession = async (s: ProjectSession, { newTab = false }: { newTab?: boolean } = {}) => {
    const open = findTab(tabs(), { chatId: s.liveChatId ?? null, sessionId: s.id });
    if (open >= 0) return switchTab(open);
    const target = overview().workspaces.find((w) => w.id === s.workspaceId);
    // Its harness runs in a herdr pane: show that pane, since a resume here would be a second writer on the session.
    const again = herdrAsked !== null && herdrAsked.id === s.id && Date.now() - herdrAsked.at < HERDR_AGAIN_MS;
    if (s.herdr && !s.liveChatId && !again) {
      herdrAsked = { id: s.id, at: Date.now() };
      const shown = await server.call("/api/herdr/focus", { body: { paneId: s.herdr.paneId } }).then(
        () => true,
        () => false,
      );
      const name = boot()?.harnesses.find((h) => h.id === s.harnessId)?.displayName ?? s.harnessId;
      setBanner({
        level: "warning",
        text: `${shown ? "Shown" : "Open"} in herdr, pane ${s.herdr.paneId} (${s.herdr.status}). Open it again to run it here too: a second ${name} on the same session.`,
      });
      return;
    }
    herdrAsked = null;
    setOpening({ title: s.title || "New chat", harnessId: s.harnessId });
    try {
      if (s.liveChatId) {
        show(await server.call<ChatSnapshot>(`/api/chats/${s.liveChatId}`), { newTab });
      } else {
        if (!target) throw new Error("That session's project is not open on the server");
        const ws = await enterWorkspace(target);
        const body = { harnessId: s.harnessId, workspaceId: ws.id, sessionId: s.id, ...(again ? { ignoreHerdr: true } : {}) };
        show(await server.call<ChatSnapshot>("/api/chats/resume", { body }), { newTab });
      }
      void refreshSessions();
    } catch (error) {
      fail(error);
    } finally {
      setOpening(null);
    }
  };

  /** A new chat starts empty on screen; the server's chat is made on the first message. */
  /** Nothing on screen: an empty new chat, its server chat made on the first message. */
  const blank = () => {
    stopStream?.();
    stopStream = null;
    batch(() => {
      setChat(null);
      setConn("idle");
      setGit(null);
      setBanner(null);
    });
  };

  /** A new chat, in the shown tab (it takes the tab's place, as in the web UI) or, with `newTab`, a tab of its own. */
  const newChat = ({ newTab = false }: { newTab?: boolean } = {}) => {
    remember();
    const placeholder: Omit<Tab, "key"> = { chatId: null, sessionId: null, harnessId: harnessId() ?? "", workspacePath: workspace()?.path ?? "", title: "New chat" };
    setTabs((st) => (st.tabs.length === 0 ? st : placeTab(st, placeholder, { newTab })));
    blank();
  };

  const createChat = async (): Promise<ChatState> => {
    const ws = workspace();
    const h = harnessId();
    if (!ws) throw new Error("Start atui in a project folder, or open a session from the list");
    if (!h) throw new Error("No harness is available");
    const snapshot = await server.call<ChatSnapshot>("/api/chats", { body: { harnessId: h, workspaceId: ws.id } });
    show(snapshot);
    return snapshot;
  };

  /** The shown chat, made on the server first when there is none yet (to pick its model before the first message). */
  const ensureChat = async (): Promise<ChatState | null> => {
    const c = chat();
    if (c && c.status !== "disposed") return c;
    try {
      return await createChat();
    } catch (error) {
      fail(error);
      return null;
    }
  };

  const runAppCommand = async (c: ChatState | null, name: string, arg: string) => {
    if (name === "new") return newChat();
    if (!c) throw new Error(`/${name} needs a chat`);
    if (name === "compact") await server.call(`/api/chats/${c.chatId}/compact`, { body: arg ? { instructions: arg } : {} });
    else if (name === "rename") {
      if (!arg) throw new Error("/rename <title>");
      await server.call(`/api/chats/${c.chatId}/rename`, { body: { name: arg } });
    }
  };

  // The send attempt in flight: a retry of the same words and images reuses its idempotency key,
  // so a lost answer cannot post the prompt twice. An edit is a new attempt with a new key.
  let sendAttempt: { key: string; text: string; mode: SendMode; images: ImageAttachment[] } | null = null;

  /** Send what was typed: a normal message when idle, a steer (or follow-up) while the agent works. */
  const send = async (text: string, options: { compactFirst?: boolean; images?: ImageAttachment[] } = {}): Promise<boolean> => {
    const images = options.images ?? [];
    // Text stays required with images (some providers reject an empty text block).
    const value = text.trim() || (images.length > 0 ? "See the attached image" : "");
    if (!value) return false;
    try {
      const command = images.length === 0 ? appCommand(value) : null;
      if (command) {
        await runAppCommand(chat(), command.name, command.arg);
        return true;
      }
      const c = chat() && chat()?.status !== "disposed" ? (chat() as ChatState) : await createChat();
      let mode: SendMode = "normal";
      if (isBusy(c.status)) {
        if (c.status === "running" && c.capabilities.supportsSteer) mode = "steer";
        else if (c.status === "running" && c.capabilities.supportsFollowUp) mode = "followUp";
        else throw new Error("The agent is busy; wait, or stop it with Esc Esc");
      }
      const prior = sendAttempt;
      const retry = prior !== null && prior.text === value && prior.mode === mode && prior.images.length === images.length && prior.images.every((image, at) => image.data === images[at]?.data);
      const key = retry && prior ? prior.key : idempotencyKey();
      sendAttempt = { key, text: value, mode, images };
      await server.call(`/api/chats/${c.chatId}/messages`, {
        body: {
          text: value,
          mode,
          ...(images.length > 0 ? { images: images.map(({ mimeType, data }) => ({ mimeType, data })) } : {}),
          ...(mode === "normal" && options.compactFirst ? { compactFirst: true } : {}),
        },
        idempotencyKey: key,
      });
      sendAttempt = null;
      setBanner(null);
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const stop = () => {
    const c = chat();
    if (!c || !isBusy(c.status)) return;
    setChat((prev) => (prev && prev.chatId === c.chatId ? { ...prev, status: "stopping" } : prev));
    server.call(`/api/chats/${c.chatId}/abort`, { body: {} }).catch(fail);
  };

  const answer = async (requestId: string, a: InteractionAnswer, denialReason?: string) => {
    const c = chat();
    if (!c) return;
    try {
      await server.call(`/api/chats/${c.chatId}/requests/${encodeURIComponent(requestId)}`, { body: { answer: a, ...(denialReason ? { denialReason } : {}) } });
    } catch (error) {
      if (error instanceof ServerError && error.status === 409) {
        setChat((prev) => (prev ? { ...prev, pending: prev.pending.filter((p) => p.id !== requestId) } : prev));
        setBanner({ level: "info", text: message(error) });
      } else fail(error);
    }
  };

  const configure = async (patch: { model?: string; thinkingLevel?: string; permissionMode?: string }) => {
    const c = chat();
    if (!c) return;
    try {
      await server.call(`/api/chats/${c.chatId}/config`, { method: "PATCH", body: patch });
    } catch (error) {
      fail(error);
    }
  };

  const compact = async () => {
    const c = chat();
    if (!c) return;
    try {
      await server.call(`/api/chats/${c.chatId}/compact`, { body: {} });
    } catch (error) {
      fail(error);
    }
  };

  const chooseHarness = (id: string) => {
    setHarnessId(id);
    if (chat()) newChat();
  };

  /** Move the open chat to another harness: a copy of the conversation, or a summary its first prompt carries. */
  const handoff = async (id: string) => {
    const c = chat();
    if (!c) return chooseHarness(id);
    setOpening({ title: c.title || "New chat", harnessId: id });
    try {
      const moved = await server.call<ChatSnapshot>(`/api/chats/${c.chatId}/handoff`, { body: { harness: id } });
      setHarnessId(id);
      show(moved);
      void refreshSessions();
    } catch (error) {
      fail(error);
    } finally {
      setOpening(null);
    }
  };

  // ---- a past prompt: retry, edit, fork from it, put its files back ---------------------

  /** A prompt being edited in the composer: Enter replaces it (as the web UI's Edit does). */
  const [editing, setEditing] = createSignal<{ through: number; item: UserItem } | null>(null);
  /**
   * Review threads by chat, as the server holds them: the same ones the web
   * panel shows, read when the review opens. Every write asks the server and
   * keeps what it answers, so a resolve or a note lands for every device.
   */
  const [reviewThreads, setReviewThreads] = createSignal<Record<string, ReviewThread[]>>({});
  const reviewComments = (chatId: string): ReviewThread[] => reviewThreads()[chatId] ?? [];
  const putReviewThread = (chatId: string, thread: ReviewThread) =>
    setReviewThreads((all) => ({ ...all, [chatId]: [thread, ...(all[chatId] ?? []).filter((t) => t.id !== thread.id)] }));

  const loadReview = async (chatId: string): Promise<void> => {
    try {
      const body = await server.call<{ threads: ReviewThread[] }>(`/api/chats/${chatId}/review-threads`);
      setReviewThreads((all) => ({ ...all, [chatId]: body.threads }));
    } catch (error) {
      fail(error);
    }
  };
  const createReviewThread = async (chatId: string, anchor: ReviewAnchor, text: string): Promise<boolean> => {
    try {
      putReviewThread(chatId, await server.call<ReviewThread>(`/api/chats/${chatId}/review-threads`, { body: { anchor, text } }));
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };
  const replyReviewThread = async (chatId: string, threadId: string, text: string): Promise<boolean> => {
    try {
      putReviewThread(chatId, await server.call<ReviewThread>(`/api/chats/${chatId}/review-threads/${threadId}/notes`, { body: { text } }));
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };
  const resolveReviewThread = async (chatId: string, threadId: string, status: ReviewThread["status"]): Promise<boolean> => {
    try {
      putReviewThread(chatId, await server.call<ReviewThread>(`/api/chats/${chatId}/review-threads/${threadId}/status`, { body: { status } }));
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };
  const deleteReviewThread = async (chatId: string, threadId: string): Promise<boolean> => {
    try {
      await server.call(`/api/chats/${chatId}/review-threads/${threadId}`, { method: "DELETE" });
      setReviewThreads((all) => ({ ...all, [chatId]: (all[chatId] ?? []).filter((t) => t.id !== threadId) }));
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };
  /** The chat's open threads as one prompt, composed by the server; nothing is cleared afterwards. */
  const sendReview = async (chatId: string, stale: string[]): Promise<boolean> => {
    try {
      const result = await server.call<ReviewSendResult>(`/api/chats/${chatId}/review-threads/send`, { body: { target: { kind: "chat", chatId }, stale } });
      setBanner({ level: "info", text: `Sent ${result.sent} ${result.sent === 1 ? "comment" : "comments"} to this chat` });
      await loadReview(chatId);
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };
  /** The prompt whose files the Undo dialog offers to put back. */
  const [undoTurn, setUndoTurn] = createSignal<number | null>(null);
  /** The files a restore put back, to put back as they were again (C-x z). */
  const [putBackable, setPutBackable] = createSignal<{ chatId: string; tree: string; paths: string[] } | null>(null);

  /** A prompt's images, to go with it again. */
  const imagesOf = async (item: UserItem): Promise<ImageAttachment[]> => {
    const out: ImageAttachment[] = [];
    for (const ref of item.images ?? []) {
      if (!(IMAGE_MIME_TYPES as readonly string[]).includes(ref.mimeType)) continue;
      const bytes = await image(ref.id);
      if (bytes) out.push({ mimeType: ref.mimeType as ImageAttachment["mimeType"], data: Buffer.from(bytes).toString("base64") });
    }
    return out;
  };

  /**
   * Retry or edit prompt `through`: replaced in place where the harness can
   * (supportsRewind), else run in a branch from before it (a fork, or a fresh
   * chat for the first prompt) on the same model and thinking level, shown in
   * the same tab. The web UI's rerun, without the file undo.
   */
  const rerun = async (through: number, item: UserItem, text: string): Promise<boolean> => {
    const from = chat();
    if (!from) return false;
    try {
      const images = await imagesOf(item);
      const withImages = images.length > 0 ? { images } : {};
      if (from.capabilities.supportsRewind) {
        await server.call(`/api/chats/${from.chatId}/rewind`, { body: { turn: through, text, ...withImages } });
        return true;
      }
      const next =
        through > 1
          ? await server.call<ChatSnapshot>(`/api/chats/${from.chatId}/fork`, { body: { through: through - 1 } })
          : await server.call<ChatSnapshot>("/api/chats", { body: { harnessId: from.harnessId, workspaceId: from.workspace.id } });
      const patch: { model?: string; thinkingLevel?: string } = {};
      if (from.capabilities.supportsModelSelection && from.config.model && next.config.model !== from.config.model && next.config.models.some((m) => m.key === from.config.model)) patch.model = from.config.model;
      if (from.capabilities.supportsThinkingLevel && from.config.thinkingLevel && next.config.thinkingLevel !== from.config.thinkingLevel) patch.thinkingLevel = from.config.thinkingLevel;
      if (patch.model || patch.thinkingLevel) await server.call(`/api/chats/${next.chatId}/config`, { method: "PATCH", body: patch }).catch(() => undefined);
      show(next);
      await server.call(`/api/chats/${next.chatId}/messages`, { body: { text, mode: "normal", ...withImages } });
      setBanner({ level: "info", text: `Branched from before message ${through}; the original chat is still in the session list` });
      void refreshSessions();
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  /** A new session holding the chat through prompt `through`, opened in a tab of its own. */
  const fork = async (through: number) => {
    const c = chat();
    if (!c) return;
    try {
      show(await server.call<ChatSnapshot>(`/api/chats/${c.chatId}/fork`, { body: { through } }), { newTab: true });
      void refreshSessions();
    } catch (error) {
      fail(error);
    }
  };

  /** What putting the files back as they were before prompt `turn` would do. */
  const checkpointPreview = async (turn: number): Promise<CheckpointPreview | null> => {
    const c = chat();
    if (!c) return null;
    try {
      return await server.call<CheckpointPreview>(`/api/chats/${c.chatId}/checkpoints/${turn}`);
    } catch (error) {
      fail(error);
      return null;
    }
  };

  /** Put `paths` back as they were before prompt `turn`; C-x z can undo it. */
  const restoreFiles = async (turn: number, paths: string[]): Promise<boolean> => {
    const c = chat();
    if (!c || paths.length === 0) return false;
    try {
      const done = await server.call<CheckpointRestored>(`/api/chats/${c.chatId}/checkpoints/${turn}/restore`, { body: { paths } });
      setPutBackable({ chatId: c.chatId, tree: done.undo, paths: done.files.map((f) => f.path) });
      const n = done.files.length;
      setBanner({ level: "info", text: `Undid changes to ${n} ${n === 1 ? "file" : "files"} from message ${turn} on; the agent was not told · C-x z puts them back` });
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  const putBack = async () => {
    const p = putBackable();
    if (!p) return false;
    try {
      await server.call(`/api/chats/${p.chatId}/checkpoints/put-back`, { body: { tree: p.tree, paths: p.paths } });
      setPutBackable(null);
      setBanner({ level: "info", text: `Put ${p.paths.length} ${p.paths.length === 1 ? "file" : "files"} back as they were` });
      return true;
    } catch (error) {
      fail(error);
      return false;
    }
  };

  /** Run one command line from an answer in the chat's project (the web UI's Run on a code block). */
  const runCommand = async (command: string, shell: RunShell): Promise<RunResult | null> => {
    const c = chat();
    if (!c) return null;
    try {
      return await server.call<RunResult>(`/api/chats/${c.chatId}/run`, { body: { command, shell } });
    } catch (error) {
      fail(error);
      return null;
    }
  };

  const dispose = () => {
    stopStream?.();
    for (const timer of timers.splice(0)) clearInterval(timer);
    clearTimeout(listTimer);
    if (flushTimer) clearTimeout(flushTimer);
    for (const timer of toastTimers) clearTimeout(timer);
    toastTimers.clear();
  };

  return {
    server,
    boot,
    theme,
    harnessId,
    harness,
    workspace,
    tabs,
    switchTab,
    closeTab,
    stepTab,
    editing,
    setEditing,
    undoTurn,
    setUndoTurn,
    reviewComments,
    loadReview,
    createReviewThread,
    replyReviewThread,
    resolveReviewThread,
    deleteReviewThread,
    sendReview,
    runCommand,
    rerun,
    fork,
    checkpointPreview,
    restoreFiles,
    putBackable,
    putBack,
    overview,
    chat,
    conn,
    limits,
    git,
    banner,
    setBanner,
    opening,
    busy,
    toasts,
    dismissToast,
    glass,
    setGlass,
    imageMode,
    contextHistory,
    searchFiles,
    usageReport,
    preview,
    image,
    init,
    refreshSessions,
    refreshGit,
    refreshLimits,
    openSession,
    newChat,
    ensureChat,
    send,
    stop,
    answer,
    configure,
    compact,
    chooseHarness,
    handoff,
    dispose,
  };
}

export type Atui = ReturnType<typeof createAtui>;
