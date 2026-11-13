// An isolated worker's integration: completion is not approval. Fetch bounded review details,
// then explicitly apply, keep without applying, reverse that decision, or clean up only after review.
import { useCallback, useState } from "react";
import { api, errorText } from "../api.js";
import type { IntegrationRecord } from "../../shared/protocol.js";
import { ConfirmButton } from "./ConfirmButton.js";

export function TaskReview({ chatId, taskId, workspaceId }: { chatId: string; taskId: string; workspaceId: string }) {
  const [state, setState] = useState<{ record: IntegrationRecord; headsMatch: boolean | null; reason: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspecting, setInspecting] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await api<typeof state>(`/api/chats/${chatId}/tasks/${taskId}/review`);
      setState(response);
    } catch (cause) { setError(errorText(cause)); }
  }, [chatId, taskId]);
  if (!inspecting) return <button type="button" className="btn btn-small" onClick={() => { setInspecting(true); void load(); }}>Inspect integration</button>;
  const act = async (path: string, body?: unknown) => {
    setBusy(true); setError(null);
    try {
      await api(`/api/chats/${chatId}/tasks/${taskId}/${path}`, { ...(body ? { body } : {}) });
      await load();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  };
  if (!state && !error) return <p className="muted">Checking the worker's recorded heads before review…</p>;
  if (!state) return error ? <p className="notice notice-error" role="alert">{error}</p> : null;
  const { record } = state;
  return (
    <section className="task-review" aria-label={`Review ${taskId}`}>
      <p className="muted">
        {record.appliedAt ? "Approved and applied into the lead checkout. The lead's files changed; no further automatic integration runs here. Undo apply reverses that patch while the checkout still holds exactly it."
          : record.discardedAt ? "Reviewed without applying. The managed worktree stays until you clean it up."
            : state.headsMatch === false ? `Cannot apply yet: ${state.reason ?? "a recorded head moved"}. Open the worktree to inspect it.`
              : "The worker finished in its own checkout. Choose whether to apply its patch, or keep it without applying. Nothing starts until you choose."}
      </p>
      {error ? <p className="notice notice-error" role="alert">{error}</p> : null}
      {!record.review ? <label className="task-review-note">Review note (optional)<input className="input" value={note} maxLength={400} onChange={(e) => setNote(e.target.value)} disabled={busy} /></label> : null}
      <div className="task-review-actions">
        {!record.review ? <>
          <button type="button" className="btn btn-small btn-primary" disabled={busy || state.headsMatch === false} onClick={() => void act("review", { workspaceId, decision: "apply", note: note || undefined })}>Apply patch into lead</button>
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => void act("review", { workspaceId, decision: "discard", note: note || undefined })}>Keep it unapplied</button>
        </> : <>
          <button type="button" className="btn btn-small" disabled={busy} onClick={() => void act("unreview")}>{record.appliedAt ? "Undo apply" : "Back to review"}</button>
          {!record.appliedAt ? <ConfirmButton label="Remove managed worktree" confirmLabel="Discard this worktree?" className="btn btn-small" disabled={busy} onConfirm={() => void act("review/cleanup")} /> : null}
        </>}
      </div>
    </section>
  );
}
