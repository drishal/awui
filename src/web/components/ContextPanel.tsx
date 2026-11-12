// A right-hand reading/action column for a chat's actual state. Collapsed: a quiet 40px rail.
// Expanded: about 280px of relationships and management choices. It shares the outer
// chat column; an existing file/chat/terminal/Github panel remains untouched beside it.
// On a phone the expanded detail is a modal instead of squeezing a second side panel.
/* Active work stays in what this chat's own snapshots already describe. Other
 * contexts fetched are bounded readings of its own project; ownership/actions
 * go through the host chat's native APIs, not via a second session model. */
import { useEffect, useMemo, useState } from "react";
import type { ChatSnapshot, DelegatedTaskView, RaceSummary, ReviewThread, SecondOpinion } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { save, load } from "../storage.js";
import { IconAgents, IconChevronDown, IconChevronRight, IconClock, IconEdit, IconGauge, IconSidebar, IconSplit, IconTool, IconX } from "../icons.js";
import { Dialog } from "./Dialog.js";
import { ConfirmButton } from "./ConfirmButton.js";
import { jobEntries, taskAttention, raceCount, runEntries, validatedFolds, type ContextSectionId } from "../context-panel.js";

export interface ContextActions {
  onOpenChat: (chatId: string) => void;
  onCancelTask: (task: DelegatedTaskView) => void;
  onReview: (thread?: ReviewThread) => void;
  onRace: (raceId: string | null) => void;
  onOpinion: (opinion: SecondOpinion) => void;
  onUsage: () => void;
  /** Scroll the conversation to a request without auto-approving it. */
  onQuestions: () => void;
  onSubagents: (toolId: string) => void;
}

export interface ContextRailProps extends ContextActions {
  chat: ChatSnapshot;
  mode?: "inline" | "sheet";
  expanded?: boolean;
  onOpen: () => void;
  /** Close the selected detail without removing the rail. */
  onClose: () => void;
}

type Props = ContextRailProps;
type OpenState = Record<ContextSectionId, boolean>;
const DEFAULT_OPEN: OpenState = { agents: true, tasks: true, jobs: true, questions: true, races: false, opinions: false, review: false, memory: false };
const labels: Record<ContextSectionId, string> = { agents: "Agents and lineage", tasks: "Delegated work", jobs: "Background jobs", questions: "Questions and permissions", races: "Comparisons and races", opinions: "Second opinions", review: "Review comments", memory: "Context and usage" };

function Section({ id, count, open, toggle, children, warning, aria }: { id: ContextSectionId; count?: number; open: boolean; toggle: (id: ContextSectionId) => void; children: React.ReactNode; warning?: boolean; aria?: string }) {
  return <section className={`context-section context-section-${id}${warning ? " is-attention" : ""}`}>
    <button type="button" className="context-section-head" aria-expanded={open} onClick={() => toggle(id)}>
      <IconChevronDown size={12} className="context-folder-icon" />
      <h3>{labels[id]}</h3>
      {count !== undefined ? <span className="context-count">{count}</span> : null}
    </button>
    {open ? <div className="context-section-body" aria-label={aria ?? labels[id]}>{children}</div> : null}
  </section>;
}

function TaskList({ tasks, onOpenChat, onCancelTask }: { tasks: DelegatedTaskView[] | undefined; onOpenChat: ContextActions["onOpenChat"]; onCancelTask: ContextActions["onCancelTask"] }) {
  if (!tasks) return <p className="context-empty">No worker overview yet. Delegated work reports here when this chat uses the orchestration tools.</p>;
  if (tasks.length === 0) return <p className="context-empty">No delegated work attached to the current chat.</p>;
  return <ul className="context-list">{tasks.map((task) => <li key={task.id} className={`context-task is-${task.state}`}>
    <div className="context-task-title">{task.title || task.id}</div>
    <span className="muted">{task.state === "result_available" ? (task.outcome ?? "finished") : task.state}{task.harnessId ? ` · ${task.harnessId}` : ""}</span>
    {task.reviewable && task.state === "result_available" ? <span className="context-review-note">Worktree review actions live with the task on the composer/status stack.</span> : null}
    {task.childChatId ? <div className="context-item-actions"><button type="button" className="btn btn-small" onClick={() => onOpenChat(task.childChatId!)}>Open chat</button>{task.state !== "result_available" ? <ConfirmButton label={`Cancel ${task.id}`} className="btn btn-small btn-ghost" onConfirm={() => onCancelTask(task)} danger iconOnly>Cancel</ConfirmButton> : null}</div> : null}
  </li>)}</ul>;
}

