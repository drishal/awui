// The sessions sidebar: the harness and project pickers, search with its quick
// filter chips (Running, Needs you, Today), and every
// project's sessions in date sections ("Show N more" past a few), from the
// server's sessions overview. Rows warm their chat on hover, show a hover card,
// carry a menu (new tab, resume command, pin, snooze, archive, move), and drag
// to a new place inside their date section. On phones it is the drawer.
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChatStatus, Checkout, HarnessStatus, ProjectSession, RoomSummary, SessionsOverview, WorkspaceInfo } from "../../shared/protocol.js";
import { RoomList } from "./RoomList.js";
import { useDismiss, useLeave, useNow, useViewSlide } from "../hooks.js";
import { projectScoped } from "../harness-policy.js";
import { useHoverCard } from "../hover-card.js";
import { IconArchive, IconCheck, IconChevronDown, IconChevronLeft, IconChevronUp, IconClock, IconDot, IconMore, IconNewTab, IconPin, IconPlus, IconSearch, IconSettings, IconSidebar, IconTerminal, IconWarning, IconSplit } from "../icons.js";
import { copyResumeCommand, useResumeCommand } from "../resume-command.js";
import type { UsageLimits } from "../../shared/protocol.js";
import { limitResetAt } from "../../shared/limit-stop.js";
import { coarse, useRowSwipe } from "../gestures.js";
import { focusProject, groupByProject, historySections, isBusy, localeWeekStart, movedOrder, projectRows, sidebarSections, snoozeOptions, wakeLabel, type ProjectGroup } from "../session-groups.js";
import { applyHidden, applyQuick, asHideGroups, asQuickFilter, chipsShown, escapeClears, hideCounts, provenanceOf, quickCounts, QUICK_LABELS, type HideGroup, type QuickFilter } from "../sidebar-filter.js";
import { load, save } from "../storage.js";
import { harnessColor } from "../harness-colors.js";
import { HarnessMenu } from "./HarnessMenu.js";
import { WorkingRing } from "./WorkingRing.js";
import { SessionCard } from "./SessionCard.js";
import { agentStatusText } from "../agent-status.js";
import { ago } from "../turns.js";
import { SidebarFilters } from "./SidebarFilters.js";
import { ProjectBadge } from "./ProjectBadge.js";
import { ProjectIconDialog } from "./ProjectIconDialog.js";
import { setProjectIcon, useProjectIcons } from "../project-icons.js";
import { enterSelection, leaveSelection, setSelectionOrder, toggleSelection, useSelectionMode } from "../selection-mode.js";
import { SnoozeUntil } from "./SnoozeUntil.js";
import { plainTitle } from "../plain-title.js";

/** Sessions shown per project before "Show N more". */
const VISIBLE_CURRENT = 8;
const VISIBLE_OTHER = 4;

export const TEXT_SCALES: Array<[string, number]> = [
  ["Small", 0.92],
  ["Default", 1],
  ["Large", 1.1],
  ["Larger", 1.22],
];

function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60_000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}


export type MarkChange = { pinned?: boolean; archived?: boolean; settled?: boolean; snoozedUntil?: number | null; unread?: boolean };

/** A row's moves inside its date section: whether it can go up or down, and the move. */
type Mover = { up: boolean; down: boolean; by: (delta: -1 | 1) => void };

/** A row's part in a drag: its handlers, and how it shows (being dragged, or the drop above or below it). */
type RowDrag = {
  dragging: boolean;
  drop: "before" | "after" | null;
  onStart: (e: React.DragEvent<HTMLLIElement>) => void;
  onOver: (e: React.DragEvent<HTMLLIElement>) => void;
  onLeave: () => void;
  onDrop: (e: React.DragEvent<HTMLLIElement>) => void;
  onEnd: () => void;
};

/**
 * Start opening a session before its click: App fetches it on a hover (live
 * chats) or a mouse press, so the click finds it loaded. A context, so the
 * rows in every list get it without threading it through each one.
 */
/**
 * What a row can do besides opening: warm its session, open it beside the
 * shown chat (where the window has the room), and copy the command that
 * resumes it in a terminal (on a harness that has one), saying so in the banner.
 */
const RowActions = createContext<{
  warm: (s: ProjectSession, why: "hover" | "press") => void;
  beside?: (s: ProjectSession) => void;
  resumable: (s: ProjectSession) => boolean;
  /** Reclaim a handed-off session (the lock goes, and the session opens here). */
  reclaim?: (s: ProjectSession) => void;
  notice: (text: string) => void;
  /** When every limited account window resets, for the menu entry below. */
  snoozeReset: number | null;
}>({ warm: () => {}, resumable: () => false, notice: () => {}, snoozeReset: null });
const HOVER_WARM_MS = 90;
/** How long the mouse rests on a row before its hover card shows. */
const HOVER_CARD_MS = 500;

/**
 * Open in a new tab, copy its resume command, pin, settle, snooze, archive:
 * from the row's ⋯ button or a right-click (a long press on phones). A session
 * not saved yet can only be opened.
 */
