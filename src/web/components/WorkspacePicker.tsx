// Open a project: browse folders under the server's workspace roots (the
// server confines every listing), type a path, or pick a recent one.
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowseResult } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { IconFolder } from "../icons.js";
import { Dialog } from "./Dialog.js";

/** A folder in either list: its name past the folder glyph, the place it sits under it (mono), the full
    path on hover. Both lists draw it the same way, so their names and paths start on one line. */
function FolderRow({ name, under, title, onOpen }: { name: string; under?: string; title: string; onOpen: () => void }) {
  return (
    <li>
      <button type="button" className="picker-item" onClick={onOpen} title={title}>
        <span className="picker-name picker-folder">
          <IconFolder size={14} />
          <span>{name}</span>
        </span>
        {under ? <span className="picker-path picker-under-icon">{under}</span> : null}
      </button>
    </li>
  );
}

/** The last segment of a path: what a folder is called. */
const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

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
              <FolderRow key={p} name={folderName(p)} under={p} title={p} onOpen={() => onOpen(p)} />
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
        {listing?.path ? (
          <div className="picker-location">
            <button type="button" className="btn btn-small" onClick={() => void browse(listing.parent ?? undefined)}>
              ↑ Up
            </button>
            <code className="picker-current">{listing.path}</code>
            <button type="button" className="btn btn-small btn-primary" onClick={() => onOpen(listing.path as string)}>
              Open this folder
            </button>
          </div>
        ) : null}
        {browseError ? <p className="notice notice-error">{browseError}</p> : null}
        {/* At the top the list is the workspace roots themselves. It says so to a screen reader; on screen a second
            label straight under "Browse" only repeated it. */}
        <ul className="picker-list picker-box picker-scroll" aria-label={listing?.path ? "Folders" : "Workspace roots"}>
          {entries.map((e) => {
            // A workspace root comes named by its whole path: name it by its folder, as Recent does, with the path under it.
            const rooted = e.name.includes("/") || e.name.includes("\\");
            return <FolderRow key={e.path} name={rooted ? folderName(e.name) : e.name} {...(rooted ? { under: e.name } : {})} title={e.path} onOpen={() => void browse(e.path)} />;
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
          {/* The typed path's Open becomes the dialog's primary action once there is a path to open. */}
          <button type="submit" className={typed.trim() ? "btn btn-primary" : "btn"}>
            Open
          </button>
        </div>
      </form>
    </Dialog>
  );
}
