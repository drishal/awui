// The sessions sidebar: two rows of chrome (the harness as its title with New chat and collapse; search with the filter
// inside it) above the sessions in one of two views — Recent, one flat
// list across projects under date headings, or Projects, grouped by folder with focus mode ("Show N
// more" past a page), from the server's sessions overview. Rows warm their chat on hover, show a hover
// card, carry a menu (new tab, resume command, pin, snooze, archive, move), and, in the Projects view,
// drag to a new place inside their date section. On phones it is the drawer.
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ChatStatus, Checkout, HarnessStatus, ProjectSession, RoomSummary, SessionsOverview, WorkspaceInfo } from "../../shared/protocol.js";
import { RoomList } from "./RoomList.js";
import { useDismiss, useLeave, useNow, useViewSlide } from "../hooks.js";
import { projectScoped } from "../harness-policy.js";
import { useHoverCard, type CardSide } from "../hover-card.js";
import { menuStep, useMenuKeys } from "../menu-focus.js";
import { useFocusTrap } from "../focus-trap.js";
import { shortPath } from "../project-path.js";
import { IconArchive, IconArrowLeft, IconCheck, IconCheckSquare, IconChevronDown, IconChevronLeft, IconChevronUp, IconClock, IconDot, IconImage, IconMore, IconNewTab, IconPin, IconPlus, IconSearch, IconSettings, IconSidebar, IconTerminal, IconWarning, IconSplit, IconX } from "../icons.js";
import { shortcutHint } from "../shortcuts.js";
import { copyResumeCommand, useResumeCommand } from "../resume-command.js";
import type { UsageLimits } from "../../shared/protocol.js";
import { limitResetAt } from "../../shared/limit-stop.js";
import { coarse, useRowSwipe } from "../gestures.js";
import { focusProject, groupByProject, isWorking as statusWorking, localeWeekStart, isTrunkBranch, movedOrder, projectRows, sidebarSections, snoozeOptions, wakeLabel, type ProjectGroup } from "../session-groups.js";
import { RECENT_PAGE, SHOW_MORE, projectTag, recentRows, type ProjectTag } from "../recent-view.js";
import { useSidebarView } from "../sidebar-view.js";
import { applyHidden, applyQuick, asHideGroups, asQuickFilter, chipsShown, escapeClears, hideCounts, provenanceOf, quickCounts, QUICK_LABELS, type HideGroup, type QuickFilter } from "../sidebar-filter.js";
import { load, save } from "../storage.js";
import { harnessColor } from "../harness-colors.js";
import { HarnessMenu } from "./HarnessMenu.js";
import { WorkingRing } from "./WorkingRing.js";
import { SessionCard } from "./SessionCard.js";
import { ago, shortAgo } from "../turns.js";
import { SidebarFilters } from "./SidebarFilters.js";
import { SidebarViewMenu } from "./SidebarViewMenu.js";
import { ProjectBadge } from "./ProjectBadge.js";
import { ProjectIconDialog } from "./ProjectIconDialog.js";
import { setProjectIcon, useProjectIcons } from "../project-icons.js";
import { projectSlots, type ProjectMonogram } from "../project-badge.js";
import { enterSelection, leaveSelection, setSelectionOrder, toggleSelection, useSelectionMode } from "../selection-mode.js";
import { SnoozeUntil } from "./SnoozeUntil.js";
import { plainTitle } from "../plain-title.js";
import { rowState, rowSubline, runElapsed, type TagFact } from "../session-state.js";
import { matchSpan } from "../sidebar-filter.js";
import { type Box, firstLineBox, glide, handoff, MORPH_IN_MS } from "../morph.js";

/** A folder's first page: the current one gets a fuller preview than the others (each adds SHOW_MORE). */
const VISIBLE_CURRENT = 8;
const VISIBLE_OTHER = 4;
/** A compact row hides its lone project suffix under this rail width: below the desktop floor, so only a
 *  viewport under 254px reaches it, through the phone drawer's 88vw width (`.is-narrow`, sidebar.css). */
const NARROW_RAIL = 224;
/** Under this rail the search field is too narrow for the whole placeholder (an input cannot ellipsise one),
 *  so it asks for a search in one word instead. The field's own label stays "Search sessions" at every width. */
const TIGHT_FIELD = 256;

export const TEXT_SCALES: Array<[string, number]> = [
  ["Small", 0.92],
  ["Default", 1],
  ["Large", 1.1],
  ["Larger", 1.22],
];

function relativeTime(iso: string | null): string {
  return iso ? shortAgo(new Date(iso).getTime()) : "";
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

/** A rule between a menu's groups: five short tasks read faster than thirteen flat actions. */
function MenuSeparator() {
  return <li role="separator" className="menu-separator" />;
}
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
  opener,
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
  /** The row's ⋯ button, or the row itself after a right-click: where Escape hands the focus back. */
  opener: { readonly current: HTMLElement | null };
}) {
  const { snoozeReset } = useContext(RowActions);
  const selection = useSelectionMode();
  const list = useRef<HTMLUListElement>(null);
  // Its height, measured before the first paint: the layout's, since it pops in scaled. The snooze choices
  // fold open inside it, which changes it.
  const [height, setHeight] = useState(300);
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  useLayoutEffect(() => {
    if (list.current) setHeight(list.current.scrollHeight);
  }, [snoozeOpen]);
  const snoozed = (s.snoozedUntil ?? 0) > Date.now();
  // Its own keyboard: one tab stop, arrows between the rows, Escape back to the button that opened it.
  const keys = useMenuKeys(list, { open: true, close: onClose, opener, version: snoozeOpen ? 1 : 0 });
  // Below when it fits there, else above when it fits there, else on the roomier side, scrolling. The list's
  // own scroller is its ceiling: a menu on a row near the top opens inside the list, never over the head.
  const roomBelow = window.innerHeight - anchor.bottom - 12;
  const ceiling = (document.querySelector<HTMLElement>(".sidebar .session-list")?.getBoundingClientRect().top ?? 8) + 4;
  // A flipped menu clears the whole row, not only the ⋯ on its subline: even the title being acted on stays
  // readable. The row's `.session` is the opener's sibling in `li.session-item`, or the opener on a right-click.
  const fromRow = opener.current?.closest<HTMLElement>(".session-item")?.querySelector<HTMLElement>(".session") ?? opener.current?.closest<HTMLElement>(".session");
  const rowTop = fromRow?.getBoundingClientRect().top ?? anchor.top;
  const roomAbove = rowTop - 12;
  const below = height <= roomBelow || (height > roomAbove && roomBelow >= roomAbove);
  const room = below ? roomBelow : Math.max(0, Math.min(roomAbove, rowTop - 4 - ceiling));
  // Under the ⋯ button it lines up with the button's right edge; at a right-click's
  // point (no width) it opens rightwards, since the sidebar sits at the window's left.
  const across = anchor.width === 0 ? { left: Math.max(8, Math.min(anchor.left, window.innerWidth - 240)), right: "auto" } : { left: "auto", right: Math.max(8, window.innerWidth - anchor.right) };
  const style = {
    position: "fixed" as const,
    ...across,
    ...(below ? { top: anchor.bottom + 4, bottom: "auto" } : { top: "auto", bottom: window.innerHeight - rowTop + 4 }),
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
      <ul ref={list} className="menu-list row-menu" role="menu" aria-label={`Actions for ${s.title}`} style={style} onKeyDown={keys.onKeyDown}>
        {/* Open first: every way out of this list, with the session's own handoff. */}
        <li role="none">
          <button
            type="button"
            role="menuitem"
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
            <MenuSeparator />
            <li role="none">
              <button type="button" role="menuitem" onClick={() => pick({ pinned: !s.pinned })}>
                <IconPin size={14} /> {s.pinned ? "Unpin" : "Pin"}
              </button>
            </li>
            <li role="none">
              <button type="button" role="menuitem" onClick={() => pick({ unread: !s.unread })}>
                <IconDot size={14} /> {s.unread ? "Mark read" : "Mark unread"}
              </button>
            </li>
            <li role="none">
              <button type="button" role="menuitem" onClick={() => pick({ settled: !s.settled })}>
                <IconCheck size={14} /> {s.settled ? "Unsettle" : "Settle"}
              </button>
            </li>
            {snoozed ? (
              <li role="none">
                <button type="button" role="menuitem" onClick={() => pick({ snoozedUntil: null })}>
                  <IconClock size={14} /> Wake now
                </button>
              </li>
            ) : (
              <>
                {/* One row, its choices folded under it: the presets, the limit, and a time of your own. */}
                <li role="none">
                  <button type="button" role="menuitem" aria-expanded={snoozeOpen} onClick={() => setSnoozeOpen((open) => !open)}>
                    <IconClock size={14} /> Snooze
                    <IconChevronDown size={12} className={`menu-disclosure${snoozeOpen ? " is-open" : ""}`} />
                  </button>
                </li>
                {snoozeOpen ? (
                  <li role="none" className="menu-fold">
                    <div role="group" aria-label="Snooze until">
                      {snoozeReset ? (
                        <button type="button" role="menuitem" onClick={() => pick({ snoozedUntil: snoozeReset + 20_000 })}>
                          Until the limit resets
                        </button>
                      ) : null}
                      {snoozeOptions().map((o) => (
                        <button type="button" role="menuitem" key={o.label} onClick={() => pick({ snoozedUntil: o.until })}>
                          {o.label}
                        </button>
                      ))}
                      <button
                        type="button"
                        role="menuitem"
                        onClick={() => {
                          onClose();
                          onSnoozeAt();
                        }}
                      >
                        Until a time…
                      </button>
                    </div>
                  </li>
                ) : null}
              </>
            )}
            {/* Two rules, three tasks when Move is absent: Select joins the state group; with Move up/down
                the pair is a real organise group and keeps the rule between it and Select. */}
            {onMove ? <MenuSeparator /> : null}
            <li role="none">
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onClose();
                  enterSelection(s.id);
                }}
              >
                <IconCheckSquare size={14} /> Select sessions
              </button>
            </li>
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
            <MenuSeparator />
            <li role="none">
              <button type="button" role="menuitem" onClick={() => pick({ archived: !s.archived })}>
                <IconArchive size={14} /> {s.archived ? "Unarchive" : "Archive"}
              </button>
            </li>
          </>
        ) : null}
      </ul>
    </>
  );
}

