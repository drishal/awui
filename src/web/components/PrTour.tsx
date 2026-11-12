// Deterministic file-by-file PR reading: source before tests, mechanical changes last.
// This is a reading guide, not a review verdict or approval.
import { useCallback, useEffect, useState } from "react";
import type { Tour } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { DiffView } from "./ToolBody.js";

export function PrTour({ workspaceId, pr, onClose }: { workspaceId: string; pr: number; onClose: () => void }) {
  const [guide, setGuide] = useState<{ tour: Tour; stale: boolean } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [position, setPosition] = useState(0);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (regenerate: boolean) => {
    setLoading(true);
    setError(null);
    try {
      const next = await api<{ tour: Tour; stale: boolean }>(`/api/workspaces/${workspaceId}/pr-tour?pr=${pr}&regenerate=${regenerate}`);
      setGuide(next);
      if (regenerate) setPosition(0);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setLoading(false);
    }
  }, [workspaceId, pr]);
  useEffect(() => { void load(false); }, [load]);

  const count = guide?.tour.files.length ?? 0;
  const index = Math.min(position, Math.max(0, count - 1));
  const file = guide?.tour.files[index];
  return <section className="pr-tour" aria-label={`Review guide for pull request ${pr}`}>
    <div className="pr-tour-heading">
      <div>
        <h3>Review guide</h3>
        {guide ? <p className="muted">#{pr} · {guide.tour.title}</p> : null}
      </div>
      <button type="button" className="btn btn-small btn-ghost" disabled={loading} onClick={onClose}>Back to pull request</button>
    </div>
    <p className="muted">Source changes first, then tests, generated output, and mechanical files. A reading guide, not an approval.</p>
    {error ? <div className="notice notice-error" role="alert">{error}</div> : null}
    {loading ? <p className="muted" role="status">{guide ? "Rebuilding from the PR’s current head…" : "Reading the PR diff…"}</p> : null}
    {guide && !file ? <p className="muted">No textual file changes to tour. Inspect binary or metadata changes on GitHub.</p> : null}
    {guide?.stale ? <p className="notice notice-info" role="alert">The PR has changed since this guide was made. Rebuild from the current head before judging it.</p> : null}
    {file ? <>
      <div className="tour-step" aria-label={`Viewing file ${index + 1} of ${count}`}>
        <div>
          <strong>{file.path}</strong>
          <span className="muted">{index + 1} of {count} · {file.bucket}</span>
        </div>
        <button type="button" className="btn btn-small" disabled={loading} onClick={() => void load(true)}>{loading ? "Checking…" : "Rebuild from current PR"}</button>
      </div>
      <div className="pr-tour-body" aria-live="polite">
        {file.diff ? <DiffView diff={file.diff} /> : <p className="muted">{file.note ?? "No text changes to render for this file. Inspect the full file on GitHub."}</p>}
      </div>
      <div className="tour-nav">
        <button type="button" className="btn btn-small" disabled={loading || index === 0} onClick={() => setPosition(index - 1)}>Previous file</button>
        <button type="button" className="btn btn-small" disabled={loading || index >= count - 1} onClick={() => setPosition(index + 1)}>Next file</button>
      </div>
    </> : null}
    {guide && !file && !loading ? <button type="button" className="btn btn-small" onClick={() => void load(true)}>Rebuild from current PR</button> : null}
    {guide?.tour.truncated ? <p className="muted">This is a bounded reading view. Inspect the remaining changes before approving.</p> : null}
  </section>;
}
