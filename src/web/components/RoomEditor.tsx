// Creating a room (name, topic, workspace, its first members, the lead) and
// editing one (name, topic, lead, archive, budgets). Membership policy —
// ranks, allowlists, enable/disable, resets — lives in RoomMembers, because it
// needs membership ids the server only assigns when the room exists. Drawn
// in FormRow cards like Settings: a new room is its name, its folder, and a
// ranked list of bots with one of them marked as the lead.
import { useEffect, useId, useState } from "react";
import type { BotProfile, RoomBudgets, RoomInfo, RoomSnapshot, WorkspaceInfo } from "../../shared/protocol.js";
import { BOARD_MAX_CONSULT_REQUESTS, BOARD_MAX_DIRECT_RESPONDERS, BOARD_MAX_INVOCATIONS, BOARD_MAX_INVOCATIONS_PER_MEMBER, BOARD_MAX_MEMBERS, BOARD_QUEUE_MAX, BOARD_TURN_WALL_CLOCK_MS } from "../../shared/protocol.js";
import { errorText } from "../api.js";
import { createRoom, patchRoom, type RoomPatch } from "../rooms.js";
import { handleFrom } from "../room-mentions.js";
import { budgetsOf, DEFAULT_BUDGETS } from "../room-state.js";
import { harnessColor } from "../harness-colors.js";
import { IconChevronDown, IconChevronUp, IconFolder, IconPlus, IconX } from "../icons.js";
import { Collapse } from "./Collapse.js";
import { Dialog } from "./Dialog.js";
import { FormRow } from "./FormRow.js";
import { Select } from "./Select.js";
import { Switch } from "./Switch.js";

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
  const [budgetsOpen, setBudgetsOpen] = useState(false);
  const budgetsId = useId();
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
  // The lead is the one marked, else the first bot added: a new room always has one.
  const lead = (leadBotId !== null && drafts.some((d) => d.botId === leadBotId) ? leadBotId : null) ?? drafts[0]?.botId ?? null;
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

  const available = bots?.filter((b) => !drafts.some((d) => d.botId === b.id)) ?? [];
  const budgetSummary = `${caps.maxDirectResponders} direct · ${caps.maxConsultRequests} consults · ${caps.maxInvocations} runs · ${Math.round(caps.turnWallClockMs / 1000)}s a turn`;

  return (
    <Dialog title={room ? `Edit ${room.name}` : "New room"} onClose={onClose} className="room-editor-dialog">
      <div className="board-form">
        <div className="form-card">
          <FormRow label="Name" stack>
            <input className="input" type="text" value={name} maxLength={100} aria-label="Room name" placeholder="e.g. webui review" onChange={(e) => setName(e.target.value)} />
          </FormRow>
          <FormRow label="Topic" desc="Optional: what this room is for. Every bot sees it." stack>
            <input className="input" type="text" value={topic} maxLength={500} aria-label="Room topic" placeholder="What this room is for" onChange={(e) => setTopic(e.target.value)} />
          </FormRow>
          {room === null ? (
            <FormRow label="Project" desc={workspaces.length === 0 ? "Open a project first: a room runs its bots in one." : "The folder its bots work in."}>
              {workspaces.length > 0 ? <Select label="Room workspace" value={workspaceId} onChange={setWorkspaceId} options={workspaces.map((w) => ({ value: w.id, label: w.name, hint: w.path }))} /> : null}
              {onPickFolder ? (
                <button type="button" className="btn btn-small btn-ghost" aria-label="Open another project" onClick={onPickFolder}>
                  <IconFolder size={13} /> Open…
                </button>
              ) : null}
            </FormRow>
          ) : (
            <FormRow label="Project" desc="Fixed once the room exists.">
              <span className="board-static">
                <IconFolder size={13} /> {room.workspaceName}
              </span>
            </FormRow>
          )}
        </div>

        {room === null ? (
          <section className="form-section board-members-section" aria-labelledby="room-members-head">
            <h3 id="room-members-head">Members</h3>
            <p className="form-note">In rank order. A message with no @mention goes to the lead; consultations are set in Members once the room exists.</p>
            {bots === null ? (
              <p className="form-empty">Loading bots…</p>
            ) : bots.length === 0 ? (
              <div className="board-empty">
                <p>A room runs bots, and there are none yet. A bot is a harness, a model, and its instructions.</p>
                <button type="button" className="btn btn-small btn-primary" onClick={onNewBot}>
                  <IconPlus size={13} /> Create a bot
                </button>
              </div>
            ) : (
              <>
                <ol className="form-card room-draft-members" aria-label="Room members">
                  {drafts.length === 0 ? <li className="form-empty room-draft-empty">No members yet: add a bot below. The first one leads until you pick another.</li> : null}
                  {drafts.map((d, i) => {
                    const bot = bots.find((b) => b.id === d.botId);
                    const isLead = d.botId === lead;
                    const name = bot?.name ?? "this bot";
                    return (
                      <li key={d.botId} className={`room-draft-member${isLead ? " is-lead" : ""}`}>
                        <span className="room-draft-rank" aria-hidden="true">
                          {i + 1}
                        </span>
                        <span className="bot-dot" style={{ "--bot-accent": bot?.accent ? `var(--${bot.accent}, var(--accent))` : `var(--harness-${bot?.harnessId ?? "none"}, var(--muted))` } as React.CSSProperties} aria-hidden="true" />
                        <span className="room-draft-who">
                          <span className="room-draft-name">{bot?.name ?? d.botId}</span>
                          <span className="room-draft-meta">
                            <span className="badge badge-harness" style={harnessColor(bot?.harnessId)}>
                              {bot?.harnessId ?? "?"}
                            </span>
                            {bot?.role ? <span>{bot.role}</span> : null}
                          </span>
                        </span>
                        <label className="room-handle">
                          <span aria-hidden="true">@</span>
                          <input type="text" value={d.handle} aria-label={`Handle for ${name}`} aria-invalid={!/^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(d.handle)} onChange={(e) => setHandle(d.botId, e.target.value)} />
                        </label>
                        <button type="button" className="board-lead-chip" aria-pressed={isLead} aria-label={`Make ${name} the lead`} title={isLead ? "Answers messages with no @mention" : "Make this bot the lead"} onClick={() => setLeadBotId(d.botId)}>
                          Lead
                        </button>
                        <span className="room-draft-actions">
                          <button type="button" className="ghost-icon" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
                            <IconChevronUp size={13} />
                          </button>
                          <button type="button" className="ghost-icon" aria-label={`Move ${name} down`} disabled={i === drafts.length - 1} onClick={() => move(i, 1)}>
                            <IconChevronDown size={13} />
                          </button>
                          <button type="button" className="ghost-icon" aria-label={`Remove ${name} from the room`} onClick={() => drop(d.botId)}>
                            <IconX size={13} />
                          </button>
                        </span>
                      </li>
                    );
                  })}
                </ol>
                {duplicateHandle ? <p className="room-warning">Two members cannot share the handle @{duplicateHandle}.</p> : null}
                {badHandle ? <p className="room-warning">@{badHandle} is not a handle: 1–32 letters, digits, `_` or `-`.</p> : null}
                <div className="room-pick-bots" role="group" aria-label="Bots to add">
                  {available.map((bot) => (
                    <button key={bot.id} type="button" className="pill-btn room-pick-bot" aria-label={`Add ${bot.name}`} disabled={drafts.length >= BOARD_MAX_MEMBERS} onClick={() => add(bot)}>
                      <IconPlus size={12} />
                      <span className="harness-dot" style={{ ["--harness" as string]: `var(--harness-${bot.harnessId}, var(--muted))` }} aria-hidden="true" />
                      {bot.name}
                      <span className="room-pick-harness">{bot.harnessId}</span>
                    </button>
                  ))}
                  <button type="button" className="pill-btn room-pick-bot is-new" onClick={onNewBot}>
                    <IconPlus size={12} /> New bot
                  </button>
                </div>
              </>
            )}
          </section>
        ) : (
          <>
            <div className="form-card">
              <FormRow label="Lead" desc="Answers every message with no @mention.">
                <Select
                  label="Room lead"
                  value={leadId}
                  onChange={setLeadId}
                  options={[{ value: "", label: "No lead" }, ...room.members.filter((m) => m.canLead && m.enabled).map((m) => ({ value: m.id, label: m.name, hint: `@${m.handle}` }))]}
                />
              </FormRow>
              <FormRow label="Archived" desc="Its bots do not run; the transcript stays readable." toggle>
                <Switch label="Archive this room" checked={archived} onChange={setArchived} />
              </FormRow>
            </div>
            <div className="form-card room-budgets">
              <button type="button" className="room-budgets-head" aria-expanded={budgetsOpen} aria-controls={budgetsId} onClick={() => setBudgetsOpen((v) => !v)}>
                <span className="form-row-text">
                  <span className="form-label">Budgets</span>
                  <span className="form-desc">{budgetSummary}</span>
                </span>
                <IconChevronDown size={14} className="room-budgets-chevron" />
              </button>
              <Collapse open={budgetsOpen}>
                <div className="room-budgets-body" id={budgetsId}>
                  <p className="form-note">Per message, enforced by the server. A change applies from the next message, not the one running.</p>
                  <div className="room-budget-grid">
                    <BudgetField label="Direct responders" value={budgets.maxDirectResponders} limits={BUDGET_LIMITS.maxDirectResponders} onChange={(v) => setBudgets({ ...budgets, maxDirectResponders: v })} />
                    <BudgetField label="Consultation requests" value={budgets.maxConsultRequests} limits={BUDGET_LIMITS.maxConsultRequests} onChange={(v) => setBudgets({ ...budgets, maxConsultRequests: v })} />
                    <BudgetField label="Total invocations" value={budgets.maxInvocations} limits={BUDGET_LIMITS.maxInvocations} onChange={(v) => setBudgets({ ...budgets, maxInvocations: v })} />
                    <BudgetField label="Invocations per bot" value={budgets.maxInvocationsPerMember} limits={BUDGET_LIMITS.maxInvocationsPerMember} onChange={(v) => setBudgets({ ...budgets, maxInvocationsPerMember: v })} />
                    <BudgetField label="Wall clock (ms)" value={budgets.turnWallClockMs} limits={BUDGET_LIMITS.turnWallClockMs} onChange={(v) => setBudgets({ ...budgets, turnWallClockMs: v })} />
                    <BudgetField label="Queued messages" value={budgets.queueMax} limits={BUDGET_LIMITS.queueMax} onChange={(v) => setBudgets({ ...budgets, queueMax: v })} />
                  </div>
                </div>
              </Collapse>
            </div>
          </>
        )}
      </div>
      {notice ? (
        <p className="room-warning" role="alert">
          {notice}
        </p>
      ) : null}
      <div className="board-actions">
        {room === null && drafts.length === 0 && bots !== null && bots.length > 0 ? <span className="board-actions-hint">Add at least one bot</span> : null}
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={!valid || saving || !budgetsValid || (room === null && !memberOk)} onClick={() => void save()}>
          {room ? "Save room" : "Create room"}
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
  const n = Number((value ?? "").trim());
  const ok = Number.isInteger(n) && n >= limits.min && n <= limits.max;
  return (
    <label className="room-budget-field">
      <span className="room-budget-label">{label}</span>
      <input className="input" type="number" min={limits.min} max={limits.max} value={value ?? ""} aria-label={label} aria-invalid={!ok} onChange={(e) => onChange(e.target.value)} />
      <span className="room-budget-range">
        {limits.min.toLocaleString()}–{limits.max.toLocaleString()}
      </span>
    </label>
  );
}
