// Push and create pull requests using the project's own gh authentication.
// No remote URL or credentials are fabricated here. The server identifies the
// actual branch and PR; this panel presents the confirmed outcome only.
import { useEffect, useState } from "react";
import type { WorkspaceInfo } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { Dialog } from "./Dialog.js";
import { IconBranch, IconRefresh } from "../icons.js";

interface Status {
  available: boolean;
  reason?: string;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  remoteUrl: string | null;
}

interface Check {
  name: string;
  state: string;
  link: string | null;
}

export function GitHubPanel({ workspace, onClose }: { workspace: WorkspaceInfo; onClose: () => void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [checks, setChecks] = useState<Check[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [base, setBase] = useState("main");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<"load" | "push" | "pr" | null>("load");

  const refresh = async () => {
    setBusy("load");
    try {
      // Status first: it carries the reason gh cannot be used, which the PR and
      // checks calls would only turn into a bare failure.
      const next = await api<Status>(`/api/workspaces/${workspace.id}/github`);
      setStatus(next);
      setError(null);
      if (!next.available) {
        setChecks([]);
        setPrUrl(null);
        return;
      }
      const [check, current] = await Promise.allSettled([
        api<{ checks: Check[] }>(`/api/workspaces/${workspace.id}/github/checks`),
        api<{ pr: { url: string; title: string; state: string; isDraft: boolean } | null }>(`/api/workspaces/${workspace.id}/github/pr`),
      ]);
      setChecks(check.status === "fulfilled" ? check.value.checks : []);
      if (current.status === "fulfilled") {
        setPrUrl(current.value.pr?.url ?? null);
        if (current.value.pr && !title) setTitle(current.value.pr.isDraft ? `${current.value.pr.title} — update` : current.value.pr.title);
      }
      const failed = [check, current].find((r) => r.status === "rejected");
      if (failed) setError(errorText(failed.reason));
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  };
  useEffect(() => { void refresh(); }, [workspace.id]);

  const push = async () => {
    setBusy("push"); setError(null);
    try {
      await api(`/api/workspaces/${workspace.id}/github/push`, { method: "POST", body: {} });
      await refresh();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  };
  const create = async () => {
    setBusy("pr"); setError(null);
    try {
      const result = await api<{ url: string; title: string; base: string }>(`/api/workspaces/${workspace.id}/github/pr`, { body: { title, base, body } });
      setPrUrl(result.url);
      await refresh();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  };

  return (
    <Dialog title={`GitHub for ${workspace.name}`} onClose={onClose} className="dialog-wide">
      <div className="github-status">
        <div><IconBranch size={16} /> <strong>{status?.branch ?? "Loading…"}</strong>{status?.upstream ? <span className="muted"> → {status.upstream}</span> : null}</div>
        <button type="button" className="icon-btn" aria-label="Refresh GitHub status" disabled={busy !== null} onClick={() => void refresh()}><IconRefresh size={14} /></button>
      </div>
      {status?.upstream ? <p className="muted">{status.ahead === 0 ? "Everything recorded on the upstream branch." : `${status.ahead} local commit${status.ahead === 1 ? "" : "s"} not on upstream.`}</p> : <p className="muted">No upstream yet. The first push sets it to the current branch on origin.</p>}
      {status?.remoteUrl ? <p className="muted github-remote">Remote: {status.remoteUrl}</p> : null}
      {error ? <p className="notice notice-error">{error}</p> : null}
      {status && !status.available ? <p className="notice notice-error">{status.reason ?? "GitHub is not available on this machine. Install gh and log in on the server."}</p> : null}
      {prUrl ? <p className="notice notice-info">Pull request: <a href={prUrl} target="_blank" rel="noreferrer">{prUrl}</a></p> : null}
      <div className="github-actions">
        <button className="btn" disabled={busy !== null || !status?.available || !status.branch} onClick={() => void push()}>{busy === "push" ? "Pushing…" : "Push current branch"}</button>
        <button className="btn btn-ghost" disabled={busy !== null || !status?.available} onClick={() => void refresh()}>{busy === "load" ? "Refreshing…" : "Refresh PR status"}</button>
      </div>
      <h3>Checks</h3>
      {checks.length === 0 ? <p className="muted">No reported checks are available for the current PR.</p> : <ul className="github-checks">{checks.map((check) => <li key={check.name}><span>{check.name}</span><span className={`github-check is-${check.state}`}>{check.state}</span>{check.link ? <a href={check.link} target="_blank" rel="noreferrer">View</a> : null}</li>)}</ul>}
      <h3>New pull request</h3>
      <p className="muted">Your explicit push creates the upstream branch. Creating a PR does not push or merge anything automatically.</p>
      <label className="form-row">Target branch <input className="input" value={base} onChange={(e) => setBase(e.target.value)} maxLength={120} /></label>
      <label className="form-row">Title <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="What changed, concisely" /></label>
      <label className="form-row">Description <textarea className="input" rows={7} value={body} onChange={(e) => setBody(e.target.value)} maxLength={20000} placeholder="Why this change matters and how it was verified" /></label>
      <button className="btn btn-primary" disabled={busy !== null || !status?.available || !title.trim() || !base.trim()} onClick={() => void create()}>{busy === "pr" ? "Creating pull request…" : "Create pull request"}</button>
      {!status?.available ? <p className="muted">The server must have gh installed and an authenticated account configured. awui never reads those credentials.</p> : null}
    </Dialog>
  );
}
