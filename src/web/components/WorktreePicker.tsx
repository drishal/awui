// Select or create an isolated Git checkout. Worktree paths stay server-owned;
// choosing one just hands its workspace to the ordinary start/resume flow. The project
// may check in its own `awui.yml`: its base ref fills the form, its shared entries seed
// the tree, and its setup command is offered only once a person has trusted that exact
// version and ticks the box — a repository's file never runs anything by itself.
import { useEffect, useRef, useState } from "react";
import type { ProjectConfigStatus, RunResult, WorktreeInfo, WorktreeSeedReport, WorkspaceInfo } from "../../shared/protocol.js";
import { api, errorText, idempotencyKey } from "../api.js";
import { Dialog } from "./Dialog.js";
import { worktreeSeedSummary } from "../worktree-seed.js";
import { canRunSetup, defaultBase, projectConfigWants, trustLabel } from "../project-config.js";

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
  // The project's own awui.yml, if it has one: its base fills the form, its trust decides the rest.
  const [projectConfig, setProjectConfig] = useState<ProjectConfigStatus | null>(null);
  const [runSetup, setRunSetup] = useState(false);
  /** The tree whose setup command is running now; every Set up is disabled meanwhile. */
  const [settingUp, setSettingUp] = useState<string | null>(null);
  const [setupResult, setSetupResult] = useState<RunResult | null>(null);
  const refresh = async () => {
    try {
      setTrees((await api<{ worktrees: WorktreeInfo[] }>(`/api/workspaces/${workspace.id}/worktrees`)).worktrees);
      const config = (await api<{ config: ProjectConfigStatus | null }>(`/api/workspaces/${workspace.id}/project-config`)).config;
      setProjectConfig(config);
      // The project's default base applies until someone types another one.
      setBase((current) => (current === "HEAD" ? defaultBase(config) : current));
      setError(null);
    } catch (e) { setError(errorText(e)); }
  };
  useEffect(() => { void refresh(); }, [workspace.id]);
  // Trust is the server's record of one hash: a file that changed since is untrusted again.
  const trust = async () => {
    if (!projectConfig) return;
    setError(null);
    try {
      await api(`/api/workspaces/${workspace.id}/project-config/trust`, { body: { hash: projectConfig.hash } });
      await refresh();
    } catch (e) { setError(errorText(e)); }
  };
  const setupIn = async (tree: Pick<WorktreeInfo, "id" | "branch">) => {
    setError(null);
    setSetupResult(null);
    setSettingUp(tree.id);
    try {
      const result = await api<RunResult>(`/api/workspaces/${workspace.id}/worktrees/${tree.id}/setup`, { method: "POST" });
      setSetupResult(result);
      onSeeded(setupSummary(tree.branch, result));
    } catch (e) { setError(errorText(e)); }
    finally { setSettingUp(null); }
  };
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
      const tree = await api<WorktreeInfo & { seeded: WorktreeSeedReport; setup?: RunResult }>(`/api/workspaces/${workspace.id}/worktrees`, { body: { name, base, ...(runSetup ? { setup: true } : {}) }, idempotencyKey: key });
      const seeded = worktreeSeedSummary(tree.seeded);
      attempt.current = null;
      if (seeded) onSeeded(seeded);
      if (tree.setup) onSeeded(setupSummary(tree.branch, tree.setup));
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
      {projectConfig ? (
        <div className={`worktree-config${projectConfig.problem ? " is-problem" : ""}`} data-testid="project-config">
          <p className="worktree-config-line">
            <span className="mono">{projectConfig.file}</span>{" "}
            {projectConfig.problem ? <span className="notice-error">{projectConfig.problem}</span> : <span className="muted">{projectConfigWants(projectConfig) ?? "asks for nothing yet"}</span>}
          </p>
          {projectConfig.trusted ? (
            <span className="muted">{trustLabel(projectConfig)}</span>
          ) : (
            <button type="button" className="btn btn-small" onClick={() => void trust()} disabled={projectConfig.problem !== undefined}>
              {trustLabel(projectConfig)}
            </button>
          )}
          {canRunSetup(projectConfig) ? (
            <label className="worktree-setup-check">
              <input type="checkbox" checked={runSetup} onChange={(e) => setRunSetup(e.target.checked)} />
              Run <span className="mono">{projectConfig.config.setup}</span> in the new worktree
            </label>
          ) : null}
        </div>
      ) : null}
      <div className="worktree-actions">
        <button type="button" className="btn" onClick={onCompare}>Compare agents in isolated worktrees</button>
      </div>
      {setupResult ? (
        <pre className="worktree-setup-output" data-testid="setup-output">
          {`${setupResult.exitCode === null ? "no exit code" : `exit ${setupResult.exitCode}`}${setupResult.timedOut ? " · timed out" : ""}${setupResult.truncated ? " · output truncated" : ""}\n${setupResult.output}`}
        </pre>
      ) : null}
      {trees.length > 0 ? <h3>Existing worktrees</h3> : <p className="muted">No managed worktrees yet.</p>}
      <ul className="picker-list worktree-list">
        {trees.map((tree) => <li key={tree.id} className="worktree-row">
          <button type="button" className="picker-item" onClick={() => void onOpen(tree.path).then(onClose).catch((e) => setError(errorText(e)))}>
            <span className="picker-name">{tree.branch}</span><span className="picker-path">{tree.path}</span>
          </button>
          {canRunSetup(projectConfig) ? (
            <button type="button" className="btn btn-small btn-ghost" title={`Run ${projectConfig?.config.setup ?? "the setup command"} in this worktree`} disabled={settingUp !== null} onClick={() => void setupIn(tree)}>
              {settingUp === tree.id ? "Running…" : "Set up"}
            </button>
          ) : null}
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

/** One line for a finished setup run: what it exited with, and whether anything was cut. */
function setupSummary(branch: string, result: RunResult): string {
  const how = result.timedOut ? "timed out" : result.exitCode === 0 ? "finished" : `exited ${result.exitCode ?? "?"}`;
  return `Setup in ${branch} ${how}${result.truncated ? " (output truncated)" : ""}`;
}
