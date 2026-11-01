// The room's chain of command, on a desktop drawer and a phone sheet alike:
// every membership with its rank, whether it may lead, whether others may
// consult it, who it may consult, enable/disable, session reset (future native
// session only), removal, and adding a profile to the room.
import { useState } from "react";
import type { BotProfile, RoomInfo, RoomMemberView } from "../../shared/protocol.js";
import { BOARD_HANDLE_PATTERN } from "../../shared/protocol.js";
import { errorText } from "../api.js";
import { addMember, patchMember, patchRoom, removeMember, resetMember } from "../rooms.js";
import { handleFrom } from "../room-mentions.js";
import { harnessColor } from "../harness-colors.js";
import { IconChevronDown, IconChevronUp, IconPlus, IconRefresh, IconX } from "../icons.js";
import { ConfirmButton } from "./ConfirmButton.js";
import { BoardSelect } from "./BoardSelect.js";
import { Dialog } from "./Dialog.js";

const byRank = (a: RoomMemberView, b: RoomMemberView) => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

export function RoomMembers({
  room,
  bots,
  busy,
  onRoom,
  onNotice,
  onNewBot,
  onEditBot,
  onClose,
}: {
  room: RoomInfo;
  bots: BotProfile[] | null;
  /** A turn is running: membership edits wait until it settles (the server refuses them anyway). */
  busy: boolean;
  /** A mutation's fresh RoomInfo, which replaces the room everywhere. */
  onRoom: (room: RoomInfo) => void;
  onNotice: (text: string) => void;
  onNewBot: () => void;
  onEditBot: (botId: string) => void;
  onClose: () => void;
}) {
  const [working, setWorking] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // A refusal is said inside the sheet, where the person who asked can see it.
  const [notice, setNotice] = useState<string | null>(null);
  const say = (text: string) => {
    setNotice(text);
    onNotice(text);
  };
  const members = [...room.members].sort(byRank);
  const lead = members.find((m) => m.id === room.leadMemberId) ?? null;

  /** One mutation at a time, with the row that asked for it busy; the first failure is said, not thrown. */
  const run = async (key: string, fn: () => Promise<RoomInfo>) => {
    setWorking(key);
    try {
      onRoom(await fn());
      setNotice(null);
    } catch (e) {
      say(errorText(e));
    } finally {
      setWorking(null);
    }
  };

  const move = (member: RoomMemberView, dir: -1 | 1) => {
    const ordered = [...members];
    const at = ordered.findIndex((m) => m.id === member.id);
    const to = at + dir;
    if (to < 0 || to >= ordered.length) return;
    const a = ordered[at] as RoomMemberView;
    const b = ordered[to] as RoomMemberView;
    ordered[at] = b;
    ordered[to] = a;
    // Renumbering every changed position keeps the server's order identical to this list.
    const changes = ordered.map((m, i) => ({ m, i })).filter(({ m, i }) => m.rank !== i);
    void (async () => {
      setWorking(`rank:${member.id}`);
      try {
        let latest = room;
        for (const { m, i } of changes) latest = await patchMember(room.id, m.id, { rank: i });
        onRoom(latest);
        setNotice(null);
      } catch (e) {
        say(errorText(e));
      } finally {
        setWorking(null);
      }
    })();
  };

  return (
    <Dialog title={`${room.name}: members`} onClose={onClose} className="room-members-dialog">
      <div className="room-members">
        {notice ? (
          <p className="room-warning" role="alert">
            {notice}
          </p>
        ) : null}
        <label className="room-field">
          <span>Lead</span>
          <BoardSelect
            label="Room lead"
            value={room.leadMemberId ?? ""}
            disabled={busy || working !== null}
            onChange={(leadMemberId) => {
              if (leadMemberId) void run("lead", () => patchRoom(room.id, { leadMemberId }));
            }}
            options={[{ value: "", label: "No lead" }, ...members.filter((m) => m.canLead && m.enabled).map((m) => ({ value: m.id, label: `${m.name} (@${m.handle})` }))]}
          />
        </label>
        {lead === null ? <p className="room-warning">No enabled member can lead. Enable one of the can-lead members below.</p> : null}

        <ul className="room-roster" aria-label="Room members">
          {members.map((member, index) => (
            <MemberRow
              key={member.id}
              room={room}
              member={member}
              members={members}
              first={index === 0}
              last={index === members.length - 1}
              busy={busy || working !== null}
              working={working === `rank:${member.id}` || working === `row:${member.id}`}
              onMove={(dir) => move(member, dir)}
              onRun={(fn) => void run(`row:${member.id}`, fn)}
              onEditBot={onEditBot}
            />
          ))}
        </ul>

        {adding ? (
          <AddMember
            room={room}
            bots={bots}
            onRoom={onRoom}
            onNotice={say}
            onClose={() => setAdding(false)}
          />
        ) : (
          <button
            type="button"
            className="btn btn-small room-add-member"
            disabled={busy || bots === null}
            onClick={() => (bots !== null && bots.length === 0 ? onNewBot() : setAdding(true))}
          >
            <IconPlus size={13} />
            {bots === null ? "Loading bots…" : bots.length === 0 ? "Create a bot first" : "Add a member"}
          </button>
        )}
        {bots !== null && bots.length === 0 ? (
          <p className="muted">A bot is a reusable profile: a harness, a model, and its instructions. Create one to add it here.</p>
        ) : null}
      </div>
    </Dialog>
  );
}

