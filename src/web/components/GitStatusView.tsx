// Git in the composer (Hermes Desktop's coding row): one line at the base of
// the status stack — branch, upstream sync, what changed — that opens a panel
// with the details: upstream, last commit, stashes, and every changed file by
// group, each opening to its diff against HEAD.
import { useEffect, useRef, useState } from "react";
import type { DirenvState, GitFileDiff, GitStatus } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { GROUP_LABEL, branchWords, commitWords, countsLine, groupFiles, OPERATION_LABEL, stateLetter, stateTone, syncWordsOf, type GroupedFile } from "../git.js";
import { ago } from "../turns.js";
import { useNow } from "../hooks.js";
import { IconBranch, IconCheck, IconChevronDown, IconChevronRight, IconRefresh, IconTerminal, IconX } from "../icons.js";
import { DiffBadge, DiffView } from "./ToolBody.js";
import { Dot, dotted } from "./Dot.js";

function Sync({ git }: { git: GitStatus }) {
  if (!git.upstream) return <span className="git-sync is-none">not pushed</span>;
  if (git.ahead === 0 && git.behind === 0)
    return (
      <span className="git-sync is-even" title={`Even with ${git.upstream}`}>
        <IconCheck size={11} />
      </span>
    );
  return (
    <span className="git-sync" title={`${git.ahead} ahead of, ${git.behind} behind ${git.upstream}`}>
      {git.ahead > 0 ? <span>↑{git.ahead}</span> : null}
      {git.behind > 0 ? <span>↓{git.behind}</span> : null}
    </span>
  );
}

function Counts({ git }: { git: GitStatus }) {
  if (git.files.length === 0) return <span className="git-count is-clean">clean</span>;
  return <>{countsLine(git)}</>;
}

export function GitRow({ git, onOpen }: { git: GitStatus; onOpen: () => void }) {
  return (
    <button type="button" className="git-row" onClick={onOpen} data-testid="git-row" title="Git status: open for files and diffs">
      <IconBranch size={14} className="git-branch-icon" />
      <span className="git-branch">{branchWords(git)}</span>
      {git.operation ? <span className="git-op">{OPERATION_LABEL[git.operation]}</span> : null}
      <Sync git={git} />
      <span className="git-counts">
        <Counts git={git} />
      </span>
      <DiffBadge added={git.added} removed={git.removed} />
      <IconChevronRight size={13} className="git-open" />
    </button>
  );
}

/** The project's environment as direnv loaded it (the row beside the git one): shown only when direnv says so. */
export function DirenvRow({ direnv }: { direnv: DirenvState }) {
  if (direnv.rcPath === null || direnv.blocked || direnv.allowed !== true) return null;
  const slash = direnv.rcPath.lastIndexOf("/");
  return (
    <div className="direnv-row" data-testid="direnv-row" title={`direnv loads ${direnv.rcPath} into every agent this project starts`}>
      <IconTerminal size={13} className="direnv-row-icon" />
      <span className="direnv-row-text">direnv</span>
      <span className="direnv-row-file">{direnv.rcPath.slice(slash + 1)}</span>
      <IconCheck size={11} className="direnv-row-check" />
    </div>
  );
}

function FileRow({
  chatId,
  entry,
  onWrite,
  busy,
}: {
  chatId: string;
  entry: GroupedFile;
  onWrite: (kind: "stage" | "unstage", paths: string[]) => void;
  busy: boolean;
}) {
  const { file, state, lines, side } = entry;
  const [open, setOpen] = useState(false);
  const [diff, setDiff] = useState<GitFileDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const slash = file.path.lastIndexOf("/");
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : "";
  const name = file.path.slice(slash + 1);

  const toggle = () => {
    setOpen(!open);
    if (!open && !diff) {
      api<GitFileDiff>(`/api/chats/${chatId}/git/diff?path=${encodeURIComponent(file.path)}&side=${side}`)
        .then(setDiff)
        .catch((e: unknown) => setError(errorText(e)));
    }
  };

  return (
    <li className={`git-file${open ? " is-open" : ""}`}>
      <button type="button" className="git-file-head" aria-expanded={open} onClick={toggle}>
        <IconChevronDown size={12} className="git-file-chevron" />
        <span className={`git-state tone-${stateTone(state)}`} title={state}>
          {stateLetter(state)}
        </span>
        <span className="git-file-path" title={file.from ? `${file.from} → ${file.path}` : file.path}>
          {file.from && side !== "unstaged" ? <span className="git-file-from">{file.from} → </span> : null}
          <span className="git-file-dir">{dir}</span>
          <span className="git-file-name">{name}</span>
        </span>
        {lines && lines.added !== null && lines.removed !== null ? (
          <DiffBadge added={lines.added} removed={lines.removed} />
        ) : (
          <span className="git-file-note">{state === "untracked" ? "new" : state === "conflict" ? "conflict" : lines ? "binary" : ""}</span>
        )}
      </button>
      <button
        type="button"
        className="git-file-write"
        title={side === "staged" ? `Unstage ${file.path}` : `Stage ${file.path}`}
        aria-label={`${side === "staged" ? "Unstage" : "Stage"} ${file.path}`}
        disabled={busy}
        onClick={() => onWrite(side === "staged" ? "unstage" : "stage", [file.path])}
      >
        {side === "staged" ? "Unstage" : "Stage"}
      </button>
      {open ? (
        <div className="git-file-body">
          {error ? <p className="git-file-msg is-error">{error}</p> : null}
          {!diff && !error ? <p className="git-file-msg">Loading…</p> : null}
          {diff?.diff ? <DiffView diff={diff.diff} /> : null}
          {diff && !diff.diff ? <p className="git-file-msg">{diff.note ?? "No changes to show"}</p> : null}
        </div>
      ) : null}
    </li>
  );
}

