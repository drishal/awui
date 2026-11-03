// Creating a room (name, topic, workspace, its first members, the lead) and
// editing one (name, topic, lead, archive, budgets). Membership policy —
// ranks, allowlists, enable/disable, resets — lives in RoomMembers, because it
// needs membership ids the server only assigns when the room exists.
import { useEffect, useState } from "react";
import type { BotProfile, RoomBudgets, RoomInfo, RoomSnapshot, WorkspaceInfo } from "../../shared/protocol.js";
import { BOARD_MAX_CONSULT_REQUESTS, BOARD_MAX_DIRECT_RESPONDERS, BOARD_MAX_INVOCATIONS, BOARD_MAX_INVOCATIONS_PER_MEMBER, BOARD_MAX_MEMBERS, BOARD_QUEUE_MAX, BOARD_TURN_WALL_CLOCK_MS } from "../../shared/protocol.js";
import { errorText } from "../api.js";
import { createRoom, patchRoom, type RoomPatch } from "../rooms.js";
import { handleFrom } from "../room-mentions.js";
import { budgetsOf, DEFAULT_BUDGETS } from "../room-state.js";
import { harnessColor } from "../harness-colors.js";
import { IconChevronDown, IconChevronUp, IconPlus, IconX } from "../icons.js";
import { Dialog } from "./Dialog.js";
import { Select } from "./Select.js";

interface DraftMember {
  botId: string;
  handle: string;
  canLead: boolean;
}

