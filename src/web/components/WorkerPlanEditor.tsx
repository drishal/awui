// Edit a lead/worker proposal. Saving is not a prompt: only Confirm starts ordinary
// delegated workers. The server owns the DAG, actual model validation, scope rules, and
// persistence; this component edits one bounded proposal and applies its real stream state.
import { useEffect, useState } from "react";
import type { HarnessStatus, Plan, ModelInfo } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { Dialog } from "./Dialog.js";

interface EditTask {
  id: string;
  title: string;
  prompt: string;
  harness?: string;
  leadHarness?: string;
  model?: string;
  dependsOn: string[];
  writeScope: string[];
  isolation?: "worktree";
}

function drafts(plan: Plan | null): { title: string; maxParallel: number; tasks: EditTask[] } {
  return { title: plan?.title ?? "", maxParallel: plan?.maxParallel ?? 2, tasks: plan?.tasks.map((task) => ({ ...task, title: task.title ?? task.id })) ?? [] };
}

export function WorkerPlanEditor({ chatId, plan, harnesses, leadHarness, workspaceId, models, onClose, onPlan }: {
  chatId: string;
  plan: Plan | null;
  harnesses: HarnessStatus[];
  models: ModelInfo[];
  leadHarness: string;
  workspaceId: string;
  onClose: () => void;
  onPlan: (plan: Plan | null) => void;
}) {
  const [draft, setDraft] = useState(() => drafts(plan));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [catalogs, setCatalogs] = useState<Record<string, ModelInfo[]>>({});
  useEffect(() => { if (plan) setDraft(drafts(plan)); }, [plan?.id, plan?.updatedAt]);
  const otherHarnesses = [...new Set(draft.tasks.map((task) => task.harness).filter((id): id is string => id !== undefined && id !== leadHarness && catalogs[id] === undefined))].sort();
  useEffect(() => {
    let active = true;
    for (const id of otherHarnesses) {
      void api<{ models: ModelInfo[] }>(`/api/harnesses/${encodeURIComponent(id)}/models?workspaceId=${encodeURIComponent(workspaceId)}`).then((answer) => {
        if (active) setCatalogs((current) => ({ ...current, [id]: answer.models }));
      }).catch((error: unknown) => { if (active) setError(errorText(error)); });
    }
    return () => { active = false; };
  }, [otherHarnesses.join("\0"), workspaceId]);
  const harnessModels = (id: string | undefined): ModelInfo[] => (!id || id === leadHarness ? models : catalogs[id] ?? []);
  const update = (id: string, change: Partial<EditTask>) => setDraft((current) => ({ ...current, tasks: current.tasks.map((task) => task.id === id ? { ...task, ...change } : task) }));
  const validity = draft.tasks.some((task) => !task.id.trim() || !task.prompt.trim()) || new Set(draft.tasks.map((task) => task.id)).size !== draft.tasks.length;
  const start = async (path: string, body: unknown) => {
    setBusy(true); setError(null);
    try {
      const result = await api<{ data: { plan: Plan } }>(`/api/chats/${chatId}${path}`, { body });
      onPlan(result.data.plan);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  return (
    <Dialog title="Worker plan" onClose={onClose} className="dialog-wide">
      <div className="worker-plan-editor">
      <p className="muted">Edit the assignments before starting anything. Dependencies must finish successfully first; independent tasks have disjoint write scopes. Saving is free; Confirm starts workers.</p>
      {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
      <form onSubmit={(event) => { event.preventDefault(); void start("/plans", { ...draft, tasks: draft.tasks.map(({ leadHarness: _ui, ...task }) => ({ ...task, title: task.title || undefined })), planId: plan?.id }); }}>
        <label>Proposal title <input className="input" required value={draft.title} onChange={(e) => setDraft((current) => ({ ...current, title: e.target.value }))} maxLength={160} /></label>
        <label>At most <select className="input" value={draft.maxParallel} onChange={(e) => setDraft((current) => ({ ...current, maxParallel: Number(e.target.value) }))}>{[1, 2, 3, 4].map((n) => <option key={n} value={n}>{n} parallel workers</option>)}</select></label>
        {draft.tasks.map((task) => <fieldset key={task.id}>
          <legend>{task.title || task.id || "Worker"}</legend>
          <label>Task id <input className="input" required value={task.id} disabled readOnly pattern="[a-zA-Z][a-zA-Z0-9-]{0,47}" maxLength={48} /></label>
          <label>Summary <input className="input" value={task.title} onChange={(e) => update(task.id, { title: e.target.value })} maxLength={120} /></label>
          <label>Complete assignment <textarea className="input" required rows={3} value={task.prompt} onChange={(e) => update(task.id, { prompt: e.target.value })} maxLength={32_000} /></label>
          <label>Harness <select className="input" value={task.harness ?? ""} onChange={(e) => update(task.id, { harness: e.target.value || undefined, model: undefined })}>
            <option value="">This chat's harness</option>
            {harnesses.filter((h) => h.available && !h.capabilities.readOnlyHarness).map((h) => <option key={h.id} value={h.id}>{h.displayName}</option>)}
          </select></label>
          <label>Checkout <select className="input" value={task.isolation ?? ""} onChange={(e) => update(task.id, { isolation: e.target.value === "worktree" ? "worktree" : undefined })}>
            <option value="worktree">A separate managed worktree</option>
            <option value="">The current project checkout</option>
          </select></label>
          <label>Model <select className="input" value={task.model ?? ""} onChange={(e) => update(task.id, { model: e.target.value || undefined })}>
            <option value="">This harness's default</option>
            {harnessModels(task.harness).map((model) => <option key={model.key} value={model.key}>{model.name}</option>)}
          </select></label>
          <label>Depends on (comma-separated task ids) <input className="input" value={task.dependsOn.join(",")} onChange={(e) => update(task.id, { dependsOn: e.target.value.split(/\s*,\s*/).filter(Boolean) })} /></label>
          <label>Write scope (comma-separated globs) <input className="input" value={task.writeScope.join(",")} onChange={(e) => update(task.id, { writeScope: e.target.value.split(/\s*,\s*/).filter(Boolean) })} /></label>
        </fieldset>)}
        {validity ? <p className="notice notice-warning">Every worker needs a unique id and an assignment.</p> : null}
        <button type="submit" className="btn btn-primary" disabled={busy || draft.tasks.length === 0 || !draft.title.trim() || validity}>Save edits</button>
      </form>
      {draft.tasks.length === 0 ? <div className="empty"><p className="muted">No plan exists for this chat yet. Create one explicitly, or ask an agent for a structured proposal. Saving an edit never starts a worker.</p><button type="button" className="btn btn-primary" disabled={busy} onClick={() => {
        const task = { id: "inspect", title: "Inspect and propose", prompt: "Inspect this project and propose useful next work. Make no edits until the person reviews this proposal.", writeScope: [], dependsOn: [], isolation: "worktree" as const };
        void start("/plans", { title: "Review and delegate", tasks: [task], maxParallel: 1, planId: undefined });
      }}>New proposal</button></div> : null}
      {plan?.note ? <p className="muted">{plan.note}</p> : null}
      <div className="dialog-actions">
        {plan ? <button type="button" className="btn" disabled={busy || plan.status !== "draft"} onClick={() => void start("/plans/cancel", { planId: plan.id })}>Discard proposal</button> : null}
        {plan ? <button type="button" className="btn btn-primary" disabled={busy || plan.status !== "draft"} onClick={() => void start("/plans/confirm", { planId: plan.id })}>Confirm and start workers</button> : null}
      </div>
      </div>
    </Dialog>
  );
}
