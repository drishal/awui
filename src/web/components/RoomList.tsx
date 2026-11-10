// The sidebar's Rooms section: Board's rooms beside ordinary chats, with what
// each one is doing (idle, queued, working, waiting for you), how many
// approvals are pending, and an archived fold. Opening a room is navigation
// (#room=<id>), not a tab.
import { useEffect, useRef, useState } from "react";
import type { RoomSummary } from "../../shared/protocol.js";
import { useNow } from "../hooks.js";
import { load, save } from "../storage.js";
import { ago } from "../turns.js";
import { shortTokens, tokensOf } from "../usage.js";
import { IconArchive, IconChevronDown, IconPlus, IconRefresh } from "../icons.js";

const STATUS_LABEL: Record<RoomSummary["status"], string> = {
  idle: "Idle",
  queued: "Queued",
  running: "Working",
  waiting: "Waiting for you",
};

function sortRooms(a: RoomSummary, b: RoomSummary): number {
  return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0) || a.name.localeCompare(b.name);
}

export function RoomList({
  rooms,
  activeRoomId,
  loading,
  error,
  onOpen,
  onNew,
  onRefresh,
}: {
  /** null until the first list arrives. */
  rooms: RoomSummary[] | null;
  activeRoomId: string | null;
  loading: boolean;
  error: string | null;
  onOpen: (roomId: string) => void;
  onNew: () => void;
  onRefresh: () => void;
}) {
  // Folded until the user opens it or a room exists to show: an empty group must not push everyone's sessions down.
  const [open, setOpen] = useState(() => load<boolean | null>("roomsOpen", null) ?? false);
  const [showArchived, setShowArchived] = useState(() => load<boolean>("roomsArchived", false));
  const choseOpen = useRef(load<boolean | null>("roomsOpen", null) !== null);
  const now = useNow(true, 60_000);
  const live = (rooms ?? []).filter((r) => !r.archived).sort(sortRooms);
  const archived = (rooms ?? []).filter((r) => r.archived).sort(sortRooms);
  const pendingOf = (list: RoomSummary[]) => list.reduce((n, r) => n + r.pendingCount, 0);
  const pending = pendingOf(live);
  useEffect(() => {
    if (!choseOpen.current && live.length > 0) setOpen(true);
  }, [live.length]);

  const toggle = () => {
    choseOpen.current = true;
    setOpen(!open);
    save("roomsOpen", !open);
  };
  const toggleArchived = () => {
    setShowArchived(!showArchived);
    save("roomsArchived", !showArchived);
  };

  return (
    <li className={`project-group section-group rooms-group${open ? " is-open" : ""}`} data-testid="rooms-group">
      <div className="project-head" role="group" aria-label="Rooms">
        <button type="button" className="project-toggle" aria-expanded={open} onClick={toggle}>
          <IconChevronDown size={12} className="group-chevron" />
          <IconRooms />
          <span className="project-name">Rooms</span>
          {live.length > 0 ? <span className="group-count">{live.length}</span> : null}
          {pending > 0 ? (
            <span className="room-badge is-pending" title={`${pending} waiting for you`}>
              {pending}
            </span>
          ) : null}
        </button>
        <span className="room-group-actions">
          <button type="button" className="icon-btn" aria-label="Refresh rooms" title="Refresh rooms" onClick={onRefresh}>
            <IconRefresh size={13} />
          </button>
          <button type="button" className="icon-btn" aria-label="New room" title="New room" onClick={onNew}>
            <IconPlus size={14} />
          </button>
        </span>
      </div>
      {open ? (
        <ul className="session-sublist" aria-label="Rooms">
          {error ? <li className="sidebar-note is-warning">{error}</li> : null}
          {rooms !== null && live.length === 0 ? (
            <li className="room-empty-note">
              <p>Rooms put several named bots on one topic: one leads, and you decide who else runs.</p>
              <button type="button" className="btn btn-small" onClick={onNew}>
                Create a room
              </button>
            </li>
          ) : null}
          {live.map((room) => (
            <li key={room.id} className={`room-row${room.id === activeRoomId ? " is-current" : ""}`}>
              <button
                type="button"
                className="room-row-open"
                aria-current={room.id === activeRoomId ? "page" : undefined}
                aria-label={`Open room ${room.name}`}
                onClick={() => onOpen(room.id)}
              >
                <span className={`room-dot is-${room.status}`} aria-hidden="true" />
                <span className="room-row-name">{room.name}</span>
                <span className="room-row-meta">
                  {room.pendingCount > 0 ? (
                    <span className="room-badge is-pending" title={`${room.pendingCount} waiting for you`}>
                      {room.pendingCount}
                    </span>
                  ) : null}
                  <span className={`room-row-status is-${room.status}`}>{STATUS_LABEL[room.status]}</span>
                </span>
              </button>
              <p className="room-row-sub">
                {room.leadName ? <>Lead: {room.leadName}</> : <span className="is-warning">No lead</span>}
                <span aria-hidden="true"> · </span>
                {room.memberCount} {room.memberCount === 1 ? "bot" : "bots"}
                {room.lastActivityAt ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    {ago(room.lastActivityAt, now)}
                  </>
                ) : null}
                {tokensOf(room.usage) > 0 ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    {shortTokens(tokensOf(room.usage))} tokens
                  </>
                ) : null}
              </p>
            </li>
          ))}
          {archived.length > 0 ? (
            <li className="room-archived-toggle">
              <button type="button" className="show-more" aria-pressed={showArchived} onClick={toggleArchived}>
                <IconArchive size={13} /> {showArchived ? "Hide archived rooms" : `${archived.length} archived`}
              </button>
            </li>
          ) : null}
          {showArchived
            ? archived.map((room) => (
                <li key={room.id} className={`room-row is-archived${room.id === activeRoomId ? " is-current" : ""}`}>
                  <button type="button" className="room-row-open" aria-label={`Open archived room ${room.name}`} onClick={() => onOpen(room.id)}>
                    <IconArchive size={13} aria-hidden="true" />
                    <span className="room-row-name">{room.name}</span>
                  </button>
                  <p className="room-row-sub">
                    {room.leadName ? <>Lead: {room.leadName}</> : <span className="is-warning">No lead</span>}
                  </p>
                </li>
              ))
            : null}
          {loading && rooms === null ? <li className="sidebar-note">Loading rooms…</li> : null}
        </ul>
      ) : null}
    </li>
  );
}

/** Rooms glyph in the house 16px stroke style (a room of two seats). */
function IconRooms() {
  return (
    <svg className="icon" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M2.5 3.5h11v9h-11z" />
      <path d="M5 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM11 7.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z" />
      <path d="M3.5 10.5c.5-1.2 2.5-1.2 3 0M9.5 10.5c.5-1.2 2.5-1.2 3 0" />
    </svg>
  );
}
