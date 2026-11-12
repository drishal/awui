// A session that a handover locked, opened here: its exact resume line was copied
// for a terminal, so resuming it here during the handover would be a second writer
// on the same session. Reclaim it (the lock goes, and the session is opened here
// through the ordinary resume, which now works), or leave it to the terminal.
import { useState } from "react";
import type { ProjectSession } from "../../shared/protocol.js";
import { errorText } from "../api.js";
import { Dialog } from "./Dialog.js";

export function HandoverDialog({
  session,
  harnessName,
  command,
  onReclaim,
  onClose,
}: {
  session: ProjectSession & { handover: true };
  harnessName: string;
  /** The line the handover held (shown, so the user can paste it again if the terminal is gone); null when it cannot be read. */
  command: string | null;
  onReclaim: () => void;
  onClose: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog title="Session handed to a terminal" onClose={onClose} className="herdr-dialog">
      <p className="herdr-dialog-text">
        <strong>{session.title || "This session"}</strong> was handed to a terminal: its resume line{command ? <code> {command}</code> : null} was copied to run it in {harnessName} outside awui.
        Opening it here as well starts a second {harnessName} on the same session, and both would write to it. Reclaim it here to bring it back (the terminal's copy keeps working: it is the same native session).
      </p>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            onClose();
            onReclaim();
          }}
        >
          Reclaim here
        </button>
      </div>
    </Dialog>
  );
}
