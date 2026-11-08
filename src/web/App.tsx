// The app shell: bootstrap and sign-in, the tabs of open chats, the sidebar,
// the conversation and its header, the composer, and every dialog. It owns
// which chat is shown (the URL's #chat=, chat-stream.ts streams it over SSE)
// and which room (the URL's #room=, use-room-stream.ts streams it); rooms do
// not open as tabs. It hands each region its data and callbacks; the regions
// themselves live in components/ and draw from props. docs/ui.md maps which
// part is where.
import { openRoomHash, roomIdFromHash, TURN_STATUS_LABEL, useRoomStream } from "./use-room-stream.js";
import {
  answerRoomRequest as postRoomAnswer,
  cancelQueuedTurn as postCancelQueuedTurn,
  downloadRoomExport,
  fetchHistory,
  sendRoomMessage as postRoomMessage,
  stopRoom as postStopRoom,
  useBots,
  useRooms,
} from "./rooms.js";
import { oldestSeq } from "./room-state.js";
import { RoomView } from "./components/RoomView.js";
import { BotEditor } from "./components/BotEditor.js";
import { RoomEditor } from "./components/RoomEditor.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  SessionMarkState,
  ChatSnapshot,
  CheckpointPreview,
  CheckpointRestored,
  ConfigPatch,
  ImageAttachment,
  InteractionAnswer,
  RoomInfo,
  ModelInfo,
  ProjectSession,
  PushNote,
  SendMode,
  ServerSettings,
  ThemeChoice,
  UserItem,
  WorkspaceInfo,
} from "../shared/protocol.js";
import { api, ApiError, errorText } from "./api.js";
import { checkForNewBuild, rememberBuild, reloadApp, watchForNewBuild } from "./app-update.js";
import { useBanner } from "./banner.js";
import { useBootstrap } from "./bootstrap.js";
import type { ChatState } from "./chat-state.js";
import { StatusWord } from "./components/StatusWord.js";
import { chatIdFromHash, CONN_BANNER, setHash, STATUS_LABEL, useChatStream } from "./chat-stream.js";
import { appCommand } from "./commands.js";
import { mergeHarnesses, useHarnessRecheck } from "./harness-status.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { Composer } from "./components/Composer.js";
import { Conversation } from "./components/Conversation.js";
import { UpdateBanner } from "./components/UpdateBanner.js";
import { LimitsSummary } from "./components/LimitsMeter.js";
import { Loader } from "./components/Loader.js";
import { LoginForm } from "./components/LoginForm.js";
import { StartScreen } from "./components/StartScreen.js";
import { Sidebar, type MarkChange } from "./components/Sidebar.js";
import { SidebarResizer } from "./components/SidebarResizer.js";
import { StatusBar } from "./components/StatusBar.js";
import { TabStrip } from "./components/TabStrip.js";
import { SwitchSplash, type SplashTarget } from "./components/SwitchSplash.js";
import { ProjectSearch } from "./components/ProjectSearch.js";
import { ShortcutSheet } from "./components/ShortcutSheet.js";
import { ChatSearch } from "./components/ChatSearch.js";
import { FileViewer } from "./components/FileViewer.js";
import { SavedPromptsDialog } from "./components/SavedPromptsDialog.js";
import { UsageDialog } from "./components/UsageDialog.js";
import { SidePane } from "./components/SidePane.js";
import { TimelineDialog } from "./components/TimelineDialog.js";
import { useManagePrompts } from "./saved-prompts.js";
import { setPreviewWorkspace, useFileRequests, type FileRequest } from "./file-bus.js";
import { isShortcutsKey, shortcutHint } from "./shortcuts.js";
import { attentionCount, badgedIcon, chime, primeAudio, titleWith } from "./attention.js";
import { useEdgeSwipe } from "./gestures.js";
import { useLaunchActions } from "./launch.js";
import { ToastStack, useToasts } from "./components/ToastStack.js";
import { WorkspacePicker } from "./components/WorkspacePicker.js";
import { PairDialog, RenameDialog } from "./dialogs.js";
import { ReviewPanel } from "./components/ReviewPanel.js";
import { RestoreDialog } from "./components/RestoreDialog.js";
import { HerdrDialog } from "./components/HerdrDialog.js";
import { collectChanges } from "./review.js";
import { copyResumeCommand, useResumeCommand } from "./resume-command.js";
import { chatMarkdown, downloadText, exportFileName } from "./export.js";
import { RoutinesDialog } from "./components/RoutinesDialog.js";
import { SettingsDialog } from "./components/SettingsDialog.js";
import { IconEdit, IconGauge, IconMenu, IconMore, IconSearch, IconSidebar, IconSplit } from "./icons.js";
import { applyHarnessAccents, harnessColor } from "./harness-colors.js";
import { moveTab, pinnedCount, setPinned } from "./tab-order.js";
import { closeTab, draftTab, findTab, loadTabs, markUnread, placeChat, placeTab, runningChats, saveTabs, syncActive, type Tab, type TabState } from "./tabs.js";
import { useLimits } from "./limits.js";
import { useNotifications } from "./notify.js";
import { isPaletteKey, type PaletteItem } from "./palette.js";
import { isBusy, wakeLabel } from "./session-groups.js";
import { pendingImage, sentAttachments, type PendingImage } from "./images.js";
import { useSessions } from "./sessions.js";
import { useSidebarLayout } from "./sidebar-layout.js";
import { forgetWorkspace, load, rememberWorkspace, save } from "./storage.js";
import { themeModeOf, useTheme } from "./theme.js";
import { retryMode } from "./tool-retry.js";

