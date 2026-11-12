// Push, create, and stack pull requests using the project's own gh authentication.
// No remote URL or credentials are fabricated here. The server identifies the
// actual branch, PR, and stack layers; this panel presents the confirmed outcome
// only, and every write (push, create, merge, archive) is one deliberate action.
import { useEffect, useState } from "react";
import type { ChatSnapshot, PrStack, WorkspaceInfo } from "../../shared/protocol.js";
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

interface Layer {
  pr: number;
  url: string;
  title: string;
  state: string;
  baseBranch: string;
  headBranch: string;
  checks: Check[];
}

export function GitHubPanel({ workspace, chat, onClose, onOpen }: { workspace: WorkspaceInfo; chat: ChatSnapshot; onClose: () => void; onOpen: (chat: ChatSnapshot) => void }) {
  const [watching, setWatching] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [watchedUrl, setWatchedUrl] = useState<string | null>(null);
  const [repairOpen, setRepairOpen] = useState(false);
  const [checks, setChecks] = useState<Check[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const [base, setBase] = useState("main");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState<"load" | "push" | "pr" | "merge" | null>("load");
  const [stack, setStack] = useState<PrStack | null>(null);
  /** The PR to stack above, and the stacked PR's own title/description. */
  const [above, setAbove] = useState("");
  const [stackTitle, setStackTitle] = useState("");
  const [stackBody, setStackBody] = useState("");
  const [stackPush, setStackPush] = useState(false);
  const [mergeArchive, setMergeArchive] = useState(false);

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
      const mine = await api<{ watches: Array<{ url: string }> }>(`/api/chats/${chat.chatId}/pr-watches`).catch(() => null);
      setWatchedUrl(mine?.watches[0]?.url ?? null);
      const failed = [check, current].find((r) => r.status === "rejected");
      if (failed) setError(errorText(failed.reason));
      setStack((await api<{ stacks: PrStack[] }>(`/api/workspaces/${workspace.id}/pr-stack`)).stacks[0] ?? null);
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
  // Stack this PR above #above: the server makes that PR's head branch the target.
  const stackOn = async () => {
    setBusy("pr"); setError(null);
    try {
      const result = await api<{ stack: PrStack }>(`/api/workspaces/${workspace.id}/pr-stack`, { body: { above: Number(above), title: stackTitle, body: stackBody, push: stackPush } });
      setStack(result.stack);
      setStackTitle(""); setStackBody(""); setAbove("");
      await refresh();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  };
  // Start a stack on the explicit base typed in the form.
  const stackFrom = async () => {
    setBusy("pr"); setError(null);
    try {
      const result = await api<{ stack: PrStack }>(`/api/workspaces/${workspace.id}/pr-stack`, { body: { base, title: stackTitle, body: stackBody, push: stackPush } });
      setStack(result.stack);
      setStackTitle(""); setStackBody("");
      await refresh();
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(null); }
  };
  // Merge bottom-up through gh; the refusal, when one comes, is the actionable error.
  const merge = async () => {
    if (!stack) return;
    setBusy("merge"); setError(null);
    try {
      const result = await api<{ stack: PrStack; refusal: { pr: number; message: string } | null; archiveRefusals: Array<{ pr: number; message: string }> }>(`/api/workspaces/${workspace.id}/pr-stack/${stack.id}/merge`, { method: "POST", body: { archive: mergeArchive } });
      setStack(result.stack);
      const notes: string[] = [];
      if (result.refusal) notes.push(`#${result.refusal.pr} could not be merged: ${result.refusal.message}`);
      for (const refusal of result.archiveRefusals) notes.push(`#${refusal.pr}'s checkout could not be archived: ${refusal.message}`);
      if (notes.length > 0) setError(notes.join(" · "));
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
      {prUrl ? <section className="picker-section" aria-label="Pull request activity">
        <h3>Watch this PR</h3>
        <p className="muted">{watchedUrl === prUrl ? "This chat owns the watch. A real check or review change prompts it; repeated polls stay quiet." : "One opt-in watch for this chat. Activity goes to you here, never to another workspace chat."}</p>
        {!chat.sessionId ? <p className="muted">Wait for this chat's native session, then register.</p> : watchedUrl !== prUrl ? <button className="btn btn-small" disabled={watching} onClick={() => {
          setWatching(true);
          void api(`/api/chats/${chat.chatId}/pr-watch`, { body: { url: prUrl } }).then(() => setWatchedUrl(prUrl)).catch((e: unknown) => setError(errorText(e))).finally(() => setWatching(false));
        }}>Watch this PR</button> : <button className="btn btn-small" disabled={watching} onClick={() => {
          void api(`/api/chats/${chat.chatId}/pr-watch`, { method: "DELETE", body: { url: prUrl } }).then(() => setWatchedUrl(null)).catch((e: unknown) => setError(errorText(e)));
        }}>Unwatch this PR</button>}
        {checks.some((check) => /fail|error|cancel|timeout/i.test(check.state)) ? !repairOpen ? <button type="button" className="btn btn-small" disabled={chat.capabilities.readOnlyHarness} onClick={() => setRepairOpen(true)}>Offer CI repair</button> : <div className="notice notice-info">
          <p>Start a new {chat.harnessId} chat with the failing checks and their evidence. The agent fixes only those and reports local results; no push happens automatically.</p>
          <button type="button" className="btn btn-small" onClick={() => {
            void api<{ chat: ChatSnapshot }>(`/api/workspaces/${workspace.id}/pr-repair`, { body: { url: prUrl, harnessId: chat.harnessId } }).then((response) => { setRepairOpen(false); onOpen(response.chat); }).catch((e: unknown) => setError(errorText(e)));
          }}>Start repair chat</button><button type="button" className="btn btn-small btn-ghost" onClick={() => setRepairOpen(false)}>Cancel</button>
        </div> : null}
      </section> : null}
      {stack && stack.layers.length > 0 ? <>
        <h3>Stack</h3>
        <p className="muted">Merged bottom-up: each layer goes in after the one below it. Creating a stacked PR does not push or merge anything by itself.</p>
        <ul className="github-stack">
          {stack.layers.map((layer) => <li key={layer.pr} className="github-stack-row">
            <a href={layer.url} target="_blank" rel="noreferrer">#{layer.pr}</a>
            <span className="github-stack-title">{layer.title}</span>
            <span className={`github-check is-${layer.state.toLowerCase()}`}>{layer.state}</span>
            <span className="muted github-stack-base">→ {layer.baseBranch}</span>
            {layer.checks.length > 0 ? <span className="github-stack-checks">{layer.checks.filter((c) => c.state === "pass").length}/{layer.checks.length} checks</span> : null}
          </li>)}
        </ul>
        <div className="github-actions">
          <button className="btn btn-primary" disabled={busy !== null || !stack.layers.some((l) => l.state === "OPEN" || l.state === "DRAFT")} onClick={() => void merge()}>{busy === "merge" ? "Merging stack…" : "Merge stack bottom-up"}</button>
          <label className="worktree-setup-check">
            <input type="checkbox" checked={mergeArchive} onChange={(e) => setMergeArchive(e.target.checked)} />
            Archive checkouts whose PRs merge
          </label>
        </div>
      </> : null}
      <h3>Stack a new pull request</h3>
      <p className="muted">Puts a new PR on top of #above: that PR's head branch becomes the new PR's target.</p>
      <label className="form-row">Stack above (PR number) <input className="input" value={above} onChange={(e) => setAbove(e.target.value)} maxLength={5} placeholder="42, empty to start a stack on the target branch" /></label>
      <label className="form-row">Title <input className="input" value={stackTitle} onChange={(e) => setStackTitle(e.target.value)} maxLength={200} placeholder="What this layer changes" /></label>
      <label className="form-row">Description <textarea className="input" rows={4} value={stackBody} onChange={(e) => setStackBody(e.target.value)} maxLength={20000} placeholder="Why this layer matters" /></label>
      <label className="worktree-setup-check">
        <input type="checkbox" checked={stackPush} onChange={(e) => setStackPush(e.target.checked)} />
        Push the checked-out branch to origin first
      </label>
      <div className="github-actions">
        <button className="btn btn-primary" disabled={busy !== null || !stackTitle.trim() || !above.trim()} onClick={() => void stackOn()}>{busy === "pr" ? "Creating pull request…" : "Stack above #N"}</button>
        <button className="btn btn-ghost" disabled={busy !== null || !stackTitle.trim() || !base.trim()} onClick={() => void stackFrom()}>Start a stack on {base || "the target branch"}</button>
      </div>
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
