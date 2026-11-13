// A right-hand reading/action column for a chat's actual state. Collapsed: a quiet 40px rail.
// Expanded: about 280px of relationships and management choices. It shares the outer
// chat column; an existing file/chat/terminal/Github panel remains untouched beside it.
// On a phone the expanded detail is a modal instead of squeezing a second side panel.
/* Active work stays in what this chat's own snapshots already describe. Other
 * contexts fetched are bounded readings of its own project; ownership/actions
 * go through the host chat's native APIs, not via a second session model. */
import { useEffect, useMemo, useState } from "react";
import type { ChatSnapshot, DelegatedTaskView, GitStatus, RaceSummary, ReviewThread, SecondOpinion } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { save, load } from "../storage.js";
import { IconAgents, IconBranch, IconChevronRight, IconEdit, IconFork, IconGauge, IconSidebar, IconSpark, IconSplit, IconStop, IconTerminal, IconTool, IconWarning } from "../icons.js";
import { Dialog } from "./Dialog.js";
import { ConfirmButton } from "./ConfirmButton.js";
import { DiffBadge } from "./ToolBody.js";
import { ContextCardAction, ContextGroup, ContextList, ContextQuiet, ContextRow, ContextRowButton, ContextStatus } from "./ContextRows.js";
import { gitSummary, jobEntries, jobReadout, raceCount, runEntries, runReadout, taskAttention, taskReadout, tokenCount, validatedFolds, type ContextSectionId } from "../context-panel.js";

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
const OPERATION_LABEL: Record<NonNullable<GitStatus["operation"]>, string> = { merge: "merge", rebase: "rebase", "cherry-pick": "cherry-pick", revert: "revert", bisect: "bisect" };

/**
 * The project's branch and counts for the summary card: one reading when the panel
 * opens, again when the chat settles. The composer's git row already owns the live
 * polling, so this never adds an interval.
 */
function useProjectGit(chatId: string, status: ChatSnapshot["status"], showing: boolean): GitStatus | null {
  const [git, setGit] = useState<GitStatus | null>(null);
  useEffect(() => {
    if (!showing) return;
    let live = true;
    void api<{ status: GitStatus | null }>(`/api/chats/${chatId}/git`).then((answer) => { if (live) setGit(answer.status); }).catch(() => undefined);
    return () => { live = false; };
  }, [chatId, status, showing]);
  return git;
}

