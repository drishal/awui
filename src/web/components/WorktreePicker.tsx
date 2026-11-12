// Select or create an isolated Git checkout. Worktree paths stay server-owned;
// choosing one just hands its workspace to the ordinary start/resume flow.
import { useEffect, useRef, useState } from "react";
import type { WorktreeInfo, WorktreeSeedReport, WorkspaceInfo } from "../../shared/protocol.js";
import { api, errorText, idempotencyKey } from "../api.js";
import { Dialog } from "./Dialog.js";
import { worktreeSeedSummary } from "../worktree-seed.js";

export function WorktreePicker({ workspace, onOpen, onClose, onCompare, onSeeded }: {
  workspace: WorkspaceInfo;
  onOpen(path: string): Promise<void>;
  onClose(): void;
  onCompare(): void;
  onSeeded(text: string): void;
}) {
  const [trees, setTrees] = useState<WorktreeInfo[]>([]);
  const [name, setName] = useState("");
  const [base, setBase] = useState("HEAD");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<string | null>(null);
  const refresh = async () => {
    try {
      setTrees((await api<{ worktrees: WorktreeInfo[] }>(`/api/workspaces/${workspace.id}/worktrees`)).worktrees);
      setError(null);
    } catch (e) { setError(errorText(e)); }
  };
  useEffect(() => { void refresh(); }, [workspace.id]);
  // One key per attempt: a create retried after its answer was lost (the same name and base)
  // must not make a second checkout, while a different name or base is a new one.
  const attempt = useRef<{ key: string; name: string; base: string } | null>(null);
  const create = async () => {
    setBusy(true);
    setError(null);
    const prior = attempt.current;
    const key = prior && prior.name === name && prior.base === base ? prior.key : idempotencyKey();
    attempt.current = { key, name, base };
    try {
      const tree = await api<WorktreeInfo & { seeded: WorktreeSeedReport }>(`/api/workspaces/${workspace.id}/worktrees`, { body: { name, base }, idempotencyKey: key });
      const seeded = worktreeSeedSummary(tree.seeded);
      attempt.current = null;
      if (seeded) onSeeded(seeded);
      await onOpen(tree.path);
      onClose();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog title={`Worktrees for ${workspace.name}`} onClose={onClose} className="dialog-wide">
      <p className="muted">Each chat runs in its own checkout. Nothing is deleted unless you choose Prune on a clean managed tree.</p>
      {error ? <p className="notice notice-error">{error}</p> : null}
      <form onSubmit={(e) => { e.preventDefault(); void create(); }} className="worktree-create">
        <label>Task name <input className="input" required pattern="[a-z0-9][a-z0-9\-]{0,63}" value={name} onChange={(e) => setName(e.target.value)} placeholder="fix-sidebar" minLength={1} maxLength={64} /></label>
        <label>Base branch or commit <input className="input" required value={base} onChange={(e) => setBase(e.target.value)} maxLength={256} /></label>
        <button className="btn btn-primary" disabled={busy || !name.trim() || !base.trim()}>{busy ? "Creating…" : "Create worktree"}</button>
      </form>
      <div className="worktree-actions">
        <button type="button" className="btn" onClick={onCompare}>Compare agents in isolated worktrees</button>
      </div>
      {trees.length > 0 ? <h3>Existing worktrees</h3> : <p className="muted">No managed worktrees yet.</p>}
      <ul className="picker-list worktree-list">
        {trees.map((tree) => <li key={tree.id} className="worktree-row">
          <button type="button" className="picker-item" onClick={() => void onOpen(tree.path).then(onClose).catch((e) => setError(errorText(e)))}>
            <span className="picker-name">{tree.branch}</span><span className="picker-path">{tree.path}</span>
          </button>
          <button type="button" className="btn btn-small btn-ghost" title="Remove this worktree only when git reports it clean" disabled={removing !== null} onClick={() => void (async () => {
            setRemoving(tree.id); setError(null);
            try { await api(`/api/workspaces/${workspace.id}/worktrees/${tree.id}`, { method: "DELETE" }); await refresh(); }
            catch (e) { setError(errorText(e)); }
            finally { setRemoving(null); }
          })()}>{removing === tree.id ? "Pruning…" : "Prune"}</button>
        </li>)}
      </ul>
      <p className="muted">Pruning refuses a dirty tree. A missing managed folder is forgotten only from awui's list, never force-deleted.</p>
    </Dialog>
  );
}
