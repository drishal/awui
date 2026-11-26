// A right-hand reading/action column for a chat's actual state. Collapsed: a quiet 40px rail.
// Expanded: about 280px of relationships and management choices. It shares the outer
// chat column; an existing file/chat/terminal/Github panel remains untouched beside it.
// On a phone the expanded detail is a modal instead of squeezing a second side panel.
/* Active work stays in what this chat's own snapshots already describe. Other
 * contexts fetched are bounded readings of its own project; ownership/actions
 * go through the host chat's native APIs, not via a second session model. */
import { useEffect, useMemo, useRef, useState } from "react";
import type { ChatSnapshot, DelegatedTaskView, GitStatus, RaceSummary, ReviewThread, SecondOpinion } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { save, load } from "../storage.js";
import { IconAgents, IconBranch, IconChevronRight, IconEdit, IconFork, IconSidebar, IconSpark, IconSplit, IconStop, IconTerminal, IconTool, IconWarning } from "../icons.js";
import { Dialog } from "./Dialog.js";
import { ConfirmButton } from "./ConfirmButton.js";
import { DiffBadge } from "./ToolBody.js";
import { ContextGroup, ContextList, ContextRow, ContextRowButton, ContextStatus } from "./ContextRows.js";
import { ContextPie } from "./ContextRing.js";
import { contextTone } from "../context-tone.js";
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
  /** The composer shows the branch, diff, and context ring while this is true; the rail never repeats them. */
  composerVisible: boolean;
}

type Props = ContextRailProps;
type OpenState = Record<ContextSectionId, boolean>;
// The usage card and the questions card are open by default: they are the rail's floor and the
// one kind of work the chat cannot answer itself. The other groups start folded; pending, running,
// or failed work opens its own group, unless seeing the group at all is what notes work.
const DEFAULT_OPEN: OpenState = { agents: false, tasks: false, jobs: false, questions: true, races: false, opinions: false, review: false, memory: true };
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