export function ContextPanel({ chat, expanded = true, onOpen, mode, onClose, onOpenChat, onCancelTask, onReview, onRace, onOpinion, onUsage, onQuestions, onSubagents }: Props) {
  const [open, setOpen] = useState<OpenState>(() => ({ ...DEFAULT_OPEN, ...validatedFolds(load<Partial<OpenState>>("context.folds", {})) }));
  const [races, setRaces] = useState<RaceSummary[] | null>(null);
  const [opinions, setOpinions] = useState<SecondOpinion[] | null>(null);
  const [threads, setThreads] = useState<ReviewThread[] | null>(null);
  const chatId = chat.chatId;
  const runs = useMemo(() => runEntries(chat.items), [chat.items]);
  const jobs = useMemo(() => jobEntries(chat.items), [chat.items]);
  const tasks = chat.delegated ?? [];
  const hasQuestions = chat.pending.length > 0;
  const running = taskAttention(tasks) + runs.filter((r) => r.status === "running" || r.status === "pending").length + jobs.filter((j) => j.status === "running").length;
  const numberOfRaces = raceCount(races, chat.workspace.id);
  const showing = mode === "sheet" || expanded;
  const git = useProjectGit(chatId, chat.status, showing);
  const project = gitSummary(git);
  const hasAttention = running + chat.pending.length;

  const [noteError, setNoteError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setNoteError(null);
    setOpinions(null);
    void api<{ opinions: SecondOpinion[] }>(`/api/chats/${chatId}/second-opinion`).then((answer) => { if (active) setOpinions(answer.opinions); }).catch((e: unknown) => { if (active) setNoteError(errorText(e)); });
    return () => { active = false; };
  }, [chatId]);
  // Read even while collapsed: the rail's badge counts unresolved comparisons, so the count has to
  // be known before the detail is opened.
  useEffect(() => {
    let active = true;
    setRaces(null);
    void api<{ races: RaceSummary[] }>("/api/races").then((answer) => { if (active) setRaces(answer.races); }).catch((e: unknown) => { if (active) setNoteError(errorText(e)); });
    return () => { active = false; };
  }, [chat.workspace.id]);
  useEffect(() => {
    if (!showing) return;
    let active = true;
    setThreads(null);
    setReviewError(null);
    void api<{ threads: ReviewThread[] }>(`/api/chats/${chatId}/review-threads`).then((answer) => { if (active) setThreads(answer.threads); }).catch((e: unknown) => { if (active) setReviewError(errorText(e)); });
    return () => { active = false; };
  }, [chatId, showing]);

  const toggle = (id: ContextSectionId) => {
    const next = { ...open, [id]: !open[id] };
    setOpen(next);
    save("context.folds", next);
  };
  const inWorkspace = (races ?? []).filter((race) => race.workspaceId === chat.workspace.id);
  const error = noteError ?? reviewError;

  const details = (
    <>
      <div className="context-summary">
        <div className="context-summary-main">
          <p className="context-summary-title" title={chat.title || chat.harnessId}>{chat.title || chat.harnessId}</p>
          <p className="context-summary-meta"><span className="context-summary-harness">{chat.harnessId}</span><span className="context-summary-sep" aria-hidden="true">·</span>{chat.workspace.name}</p>
        </div>
        {project ? <div className="context-summary-git">
          <IconBranch size={12} className="context-summary-branch-icon" />
          <span className="context-summary-branch" title={`On ${project.branch}`}>{project.branch}</span>
          {project.operation ? <span className="context-summary-op">{OPERATION_LABEL[project.operation]} in progress</span> : null}
          <span className="context-summary-diff">{project.files > 0 ? <><span className="context-summary-files">{project.files} {project.files === 1 ? "file" : "files"}</span><DiffBadge added={project.added} removed={project.removed} /></> : <span className="context-summary-clean">clean</span>}</span>
        </div> : null}
      </div>

      {runs.length > 0 || chat.lineage ? <ContextGroup id="agents" label={labels.agents} count={runs.length || undefined} open={open.agents} attention={runs.some((run) => run.status === "failed") ? "accent" : false} onToggle={toggle}>
        <ContextList>
          {chat.lineage ? <ContextRow icon={<IconFork size={13} />} title={`Delegated from ${chat.lineage.parentTitle ?? "another chat"}`} meta={`Depth ${chat.lineage.depth}`} actions={<ContextRowButton label="Open parent" onClick={() => onOpenChat(chat.lineage?.parentChatId ?? "")}><IconChevronRight size={13} /></ContextRowButton>} /> : null}
          {runs.slice(-8).map((run) => {
            const readout = runReadout(run.status);
            return <ContextRow key={run.key} icon={<IconAgents size={13} />} title={run.label || run.agent} meta={`Agent · ${run.agent}${run.activity ? ` · ${run.activity}` : ""}`} aside={<ContextStatus tone={readout.tone}>{readout.word}</ContextStatus>} actions={<ContextRowButton label={`Open ${run.agent} run`} onClick={() => onSubagents(run.toolId)}><IconChevronRight size={13} /></ContextRowButton>} />;
          })}
        </ContextList>
      </ContextGroup> : null}

      {tasks.length > 0 ? <ContextGroup id="tasks" label={labels.tasks} count={tasks.length} open={open.tasks} attention={taskAttention(tasks) > 0 ? "accent" : false} onToggle={toggle}>
        <ContextList>
          {tasks.map((task) => {
            const readout = taskReadout(task);
            const childChatId = task.childChatId;
            return <ContextRow key={task.id} icon={<IconAgents size={13} />} title={task.title || task.id} meta={`Agent · ${task.harnessId ?? "delegated"}`}
              note={task.reviewable && task.state === "result_available" ? "Worktree review actions live with the task on the composer/status stack." : undefined}
              aside={<ContextStatus tone={readout.tone}>{readout.word}</ContextStatus>}
              actions={<>
                {childChatId ? <ContextRowButton label="Open chat" onClick={() => onOpenChat(childChatId)}><IconChevronRight size={13} /></ContextRowButton> : null}
                {task.state !== "result_available" ? <ConfirmButton label={`Cancel ${task.id}`} className="context-row-button is-danger" onConfirm={() => onCancelTask(task)} danger iconOnly><IconStop size={12} /></ConfirmButton> : null}
              </>} />;
          })}
        </ContextList>
      </ContextGroup> : null}

      {jobs.length > 0 ? <ContextGroup id="jobs" label={labels.jobs} count={jobs.length} open={open.jobs} attention={jobs.some((job) => job.status === "failed") ? "accent" : false} onToggle={toggle}>
        <ContextList>
          {jobs.slice(-8).map((job) => {
            const readout = jobReadout(job.status);
            return <ContextRow key={job.key} icon={job.kind === "shell" ? <IconTerminal size={13} /> : <IconTool size={13} />} title={job.label} meta={job.kind === "shell" ? "Shell job" : "Task job"} aside={<ContextStatus tone={readout.tone}>{readout.word}</ContextStatus>} actions={<ContextRowButton label="Open reported output" onClick={() => onSubagents(job.toolId)}><IconChevronRight size={13} /></ContextRowButton>} />;
          })}
        </ContextList>
      </ContextGroup> : null}

      {hasQuestions ? <ContextGroup id="questions" label={labels.questions} count={chat.pending.length} open={open.questions} attention="accent" onToggle={toggle}>
        <div className="context-question">
          <p><IconWarning size={13} />This chat needs a human answer before it can proceed.</p>
          <button type="button" className="context-foot-button" onClick={onQuestions}>Jump to the request<IconChevronRight size={12} /></button>
        </div>
      </ContextGroup> : null}

      {inWorkspace.length > 0 ? <ContextGroup id="races" label={labels.races} count={numberOfRaces || undefined} open={open.races} onToggle={toggle}>
        <ContextList>
          {inWorkspace.slice(0, 8).map((race) => {
            const readout = race.winnerChatId ? { tone: "done" as const, word: "Chosen" } : race.members.some((member) => member.status === "running") ? { tone: "working" as const, word: "Working" } : { tone: "waiting" as const, word: "Awaiting review" };
            return <ContextRow key={race.id} icon={<IconSplit size={13} />} title={race.prompt || "Comparison"} meta={`${race.members.length} chats`} aside={<ContextStatus tone={readout.tone}>{readout.word}</ContextStatus>} actions={<ContextRowButton label="Open comparison" onClick={() => onRace(race.id)}><IconChevronRight size={13} /></ContextRowButton>} />;
          })}
        </ContextList>
      </ContextGroup> : null}

      {opinions && opinions.length > 0 ? <ContextGroup id="opinions" label={labels.opinions} count={opinions.length} open={open.opinions} onToggle={toggle}>
        <ContextList>
          {opinions.map((opinion) => <ContextRow key={opinion.id} icon={<IconSpark size={13} />} title={opinion.ask || `Second opinion from turn ${opinion.turn}`} meta={`Asked ${opinion.to}`} aside={<ContextStatus tone={opinion.report ? "done" : "working"}>{opinion.report ? "Replied" : "Working"}</ContextStatus>} actions={<ContextRowButton label="View opinion" onClick={() => onOpinion(opinion)}><IconChevronRight size={13} /></ContextRowButton>} />)}
        </ContextList>
      </ContextGroup> : null}

      {threads && threads.length > 0 ? <ContextGroup id="review" label={labels.review} count={threads.length} open={open.review} onToggle={toggle}>
        <ContextList>
          {threads.slice(0, 12).map((thread) => <ContextRow key={thread.id} icon={<IconEdit size={13} />} title={`${thread.anchor.path}:${thread.anchor.line ?? "?"}`} meta={thread.notes?.[0]?.text ?? "Comment thread"} aside={<ContextStatus tone={thread.status === "open" ? "waiting" : "quiet"}>{thread.status === "open" ? "Open" : "Resolved"}</ContextStatus>} actions={<ContextRowButton label={`Open comment on ${thread.anchor.path}:${thread.anchor.line ?? "?"}`} onClick={() => onReview(thread)}><IconChevronRight size={13} /></ContextRowButton>} />)}
        </ContextList>
        <ContextCardAction onClick={() => onReview()} icon={<IconEdit size={12} />}>Open file review</ContextCardAction>
      </ContextGroup> : null}

      <ContextGroup id="memory" label={labels.memory} open={open.memory} attention={chat.context?.percent && chat.context.percent >= 80 ? "warn" : false} onToggle={toggle}>
        {chat.context ? <>
          <ContextList>
            <ContextRow icon={<IconGauge size={13} />} title="Context used" meta={`${tokenCount(chat.context.tokens)} of ${tokenCount(chat.context.window)} tokens`} aside={<strong className="context-percent">{chat.context.percent === null ? "—" : `${Math.round(chat.context.percent)}%`}</strong>} actions={<ContextRowButton label="Open context and timings" onClick={onUsage}><IconChevronRight size={13} /></ContextRowButton>} />
          </ContextList>
          <div className="context-usage-bar" style={{ "--context-value": `${Math.min(100, chat.context.percent ?? 0)}%` } as React.CSSProperties} />
        </> : <ContextQuiet>This harness has not reported context-window usage yet.</ContextQuiet>}
      </ContextGroup>
      {error ? <p className="context-error" role="alert">{error}</p> : null}
    </>
  );

  if (mode === "sheet") {
    return <Dialog title="Active chat context" onClose={onClose}>
      {details}
    </Dialog>;
  }
  return <aside className={`context-panel${expanded ? " is-expanded" : " is-collapsed"}`} aria-label="Chat context">
    <div className={`context-top${expanded ? " is-expanded" : ""}`}>
      {expanded ? <h2 className="context-eyebrow">Active work</h2> : null}
      <button className={expanded ? "icon-btn" : "context-rail-button"} aria-label={expanded ? "Collapse context panel" : "Expand context panel"} title={expanded ? "Hide active work detail" : "Open active work detail"} onClick={() => (expanded ? onClose() : onOpen())}>{expanded ? <IconChevronRight size={16} /> : <IconSidebar size={16} />}</button>
      {!expanded ? <div className="context-rails">
        <button type="button" className="context-rail-button" title={hasQuestions || running > 0 ? "Jump to an ongoing run or pending answer" : "Expand active work"} aria-label="Open contextual work details" onClick={() => { if (hasQuestions) onQuestions(); else onOpen(); }}><IconAgents size={16} />{hasAttention > 0 ? <span className="context-rail-badge">{hasAttention > 9 ? "9+" : hasAttention}</span> : null}</button>
        <button type="button" className="context-rail-button" title="Project comparisons and races" aria-label="Inspect project races" onClick={() => { if (inWorkspace.length === 0) { onRace(null); return; } onOpen(); if (!open.races) toggle("races"); }}><IconSplit size={16} />{numberOfRaces > 0 ? <span className="context-rail-badge">{numberOfRaces > 9 ? "9+" : numberOfRaces}</span> : null}</button>
      </div> : null}
    </div>
    {expanded ? <div className="context-scroller">{details}</div> : <div className="context-rail-foot"><span className="context-vertical-title">{chat.title || chat.harnessId}</span><span className={`context-live-grow${running || hasQuestions ? " is-on" : ""}`} /></div>}
  </aside>;
}
