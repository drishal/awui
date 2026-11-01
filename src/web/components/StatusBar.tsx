// Thin app-wide status bar (after Hermes Desktop): connection, harness and
// model, project, version. Desktop only; phones get a header banner instead.
// A shown Board room takes the place of the chat's three items (its own
// connection, its name and turn state, its workspace); the room is never
// faked into a ChatState.
import type { ChatState } from "../chat-state.js";
import type { ConnectionState } from "../stream.js";
import { dotted } from "./Dot.js";

const CONN_LABEL: Record<ConnectionState, string> = {
  connecting: "Connecting",
  connected: "Connected",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
};

/** What the bar needs about a shown room; App builds it from useRoomStream. */
export interface StatusBarRoom {
  conn: ConnectionState;
  name: string;
  workspace: string;
  /** The active turn's label, or Idle. */
  status: string;
}

export function StatusBar({
  conn,
  chat,
  room,
  harnessName,
  version,
}: {
  conn: ConnectionState;
  chat: ChatState | null;
  room: StatusBarRoom | null;
  harnessName: string | null;
  version: string;
}) {
  const model = chat?.config.models.find((m) => m.key === chat.config.model)?.name ?? chat?.config.model ?? null;
  return (
    <footer className="status-bar" aria-label="Status">
      {room ? (
        <span className={`sb-item conn conn-${room.conn}`} data-testid="connection" aria-live="polite">
          {CONN_LABEL[room.conn]}
        </span>
      ) : chat ? (
        <span className={`sb-item conn conn-${conn}`} data-testid="connection" aria-live="polite">
          {CONN_LABEL[conn]}
        </span>
      ) : (
        <span className="sb-item muted">No chat open</span>
      )}
      {room ? (
        <span className="sb-item">{dotted([room.name, room.status])}</span>
      ) : chat && harnessName ? (
        <span className="sb-item">{dotted([harnessName, model, chat.config.thinkingLevel])}</span>
      ) : null}
      {room ? <span className="sb-item sb-path" title={room.workspace}>{room.workspace}</span> : chat ? <span className="sb-item sb-path" title={chat.workspace.path}>{chat.workspace.path}</span> : null}
      <span className="sb-spacer" />
      <span className="sb-item">v{version}</span>
    </footer>
  );
}