export function ContextPanel({ chat, expanded = true, onOpen, mode, onClose, onOpenChat, onCancelTask, onReview, onRace, onOpinion, onUsage, onQuestions, onSubagents }: Props) {


  const [open, setOpen] = useState<OpenState>(() => ({ ...DEFAULT_OPEN, ...validatedFolds(load<Partial<OpenState>>("context.folds", {})) }));
  const [races, setRaces] = useState<RaceSummary[] | null>(null);
  const [opinions, setOpinions] = useState<SecondOpinion[] | null>(null);
  const chatId = chat.chatId;
  const runs = useMemo(() => runEntries(chat.items), [chat.items]);
  const jobs = useMemo(() => jobEntries(chat.items), [chat.items]);
  const hasQuestions = chat.pending.length > 0;
  const running = taskAttention(chat.delegated ?? []) + runs.filter((r) => r.status === "running" || r.status === "pending").length + jobs.filter((j) => j.status === "running").length;
  const numberOfRaces = raceCount(races, chat.workspace.id);

  const [noteError, setNoteError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setNoteError(null);
    setOpinions(null);
    void api<{ opinions: SecondOpinion[] }>(`/api/chats/${chatId}/second-opinion`).then((answer) => { if (active) setOpinions(answer.opinions); }).catch((e: unknown) => { if (active) setNoteError(errorText(e)); });
    return () => { active = false; };
  }, [chatId]);
  useEffect(() => {
    if (!expanded) return;
    let active = true;
    setRaces(null);
    void api<{ races: RaceSummary[] }>("/api/races").then((answer) => { if (active) setRaces(answer.races); }).catch((e: unknown) => { if (active) setNoteError(errorText(e)); });
    return () => { active = false; };
  }, [expanded, chat.workspace.id]);

  const toggle = (id: ContextSectionId) => {
    const next = { ...open, [id]: !open[id] };
    setOpen(next);
    save("context.folds", next);
  };
  const renderDetails = (
    <>
      <Section id="agents" toggle={toggle} open={open.agents} count={runs.length}>
        {chat.lineage ? <div className="context-lineage"><span className="muted">This is a delegated chat · depth {chat.lineage.depth}</span><button type="button" className="btn btn-small btn-ghost" onClick={() => onOpenChat(chat.lineage?.parentChatId ?? "")}>Open parent</button></div> : null}
        {runs.length === 0 && !chat.lineage ? <p className="context-empty">No agent-side runs in this chat.</p> : null}
        <ul className="context-list">{runs.slice(-8).map((run) => <li key={run.key} className="context-run">
          <div><strong>{run.label || run.agent}</strong><span className="muted"> · {run.agent}</span></div>
          <div className="context-run-meta"><span className={`is-running-${run.status === "running"}`}>{run.status}</span><IconClock size={10} />{run.activity ? <span className="muted">{run.activity}</span> : null}</div>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => onSubagents(run.toolId)} aria-label={`Open ${run.agent} run`}>Open run</button>
        </li>)}</ul>
      </Section>

      <Section id="tasks" toggle={toggle} open={open.tasks} count={(chat.delegated ?? []).length || undefined} warning={taskAttention(chat.delegated ?? []) > 0}>
        <TaskList onOpenChat={onOpenChat} onCancelTask={onCancelTask} tasks={chat.delegated} />
      </Section>

      <Section id="jobs" toggle={toggle} open={open.jobs} count={jobs.length ? jobs.length : undefined}>
        {jobs.length === 0 ? <p className="context-empty">No background jobs reported in this chat.</p> : <ul className="context-list">{jobs.slice(-8).map((job) => <li key={job.key}><div className="context-job-head"><IconTool size={12} /><span>{job.label}</span></div><span className="muted">{job.status}{job.kind === "shell" ? " · shell" : ""}</span><button type="button" className="btn btn-small btn-ghost" onClick={() => onSubagents(job.toolId)}>Open reported output</button></li>)}</ul>}
      </Section>

      <Section id="questions" toggle={toggle} open={open.questions} count={hasQuestions ? chat.pending.length : 0} warning={hasQuestions}>
        {hasQuestions ? <><p className="context-prompt">This chat needs a human answer before it can proceed.</p><button type="button" className="btn btn-small" onClick={onQuestions}>Jump to the request</button></> : <p className="context-empty">No approvals or interactive questions waiting right now.</p>}
      </Section>

      <Section id="races" toggle={toggle} open={open.races} count={races ? numberOfRaces : undefined}>
        {!races ? <p className="context-empty context-loading">Reading project comparisons…</p> : races.filter((r) => r.workspaceId === chat.workspace.id).length === 0 ? <p className="context-empty">No recorded isolated comparisons for {chat.workspace.name}.</p> : <ul className="context-list">{races.filter((r) => r.workspaceId === chat.workspace.id).slice(0, 8).map((r) => <li key={r.id}><div>{r.prompt || "Comparison"}</div><span className="muted">{r.members.length} chats · {r.winnerChatId ? "winner chosen" : r.members.some((m) => m.status === "running") ? "working" : "awaiting review"}</span><button type="button" className="btn btn-small btn-ghost" onClick={() => onRace(r.id)}>Open comparison</button></li>)}</ul>}
      </Section>

      <Section id="opinions" toggle={toggle} open={open.opinions}>
        {opinions === null ? <p className="context-empty">No new second-opinion records in this chat yet, or they cannot be shown.</p> : opinions.length === 0 ? <p className="context-empty">This chat has not sent any turn for a second opinion.</p> : <ul className="context-list">{opinions.map((opinion) => <li key={opinion.id}><div>{opinion.ask || `Second opinion from turn ${opinion.turn}`}</div><span className="muted">Asked {opinion.to}{opinion.report ? " · replied" : " · still working"}</span><button type="button" className="btn btn-small btn-ghost" onClick={() => onOpinion(opinion)}>View opinion</button></li>)}</ul>}
      </Section>

      <Section id="review" toggle={toggle} open={open.review}>
        <ReviewSection chatId={chatId} onReview={onReview} />
      </Section>

      <Section id="memory" toggle={toggle} open={open.memory} warning={!!chat.context?.percent && chat.context.percent >= 80}>
        {chat.context ? <><div className="context-usage"><span className="context-usage-bar" style={{ "--context-value": `${Math.min(100, chat.context.percent ?? 0)}%` } as React.CSSProperties} /><strong>{chat.context.percent === null ? "—" : Math.round(chat.context.percent)}%</strong></div><p className="muted">{chat.context.tokens ?? "tokens not reported"}{chat.context.window ? ` / ${chat.context.window} window` : ""}{chat.context.percent !== null ? ` · ${chat.context.percent}%` : ""}</p><button type="button" className="btn btn-small btn-ghost" onClick={onUsage}>Open context and timings</button></> : <p className="context-empty">This harness has not reported context-window usage yet.</p>}
      </Section>
      {noteError ? <p className="context-error" role="alert">{noteError}</p> : null}
    </>
  );

  if (mode === "sheet") {
    return <Dialog title="Active chat context" onClose={onClose}>
      {renderDetails}
    </Dialog>;
  }
  return <aside className={`context-panel${expanded ? " is-expanded" : " is-collapsed"}`} aria-label="Chat context">
    <div className="context-top">
      <button className="icon-btn" aria-label={expanded ? "Collapse context panel" : "Expand context panel"} title={expanded ? "Hide active work detail" : "Open active work detail"} onClick={() => (expanded ? onClose() : onOpen())}>{expanded ? <IconChevronRight size={16} /> : <IconSidebar size={16} />}</button>
      {expanded ? <div className="context-title"><strong>Active work</strong><span>{chat.title || chat.harnessId}</span></div> : <div className="context-rails">
        <button type="button" className="context-rail-button" title={chat.pending.length > 0 || running > 0 ? "Jump to an ongoing run or pending answer" : "Expand active work"} aria-label="Open contextual work details" onClick={() => { if (hasQuestions) onQuestions(); else onOpen(); }}><IconAgents size={16} />{hasQuestions || running > 0 ? <span className="context-dot" /> : null}</button>
        <button type="button" className="context-rail-button" title="Project comparisons and races" aria-label="Inspect project races" onClick={() => { onOpen(); if (!open.races) toggle("races"); }}><IconSplit size={16} />{numberOfRaces > 0 ? <span className="context-dot" /> : null}</button>
      </div>}
    </div>
    {expanded ? <div className="context-scroller">{renderDetails}</div> : <div className="context-rail-foot"><span className="context-vertical-title">{chat.title || chat.harnessId}</span><span className={`context-live-grow${running || hasQuestions ? " is-on" : ""}`} /></div>}
    <button type="button" className="context-close-small" aria-label="Close context management" onClick={onClose}><IconX size={12} /></button>
  </aside>;
}

