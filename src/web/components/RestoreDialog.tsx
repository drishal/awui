// Restore a turn's checkpoint: the files as they were before its prompt. The
// preview lists every file that would change (by the agent's edits, its
// commands, or anyone else since), each one ticked; the conversation itself
// is not changed, unless the fork is ticked too.
import { useEffect, useState } from "react";
import type { CheckpointChange, CheckpointPreview } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { Dialog } from "./Dialog.js";
import { HoldButton } from "./HoldButton.js";

const CHANGE: Record<CheckpointChange, string> = {
  restore: "put back",
  delete: "deleted (new since)",
  recreate: "brought back (deleted since)",
};

export function RestoreDialog({
  chatId,
  through,
  canFork,
  onRestore,
  onClose,
}: {
  chatId: string;
  /** The turn whose checkpoint this is (1-based, as fork counts). */
  through: number;
  /** The chat can also be forked from before the turn. */
  canFork: boolean;
  onRestore: (paths: string[], fork: boolean) => Promise<void>;
  onClose: () => void;
}) {
  const [preview, setPreview] = useState<CheckpointPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<ReadonlySet<string>>(() => new Set());
  const [fork, setFork] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<CheckpointPreview>(`/api/chats/${chatId}/checkpoints/${through}`)
      .then(setPreview)
      .catch((e: unknown) => setError(errorText(e)));
  }, [chatId, through]);

  const chosen = preview?.files.filter((f) => !skipped.has(f.path)) ?? [];
  const toggle = (path: string) =>
    setSkipped((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <Dialog title="Undo file changes" onClose={onClose} className="dialog-wide restore-dialog">
      <p className="settings-note">
        Puts files back as they were before turn {through}'s prompt: what the agent edited or its commands changed in this turn and every later one, and
        anything else changed since. The conversation stays as it is.
      </p>
      {error ? <p className="banner banner-error">{error}</p> : null}
      {!preview && !error ? <p className="settings-note">Comparing…</p> : null}
      {preview && preview.files.length === 0 ? <p className="settings-note">Nothing has changed since then.</p> : null}
      {preview && preview.files.length > 0 ? (
        <ul className="restore-list" aria-label="Files">
          {preview.files.map((f) => (
            <li key={f.path}>
              <label>
                <input type="checkbox" checked={!skipped.has(f.path)} onChange={() => toggle(f.path)} />
                <code>{f.path}</code>
                <span className={`restore-change is-${f.change}`}>{CHANGE[f.change]}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : null}
      {canFork && through > 1 ? (
        <label className="checkbox">
          <input type="checkbox" checked={fork} onChange={(e) => setFork(e.target.checked)} />
          Also fork the conversation from before turn {through}
        </label>
      ) : null}
      <div className="dialog-actions">
        <button type="button" className="btn" onClick={onClose}>
          Cancel
        </button>
        {/* The files come back with real pressure: hold ~600ms so a stray click can't. */}
        <HoldButton
          label={chosen.length === 0 ? "Undo" : `Undo ${chosen.length} ${chosen.length === 1 ? "file" : "files"}`}
          holdLabel="Hold to undo"
          doneLabel="File changes undone"
          disabled={busy || chosen.length === 0}
          onFire={() => {
            setBusy(true);
            void onRestore(
              chosen.map((f) => f.path),
              fork,
            ).finally(() => setBusy(false));
          }}
        />
      </div>
    </Dialog>
  );
}