export function GitPanel({ chatId, git, at, onRefresh, onClose }: { chatId: string; git: GitStatus; at: number; onRefresh: () => Promise<void>; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(true, 10_000);
  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);
  const { counts } = git;
  const groups = groupFiles(git.files);

  // Writing git: stage or unstage files, then commit what is staged. The server
  // answers with the fresh status; the row re-reads from it.
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const write = async (kind: "stage" | "unstage" | "commit", body: object) => {
    setBusy(kind);
    setError(null);
    try {
      await api(`/api/chats/${chatId}/git/${kind}`, { body });
      if (kind === "commit") setMessage("");
      await onRefresh();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(null);
    }
  };
  const canCommit = counts.staged > 0 && message.trim().length > 0 && busy === null;
  const unstaged = git.files.filter((f) => f.unstaged || f.staged === "conflict");
  const staged = git.files.filter((f) => f.staged);

  return (
    <dialog
      ref={ref}
      className="review git-sheet"
      aria-label="Git status"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="review-body">
        <header className="review-head">
          <div className="git-title">
            <h2>
              <IconBranch size={16} /> Git
            </h2>
            <p className="muted" title={git.root}>
              {git.root}
              <Dot />
              updated {ago(at, now)}
            </p>
          </div>
          <div className="git-head-actions">
            <button
              type="button"
              className="icon-btn"
              aria-label="Refresh"
              title="Refresh"
              disabled={refreshing}
              onClick={() => {
                setRefreshing(true);
                void onRefresh().finally(() => setRefreshing(false));
              }}
            >
              <IconRefresh size={15} />
            </button>
            <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
              <IconX size={16} />
            </button>
          </div>
        </header>
        <div className="git-write" data-testid="git-write">
          <input
            className="git-write-message"
            aria-label="Commit message"
            placeholder={counts.staged > 0 ? "Commit message" : "Stage a change, then commit"}
            value={message}
            disabled={counts.staged === 0 || busy !== null}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || !canCommit) return;
              e.preventDefault();
              void write("commit", { message });
            }}
          />
          <button type="button" className="btn btn-small" disabled={!canCommit} onClick={() => void write("commit", { message })}>
            Commit{counts.staged > 0 ? ` ${counts.staged}` : ""}
          </button>
          <button
            type="button"
            className="btn btn-small btn-ghost"
            disabled={busy !== null || unstaged.length === 0}
            onClick={() => void write("stage", { paths: unstaged.map((f) => f.path) })}
          >
            Stage all
          </button>
          {staged.length > 0 ? (
            <button
              type="button"
              className="btn btn-small btn-ghost"
              disabled={busy !== null}
              onClick={() => void write("unstage", { paths: staged.map((f) => f.path) })}
            >
              Unstage all
            </button>
          ) : null}
        </div>
        {error ? (
          <p className="git-write-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="review-files">
          <dl className="git-facts">
            <dt>Branch</dt>
            <dd>
              <code>{branchWords(git)}</code>
              {git.operation ? <span className="git-op">{OPERATION_LABEL[git.operation]}</span> : null}
            </dd>
            <dt>Upstream</dt>
            <dd>
              {git.upstream ? (
                <>
                  <code>{git.upstream}</code>
                  <span className="git-fact-meta">
                    {git.ahead === 0 && git.behind === 0 ? "up to date" : dotted([`${git.ahead} ahead`, `${git.behind} behind`])}
                  </span>
                </>
              ) : (
                <span className="muted">none: this branch has not been pushed</span>
              )}
            </dd>
            <dt>Last commit</dt>
            <dd>
              {git.lastCommit ? (
                <span className="git-commit">
                  <code>{git.lastCommit.hash}</code>
                  <span className="git-commit-subject">{commitWords(git.lastCommit, now)}</span>
                </span>
              ) : (
                <span className="muted">no commits yet</span>
              )}
            </dd>
            <dt>Changes</dt>
            <dd>
              {git.files.length === 0 ? (
                <span className="muted">working tree clean</span>
              ) : (
                <span className="git-fact-counts">
                  {countsLine(git)}
                  <DiffBadge added={git.added} removed={git.removed} />
                </span>
              )}
            </dd>
            {git.stashes > 0 ? (
              <>
                <dt>Stashes</dt>
                <dd>{git.stashes}</dd>
              </>
            ) : null}
          </dl>
          {git.files.length === 0 ? (
            <p className="git-clean">
              <IconCheck size={14} /> Nothing to commit
            </p>
          ) : null}
          {groups.map(({ group, files }) => (
            <section key={group} className={`git-group is-${group}`}>
              <h3 className="git-group-head">
                {GROUP_LABEL[group]} <span className="git-group-count">{files.length}</span>
              </h3>
              <ul className="git-files">
                {files.map((entry) => (
                  <FileRow key={`${group}:${entry.file.path}`} chatId={chatId} entry={entry} busy={busy !== null} onWrite={(kind, paths) => void write(kind, { paths })} />
                ))}
              </ul>
            </section>
          ))}
          {git.more > 0 ? <p className="muted git-more">and {git.more} more files</p> : null}
        </div>
      </div>
    </dialog>
  );
}
