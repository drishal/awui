// The sidebar's session list: full fetched rows, with immediate live metadata
// for the chat states driving background tab and needs-you indicators.
import { useCallback, useEffect, useRef, useState } from "react";
import type { Bootstrap, OverviewEvent, SessionMarkState, SessionsOverview, WorkspaceInfo } from "../shared/protocol.js";
import { api, errorText } from "./api.js";
import type { ChatState } from "./chat-state.js";
import { useOverviewStream } from "./overview-stream.js";
import { mergeSessionOverview } from "../shared/overview-events.js";

/** How often the session list refreshes while a herdr pane reports work. */
const HERDR_POLL_MS = 3000;

/** The App shares one event stream: its callback ref updates this overview and useRooms' summary list. */
export function useSessions({ boot, workspace, chat }: { boot: Bootstrap | null; workspace: WorkspaceInfo | null; chat: ChatState | null }) {
  const [overview, setOverview] = useState<SessionsOverview>({ workspaces: [], sessions: [], errors: [] });
  const [sessionsError, setSessionsError] = useState<string | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  // Every harness, every project; the sidebar filters by harness and groups by project.
  const sessionsRequest = useRef(0);
  const refreshSessions = useCallback(async () => {
    if (!boot) return;
    const seq = ++sessionsRequest.current;
    setSessionsLoading(true);
    try {
      // Passing the current project also re-registers it after a server restart.
      const next = await api<SessionsOverview>(`/api/sessions${workspace ? `?path=${encodeURIComponent(workspace.path)}` : ""}`);
      if (seq !== sessionsRequest.current) return;
      setOverview(next);
      setSessionsError(next.errors.length > 0 ? next.errors.join(" · ") : null);
    } catch (e) {
      if (seq === sessionsRequest.current) setSessionsError(errorText(e));
    } finally {
      if (seq === sessionsRequest.current) setSessionsLoading(false);
    }
  }, [boot, workspace]);

  useEffect(() => {
    void refreshSessions();
  }, [refreshSessions]);

  // Refresh the list when a run settles or the title changes.
  const settleKey = chat ? `${chat.chatId}:${chat.status === "idle" ? "idle" : "busy"}:${chat.title}:${chat.sessionId}` : "";
  const refreshTimer = useRef<number | null>(null);
  useEffect(() => {
    if (!settleKey) return;
    if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    refreshTimer.current = window.setTimeout(() => void refreshSessions(), 600);
    return () => {
      if (refreshTimer.current !== null) window.clearTimeout(refreshTimer.current);
    };
  }, [settleKey, refreshSessions]);

  // The overview stream carries awui's own chats, not herdr's panes: poll while
  // one is working so its sidebar mark follows what herdr reports.
  const herdrBusy = overview.sessions.some((s) => s.herdr?.status === "working" || s.herdr?.status === "blocked");
  useEffect(() => {
    if (!herdrBusy) return;
    const timer = window.setInterval(() => void refreshSessions(), HERDR_POLL_MS);
    return () => window.clearInterval(timer);
  }, [herdrBusy, refreshSessions]);

  useOverviewStream((event) => {
    if (event.type === "snapshot") {
      void refreshSessions();
      return;
    }
    setOverview((current) => {
      const next = mergeSessionOverview(current, event);
      if (next.refresh) void refreshSessions();
      return next.overview;
    });
  });

  /** Show a pin or archive at once; the server's answer replaces it (a later refresh agrees). */
  const markSession = useCallback((sessionId: string, mark: SessionMarkState) => {
    setOverview((o) => ({
      ...o,
      sessions: o.sessions.map((s) => {
        if (s.id !== sessionId) return s;
        const { pinned: _p, archived: _a, settled: _s, snoozedUntil: _z, ...rest } = s;
        return { ...rest, ...mark };
      }),
    }));
  }, []);

  /** Show a hand-made order at once; the server keeps it for every device. */
  const orderSessions = useCallback((key: string, ids: string[]) => {
    setOverview((o) => ({ ...o, orders: { ...o.orders, [key]: ids } }));
  }, []);

  return { overview, sessionsError, sessionsLoading, refreshSessions, markSession, orderSessions };
}