function ReviewSection({ chatId, onReview }: { chatId: string; onReview: (thread?: ReviewThread) => void }) {
  const [threads, setThreads] = useState<ReviewThread[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api<{ threads: ReviewThread[] }>(`/api/chats/${chatId}/review-threads`).then((answer) => { if (live) setThreads(answer.threads); }).catch((e: unknown) => { if (live) setError(errorText(e)); });
    return () => { live = false; };
  }, [chatId]);
  if (error) return <p className="context-error" role="alert">{error}</p>;
  return <>
    {threads && threads.length > 0 ? <ul className="context-list">{threads.slice(0, 12).map((thread) => <li key={thread.id} className="context-review-thread">
      <button type="button" className="btn btn-small btn-ghost" onClick={() => onReview(thread)}>{thread.anchor.path}:{thread.anchor.line ?? "?"}</button>
      <span className="muted">{thread.notes?.[0]?.text ?? "Comment thread"}</span>
      <span className="context-thread-meta">{thread.status}</span>
    </li>)}</ul> : <p className="context-empty">{threads === null ? "Reading actual review comments…" : "No comments yet. Review the current diff using the existing review surface."}</p>}
    <button type="button" className="btn btn-small" onClick={() => onReview()}><IconEdit size={12} />Open file review</button>
  </>;
}