function RowMenu({
  s,
  anchor,
  markable,
  onOpenNewTab,
  onMark,
  onMove,
  onClose,
  onSnoozeAt,
}: {
  s: ProjectSession;
  anchor: DOMRect;
  markable: boolean;
  onOpenNewTab: () => void;
  onMark: (change: MarkChange) => void;
  onMove?: Mover;
  onClose: () => void;
  /** Wake it again at a time the user picks (the dialog's own item). */
  onSnoozeAt: () => void;
}) {
  const { snoozeReset } = useContext(RowActions);
  const selection = useSelectionMode();
  const list = useRef<HTMLUListElement>(null);
  // Its height, measured before the first paint: the layout's, since it pops in scaled.
  const [height, setHeight] = useState(300);
  useLayoutEffect(() => {
    if (list.current) setHeight(list.current.scrollHeight);
  }, []);
  // Below when it fits there, else above when it fits there, else on the roomier side, scrolling.
  const roomBelow = window.innerHeight - anchor.bottom - 12;
  const roomAbove = anchor.top - 12;
  const below = height <= roomBelow || (height > roomAbove && roomBelow >= roomAbove);
  const room = below ? roomBelow : roomAbove;
  // Under the ⋯ button it lines up with the button's right edge; at a right-click's
  // point (no width) it opens rightwards, since the sidebar sits at the window's left.
  const across = anchor.width === 0 ? { left: Math.max(8, Math.min(anchor.left, window.innerWidth - 240)), right: "auto" } : { left: "auto", right: Math.max(8, window.innerWidth - anchor.right) };
  const style = {
    position: "fixed" as const,
    ...across,
    ...(below ? { top: anchor.bottom + 4, bottom: "auto" } : { top: "auto", bottom: window.innerHeight - anchor.top + 4 }),
    ...(height > room ? { maxHeight: room, overflowY: "auto" as const } : {}),
  };
  const { beside, resumable, reclaim: reclaimFn, notice } = useContext(RowActions);
  const canResume = markable && resumable(s);
  const { resume, why } = useResumeCommand(canResume ? { harnessId: s.harnessId, sessionId: s.id, workspaceId: s.workspaceId } : null);
  const pick = (change: MarkChange) => {
    onClose();
    onMark(change);
  };
  return (
    <>
      <div className="menu-backdrop" onClick={onClose} aria-hidden="true" />
      <ul ref={list} className="menu-list row-menu" role="menu" style={style} onKeyDown={(e) => e.key === "Escape" && onClose()}>
        <li role="none">
          <button
            type="button"
            role="menuitem"
            autoFocus
            onClick={() => {
              onClose();
              onOpenNewTab();
            }}
          >
            <IconNewTab size={14} /> Open in new tab
          </button>
        </li>
        {beside ? (
          <li role="none">
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onClose();
                beside(s);
              }}
            >
              <IconSplit size={14} /> Open beside
            </button>
          </li>
        ) : null}
        {canResume ? (
          <li role="none">
            <button
              type="button"
              role="menuitem"
              disabled={!resume}
              title={resume?.command ?? why ?? undefined}
              onClick={() => {
                if (!resume) return;
                onClose();
                void copyResumeCommand(resume).then(notice);
              }}
            >
              <IconTerminal size={14} /> Copy resume command
            </button>
          </li>
        ) : null}
        {s.handover ? (
          <li role="none">
            <button
              type="button"
              role="menuitem"
              title={s.handoverCommand ? `Handed to a terminal: ${s.handoverCommand}` : "Handed to a terminal"}
              onClick={() => {
                if (!reclaimFn) return;
                onClose();
                reclaimFn(s);
              }}
            >
              <IconTerminal size={14} /> Reclaim session
            </button>
          </li>
        ) : null}
        {markable ? (
          <>
            <li role="none">
              <button type="button" role="menuitem" onClick={() => pick({ pinned: !s.pinned })}>
                <IconPin size={14} /> {s.pinned ? "Unpin" : "Pin"}
              </button>
            </li>
            <li role="none">
              <button type="button" role="menuitem" onClick={() => pick({ settled: !s.settled })}>
                <IconCheck size={14} /> {s.settled ? "Unsettle" : "Settle"}
              </button>
            </li>
            <li role="none">
              <button type="button" role="menuitem" onClick={() => pick({ unread: !s.unread })}>
                <IconDot size={14} /> {s.unread ? "Mark read" : "Mark unread"}
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onClose();
                  enterSelection(s.id);
                }}
              >
                Select sessions
              </button>
            </li>
            {s.snoozedUntil && s.snoozedUntil > Date.now() ? (
              <li role="none">
                <button type="button" role="menuitem" onClick={() => pick({ snoozedUntil: null })}>
                  <IconClock size={14} /> Wake now
                </button>
              </li>
            ) : (
              <>
                {snoozeReset ? (
                  <li role="none">
                    <button type="button" role="menuitem" onClick={() => pick({ snoozedUntil: snoozeReset + 20_000 })}>
                      <IconClock size={14} /> Until the limit resets
                    </button>
                  </li>
                ) : null}
                {snoozeOptions().map((o) => (
                <li role="none" key={o.label}>
                  <button type="button" role="menuitem" onClick={() => pick({ snoozedUntil: o.until })}>
                    <IconClock size={14} /> Snooze {o.label.toLowerCase()}
                  </button>
                </li>
                ))}
              </>
            )}
            <li role="none">
              <button type="button" role="menuitem" onClick={() => pick({ archived: !s.archived })}>
                <IconArchive size={14} /> {s.archived ? "Unarchive" : "Archive"}
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onClose();
                  onSnoozeAt();
                }}
              >
                <IconClock size={14} /> Snooze until a time…
              </button>
            </li>
          </>
        ) : null}
        {onMove ? (
          <>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                disabled={!onMove.up}
                onClick={() => {
                  onClose();
                  onMove.by(-1);
                }}
              >
                <IconChevronUp size={14} /> Move up
              </button>
            </li>
            <li role="none">
              <button
                type="button"
                role="menuitem"
                disabled={!onMove.down}
                onClick={() => {
                  onClose();
                  onMove.by(1);
                }}
              >
                <IconChevronDown size={14} /> Move down
              </button>
            </li>
          </>
        ) : null}
      </ul>
    </>
  );
}

