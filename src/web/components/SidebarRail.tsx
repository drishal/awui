// The slim rail a collapsed sidebar leaves behind on a wide screen (≥ 1100 px): expand, new chat, search,
// and two counts that open what they count — the chats waiting on you, and the ones running. A narrower
// window keeps the full hide, where the chat header's expand button is the only way back. The rail reads the
// same overview the sidebar does and owns nothing: opening a row opens a chat, exactly as the list does.
import { useMemo, useRef, useState } from "react";
import type { ProjectSession, SessionsOverview } from "../../shared/protocol.js";
import { sidebarSections } from "../session-groups.js";
import { plainTitle } from "../plain-title.js";
import { useMenuKeys } from "../menu-focus.js";
import { useNow } from "../hooks.js";
import { shortcutHint } from "../shortcuts.js";
import { IconGauge, IconPlus, IconSearch, IconSettings, IconSidebar, IconWarning } from "../icons.js";
import { WorkingRing } from "./WorkingRing.js";

type Peek = { kind: "needs" | "working"; at: DOMRect };

export function SidebarRail({
  overview,
  harnessId,
  onExpand,
  onNewChat,
  onSearch,
  onOpenSession,
  onUsage,
  onSettings,
  themeMenu,
}: {
  overview: SessionsOverview;
  harnessId: string | null;
  onExpand: () => void;
  onNewChat: () => void;
  onSearch: () => void;
  onOpenSession: (s: ProjectSession) => void;
  /** The footer's Usage panel, and Settings: the rail's bottom cluster stands where the tray does. */
  onUsage: () => void;
  onSettings: () => void;
  /** The theme menu the footer draws (the same element: it places its own popover). */
  themeMenu?: React.ReactNode;
}) {
  const now = useNow(true, 60_000);
  // The two lists the counts stand for: the same reader the sidebar uses, over the same scope.
  const { needs, working } = useMemo(
    () =>
      sidebarSections(overview, {
        currentId: null,
        query: "",
        harnessId,
        showArchived: false,
        showSettled: false,
        showSnoozed: false,
        isActive: () => false,
        now,
      }),
    [overview, harnessId, now],
  );
  const [peek, setPeek] = useState<Peek | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const keys = useMenuKeys(list, { open: peek !== null, close: () => setPeek(null), opener });
  const openPeek = (kind: Peek["kind"], button: HTMLElement | null) => {
    if (!button) return;
    opener.current = button;
    const box = button.getBoundingClientRect();
    setPeek({ kind, at: box });
  };
  const rows = peek?.kind === "needs" ? needs : peek?.kind === "working" ? working : [];
  const projects = useMemo(() => new Map(overview.workspaces.map((w) => [w.id, w.name])), [overview.workspaces]);
  return (
    <aside className="sidebar-rail" aria-label="Sidebar (collapsed)">
      <button type="button" className="icon-btn sidebar-expand" aria-label="Expand sidebar" title="Expand sidebar" onClick={onExpand}>
        <IconSidebar size={16} />
      </button>
      <button type="button" className="icon-btn" aria-label="New chat" aria-keyshortcuts="Control+N Meta+N" title={`New chat (${shortcutHint("new")})`} onClick={onNewChat}>
        <IconPlus size={16} />
      </button>
      <button type="button" className="icon-btn" aria-label="Search and commands" aria-keyshortcuts="Control+K Meta+K" title={`Search and commands (${shortcutHint("palette")})`} onClick={onSearch}>
        <IconSearch size={16} />
      </button>
      <div className="rail-counts">
        {needs.length > 0 ? (
          <button type="button" className="icon-btn rail-btn" aria-label={`${needs.length} waiting on you`} aria-haspopup="menu" title={`${needs.length} waiting on you`} onClick={(e) => openPeek("needs", e.currentTarget)}>
            <IconWarning size={15} className="rail-warn" />
            <span className="rail-badge is-warn">{needs.length}</span>
          </button>
        ) : null}
        {working.length > 0 ? (
          <button type="button" className="icon-btn rail-btn" aria-label={`${working.length} running`} aria-haspopup="menu" title={`${working.length} running`} onClick={(e) => openPeek("working", e.currentTarget)}>
            <WorkingRing colored={false} />
            <span className="rail-badge">{working.length}</span>
          </button>
        ) : null}
      </div>
      {peek ? (
        <>
          <div className="menu-backdrop" onClick={() => setPeek(null)} aria-hidden="true" />
          <ul
            ref={list}
            className="menu-list rail-peek"
            role="menu"
            aria-label={peek.kind === "needs" ? "Waiting on you" : "Running"}
            style={{ left: Math.round(peek.at.right + 8), top: Math.max(8, Math.min(peek.at.top - 6, window.innerHeight - 320)) }}
            onKeyDown={keys.onKeyDown}
          >
            {rows.length === 0 ? (
              <li className="sidebar-note">Nothing here now</li>
            ) : (
              rows.map((s) => (
                <li key={s.id} role="none">
                  <button
                    type="button"
                    role="menuitem"
                    title={s.title}
                    onClick={() => {
                      setPeek(null);
                      onOpenSession(s);
                    }}
                  >
                    <span className="rail-peek-title">{plainTitle(s.title)}</span>
                    <span className="rail-peek-project">{projects.get(s.workspaceId) ?? ""}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        </>
      ) : null}
      {/* The tray's own things, where the folded panel's footer would be: Usage, Theme, Settings stay one press away. */}
      <div className="rail-bottom">
        <button type="button" className="icon-btn" aria-label="Usage" title="Usage" onClick={onUsage}>
          <IconGauge size={16} />
        </button>
        {themeMenu}
        <button type="button" className="icon-btn" aria-label="Settings" title="Settings" onClick={onSettings}>
          <IconSettings size={16} />
        </button>
      </div>
    </aside>
  );
}