function MemberRow({
  room,
  member,
  members,
  first,
  last,
  busy,
  working,
  onMove,
  onRun,
  onEditBot,
}: {
  room: RoomInfo;
  member: RoomMemberView;
  members: RoomMemberView[];
  first: boolean;
  last: boolean;
  busy: boolean;
  working: boolean;
  onMove: (dir: -1 | 1) => void;
  onRun: (fn: () => Promise<RoomInfo>) => void;
  onEditBot: (botId: string) => void;
}) {
  const isLead = member.id === room.leadMemberId;
  const others = members.filter((m) => m.id !== member.id);
  const [handle, setHandle] = useState(member.handle);
  const handleValid = BOARD_HANDLE_PATTERN.test(handle) && handle === handle.trim();
  return (
    <li className={`room-member${member.enabled ? "" : " is-off"}${isLead ? " is-lead" : ""}`} data-testid="room-member">
      <div className="room-member-head">
        <span className="room-member-accent" style={member.accent ? ({ "--bot-accent": `var(--${member.accent}, var(--accent))` } as React.CSSProperties) : undefined} aria-hidden="true" />
        <span className="room-member-name">{member.name}</span>
        {isLead ? <span className="room-member-tag is-lead">lead</span> : null}
        {member.role ? <span className="room-member-role">{member.role}</span> : null}
        <span className="badge badge-harness" style={harnessColor(member.harnessId)}>
          {member.harnessId}
        </span>
        {member.model ? <span className="room-member-model">{member.model}</span> : null}
        {!member.enabled ? <span className="room-member-tag is-off">disabled</span> : null}
        <span className="room-member-actions">
          <button type="button" className="icon-btn" aria-label={`Move ${member.name} up`} title="Move up" disabled={busy || first} onClick={() => onMove(-1)}>
            <IconChevronUp size={13} />
          </button>
          <button type="button" className="icon-btn" aria-label={`Move ${member.name} down`} title="Move down" disabled={busy || last} onClick={() => onMove(1)}>
            <IconChevronDown size={13} />
          </button>
          <button type="button" className="btn btn-small" aria-label={`Edit ${member.name}'s profile`} disabled={busy} onClick={() => onEditBot(member.botId)}>
            Profile
          </button>
          <ConfirmButton
            label={`Reset ${member.name}'s session`}
            confirmLabel="New session?"
            className="btn btn-small btn-ghost"
            disabled={busy}
            onConfirm={() => onRun(() => resetMember(room.id, member.id))}
          >
            <IconRefresh size={13} />
          </ConfirmButton>
          <ConfirmButton
            label={`Remove ${member.name}`}
            confirmLabel="Remove?"
            className="btn btn-small btn-ghost"
            danger
            disabled={busy}
            onConfirm={() => onRun(() => removeMember(room.id, member.id))}
          >
            <IconX size={13} />
          </ConfirmButton>
        </span>
      </div>
      <div className="room-member-policy">
        <label className="room-check">
          <input
            type="checkbox"
            checked={member.enabled}
            disabled={busy}
            aria-label={`Enable ${member.name}`}
            onChange={(e) => onRun(() => patchMember(room.id, member.id, { enabled: e.target.checked }))}
          />
          enabled
        </label>
        <label className="room-check">
          <input
            type="checkbox"
            checked={member.canLead}
            disabled={busy}
            aria-label={`Let ${member.name} lead`}
            onChange={(e) => onRun(() => patchMember(room.id, member.id, { canLead: e.target.checked }))}
          />
          can lead
        </label>
        <label className="room-check">
          <input
            type="checkbox"
            checked={member.consultable}
            disabled={busy}
            aria-label={`Allow consulting ${member.name}`}
            onChange={(e) => onRun(() => patchMember(room.id, member.id, { consultable: e.target.checked }))}
          />
          may be consulted
        </label>
        <label className="room-check room-handle">
          <span>@{""}</span>
          <input
            type="text"
            value={handle}
            aria-label={`${member.name}'s handle`}
            aria-invalid={!handleValid}
            disabled={busy}
            onChange={(e) => setHandle(e.target.value)}
            onBlur={() => {
              if (!handleValid || handle === member.handle) {
                setHandle(member.handle);
                return;
              }
              onRun(() => patchMember(room.id, member.id, { handle }));
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
        </label>
        {working ? <span className="room-member-working">Saving…</span> : null}
      </div>
      {member.consultable && others.length > 0 ? (
        <details className="room-allowlist">
          <summary>
            May consult {member.consultants.length === 0 ? "nobody" : `${member.consultants.length} ${member.consultants.length === 1 ? "member" : "members"}`}
          </summary>
          <ul>
            {others.map((other) => (
              <li key={other.id}>
                <label className="room-check">
                  <input
                    type="checkbox"
                    checked={member.consultants.includes(other.id)}
                    disabled={busy || !other.consultable}
                    aria-label={`Let ${member.name} consult ${other.name}`}
                    onChange={(e) => {
                      const next = e.target.checked ? [...member.consultants, other.id] : member.consultants.filter((id) => id !== other.id);
                      onRun(() => patchMember(room.id, member.id, { consultants: next }));
                    }}
                  />
                  {other.name} <span className="muted">@{other.handle}</span>
                  {!other.consultable ? <span className="muted"> — may not be consulted</span> : null}
                </label>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </li>
  );
}

function AddMember({
  room,
  bots,
  onRoom,
  onNotice,
  onClose,
}: {
  room: RoomInfo;
  bots: BotProfile[] | null;
  onRoom: (room: RoomInfo) => void;
  onNotice: (text: string) => void;
  onClose: () => void;
}) {
  const [botId, setBotId] = useState(bots?.[0]?.id ?? "");
  const [handle, setHandle] = useState(bots?.[0] ? handleFrom(bots[0].name) : "");
  const [busy, setBusy] = useState(false);
  const bot = bots?.find((b) => b.id === botId) ?? null;
  const handleOk = BOARD_HANDLE_PATTERN.test(handle);
  const duplicate = room.members.some((m) => m.handle.toLowerCase() === handle.toLowerCase());
  const nextRank = room.members.reduce((n, m) => Math.max(n, m.rank + 1), 0);
  const submit = async () => {
    if (!bot || !handleOk || duplicate) return;
    setBusy(true);
    try {
      onRoom(await addMember(room.id, { botId: bot.id, handle, rank: nextRank, canLead: true, consultable: true, consultants: [] }));
      onClose();
    } catch (e) {
      onNotice(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="room-add" role="group" aria-label="Add a member">
      <label className="room-field">
        <span>Bot</span>
        <BoardSelect
          label="Bot to add"
          value={botId}
          onChange={(value) => {
            setBotId(value);
            const picked = bots?.find((b) => b.id === value);
            if (picked) setHandle(handleFrom(picked.name));
          }}
          options={(bots ?? []).map((b) => ({
            value: b.id,
            label: b.name,
            hint: b.harnessId + (b.role ? ` · ${b.role}` : ""),
            dot: `var(--harness-${b.harnessId}, var(--muted))`,
          }))}
        />
      </label>
      <label className="room-field">
        <span>Handle</span>
        <input
          type="text"
          value={handle}
          aria-label="Handle for the new member"
          aria-invalid={!handleOk || duplicate}
          onChange={(e) => setHandle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void submit();
          }}
        />
      </label>
      {!handleOk ? <p className="room-warning">A handle is 1–32 letters, digits, `_` or `-`, starting with a letter or digit.</p> : null}
      {duplicate ? <p className="room-warning">Another member already uses @{handle}.</p> : null}
      <div className="room-add-actions">
        <button type="button" className="btn btn-small" disabled={busy || !handleOk || duplicate} onClick={() => void submit()}>
          Add to room
        </button>
        <button type="button" className="btn btn-small btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