export function ContextPanel({ chat, expanded = true, onOpen, mode, onClose, composerVisible, onOpenChat, onCancelTask, onReview, onRace, onOpinion, onUsage, onQuestions, onSubagents }: Props) {
  // The rail is always there, being 240–280px wide is a choice: its rows are the reason for the width, so an
  // empty rail keeps its 40px and one with something to say opens by itself. `asked` is the person overruling
  // that — true when they opened an empty rail, false when they folded a busy one away.
  const [asked, setAsked] = useState<boolean | null>(null);
  // Set while a person's own fold is animating the rail's width; the stylesheet keys the transition on it.
  const [toggling, setToggling] = useState(false);
  // Groups that have been there while this panel was mounted; a new one may open for live work,
  // but a person's later fold of it stays put. An explicit saved fold has the same precedence.
  const seenGroups = useRef<Partial<OpenState>>({});
  const savedFolds = useRef<Partial<OpenState>>(validatedFolds(load<Partial<OpenState>>("context.folds", {})));
  const [open, setOpen] = useState<OpenState>(() => ({ ...DEFAULT_OPEN, ...savedFolds.current }));
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
  const inWorkspace = (races ?? []).filter((race) => race.workspaceId === chat.workspace.id);
  // Nothing above the usage card: an empty rail says so once, in words, instead of leaving a silence
  // that reads like a panel still loading. The groups keep their rule — no empty group, no zero count.
  const idle = runs.length === 0 && !chat.lineage && tasks.length === 0 && jobs.length === 0 && !hasQuestions && inWorkspace.length === 0 && (opinions?.length ?? 0) === 0 && (threads?.length ?? 0) === 0;
  // `expanded` is the room the panel has (no viewer, tool panel or split beside it); `asked` outranks it, and
  // a rail with nothing in it does not claim the width on its own.
  const detail = mode === "sheet" || (expanded && (asked ?? !idle));
  const showing = detail;
  const git = useProjectGit(chatId, chat.status, showing && !composerVisible);
  const project = gitSummary(git);
  const hasAttention = running + chat.pending.length;

  const [noteError, setNoteError] = useState<string | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);

  // Reduced motion turns every transition off, so the width never ends: clear the mark on a timer as well
  // (a little over the fold's own 160 ms).
  useEffect(() => {
    if (!toggling) return;
    const timer = window.setTimeout(() => setToggling(false), 240);
    return () => window.clearTimeout(timer);
  }, [toggling]);

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
  // Read whether or not the detail is open: a chat whose only active work is a review comment has to know
  // about it before the rail can open itself for it, and a comment is not something a collapsed rail badges.
  useEffect(() => {
    let active = true;
    setThreads(null);
    setReviewError(null);
    void api<{ threads: ReviewThread[] }>(`/api/chats/${chatId}/review-threads`).then((answer) => { if (active) setThreads(answer.threads); }).catch((e: unknown) => { if (active) setReviewError(errorText(e)); });
    return () => { active = false; };
  }, [chatId]);
  // A row landing is what the width is for, so it overrules a fold made while the rail was empty. A busy
  // rail folded away stays folded until it empties and fills again: the ask outranks the rows, not the reverse.
  useEffect(() => {
    if (!idle) setAsked((value) => (value === false ? null : value));
  }, [idle]);

  // A group's count is what announces pending, running, or failed work: it opens once, when the
  // group appears. A person's fold of it afterwards is a choice, so the group's being there (not
  // the work's state) is what opens it; the effect also runs when the panel is folded away.
  useEffect(() => {
    const hasLive = {
      agents: runs.some((run) => run.status === "pending" || run.status === "running" || run.status === "failed"),
      tasks: tasks.some((task) => task.state !== "result_available" || task.outcome === "failed"),
      jobs: jobs.some((job) => job.status === "running" || job.status === "failed"),
      questions: hasQuestions,
      races: false,
      opinions: false,
      review: false,
      memory: true,
    };
    let next: OpenState | null = null;
    for (const id of Object.keys(hasLive) as ContextSectionId[]) {
      const exists = id === "agents" ? runs.length > 0 || chat.lineage !== null
        : id === "tasks" ? tasks.length > 0
        : id === "jobs" ? jobs.length > 0
        : id === "questions" ? hasQuestions
        : id === "memory" ? chat.context !== null
        : false;
      const seen = seenGroups.current[id];
      seenGroups.current[id] = exists;
      if (exists && !seen && hasLive[id] && !open[id] && savedFolds.current[id] !== false) {
        if (!next) next = { ...open };
        next[id] = true;
      }
    }
    if (next) setOpen(next);
  }, [runs, tasks, jobs, hasQuestions, chat.lineage, chat.context, open]);

  const toggle = (id: ContextSectionId) => {
    const next = { ...open, [id]: !open[id] };
    setOpen(next);
    save("context.folds", next);
  };
  const error = noteError ?? reviewError;

  const details = (
    <>
      {/* Where the project stands, in one row: the header above already names the chat and its project, so
          this card holds only what they do not — the branch, what it changed, and the way into review. */}
      {project ? (
        <div className="context-git">
          <IconBranch size={12} className="context-git-branch-icon" />
          <span className="context-git-branch" title={`On ${project.branch}`}>{project.branch}</span>
          {project.operation ? <span className="context-git-op">{OPERATION_LABEL[project.operation]}</span> : null}
          <span className="context-git-diff">
            {project.files > 0 ? <><span className="context-git-files">{project.files} {project.files === 1 ? "file" : "files"}</span><DiffBadge added={project.added} removed={project.removed} /></> : <span className="context-git-clean">clean</span>}
          </span>
          <button type="button" className="context-git-review" aria-label="Review changes" title="Review changes" onClick={() => onReview()}>
            <IconEdit size={13} />
          </button>
        </div>
      ) : null}

      {idle ? <p className="context-idle">No agents, jobs or comments.</p> : null}

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
            return <ContextRow key={task.id} icon={<IconAgents size={13} />} title={task.title || task.id} meta={`Agent · ${task.harnessId ?? "delegated"}`} harness={task.harnessId ?? null}
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

      {hasQuestions ? <ContextGroup id="questions" label={labels.questions} count={chat.pending.length} open={open.questions} attention="warn" onToggle={toggle}>
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
      </ContextGroup> : null}

      {/* Only a harness that reports a window has anything to say here. The figure lives in the card's own
          ring and second line: the rail keeps its own pie and puts the percentage in that button's accessible name. */}
      {chat.context ? <ContextGroup id="memory" label={labels.memory} open={open.memory} attention={chat.context.percent !== null && chat.context.percent >= 80 ? "warn" : false} onToggle={toggle}>
        <ContextList>
          <ContextRow className="context-usage-row" icon={<span className={`context-pie tone-${contextTone(chat.context.percent ?? 0)}`}><ContextPie percent={chat.context.percent ?? 0} size={24} /></span>} title="Context used" meta={`${tokenCount(chat.context.tokens)} of ${tokenCount(chat.context.window)} tokens`} actions={<ContextRowButton label="Open context and timings" onClick={onUsage}><IconChevronRight size={13} /></ContextRowButton>} />
        </ContextList>
      </ContextGroup> : null}
      {error ? <p className="context-error" role="alert">{error}</p> : null}
    </>
  );

  if (mode === "sheet") {
    return <Dialog title="Active chat context" onClose={onClose}>
      {details}
    </Dialog>;
  }
  // Opening the detail is an ask and closing it is the answer. `onOpen`/`onClose` still carry the sheet's
  // own state beside this one; the inline panel answers the panel glyph itself.
  const openDetail = () => { setToggling(true); setAsked(true); onOpen(); };
  const closeDetail = () => { setToggling(true); setAsked(false); onClose(); };
  return <aside
    className={`context-panel${detail ? " is-expanded" : " is-collapsed"}`}
    aria-label="Chat context"
    // The rail's width animates for a person's own fold only (the stylesheet listens for this attribute):
    // a session switch changes the width because the new chat has other rows, and sliding it re-lays-out
    // every label while the transcript beside it is already in its final place.
    data-toggling={toggling ? "" : undefined}
    onTransitionEnd={(e) => {
      if (e.target === e.currentTarget && e.propertyName === "flex-basis") setToggling(false);
    }}
  >
    <div className={`context-top${detail ? " is-expanded" : ""}`}>
      {detail ? <h2 className="context-eyebrow">Active work</h2> : null}
      {/* The sidebar's two silhouettes describe the panel's fold; the chevron names a row or a heading instead. */}
      <button className={detail ? "icon-btn" : "context-rail-button"} aria-label={detail ? "Collapse context panel" : "Expand context panel"} title={detail ? "Hide active work detail" : "Open active work detail"} onClick={() => (detail ? closeDetail() : openDetail())}>{detail ? <IconSidebar size={16} className="icon-flip-x" /> : <IconSidebar size={16} />}</button>
      {!detail ? <div className="context-rails">
        <button type="button" className="context-rail-button" title={hasQuestions || running > 0 ? "Jump to an ongoing run or pending answer" : "Expand active work"} aria-label="Open contextual work details" onClick={() => { if (hasQuestions) onQuestions(); else openDetail(); }}><IconAgents size={16} />{hasAttention > 0 ? <span className="context-rail-badge">{hasAttention > 9 ? "9+" : hasAttention}</span> : null}</button>
        <button type="button" className="context-rail-button" title="Project comparisons and races" aria-label="Inspect project races" onClick={() => { if (inWorkspace.length === 0) { onRace(null); return; } openDetail(); if (!open.races) toggle("races"); }}><IconSplit size={16} />{numberOfRaces > 0 ? <span className="context-rail-badge">{numberOfRaces > 9 ? "9+" : numberOfRaces}</span> : null}</button>
      </div> : null}
    </div>
    {detail ? <div className="context-scroller">{details}</div> : <div className="context-rail-foot">{chat.context && !composerVisible ? <button type="button" className="context-rail-usage" onClick={onUsage} title="Open context and model usage" aria-label={chat.context.percent === null ? "Open context and model usage" : `Context used: ${Math.round(chat.context.percent)}% of ${tokenCount(chat.context.window)}`}>
      <span className={`context-pie tone-${contextTone(chat.context.percent ?? 0)}`}><ContextPie percent={chat.context.percent ?? 0} size={28} /></span>
    </button> : null}</div>}
  </aside>;
}
