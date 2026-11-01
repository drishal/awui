// One room, whole: its header (topic, workspace, status, spend), the live
// transcript, the approvals its bots raised, the queue of messages waiting,
// the roster drawer, and the composer. Data and mutations come from App; this
// component decides only how the room is drawn.
import { useState } from "react";
import type { BotProfile, Bootstrap, InteractionAnswer, InteractionRequest, RoomInfo } from "../../shared/protocol.js";
import { isLiveTurn, liveInvocations, type RoomState } from "../room-state.js";
import { ROOM_CONN_LABEL, TURN_STATUS_LABEL } from "../use-room-stream.js";
import { dollars, shortTokens, tokensOf } from "../usage.js";
import { IconAgents, IconArchive, IconEdit, IconGauge } from "../icons.js";
import { ApprovalStack } from "./ApprovalStack.js";
import { RoomComposer } from "./RoomComposer.js";
import { RoomConversation } from "./RoomConversation.js";
import { RoomMembers } from "./RoomMembers.js";

export function RoomView({
  roomId,
  state,
  gone,
  conn,
  boot,
  bots,
  workspacePath,
  onSend,
  onAnswer,
  onStop,
  onCancelQueued,
  onLoadOlder,
  onEditRoom,
  onRoom,
  onExport,
  onNotice,
  onNewBot,
  onEditBot,
  onLeave,
}: {
  roomId: string;
  state: RoomState | null;
  /** A room that never loaded (deleted before its snapshot); `state.gone` covers one that ended later. */
  gone: string | null;
  conn: keyof typeof ROOM_CONN_LABEL;
  boot: Bootstrap;
  bots: BotProfile[] | null;
  /** The room workspace's path, for tool rows and file links (the wire carries only its name). */
  workspacePath: string;
  onSend: (text: string, mentions: string[], clientId: string) => Promise<boolean>;
  onAnswer: (requestId: string, answer: InteractionAnswer) => void;
  onStop: () => void;
  onCancelQueued: (turnId: string) => void;
  onLoadOlder: () => Promise<void>;
  onEditRoom: () => void;
  onRoom: (room: RoomInfo) => void;
  onExport: () => void;
  onNotice: (text: string) => void;
  onNewBot: () => void;
  onEditBot: (botId: string) => void;
  onLeave: () => void;
}) {
  const [membersOpen, setMembersOpen] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);

  if (!state) {
    return (
      <div className={`room-view is-opening${gone ? " is-gone" : ""}`} aria-busy={gone === null}>
        <div className="room-opening">
          {gone ? (
            <>
              <p role="alert">{gone}</p>
              <button type="button" className="btn btn-small" onClick={onLeave}>
                Back to chats
              </button>
            </>
          ) : (
            <p>{conn === "connecting" || conn === "reconnecting" ? "Opening the room…" : ROOM_CONN_LABEL[conn]}</p>
          )}
        </div>
      </div>
    );
  }

  const { room } = state;
  // A queued turn's prompt is drawn once, in the queue above the composer: the transcript skips those records.
  const queuedTurnIds = new Set(state.queued.map((turn) => turn.id));
  const harnessName = (id: string) => boot.harnesses.find((h) => h.id === id)?.displayName ?? id;
  const active = isLiveTurn(state.activeTurn) ? state.activeTurn : null;
  const busy = active !== null || state.queued.length > 0;
  const stopping = state.activeTurn?.state === "stopping";
  const status = active ? TURN_STATUS_LABEL[active.state] ?? active.state : state.queued.length > 0 ? `${state.queued.length} queued` : "Idle";
  const tokens = tokensOf(state.usage);
  const pendingRequests = state.pending;
  const firstPending = pendingRequests[0] ?? null;
  const pendingMember = firstPending ? state.room.members.find((m) => m.id === firstPending.memberId) ?? null : null;

  const loadOlder = async () => {
    setLoadingOlder(true);
    try {
      await onLoadOlder();
    } finally {
      setLoadingOlder(false);
    }
  };

  const answer = (request: InteractionRequest, value: InteractionAnswer) => {
    const entry = pendingRequests.find((p) => p.request.id === request.id) ?? pendingRequests.find((p) => p.id === request.id);
    if (!entry) {
      onNotice("That request is no longer waiting.");
      return;
    }
    onAnswer(entry.id, value);
  };

  return (
    <div className="room-view" data-testid="room-view" data-room={roomId}>
      <header className="room-header">
        <div className="room-head-main">
          <div className="room-sub">
            {room.archived ? (
              <span className="room-tag is-archived">
                <IconArchive size={12} /> Archived
              </span>
            ) : null}
            <span className={`room-status is-${active ? active.state : busy ? "queued" : "idle"}`} data-testid="room-status">
              {status}
            </span>
            <span className="room-workspace" title="Every bot runs in this project">
              {room.workspaceName}
            </span>
            <span className="room-member-count">
              <IconAgents size={12} /> {room.members.length} {room.members.length === 1 ? "bot" : "bots"}
            </span>
            <span className="room-spend-head" title="Usage over this room's invocations">
              <IconGauge size={12} /> {shortTokens(tokens)} tokens
              {state.usage.cost !== null ? ` · ${dollars(state.usage.cost, true)}` : state.usage.unpriced > 0 ? " · cost unavailable" : ""}
            </span>
          </div>
          {room.topic ? <p className="room-topic">{room.topic}</p> : null}
        </div>
        <div className="room-head-actions">
          <button type="button" className="btn btn-small" aria-label="Room members" aria-expanded={membersOpen} onClick={() => setMembersOpen(true)}>
            <IconAgents size={14} /> Members
          </button>
          <button type="button" className="btn btn-small btn-ghost" aria-label="Edit room" onClick={onEditRoom}>
            <IconEdit size={14} /> Edit
          </button>
          <button type="button" className="btn btn-small btn-ghost" aria-label="Export room as Markdown" onClick={onExport}>
            Export
          </button>
        </div>
      </header>

      {state.gone ? (
        <div className="banner banner-error" role="alert">
          {state.gone}
          <button type="button" className="btn btn-small" onClick={onLeave}>
            Back to chats
          </button>
        </div>
      ) : null}
      {conn !== "connected" ? (
        <div className={`conn-banner conn-${conn}`} role="status">
          {ROOM_CONN_LABEL[conn]}…
        </div>
      ) : null}
      {room.archived ? (
        <div className="banner banner-info" role="status">
          This room is archived. Its transcript stays; unarchive it in Edit to run bots again.
        </div>
      ) : null}
      {room.leadMemberId === null && room.members.some((m) => m.enabled) ? (
        <div className="banner banner-warning" role="status">
          No lead is selected. Pick one in Members, or address a bot with @mention.
        </div>
      ) : null}

      <RoomConversation
        room={room}
        records={state.records}
        live={liveInvocations(state)}
        hasOlder={state.hasOlder}
        loadingOlder={loadingOlder}
        onLoadOlder={() => void loadOlder()}
        workspace={workspacePath}
        harnessName={harnessName}
        queuedTurnIds={queuedTurnIds}
      />

      {state.queued.length > 0 ? (
        <section className="room-queue" aria-label="Queued messages">
          <ul>
            {state.queued.map((turn) => (
              <li key={turn.id} className="room-queue-row">
                <span className="room-queue-state">{TURN_STATUS_LABEL[turn.state] ?? turn.state}</span>
                <span className="room-queue-text" title={turn.text}>
                  {turn.text.length > 120 ? `${turn.text.slice(0, 119)}…` : turn.text}
                </span>
                <span className="room-queue-to">
                  {turn.directMemberIds
                    .map((id) => room.members.find((m) => m.id === id)?.handle ?? null)
                    .filter((h): h is string => h !== null)
                    .map((h) => `@${h}`)
                    .join(" ") || "lead"}
                </span>
                <button type="button" className="btn btn-small btn-ghost" aria-label={`Cancel queued message ${turn.text.slice(0, 40)}`} onClick={() => onCancelQueued(turn.id)}>
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {pendingRequests.length > 0 && firstPending ? (
        <section className="room-approvals" aria-label={`${pendingMember?.name ?? "A bot"} is waiting for you`}>
          <p className="room-approval-who">
            <span className="room-approval-dot" aria-hidden="true" />
            {pendingMember?.name ?? "A bot"}
            {pendingMember?.role ? <span className="room-role">{pendingMember.role}</span> : null} is waiting for you
          </p>
          <ApprovalStack
            pending={pendingRequests.map((p) => p.request)}
            busy={false}
            stopping={stopping}
            onAnswer={answer}
            onStop={onStop}
          />
        </section>
      ) : null}

      <RoomComposer
        key={room.id}
        room={room}
        members={state.room.members}
        busy={busy}
        stopping={stopping}
        queuedCount={state.queued.length}
        invocationCount={active?.invocationCount ?? 0}
        usage={state.usage}
        onSend={(text, mentions, clientId) => onSend(text, mentions, clientId)}
        onStop={onStop}
        onNotice={onNotice}
      />

      {membersOpen ? (
        <RoomMembers
          room={state.room}
          bots={bots}
          busy={busy}
          onRoom={onRoom}
          onNotice={onNotice}
          onNewBot={onNewBot}
          onEditBot={onEditBot}
          onClose={() => setMembersOpen(false)}
        />
      ) : null}
    </div>
  );
}