/**
 * A running row's age slot: how long its run has been going, counting up. Its own second clock, so only this
 * word redraws as the time passes (the list's clock ticks a minute at a time, which would leave a counter
 * saying "<1s" for a minute). A row whose start the listing does not say keeps its age.
 */
function RunElapsed({ s }: { s: ProjectSession }) {
  const now = useNow(true, 1000);
  return <span className="session-time is-elapsed">{runElapsed(s, now) ?? relativeTime(s.updatedAt)}</span>;
}

/**
 * A tagged row's one line of words, piece by piece: the fact that changed (a blocked agent's state word and
 * the note under it, or the agent's own sentence), then the project the row is out of, then a branch no head
 * stated. Each piece is its own span so a compact row gives way in that order (sidebar.css): the project
 * before the fact beside it, and the state's word never.
 */
function TagLine({ tag, fact }: { tag: ProjectTag; fact: TagFact | null }) {
  return (
    <span className={`session-sub-name${fact === null && tag.branch === null ? " is-plain" : ""}`}>
      {fact === null ? null : (
        <>
          <span className="session-sub-fact">
            {fact.kind === "state" ? (
              <>
                <span className="session-sub-state">{fact.word}</span>
                {fact.note ? ` · ${fact.note}` : null}
              </>
            ) : (
              fact.text
            )}
          </span>
          {" "}
          <span className="session-sub-dot" aria-hidden="true">·</span>
          {" "}
        </>
      )}
      <span className="session-sub-project">{tag.name}</span>
      {tag.branch ? (
        <>
          {" "}
          <span className="session-sub-dot" aria-hidden="true">·</span>
          {" "}
          <span className="session-sub-branch">{tag.branch}</span>
        </>
      ) : null}
    </span>
  );
}