export function RoomEditor({
  room,
  bots,
  workspaces,
  onCreated,
  onSaved,
  onNewBot,
  onPickFolder,
  onNotice,
  onClose,
}: {
  /** null creates a room; an existing one is edited. */
  room: RoomInfo | null;
  bots: BotProfile[] | null;
  workspaces: WorkspaceInfo[];
  onCreated: (snapshot: RoomSnapshot) => void;
  onSaved: (room: RoomInfo) => void;
  onNewBot: () => void;
  /** The app's folder picker: opening a project registers it, and it can then be this room's workspace. */
  onPickFolder?: () => void;
  onNotice: (text: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(room?.name ?? "");
  const [topic, setTopic] = useState(room?.topic ?? "");
  const [workspaceId, setWorkspaceId] = useState(room?.workspaceId ?? workspaces[0]?.id ?? "");
  const [drafts, setDrafts] = useState<DraftMember[]>([]);
  const [leadBotId, setLeadBotId] = useState<string | null>(null);
  const [archived, setArchived] = useState(room?.archived ?? false);
  const [leadId, setLeadId] = useState(room?.leadMemberId ?? "");
  const [saving, setSaving] = useState(false);
  // The server's refusal is said in the dialog, not behind it in the page banner.
  const [notice, setNotice] = useState<string | null>(null);
  // A project opened while this dialog was up becomes the default (the list it was built from grew).
  useEffect(() => {
    if (room === null && workspaceId === "" && workspaces[0]) setWorkspaceId(workspaces[0].id);
  }, [room, workspaceId, workspaces]);
  // The room's caps as it reports them; an older server's missing object falls back to the plan defaults.
  const caps = room ? budgetsOf(room) : DEFAULT_BUDGETS;
  const [budgets, setBudgets] = useState<Record<BudgetKey, string>>(() => budgetText(caps));

  const trimmed = name.trim();
  const lead = leadBotId ?? drafts.find((d) => d.canLead)?.botId ?? null;
  const valid = trimmed.length > 0 && trimmed.length <= 100 && (room !== null || (workspaceId !== "" && drafts.length > 0 && lead !== null));

  const add = (bot: BotProfile) => {
    if (drafts.some((d) => d.botId === bot.id) || drafts.length >= BOARD_MAX_MEMBERS) return;
    setDrafts([...drafts, { botId: bot.id, handle: handleFrom(bot.name), canLead: true }]);
  };
  const move = (index: number, dir: -1 | 1) => {
    const to = index + dir;
    if (to < 0 || to >= drafts.length) return;
    const next = [...drafts];
    const a = next[index] as DraftMember;
    const b = next[to] as DraftMember;
    next[index] = b;
    next[to] = a;
    setDrafts(next);
  };
  const drop = (botId: string) => {
    setDrafts(drafts.filter((d) => d.botId !== botId));
    if (leadBotId === botId) setLeadBotId(null);
  };
  const setHandle = (botId: string, handle: string) => setDrafts(drafts.map((d) => (d.botId === botId ? { ...d, handle } : d)));
  const duplicateHandle = (() => {
    const seen = new Set<string>();
    for (const d of drafts) {
      const key = d.handle.toLowerCase();
      if (seen.has(key)) return d.handle;
      seen.add(key);
    }
    return null;
  })();
  const badHandle = drafts.find((d) => !/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(d.handle))?.handle ?? null;
  const memberOk = duplicateHandle === null && badHandle === null;

  /** Only the caps that changed: a room's untouched budgets are not re-sent. */
  const budgetPatch = () => {
    const patch: Record<string, number> = {};
    for (const key of BUDGET_KEYS) {
      const n = Number(budgets[key].trim());
      if (Number.isInteger(n) && n !== caps[key]) patch[key] = n;
    }
    return patch;
  };
  const budgetsValid = BUDGET_KEYS.every((key) => {
    const n = Number(budgets[key].trim());
    return Number.isInteger(n) && n >= BUDGET_LIMITS[key].min && n <= BUDGET_LIMITS[key].max;
  });

  const save = async () => {
    if (!valid || saving || (room === null && !memberOk)) return;
    setSaving(true);
    try {
      if (room) {
        const patch: RoomPatch = { name: trimmed, topic: topic.trim() === "" ? null : topic };
        if (archived !== room.archived) patch.archived = archived;
        if (leadId !== "" && leadId !== room.leadMemberId) patch.leadMemberId = leadId;
        const typed = budgetPatch();
        if (Object.keys(typed).length > 0) patch.budgets = typed;
        onSaved(await patchRoom(room.id, patch));
      } else {
        onCreated(
          await createRoom({
            name: trimmed,
            topic: topic.trim() === "" ? null : topic,
            workspaceId,
            // Draft order is rank order; the lead is chosen separately and need not be rank 0.
            members: drafts.map((d, rank) => ({ botId: d.botId, handle: d.handle, rank, canLead: d.canLead, consultable: true, consultants: [] })),
            ...(lead ? { leadBotId: lead } : {}),
          }),
        );
      }
      onClose();
    } catch (e) {
      setNotice(errorText(e));
      onNotice(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog title={room ? `Edit ${room.name}` : "New room"} onClose={onClose} className="room-editor-dialog">
      <div className="board-form">
        <label className="room-field">
          <span>Name</span>
          <input type="text" value={name} maxLength={100} aria-label="Room name" onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="room-field">
          <span>Topic</span>
          <input type="text" value={topic} maxLength={500} aria-label="Room topic" placeholder="What this room is for" onChange={(e) => setTopic(e.target.value)} />
        </label>
        {room === null ? (
          <div className="room-field">
            <span>Workspace</span>
            <div className="board-model-row">
              {workspaces.length === 0 ? (
                <span className="room-warning">Open a project first: a room runs its bots in one.</span>
              ) : (
                <Select label="Room workspace" value={workspaceId} onChange={setWorkspaceId} options={workspaces.map((w) => ({ value: w.id, label: w.name }))} />
              )}
              {onPickFolder ? (
                <button type="button" className="btn btn-small" aria-label="Open another project" onClick={onPickFolder}>
                  Open project…
                </button>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="room-field">
            <span>Workspace</span>
            <span className="board-static">{room.workspaceName}</span>
          </div>
        )}
        {room === null ? (
          <div className="board-field">
            <span className="board-field-label">Members (the first added is ranked first)</span>
            {bots === null ? <p className="muted">Loading bots…</p> : bots.length === 0 ? (
              <div className="room-no-bots">
                <p>A room runs bots, and there are none yet. Create one first.</p>
                <button type="button" className="btn btn-small" onClick={onNewBot}>
                  <IconPlus size={13} /> Create a bot
                </button>
              </div>
            ) : (
              <>
                <ul className="room-draft-members">
                  {drafts.map((d, i) => {
                    const bot = bots.find((b) => b.id === d.botId);
                    return (
                      <li key={d.botId} className="room-draft-member">
                        <span className="room-draft-rank">{i + 1}</span>
                        <button type="button" className="icon-btn" aria-label={`Move ${bot?.name ?? "this bot"} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                          <IconChevronUp size={12} />
                        </button>
                        <button type="button" className="icon-btn" aria-label={`Move ${bot?.name ?? "this bot"} down`} disabled={i === drafts.length - 1} onClick={() => move(i, 1)}>
                          <IconChevronDown size={12} />
                        </button>
                        <span className="badge badge-harness" style={harnessColor(bot?.harnessId)}>
                          {bot?.harnessId ?? "?"}
                        </span>
                        <span className="room-draft-name">{bot?.name ?? d.botId}</span>
                        <label className="room-check">
                          <input
                            type="checkbox"
                            checked={d.canLead}
                            aria-label={`Let ${bot?.name ?? "this bot"} lead`}
                            onChange={(e) => setDrafts(drafts.map((x) => (x.botId === d.botId ? { ...x, canLead: e.target.checked } : x)))}
                          />
                          can lead
                        </label>
                        <label className="room-field room-handle">
                          <span>@</span>
                          <input type="text" value={d.handle} aria-label={`Handle for ${bot?.name ?? "this bot"}`} onChange={(e) => setHandle(d.botId, e.target.value)} />
                        </label>
                        <button type="button" className="icon-btn" aria-label={`Remove ${bot?.name ?? "this bot"} from the room`} onClick={() => drop(d.botId)}>
                          <IconX size={13} />
                        </button>
                      </li>
                    );
                  })}
                </ul>
                {duplicateHandle ? <p className="room-warning">Two members cannot share the handle @{duplicateHandle}.</p> : null}
                {badHandle ? <p className="room-warning">@{badHandle} is not a handle: 1–32 letters, digits, `_` or `-`.</p> : null}
                <div className="room-pick-bots" role="group" aria-label="Bots to add">
                  {bots
                    .filter((b) => !drafts.some((d) => d.botId === b.id))
                    .map((bot) => (
                      <button key={bot.id} type="button" className="btn btn-small room-pick-bot" aria-label={`Add ${bot.name}`} onClick={() => add(bot)}>
                        <IconPlus size={12} />
                        Add {bot.name}
                        <span className="muted">{bot.harnessId}</span>
                      </button>
                    ))}
                </div>
                {drafts.length === 0 ? <p className="room-warning">No members yet: click a bot above to add it. A room needs at least one, and the first added is ranked first.</p> : null}
                <button type="button" className="btn btn-small" onClick={onNewBot}>
                  <IconPlus size={13} /> New bot
                </button>
                {drafts.length > 0 && lead === null ? <p className="room-warning">Pick at least one bot that can lead; a room runs its lead for bare messages.</p> : null}
                {drafts.length > 0 ? (
                  <label className="room-field">
                    <span>Lead</span>
                    <Select
                      label="Room lead"
                      value={lead ?? ""}
                      onChange={(value) => setLeadBotId(value || null)}
                      options={drafts.filter((d) => d.canLead).map((d) => ({ value: d.botId, label: bots.find((b) => b.id === d.botId)?.name ?? d.botId }))}
                    />
                  </label>
                ) : null}
                <p className="board-hint">A bare message goes only to the lead. Consultation allowlists are set once the room exists, in Members.</p>
              </>
            )}
          </div>
        ) : (
          <>
            <label className="room-field">
              <span>Lead</span>
              <Select
                label="Room lead"
                value={leadId}
                onChange={setLeadId}
                options={[{ value: "", label: "No lead" }, ...room.members.filter((m) => m.canLead && m.enabled).map((m) => ({ value: m.id, label: `${m.name} (@${m.handle})` }))]}
              />
              <span className="board-hint">A message with no @mention goes only to the lead.</span>
            </label>
            <label className="room-check room-archive-check">
              <input type="checkbox" checked={archived} aria-label="Archive this room" onChange={(e) => setArchived(e.target.checked)} />
              Archived (bots do not run; the transcript stays)
            </label>
            <details className="room-budgets">
              <summary>Budgets</summary>
              <p className="board-hint">Per top-level turn, enforced by the server. Changing them affects the next turn, not the one running.</p>
              <div className="room-budget-grid">
                <BudgetField label="Direct responders" value={budgets.maxDirectResponders} limits={BUDGET_LIMITS.maxDirectResponders} onChange={(v) => setBudgets({ ...budgets, maxDirectResponders: v })} />
                <BudgetField label="Consultation requests" value={budgets.maxConsultRequests} limits={BUDGET_LIMITS.maxConsultRequests} onChange={(v) => setBudgets({ ...budgets, maxConsultRequests: v })} />
                <BudgetField label="Total invocations" value={budgets.maxInvocations} limits={BUDGET_LIMITS.maxInvocations} onChange={(v) => setBudgets({ ...budgets, maxInvocations: v })} />
                <BudgetField label="Invocations per bot" value={budgets.maxInvocationsPerMember} limits={BUDGET_LIMITS.maxInvocationsPerMember} onChange={(v) => setBudgets({ ...budgets, maxInvocationsPerMember: v })} />
                <BudgetField label="Wall clock (ms)" value={budgets.turnWallClockMs} limits={BUDGET_LIMITS.turnWallClockMs} onChange={(v) => setBudgets({ ...budgets, turnWallClockMs: v })} />
                <BudgetField label="Queued turns" value={budgets.queueMax} limits={BUDGET_LIMITS.queueMax} onChange={(v) => setBudgets({ ...budgets, queueMax: v })} />
              </div>
            </details>
          </>
        )}
      </div>
      {notice ? (
        <p className="room-warning" role="alert">
          {notice}
        </p>
      ) : null}
      <div className="board-actions">
        <button type="button" className="btn btn-primary" disabled={!valid || saving || !budgetsValid || (room === null && !memberOk)} onClick={() => void save()}>
          {room ? "Save room" : "Create room"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Dialog>
  );
}

const BUDGET_KEYS = ["maxDirectResponders", "maxConsultRequests", "maxInvocations", "maxInvocationsPerMember", "turnWallClockMs", "queueMax"] as const;
type BudgetKey = (typeof BUDGET_KEYS)[number];

/** The wire's own bounds for each cap (protocol.ts), so an out-of-range field disables Save. */
const BUDGET_LIMITS: Record<BudgetKey, { min: number; max: number }> = {
  maxDirectResponders: { min: 1, max: BOARD_MAX_DIRECT_RESPONDERS },
  maxConsultRequests: { min: 0, max: BOARD_MAX_CONSULT_REQUESTS },
  maxInvocations: { min: 1, max: BOARD_MAX_INVOCATIONS },
  maxInvocationsPerMember: { min: 1, max: BOARD_MAX_INVOCATIONS_PER_MEMBER },
  // roomPatchSchema's own bounds, not this room's default.
  turnWallClockMs: { min: 10_000, max: 600_000 },
  queueMax: { min: 0, max: BOARD_QUEUE_MAX },
};

function budgetText(caps: RoomBudgets): Record<BudgetKey, string> {
  return {
    maxDirectResponders: String(caps.maxDirectResponders),
    maxConsultRequests: String(caps.maxConsultRequests),
    maxInvocations: String(caps.maxInvocations),
    maxInvocationsPerMember: String(caps.maxInvocationsPerMember),
    turnWallClockMs: String(caps.turnWallClockMs),
    queueMax: String(caps.queueMax),
  };
}

function BudgetField({ label, value, limits, onChange }: { label: string; value: string | undefined; limits: { min: number; max: number }; onChange: (value: string) => void }) {
  return (
    <label className="room-field room-budget-field">
      <span>{label}</span>
      <input type="number" min={limits.min} max={limits.max} value={value ?? ""} aria-label={label} onChange={(e) => onChange(e.target.value)} title={`${limits.min}–${limits.max}`} />
    </label>
  );
}
