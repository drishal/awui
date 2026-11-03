// The .envrc notice: when a chat's project has a direnv file that has never been
// allowed, harnesses spawn without it. A banner above the composer says so, names
// the file, and offers to allow it (direnv allow) so the next spawn picks it up.
// Allowing writes the user's own direnv consent state — the same file `direnv allow`
// writes — so no awui-specific trust store exists.
import { useState } from "react";
import { api } from "../api.js";
import type { ChatState } from "../chat-state.js";
import { IconTerminal, IconX } from "../icons.js";

/** The banner behind the composer's card while the project's .envrc is blocked. */
export function DirenvNote({ chat }: { chat: ChatState }) {
  const state = chat.workspace.direnv;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null); // the rcPath dismissed this chat's view
  const [allowed, setAllowed] = useState(false);
  if (!state?.blocked || !state.rcPath || allowed || dismissed === state.rcPath) return null;
  const allow = async () => {
    setBusy(true);
    setError(null);
    try {
      await api(`/api/workspaces/${chat.workspace.id}/direnv-allow`, { method: "POST" });
      setAllowed(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "direnv allow failed");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="direnv-note" role="status" data-testid="direnv-note">
      <IconTerminal size={13} />
      <span className="direnv-note-text">
        This project has a <strong>.envrc</strong> that direnv won't run yet; the agent starts without it.
      </span>
      <button type="button" className="btn btn-small" disabled={busy} onClick={() => void allow()} data-testid="direnv-allow">
        {busy ? "Allowing…" : "Allow .envrc"}
      </button>
      <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setDismissed(state.rcPath)}>
        <IconX size={11} />
      </button>
      {error ? <span className="direnv-note-error">{error}</span> : null}
    </div>
  );
}
