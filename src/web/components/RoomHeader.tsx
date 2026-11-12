// A room's share of the pane header, in the places a chat uses: its status, bots
// and spend on the subtitle line (where a chat names its harness, status and
// project), and Members, Edit and Export beside the title (where a chat keeps
// Review and its tools). The room view under the header is then the transcript
// alone, as a chat's is, with no band of its own between the two.
import type { RoomState } from "../room-state.js";
import { isLiveTurn } from "../room-state.js";
import { TURN_STATUS_LABEL } from "../use-room-stream.js";
import { dollars, shortTokens, tokensOf } from "../usage.js";
import { IconAgents, IconDownload, IconEdit, IconLink } from "../icons.js";

/** The subtitle's room facts: "● Idle · 2 bots · 30k tokens". The project and the Room tag are the header's own. */
export function RoomHeadSub({ state }: { state: RoomState }) {
  const active = isLiveTurn(state.activeTurn) ? state.activeTurn : null;
  const queued = state.queued.length;
  const status = active ? (TURN_STATUS_LABEL[active.state] ?? active.state) : queued > 0 ? `${queued} queued` : "Idle";
  const bots = state.room.members.length;
  const cost = state.usage.cost !== null ? ` · ${dollars(state.usage.cost, true)}` : state.usage.unpriced > 0 ? " · cost unavailable" : "";
  return (
    <>
      <span className={`room-status is-${active ? active.state : queued > 0 ? "queued" : "idle"}`} data-testid="room-status">
        {status}
      </span>
      <span className="room-member-count">
        {bots} {bots === 1 ? "bot" : "bots"}
      </span>
      <span className="room-spend-head" title="Usage over this room's invocations">
        {shortTokens(tokensOf(state.usage))} tokens{cost}
      </span>
    </>
  );
}

/** Members (the room's main control, worded like the chat's Review), then Edit and Export as the header's icon tools. */
export function RoomHeadActions({ membersOpen, onMembers, onEdit, onExport, onCopyLink }: { membersOpen: boolean; onMembers: () => void; onEdit: () => void; onExport: () => void; onCopyLink: () => void }) {
  return (
    <>
      <button type="button" className="btn btn-small room-members-open" aria-label="Room members" aria-expanded={membersOpen} title="Who is in the room, the lead, and who may consult whom" onClick={onMembers}>
        <IconAgents size={14} /> <span className="room-members-label">Members</span>
      </button>
      <button type="button" className="icon-btn" aria-label="Edit room" title="Edit the room: name, topic, project, members, and budgets" onClick={onEdit}>
        <IconEdit size={16} />
      </button>
      <button type="button" className="icon-btn" aria-label="Copy room link" title="Copy a link that opens this room again" onClick={onCopyLink}>
        <IconLink size={16} />
      </button>
      <button type="button" className="icon-btn" aria-label="Export room as Markdown" title="Download the room as Markdown" onClick={onExport}>
        <IconDownload size={16} />
      </button>
    </>
  );
}