function SessionRow({
  s,
  active,
  working,
  harnessName,
  project,
  onOpen,
  onMark,
  move,
  drag,
  provenance,
}: {
  s: ProjectSession;
  active: boolean;
  working: boolean;
  harnessName: string;
  /** Shown beside the title where the row is out of its project (the pinned list). */
  project?: string;
  /** Why this row is where it is (a routine started it, it is quiet, on the default branch); its hover card says it. */
  provenance?: string | null;
  /** `newTab`: Ctrl/⌘-click or middle-click, as in a browser. */
  onOpen: (newTab: boolean) => void;
  onMark: (change: MarkChange) => void;
  /** Moving it inside its date section (menu, Alt+↑/↓); absent where the list has no hand order. */
  move?: Mover;
  /** Dragging it inside its date section. */
  drag?: RowDrag;
}) {
  const [menuAt, setMenuAt] = useState<DOMRect | null>(null);
  // The snooze dialog: opened from the row's menu, which closes as it does.
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const selection = useSelectionMode();
  const moreRef = useRef<HTMLButtonElement>(null);
  // A session not saved yet has nothing to mark.
  const markable = !s.id.includes(":live-");
  const { warm } = useContext(RowActions);
  // On a touch screen a row also slides left for Pin, Archive and Snooze (the menu's own actions); a full swipe is the first.
  const swipeActions: Array<{ label: string; icon: React.ReactNode; change: MarkChange }> = [
    { label: s.pinned ? "Unpin" : "Pin", icon: <IconPin size={16} />, change: { pinned: !s.pinned } },
    { label: s.archived ? "Unarchive" : "Archive", icon: <IconArchive size={16} />, change: { archived: !s.archived } },
    { label: "Snooze", icon: <IconClock size={16} />, change: { snoozedUntil: snoozeOptions()[0]?.until ?? Date.now() + 3_600_000 } },
  ];
  const swipe = useRowSwipe(markable && !selection.on && coarse(), swipeActions.length, () => onMark(swipeActions[0]?.change ?? {}));
  const hover = useRef(0);
  const { anchor: cardAt, show: showCard, hide: hideCard } = useHoverCard(HOVER_CARD_MS);
  const cardId = useId();
  useEffect(() => () => window.clearTimeout(hover.current), []);
  return (
    <li
      data-row-swipe=""
      {...swipe.handlers}
      style={swipe.reveal > 0 ? ({ "--reveal": `${swipe.reveal}px` } as React.CSSProperties) : undefined}
      className={`session-item${swipe.reveal > 0 ? " is-swiped" : ""}${swipe.dragging ? " is-swiping" : ""}${menuAt ? " is-menu-open" : ""}${drag?.dragging ? " is-dragging" : ""}${drag?.drop ? ` is-drop-${drag.drop}` : ""}`}
      draggable={drag ? true : undefined}
      onDragStart={drag?.onStart}
      onDragOver={drag?.onOver}
      onDragLeave={drag?.onLeave}
      onDrop={drag?.onDrop}
      onDragEnd={drag?.onEnd}
    >
      <button
        type="button"
        className={`session${active ? " is-active" : ""}${selection.ids.has(s.id) ? " is-selected" : ""}${working ? " is-working" : ""}${s.archived || s.settled || (s.snoozedUntil ?? 0) > Date.now() ? " is-archived" : ""}`}
        onClick={(e) => {
          if (selection.on) {
            toggleSelection(s.id, e.shiftKey);
            return;
          }
          onOpen(e.ctrlKey || e.metaKey);
        }}
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
        // A touch press may be the start of a scroll, so only a mouse's press counts.
        onPointerDown={(e) => {
          hideCard();
          if (e.pointerType === "mouse" && (e.button === 0 || e.button === 1)) warm(s, "press");
        }}
        onPointerEnter={(e) => {
          if (e.pointerType !== "mouse") return;
          window.clearTimeout(hover.current);
          hover.current = window.setTimeout(() => warm(s, "hover"), HOVER_WARM_MS);
          if (markable) showCard(e.currentTarget);
          else hideCard();
        }}
        onPointerLeave={() => {
          window.clearTimeout(hover.current);
          hideCard();
        }}
        aria-describedby={cardAt ? cardId : undefined}
        onAuxClick={(e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          onOpen(true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          hideCard();
          setMenuAt(new DOMRect(e.clientX, e.clientY, 0, 0));
        }}
        onKeyDown={(e) => {
          if (!move || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          if (e.key === "ArrowUp" ? move.up : move.down) move.by(e.key === "ArrowUp" ? -1 : 1);
        }}
        aria-current={active ? "true" : undefined}
        title={project ? `${s.title} · ${project}` : undefined}
      >
        {working ? (
          <WorkingRing harnessId={s.harnessId} colored />
        ) : (
          <span className="harness-dot" style={harnessColor(s.harnessId)} role="img" aria-label={harnessName} title={harnessName} />
        )}
        <span className="session-title">{plainTitle(s.title)}</span>
        {s.agentStatus ? (
          <span className={`session-agent is-${s.agentStatus.state}`} title={`${agentStatusText(s.agentStatus)} · set by the agent ${ago(s.agentStatus.at)}`}>
            {s.agentStatus.comment || agentStatusText(s.agentStatus)}
          </span>
        ) : null}
        {s.unread ? <span className="session-unread" role="img" aria-label="Unread" title="Unread" /> : null}
        <span className="session-meta">
          {project ? <span className="session-project">{project}</span> : null}
          {s.liveChatId && !working ? <span className="live-dot" title="Open in this server" aria-label="live" /> : null}
          {s.parked && !s.liveChatId ? (
            <span className="session-parked" role="img" aria-label="Parked" title="Parked: the agent was parked after sitting idle; opening it resumes the same session" />
          ) : null}
          {s.herdr ? (
            <span
              className={`session-herdr is-${s.herdr.status}`}
              role="img"
              aria-label={`Open in herdr, pane ${s.herdr.paneId} (${s.herdr.status})`}
              title={`Open in herdr, pane ${s.herdr.paneId} (${s.herdr.status})`}
            />
          ) : null}
          {s.handover ? (
            <span
              className="session-handover"
              role="img"
              aria-label={`Handed to a terminal${s.handoverCommand ? `: ${s.handoverCommand}` : ""}`}
              title={`Handed to a terminal${s.handoverCommand ? `: ${s.handoverCommand}` : ""}`}
            />
          ) : null}
          {s.asking ? <span className="session-asking">needs you</span> : null}
          {(s.snoozedUntil ?? 0) > Date.now() ? (
            <span className="session-wake" title="Snoozed until then">
              <IconClock size={11} /> {wakeLabel(s.snoozedUntil as number)}
            </span>
          ) : (
            <span className="session-time">{relativeTime(s.updatedAt)}</span>
          )}
        </span>
      </button>
      <button
        ref={moreRef}
        type="button"
        className="icon-btn session-more"
        aria-label={`More for ${s.title}`}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        onClick={() => setMenuAt(moreRef.current?.getBoundingClientRect() ?? null)}
      >
        <IconMore size={14} />
      </button>
      {swipe.reveal > 0 ? (
        <div className="row-swipe-actions" role="group" aria-label={`Actions for ${s.title}`}>
          {swipeActions.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={() => {
                swipe.close();
                onMark(a.change);
              }}
            >
              {a.icon}
              <span>{a.label}</span>
            </button>
          ))}
        </div>
      ) : null}
      {cardAt && !menuAt ? <SessionCard s={s} anchor={cardAt} harnessName={harnessName} project={project ?? ""} id={cardId} provenance={provenance ?? null} /> : null}
      {menuAt ? (
        <RowMenu
          s={s}
          anchor={menuAt}
          markable={markable}
          onOpenNewTab={() => onOpen(true)}
          onMark={onMark}
          onSnoozeAt={() => setSnoozeOpen(true)}
          {...(move ? { onMove: move } : {})}
          onClose={() => setMenuAt(null)}
        />
      ) : null}
      {snoozeOpen ? (
        <SnoozeUntil
          onPick={(at) => {
            setSnoozeOpen(false);
            onMark({ snoozedUntil: at });
          }}
          onClose={() => setSnoozeOpen(false)}
        />
      ) : null}
    </li>
  );
}

/** A list above the projects (Needs you, Working, Pinned): a header, and its rows unless folded. */
function SectionList({
  className,
  testId,
  icon,
  title,
  sessions,
  open = true,
  onToggle,
  row,
}: {
  className: string;
  testId: string;
  icon: React.ReactNode;
  title: string;
  sessions: ProjectSession[];
  open?: boolean;
  /** Foldable when given. */
  onToggle?: () => void;
  row: (s: ProjectSession) => React.ReactNode;
}) {
  return (
    <li className={`project-group section-group ${className}${open ? " is-open" : ""}`} data-testid={testId}>
      <div className="project-head">
        {onToggle ? (
          <button type="button" className="project-toggle" aria-expanded={open} onClick={onToggle}>
            <IconChevronDown size={12} className="group-chevron" />
            {icon}
            <span className="project-name">{title}</span>
            <span className="group-count">{sessions.length}</span>
          </button>
        ) : (
          <span className="project-toggle is-static">
            {icon}
            <span className="project-name">{title}</span>
            <span className="group-count">{sessions.length}</span>
          </span>
        )}
      </div>
      {open ? <ul className="session-sublist">{sessions.map(row)}</ul> : null}
    </li>
  );
}