export function App() {
  const { banner, setBanner, fail } = useBanner();
  const { themeInfo, initTheme, setThemeMode } = useTheme();
  const [harnessId, setHarnessId] = useState<string | null>(() => load<string | null>("harness", null));
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [recent, setRecent] = useState<string[]>(() => load<string[]>("recentWorkspaces", []));

  // A 401 on the live stream flips useBootstrap's signed-out flag (declared on
  // the next line); this closure only runs on an event, long after this render
  // finished, so the forward reference is safe.
  const { chat, setChat, conn } = useChatStream({ onSignedOut: () => setSignedOut(true) });
  const { boot, setBoot, bootError, signedOut, setSignedOut } = useBootstrap({
    onTheme: initTheme,
    setHarnessId,
    setWorkspace,
    setRecent,
    setChat,
  });
  const { overview, sessionsError, sessionsLoading, refreshSessions, markSession, orderSessions } = useSessions({ boot, workspace, chat });

  // Rooms are a sibling of chats: the URL's #room= names the shown one, and only
  // that room streams. The sidebar list and the bot profiles are plain fetches.
  const room = useRoomStream({ onSignedOut: () => setSignedOut(true) });
  const { rooms: roomsList, error: roomsError, loading: roomsLoading, refresh: refreshRooms } = useRooms(() => setSignedOut(true));
  const { bots: botsList, refresh: refreshBots } = useBots(() => setSignedOut(true));
  /** The room dialog: creating one, or editing the shown room. */
  const [roomEditor, setRoomEditor] = useState<{ mode: "create" } | { mode: "edit" } | null>(null);
  /** The bot profile dialog: an id, or null for a new one. */
  const [botEditor, setBotEditor] = useState<{ botId: string | null } | null>(null);
  const {
    sidebarWidth,
    setSidebarWidth,
    commitSidebarWidth,
    sidebarCollapsed,
    sidebarToggling,
    collapseSidebar,
    drawerOpen,
    setDrawerOpen,
    narrow,
    openedWhileNarrow,
  } = useSidebarLayout();

  /** A room is a target, not a tab: opening one navigates (Back returns to what was shown). */
  const openRoom = (id: string) => {
    openRoomHash(id);
    setDrawerOpen(false);
  };
  /** Leave the room for whatever the user asked for next (a chat, a project, the start screen). */
  const leaveRoom = () => {
    if (!room.roomId) return;
    // A chat may already own the URL (its hash write does not fire hashchange): drop the room only.
    if (roomIdFromHash() !== null) openRoomHash(null);
    else room.detach();
  };
  const applyRoom = (info: RoomInfo) => {
    room.apply([{ type: "room", room: info }]);
    void refreshRooms();
  };
  const sendToRoom = async (text: string, mentions: string[], clientId: string) => {
    if (!room.roomId) return false;
    try {
      const result = await postRoomMessage(room.roomId, { text, mentions, clientId });
      // The posted turn is queued now; its record arrives as a `record` event.
      room.apply([{ type: "queue", queued: result.queued }]);
      void refreshRooms();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };
  const answerInRoom = (requestId: string, answer: InteractionAnswer) => {
    if (!room.roomId) return;
    postRoomAnswer(room.roomId, requestId, answer).catch((e: unknown) => fail(e));
  };
  const stopRoom = () => {
    if (!room.roomId) return;
    postStopRoom(room.roomId).catch((e: unknown) => fail(e));
  };
  const cancelQueuedInRoom = (turnId: string) => {
    if (!room.roomId) return;
    postCancelQueuedTurn(room.roomId, turnId)
      .then(({ queued }) => room.apply([{ type: "queue", queued }]))
      .catch((e: unknown) => fail(e));
  };
  const loadOlderRoomRecords = async () => {
    const state = room.state;
    if (!room.roomId || !state) return;
    const before = oldestSeq(state);
    if (before === null) return;
    try {
      const { records } = await fetchHistory(room.roomId, before);
      room.prepend(records);
    } catch (e) {
      fail(e);
    }
  };
  /** The room's workspace path: the wire carries only its name, and tool rows want a path. */
  const roomWorkspacePath = overview.workspaces.find((w) => w.id === room.state?.room.workspaceId)?.path ?? "";
  /** Projects a new room may run in: every registered one, plus the current (even before it has a session). */
  const boardWorkspaces = useMemo(() => {
    const list = workspace ? [workspace, ...overview.workspaces] : overview.workspaces;
    return list.filter((w, i) => list.findIndex((x) => x.id === w.id) === i);
  }, [overview.workspaces, workspace]);

  /** What a share or prompt link put into the start screen's box (it waits there until Send). */
  const [startSeed, setStartSeed] = useState<{ text?: string; images?: PendingImage[]; hidden?: number } | null>(null);
  /** Bumped when a folder is picked from the start screen: its box takes the focus again. */
  const [startFocus, setStartFocus] = useState(0);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [opening, setOpening] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [pairOpen, setPairOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** A session open in a herdr pane, being opened here: the choice to make first. */
  const [herdrAsk, setHerdrAsk] = useState<{ s: ProjectSession & { herdr: NonNullable<ProjectSession["herdr"]> }; newTab: boolean; workspace?: WorkspaceInfo } | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  /** What the window-wide shortcuts call, kept current (the listener is added once). */
  const keysRef = useRef<{ step: (step: -1 | 1) => void; reopen: () => void; undo: (() => void) | null; search: () => void; searchAll: () => void }>({
    step: () => {},
    reopen: () => {},
    undo: null,
    search: () => {},
    searchAll: () => {},
  });
  /** Search every chat: open, with what it starts holding (the sidebar's query, or nothing). */
  const [chatSearch, setChatSearch] = useState<string | null>(null);
  /** The file viewer: open, on a file (and a line) or on its "Go to file" box. */
  const [viewer, setViewer] = useState<{ request: FileRequest | null } | null>(null);
  useFileRequests((request) => setViewer({ request }));
  /** The saved prompts' manager: open, perhaps starting a new prompt from a draft. */
  const [promptsOpen, setPromptsOpen] = useState<{ draft?: string } | null>(null);
  const [usageOpen, setUsageOpen] = useState(false);
  const [routinesOpen, setRoutinesOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  /** A chat beside the main one (SidePane): what it starts on (null: its picker); `n` remounts it for a new one. */
  const [side, setSide] = useState<{ initial: ChatSnapshot | null; n: number } | null>(null);
  // Two chats side by side need the room: below this the pane is not offered (and one open closes).
  const [wide, setWide] = useState(() => window.matchMedia(SPLIT_QUERY).matches);
  useEffect(() => {
    const query = window.matchMedia(SPLIT_QUERY);
    const on = () => setWide(query.matches);
    query.addEventListener("change", on);
    return () => query.removeEventListener("change", on);
  }, []);
  useEffect(() => {
    if (!wide) setSide(null);
  }, [wide]);
  useManagePrompts((draft) => setPromptsOpen(draft ? { draft } : {}));
  /** A chat opened from that search: Find opens in it holding the word, once it is shown. */
  const [findAsk, setFindAsk] = useState<{ query: string; nonce: number; sessionId: string; chatId: string | null } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  /** The turn whose checkpoint the restore dialog shows. */
  const [restoreTurn, setRestoreTurn] = useState<number | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isPaletteKey(e)) {
        e.preventDefault();
        setPaletteOpen((open) => !open);
        return;
      }
      if (isShortcutsKey(e)) {
        e.preventDefault();
        setShortcutsOpen((open) => !open);
        return;
      }
      const mod = (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey;
      if (mod && (e.code === "BracketLeft" || e.code === "BracketRight")) {
        e.preventDefault();
        keysRef.current.step(e.code === "BracketLeft" ? -1 : 1);
      } else if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey && e.code === "KeyT") {
        e.preventDefault();
        keysRef.current.reopen();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyF") {
        e.preventDefault();
        keysRef.current.search();
      } else if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === "KeyH") {
        e.preventDefault();
        keysRef.current.searchAll();
      } else if (mod && e.code === "KeyZ" && keysRef.current.undo) {
        const target = e.target as HTMLElement | null;
        if (target?.closest("input, textarea, [contenteditable='true']")) return;
        e.preventDefault();
        keysRef.current.undo();
      }
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, []);

  // ---- shared look: config.yml rules every device; a save applies here at once ----

  const themeMode = themeModeOf(themeInfo, boot?.ui.theme ?? null);
  const textScale = boot?.ui.textScale ?? 1;
  useEffect(() => {
    setThemeMode(themeMode);
  }, [themeMode, setThemeMode]);
  useEffect(() => {
    document.documentElement.style.setProperty("--chat-scale", String(textScale));
  }, [textScale]);
  const chatWidth = boot?.ui.chatWidth ?? null;
  useEffect(() => {
    const root = document.documentElement.style;
    if (chatWidth === "wide") root.setProperty("--chat-col", "1400px");
    else if (chatWidth === "full") root.setProperty("--chat-col", "100%");
    else root.removeProperty("--chat-col");
  }, [chatWidth]);
  // Compact density is an attribute on <html>: tokens.css swaps the spacing tokens under it.
  const density = boot?.ui.density ?? null;
  useEffect(() => {
    if (density === "compact") document.documentElement.setAttribute("data-density", "compact");
    else document.documentElement.removeAttribute("data-density");
  }, [density]);

  const available = useMemo(() => boot?.harnesses.filter((h) => h.available) ?? [], [boot]);
  // A harness that comes back after this page loaded (a Hermes gateway finishing its
  // start, a CLI just installed) is asked about again instead of staying greyed out.
  useHarnessRecheck(boot, (rows) => setBoot((prev) => (prev ? mergeHarnesses(prev, rows) : prev)));
  useEffect(() => {
    if (boot) applyHarnessAccents(boot.harnesses);
  }, [boot]);
  // The build this page loaded from, and the three moments a deploy can surface:
  // the stream reconnecting to a restarted server, the page becoming visible again,
  // and a slow poll while it stays visible (see app-update.ts).
  useEffect(() => rememberBuild(boot?.build), [boot]);
  useEffect(() => watchForNewBuild(), []);
  useEffect(() => {
    if (conn === "connected") void checkForNewBuild();
  }, [conn]);
  const chatId = chat?.chatId ?? null;

  // ---- session tabs ---------------------------------------------------------------------

  const [tabState, setTabState] = useState<TabState>(loadTabs);
  const tabsRef = useRef(tabState);
  tabsRef.current = tabState;
  useEffect(() => saveTabs(tabState), [tabState]);
  /** Each tab's chat as last shown: switching back shows it at once, and the stream replays what it missed. */
  const tabCache = useRef(new Map<string, ChatState>());
  const chatRef = useRef(chat);
  chatRef.current = chat;
  const rememberShown = () => {
    const { tabs, active } = tabsRef.current;
    const shown = chatRef.current;
    const tab = tabs[active];
    if (shown && tab && tab.chatId === shown.chatId) tabCache.current.set(tab.key, shown);
  };

  // Whatever chat is shown lives in a tab: adopt one that arrived another way (the URL hash),
  // and keep the shown tab's title and session in step.
  useEffect(() => {
    if (!chat) return;
    setTabState((st) => {
      const i = findTab(st, chat);
      return i < 0 ? placeChat(st, chat) : i === st.active ? syncActive(st, chat) : st;
    });
  }, [chat?.chatId, chat?.title, chat?.sessionId]);

  // A draft tab carries the harness and folder the start screen shows, so the strip's
  // tint and the tab it becomes stay right until the first send fills it in.
  useEffect(() => {
    if (chat) return;
    setTabState((st) => {
      const tab = st.tabs[st.active];
      if (!tab || tab.chatId !== null || tab.sessionId !== null) return st;
      const harness = harnessId ?? tab.harnessId;
      const path = workspace?.path ?? tab.workspacePath;
      if (harness === tab.harnessId && path === tab.workspacePath) return st;
      const tabs = st.tabs.slice();
      tabs[st.active] = { ...tab, harnessId: harness, workspacePath: path };
      return { ...st, tabs };
    });
  }, [chat, harnessId, workspace?.path]);

  /** Background notices (a run finished, a question waiting) and mark changes' Undo, stacked. */
  const toasts = useToasts();

  // Background tabs: a tab whose run ended while another was shown gets a dot.
  // Only a run counts; a harness starting up (Starting → Idle) is no news.
  const busyBefore = useRef(new Set<string>());
  useEffect(() => {
    const busyNow = runningChats(overview.sessions);
    const finished = new Set([...busyBefore.current].filter((id) => !busyNow.has(id) && id !== chatId));
    busyBefore.current = busyNow;
    setTabState((st) => markUnread(st, finished));
    // The same news as a card that opens the chat; two finishes of one chat are one card.
    for (const id of finished) {
      const s = overview.sessions.find((x) => x.liveChatId === id);
      if (s) toasts.push({ key: `done:${id}`, text: `“${s.title}” finished`, sessionId: s.id, ms: 8000 });
    }
    if (finished.size > 0 && document.hidden) chime();
  }, [overview, chatId]);

  // What needs you, from another tab (attention.ts): a count in the title and on the favicon, and a chime.
  const askingIds = useMemo(() => overview.sessions.flatMap((x) => (x.asking && x.liveChatId ? [x.liveChatId] : [])), [overview]);
  // Chats already asking when the page loads are not news; only a new question chimes.
  const askedBefore = useRef<Set<string> | null>(null);
  useEffect(() => {
    const before = askedBefore.current;
    askedBefore.current = new Set(askingIds);
    if (!before) return;
    const fresh = askingIds.filter((id) => !before.has(id));
    if (fresh.length > 0 && (document.hidden || fresh.some((id) => id !== chatId))) chime();
    for (const id of fresh) {
      const s = id === chatId ? undefined : overview.sessions.find((x) => x.liveChatId === id);
      if (s) toasts.push({ key: `ask:${id}`, text: `“${s.title}” needs you`, sessionId: s.id, ms: 12000 });
    }
  }, [askingIds]);
  useEffect(() => primeAudio(), []);
  const attention = attentionCount(
    askingIds,
    tabState.tabs.flatMap((t) => (t.unread && t.chatId ? [t.chatId] : [])),
  );
  const pageTitle = titleWith(attention, chat ? `${chat.title || "New chat"} · awui` : "awui");
  useEffect(() => {
    document.title = pageTitle;
  }, [pageTitle]);
  // The favicon carries the count too: drawn from the app's icon, put back when nothing is waiting.
  useEffect(() => {
    const icons = [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];
    for (const link of icons) link.dataset.plain ??= link.href;
    if (attention === 0) {
      for (const link of icons) link.href = link.dataset.plain ?? link.href;
      return;
    }
    let cancelled = false;
    const color = getComputedStyle(document.documentElement).getPropertyValue("--danger").trim() || "#c81e1e";
    void badgedIcon("/icon-192.png", attention, color).then((url) => {
      if (cancelled || !url) return;
      for (const link of icons) link.href = url;
    });
    return () => {
      cancelled = true;
    };
  }, [attention]);

  const changes = useMemo(() => (chat ? collectChanges(chat.items, chat.workspace.path) : []), [chat?.items, chat?.workspace.path]);
  const changedFiles = changes.length;

  // Runs the shown chat finished: the limits meter re-reads after each.
  const [settledRuns, setSettledRuns] = useState(0);
  const shownStatus = useRef<string | null>(null);
  useEffect(() => {
    const status = chat?.status ?? null;
    if (status === "idle" && shownStatus.current === "running") setSettledRuns((n) => n + 1);
    shownStatus.current = status;
  }, [chat?.status]);
  const limits = useLimits(Boolean(boot), settledRuns);

  const tabStatus = (tab: Tab) =>
    chat && tab.chatId === chat.chatId ? chat.status : (overview.sessions.find((x) => x.liveChatId !== undefined && x.liveChatId === tab.chatId)?.status ?? null);

  // ---- opening a chat at once -----------------------------------------------------------

  // A click on a session answers in the same frame: its tab, title, and a loading
  // screen show while the snapshot comes, and the screen fades once the chat has drawn.
  // Each open takes a number, so a slow earlier one landing after a later click is dropped.
  const nav = useRef(0);
  const [splash, setSplash] = useState<{ target: SplashTarget; leaving: boolean } | null>(null);
  const splashFor = (tab: Pick<Tab, "title" | "harnessId" | "workspacePath">): SplashTarget => ({
    title: tab.title || "Chat",
    harnessId: tab.harnessId,
    harnessName: boot?.harnesses.find((h) => h.id === tab.harnessId)?.displayName ?? tab.harnessId,
    project: tab.harnessId === "awui" ? null : (tab.workspacePath.split("/").filter(Boolean).pop() ?? null),
  });
  /** Start an open: later ones win. With a target, its loading screen shows until showChat. */
  const beginOpen = (target: SplashTarget | null): number => {
    nav.current += 1;
    setSplash(target ? { target, leaving: false } : null);
    return nav.current;
  };
  useEffect(() => {
    if (!splash?.leaving) return;
    const t = window.setTimeout(() => setSplash(null), 260);
    return () => window.clearTimeout(t);
  }, [splash]);

  /** What opening a session needs: its project (registered with the server again if need be) and its chat, live or resumed from the file. */
  const fetchSession = async (s: ProjectSession, target: WorkspaceInfo, ignoreHerdr = false): Promise<{ ws: WorkspaceInfo; snapshot: ChatSnapshot }> => {
    const ws = target.id === workspace?.id ? Promise.resolve(target) : api<WorkspaceInfo>("/api/workspaces/open", { body: { path: target.path } });
    if (s.liveChatId) {
      const [opened, snapshot] = await Promise.all([ws, api<ChatSnapshot>(`/api/chats/${s.liveChatId}`)]);
      return { ws: opened, snapshot };
    }
    const opened = await ws;
    const body = { harnessId: s.harnessId, workspaceId: opened.id, sessionId: s.id, ...(ignoreHerdr ? { ignoreHerdr: true } : {}) };
    return { ws: opened, snapshot: await api<ChatSnapshot>("/api/chats/resume", { body }) };
  };

  /**
   * Opens started before the click: on a mouse press (the click lands ~100 ms
   * later), and on hover for a live chat, whose read has no side effects. A
   * resume starts the harness, so it waits for a press. Used once, or dropped.
   */
  const early = useRef(new Map<string, { at: number; result: ReturnType<typeof fetchSession> }>());
  const EARLY_MS = 10_000;
  const warmSession = (s: ProjectSession, why: "hover" | "press") => {
    if (why === "hover" && !s.liveChatId) return;
    // A herdr pane runs it: opening asks first, so nothing starts on the press.
    if (s.herdr && !s.liveChatId) return;
    if (findTab(tabsRef.current, { chatId: s.liveChatId ?? null, sessionId: s.id }) >= 0) return;
    const known = early.current.get(s.id);
    if (known && Date.now() - known.at < EARLY_MS) return;
    const target = overview.workspaces.find((w) => w.id === s.workspaceId);
    if (!target) return;
    const result = fetchSession(s, target);
    // The click reports a failure; one nobody clicks is dropped quietly.
    result.catch(() => undefined);
    early.current.set(s.id, { at: Date.now(), result });
  };
  const takeEarly = (s: ProjectSession) => {
    const known = early.current.get(s.id);
    early.current.delete(s.id);
    return known && Date.now() - known.at < EARLY_MS ? known.result : null;
  };

  // ---- actions -------------------------------------------------------------------------

  const chooseHarness = (id: string) => {
    setHarnessId(id);
    save("harness", id);
    // The Awui harness has no projects; putting it on the home workspace keeps its
    // flat history from filtering to nothing under whatever coding workspace was last.
    if (id === "awui" && workspace?.path !== boot?.home) {
      void api<WorkspaceInfo>("/api/workspaces/open", { body: { path: boot?.home ?? "/" } }).then(setWorkspace).catch(() => undefined);
    }
  };

  const openWorkspace = async (path: string) => {
    setPickerError(null);
    try {
      const ws = await api<WorkspaceInfo>("/api/workspaces/open", { body: { path } });
      setWorkspace(ws);
      setRecent(rememberWorkspace(ws.path));
      setPickerOpen(false);
      // The start screen's chip is the main way in now; picking a folder lands on it, so the drawer closes (as showChat does).
      if (!chatRef.current) {
        setDrawerOpen(false);
        setStartFocus((n) => n + 1);
      }
    } catch (e) {
      if (e instanceof ApiError && e.code === "missing_project") setRecent(forgetWorkspace(path));
      setPickerError(errorText(e));
    }
  };

  /** Show a chat: in its own tab when it has one, else in the shown tab, or a new tab with `newTab`. */
  /** `keepDrawer`: a tab reattaching (on load, or switched to) leaves the drawer as it is; picking a chat closes it. */
  const showChat = (snapshot: ChatSnapshot, { newTab = false, keepDrawer = false }: { newTab?: boolean; keepDrawer?: boolean } = {}) => {
    rememberShown();
    setTabState((st) => placeChat(st, snapshot, { newTab }));
    setChat(snapshot);
    // The start screen's tab key is consumed: its draft has become (or lost) this chat.
    startTabKey.current = null;
    setBanner(null);
    setSplash((sp) => (sp ? { ...sp, leaving: true } : sp));
    if (!keepDrawer) setDrawerOpen(false);
  };

  /** Make `ws` the current project, registering it with the server again if needed. */
  const enterWorkspace = async (ws: WorkspaceInfo): Promise<WorkspaceInfo> => {
    if (ws.id === workspace?.id) return ws;
    const opened = await api<WorkspaceInfo>("/api/workspaces/open", { body: { path: ws.path } });
    setWorkspace(opened);
    setRecent(rememberWorkspace(opened.path));
    return opened;
  };

  /** Show the start screen: no chat on screen; the open tabs stay, none active. Nothing starts until a send. */
  const showStart = () => {
    leaveRoom();
    rememberShown();
    setStartSeed(null);
    startTabKey.current = null;
    setTabState((st) => ({ ...st, active: -1 }));
    setChat(null);
    setHash(null);
    setBanner(null);
    beginOpen(null);
    setDrawerOpen(false);
  };

  /**
   * The strip's +: a tab for a chat nobody has started. The start screen is what the
   * tab shows, and the first prompt fills the same tab in (placeChat takes the shown
   * tab's place, since a draft matches no chat).
   */
  const newTab = () => {
    leaveRoom();
    rememberShown();
    setStartSeed(null);
    startTabKey.current = null;
    let made: string | null = null;
    setTabState((st) => {
      const next = placeTab(st, draftTab(harnessId ?? "", workspace?.path ?? ""), { newTab: true });
      made = next.tabs[next.active]?.key ?? null;
      return next;
    });
    startTabKey.current = made;
    setChat(null);
    setHash(null);
    setBanner(null);
    beginOpen(null);
    setDrawerOpen(false);
  };


  /** The tab a start screen's send fills in: the draft tab the strip's + made, or none
   * (the start screen without a tab, a project's +). Kept here, so a create that lands
   * after the user switched tabs fills that same tab in from the background. */
  const startTabKey = useRef<string | null>(null);
  /** A project's +: that project's folder on the start screen, with nothing started yet. */
  const startIn = async (ws: WorkspaceInfo) => {
    try {
      await enterWorkspace(ws);
    } catch (e) {
      fail(e);
      return;
    }
    showStart();
    setStartFocus((n) => n + 1);
  };

  /** The sidebar's New chat: the start screen, with the folder picker open over it. */
  const newChatInFolder = () => {
    showStart();
    if (harnessId === "awui") return;
    setPickerError(null);
    setPickerOpen(true);
  };

  /** The start screen's Send: create the chat, then post the message to its id (the render closure still holds no chat). */
  const [startBusy, setStartBusy] = useState(false);
  const startingRef = useRef(false);
  // The start screen's model chip: the harness's models for the folder, read before any chat
  // exists. A pick applies when the chat is created, never to this or the last chat.
  const [startModels, setStartModels] = useState<ModelInfo[]>([]);
  const [startModel, setStartModel] = useState<string | null>(null);
  // The harness's own default for a fresh chat, when it says one: the chip names it instead of "Default model".
  const [startDefault, setStartDefault] = useState<{ model: string; thinkingLevel: string | null } | null>(null);
  // The thinking levels the harness offers a fresh chat, and the one picked here ("" = the harness's default).
  const [startLevels, setStartLevels] = useState<string[]>([]);
  const [startThinking, setStartThinking] = useState<string>("");
  const modelFetch = useRef(0);
  const modelsKey = useRef<string | null>(null);
  const loadStartModels = async (forHarness: string, forWs: WorkspaceInfo, refresh = false): Promise<ModelInfo[]> => {
    const seq = ++modelFetch.current;
    try {
      const { models, defaultModel, thinkingLevels } = await api<{ models: ModelInfo[]; defaultModel?: { model: string; thinkingLevel: string | null } | null; thinkingLevels?: string[] }>(`/api/harnesses/${encodeURIComponent(forHarness)}/models?workspaceId=${encodeURIComponent(forWs.id)}${refresh ? "&refresh=1" : ""}`);
      if (seq === modelFetch.current) {
        setStartModels(models);
        // Only a default that names a model the list actually offers is shown; anything else is no better than "Default model".
        const usable = defaultModel && models.some((m) => m.key === defaultModel.model) ? defaultModel : null;
        setStartDefault(usable);
        setStartLevels(thinkingLevels ?? []);
        // A model the harness no longer lists (another harness, another folder's providers) is no pick.
        setStartModel((picked) => (picked && models.some((m) => m.key === picked) ? picked : null));
        setStartThinking((picked) => (thinkingLevels?.includes(picked) ? picked : ""));
      }
      return models;
    } catch {
      if (seq === modelFetch.current) {
        setStartModels([]);
        setStartDefault(null);
        setStartLevels([]);
      }
      return [];
    }
  };
  useEffect(() => {
    // No chip behind a chat, and a chat's start invalidates a list still on its way.
    if (chatId !== null || !harnessId || !workspace) {
      modelFetch.current += 1;
      modelsKey.current = null;
      setStartModels([]);
      setStartDefault(null);
      setStartLevels([]);
      setStartThinking("");
      return;
    }
    // Another harness or folder: the list on screen belongs to the old one, so drop it (and the
    // pick in it) before asking for the new one, rather than offering models this chat cannot use.
    const key = `${harnessId}\0${workspace.id}`;
    if (modelsKey.current !== key) {
      modelsKey.current = key;
      setStartModels([]);
      setStartModel(null);
      setStartDefault(null);
      setStartLevels([]);
      setStartThinking("");
    }
    void loadStartModels(harnessId, workspace);
  }, [chatId, harnessId, workspace?.id]);
  const refreshStartModels = async (): Promise<void> => {
    if (!harnessId || !workspace) return;
    await loadStartModels(harnessId, workspace, true);
  };
  const startSend = async (text: string, images: PendingImage[]): Promise<boolean> => {
    // Two quick presses (a double Enter) must make one chat: the ref guards before state can re-render.
    if (!harnessId || startingRef.current) return false;
    startingRef.current = true;
    const target = harnessId === "awui" && boot && boot.home ? ({ id: "__home", path: boot.home, name: "home" } as WorkspaceInfo) : workspace;
    if (!target) {
      startingRef.current = false;
      return false;
    }
    const token = beginOpen(null);
    setStartBusy(true);
    setBanner(null);
    try {
      const ws = await enterWorkspace(target);
      const snapshot = await api<ChatSnapshot>("/api/chats", { body: { harnessId, workspaceId: ws.id, ...(startModel ? { model: startModel } : {}), ...(startThinking ? { thinkingLevel: startThinking } : {}) } });
      // A create is never undone by the user going elsewhere while it ran (a tab
      // switch, another open): the chat keeps its tab and its prompt, landing in
      // the background below. startingRef already guarantees one create at a time,
      // so there is nothing to dispose this one against.
      try {
        await api(`/api/chats/${snapshot.chatId}/messages`, {
          body: {
            text: text || (images.length > 0 ? "Look at the attached image." : " "),
            mode: "normal",
            ...(images.length > 0 ? { images: images.map(({ mimeType, data }) => ({ mimeType, data })) } : {}),
          },
        });
      } catch (e) {
        // The chat exists but has no message: open it with the text as its draft, so the words are not lost.
        save(`draft.${snapshot.chatId}`, text);
        showChat(snapshot);
        fail(e);
        return false;
      }
      setStartSeed(null);
      // The chat took the picks; a next New chat starts on the harness's defaults again.
      setStartModel(null);
      setStartThinking("");
      if (token !== nav.current) {
        // The user went elsewhere while the harness spawned: the chat keeps its tab —
        // the draft that sent it, else a background one after the view — and does not
        // steal the screen or get dropped for the detour.
        const from = startTabKey.current;
        // The create snapshot predates the message: read it back once the run has
        // taken it, so the background tab carries its title (and items) at once.
        const fresh = await api<ChatSnapshot>(`/api/chats/${snapshot.chatId}`).catch(() => snapshot);
        setTabState((st) => placeChat(st, fresh, { background: true, ...(from ? { forKey: from } : {}) }));
      } else {
        showChat(snapshot);
      }
      void refreshSessions();
      return true;
    } catch (e) {
      if (token === nav.current) fail(e);
      return false;
    } finally {
      startingRef.current = false;
      setStartBusy(false);
    }
  };

  /** An immediate new chat (Ctrl+Alt+Enter from a composer): the start screen is the ordinary path, this one skips it. */
  const newChat = async (target: WorkspaceInfo | null = workspace, { newTab = false }: { newTab?: boolean } = {}) => {
    // The Awui harness's history is global; a new chat belongs on the home workspace, not wherever a coding chat left the picker.
    if (harnessId === "awui" && boot && target?.path !== boot.home) {
      target = boot.home ? ({ id: "__home", path: boot.home, name: "home" } as WorkspaceInfo) : target;
    }
    if (!target || !harnessId) return;
    const token = beginOpen(null);
    setOpening(true);
    setBanner(null);
    try {
      const ws = await enterWorkspace(target);
      const snapshot = await api<ChatSnapshot>("/api/chats", { body: { harnessId, workspaceId: ws.id } });
      if (token !== nav.current) {
        // The user went elsewhere while the harness spawned: the chat keeps its tab
        // (a background one after the view), not dropped for the detour.
        setTabState((st) => placeChat(st, snapshot, { newTab: true, background: true }));
        void refreshSessions();
        return;
      }
      showChat(snapshot, { newTab });
      void refreshSessions();
    } catch (e) {
      fail(e);
      setDrawerOpen(false);
    } finally {
      setOpening(false);
    }
  };

  // The installed app's shortcuts and shares (?new, ?sessions, ?share), and phones' swipe for the drawer.
  useLaunchActions({ booted: Boolean(boot), ready: Boolean(boot && workspace && harnessId), hasChat: chat !== null, newChat: () => newChat(), openSessions: () => setDrawerOpen(true), seed: (s) => setStartSeed(s) });
  useEdgeSwipe(drawerOpen, setDrawerOpen);

  /**
   * Reattach a tab to its chat, or resume its session once the server no longer
   * holds the chat (a restart, or the idle reaper). A tab with neither is dropped.
   */
  const loadTab = async (tab: Tab) => {
    if (!tab.chatId && !tab.sessionId) {
      // A draft tab (the strip's +): the start screen is what it shows, and it is not a
      // stale tab to close when its chat is gone.
      beginOpen(null);
      setOpening(false);
      setStartSeed(null);
      setChat(null);
      setHash(null);
      setBanner(null);
      return;
    }
    const token = beginOpen(splashFor(tab));
    setOpening(true);
    setBanner(null);
    try {
      if (tab.chatId) {
        try {
          const live = await api<ChatSnapshot>(`/api/chats/${tab.chatId}`);
          if (token !== nav.current) return;
          setWorkspace(live.workspace);
          showChat(live, { keepDrawer: true });
          return;
        } catch (e) {
          if (!(e instanceof ApiError && e.status === 404)) throw e;
        }
      }
      if (token !== nav.current) return;
      if (!tab.sessionId) {
        setSplash(null);
        setTabState((st) => {
          const i = st.tabs.findIndex((t) => t.key === tab.key);
          return i < 0 ? st : closeTab(st, i);
        });
        return;
      }
      const ws = await api<WorkspaceInfo>("/api/workspaces/open", { body: { path: tab.workspacePath } });
      const snapshot = await api<ChatSnapshot>("/api/chats/resume", { body: { harnessId: tab.harnessId, workspaceId: ws.id, sessionId: tab.sessionId } });
      if (token !== nav.current) return;
      setWorkspace(ws);
      showChat(snapshot, { keepDrawer: true });
    } catch (e) {
      if (token !== nav.current) return;
      setSplash(null);
      fail(e);
    } finally {
      if (token === nav.current) setOpening(false);
    }
  };

  const activateTab = (index: number) => {
    leaveRoom();
    const tab = tabsRef.current.tabs[index];
    if (!tab) return;
    if (index === tabsRef.current.active && chat?.chatId === tab.chatId) return;
    rememberShown();
    setTabState((st) => ({ active: index, tabs: st.tabs.map((t, i) => (i === index && t.unread ? { ...t, unread: undefined } : t)) }));
    const cached = tabCache.current.get(tab.key);
    if (cached && cached.chatId === tab.chatId && cached.status !== "disposed") {
      beginOpen(null);
      setOpening(false);
      setWorkspace(cached.workspace);
      setChat(cached);
      setBanner(null);
      return;
    }
    void loadTab(tab);
  };

  /** Closed tabs, newest last, for Alt+Shift+T (the browser keeps Ctrl+Shift+T). */
  const closedTabs = useRef<Tab[]>([]);
  const reopenClosedTab = () => {
    const popped = closedTabs.current.pop();
    if (!popped) return;
    // Back unpinned, whatever it was: it is not among the pinned ones at the left any more.
    const tab = { ...popped, pinned: undefined };
    const open = findTab(tabsRef.current, tab);
    if (open >= 0) {
      activateTab(open);
      return;
    }
    rememberShown();
    const at = Math.max(tabsRef.current.active + 1, pinnedCount(tabsRef.current.tabs));
    const next = { tabs: [...tabsRef.current.tabs.slice(0, at), tab, ...tabsRef.current.tabs.slice(at)], active: at };
    tabsRef.current = next;
    setTabState(next);
    void loadTab(tab);
  };

  /** Reorder the strip (a drag, or Alt+Shift+←/→); the shown tab stays the shown tab. */
  const moveTabTo = (from: number, to: number) => {
    const next = moveTab(tabsRef.current, from, to);
    tabsRef.current = next;
    setTabState(next);
  };
  const pinTabAt = (index: number, pinned: boolean) => {
    const next = setPinned(tabsRef.current, index, pinned);
    tabsRef.current = next;
    setTabState(next);
  };

  const closeTabAt = (index: number) => {
    const before = tabsRef.current;
    const closing = before.tabs[index];
    if (!closing) return;
    if (closing.chatId || closing.sessionId) closedTabs.current = [...closedTabs.current.filter((t) => t.key !== closing.key), closing].slice(-10);
    tabCache.current.delete(closing.key);
    const after = closeTab(before, index);
    // Updated now, not at the next render: activateTab below reads it.
    tabsRef.current = after;
    setTabState(after);
    if (index !== before.active) return;
    const next = after.tabs[after.active];
    if (next) activateTab(after.active);
    else {
      beginOpen(null);
      setChat(null);
      setHash(null);
    }
  };

  // Back and forward through the chats shown (Ctrl+[ and Ctrl+], as in an editor).
  const visits = useRef<{ list: Tab[]; at: number; moving: boolean }>({ list: [], at: -1, moving: false });
  useEffect(() => {
    if (!chat) return;
    const v = visits.current;
    const here = v.list[v.at];
    if (here && (here.chatId === chat.chatId || (chat.sessionId !== null && here.sessionId === chat.sessionId))) return;
    if (v.moving) {
      v.moving = false;
      return;
    }
    const tab = tabsRef.current.tabs[tabsRef.current.active];
    const entry: Tab = tab && tab.chatId === chat.chatId ? tab : { key: `v${Date.now()}`, chatId: chat.chatId, sessionId: chat.sessionId, harnessId: chat.harnessId, workspacePath: chat.workspace.path, title: chat.title };
    v.list = [...v.list.slice(0, v.at + 1), entry].slice(-50);
    v.at = v.list.length - 1;
  }, [chat?.chatId]);
  const stepVisits = (step: -1 | 1) => {
    const v = visits.current;
    const target = v.list[v.at + step];
    if (!target) return;
    v.at += step;
    v.moving = true;
    const open = findTab(tabsRef.current, target);
    if (open >= 0) activateTab(open);
    else {
      const shown = tabsRef.current.tabs[tabsRef.current.active];
      void loadTab({ ...target, key: shown?.key ?? target.key });
    }
  };

  // A shown chat the server dropped (restart, idle reaper) comes back through its tab's session.
  const resumedGone = useRef(new Set<string>());
  useEffect(() => {
    if (!chat?.gone) return;
    const tab = tabsRef.current.tabs[tabsRef.current.active];
    if (!tab || tab.chatId !== chat.chatId || !tab.sessionId || resumedGone.current.has(chat.chatId)) return;
    resumedGone.current.add(chat.chatId);
    void loadTab({ ...tab, chatId: null });
  }, [chat?.gone]);

  // On load, the shown tab reattaches unless the URL already names a chat or a room.
  const restored = useRef(false);
  useEffect(() => {
    if (!boot || restored.current) return;
    restored.current = true;
    const tab = tabsRef.current.tabs[tabsRef.current.active];
    if (tab && !chatIdFromHash() && !roomIdFromHash()) void loadTab(tab);
  }, [boot]);

  // Opening a chat while a room is shown leaves the room: the URL names one target,
  // and the chat's own hash write (replaceState) never reports a hashchange.
  const lastChatId = useRef<string | null>(null);
  useEffect(() => {
    const id = chat?.chatId ?? null;
    const previous = lastChatId.current;
    lastChatId.current = id;
    if (id !== null && id !== previous && room.roomId) leaveRoom();
  }, [chat?.chatId, room.roomId]);

  /** Open a chat beside the main one: `s` at once, or the pane's picker. */
  const openBeside = async (s?: ProjectSession) => {
    if (!s) return setSide((v) => ({ initial: null, n: (v?.n ?? 0) + 1 }));
    const target = overview.workspaces.find((w) => w.id === s.workspaceId);
    if (!target) return;
    try {
      const { snapshot } = await fetchSession(s, target);
      setSide((v) => ({ initial: snapshot, n: (v?.n ?? 0) + 1 }));
    } catch (e) {
      fail(e);
    }
  };
  /** Swap the two: the chat beside comes to the main pane, and the main one goes beside. */
  const makeMain = (beside: ChatState) => {
    const was = chat;
    setSide((v) => ({ initial: was && was.status !== "disposed" ? was : null, n: (v?.n ?? 0) + 1 }));
    setWorkspace(beside.workspace);
    showChat(beside);
  };

  /** `workspace`: the session's project, when the caller knows it (a search reaches sessions the sidebar's list may not hold). */
  const openSession = async (
    s: ProjectSession,
    { newTab = false, workspace: known, ignoreHerdr = false }: { newTab?: boolean; workspace?: WorkspaceInfo; ignoreHerdr?: boolean } = {},
  ) => {
    leaveRoom();
    // Opening it here is reading it: no toast, the dot just goes. Awaited, so the
    // overview refresh that opening triggers cannot land first and put it back.
    if (s.unread) {
      const mark = await api<SessionMarkState>("/api/sessions/marks", { body: { sessionId: s.id, unread: false } }).catch(() => null);
      if (mark) markSession(s.id, mark);
      void refreshSessions();
    }
    const open = findTab(tabsRef.current, { chatId: s.liveChatId ?? null, sessionId: s.id });
    if (open >= 0) {
      activateTab(open);
      setDrawerOpen(false);
      return;
    }
    // A herdr pane runs its harness: a resume here would be a second writer, so ask (HerdrDialog).
    if (s.herdr && !s.liveChatId && !ignoreHerdr) {
      setHerdrAsk({ s: { ...s, herdr: s.herdr }, newTab, ...(known ? { workspace: known } : {}) });
      setDrawerOpen(false);
      return;
    }
    const target = known ?? overview.workspaces.find((w) => w.id === s.workspaceId);
    if (!target) return;
    // Its tab and loading screen first; the snapshot fills the same tab in.
    const tab = { chatId: s.liveChatId ?? null, sessionId: s.id, harnessId: s.harnessId, workspacePath: target.path, title: s.title };
    const token = beginOpen(splashFor(tab));
    rememberShown();
    const before = tabsRef.current;
    // The draft the user is composing in (a start screen's tab) is never taken
    // over: opening a past session beside it keeps the new chat they are about
    // to start. Anything else still takes the shown tab's place.
    const composing = startTabKey.current !== null && before.active >= 0 && before.tabs[before.active]?.key === startTabKey.current;
    const placed = placeTab(before, tab, { newTab: newTab || composing });
    tabsRef.current = placed;
    setTabState(placed);
    setDrawerOpen(false);
    setOpening(true);
    setBanner(null);
    try {
      const { ws, snapshot } = await (takeEarly(s) ?? fetchSession(s, target, ignoreHerdr));
      if (token !== nav.current) return;
      if (ws.id !== workspace?.id) {
        setWorkspace(ws);
        setRecent(rememberWorkspace(ws.path));
      }
      showChat(snapshot);
    } catch (e) {
      if (token !== nav.current) return;
      setSplash(null);
      // The tab goes back to what it showed.
      if (tabsRef.current === placed) {
        tabsRef.current = before;
        setTabState(before);
      }
      fail(e);
      void refreshSessions();
    } finally {
      if (token === nav.current) setOpening(false);
    }
  };

  /** A notification was clicked: show its chat, or resume its session once the server no longer holds the chat. */
  const openNote = async (note: PushNote) => {
    if (note.roomId) {
      openRoom(note.roomId);
      return;
    }
    if (!note.chatId) return;
    const tab = findTab(tabsRef.current, { chatId: note.chatId, sessionId: note.sessionId });
    if (tab >= 0) {
      activateTab(tab);
      return;
    }
    const token = beginOpen(null);
    try {
      const live = await api<ChatSnapshot>(`/api/chats/${note.chatId}`);
      if (token !== nav.current) return;
      setWorkspace(live.workspace);
      showChat(live, { newTab: true });
    } catch (e) {
      if (token !== nav.current) return;
      const session = note.sessionId ? overview.sessions.find((x) => x.id === note.sessionId) : undefined;
      if (session) void openSession(session, { newTab: true });
      else fail(e);
    }
  };
  const openNoteRef = useRef(openNote);
  openNoteRef.current = openNote;
  const { notify, toggleNotify, testNotify } = useNotifications(Boolean(boot), (note) => void openNoteRef.current(note));

  const send = async (text: string, mode: SendMode, images: ImageAttachment[] = [], options: { compactFirst?: boolean; attachments?: string[] } = {}): Promise<boolean> => {
    if (!chat) return false;
    const command = mode === "normal" && images.length === 0 && (options.attachments?.length ?? 0) === 0 ? appCommand(text) : null;
    if (command) return runAppCommand(command.name, command.arg);
    try {
      await api(`/api/chats/${chat.chatId}/messages`, {
        body: {
          text,
          mode,
          ...(images.length > 0 ? { images } : {}),
          ...(options.attachments && options.attachments.length > 0 ? { attachments: options.attachments.map((id) => ({ id })) } : {}),
          ...(options.compactFirst ? { compactFirst: true } : {}),
        },
      });
      setBanner(null);
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const refreshModels = async (): Promise<void> => {
    if (!chat) return;
    try {
      // The new list arrives as a config event.
      await api(`/api/chats/${chat.chatId}/models/refresh`, { body: {} });
    } catch (e) {
      fail(e);
    }
  };

  /** /new, /compact [focus], /rename <title>: the app's own commands, for every harness. */
  const runAppCommand = async (name: string, arg: string): Promise<boolean> => {
    if (!chat) return false;
    try {
      if (name === "new") {
        showStart();
        return true;
      }
      else if (name === "compact") await api(`/api/chats/${chat.chatId}/compact`, { body: arg ? { instructions: arg } : {} });
      else if (name === "rename") {
        if (arg) await api(`/api/chats/${chat.chatId}/rename`, { body: { name: arg } });
        else setRenameOpen(true);
      }
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  const stop = () => {
    if (!chat) return;
    setChat((prev) => (prev && prev.status !== "idle" ? { ...prev, status: "stopping" } : prev));
    api(`/api/chats/${chat.chatId}/abort`, { body: {} }).catch((e: unknown) => fail(e));
  };

  /** Branch the chat after its Nth turn into a new session, and open the copy. */
  const forkChat = async (through: number): Promise<void> => {
    if (!chat) return;
    try {
      showChat(await api<ChatSnapshot>(`/api/chats/${chat.chatId}/fork`, { body: { through } }));
    } catch (e) {
      fail(e);
    }
  };

  /** Put files back as they were before turn `through`; the banner offers to put them back again. */
  const restoreFiles = async (through: number, paths: string[], alsoFork: boolean): Promise<void> => {
    if (!chat) return;
    const chatId = chat.chatId;
    try {
      const done = await api<CheckpointRestored>(`/api/chats/${chatId}/checkpoints/${through}/restore`, { body: { paths } });
      setRestoreTurn(null);
      const n = done.files.length;
      const putBack = async () => {
        try {
          await api<CheckpointRestored>(`/api/chats/${chatId}/checkpoints/put-back`, { body: { tree: done.undo, paths: done.files.map((f) => f.path) } });
          setBanner({ level: "info", text: `Put ${n} ${n === 1 ? "file" : "files"} back as they were` });
        } catch (e) {
          fail(e);
        }
      };
      if (alsoFork) await forkChat(through - 1);
      setBanner({
        level: "info",
        text: `Undid changes to ${n} ${n === 1 ? "file" : "files"} from turn ${through} on${alsoFork ? ", and forked the chat before it" : ". The agent was not told"}`,
        action: { label: "Put back", run: () => void putBack() },
      });
    } catch (e) {
      setRestoreTurn(null);
      fail(e);
    }
  };

  /**
   * Retry or edit prompt `through`: replaced in place where the harness can
   * (Hermes), else run in a branch from before it (a fork; a fresh chat for
   * the first prompt), keeping the model. `undoFiles` first puts the files
   * back as they were before that prompt.
   */
  const rerun = async (through: number, item: UserItem, text: string, undoFiles: boolean): Promise<boolean> => {
    if (!chat) return false;
    const from = chat;
    try {
      if (undoFiles && from.checkpoints.includes(through)) {
        const preview = await api<CheckpointPreview>(`/api/chats/${from.chatId}/checkpoints/${through}`);
        if (preview.files.length > 0) await api(`/api/chats/${from.chatId}/checkpoints/${through}/restore`, { body: { paths: preview.files.map((f) => f.path) } });
      }
      const images = item.images?.length ? await sentAttachments(item.images) : [];
      const withImages = images.length > 0 ? { images } : {};
      if (from.capabilities.supportsRewind) {
        await api(`/api/chats/${from.chatId}/rewind`, { body: { turn: through, text, ...withImages } });
        setBanner(undoFiles ? { level: "info", text: `Undid the file changes from message ${through} on` } : null);
        return true;
      }
      const next =
        through > 1
          ? await api<ChatSnapshot>(`/api/chats/${from.chatId}/fork`, { body: { through: through - 1 } })
          : await api<ChatSnapshot>("/api/chats", { body: { harnessId: from.harnessId, workspaceId: from.workspace.id } });
      const patch: ConfigPatch = {};
      if (from.capabilities.supportsModelSelection && from.config.model && next.config.model !== from.config.model && next.config.models.some((m) => m.key === from.config.model)) {
        patch.model = from.config.model;
      }
      if (from.capabilities.supportsThinkingLevel && from.config.thinkingLevel && next.config.thinkingLevel !== from.config.thinkingLevel) {
        patch.thinkingLevel = from.config.thinkingLevel;
      }
      const mode = from.config.permissionMode;
      if (from.capabilities.supportsPermissionMode && mode && next.config.permissionMode !== mode && next.config.permissionModes?.some((m) => m.id === mode)) {
        patch.permissionMode = mode;
      }
      if (patch.model || patch.thinkingLevel || patch.permissionMode) await api(`/api/chats/${next.chatId}/config`, { method: "PATCH", body: patch }).catch(() => undefined);
      showChat(next);
      await api(`/api/chats/${next.chatId}/messages`, { body: { text, mode: "normal", ...withImages } });
      setBanner({
        level: "info",
        text: `Branched from before message ${through}${undoFiles ? ", with its file changes undone" : ""}; the original chat is still in the sidebar`,
      });
      void refreshSessions();
      return true;
    } catch (e) {
      fail(e);
      return false;
    }
  };

  /** Continue this chat in another harness; the draft (if any) seeds its first turn. */
  const handoffChat = async (harnessId: string, draft: string): Promise<void> => {
    if (!chat) return;
    const prompt = draft.trim() ? draft : undefined;
    try {
      const next = await api<ChatSnapshot>(`/api/chats/${chat.chatId}/handoff`, { body: { harness: harnessId, ...(prompt ? { prompt } : {}) } });
      const target = boot?.harnesses.find((h) => h.id === harnessId);
      const turns = chat.items.filter((i) => i.kind === "user" && !i.command).length;
      showChat(next);
      // A harness that keeps past turns got a copy; any other was briefed in its first prompt.
      const how = target?.capabilities.supportsHandoff ? "" : ` from a summary of ${turns} ${turns === 1 ? "turn" : "turns"}`;
      setBanner({ level: "info", text: `Continued in ${target?.displayName ?? harnessId}${how} · model reset to default` });
      void refreshSessions();
    } catch (e) {
      fail(e);
    }
  };
  const answer = async (requestId: string, a: InteractionAnswer) => {
    if (!chat) return;
    try {
      await api(`/api/chats/${chat.chatId}/requests/${encodeURIComponent(requestId)}`, { body: { answer: a } });
    } catch (e) {
      // 409 = already resolved (another client answered): drop the card and say
      // so quietly. Any other failure may still be pending: keep the card.
      const resolved = e instanceof ApiError && e.status === 409;
      fail(e, resolved ? "info" : "error");
      if (resolved) setChat((prev) => (prev ? { ...prev, pending: prev.pending.filter((p) => p.id !== requestId) } : prev));
    }
  };

  const configure = async (patch: ConfigPatch) => {
    if (!chat) return;
    try {
      await api(`/api/chats/${chat.chatId}/config`, { method: "PATCH", body: patch });
    } catch (e) {
      fail(e);
    }
  };

  /** A fresh harness process on the same session (after a config, skill, or MCP change). */
  const restartChat = async () => {
    if (!chat) return;
    try {
      showChat(await api<ChatSnapshot>(`/api/chats/${chat.chatId}/restart`, { method: "POST" }));
    } catch (e) {
      fail(e);
    }
  };
  const compact = async () => {
    setMenuOpen(false);
    if (!chat) return;
    try {
      await api(`/api/chats/${chat.chatId}/compact`, { body: {} });
    } catch (e) {
      fail(e);
    }
  };

  /** Mark changes show an Undo (and Ctrl+Z) while their card does. */
  const showToast = (text: string, undo: () => void) => toasts.push({ key: "undo", text, ms: 8000, action: { label: "Undo", run: undo } });
  const undoToast = toasts.stack.find((t) => t.action && !t.leaving);

  const searchWorkspace = chat?.workspace ?? workspace;
  // A file link's hover preview reads from the same project the viewer opens in.
  useEffect(() => {
    setPreviewWorkspace(searchWorkspace?.id ?? null);
  }, [searchWorkspace?.id]);
  keysRef.current = {
    step: (step) => stepVisits(step),
    reopen: () => reopenClosedTab(),
    undo: undoToast?.action
      ? () => {
          undoToast.action?.run();
          toasts.dismiss(undoToast.id);
        }
      : null,
    search: () => searchWorkspace && setSearchOpen(true),
    searchAll: () => setChatSearch((q) => (q === null ? "" : null)),
  };

  const markSessionAs = async (s: ProjectSession, change: MarkChange) => {
    const before: SessionMarkState = {
      ...(s.pinned ? { pinned: true } : {}),
      ...(s.archived ? { archived: true } : {}),
      ...(s.settled ? { settled: true } : {}),
      ...(s.snoozedUntil ? { snoozedUntil: s.snoozedUntil } : {}),
    };
    try {
      markSession(s.id, await api<SessionMarkState>("/api/sessions/marks", { body: { sessionId: s.id, ...change } }));
      showToast(markToast(change, s.title), () => {
        void api<SessionMarkState>("/api/sessions/marks", { body: { sessionId: s.id, ...before, replace: true } }).then(
          (mark) => markSession(s.id, mark),
          (e: unknown) => fail(e),
        );
      });
    } catch (e) {
      fail(e);
    }
  };

  /** One change for a selection: one bulk call, one toast, and an undo that puts each back. */
  const markMany = async (ids: string[], change: MarkChange) => {
    if (ids.length === 0) return;
    const before = ids.map((id) => overview.sessions.find((x) => x.id === id));
    try {
      const result = await api<{ marks: Record<string, SessionMarkState> }>("/api/sessions/marks/bulk", { body: { ids, ...change } });
      for (const [id, mark] of Object.entries(result.marks)) markSession(id, mark);
      showToast(`${ids.length} ${ids.length === 1 ? "session" : "sessions"} updated`, () => {
        // A bulk replace cannot restore different before-marks, so undo is one call each.
        ids.forEach((id, index) => {
          const s = before[index];
          const mark: SessionMarkState = {
            ...(s?.pinned ? { pinned: true } : {}),
            ...(s?.archived ? { archived: true } : {}),
            ...(s?.settled ? { settled: true } : {}),
            ...(s?.snoozedUntil ? { snoozedUntil: s.snoozedUntil } : {}),
          };
          void api<SessionMarkState>("/api/sessions/marks", { body: { sessionId: id, ...mark, replace: true } })
            .then((restored) => markSession(id, restored))
            .catch(() => undefined);
        });
      });
    } catch (e) {
      fail(e);
    }
  };

  const exportChat = () => {
    setMenuOpen(false);
    if (!chat) return;
    const name = boot?.harnesses.find((h) => h.id === chat.harnessId)?.displayName ?? chat.harnessId;
    downloadText(exportFileName(chat.title), chatMarkdown(chat, name));
  };

  /** The shared look, as Settings saves it: config.yml's theme, for every device. */
  const chooseTheme = async (theme: ThemeChoice) => {
    try {
      const next = await api<ServerSettings>("/api/settings", { method: "PUT", body: { theme } });
      setBoot((b) => (b ? { ...b, ui: { ...b.ui, theme: next.values.theme, textScale: next.values.textScale, chatWidth: next.values.chatWidth, density: next.values.density, autocollapseSidebar: next.values.autocollapseSidebar } } : b));
    } catch (e) {
      fail(e);
    }
  };

  const paletteItems = (): PaletteItem[] => {
    if (!boot) return [];
    const items: PaletteItem[] = [];
    const harnessName = (id: string) => boot.harnesses.find((h) => h.id === id)?.displayName ?? id;
    const busy = chat ? isBusy(chat.status) : false;
    const idle = chat ? chat.status === "idle" || chat.status === "error" : false;
    const waitIdle = idle ? undefined : "Wait until the agent is idle";
    items.push({ id: "new", section: "Actions", label: "New chat", hint: workspace?.name, run: () => showStart() });
    items.push({
      id: "new-tab",
      section: "Actions",
      label: "New chat in a new tab",
      disabled: newChatDisabled ?? undefined,
      searchOnly: true,
      run: newTab,
    });
    if (chat && chat.status !== "disposed") {
      if (busy) items.push({ id: "stop", section: "Actions", label: "Stop", run: stop });
      if (chat.capabilities.supportsRename) items.push({ id: "rename", section: "Actions", label: "Rename chat", run: () => setRenameOpen(true) });
      if (chat.capabilities.supportsCompact) items.push({ id: "compact", section: "Actions", label: "Compact context", disabled: chat.status === "idle" ? undefined : "Wait until the agent is idle", run: () => void compact() });
      items.push({ id: "restart", section: "Actions", label: "Restart agent session", hint: "New process, same conversation", disabled: chat.status === "idle" || chat.status === "error" ? undefined : "Wait until the agent is idle", run: () => void restartChat() });
      items.push({ id: "review", section: "Actions", label: "Review changes", hint: changedFiles > 0 ? `${changedFiles} ${changedFiles === 1 ? "file" : "files"}` : undefined, disabled: changedFiles > 0 ? undefined : "No files changed yet", run: () => setReviewOpen(true) });
      items.push({
        id: "timeline",
        section: "Actions",
        label: "File timeline",
        hint: chat.checkpoints.length > 0 ? `${chat.checkpoints.length} ${chat.checkpoints.length === 1 ? "checkpoint" : "checkpoints"}` : undefined,
        keywords: "checkpoints compare history diff",
        disabled: chat.checkpoints.length > 0 ? undefined : "No checkpoints yet (one is taken before each prompt in a git repository)",
        run: () => setTimelineOpen(true),
      });
      items.push({ id: "export", section: "Actions", label: "Export as Markdown", disabled: hasPrompt ? undefined : "Nothing to export yet", run: exportChat });
      items.push({ id: "close", section: "Actions", label: "Close chat", run: () => void closeChat() });
    }
    items.push({
      id: "beside",
      section: "Actions",
      label: side ? "Close the chat beside" : "Open a chat beside this one",
      hint: "split",
      keywords: "split side by side compare two",
      disabled: wide ? undefined : "Needs a wider window",
      run: () => (side ? setSide(null) : void openBeside()),
    });
    items.push({ id: "usage", section: "Actions", label: "Usage across chats", hint: "tokens, cost", keywords: "spend dashboard stats", run: () => setUsageOpen(true) });
    items.push({ id: "routines", section: "Actions", label: "Routines…", hint: "scheduled prompts", keywords: "schedule cron jobs recurring", run: () => setRoutinesOpen(true) });
    items.push({ id: "reload-app", section: "Actions", label: "Reload the app", hint: "after an update", keywords: "refresh update deploy new build", run: () => void reloadApp() });
    items.push({ id: "prompts", section: "Actions", label: "Saved prompts…", hint: "#", keywords: "templates snippets", run: () => setPromptsOpen({}) });
    items.push({ id: "open-file", section: "Actions", label: "Open a file…", hint: searchWorkspace?.name, keywords: "view read go to", disabled: searchWorkspace ? undefined : "Choose a project first", run: () => setViewer({ request: null }) });
    items.push({ id: "search-all", section: "Actions", label: "Search every chat", hint: shortcutHint("history-search"), keywords: "history find", run: () => setChatSearch("") });
    items.push({
      id: "search",
      section: "Actions",
      label: "Search in project",
      hint: shortcutHint("search"),
      disabled: searchWorkspace ? undefined : "Choose a project first",
      run: () => setSearchOpen(true),
    });
    items.push({ id: "folder", section: "Actions", label: "Choose project folder…", run: () => setPickerOpen(true) });
    items.push({ id: "reopen", section: "Actions", label: "Reopen closed tab", hint: shortcutHint("reopen"), disabled: closedTabs.current.length ? undefined : "No tab closed yet", searchOnly: true, run: reopenClosedTab });
    const shownTab = tabState.tabs[tabState.active];
    if (shownTab) {
      items.push({
        id: "pin-tab",
        section: "Actions",
        label: shownTab.pinned ? "Unpin tab" : "Pin tab",
        hint: "this tab",
        keywords: "tabs keep left strip",
        searchOnly: true,
        run: () => pinTabAt(tabState.active, !shownTab.pinned),
      });
    }
    items.push({ id: "back", section: "Actions", label: "Back to the previous chat", hint: shortcutHint("back"), searchOnly: true, disabled: visits.current.at > 0 ? undefined : "Nothing before this", run: () => stepVisits(-1) });
    items.push({ id: "forward", section: "Actions", label: "Forward to the next chat", hint: shortcutHint("forward"), searchOnly: true, disabled: visits.current.at < visits.current.list.length - 1 ? undefined : "Nothing after this", run: () => stepVisits(1) });
    items.push({ id: "sidebar", section: "Actions", label: collapsed ? "Show sidebar" : "Hide sidebar", searchOnly: true, run: () => collapseSidebar(!collapsed) });
    items.push({ id: "settings", section: "Actions", label: "Settings", run: () => setSettingsOpen(true) });
    items.push({ id: "shortcuts", section: "Actions", label: "Keyboard shortcuts", hint: shortcutHint("shortcuts"), keywords: "keys help", run: () => setShortcutsOpen(true) });
    items.push({ id: "pair", section: "Actions", label: "Pair a phone", searchOnly: true, run: () => setPairOpen(true) });

    // Pinned first, then newest; the eight at the top show before anything is typed.
    const sessions = [...overview.sessions.filter((x) => x.pinned), ...overview.sessions.filter((x) => !x.pinned)];
    sessions.forEach((x, i) => {
      const project = overview.workspaces.find((w) => w.id === x.workspaceId)?.name ?? "";
      items.push({
        id: `s:${x.id}`,
        section: "Sessions",
        label: x.title,
        hint: project,
        keywords: `${harnessName(x.harnessId)}${x.pinned ? " pinned" : ""}${x.archived ? " archived" : ""}`,
        searchOnly: i >= 8 || x.archived,
        current: (chat?.sessionId !== null && chat?.sessionId === x.id) || (x.liveChatId !== undefined && x.liveChatId === chat?.chatId),
        run: () => void openSession(x),
      });
    });

    if (chat && chat.status !== "disposed" && chat.capabilities.supportsModelSelection) {
      for (const m of chat.config.models) {
        items.push({ id: `m:${m.key}`, section: "Model", label: m.name, hint: m.provider, keywords: m.key, searchOnly: true, current: m.key === chat.config.model, disabled: waitIdle, run: () => void configure({ model: m.key }) });
      }
    }
    if (chat && chat.status !== "disposed" && chat.capabilities.supportsThinkingLevel) {
      for (const level of chat.config.thinkingLevels) {
        items.push({ id: `t:${level}`, section: "Thinking", label: `Thinking: ${level}`, searchOnly: true, current: level === chat.config.thinkingLevel, disabled: waitIdle, run: () => void configure({ thinkingLevel: level }) });
      }
    }
    // Mid-run too, unlike model and thinking.
    if (chat && chat.status !== "disposed" && chat.capabilities.supportsPermissionMode) {
      for (const mode of chat.config.permissionModes ?? []) {
        items.push({
          id: `p:${mode.id}`,
          section: "Permissions",
          label: `Permissions: ${mode.label}`,
          keywords: `${mode.id} ${mode.description}`,
          searchOnly: true,
          current: mode.id === chat.config.permissionMode,
          run: () => void configure({ permissionMode: mode.id }),
        });
      }
    }
    for (const h of boot.harnesses) {
      items.push({
        id: `h:${h.id}`,
        section: "Harness",
        label: `Harness: ${h.displayName}`,
        hint: "for new chats",
        searchOnly: true,
        current: h.id === harnessId,
        disabled: h.available ? undefined : (h.reason ?? "Not available"),
        run: () => chooseHarness(h.id),
      });
    }
    const themes: Array<[ThemeChoice, string]> = [
      ["system", "System"],
      ["light", "Light"],
      ["dark", "Dark"],
      ...(themeInfo?.source === "file" ? ([["base16", themeInfo.name ?? "Base16 scheme"]] as Array<[ThemeChoice, string]>) : []),
    ];
    for (const [choice, label] of themes) {
      items.push({ id: `theme:${choice}`, section: "Theme", label: `Theme: ${label}`, hint: "every device", searchOnly: true, current: choice === themeMode, run: () => void chooseTheme(choice) });
    }
    return items;
  };

  const closeChat = async () => {
    setMenuOpen(false);
    if (!chat) return;
    // Closed on purpose: the server's "gone" must not bring it back through its tab.
    resumedGone.current.add(chat.chatId);
    const index = tabsRef.current.tabs.findIndex((t) => t.chatId === chat.chatId);
    try {
      await api(`/api/chats/${chat.chatId}/dispose`, { body: {} });
    } catch {
      // already gone
    }
    if (index >= 0) closeTabAt(index);
    else {
      setChat(null);
      setHash(null);
    }
    void refreshSessions();
  };

  // ---- render ---------------------------------------------------------------------------

  const collapsed = sidebarCollapsed || (narrow && !openedWhileNarrow && (boot?.ui.autocollapseSidebar ?? true));

  // Above the early returns: a hook must run on every render.
  const resumable = chat?.capabilities.supportsResumeCommand && chat.sessionId ? { harnessId: chat.harnessId, sessionId: chat.sessionId, workspaceId: chat.workspace.id } : null;
  const { resume, why: noResume } = useResumeCommand(menuOpen ? resumable : null);
  const copyResume = () => {
    if (!resume) return;
    setMenuOpen(false);
    void copyResumeCommand(resume).then((text) => setBanner({ level: "info", text, ...(resume.live ? { action: { label: "Close chat", run: () => void closeChat() } } : {}) }));
  };

  if (signedOut) {
    return <LoginForm />;
  }
  if (bootError) {
    return (
      <div className="fullscreen-message">
        <h1>Cannot reach the server</h1>
        <p>{bootError}</p>
        <button type="button" className="btn" onClick={() => window.location.reload()}>
          Retry
        </button>
      </div>
    );
  }
  if (!boot) {
    return (
      <div className="fullscreen-message">
        <Loader label="Connecting to the server" />
      </div>
    );
  }

  const currentHarness = boot.harnesses.find((h) => h.id === harnessId);
  // The start screen needs no folder to show; only a missing harness keeps a new chat from starting.
  const newChatDisabled = !currentHarness
    ? "No harness is available."
    : !currentHarness.available
      ? (currentHarness.reason ?? `${currentHarness.displayName} is not installed.`)
      : null;
  const chatHarness = chat ? boot.harnesses.find((h) => h.id === chat.harnessId) : undefined;
  const hasPrompt = chat ? chat.items.some((i) => i.kind === "user") : false;
  /** The chat being opened names the header until it is shown. */
  const heading = splash && !splash.leaving ? splash.target : null;
  // The app's name is the sidebar's; the header names what is open, or nothing on
  // the start screen (its own heading is right below).
  const headerTitle = chat ? chat.title || "New chat" : harnessId === "awui" || !workspace ? "" : workspace.name;

  return (
    <div
      className={`app${collapsed ? " is-collapsed" : ""}${sidebarToggling ? " is-toggling" : ""}${boot && !boot.ui.showStatusBar ? " no-status-bar" : ""}`}
      style={{ ["--sidebar-w" as string]: `${sidebarWidth}px` }}
    >
      <Sidebar
        limits={limits}
        onMarkMany={(ids, change) => void markMany(ids, change)}
        resizer={<SidebarResizer width={sidebarWidth} onResize={setSidebarWidth} onCommit={commitSidebarWidth} />}
        footer={
          <button
            type="button"
            className="usage-link"
            onClick={() => {
              setUsageOpen(true);
              setDrawerOpen(false);
            }}
          >
            <IconGauge size={13} />
            <span className="usage-link-label">Usage</span>
            <LimitsSummary limits={limits} />
          </button>
        }
        tabs={
          tabState.tabs.length >= 2 ? (
            <nav className="drawer-tabs" aria-label="Open tabs">
              <p className="drawer-tabs-head">Open tabs</p>
              <ul>
                {tabState.tabs.map((tab, i) => (
                  <li key={tab.key} className={i === tabState.active ? "is-active" : undefined}>
                    <button
                      type="button"
                      className="drawer-tab"
                      aria-current={i === tabState.active ? "page" : undefined}
                      onClick={() => {
                        activateTab(i);
                        setDrawerOpen(false);
                      }}
                    >
                      <span className="drawer-tab-title">{tab.title || "New chat"}</span>
                      <span className="drawer-tab-harness">{boot.harnesses.find((h) => h.id === tab.harnessId)?.displayName ?? tab.harnessId}</span>
                    </button>
                    {tab.pinned ? null : (
                      <button type="button" className="icon-btn drawer-tab-close" aria-label={`Close tab ${tab.title || "New chat"}`} onClick={() => closeTabAt(i)}>
                        ×
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </nav>
          ) : null
        }
        open={drawerOpen}
        harnesses={boot.harnesses}
        harnessId={harnessId}
        onHarness={chooseHarness}
        workspace={workspace}
        onNewChat={newChatInFolder}
        newChatDisabled={newChatDisabled}
        canStartChat={Boolean(currentHarness?.available) && !opening}
        onNewChatIn={(ws) => void startIn(ws)}
        overview={overview}
        sessionsError={sessionsError}
        sessionsLoading={sessionsLoading}
        query={query}
        onQuery={setQuery}
        onSearchAll={(q) => {
          setChatSearch(q);
          setDrawerOpen(false);
        }}
        // While a chat opens, its row is the current one already (its tab is in place). A room is not a session row.
        activeSessionId={room.roomId ? null : heading ? (tabState.tabs[tabState.active]?.sessionId ?? null) : (chat?.sessionId ?? null)}
        activeChatId={room.roomId ? null : heading ? (tabState.tabs[tabState.active]?.chatId ?? null) : chatId}
        activeStatus={room.roomId ? null : heading ? null : (chat?.status ?? null)}
        rooms={roomsList}
        roomsError={roomsError}
        roomsLoading={roomsLoading}
        activeRoomId={room.roomId}
        onOpenRoom={openRoom}
        onNewRoom={() => setRoomEditor({ mode: "create" })}
        onRefreshRooms={() => void refreshRooms()}
        onOpenSession={(s, newTab) => {
          leaveRoom();
          void openSession(s, { newTab });
        }}
        onWarmSession={warmSession}
        onOpenBeside={
          wide
            ? (s) => {
                leaveRoom();
                void openBeside(s);
              }
            : undefined
        }
        onMarkSession={(s, change) => void markSessionAs(s, change)}
        onReorderSessions={(harnessId, workspaceId, ids) => {
          const before = overview.orders?.[`${harnessId}:${workspaceId}`];
          orderSessions(`${harnessId}:${workspaceId}`, ids);
          api<{ ids: string[] }>("/api/sessions/order", { body: { harnessId, workspaceId, ids } }).catch((e: unknown) => {
            orderSessions(`${harnessId}:${workspaceId}`, before ?? []);
            fail(e);
          });
        }}
        onNotice={(text) => setBanner({ level: "info", text })}
        onRefresh={() => void refreshSessions()}
        onSettings={() => {
          setSettingsOpen(true);
          setDrawerOpen(false);
        }}
        onClose={() => setDrawerOpen(false)}
        onCollapse={() => collapseSidebar(true)}
      />
      {routinesOpen && boot ? <RoutinesDialog harnesses={available} workspaces={overview.workspaces} onClose={() => setRoutinesOpen(false)} /> : null}
      {settingsOpen ? (
        <SettingsDialog
          scheme={themeInfo?.source === "file" ? { name: themeInfo.name } : null}
          onPair={() => {
            setSettingsOpen(false);
            setPairOpen(true);
          }}
          signedInAs={boot.auth.mode === "password" ? boot.auth.username : null}
          onSignOut={() => {
            void api("/api/logout", { body: {} }).finally(() => window.location.reload());
          }}
          version={boot.version}
          notify={notify}
          onToggleNotify={toggleNotify}
          onTestNotify={testNotify}
          onUiSaved={(ui) => setBoot((b) => (b ? { ...b, ui: { ...b.ui, ...ui } } : b))}
          onClose={() => setSettingsOpen(false)}
        />
      ) : null}

      <main className="main">
        {tabState.tabs.length >= (narrow ? 2 : 1) ? (
          <TabStrip
            tabs={tabState.tabs}
            active={tabState.active}
            statusOf={tabStatus}
            harnessName={(id) => boot.harnesses.find((h) => h.id === id)?.displayName ?? id}
            onActivate={activateTab}
            onClose={closeTabAt}
            onMove={moveTabTo}
            onPin={pinTabAt}
            onNew={newTab}
            newDisabled={newChatDisabled !== null}
          />
        ) : null}
        <header className="chat-header">
          <button type="button" className="icon-btn drawer-open" aria-label="Open menu" aria-expanded={drawerOpen} onClick={() => setDrawerOpen(true)}>
            <IconMenu size={18} />
          </button>
          {collapsed ? (
            <button type="button" className="icon-btn sidebar-expand" aria-label="Expand sidebar" title="Expand sidebar" onClick={() => collapseSidebar(false)}>
              <IconSidebar size={16} />
            </button>
          ) : null}
          <div className="chat-title">
            {room.roomId ? (
              <>
                <h1>{room.state?.room.name ?? "Room"}</h1>
                <div className="chat-sub">
                  <span className="badge badge-room">Room</span>
                  {room.state ? <span className="chat-path">{room.state.room.workspaceName}</span> : null}
                  {room.state?.room.archived ? <span className="room-tag is-archived">Archived</span> : null}
                </div>
              </>
            ) : heading ? (
              <>
                <h1>{heading.title}</h1>
                <div className="chat-sub">
                  <span className="badge badge-harness" style={harnessColor(heading.harnessId)}>
                    {heading.harnessName}
                  </span>
                  <span className="status status-starting">Opening</span>
                  {heading.project ? <span className="chat-path">{heading.project}</span> : null}
                </div>
              </>
            ) : (
              <>
                {headerTitle ? <h1>{headerTitle}</h1> : null}
                {chat ? (
                  <div className="chat-sub">
                    <span className="badge badge-harness" style={harnessColor(chat.harnessId)}>
                      {chatHarness?.displayName ?? chat.harnessId}
                    </span>
                    <span className={`status status-${chat.status}`} data-testid="chat-status">
                      <StatusWord text={STATUS_LABEL[chat.status] ?? chat.status} />
                    </span>
                    {chat.harnessId !== "awui" ? (
                      <span className="chat-path" title={chat.workspace.path}>
                        {chat.workspace.name}
                      </span>
                    ) : null}
                    {chat.viewers >= 2 ? (
                      <span className="chat-viewers" data-testid="chat-viewers" title={`${chat.viewers} devices have this chat open; you see the same run on each`}>
                        {chat.viewers} devices
                      </span>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
          {chat && !room.roomId && changedFiles > 0 ? (
            <button type="button" className="btn btn-small review-open" title="Review the changes and comment on them" onClick={() => setReviewOpen(true)}>
              <IconEdit size={14} /> <span className="review-label">Review</span> <span className="review-count">{changedFiles}</span>
            </button>
          ) : null}
          {wide && !room.roomId && (chat || side) ? (
            <button
              type="button"
              className={`icon-btn split-toggle${side ? " is-on" : ""}`}
              aria-label={side ? "Close the chat beside" : "Open a chat beside"}
              aria-pressed={side !== null}
              title={side ? "Close the chat beside" : "Open a chat beside this one"}
              onClick={() => (side ? setSide(null) : void openBeside())}
            >
              <IconSplit size={16} />
            </button>
          ) : null}
          <button type="button" className="icon-btn palette-open" aria-label="Commands" title={`Commands (${shortcutHint("palette")})`} onClick={() => setPaletteOpen(true)}>
            <IconSearch size={16} />
          </button>
          {chat && !room.roomId && chat.status !== "disposed" ? (
            <div className="menu">
              <button type="button" className="icon-btn" aria-label="Chat actions" aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((v) => !v)}>
                <IconMore size={18} />
              </button>
              {menuOpen ? (
                <>
                  <div className="menu-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />
                  <ul className="menu-list" role="menu" onKeyDown={(e) => e.key === "Escape" && setMenuOpen(false)}>
                    {chat.capabilities.supportsRename ? (
                      <li role="none">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            setRenameOpen(true);
                          }}
                        >
                          Rename
                        </button>
                      </li>
                    ) : null}
                    {chat.capabilities.supportsCompact ? (
                      <li role="none">
                        <button type="button" role="menuitem" disabled={chat.status !== "idle"} onClick={() => void compact()}>
                          Compact context
                        </button>
                      </li>
                    ) : null}
                    <li role="none" className="menu-phone-only">
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          setMenuOpen(false);
                          setPaletteOpen(true);
                        }}
                      >
                        Search and commands
                      </button>
                    </li>
                    {chat.checkpoints.length > 0 ? (
                      <li role="none">
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            setMenuOpen(false);
                            setTimelineOpen(true);
                          }}
                        >
                          File timeline
                        </button>
                      </li>
                    ) : null}
                    <li role="none">
                      <button type="button" role="menuitem" disabled={!hasPrompt} onClick={exportChat}>
                        Export as Markdown
                      </button>
                    </li>
                    {resumable ? (
                      <li role="none">
                        <button type="button" role="menuitem" disabled={!resume} title={resume?.command ?? noResume ?? undefined} onClick={copyResume}>
                          Copy resume command
                        </button>
                      </li>
                    ) : null}
                    <li role="none">
                      <button type="button" role="menuitem" onClick={() => void closeChat()}>
                        Close chat
                      </button>
                    </li>
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}
        </header>

        {chat && conn !== "connected" && conn !== "connecting" ? (
          <div className={`conn-banner conn-${conn}`} role="status">
            {CONN_BANNER[conn]}…
          </div>
        ) : null}
        <UpdateBanner />
        {chat && chat.config.models.length === 0 && chat.capabilities.supportsModelSelection ? (
          <div className="banner banner-warning">
            {chatHarness?.setupCommand ? (
              <>
                No models are available. Run <code>{chatHarness.setupCommand}</code> in a terminal and log in to a provider.
              </>
            ) : (
              <>No models are available. Log in to a provider for {chatHarness?.displayName ?? chat.harnessId}, then reopen this chat.</>
            )}
          </div>
        ) : null}
        {banner ? (
          <div className={`banner banner-${banner.level}`} role={banner.level === "error" ? "alert" : "status"}>
            <span>{banner.text}</span>
            {banner.action ? (
              <button type="button" className="btn btn-small banner-action" onClick={banner.action.run}>
                {banner.action.label}
              </button>
            ) : null}
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setBanner(null)}>
              ✕
            </button>
          </div>
        ) : null}

        <div className={`chat-split${side ? " is-split" : ""}`}>
          <div className="chat-body" data-pane="main">
            {room.roomId ? (
              <RoomView
                key={room.roomId}
                roomId={room.roomId}
                state={room.state}
                gone={room.gone}
                conn={room.conn}
                boot={boot}
                bots={botsList}
                workspacePath={roomWorkspacePath}
                onSend={sendToRoom}
                onAnswer={answerInRoom}
                onStop={stopRoom}
                onCancelQueued={cancelQueuedInRoom}
                onLoadOlder={loadOlderRoomRecords}
                onEditRoom={() => setRoomEditor({ mode: "edit" })}
                onRoom={applyRoom}
                onExport={() => {
                  if (room.roomId) downloadRoomExport(room.roomId);
                }}
                onNotice={(text) => setBanner({ level: "info", text })}
                onNewBot={() => setBotEditor({ botId: null })}
                onEditBot={(botId) => setBotEditor({ botId })}
                onLeave={() => openRoomHash(null)}
              />
            ) : chat && !hasPrompt ? (
              <div className="hero">
                <div className="hero-inner">
                  {chat.items.length > 0 ? (
                    <div className="hero-notices">
                      {chat.items.map((item) =>
                        item.kind === "notice" ? (
                          <div key={item.id} className={`notice-row notice-${item.level}`}>
                            <span className="notice-text">{item.text}</span>
                          </div>
                        ) : null,
                      )}
                    </div>
                  ) : null}
                  <h2 className="hero-title">
                    {chat.harnessId === "awui" ? (
                      <>Ask anything</>
                    ) : (
                      <>
                        What should {chatHarness?.displayName ?? "the agent"} do in <span className="hero-project">{chat.workspace.name}</span>?
                      </>
                    )}
                  </h2>
                  <p className="hero-sub muted">{chat.harnessId === "awui" ? "It reads, searches, and computes — it never edits your files." : "It runs with its normal tools, as you, in this folder."}</p>
                  {chat.gone ? <div className="banner banner-info">{chat.gone}</div> : null}
                  <Composer
                    key={chat.chatId}
                    hero
                    chat={chat}
                    harnesses={boot.harnesses}
                    maxChars={boot.limits.maxMessageChars}
                    placeholder={`Ask ${chatHarness?.displayName ?? "the agent"} to…`}
                    onSend={send}
                    onRefreshModels={refreshModels}
                    onStop={stop}
                    onAnswer={answer}
                    onConfig={configure}
                    onHandoff={(id, draft) => handoffChat(id, draft)}
                    onNewChat={() => void newChat(chat.workspace, { newTab: true })}
                    limits={limits}
                  />
                </div>
              </div>
            ) : chat ? (
              <>
                <Conversation
                  chatId={chat.chatId}
                  items={chat.items}
                  status={chat.status}
                  workspace={chat.workspace.path}
                  canFork={chat.capabilities.supportsFork}
                  onFork={forkChat}
                  models={chat.config.models}
                  checkpoints={chat.checkpoints ?? []}
                  onRestore={setRestoreTurn}
                  onSend={(text) => void send(text, "normal")}
                  retryMode={retryMode(chat.status, chat.capabilities.supportsFollowUp)}
                  onRetryCall={(text) => void send(text, chat.status === "idle" || chat.status === "error" ? "normal" : "followUp")}
                  asking={chat.pending.length > 0}
                  findRequest={
                    findAsk && (chat.sessionId === findAsk.sessionId || chat.chatId === findAsk.chatId) ? { query: findAsk.query, nonce: findAsk.nonce, chatId: chat.chatId } : null
                  }
                  promptActions={{
                    inPlace: chat.capabilities.supportsRewind,
                    retry: (through, item) => void rerun(through, item, item.text, false),
                    edit: (through, item, text, undoFiles) => rerun(through, item, text, undoFiles),
                  }}
                />
                {chat.gone ? <div className="banner banner-info">{chat.gone}</div> : null}
                <Composer
                  key={chat.chatId}
                  chat={chat}
                  harnesses={boot.harnesses}
                  maxChars={boot.limits.maxMessageChars}
                  onSend={send}
                  onRefreshModels={refreshModels}
                  onStop={stop}
                  onAnswer={answer}
                  onConfig={configure}
                  onHandoff={(id, draft) => handoffChat(id, draft)}
                  onNewChat={() => void newChat(chat.workspace, { newTab: true })}
                  limits={limits}
                />
              </>
            ) : available.length === 0 ? (
              <div className="empty empty-main">
                <h2>No harness installed</h2>
                <p className="muted">Install Pi or omp, run it once in a terminal, and log in.</p>
              </div>
            ) : (
              <StartScreen
                key={startSeed ? "seeded" : "plain"}
                harnesses={boot.harnesses}
                harnessId={harnessId}
                onHarness={chooseHarness}
                models={startModels}
                model={startModel}
                defaultModel={startDefault}
                thinkingLevels={startLevels}
                thinking={startThinking}
                onThinking={setStartThinking}
                onModel={setStartModel}
                onRefreshModels={refreshStartModels}
                workspace={harnessId === "awui" ? null : workspace}
                recent={recent}
                onPickFolder={() => {
                  setPickerError(null);
                  setPickerOpen(true);
                }}
                onOpenRecent={(p) => void openWorkspace(p)}
                onShowSessions={narrow ? () => setDrawerOpen(true) : undefined}
                autoFocus={!window.matchMedia("(pointer: coarse)").matches}
                focusKey={startFocus}
                maxChars={boot.limits.maxMessageChars}
                busy={startBusy}
                initialText={startSeed?.text ?? ""}
                initialImages={startSeed?.images}
                initialLinkedHidden={startSeed?.hidden ?? null}
                onSend={startSend}
              />
            )}
            {splash ? <SwitchSplash target={splash.target} leaving={splash.leaving} /> : null}
          </div>
          {side ? (
            <SidePane
              key={side.n}
              initial={side.initial}
              overview={overview}
              harnesses={boot.harnesses}
              maxChars={boot.limits.maxMessageChars}
              limits={limits}
              main={{ chatId: chat?.chatId ?? null, sessionId: chat?.sessionId ?? null }}
              openSnapshot={async (s) => {
                const target = overview.workspaces.find((w) => w.id === s.workspaceId);
                if (!target) throw new Error("That chat's project is not open on the server");
                return (await fetchSession(s, target)).snapshot;
              }}
              onMakeMain={makeMain}
              onClose={() => setSide(null)}
              onSignedOut={() => setSignedOut(true)}
            />
          ) : null}
        </div>
      </main>
      <ToastStack
        toasts={toasts}
        onOpen={(t) => {
          const s = overview.sessions.find((x) => x.id === t.sessionId);
          if (s) void openSession(s);
        }}
      />
      <StatusBar
        conn={conn}
        chat={chat}
        room={
          room.roomId
            ? {
                conn: room.conn,
                name: room.state?.room.name ?? "Room",
                workspace: room.state?.room.workspaceName ?? "",
                status: room.state?.activeTurn ? (TURN_STATUS_LABEL[room.state.activeTurn.state] ?? room.state.activeTurn.state) : "Idle",
              }
            : null
        }
        harnessName={chatHarness?.displayName ?? null}
        version={boot.version}
      />

      {pickerOpen ? <WorkspacePicker recent={recent} onOpen={(p) => void openWorkspace(p)} onClose={() => setPickerOpen(false)} error={pickerError} /> : null}
      {roomEditor ? (
        <RoomEditor
          room={roomEditor.mode === "edit" ? room.state?.room ?? null : null}
          bots={botsList}
          workspaces={boardWorkspaces}
          onCreated={(snapshot) => {
            void refreshRooms();
            openRoom(snapshot.room.id);
          }}
          onSaved={applyRoom}
          onNewBot={() => setBotEditor({ botId: null })}
          onPickFolder={() => {
            setPickerError(null);
            setPickerOpen(true);
          }}
          onNotice={(text) => setBanner({ level: "info", text })}
          onClose={() => setRoomEditor(null)}
        />
      ) : null}
      {botEditor ? (
        <BotEditor
          bot={botEditor.botId ? botsList?.find((b) => b.id === botEditor.botId) ?? null : null}
          harnesses={boot.harnesses}
          workspaces={boardWorkspaces}
          defaultWorkspaceId={room.state?.room.workspaceId ?? workspace?.id ?? null}
          onSaved={() => void refreshBots()}
          onDeleted={() => void refreshBots()}
          onNotice={(text) => setBanner({ level: "info", text })}
          onClose={() => setBotEditor(null)}
        />
      ) : null}
      {renameOpen && chat ? (
        <RenameDialog
          initial={chat.title}
          onClose={() => setRenameOpen(false)}
          onSave={async (name) => {
            try {
              await api(`/api/chats/${chat.chatId}/rename`, { body: { name } });
              setRenameOpen(false);
            } catch (e) {
              fail(e);
              setRenameOpen(false);
            }
          }}
        />
      ) : null}
      {herdrAsk ? (
        <HerdrDialog
          session={herdrAsk.s}
          harnessName={boot.harnesses.find((h) => h.id === herdrAsk.s.harnessId)?.displayName ?? herdrAsk.s.harnessId}
          local={boot.auth.mode === "local"}
          onOpenHere={() => void openSession(herdrAsk.s, { newTab: herdrAsk.newTab, ignoreHerdr: true, ...(herdrAsk.workspace ? { workspace: herdrAsk.workspace } : {}) })}
          onClose={() => {
            setHerdrAsk(null);
            void refreshSessions();
          }}
        />
      ) : null}
      {restoreTurn !== null && chat ? (
        <RestoreDialog
          chatId={chat.chatId}
          through={restoreTurn}
          canFork={chat.capabilities.supportsFork}
          onRestore={(paths, alsoFork) => restoreFiles(restoreTurn, paths, alsoFork)}
          onClose={() => setRestoreTurn(null)}
        />
      ) : null}
      {reviewOpen && chat ? (
        <ReviewPanel
          key={chat.chatId}
          chatId={chat.chatId}
          items={chat.items}
          workspace={chat.workspace.path}
          sendLabel={chat.status === "idle" || chat.status === "error" ? "Send to the agent" : "Send as follow-up"}
          sendBlocked={
            chat.status === "disposed"
              ? "This chat is closed"
              : chat.status === "idle" || chat.status === "error" || chat.capabilities.supportsFollowUp
                ? null
                : "Wait until the agent is idle"
          }
          onSend={(prompt) => send(prompt, chat.status === "idle" || chat.status === "error" ? "normal" : "followUp")}
          onClose={() => setReviewOpen(false)}
        />
      ) : null}
      {paletteOpen ? <CommandPalette items={paletteItems()} onClose={() => setPaletteOpen(false)} /> : null}
      {shortcutsOpen ? <ShortcutSheet onClose={() => setShortcutsOpen(false)} /> : null}
      {promptsOpen ? <SavedPromptsDialog {...promptsOpen} onClose={() => setPromptsOpen(null)} /> : null}
      {timelineOpen && chat ? (
        <TimelineDialog
          key={chat.chatId}
          chatId={chat.chatId}
          onUndo={(turn) => {
            setTimelineOpen(false);
            setRestoreTurn(turn);
          }}
          onClose={() => setTimelineOpen(false)}
        />
      ) : null}
      {usageOpen ? (
        <UsageDialog harnesses={boot.harnesses} limits={limits} onOpenSession={(s, ws) => void openSession(s, ws ? { workspace: ws } : {})} onClose={() => setUsageOpen(false)} />
      ) : null}
      {viewer && searchWorkspace ? <FileViewer workspace={searchWorkspace} request={viewer.request} changes={chat ? changes : []} onClose={() => setViewer(null)} /> : null}
      {chatSearch !== null ? (
        <ChatSearch
          harnesses={boot.harnesses.filter((h) => h.available)}
          initialQuery={chatSearch}
          onOpen={(r, word, ws) => {
            setFindAsk({ query: word, nonce: Date.now(), sessionId: r.session.id, chatId: r.session.liveChatId ?? null });
            void openSession(r.session, ws ? { workspace: ws } : {});
          }}
          onClose={() => setChatSearch(null)}
        />
      ) : null}
      {searchOpen && searchWorkspace ? <ProjectSearch workspace={searchWorkspace} onClose={() => setSearchOpen(false)} /> : null}
      {pairOpen ? <PairDialog urls={boot.pairing.urls} username={boot.auth.username} onClose={() => setPairOpen(false)} /> : null}
    </div>
  );
}

/** Wide enough for a chat beside the main one. */
const SPLIT_QUERY = "(min-width: 1180px)";

/** What a mark change did, for its toast. */
function markToast(change: MarkChange, title: string): string {
  const name = `“${title.length > 40 ? `${title.slice(0, 39)}…` : title}”`;
  if (change.pinned !== undefined) return `${change.pinned ? "Pinned" : "Unpinned"} ${name}`;
  if (change.archived !== undefined) return `${change.archived ? "Archived" : "Unarchived"} ${name}`;
  if (change.settled !== undefined) return `${change.settled ? "Settled" : "Unsettled"} ${name}`;
  if (change.snoozedUntil) return `Snoozed ${name} until ${wakeLabel(change.snoozedUntil)}`;
  return `Woke ${name}`;
}

