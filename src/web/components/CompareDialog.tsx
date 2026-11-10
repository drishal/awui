// One prompt, separate worktrees and harnesses. The server creates only the
// chosen tasks, reports each one's start failure, and returns ordinary chats.
import { useEffect, useState } from "react";
import type { ChatSnapshot, HarnessStatus, WorkspaceInfo } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { Dialog } from "./Dialog.js";

export function CompareDialog({ workspace, harnesses, initialHarness, initialModel, onDone, onClose }: {
  workspace: WorkspaceInfo;
  harnesses: HarnessStatus[];
  initialHarness: string | null;
  initialModel: string | null;
  onDone(chats: ChatSnapshot[]): void;
  onClose(): void;
}) {
  const available = harnesses.filter((h) => h.available);
  const [choices, setChoices] = useState<string[]>(() => [...new Set([initialHarness, ...available.map((h) => h.id).filter((id) => id !== initialHarness)].filter((id): id is string => id !== null))].slice(0, 3));
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("compare");
  const [base, setBase] = useState("HEAD");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  useEffect(() => { if (choices.length < 2) setChoices(available.slice(0, 2).map((h) => h.id)); }, [available.length]);
  const start = async () => {
    setBusy(true); setError(null); setOutcomes({});
    try {
      const response = await api<{ results: Array<{ harnessId: string; snapshot: ChatSnapshot | null; error?: string; tree: { path: string } | null }> }>("/api/compare", {
        body: { workspaceId: workspace.id, name, base, prompt, choices: choices.map((harnessId, index) => ({ harnessId, ...(index === 0 && harnessId === initialHarness && initialModel ? { model: initialModel } : {}) })) },
      });
      const problems = response.results.filter((result) => result.error);
      if (response.results.length === 0) throw new Error("No worktrees were created");
      onDone(response.results.flatMap((r) => r.snapshot ? [r.snapshot] : []));
      // The started chats are open already; the dialog stays only to show what failed.
      if (problems.length === 0) onClose();
      else setOutcomes(Object.fromEntries(problems.map((r) => [r.tree?.path ?? (harnesses.find((h) => h.id === r.harnessId)?.displayName ?? r.harnessId), r.error ?? "Could not start"])));
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog title={`Compare agents in ${workspace.name}`} onClose={onClose} className="dialog-wide">
      <p className="muted">Each selected agent gets a new worktree and its own chat. Review and adopt the result later; nothing merges automatically.</p>
      {error ? <p className="notice notice-error">{error}</p> : null}
      {Object.entries(outcomes).map(([path, why]) => <p className="notice notice-error" key={path}>{path}: {why}</p>)}
      <fieldset className="compare-harnesses"><legend>Run this prompt with</legend>
        {available.map((harness) => <label className="checkbox" key={harness.id}>
          <input type="checkbox" checked={choices.includes(harness.id)} onChange={(e) => setChoices((current) => e.target.checked ? [...current, harness.id] : current.filter((id) => id !== harness.id))} />
          {harness.displayName}{harness.id === initialHarness && initialModel ? ` · ${initialModel}` : ""}
        </label>)}
      </fieldset>
      <label>Task prefix <input className="input" value={name} onChange={(e) => setName(e.target.value)} pattern="[a-z0-9][a-z0-9\-]{0,63}" maxLength={64} required /></label>
      <label>Base branch or commit <input className="input" value={base} onChange={(e) => setBase(e.target.value)} maxLength={256} required /></label>
      <label>Prompt <textarea className="input compare-prompt" rows={7} value={prompt} onChange={(e) => setPrompt(e.target.value)} autoFocus /></label>
      <div className="dialog-actions">
        <button className="btn btn-primary" disabled={busy || choices.length < 2 || choices.length > 4 || !prompt.trim() || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name) || !base.trim()} onClick={() => void start()}>{busy ? `Creating ${choices.length} worktrees…` : `Compare ${choices.length} agents`}</button>
        <button className="btn" onClick={onClose}>{busy ? "Keep tasks in background" : "Cancel"}</button>
      </div>
      <p className="muted">If one agent cannot start, the others keep their worktrees. Its failure appears here; all started chats stay available.</p>
    </Dialog>
  );
}