/** One project: header (collapse, new chat here), date-divided sessions, "Show N more". */
function ProjectGroupView({
  group,
  searching,
  order,
  now,
  isActive,
  isWorking,
  harnessName,
  canStartChat,
  onOpen,
  onMark,
  onReorder,
  onNewChat,
}: {
  group: ProjectGroup;
  searching: boolean;
  /** The project's hand-made order, first to last. */
  order: string[] | undefined;
  now: number;
  isActive: (s: ProjectSession) => boolean;
  isWorking: (s: ProjectSession) => boolean;
  harnessName: (id: string) => string;
  canStartChat: boolean;
  onOpen: (s: ProjectSession, newTab: boolean) => void;
  onMark: (s: ProjectSession, change: MarkChange) => void;
  onReorder: (ids: string[]) => void;
  onNewChat: (ws: WorkspaceInfo) => void;
}) {
  const [open, setOpen] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; place: "before" | "after" } | null>(null);
  const { workspace, sessions, current, checkout, sharesRepo } = group;
  const limit = current ? VISIBLE_CURRENT : VISIBLE_OTHER;
  const weekStart = useMemo(localeWeekStart, []);
  const all = useMemo(() => projectRows(sessions, { now, weekStartsOn: weekStart, ...(order ? { order } : {}) }), [sessions, now, weekStart, order]);
  // A search lists matches, not a hand order.
  const arranging = !searching;
  const groupOf = (id: string) => all.flatMap((r) => (r.kind === "session" && r.s.id === id ? [r.group] : []))[0];
  const reorder = (ids: string[] | null) => {
    if (ids) onReorder(ids);
  };

  const rows: React.ReactNode[] = [];
  let count = 0;
  for (const [i, r] of all.entries()) {
    if (r.kind === "divider") {
      // A divider shows only when a session under it does.
      const next = all[i + 1];
      if (next?.kind === "session" && (searching || showAll || count < limit))
        rows.push(
          <li key={`d-${r.key}`} className="date-divider" role="presentation">
            {r.label}
          </li>,
        );
      continue;
    }
    if (!searching && !showAll && count >= limit) break;
    count++;
    const { s, group: section } = r;
    const markable = !s.id.includes(":live-");
    const up = movedOrder(all, s.id, { delta: -1 }) !== null;
    const down = movedOrder(all, s.id, { delta: 1 }) !== null;
    rows.push(
      <SessionRow
        key={s.id}
        s={s}
        active={isActive(s)}
        working={isWorking(s)}
        harnessName={harnessName(s.harnessId)}
        onOpen={(newTab) => onOpen(s, newTab)}
        onMark={(change) => onMark(s, change)}
        {...(arranging && markable && (up || down) ? { move: { up, down, by: (delta) => reorder(movedOrder(all, s.id, { delta })) } } : {})}
        {...(arranging && markable
          ? {
              drag: {
                dragging: dragged === s.id,
                drop: drop?.id === s.id ? drop.place : null,
                onStart: (e) => {
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", s.title);
                  setDragged(s.id);
                },
                onOver: (e) => {
                  if (!dragged || dragged === s.id || groupOf(dragged) !== section) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = "move";
                  const box = e.currentTarget.getBoundingClientRect();
                  const place = e.clientY < box.top + box.height / 2 ? "before" : "after";
                  if (drop?.id !== s.id || drop.place !== place) setDrop({ id: s.id, place });
                },
                onLeave: () => setDrop((d) => (d?.id === s.id ? null : d)),
                onDrop: (e) => {
                  e.preventDefault();
                  if (dragged && drop?.id === s.id) reorder(movedOrder(all, dragged, { target: s.id, place: drop.place }));
                  setDragged(null);
                  setDrop(null);
                },
                onEnd: () => {
                  setDragged(null);
                  setDrop(null);
                },
              },
            }
          : {})}
      />,
    );
  }
  const hidden = sessions.length - count;

  return (
    <li className={`project-group${open ? " is-open" : ""}${current ? " is-current" : ""}`} data-testid="project-group">
      <div className="project-head">
        <button type="button" className="project-toggle" aria-expanded={open} onClick={() => setOpen((v) => !v)} title={workspace.path}>
          <IconChevronDown size={12} className="group-chevron" />
          <ProjectBadge id={workspace.id} name={workspace.name} />
          <span className="project-name">{workspace.name}</span>
          {sharesRepo && checkout?.branch ? <span className="project-branch">{checkout.branch}</span> : null}
          {!open && sessions.some(isWorking) ? <WorkingRing colored={false} /> : null}
          <span className="group-count">{sessions.length}</span>
        </button>
        <button
          type="button"
          className="icon-btn project-new"
          aria-label={`New chat in ${workspace.name}`}
          title={`New chat in ${workspace.name} in a new tab`}
          disabled={!canStartChat}
          onClick={() => onNewChat(workspace)}
        >
          <IconPlus size={13} />
        </button>
      </div>
      {open ? (
        <ul className="session-sublist">
          {rows}
          {sessions.length === 0 ? <li className="sidebar-note">No sessions here yet</li> : null}
          {hidden > 0 ? (
            <li>
              <button type="button" className="show-more" onClick={() => setShowAll(true)}>
                <IconMore size={13} /> Show {hidden} more in {workspace.name}
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

/** A folder's place in a project menu: its name, path, and count on one row. */
function ProjectMenuItem({ name, path, count, onPick }: { name: string; path: string; count?: number; onPick: () => void }) {
  return (
    <button type="button" role="menuitem" title={path} onClick={onPick}>
      <ProjectBadge name={name} size={16} />
      <span className="project-menu-name">{name}</span>
      <span className="project-menu-path muted">{path}</span>
      {count !== undefined ? <span className="group-count">{count}</span> : null}
    </button>
  );
}

/** The head of a focused project: "All projects" back, the project (a switch to another), new chat. */
function FocusedHeader({
  workspace,
  checkout,
  total,
  canStartChat,
  onNewChat,
  onShowAll,
  onFocus,
  scope,
}: {
  workspace: WorkspaceInfo;
  checkout?: Checkout;
  total: number;
  canStartChat: boolean;
  onNewChat: (ws: WorkspaceInfo) => void;
  onShowAll: () => void;
  onFocus: (workspaceId: string) => void;
  scope: Array<{ workspace: WorkspaceInfo; count: number; current: boolean }>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { render: showMenu, leaving } = useLeave(menuOpen);
  const [iconOpen, setIconOpen] = useState(false);
  const icons = useProjectIcons();
  const headWrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  useDismiss(headWrap, menuOpen, () => setMenuOpen(false));
  const other = scope.filter((p) => p.workspace.id !== workspace.id);
  const pick = (run: () => void) => {
    setMenuOpen(false);
    run();
  };
  // Menu keys: Escape closes (useDismiss's outside click too), arrows move, the first item takes the focus on open.
  const onMenuKey = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key === "Escape") {
      setMenuOpen(false);
      return;
    }
    const buttons = menu.current?.querySelectorAll<HTMLButtonElement>("button");
    if (!buttons?.length) return;
    const index = [...buttons].findIndex((b) => b === document.activeElement);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      (buttons[(index + 1) % buttons.length] as HTMLButtonElement).focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      (buttons[(index - 1 + buttons.length) % buttons.length] as HTMLButtonElement).focus();
    }
  };
  useEffect(() => {
    if (menuOpen) menu.current?.querySelector("button")?.focus();
  }, [menuOpen]);
  return (
    <div className="project-head focus-head" ref={headWrap} data-testid="focused-project">
      <button type="button" className="icon-btn focus-back" aria-label="All projects" title="All projects" onClick={() => pick(onShowAll)}>
        <IconChevronLeft size={14} />
      </button>
      <button
        type="button"
        className="project-toggle focus-switch"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={workspace.path}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <ProjectBadge id={workspace.id} name={workspace.name} />
        <span className="project-name">{workspace.name}</span>
        {checkout?.branch ? <span className="project-branch">{checkout.branch}</span> : null}
        <span className="group-count">{total}</span>
        <IconChevronDown size={12} className="group-chevron" />
      </button>
      <button type="button" className="icon-btn project-new" aria-label={`New chat in ${workspace.name}`} title={`New chat in ${workspace.name} in a new tab`} disabled={!canStartChat} onClick={() => onNewChat(workspace)}>
        <IconPlus size={13} />
      </button>
      {showMenu ? (
        <>
          <div className="menu-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />
          <ul ref={menu} className={`menu-list focus-menu${leaving ? " is-leaving" : ""}`} role="menu" aria-label="Project" onKeyDown={onMenuKey}>
            <li role="none" className="focus-menu-all">
              <button type="button" role="menuitem" onClick={() => pick(onShowAll)}>
                <IconChevronLeft size={13} /> All projects
              </button>
            </li>
            <li role="none">
              <button type="button" role="menuitem" onClick={() => pick(() => setIconOpen(true))}>
                Set an icon…
              </button>
            </li>
            {other.map((p) => (
              <li key={p.workspace.id} role="none">
                <ProjectMenuItem name={p.workspace.name} path={p.workspace.path} count={p.count} onPick={() => pick(() => onFocus(p.workspace.id))} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {iconOpen ? <ProjectIconDialog name={workspace.name} icon={icons[workspace.id] ?? ""} onSave={(icon) => setProjectIcon(workspace.id, icon)} onClose={() => setIconOpen(false)} /> : null}
    </div>
  );
}

/**
 * The focused project (Hermes Desktop's one-folder view): a header that names it (and switches
 * project), a back button to every folder, then its sessions of the selected harness in date
 * sections. The sections reuse the unscoped list's row (session-sublist, history-group), so it
 * reads the same; the rows keep their open, mark, and drag moves.
 */
function FocusedProjectView({
  focused,
  order,
  now,
  isActive,
  isWorking,
  harnessName,
  canStartChat,
  onOpen,
  onMark,
  onReorder,
  onNewChat,
  onShowAll,
  onFocus,
  scope,
}: {
  focused: NonNullable<ReturnType<typeof focusProject>>;
  order: string[] | undefined;
  now: number;
  isActive: (s: ProjectSession) => boolean;
  isWorking: (s: ProjectSession) => boolean;
  harnessName: (id: string) => string;
  canStartChat: boolean;
  onOpen: (s: ProjectSession, newTab: boolean) => void;
  onMark: (s: ProjectSession, change: MarkChange) => void;
  onReorder: (ids: string[]) => void;
  onNewChat: (ws: WorkspaceInfo) => void;
  onShowAll: () => void;
  onFocus: (workspaceId: string) => void;
  scope: Array<{ workspace: WorkspaceInfo; count: number; current: boolean }>;
}) {
  const [showAll, setShowAll] = useState(false);
  const { workspace, checkout, sections } = focused;
  const total = sections.reduce((n, sec) => n + sec.sessions.length, 0);
  // The VISIBLE_CURRENT cap spreads over the date sections as they come, newest first.
  const allSessions = sections.flatMap((sec) => sec.sessions);
  const projRows = projectRows(allSessions, { now, weekStartsOn: localeWeekStart(), ...(order ? { order } : {}) });

  // Each row's group (its date key) bounds a drag or a Move up/down, as in the unscoped list.
  const groupOf = (id: string) => projRows.flatMap((r) => (r.kind === "session" && r.s.id === id ? [r.group] : []))[0];
  const reorder = (ids: string[] | null) => {
    if (ids) onReorder(ids);
  };
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; place: "before" | "after" } | null>(null);
  const rows: React.ReactNode[] = [];
  let count = 0;
  for (const sec of sections) {
    const list = showAll ? sec.sessions : sec.sessions.slice(0, Math.max(0, VISIBLE_CURRENT - count));
    if (list.length === 0) continue;
    if (sec.label !== "") {
      rows.push(
        <li key={`d-${sec.label}`} className="date-divider" role="presentation">
          {sec.label}
        </li>,
      );
    }
    for (const s of list) {
      count++;
      const markable = !s.id.includes(":live-");
      const up = movedOrder(projRows, s.id, { delta: -1 }) !== null;
      const down = movedOrder(projRows, s.id, { delta: 1 }) !== null;
      const section = groupOf(s.id) ?? "recent";
      rows.push(
        <SessionRow
          key={s.id}
          s={s}
          active={isActive(s)}
          working={isWorking(s)}
          harnessName={harnessName(s.harnessId)}
          onOpen={(newTab) => onOpen(s, newTab)}
          onMark={(change) => onMark(s, change)}
          {...(markable && (up || down) ? { move: { up, down, by: (delta) => reorder(movedOrder(projRows, s.id, { delta })) } } : {})}
          {...(markable
            ? {
                drag: {
                  dragging: dragged === s.id,
                  drop: drop?.id === s.id ? drop.place : null,
                  onStart: (e) => {
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", s.title);
                    setDragged(s.id);
                  },
                  onOver: (e) => {
                    if (!dragged || dragged === s.id || groupOf(dragged) !== section) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    const box = e.currentTarget.getBoundingClientRect();
                    const place = e.clientY < box.top + box.height / 2 ? "before" : "after";
                    if (drop?.id !== s.id || drop.place !== place) setDrop({ id: s.id, place });
                  },
                  onLeave: () => setDrop((d) => (d?.id === s.id ? null : d)),
                  onDrop: (e) => {
                    e.preventDefault();
                    if (dragged && drop?.id === s.id) reorder(movedOrder(projRows, dragged, { target: s.id, place: drop.place }));
                    setDragged(null);
                    setDrop(null);
                  },
                  onEnd: () => {
                    setDragged(null);
                    setDrop(null);
                  },
                },
              }
            : {})}
        />,
      );
    }
  }
  const hidden = total - count;
  return (
    <li className="project-group is-open is-current focus-group">
      <FocusedHeader workspace={workspace} {...(checkout ? { checkout } : {})} total={total} canStartChat={canStartChat} onNewChat={onNewChat} onShowAll={onShowAll} onFocus={onFocus} scope={scope} />
      <ul className="session-sublist">
        {sections.length === 0 ? <li className="sidebar-note">No past sessions here yet</li> : rows}
        {hidden > 0 ? (
          <li>
            <button type="button" className="show-more" onClick={() => setShowAll(true)}>
              <IconMore size={13} /> Show {hidden} more in {workspace.name}
            </button>
          </li>
        ) : null}
      </ul>
    </li>
  );
}

export function Sidebar(props: {
  open: boolean;
  /** Every account limits, whose reset the row menu can snooze until. */
  limits: UsageLimits | null;
  /** One bulk change for a selection of sessions (the endpoint takes them together). */
  onMarkMany: (ids: string[], change: MarkChange) => void;
  /** Board rooms: the sidebar's own section, above chats. */
  rooms: RoomSummary[] | null;
  roomsError: string | null;
  roomsLoading: boolean;
  activeRoomId: string | null;
  onOpenRoom: (roomId: string) => void;
  onNewRoom: () => void;
  onRefreshRooms: () => void;
  harnesses: HarnessStatus[];
  harnessId: string | null;
  onHarness: (id: string) => void;
  workspace: WorkspaceInfo | null;
  onNewChat: () => void;
  newChatDisabled: string | null;
  /** A chat can start in some project (harness available, nothing opening). */
  canStartChat: boolean;
  onNewChatIn: (ws: WorkspaceInfo) => void;
  overview: SessionsOverview;
  sessionsError: string | null;
  sessionsLoading: boolean;
  query: string;
  onQuery: (q: string) => void;
  /** Look for the query in what the chats said, not only their titles. */
  onSearchAll?: (q: string) => void;
  activeSessionId: string | null;
  activeChatId: string | null;
  /** The open chat's status (live over SSE), which beats the listing's. */
  activeStatus: ChatStatus | null;
  /** `newTab`: open it in a new tab rather than the shown one. */
  onOpenSession: (s: ProjectSession, newTab: boolean) => void;
  /** Start fetching a session the pointer is on, before its click. */
  onWarmSession: (s: ProjectSession, why: "hover" | "press") => void;
  onOpenBeside?: (s: ProjectSession) => void;
  /** Pin or archive a session. */
  onMarkSession: (s: ProjectSession, change: MarkChange) => void;
  /** Reclaim a handed-off session (the lock goes, and the session opens here). */
  onReclaimSession?: (s: ProjectSession) => void;
  /** A project's sessions in a hand-made order (a drag, Move up/down), for the shown harness. */
  onReorderSessions: (harnessId: string, workspaceId: string, ids: string[]) => void;
  /** Say something in the app's banner (a copied resume command). */
  onNotice: (text: string) => void;
  onRefresh: () => void;
  /** Open Settings (theme, text size, pairing, sign-out, and the server's config.yml). */
  onSettings: () => void;
  /** Drag handle on the right edge (wide screens). */
  resizer?: React.ReactNode;
  /** Under the session list: the Usage panel's entry point. */
  footer?: React.ReactNode;
  /** Above the sessions on a phone: the open tabs (the tab strip is hidden there). */
  tabs?: React.ReactNode;
  onClose: () => void;
  /** Wide screens: fold the sidebar away (the chat header gets the expand button). */
  onCollapse: () => void;
}) {
  const current = props.harnesses.find((h) => h.id === props.harnessId);
  const names = useMemo(() => new Map(props.harnesses.map((h) => [h.id as string, h.displayName])), [props.harnesses]);
  const resumable = (s: ProjectSession) => props.harnesses.some((h) => h.id === s.harnessId && h.capabilities.supportsResumeCommand);
  const [showArchived, setShowArchived] = useState(false);
  const [showSettled, setShowSettled] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  const [workingOpen, setWorkingOpen] = useState(() => load<boolean>("workingOpen", false));
  // Snoozes end on the minute.
  const now = useNow(true, 60_000);
  const isActiveSession = (s: ProjectSession) =>
    (props.activeSessionId !== null && s.id === props.activeSessionId) || (s.liveChatId !== undefined && s.liveChatId === props.activeChatId);
  // What each session is doing now: the open chat's live status beats the listing's.
  const isWorking = (s: ProjectSession) => (isActiveSession(s) ? isBusy(props.activeStatus) : isBusy(s.status));
  // The quick filter (Running, Needs you, Today), kept per device; it narrows the overview before anything groups it.
  const [quick, setQuick] = useState<QuickFilter | null>(() => asQuickFilter(load<unknown>("sidebarFilter", null)));
  const pickQuick = (next: QuickFilter | null) => {
    setQuick(next);
    save("sidebarFilter", next);
  };
  // The hide menu's toggles, kept per device like the chip: each takes a whole kind of
  // session out of the list, and what it takes out is read from the row and its project.
  const [hide, setHide] = useState<HideGroup[]>(() => asHideGroups(load<unknown>("sidebarHide", [])));
  const pickHide = (next: HideGroup[]) => {
    setHide(next);
    save("sidebarHide", next);
  };
  const hideCtx = { now, keep: isActiveSession, ...(props.overview.checkouts ? { checkouts: props.overview.checkouts } : {}) };
  const hideCount = useMemo(() => hideCounts(props.overview, hideCtx), [props.overview, now, props.activeSessionId, props.activeChatId]);
  // What the list shows before the chip narrows it: the hidden kinds are already out, so
  // the chip's counts agree with the rows.
  const unhidden = useMemo(
    () => applyHidden(props.overview, hide, hideCtx),
    [props.overview, hide, now, props.activeSessionId, props.activeChatId],
  );
  const overview = useMemo(
    () => applyQuick(unhidden, quick, now, isWorking),
    [unhidden, quick, now, props.activeStatus, props.activeSessionId, props.activeChatId],
  );
  const groupOptions = {
    currentId: props.workspace?.id ?? null,
    query: props.query,
    harnessId: props.harnessId,
    showArchived,
    showSettled,
    showSnoozed,
    isActive: isActiveSession,
    now,
  };
  const groups = useMemo(
    () => groupByProject(overview, groupOptions),
    [overview, props.workspace, props.query, props.harnessId, showArchived, showSettled, showSnoozed, props.activeSessionId, props.activeChatId, now],
  );
  const sections = useMemo(
    () => sidebarSections(overview, groupOptions),
    [overview, props.query, props.harnessId, props.activeSessionId, props.activeChatId, now],
  );
  const { pinned, needs, working } = sections;
  const quickCount = useMemo(
    () => quickCounts(unhidden, groupOptions, isWorking),
    [unhidden, props.harnessId, props.activeStatus, props.activeSessionId, props.activeChatId, now],
  );
  const projectName = (s: ProjectSession) => overview.workspaces.find((w) => w.id === s.workspaceId)?.name ?? "";

  // The focused project (Hermes Desktop's one-folder view). "auto" follows the current folder;
  // "all" is the back row's choice, kept until a folder is picked elsewhere or the header names one.
  const [focus, setFocus] = useState<string | "all" | "auto">("auto");
  const currentId = props.workspace?.id ?? null;
  const [lastCurrent, setLastCurrent] = useState(currentId);
  if (currentId !== lastCurrent) {
    setLastCurrent(currentId);
    setFocus("auto");
  }
  // A projectless harness's flat history has no projects to focus.
  const focusId = !projectScoped(props.harnesses, props.harnessId ?? "") || focus === "all" ? null : focus === "auto" ? currentId : focus;
  const sessionList = useRef<HTMLUListElement>(null);
  useViewSlide(sessionList, focusId ?? "all");
  const focused = useMemo(() => {
    if (!focusId) return null;
    const order = props.harnessId ? overview.orders?.[`${props.harnessId}:${focusId}`] : undefined;
    return focusProject(overview, focusId, { ...groupOptions, ...(order ? { order } : {}) });
  }, [overview, focusId, props.query, props.harnessId, showArchived, showSettled, showSnoozed, props.activeSessionId, props.activeChatId, now]);
  const selection = useSelectionMode();
  // The ids in the order the sections show them, for a Shift-click run.
  const selectionOrder = useMemo(
    () => (focused ? focused.sections.flatMap((sec) => sec.sessions.map((x) => x.id)) : groups.flatMap((g) => g.sessions.map((x) => x.id))),
    [focused, groups],
  );
  useEffect(() => setSelectionOrder(selectionOrder), [selectionOrder]);

  const asideRef = useRef<HTMLElement>(null);
  const { open } = props;

  // Drawer mode: Escape closes from anywhere; the backdrop owns outside clicks.
  useDismiss(asideRef, open, props.onClose, { escape: true, outside: false });
  // Focus moves in once on open.
  useEffect(() => {
    if (!open) return;
    asideRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
  }, [open]);

  const isActive = isActiveSession;
  const searching = props.query.trim() !== "";
  // A filter that leaves nothing to list (the current project's empty heading does not count).
  const quickEmpty =
    quick !== null &&
    pinned.length === 0 &&
    needs.length === 0 &&
    working.length === 0 &&
    (!projectScoped(props.harnesses, props.harnessId ?? "") ? historySections(overview, groupOptions).length === 0 : groups.every((g) => g.sessions.length === 0));
  const sectionRow = (s: ProjectSession) => (
    <SessionRow
      key={s.id}
      s={s}
      active={isActive(s)}
      working={isWorking(s)}
      harnessName={names.get(s.harnessId) ?? s.harnessId}
      project={projectName(s)}
      provenance={provenanceOf(s, hideCtx)}
      onOpen={(newTab) => props.onOpenSession(s, newTab)}
      onMark={(change) => props.onMarkSession(s, change)}
    />
  );
  // History rows carry no project label: a chat has no folder.
  const historyRow = (s: ProjectSession) => (
    <SessionRow key={s.id} s={s} active={isActive(s)} working={isWorking(s)} harnessName={names.get(s.harnessId) ?? s.harnessId} provenance={provenanceOf(s, hideCtx)} onOpen={(newTab) => props.onOpenSession(s, newTab)} onMark={(change) => props.onMarkSession(s, change)} />
  );

  return (
    <RowActions.Provider value={{ warm: props.onWarmSession, snoozeReset: limitResetAt(props.limits), ...(props.onOpenBeside ? { beside: props.onOpenBeside } : {}), resumable, ...(props.onReclaimSession ? { reclaim: props.onReclaimSession } : {}), notice: props.onNotice }}>
      <div className={`backdrop${props.open ? " is-open" : ""}`} onClick={props.onClose} aria-hidden="true" />
      <aside
        ref={asideRef}
        className={`sidebar${props.open ? " is-open" : ""}`}
        aria-label="Sessions"
        {...(props.open ? { role: "dialog", "aria-modal": true } : {})}
        onKeyDown={(e) => {
          if (e.key === "Escape" && selection.on) {
            e.stopPropagation();
            leaveSelection();
          }
        }}
      >
        <div className="sidebar-head">
          <span className="brand">awui</span>
          <button type="button" className="icon-btn sidebar-settings" aria-label="Settings" title="Settings" onClick={props.onSettings}>
            <IconSettings size={16} />
          </button>
          <button
            type="button"
            className="icon-btn sidebar-collapse"
            aria-label="Collapse sidebar"
            title="Collapse sidebar"
            onClick={props.onCollapse}
          >
            <IconSidebar size={16} />
          </button>
          <button type="button" className="icon-btn drawer-close" aria-label="Close menu" onClick={props.onClose}>
            <IconChevronDown size={16} className="rotate-90" />
          </button>
        </div>
        {props.tabs}

        <button type="button" className="new-chat" onClick={props.onNewChat} disabled={props.newChatDisabled !== null}>
          <IconPlus size={15} /> New chat
        </button>
        {props.newChatDisabled ? <p className="sidebar-note">{props.newChatDisabled}</p> : null}

        <HarnessMenu
          variant="row"
          label="Harness"
          menuLabel="Harness"
          currentId={props.harnessId}
          choices={props.harnesses.map((h) => ({ harness: h, blocked: h.available ? null : (h.reason ?? "Not available") }))}
          hint="Filters the list; new chats start with this agent."
          onPick={props.onHarness}
        />
        {current?.warnings.map((w) => (
          <p key={w} className="sidebar-note is-warning">
            {w}
          </p>
        ))}

        <div className="sessions">
          <div className="sessions-head">
            {selection.on ? (
              <div className="selection-bar" role="group" aria-label="Selected sessions">
                <span className="selection-count">
                  {selection.ids.size} selected
                </span>
                {[
                  ["Settle", { settled: true }],
                  ["Archive", { archived: true }],
                  ["Pin", { pinned: true }],
                  ["Snooze an hour", { snoozedUntil: Date.now() + 3_600_000 }],
                ].map(([label, change]) => (
                  <button
                    key={label as string}
                    type="button"
                    className="btn btn-small"
                    disabled={selection.ids.size === 0}
                    onClick={() => {
                      props.onMarkMany([...selection.ids], change as MarkChange);
                      leaveSelection();
                    }}
                  >
                    {label as string}
                  </button>
                ))}
                <button type="button" className="btn btn-small btn-ghost" onClick={() => leaveSelection()}>
                  Done
                </button>
              </div>
            ) : (
              <>
                <label className="search-field">
                  <IconSearch size={14} />
                  <input
                    type="search"
                    placeholder="Search sessions"
                    value={props.query}
                    onChange={(e) => props.onQuery(e.target.value)}
                    onKeyDown={(e) => {
                      const clears = escapeClears(props.query, quick);
                      if (e.key !== "Escape" || !clears) return;
                      // Not the drawer's Escape, and not the browser's own clearing of a search box.
                      e.preventDefault();
                      e.stopPropagation();
                      if (clears === "query") props.onQuery("");
                      else pickQuick(null);
                    }}
                    aria-label="Search sessions"
                  />
                </label>
                <button type="button" className="icon-btn" aria-label="Refresh sessions" onClick={props.onRefresh}>
                  ↻
                </button>
              </>
            )}
          </div>
          {!selection.on ? (
            <div className="quick-filters" role="group" aria-label="Filter sessions">
              {chipsShown(quickCount, quick).map((f) => (
                <button key={f} type="button" className="quick-chip" aria-pressed={quick === f} onClick={() => pickQuick(quick === f ? null : f)}>
                  {QUICK_LABELS[f]} <span className="quick-count">{quickCount[f]}</span>
                </button>
              ))}
              <SidebarFilters hide={hide} counts={hideCount} onChange={pickHide} />
            </div>
          ) : null}
          {props.onSearchAll && props.query.trim().length >= 2 ? (
            <button type="button" className="search-all" onClick={() => props.onSearchAll?.(props.query.trim())}>
              <IconSearch size={13} />
              <span className="search-all-label">
                Search every chat for <q>{props.query.trim()}</q>
              </span>
            </button>
          ) : null}
          {props.sessionsError ? <p className="sidebar-note is-warning">{props.sessionsError}</p> : null}
          <ul ref={sessionList} className="session-list" aria-busy={props.sessionsLoading} aria-label="Sessions by project">
            {/*
              Rooms are the Awui harness's surface: they appear in its sidebar scope, not in a
              coding harness's. A server with no Awui harness has no scope to put them in (and
              Board runs on any harness), so there they stay visible.
            */}
            {props.harnessId === "awui" || !props.harnesses.some((h) => h.id === "awui") ? (
              <RoomList
                rooms={props.rooms}
                activeRoomId={props.activeRoomId}
                loading={props.roomsLoading}
                error={props.roomsError}
                onOpen={props.onOpenRoom}
                onNew={props.onNewRoom}
                onRefresh={props.onRefreshRooms}
              />
            ) : null}
            {props.sessionsLoading && groups.length === 0 ? (
              <li className="skeleton-list" aria-hidden="true">
                <span className="skeleton-row" />
                <span className="skeleton-row" />
                <span className="skeleton-row" />
              </li>
            ) : null}
            {needs.length > 0 ? (
              <SectionList
                className="needs-group"
                testId="needs-group"
                icon={<IconWarning size={14} />}
                title="Needs you"
                sessions={needs}
                row={(s) => sectionRow(s)}
              />
            ) : null}
            {working.length > 0 ? (
              <SectionList
                className="working-group"
                testId="working-group"
                icon={<WorkingRing colored={false} />}
                title="Working"
                sessions={working}
                open={workingOpen}
                onToggle={() => {
                  setWorkingOpen(!workingOpen);
                  save("workingOpen", !workingOpen);
                }}
                row={(s) => sectionRow(s)}
              />
            ) : null}
            {pinned.length > 0 ? (
              <SectionList className="pinned-group" testId="pinned-group" icon={<IconPin size={14} />} title="Pinned" sessions={pinned} row={(s) => sectionRow(s)} />
            ) : null}
            {quickEmpty ? null : !projectScoped(props.harnesses, props.harnessId ?? "") ? (
              // The chat surface has no projects: a Claude.ai-style history, newest first by day.
              historySections(overview, groupOptions)
                .filter((sec) => sec.label !== "Pinned")
                .map((sec) => (
                  <li className="project-group is-open history-group" key={sec.label} data-testid="history-group">
                    <div className="project-head">
                      <span className="project-toggle is-static">
                        <span className="project-name">{sec.label}</span>
                      </span>
                    </div>
                    <ul className="session-sublist">
                      {sec.sessions.map((s) => historyRow(s))}
                    </ul>
                  </li>
                ))
            ) : focused && !searching ? (
              <FocusedProjectView
                focused={focused}
                order={overview.orders?.[`${props.harnessId}:${focused.workspace.id}`]}
                now={now}
                isActive={isActive}
                isWorking={isWorking}
                harnessName={(id) => names.get(id) ?? id}
                canStartChat={props.canStartChat}
                onOpen={props.onOpenSession}
                onMark={props.onMarkSession}
                onReorder={(ids) => props.harnessId && props.onReorderSessions(props.harnessId, focused.workspace.id, ids)}
                onNewChat={props.onNewChatIn}
                onShowAll={() => setFocus("all")}
                onFocus={(id) => setFocus(id)}
                scope={groups.map((g) => ({ workspace: g.workspace, count: g.sessions.length, current: g.workspace.id === focusId }))}
              />
            ) : (
              groups.map((g) => (
                <ProjectGroupView
                  key={g.workspace.id}
                  group={g}
                  searching={searching}
                  order={overview.orders?.[`${props.harnessId}:${g.workspace.id}`]}
                  now={now}
                  isActive={isActive}
                  isWorking={isWorking}
                  harnessName={(id) => names.get(id) ?? id}
                  canStartChat={props.canStartChat}
                  onOpen={props.onOpenSession}
                  onMark={props.onMarkSession}
                  onReorder={(ids) => props.harnessId && props.onReorderSessions(props.harnessId, g.workspace.id, ids)}
                  onNewChat={props.onNewChatIn}
                />
              ))
            )}
            {!searching && (sections.counts.snoozed > 0 || sections.counts.settled > 0 || sections.counts.archived > 0) ? (
              <li className="list-toggles">
                {sections.counts.snoozed > 0 ? (
                  <button type="button" className="show-more" aria-pressed={showSnoozed} onClick={() => setShowSnoozed((v) => !v)}>
                    <IconClock size={13} /> {showSnoozed ? "Hide snoozed" : `${sections.counts.snoozed} snoozed`}
                  </button>
                ) : null}
                {sections.counts.settled > 0 ? (
                  <button type="button" className="show-more" aria-pressed={showSettled} onClick={() => setShowSettled((v) => !v)}>
                    <IconCheck size={13} /> {showSettled ? "Hide settled" : `${sections.counts.settled} settled`}
                  </button>
                ) : null}
                {sections.counts.archived > 0 ? (
                  <button type="button" className="show-more archived-toggle" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
                    <IconArchive size={13} /> {showArchived ? "Hide archived" : `${sections.counts.archived} archived`}
                  </button>
                ) : null}
              </li>
            ) : null}
            {quickEmpty && !props.sessionsLoading && !props.sessionsError ? (
              <li className="sidebar-note quick-empty">
                No sessions match
                <button type="button" className="btn btn-small btn-ghost" onClick={() => pickQuick(null)}>
                  Clear filter
                </button>
              </li>
            ) : null}
            {!quick && !props.sessionsLoading && groups.length === 0 && pinned.length === 0 && needs.length === 0 && working.length === 0 && !props.sessionsError ? (
              <li className="sidebar-note">{searching ? "No matching sessions" : "No chats yet. Start one on the right."}</li>
            ) : null}
          </ul>
        </div>

        {props.footer}
        {props.resizer}
      </aside>
    </RowActions.Provider>
  );
}
