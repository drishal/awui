// The room's transcript: user messages with the bots they addressed, then one
// card per direct run in rank order, with each consultation folded under the
// requester it belongs to. Nothing here invents a speaker: a consultation is
// titled with the two real members, and its consultant's card is the run.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChatItem, RoomInfo, RoomMemberView, RoomRecord } from "../../shared/protocol.js";
import { findMember } from "../room-state.js";
import { formatWhen } from "../turn-time.js";
import { IconChevronDown, IconInfo, IconWarning, Spinner } from "../icons.js";
import { BotRun } from "./BotRun.js";
import { ProcessItem } from "./Conversation.js";
import { Collapse } from "./Collapse.js";

const PIN_DISTANCE_PX = 96;

type RunRecord = Extract<RoomRecord, { kind: "bot_run" }>;
type ConsultRecord = Extract<RoomRecord, { kind: "consultation" }>;

export function RoomConversation({
  room,
  records,
  live,
  hasOlder,
  loadingOlder,
  onLoadOlder,
  workspace,
  harnessName,
  queuedTurnIds,
}: {
  room: RoomInfo;
  records: RoomRecord[];
  /** Output streaming for invocations whose record has not landed yet. */
  live: Array<{ invocationId: string; items: ChatItem[] }>;
  hasOlder: boolean;
  loadingOlder: boolean;
  onLoadOlder: () => void;
  workspace: string;
  harnessName: (harnessId: string) => string;
  /** Turns still waiting to run: their prompt shows once, in the queue above the composer, not here. */
  queuedTurnIds: ReadonlySet<string>;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // A reader who scrolled up keeps their place: only a pinned view follows new records.
  useEffect(() => {
    const el = scroll.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [records]);

  const onScroll = () => {
    const el = scroll.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < PIN_DISTANCE_PX;
  };

  // A queued turn's prompt is drawn once, in the queue above the composer: the accepted
  // message record stays out of the transcript until its turn starts.
  const visible = useMemo(() => (queuedTurnIds.size === 0 ? records : records.filter((record) => !(record.kind === "user" && queuedTurnIds.has(record.turnId)))), [records, queuedTurnIds]);
  const groups = useMemo(() => groupByTurn(visible), [visible]);
  return (
    <div className="room-transcript" ref={scroll} onScroll={onScroll} aria-label={`${room.name} transcript`} data-testid="room-transcript">
      {hasOlder ? (
        <div className="room-older">
          <button type="button" className="btn btn-small" disabled={loadingOlder} onClick={onLoadOlder}>
            {loadingOlder ? "Loading…" : "Load older messages"}
          </button>
        </div>
      ) : null}
      {groups.length === 0 ? (
        <div className="room-empty">
          <p className="muted">
            {room.leadMemberId ? (
              <>
                Say something to the room: without an <code>@mention</code> it goes to the lead only.
              </>
            ) : (
              <>This room has no lead. Pick one in Members before sending a message.</>
            )}
          </p>
        </div>
      ) : null}
      {groups.map((group) => (
        <TurnGroup key={group.key} group={group} room={room} workspace={workspace} harnessName={harnessName} />
      ))}
      {live
        .filter((run) => run.items.length > 0)
        .map((run) => (
          <section key={run.invocationId} className="room-turn is-live" aria-label="Streaming output">
            <div className="bot-run is-running" data-testid="bot-run-live">
              <header className="bot-run-head">
                <span className="bot-dot" aria-hidden="true" />
                <span className="bot-name">A bot is working…</span>
                <span className="bot-status is-running">
                  <Spinner size={12} /> Working
                </span>
              </header>
              <div className="bot-run-items">
                {run.items.map((item) => (
                  <ProcessItem key={item.id} item={item} workspace={workspace} />
                ))}
              </div>
            </div>
          </section>
        ))}
    </div>
  );
}

interface Group {
  key: string;
  turnId: string | null;
  records: RoomRecord[];
}

/** Consecutive records of one turn, in seq order; a turn-less notice keeps its own place. */
function groupByTurn(records: RoomRecord[]): Group[] {
  const groups: Group[] = [];
  for (const record of records) {
    const turnId = record.turnId;
    const last = groups[groups.length - 1];
    if (last && (turnId === null || last.turnId === turnId)) last.records.push(record);
    else groups.push({ key: `${turnId ?? "note"}:${record.id}`, turnId, records: [record] });
  }
  return groups;
}

function TurnGroup({ group, room, workspace, harnessName }: { group: Group; room: RoomInfo; workspace: string; harnessName: (id: string) => string }) {
  const member = (id: string) => findMember(room, id);
  const consultations = group.records.filter((r): r is ConsultRecord => r.kind === "consultation");
  const byConsult = new Map(consultations.map((c) => [c.id, c]));
  // The consultation a consultant's run answers, if its record is in this group.
  const consultsFor = (run: RunRecord) => (run.consultOf ? byConsult.get(run.consultOf) ?? null : null);
  const shownConsults = new Set<string>();

  const rows: ReactNode[] = [];
  for (const record of group.records) {
    switch (record.kind) {
      case "user":
        rows.push(<UserMessage key={record.id} record={record} member={member} />);
        break;
      case "notice":
        rows.push(<RoomNotice key={record.id} record={record} />);
        break;
      case "bot_run": {
        const consult = consultsFor(record);
        if (consult && shownConsults.has(consult.id)) break;
        if (consult) {
          shownConsults.add(consult.id);
          rows.push(
            <ConsultationFold
              key={consult.id}
              consult={consult}
              runs={runsForConsult(group.records, consult.id)}
              from={member(consult.fromMemberId)}
              to={member(consult.toMemberId)}
              room={room}
              workspace={workspace}
              harnessName={harnessName}
            />,
          );
          break;
        }
        const after = consultationsBefore(group.records, record.memberId, record.seq).length;
        rows.push(
          <div key={record.id} className="room-run-block">
            {after > 0 ? <p className="room-synthesis">{member(record.memberId)?.name ?? "The requester"} answered again after {after} {after === 1 ? "consultation" : "consultations"}.</p> : null}
            <BotRun record={record} member={member(record.memberId)} harnessName={harnessName} workspace={workspace} />
          </div>,
        );
        break;
      }
      case "consultation":
        // A consultation whose consultant never ran (refused/failed, or still running).
        if (shownConsults.has(record.id)) break;
        shownConsults.add(record.id);
        rows.push(
          <ConsultationFold
            key={record.id}
            consult={record}
            runs={runsForConsult(group.records, record.id)}
            from={member(record.fromMemberId)}
            to={member(record.toMemberId)}
            room={room}
            workspace={workspace}
            harnessName={harnessName}
          />,
        );
        break;
    }
  }
  return <section className="room-turn">{rows}</section>;
}

function runsForConsult(records: RoomRecord[], consultId: string): RunRecord[] {
  return records.filter((r): r is RunRecord => r.kind === "bot_run" && r.consultOf === consultId);
}

function consultationsBefore(records: RoomRecord[], memberId: string, seq: number): ConsultRecord[] {
  return records.filter((r): r is ConsultRecord => r.kind === "consultation" && r.fromMemberId === memberId && r.seq < seq);
}

function UserMessage({ record, member }: { record: Extract<RoomRecord, { kind: "user" }>; member: (id: string) => RoomMemberView | null }) {
  const addressed = record.mentions.map((id) => ({
    handle: member(id)?.handle ?? "removed",
    name: member(id)?.name ?? "a removed member",
  }));
  return (
    <div className="room-user" data-testid="room-user-message">
      <div className="room-user-meta">
        <span className="room-user-you">You</span>
        <span title={formatWhen(record.at)}>{formatWhen(record.at)}</span>
        {addressed.length > 0 ? (
          <span className="room-mentions" aria-label={`Addressed to ${addressed.map((a) => a.name).join(", ")}`}>
            {addressed.map((a, i) => (
              <span key={`${record.id}:${i}`} className="room-mention-chip" title={a.name}>
                @{a.handle}
              </span>
            ))}
          </span>
        ) : (
          <span className="room-mentions muted">to the lead</span>
        )}
      </div>
      <div className="room-user-text">{record.text}</div>
    </div>
  );
}

function RoomNotice({ record }: { record: Extract<RoomRecord, { kind: "notice" }> }) {
  return (
    <p className={`room-notice is-${record.level}`} role={record.level === "error" ? "alert" : undefined}>
      {record.level === "info" ? <IconInfo size={13} /> : <IconWarning size={13} />}
      <span>{record.text}</span>
    </p>
  );
}

function ConsultationFold({
  consult,
  runs,
  from,
  to,
  room,
  workspace,
  harnessName,
}: {
  consult: ConsultRecord;
  runs: RunRecord[];
  from: RoomMemberView | null;
  to: RoomMemberView | null;
  room: RoomInfo;
  workspace: string;
  harnessName: (id: string) => string;
}) {
  const [open, setOpen] = useState(true);
  const fromName = from?.name ?? "A removed member";
  const toName = to?.name ?? "a removed member";
  const outcome = consult.outcome;
  return (
    <div className={`consult${open ? " is-open" : ""} is-${outcome}`} data-testid="consultation">
      <button type="button" className="consult-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IconChevronDown size={13} className="consult-chevron" />
        <span className="consult-who">
          {fromName} asked {toName}
        </span>
        <span className={`consult-outcome is-${outcome}`}>
          {outcome === "answered" ? "answered" : outcome === "refused" ? "not permitted" : outcome === "failed" ? "failed" : runs.length === 0 ? "waiting" : "answering"}
          {outcome === "requested" && runs.length === 0 ? <Spinner size={11} /> : null}
        </span>
      </button>
      <Collapse open={open}>
        <div className="consult-body">
          <blockquote className="consult-question">{consult.question}</blockquote>
          {consult.reason ? <p className="consult-reason">{consult.reason}</p> : null}
          {runs.map((run) => (
            <BotRun key={run.id} record={run} member={findMember(room, run.memberId)} harnessName={harnessName} workspace={workspace} nested />
          ))}
        </div>
      </Collapse>
    </div>
  );
}