function SessionRow({
  s,
  active,
  working,
  harnessName,
  tag,
  stateTone,
  branch = null,
  query = null,
  groupBranch = null,
  showHarness = true,
  slot,
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
  /** The project a row is out of (the flat list, and the sections above the projects): its tag line. */
  tag?: ProjectTag | null;
  /** The hue that project's badge wears in this list (see projectSlots): one hue per project, once for the set. */
  slot?: ProjectMonogram["slot"];
  /** The Needs-you or Working section the row sits in: its heading already names the state, so the row keeps its age. */
  stateTone?: "needs" | "working" | null;
  /** The branch its project is checked out on (shown when it is not the trunk's, nor the head's). */
  branch?: string | null;
  /** The text the list is searching for: the row marks its first hit inside the title. */
  query?: string | null;
  /** The branch the group's head above already states: the row does not repeat it. */
  groupBranch?: string | null;
  /** False where every row of the list is the same harness: the dot would only repeat the heading above. */
  showHarness?: boolean;
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
  const rowRef = useRef<HTMLButtonElement>(null);
  // Where the menu was opened from: Escape hands the focus back there (a right-click leaves it on the row).
  const menuFrom = useRef<HTMLButtonElement | null>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  // The title as the list draws it, and where the search's query sits in it (the row marks that, so a
  // 238px ellipsis does not hide why the row matched).
  const titleText = plainTitle(s.title);
  const hit = query ? matchSpan(titleText, query) : null;
  // A session not saved yet has nothing to mark.
  const markable = !s.id.includes(":live-");
  const { warm } = useContext(RowActions);
  // The line under the title names the project, the agent's own status, how the session began (a
  // delegated task, a routine), or a branch that differs from its group. Without one the row is a
  // single line; its ⋯ replaces the age on hover.
  const sub = rowSubline(s, { tag, branch, groupBranch });
  // Inside its own state section, the leading mark says the state; the meta line keeps the age.
  const state = rowState(s, { working, showHarness, section: stateTone });
  const meta = (
    <span className="session-meta">
      {state.glyph ? <span className={`session-mark ${state.glyph.className}`} role="img" aria-label={state.glyph.label} title={state.glyph.label} /> : null}
      {state.word ? (
        <span className={`session-state is-${state.word.tone}`}>{state.word.text}</span>
      ) : (s.snoozedUntil ?? 0) > Date.now() ? (
        <span className="session-wake" title="Snoozed until then">
          <IconClock size={11} /> {wakeLabel(s.snoozedUntil as number)}
        </span>
      ) : stateTone === "working" ? (
        <RunElapsed s={s} />
      ) : (
        // Inside its own section the mark (a run's ring, the amber dot of a question) says the state and the
        // heading names it: the age stays muted, a third amber cue for one fact.
        <span className="session-time">{relativeTime(s.updatedAt)}</span>
      )}
    </span>
  );
  // On a touch screen a row also slides left for Pin, Archive and Snooze (the menu's own actions); a full swipe is the first.
  const swipeActions: Array<{ label: string; icon: React.ReactNode; change: MarkChange }> = [
    { label: s.pinned ? "Unpin" : "Pin", icon: <IconPin size={16} />, change: { pinned: !s.pinned } },
    { label: s.archived ? "Unarchive" : "Archive", icon: <IconArchive size={16} />, change: { archived: !s.archived } },
    { label: "Snooze", icon: <IconClock size={16} />, change: { snoozedUntil: snoozeOptions()[0]?.until ?? Date.now() + 3_600_000 } },
  ];
  const swipe = useRowSwipe(markable && !selection.on && coarse(), swipeActions.length, () => onMark(swipeActions[0]?.change ?? {}));
  const hover = useRef(0);
  // The row's id outlives its node: the switch a click starts redraws the list under the pointer, and the
  // press must keep the card away past that.
  const { anchor: cardAt, show: showCard, hold: holdCard, hide: hideCard } = useHoverCard(HOVER_CARD_MS, s.id);
  // A card opened by the keyboard sits under its row, where it never covers the row it belongs to.
  const [cardSide, setCardSide] = useState<CardSide>("right");
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
        ref={rowRef}
        type="button"
        className={`session${active ? " is-active" : ""}${selection.ids.has(s.id) ? " is-selected" : ""}${working ? " is-working" : ""}${state.unread ? " is-unread" : ""}${s.archived || s.settled || (s.snoozedUntil ?? 0) > Date.now() ? " is-archived" : ""}`}
        onClick={(e) => {
          if (selection.on) {
            toggleSelection(s.id, e.shiftKey);
            return;
          }
          handoff("sidebar-title", firstLineBox(titleRef.current));
          onOpen(e.ctrlKey || e.metaKey);
        }}
        onMouseDown={(e) => {
          if (e.button === 1) e.preventDefault();
        }}
        // A touch press may be the start of a scroll, so only a mouse's press counts.
        // A press says what the row is for, so its card stays away until the pointer leaves it (the browser
        // re-fires an enter when the row is replaced under a still pointer).
        onPointerDown={(e) => {
          holdCard();
          if (e.pointerType === "mouse" && (e.button === 0 || e.button === 1)) warm(s, "press");
        }}
        onPointerEnter={(e) => {
          if (e.pointerType !== "mouse") return;
          window.clearTimeout(hover.current);
          hover.current = window.setTimeout(() => warm(s, "hover"), HOVER_WARM_MS);
          setCardSide("right");
          if (markable) showCard(e.currentTarget);
          else hideCard();
        }}
        onPointerLeave={() => {
          window.clearTimeout(hover.current);
          hideCard();
        }}
        // A row reached with the keyboard says what it holds too: the same card, under the row, so the
        // row keeps its own focus ring in sight.
        onFocus={(e) => {
          setCardSide("below");
          if (markable) showCard(e.currentTarget);
          else hideCard();
        }}
        onBlur={hideCard}
        aria-describedby={cardAt ? cardId : undefined}
        onAuxClick={(e) => {
          if (e.button !== 1) return;
          e.preventDefault();
          onOpen(true);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          holdCard();
          menuFrom.current = rowRef.current;
          setMenuAt(new DOMRect(e.clientX, e.clientY, 0, 0));
        }}
        onKeyDown={(e) => {
          // The keyboard's context menu (Shift+F10, or the ContextMenu key): at the row's ⋯ button.
          if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
            e.preventDefault();
            holdCard();
            menuFrom.current = rowRef.current;
            setMenuAt(moreRef.current?.getBoundingClientRect() ?? null);
            return;
          }
          if (!move || !e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
          e.preventDefault();
          if (e.key === "ArrowUp" ? move.up : move.down) move.by(e.key === "ArrowUp" ? -1 : 1);
        }}
        aria-current={active ? "true" : undefined}
        title={tag ? `${s.title} · ${tag.name}` : s.title}
      >
        {state.mark === "working" ? (
          <WorkingRing harnessId={s.harnessId} colored />
        ) : state.mark === "needs" ? (
          // Waiting on a person is not work in progress: the row wears the amber mark of a question, not the
          // ring of a run, and a screen reader hears the state it is in.
          <span className="session-asking-dot" role="img" aria-label="Needs you" title="Needs you: waiting for your answer" />
        ) : state.mark === "harness" ? (
          <span className="harness-dot" style={harnessColor(s.harnessId)} role="img" aria-label={harnessName} title={harnessName} />
        ) : (
          // The slot stays (a blank dot), so titles keep one left edge whether or not the row is working.
          <span className="harness-dot is-blank" aria-hidden="true" />
        )}
        <span className={`session-body${sub ? " has-sub" : ""}`}>
          <span className="session-title-line">
            <span className="session-title" ref={titleRef}>
              {hit ? (
                <>
                  {titleText.slice(0, hit[0])}
                  <mark className="title-match">{titleText.slice(hit[0], hit[1])}</mark>
                  {titleText.slice(hit[1])}
                </>
              ) : (
                titleText
              )}
            </span>
            {sub ? null : <span className="session-slot">{meta}</span>}
          </span>
          {state.unread ? <span className="visually-hidden">Unread</span> : null}
          {sub ? (
            <span className={`session-sub${sub.kind === "branch" ? " is-branch" : ""}${sub.kind === "agent" ? ` session-agent is-${sub.state}` : ""}`} title={sub.kind === "agent" ? `${sub.line} · set by the agent ${ago(sub.at)}` : undefined}>
              {sub.kind === "tag" ? <ProjectBadge id={sub.tag.id} name={sub.tag.name} size={12} slot={slot} /> : null}
              {sub.kind === "tag" ? <TagLine tag={sub.tag} fact={sub.fact} /> : <span className="session-sub-name">{sub.text}</span>}
              <span className="session-slot">{meta}</span>
            </span>
          ) : null}
        </span>
      </button>
      <button
        ref={moreRef}
        type="button"
        className="icon-btn session-more"
        aria-label={`More for ${s.title}`}
        aria-haspopup="menu"
        aria-expanded={menuAt !== null}
        onClick={() => {
          menuFrom.current = moreRef.current;
          setMenuAt(moreRef.current?.getBoundingClientRect() ?? null);
        }}
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
      {cardAt && !menuAt ? <SessionCard s={s} anchor={cardAt} side={cardSide} harnessName={harnessName} project={tag?.name ?? ""} id={cardId} provenance={provenance ?? null} /> : null}
      {menuAt ? (
        <RowMenu
          s={s}
          anchor={menuAt}
          opener={menuFrom}
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

/**
 * A calendar heading: its words, and how many sessions the bucket holds at the age column's end. When the
 * page drew only part of the bucket the heading says both ("12 of 15"), because a bare count would then
 * disagree with the rows under it; the rest is in its tooltip.
 */
function DateHeading({ label, count, shown = count, first = false }: { label: string; count: number; shown?: number; first?: boolean }) {
  const part = shown < count;
  return (
    // A heading, for a reader that walks the list by its structure: the dates are its levels, and the
    // count keeps its unit for the same reason ("1 session", not "1"). The first heading of a group is
    // marked so a search's list can tuck its own first line up under "Search every chat" (sidebar.css).
    <li className={`date-divider${first ? " is-first" : ""}`} role="heading" aria-level={3}>
      <span className="date-label">{label}</span>
      <span className="date-count" {...(part ? { title: `${count - shown} more ${count - shown === 1 ? "session" : "sessions"}` } : {})}>
        {part ? <span className="date-part">{`${shown} of ${count}`}</span> : count}
        {/* The number alone would be read as part of the date; the unit says what it counts. */}
        <span className="visually-hidden"> {count === 1 ? "session" : "sessions"}</span>
      </span>
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
  // A foldable head carries its own name: the label and the count would run together as one string
  // ("Working3 sessions") read from its contents, so it says them as words instead.
  return (
    <li className={`project-group section-group ${className}${open ? " is-open" : ""}`} data-testid={testId}>
      <div className="project-head" role="heading" aria-level={3} aria-label={`${title}, ${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`}>
        {onToggle ? (
          // The heading is the outer project head: button labels otherwise flatten away its semantics.
          <div className="section-heading">
            <button type="button" className="project-toggle" aria-expanded={open} aria-label={`${title}, ${sessions.length} ${sessions.length === 1 ? "session" : "sessions"}`} onClick={onToggle}>
              <span className="section-icon" aria-hidden="true">{icon}</span>
              <span className="project-name section-name">{title}</span>
              {/* After the label, not before the icon: the icon keeps the rows' mark column. */}
              <IconChevronDown size={12} className="group-chevron" />
              <span className="group-count">
                {sessions.length}
                <span className="visually-hidden"> {sessions.length === 1 ? "session" : "sessions"}</span>
              </span>
            </button>
          </div>
        ) : (
          <span className="project-toggle is-static">
            <span className="section-icon" aria-hidden="true">{icon}</span>
            <span className="project-name section-name">{title}</span>
            <span className="group-count">
              {sessions.length}
              <span className="visually-hidden"> {sessions.length === 1 ? "session" : "sessions"}</span>
            </span>
          </span>
        )}
      </div>
      {open ? (
        <ul className="session-sublist">
          <ActiveWash />
          {sessions.map(row)}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The session list is one tab stop, not two per row: ↑/↓ walk its rows (Home/End to the ends, no wrapping,
 * since the list has a first and a last), Enter opens the focused one, and every row's ⋯ leaves the tab
 * order — Shift+F10 or the ContextMenu key opens that row's menu where a mouse would right-click.
 */
function useListKeys(list: RefObject<HTMLUListElement | null>) {
  // The tab stop follows the row on screen: the open one, else where the keyboard already is, else the first.
  useLayoutEffect(() => {
    const root = list.current;
    if (!root) return;
    const rows = Array.from(root.querySelectorAll<HTMLElement>(".session-item > .session"));
    if (rows.length === 0) return;
    const stop = rows.find((el) => el === document.activeElement) ?? rows.find((el) => el.getAttribute("aria-current") === "true") ?? rows[0];
    for (const el of rows) if (el.tabIndex !== (el === stop ? 0 : -1)) el.tabIndex = el === stop ? 0 : -1;
    for (const more of root.querySelectorAll<HTMLElement>(".session-more")) more.tabIndex = -1;
  });
  return (e: React.KeyboardEvent<HTMLUListElement>) => {
    // Alt+↑/↓ is the row's own move, and the browser keeps Ctrl/⌘/Shift chords.
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const rows = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(".session-item > .session"));
    const at = rows.indexOf(document.activeElement as HTMLElement);
    const next = menuStep(e.key, at, rows.length, false);
    if (next === null || next === at) return;
    e.preventDefault();
    rows[next]?.focus();
  };
}

/** One active wash per visible list. Its identity is the actual row marked aria-current. */
function ActiveWash() {
  const ref = useRef<HTMLLIElement>(null);
  const previous = useRef<{ row: HTMLElement | null; box: Box | null }>({ row: null, box: null });
  const place = (el: HTMLElement, row: HTMLElement): Box => {
    const box = row.getBoundingClientRect();
    const parent = el.parentElement?.getBoundingClientRect();
    Object.assign(el.style, {
      left: `${box.left - (parent?.left ?? 0)}px`,
      top: `${box.top - (parent?.top ?? 0)}px`,
      width: `${box.width}px`,
      height: `${box.height}px`,
    });
    return box;
  };
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const row = el.parentElement?.querySelector<HTMLElement>('.session[aria-current="true"]') ?? null;
    el.hidden = !row;
    if (!row) {
      previous.current = { row: null, box: null };
      return;
    }
    const box = place(el, row);
    const from = previous.current;
    const onscreen = (r: Box) => r.top + r.height > 0 && r.top < window.innerHeight;
    if (from.row && from.row !== row && from.box && onscreen(box) && onscreen(from.box)) {
      el.dataset.moved = "true";
      glide(from.box, el, { duration: MORPH_IN_MS, height: true, spring: true, id: "morph:session-active" });
    } else {
      el.dataset.moved = "false";
    }
    previous.current = { row, box };
  });
  useEffect(() => {
    const el = ref.current;
    const list = el?.parentElement;
    if (!el || !list || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const row = list.querySelector<HTMLElement>('.session[aria-current="true"]');
      if (row) previous.current = { row, box: place(el, row) };
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
  return <li ref={ref} className="session-active-bg" role="presentation" aria-hidden="true" />;
}

/** One project: header (collapse, new chat here), date-divided sessions, "Show N more". */
function ProjectGroupView({
  group,
  searching,
  query,
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
  slots,
}: {
  /** Every project's badge hue in this sidebar, by name (project-badge.ts's projectSlots). */
  slots: Map<string, ProjectMonogram["slot"]>;
  group: ProjectGroup;
  searching: boolean;
  /** The text the list is searching for, for a row to mark inside its title. */
  query: string;
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
  // How many "Show more" pages of this folder are open: each adds SHOW_MORE rows to its first page.
  const [pages, setPages] = useState(0);
  const [dragged, setDragged] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; place: "before" | "after" } | null>(null);
  const { workspace, sessions, current, checkout, sharesRepo } = group;
  // The head says the branch once for every row under it: any branch off the trunk, and the trunk too when
  // another group checks out the same repository (then "main" is what tells the two apart).
  const headBranch = checkout?.branch && (sharesRepo || !isTrunkBranch(checkout.branch)) ? checkout.branch : null;
  // One harness in the list means one dot on every row: the sidebar's harness row above already names it,
  // so the rows drop theirs and their titles keep the slot.
  const mixedHarness = sessions.some((row) => row.harnessId !== sessions[0]?.harnessId);
  const limit = (current ? VISIBLE_CURRENT : VISIBLE_OTHER) + pages * SHOW_MORE;
  const weekStart = useMemo(localeWeekStart, []);
  const all = useMemo(() => projectRows(sessions, { now, weekStartsOn: weekStart, ...(order ? { order } : {}) }), [sessions, now, weekStart, order]);
  // A heading's count is its bucket's whole size, which the folder's preview and its pages do not change.
  const countIn = (key: string) => all.filter((r) => r.kind === "session" && r.group === key).length;
  // A search lists matches, not a hand order.
  const arranging = !searching;
  const groupOf = (id: string) => all.flatMap((r) => (r.kind === "session" && r.s.id === id ? [r.group] : []))[0];
  const reorder = (ids: string[] | null) => {
    if (ids) onReorder(ids);
  };

  const rows: React.ReactNode[] = [];
  let count = 0;
  // A preview is a folder's first few rows: its dates are not worth a heading until the folder is opened,
  // because the age on each row already says when. A search is the caller's list, headings and all.
  const previewing = !searching && sessions.length > limit;
  for (const [i, r] of all.entries()) {
    if (r.kind === "divider") {
      // A divider shows only when a session under it does.
      const next = all[i + 1];
      if (!previewing && next?.kind === "session") rows.push(<DateHeading key={`d-${r.key}`} label={r.label} count={countIn(r.key)} />);
      continue;
    }
    if (!searching && count >= limit) break;
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
        showHarness={mixedHarness}
        branch={checkout?.branch ?? null}
        query={query}
        groupBranch={headBranch}
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
          {/* The head lies on the rows' columns: its badge hangs in their 10px mark slot, its name starts on
              their titles' edge, and the fold chevron follows the name so it takes no column of its own
              (a section head's chevron does the same). */}
          <span className="head-mark"><ProjectBadge id={workspace.id} name={workspace.name} slot={slots.get(workspace.name)} /></span>
          <span className="project-name">{workspace.name}</span>
          {headBranch ? <span className="project-branch">{headBranch}</span> : null}
          {!open && sessions.some(isWorking) ? <WorkingRing colored={false} /> : null}
          <IconChevronDown size={12} className="group-chevron" />
          {/* The folder's size, always: a number that appeared only while the head hid rows read as an alert
              rather than as the folder's size, and the one column then meant six different things. */}
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
          <ActiveWash />
          {rows}
          {sessions.length === 0 ? <li className="sidebar-note">No sessions here yet</li> : null}
          {hidden > 0 ? (
            <li>
              <button type="button" className="show-more" onClick={() => setPages((n) => n + 1)}>
                {/* The head above already names the folder: repeating it here said it twice, one row apart. */}
                Show {Math.min(hidden, SHOW_MORE)} more
                <IconChevronDown size={12} />
              </button>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

/** A folder's place in a project menu: badge, name, home-relative path and one aligned count column. */
function ProjectMenuItem({ id, name, path, home, count, checked, slot, onPick }: { id: string; name: string; path: string; home: string; count: number; checked: boolean; slot?: ProjectMonogram["slot"]; onPick: () => void }) {
  return (
    <button type="button" role="menuitemradio" aria-checked={checked} title={path} onClick={onPick}>
      <ProjectBadge id={id} name={name} size={16} slot={slot} />
      <span className="project-menu-name">{name}</span>
      {/* Home-relative and cut in the middle: the root and the folder's own name are the parts worth keeping. */}
      <span className="project-menu-path muted">{shortPath(path, home)}</span>
      {/* Every row reserves the check's slot, so counts have one right edge. */}
      <span className="project-menu-meta">
        {count !== undefined ? <span className="group-count">{count}</span> : null}
        {checked ? <IconCheck size={13} className="project-menu-check" /> : <span className="project-menu-check" aria-hidden="true" />}
      </span>
    </button>
  );
}

/** The head of a focused project: an "All projects" back button, then one button naming it (`project · branch ⌄`) that switches project, and new chat. */
function FocusedHeader({
  workspace,
  checkout,
  home,
  canStartChat,
  onNewChat,
  onShowAll,
  onFocus,
  scope,
  slots,
}: {
  workspace: WorkspaceInfo;
  checkout?: Checkout;
  /** The home folder, so the menu names folders where they live (see project-path.ts). */
  home: string;
  canStartChat: boolean;
  onNewChat: (ws: WorkspaceInfo) => void;
  onShowAll: () => void;
  onFocus: (workspaceId: string) => void;
  scope: Array<{ workspace: WorkspaceInfo; count: number; current: boolean }>;
  /** Every project's badge hue in this sidebar, by name: the menu's folders wear what the list's do. */
  slots: Map<string, ProjectMonogram["slot"]>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const { render: showMenu, leaving } = useLeave(menuOpen);
  const [iconOpen, setIconOpen] = useState(false);
  const icons = useProjectIcons();
  const headWrap = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLUListElement>(null);
  const switchRef = useRef<HTMLButtonElement>(null);
  useDismiss(headWrap, menuOpen, () => setMenuOpen(false));
  // Its own keyboard: the arrows walk it as one tab stop, Escape closes it and returns to the switch button.
  const keys = useMenuKeys(menu, { open: menuOpen, close: () => setMenuOpen(false), opener: switchRef });
  const pick = (run: () => void) => {
    setMenuOpen(false);
    run();
  };
  return (
    <div className="project-head focus-head" ref={headWrap} data-testid="focused-project">
      {/* Back is its own button, not a chevron on the switch: a ‹ inside the switch read as a back
          action but opened the menu, and the current project's accent rule leaked onto it. The menu's
          first item ("All projects") stays as the second path out. */}
      <button type="button" className="icon-btn focus-back" aria-label="All projects" title="All projects" onClick={onShowAll}>
        <IconArrowLeft size={13} className="focus-back-chevron" />
      </button>
      <button
        ref={switchRef}
        type="button"
        className="project-toggle focus-switch"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title={workspace.path}
        onClick={() => setMenuOpen((v) => !v)}
      >
        <span className="project-name">{workspace.name}</span>
        {/* A branch says where the folder is out of; on the trunk it is the default, so the head stays quiet. */}
        {isTrunkBranch(checkout?.branch) ? null : <span className="project-branch">{checkout?.branch}</span>}
        <IconChevronDown size={12} className="group-chevron" />
      </button>
      <button type="button" className="icon-btn project-new" aria-label={`New chat in ${workspace.name}`} title={`New chat in ${workspace.name} in a new tab`} disabled={!canStartChat} onClick={() => onNewChat(workspace)}>
        <IconPlus size={13} />
      </button>
      {showMenu ? (
        <>
          <div className="menu-backdrop" onClick={() => setMenuOpen(false)} aria-hidden="true" />
          <ul ref={menu} className={`menu-list focus-menu${leaving ? " is-leaving" : ""}`} role="menu" aria-label="Project" onKeyDown={keys.onKeyDown}>
            <li role="none" className="focus-menu-all">
              <button type="button" role="menuitem" onClick={() => pick(onShowAll)}>
                <IconChevronLeft size={13} />
                <span className="project-menu-name">All projects</span>
                <span className="project-menu-meta">
                  {scope.length > 0 ? <span className="group-count">{scope.reduce((n, p) => n + p.count, 0)}</span> : null}
                  <span className="project-menu-check" aria-hidden="true" />
                </span>
              </button>
            </li>
            {/* The folders are the choices, so they are radios and the one you are in is checked. "Set an icon…"
                is an action on that folder, not a place: it goes last, under its own rule. */}
            {scope.map((p) => (
              <li key={p.workspace.id} role="none">
                <ProjectMenuItem id={p.workspace.id} name={p.workspace.name} path={p.workspace.path} home={home} count={p.count} checked={p.current} slot={slots.get(p.workspace.name)} onPick={() => pick(() => onFocus(p.workspace.id))} />
              </li>
            ))}
            <MenuSeparator />
            <li role="none">
              <button type="button" role="menuitem" onClick={() => pick(() => setIconOpen(true))}>
                <IconImage size={13} />
                <span className="project-menu-name">Set an icon…</span>
              </button>
            </li>
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
  query,
  home,
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
  slots,
}: {
  focused: NonNullable<ReturnType<typeof focusProject>>;
  query: string;
  home: string;
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
  /** Every project's badge hue in this sidebar, by name: the switch menu's folders wear what the list's do. */
  slots: Map<string, ProjectMonogram["slot"]>;
}) {
  const [pages, setPages] = useState(0);
  const { workspace, checkout, sections } = focused;
  const total = sections.reduce((n, sec) => n + sec.sessions.length, 0);
  // The current project's first page spreads over the date sections as they come, newest first, and each
  // "Show more" adds SHOW_MORE rows to it.
  const allSessions = sections.flatMap((sec) => sec.sessions);
  const mixedHarness = allSessions.some((row) => row.harnessId !== allSessions[0]?.harnessId);
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
    const list = sec.sessions.slice(0, Math.max(0, VISIBLE_CURRENT + pages * SHOW_MORE - count));
    if (list.length === 0) continue;
    if (sec.label !== "") rows.push(<DateHeading key={`d-${sec.label}`} label={sec.label} count={sec.sessions.length} shown={list.length} />);
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
          showHarness={mixedHarness}
          branch={checkout?.branch ?? null}
          query={query}
          groupBranch={checkout?.branch ?? null}
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
      <FocusedHeader workspace={workspace} {...(checkout ? { checkout } : {})} home={home} canStartChat={canStartChat} onNewChat={onNewChat} onShowAll={onShowAll} onFocus={onFocus} scope={scope} slots={slots} />
      <ul className="session-sublist">
        <ActiveWash />
        {sections.length === 0 ? <li className="sidebar-note">No past sessions here yet</li> : rows}
        {hidden > 0 ? (
          <li>
            <button type="button" className="show-more" onClick={() => setPages((n) => n + 1)}>
              Show {Math.min(hidden, SHOW_MORE)} more in {workspace.name}
              <IconChevronDown size={12} />
            </button>
          </li>
        ) : null}
      </ul>
    </li>
  );
}

export function Sidebar(props: {
  open: boolean;
  /** The home folder (the server's), so the project menu shows `~/…/name` rather than a cut-off absolute path. */
  home: string;
  /** Counts folders picked by hand (the picker, a project's +): a pick names the list, a session elsewhere does not. */
  picked: number;
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
  /** Beside the Settings button: the theme menu. */
  themeMenu?: React.ReactNode;
  onClose: () => void;
  /** Wide screens: fold the sidebar away (the chat header gets the expand button). */
  onCollapse: () => void;
}) {
  const current = props.harnesses.find((h) => h.id === props.harnessId);
  const names = useMemo(() => new Map(props.harnesses.map((h) => [h.id as string, h.displayName])), [props.harnesses]);
  const resumable = (s: ProjectSession) => props.harnesses.some((h) => h.id === s.harnessId && h.capabilities.supportsResumeCommand);
  // The drawer's list wears a 12px fade under the head once it has scrolled: the row being cut off reads as
  // scrolled, not as broken. Desktop draws its sticky date head instead.
  const [listScrolled, setListScrolled] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showSettled, setShowSettled] = useState(false);
  const [showSnoozed, setShowSnoozed] = useState(false);
  // Open by default: a run in progress is the one thing in the list that is about to need a person. A
  // device that folded it keeps its own choice (the fold is saved like the filters beside it).
  const [workingOpen, setWorkingOpen] = useState(() => load<boolean>("workingOpen", true));
  // Snoozes end on the minute.
  const now = useNow(true, 60_000);
  const isActiveSession = (s: ProjectSession) =>
    (props.activeSessionId !== null && s.id === props.activeSessionId) || (s.liveChatId !== undefined && s.liveChatId === props.activeChatId);
  // What each session is doing now: the open chat's live status beats the listing's.
  const isWorking = (s: ProjectSession) => (isActiveSession(s) ? statusWorking(props.activeStatus) : statusWorking(s.status));
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
  // Focus mode's section scoping happens below, next to `focused`; `sections` stays the global one for
  // its counts (the snoozed/settled/archived toggles) and the empty-state checks.
  const quickCount = useMemo(
    () => quickCounts(unhidden, groupOptions, isWorking),
    [unhidden, props.harnessId, props.activeStatus, props.activeSessionId, props.activeChatId, now],
  );
  // The Recent view (sidebar-view.ts, whose switch is beside search) is one flat list across the
  // projects; the Projects view is the grouped list below. A harness with no projects has no grouping
  // to show, so there both views are the flat list.
  const [view] = useSidebarView();
  const weekStart = useMemo(localeWeekStart, []);
  const [recentLimit, setRecentLimit] = useState(RECENT_PAGE);
  const flat = view === "recent" || !projectScoped(props.harnesses, props.harnessId ?? "");
  // A page of the list belongs to the list it was turned on: a new view, harness, or search starts at 12 again.
  useEffect(() => setRecentLimit(RECENT_PAGE), [view, props.harnessId, props.query]);
  const recent = useMemo(
    () => recentRows(overview, { ...groupOptions, weekStartsOn: weekStart }, recentLimit),
    [overview, props.query, props.harnessId, showArchived, showSettled, showSnoozed, props.activeSessionId, props.activeChatId, now, weekStart, recentLimit],
  );
  // The flat list's first date heading, so a search's list can tuck its first line up under "Search every
  // chat" (sidebar.css, .is-search): a search's results are that row's own, not a group after it.
  const firstHeading = recent.rows.find((r) => r.kind === "divider") ?? null;

  // The focused project (Hermes Desktop's one-folder view). "auto" follows the current folder; "all" is the
  // user's own choice, and so is a named project: both hold while sessions open in other folders, and only
  // automatic following (or a project that left the list) gives way to the folder that moved.
  const [focus, setFocus] = useState<string | "all" | "auto">("auto");
  const currentId = props.workspace?.id ?? null;
  const [lastCurrent, setLastCurrent] = useState(currentId);
  if (currentId !== lastCurrent) {
    setLastCurrent(currentId);
    setFocus((chosen) => (chosen === "all" || (chosen !== "auto" && props.overview.workspaces.some((w) => w.id === chosen)) ? chosen : "auto"));
  }
  // A folder picked by hand names the list again; opening a session elsewhere leaves a chosen list where it is.
  const lastPick = useRef(props.picked);
  if (props.picked !== lastPick.current) {
    lastPick.current = props.picked;
    if (focus !== "auto") setFocus("auto");
  }
  // A projectless harness's flat history has no projects to focus, and neither has a lone project: with one,
  // "All projects" is the same list, so the plain group head stays instead of growing a back row that goes
  // nowhere. The count is the whole overview's, so a filter does not switch the layout under the pointer.
  const focusable = projectScoped(props.harnesses, props.harnessId ?? "") && props.overview.workspaces.length > 1;
  const focusId = flat || !focusable || focus === "all" ? null : focus === "auto" ? currentId : focus;
  const sessionList = useRef<HTMLUListElement>(null);
  const onListKeyDown = useListKeys(sessionList);
  useViewSlide(sessionList, focusId ?? "all");
  const focused = useMemo(() => {
    if (!focusId) return null;
    const order = props.harnessId ? overview.orders?.[`${props.harnessId}:${focusId}`] : undefined;
    return focusProject(overview, focusId, { ...groupOptions, ...(order ? { order } : {}) });
  }, [overview, focusId, props.query, props.harnessId, showArchived, showSettled, showSnoozed, props.activeSessionId, props.activeChatId, now]);
  // The focused project's name, taken from the overview rather than from `focused`: while a search runs the
  // focused list narrows to the query, and a project with no match would have no name to say the scope with.
  const focusedName = focusId === null ? null : (overview.workspaces.find((w) => w.id === focusId)?.name ?? null);
  const selection = useSelectionMode();
  // The ids in the order the sections show them, for a Shift-click run.
  const selectionOrder = useMemo(
    () =>
      flat
        ? recent.rows.flatMap((r) => (r.kind === "session" ? [r.s.id] : []))
        : focused
          ? focused.sections.flatMap((sec) => sec.sessions.map((x) => x.id))
          : groups.flatMap((g) => g.sessions.map((x) => x.id)),
    [flat, recent, focused, groups],
  );
  useEffect(() => setSelectionOrder(selectionOrder), [selectionOrder]);

  const asideRef = useRef<HTMLElement>(null);
  const { open } = props;
  // Whether the rail is too narrow to read a lone project's name in a compact row (sidebar.css, .is-narrow).
  // Measured here rather than by a container query: `container-type` is layout containment, and that would
  // make the sidebar the containing block for the row menu and the hover card drawn inside it — clipped by
  // the panel's own overflow instead of floating over the chat beside it.
  const [narrow, setNarrow] = useState(false);
  // Whether the field can show its whole placeholder (TIGHT_FIELD): read by the same observer, so the rail's
  // width is one measurement, not two.
  const [tightField, setTightField] = useState(false);
  useLayoutEffect(() => {
    const el = asideRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const read = () => {
      const width = el.getBoundingClientRect().width;
      setNarrow(width < NARROW_RAIL);
      setTightField(width < TIGHT_FIELD);
    };
    read();
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Drawer mode: Escape closes from anywhere (the backdrop owns outside clicks) and Tab stays inside, so the
  // chat behind the drawer — inert over there — is never reached. Focus moves in once on open and goes back
  // to the button that opened it on close, never to the body.
  useDismiss(asideRef, open, () => {
    // An open popover consumes Escape before its owner outside the drawer's frame; the parent stays open.
    // Only a popup's trigger counts: an open section or folder head is also aria-expanded, and with a run
    // going (the Working section is open) Escape stopped closing the drawer.
    if (!asideRef.current?.querySelector('[aria-haspopup][aria-expanded="true"]')) props.onClose();
  }, { escape: true, outside: false });
  const trapTab = useFocusTrap(asideRef, open);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    opener.current = (document.activeElement as HTMLElement | null) ?? null;
    asideRef.current?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
    return () => {
      // The button that opens the drawer is the chat header's, so the focus goes back there (a touch press
      // does not focus what it pressed, which is why the captured element is only the fallback).
      const back = document.querySelector<HTMLElement>(".drawer-open") ?? (opener.current?.isConnected ? opener.current : null);
      back?.focus();
    };
  }, [open]);

  const isActive = isActiveSession;
  const searching = props.query.trim() !== "";
  // "Search every chat" is offered for a query worth looking for (two letters), and the list under it then
  // tucks up to it: the row is the list's own search, not a group above it.
  const searchEverywhere = !!props.onSearchAll && props.query.trim().length >= 2;
  // Focus mode claims one folder, so its Needs-you/Working sections must hold that folder's sessions
  // alone: the section lists read a workspace-narrowed overview, while the rail's and the tab title's
  // counts (computed elsewhere from the whole overview) stay global. A search shows every project
  // instead, and the section lists stay empty then (sidebarSections returns none while searching).
  const scopedOverview = useMemo(() => {
    if (flat || focusId === null || searching) return overview;
    return { ...overview, sessions: overview.sessions.filter((s) => s.workspaceId === focusId) };
  }, [flat, focusId, searching, overview]);
  const { pinned, needs, working } = useMemo(
    () => (scopedOverview === overview ? sections : sidebarSections(scopedOverview, groupOptions)),
    [scopedOverview, overview, sections, groupOptions],
  );
  // A filter that leaves nothing to list offers to clear it; the matching count reads the full overview.
  // Enter opens the full-text search for an empty local result; local matches still work as usual.
  const noLocalMatches = (searching && props.overview.sessions.every((s) => s.harnessId !== props.harnessId || !s.title.toLowerCase().includes(props.query.trim().toLowerCase())));
  // A filter that leaves nothing to list (the current project's empty heading does not count).
  const quickEmpty =
    quick !== null &&
    pinned.length === 0 &&
    needs.length === 0 &&
    working.length === 0 &&
    (flat ? recent.rows.length === 0 : groups.every((g) => g.sessions.length === 0));
  // Every list that is one harness drops the row dots (see ProjectGroupView); the sections and the
  // projectless history read the whole overview for it.
  // The Recent list and the sections show only the selected harness's sessions, so that is the set to judge: reading
  // the whole overview put the same blue dot on every row of anyone who uses two harnesses.
  const oneHarness = new Set(overview.sessions.filter((s) => !props.harnessId || s.harnessId === props.harnessId).map((s) => s.harnessId)).size <= 1;
  // One hue per project, worked out once over the sidebar's whole set of folders: two of three projects
  // used to wear the same colour by chance (the slot is a hash of the name, mod 4), and a badge that
  // repeats says nothing. The set is the overview's projects, so a folder keeps its hue in its head, in the
  // switch menu and on the flat list's rows; the sort inside projectSlots is what makes that stable.
  const badgeSlots = useMemo(() => projectSlots(overview.workspaces.map((w) => w.name)), [overview.workspaces]);
  const tagSlot = (tag: ProjectTag | null): ProjectMonogram["slot"] | undefined => (tag === null ? undefined : badgeSlots.get(tag.name));
  const sectionRow = (s: ProjectSession, stateTone?: "needs" | "working") => (
    <SessionRow
      key={s.id}
      s={s}
      active={isActive(s)}
      working={isWorking(s)}
      harnessName={names.get(s.harnessId) ?? s.harnessId}
      showHarness={!oneHarness}
      stateTone={stateTone}
      query={props.query}
      tag={projectTag(overview, s)}
      slot={tagSlot(projectTag(overview, s))}
      provenance={provenanceOf(s, hideCtx)}
      onOpen={(newTab) => props.onOpenSession(s, newTab)}
      onMark={(change) => props.onMarkSession(s, change)}
    />
  );
  // The flat list's rows: one line, the project it is out of as its tag.
  const flatRow = (s: ProjectSession, tag: ProjectTag | null) => (
    <SessionRow
      key={s.id}
      s={s}
      active={isActive(s)}
      working={isWorking(s)}
      harnessName={names.get(s.harnessId) ?? s.harnessId}
      showHarness={!oneHarness}
      query={props.query}
      tag={tag}
      slot={tagSlot(tag)}
      provenance={provenanceOf(s, hideCtx)}
      onOpen={(newTab) => props.onOpenSession(s, newTab)}
      onMark={(change) => props.onMarkSession(s, change)}
    />
  );

  return (
    <RowActions.Provider value={{ warm: props.onWarmSession, snoozeReset: limitResetAt(props.limits), ...(props.onOpenBeside ? { beside: props.onOpenBeside } : {}), resumable, ...(props.onReclaimSession ? { reclaim: props.onReclaimSession } : {}), notice: props.onNotice }}>
      <div className={`backdrop${props.open ? " is-open" : ""}`} onClick={props.onClose} aria-hidden="true" />
      <aside
        ref={asideRef}
        className={`sidebar${props.open ? " is-open" : ""}${narrow ? " is-narrow" : ""}`}
        aria-label="Sessions"
        {...(props.open ? { role: "dialog", "aria-modal": true } : {})}
        onKeyDown={(e) => {
          // A document-level filter or row-menu listener owns Escape first, else the drawer closes.
          if (e.key === "Escape" && open) {
            props.onClose();
            return;
          }
          if (e.key === "Escape" && selection.on) {
            e.stopPropagation();
            leaveSelection();
            return;
          }
          trapTab(e);
        }}
      >
        <div className="sidebar-head">
          <HarnessMenu
            variant="row"
            label="Harness"
            menuLabel="Harness"
            currentId={props.harnessId}
            choices={props.harnesses.map((h) => ({ harness: h, blocked: h.available ? null : (h.reason ?? "Not available") }))}
            static={props.harnesses.length === 1}
            hint="Filters the list; new chats start with this agent."
            onPick={props.onHarness}
          />
          <button type="button" className="icon-btn sidebar-compose" aria-label="New chat" aria-keyshortcuts="Control+N Meta+N" title={`New chat (${shortcutHint("new")})`} onClick={props.onNewChat} disabled={props.newChatDisabled !== null}>
            <IconPlus size={16} />
          </button>
          <button type="button" className="icon-btn sidebar-collapse" aria-label="Collapse sidebar" title="Collapse sidebar" onClick={props.onCollapse}>
            <IconSidebar size={16} />
          </button>
          <button type="button" className="icon-btn drawer-close" aria-label="Close menu" onClick={props.onClose}>
            <IconX size={16} />
          </button>
        </div>
        {props.tabs}
        {props.newChatDisabled ? <p className="sidebar-note">{props.newChatDisabled}</p> : null}
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
                <div className="search-field">
                  <IconSearch size={14} />
                  <input
                    type="search"
                    placeholder={tightField ? "Search" : "Search sessions"}
                    value={props.query}
                    onChange={(e) => props.onQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && props.onSearchAll && noLocalMatches && props.query.trim().length >= 2) {
                        e.preventDefault();
                        props.onSearchAll(props.query.trim());
                        return;
                      }
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
                  <SidebarViewMenu />
                  <SidebarFilters quick={quick} quickCounts={quickCount} onQuickChange={pickQuick} hide={hide} counts={hideCount} onChange={pickHide} onRefresh={props.onRefresh} onNewRoom={props.onNewRoom} roomsAvailable={props.harnessId === "awui" || !props.harnesses.some((h) => h.id === "awui")} />
                </div>
              </>
            )}
          </div>
          {focusedName !== null && searching ? (
            // A search looks in every project, while the rail still names one: the list says whose results
            // these are not, and the way back out of it (the focus head is not drawn while they are shown).
            <div className="search-scope">
              <span>Searching all projects</span>
              <button type="button" className="search-scope-back" onClick={() => props.onQuery("")} title={`Clear the search and go back to ${focusedName}`}>
                Back to {focusedName}
              </button>
            </div>
          ) : null}
          {!selection.on && quick ? (
            <div className="quick-filters" role="group" aria-label="Filter sessions">
              <button type="button" className="quick-chip" aria-label={`Clear ${QUICK_LABELS[quick]} filter`} onClick={() => pickQuick(null)}>
                <span className="quick-chip-label">{QUICK_LABELS[quick]}</span> <span aria-hidden="true">×</span>
              </button>
            </div>
          ) : null}
          {searchEverywhere ? (
            <button type="button" className="search-all" onClick={() => props.onSearchAll?.(props.query.trim())}>
              <IconSearch size={13} />
              <span className="search-all-label">
                Search every chat for <q>{props.query.trim()}</q>
              </span>
              <kbd className="search-all-hint" aria-hidden="true">↵</kbd>
            </button>
          ) : null}
          {props.sessionsError ? <p className="sidebar-note is-warning">{props.sessionsError}</p> : null}
          <ul
            ref={sessionList}
            className={`session-list${listScrolled ? " is-scrolled" : ""}`}
            aria-busy={props.sessionsLoading}
            aria-label={flat ? "Sessions" : "Sessions by project"}
            onKeyDown={onListKeyDown}
            onScroll={(e) => {
              const at = e.currentTarget.scrollTop > 0;
              if (at !== listScrolled) setListScrolled(at);
            }}
          >
            {listScrolled ? <li className="list-scrim" role="presentation" aria-hidden="true" /> : null}
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
                row={(s) => sectionRow(s, "needs")}
              />
            ) : null}
            {working.length > 0 ? (
              <SectionList
                className="working-group"
                testId="working-group"
                icon={<WorkingRing colored={false} still />}
                title="Working"
                sessions={working}
                open={workingOpen}
                onToggle={() => {
                  setWorkingOpen(!workingOpen);
                  save("workingOpen", !workingOpen);
                }}
                row={(s) => sectionRow(s, "working")}
              />
            ) : null}
            {pinned.length > 0 ? (
              <SectionList className="pinned-group" testId="pinned-group" icon={<IconPin size={14} />} title="Pinned" sessions={pinned} row={(s) => sectionRow(s)} />
            ) : null}
            {quickEmpty ? null : flat ? (
              // One flat list across projects (the Recent view, and every harness with no projects
              // to group): date headings, each row tagged with its project, a page at a time. One
              // group of its own, so the active row's wash keeps a scrolling box to sit in.
              <li className={`project-group is-open flat-group${searchEverywhere ? " is-search" : ""}`}>
                <ul className="session-sublist">
                  <ActiveWash />
                  {recent.rows.map((r) =>
                    r.kind === "divider" ? (
                      <DateHeading key={`d-${r.key}`} label={r.label} count={r.count} shown={r.shown} first={r === firstHeading} />
                    ) : (
                      flatRow(r.s, r.tag)
                    ),
                  )}
                  {recent.hidden > 0 ? (
                    <li>
                      <button type="button" className="show-more" onClick={() => setRecentLimit((n) => n + SHOW_MORE)}>
                        Show {recent.hidden} more
                        <IconChevronDown size={12} />
                      </button>
                    </li>
                  ) : null}
                </ul>
              </li>
            ) : focused && !searching ? (
              <FocusedProjectView
                focused={focused}
                query={props.query}
                home={props.home}
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
                slots={badgeSlots}
              />
            ) : (
              groups.map((g) => (
                <ProjectGroupView
                  key={g.workspace.id}
                  group={g}
                  searching={searching}
                  query={props.query}
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
                  slots={badgeSlots}
                />
              ))
            )}
            {quickEmpty && !props.sessionsLoading && !props.sessionsError ? (
              <li className="sidebar-note quick-empty">
                No sessions match
                <button type="button" className="btn btn-small btn-ghost" onClick={() => pickQuick(null)}>
                  Clear filter
                </button>
              </li>
            ) : null}
            {!quick && !props.sessionsLoading && (flat ? recent.rows.length === 0 : groups.length === 0) && pinned.length === 0 && needs.length === 0 && working.length === 0 && !props.sessionsError ? (
              <li className="sidebar-note">{searching ? "No matching sessions" : "No chats yet. Start one on the right."}</li>
            ) : null}
            {/* The last child, so it paints over the rows by order: the fade into the footer tray is a scrim
                here, never a mask on the scroller (see .list-tray in sidebar.css). */}
            <li className="list-tray" role="presentation" aria-hidden="true" />
          </ul>
        </div>

        {!searching && (sections.counts.snoozed > 0 || sections.counts.settled > 0 || sections.counts.archived > 0) ? (
          <div className="list-toggles">
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
          </div>
        ) : null}
        {!selection.on && needs.length > 0 ? (
          // A scrolled phone list has no rail: keep its one action that needs a person within reach.
          <button
            type="button"
            className={`new-chat needs-you-shortcut${listScrolled ? " is-visible" : ""}`}
            aria-label={`${needs.length} ${needs.length === 1 ? "needs" : "need"} you`}
            onClick={() => {
              const row = sessionList.current?.querySelector<HTMLElement>('[data-testid="needs-group"] .session');
              row?.focus();
              row?.click();
              props.onClose();
            }}
          >
            <IconWarning size={15} />
            {needs.length} {needs.length === 1 ? "needs" : "need"} you
          </button>
        ) : null}
        <button type="button" className="new-chat drawer-new-chat" onClick={props.onNewChat} disabled={props.newChatDisabled !== null} aria-label="New chat in folder">
          <IconPlus size={15} /> New chat
        </button>
        <div className="sidebar-footer">
          {props.footer}
          {props.themeMenu}
          <button type="button" className="icon-btn sidebar-settings" aria-label="Settings" title="Settings" onClick={props.onSettings}>
            <IconSettings size={16} />
          </button>
        </div>
        {props.resizer}
      </aside>
    </RowActions.Provider>
  );
}
