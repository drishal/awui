// Open a project: browse folders under the server's workspace roots (the
// server confines every listing), type a path, or pick a recent one.
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowseResult } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { IconFolder } from "../icons.js";
import { Dialog } from "./Dialog.js";

export function WorkspacePicker({
  recent,
  worktrees,
  onOpen,
  onClose,
  error,
}: {
  recent: string[];
  worktrees?: () => void;
  onOpen: (path: string) => void | Promise<void>;
  onClose: () => void;
  error: string | null;
}) {
  const [listing, setListing] = useState<BrowseResult | null>(null);
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [typed, setTyped] = useState("");

  // Only the latest browse wins: rapid requests may resolve out of order.
  const seq = useRef(0);
  const browse = useCallback(async (path?: string) => {
    const mine = ++seq.current;
    setBrowseError(null);
    try {
      const result = await api<BrowseResult>(`/api/workspaces/browse${path ? `?path=${encodeURIComponent(path)}` : ""}`);
      if (mine !== seq.current) return;
      setListing(result);
    } catch (e) {
      if (mine === seq.current) setBrowseError(errorText(e));
    }
  }, []);

  useEffect(() => {
    void browse();
  }, [browse]);

  const entries = (listing?.entries ?? []).filter((e) => showHidden || !e.hidden);

  return (
    <Dialog title="Choose a project folder" onClose={onClose} className="dialog-wide">
      {error ? <p className="notice notice-error">{error}</p> : null}
      {worktrees ? <div className="picker-work-tools"><button type="button" className="btn btn-small" onClick={worktrees}>Worktrees</button><span className="muted">Create or reopen an isolated checkout.</span></div> : null}
      {recent.length > 0 ? (
        <section className="picker-section">
          <h3>Recent</h3>
          <ul className="picker-list picker-box">
            {recent.map((p) => (
              <li key={p}>
                <button type="button" className="picker-item" onClick={() => onOpen(p)} title={p}>
                  <span className="picker-name">{p.split("/").filter(Boolean).pop() ?? p}</span>
                  <span className="picker-path">{p}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section className="picker-section">
        <div className="picker-bar">
          <h3>Browse</h3>
          <label className="checkbox">
            <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> Show hidden
          </label>
        </div>
        <div className="picker-location">
          {listing?.path ? (
            <>
              <button type="button" className="btn btn-small" onClick={() => void browse(listing.parent ?? undefined)}>
                ↑ Up
              </button>
              <code className="picker-current">{listing.path}</code>
              <button type="button" className="btn btn-small btn-primary" onClick={() => onOpen(listing.path as string)}>
                Open this folder
              </button>
            </>
          ) : (
            <span className="muted">Workspace roots</span>
          )}
        </div>
        {browseError ? <p className="notice notice-error">{browseError}</p> : null}
        <ul className="picker-list picker-box picker-scroll" aria-label="Folders">
          {entries.map((e) => {
            // A workspace root comes named by its whole path: name it by its folder, as Recent does, with the path under it.
            const rooted = e.name.includes("/") || e.name.includes("\\");
            return (
              <li key={e.path}>
                <button type="button" className="picker-item" onClick={() => void browse(e.path)} title={e.path}>
                  <span className="picker-name picker-folder">
                    <IconFolder size={14} />
                    <span>{rooted ? (e.name.split(/[\\/]/).filter(Boolean).pop() ?? e.name) : e.name}</span>
                  </span>
                  {rooted ? <span className="picker-path picker-under-icon">{e.name}</span> : null}
                </button>
              </li>
            );
          })}
          {listing && entries.length === 0 ? <li className="muted picker-empty">No folders here</li> : null}
        </ul>
      </section>
      <form
        className="picker-section picker-type"
        onSubmit={(e) => {
          e.preventDefault();
          if (typed.trim()) onOpen(typed.trim());
        }}
      >
        <label htmlFor="typed-path">Or type a path</label>
        <div className="picker-type-row">
          <input id="typed-path" className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="~/projects/app" autoComplete="off" spellCheck={false} />
          <button type="submit" className="btn">
            Open
          </button>
        </div>
      </form>
    </Dialog>
  );
}
