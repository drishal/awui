// One collapsible stack above the composer for the harness's own status line,
// queued messages, and todos (after Hermes Desktop's composer status stack).
// The status line is what the harness says it is doing when that is not plain
// thinking: Hermes's "Provider temporarily unavailable — retrying in 69s", so
// a long "Working" has a reason. Pi extensions' status lines are not shown:
// they are written for pi's terminal footer (ANSI colours, terse labels) and
// read as noise here. Hiding is per chat. Where the harness can take its queue
// back, a queued message can be edited or removed before it runs (T3 Code's);
// an edit whose message ran meanwhile goes to the composer instead of being lost.
// Under the queue, the chain: what the server runs after this run (a message,
// a handoff), each step removable, with Resume and Clear when it is paused.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ChainStep, QueueState, TodoItem } from "../../shared/protocol.js";
import { addToDraft } from "../draft-bus.js";
import { IconAgents, IconChevronDown, IconClock, IconEdit, IconQueue, IconSteer, IconSwap, IconWarning, IconX, Spinner } from "../icons.js";
import { jobLine, type JobProgress } from "../job-progress.js";
import { announceLanding, ranFromQueue, type Spot } from "../queue-glide.js";
import { load, save } from "../storage.js";
import { TodoTree } from "./TodoTree.js";
import { JobCard } from "./JobCard.js";
import { Collapse } from "./Collapse.js";
import type { ChatJob } from "../jobs.js";
import { DelegatedTasks } from "./DelegatedTasks.js";
import { tasksMeta } from "../delegated-tasks.js";
import type { DelegatedTaskView } from "../../shared/protocol.js";

function Group({
  title,
  meta,
  defaultOpen,
  children,
}: {
  title: string;
  meta?: string;
  defaultOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={`stack-group${open ? " is-open" : ""}`}>
      <button type="button" className="stack-group-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IconChevronDown size={12} className="stack-chevron" />
        <span>{title}</span>
        {meta ? <span className="stack-meta">{meta}</span> : null}
      </button>
      <Collapse open={open}>
        <div className="stack-group-body">{children}</div>
      </Collapse>
    </div>
  );
}

export function StatusStack({
  chatId,
  queue,
  todos,
  notice,
  onEditQueue,
  chain = [],
  chainPaused = null,
  harnessName = (id) => id,
  onChain,
  top,
  base,
  working = false,
  jobs = null,
  background = [],
  allJobs = [],
  tasks = [],
  onOpenTask,
  onCancelTask,
}: {
  chatId: string;
  /** The harness's own status line (`<harness>:status`), when it has one. */
  notice?: string | null;
  /** Put a changed queue in place of the harness's; given only where it can take its queue back. */
  onEditQueue?: (queue: QueueState) => Promise<boolean>;
  queue: QueueState;
  todos: TodoItem[];
  /** What runs after this run (the server's chain), and why it waits, if it does. */
  chain?: ChainStep[];
  chainPaused?: string | null;
  harnessName?: (id: string) => string;
  /** Put a changed chain in place; `resume` lets a paused one go on. */
  onChain?: (steps: ChainStep[], resume?: boolean) => Promise<boolean>;
  /** A row held above everything else in the stack (the direnv indicator); with nothing else to show it leads the base. */
  top?: React.ReactNode;
  /** Always shown under the rest, even when it is hidden (the git row). */
  base?: React.ReactNode;
  /** The chat is running now: an in-progress todo spins only then. */
  working?: boolean;
  /** Live delegated runs across the chat's tools (omp's TUI strip: "2 agents · 1 running, 1 done"). */
  jobs?: JobProgress | null;
  /** Background jobs to show now (jobs.ts shownJobs): running ones, and one that just ended. */
  background?: ChatJob[];
  /** Every job the chat knows, so a todo that names one can show its state. */
  allJobs?: ChatJob[];
  /** The tasks this chat delegated to other agents (snapshot.delegated, kept current by `task` events). */
  tasks?: DelegatedTaskView[];
  /** Open a task's child chat; Cancel stops it. Both absent where there is no room for a third chat. */
  onOpenTask?: (task: DelegatedTaskView) => void;
  onCancelTask?: (task: DelegatedTaskView) => void;
}) {
  const key = `stack.${chatId}`;
  const [hidden, setHidden] = useState(() => load<boolean>(key, false));
  useEffect(() => setHidden(load<boolean>(key, false)), [key]);
  const queued = [...queue.steering.map((t, i) => ({ t, k: "Steering", i })), ...queue.followUp.map((t, i) => ({ t, k: "Follow-up", i }))];
  const [editing, setEditing] = useState<{ k: string; i: number; original: string; draft: string } | null>(null);
  const [lost, setLost] = useState(false);
  // Where each queued row is, and which messages the user took out, so one that left because it ran
  // can glide from its row into the prompt it became (queue-glide.ts). Measured after every render:
  // the rows sit inside the stack card's Collapse, which mounts its content a frame after the queue
  // gains its first row, so a capture keyed on the texts alone would see an empty list and lose the spot.
  const queueList = useRef<HTMLUListElement>(null);
  const last = useRef<{ texts: string[]; spots: Map<string, Spot> }>({ texts: [], spots: new Map() });
  const taken = useRef(new Set<string>());
  useLayoutEffect(() => {
    const texts = queued.map((q) => q.t);
    const gone = ranFromQueue(last.current.texts, texts, taken.current);
    taken.current.clear();
    const rows = [...(queueList.current?.children ?? [])];
    const spots = new Map<string, Spot>();
    texts.forEach((t, i) => {
      const box = rows[i]?.getBoundingClientRect();
      if (box && !spots.has(t)) spots.set(t, { left: box.left, top: box.top });
    });
    // Announce after measuring, from the best spots at hand: a row's spot known now beats an older one.
    for (const text of gone) {
      const spot = spots.get(text) ?? last.current.spots.get(text);
      if (spot) announceLanding(text, spot);
    }
    last.current = { texts, spots: spots.size > 0 || texts.length === 0 ? spots : last.current.spots };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });
  /** The queue with this message changed (or, with null, removed), from the queue as it is now. */
  const change = async (k: string, i: number, original: string, next: string | null) => {
    const field = k === "Steering" ? "steering" : "followUp";
    taken.current.add(original);
    const list = queue[field];
    const at = list[i] === original ? i : list.indexOf(original);
    if (at < 0) {
      // It ran (or went) while being edited: the edit is not thrown away.
      if (next) addToDraft(next);
      setLost(Boolean(next));
      setEditing(null);
      return;
    }
    const replaced = next === null || !next.trim() ? list.filter((_, j) => j !== at) : list.map((t, j) => (j === at ? next : t));
    if (await (onEditQueue?.({ ...queue, [field]: replaced }) ?? Promise.resolve(false))) setEditing(null);
  };
  // The message being edited ran (or was removed elsewhere): the edit moves to the composer.
  useEffect(() => {
    if (!editing) return;
    const list = editing.k === "Steering" ? queue.steering : queue.followUp;
    if (list.includes(editing.original)) return;
    if (editing.draft.trim() && editing.draft !== editing.original) {
      addToDraft(editing.draft);
      setLost(true);
    }
    setEditing(null);
  }, [queue, editing]);
  const jobsById = useMemo(() => new Map(allJobs.map((j) => [j.id, j])), [allJobs]);
  const runningJobs = background.filter((j) => j.status === "running").length;
  // A chat with no room for its tasks' rows (a pane beside the main one) still counts them, so the
  // ridge does not hide what is running.
  const showTasks = tasks.length > 0 && onOpenTask !== undefined && onCancelTask !== undefined;
  const count = (background.length > 0 ? 1 : 0) + (jobs ? 1 : 0) + (notice ? 1 : 0) + queued.length + (todos.length > 0 ? 1 : 0) + (lost ? 1 : 0) + chain.length + (tasks.length > 0 ? 1 : 0);
  const empty = count === 0;
  // The card grows in when something first arrives and shrinks away when the last thing goes, showing what it
  // last held while it shrinks. One already there when the chat opens is simply there.
  const lastCard = useRef<React.ReactNode>(null);
  const [shownAtMount] = useState(!empty);
  const [entered, setEntered] = useState(!empty);
  const [lingering, setLingering] = useState(!empty);
  useEffect(() => {
    if (!empty) {
      setLingering(true);
      const frame = requestAnimationFrame(() => setEntered(true));
      return () => cancelAnimationFrame(frame);
    }
    setEntered(false);
    const t = window.setTimeout(() => setLingering(false), STACK_SHRINK_MS);
    return () => window.clearTimeout(t);
  }, [empty]);
  const done = todos.filter((t) => /done|complete/.test(t.status)).length;

  const card = empty ? null : (
    <>
      <button
        type="button"
        className="stack-ridge"
        aria-expanded={!hidden}
        aria-label={hidden ? "Show status" : "Hide status"}
        onClick={() => {
          setHidden(!hidden);
          save(key, !hidden);
        }}
      >
        <span className="ridge-bar" aria-hidden="true" />
        {hidden ? <span className="ridge-count">{count}</span> : null}
      </button>
      <Collapse open={!hidden}>
        {top ? <div className="stack-top">{top}</div> : null}
        <div className="stack-body">
          {jobs ? (
            <div className="stack-row stack-jobs" role="status" aria-live="polite" data-testid="job-progress">
              <span className="stack-icon">{jobs.mode === "background" ? <IconAgents size={13} /> : <Spinner size={12} />}</span>
              <span className="stack-text">{jobLine(jobs).label}</span>
              <span className="stack-meta">{jobLine(jobs).meta}</span>
            </div>
          ) : null}
          {background.length > 0 ? (
            <Group title="Background" meta={runningJobs > 0 ? `${runningJobs} running` : "finished"} defaultOpen>
              <div className="job-list" data-testid="background-jobs">
                {background.map((job) => (
                  <JobCard key={job.id} job={job} />
                ))}
              </div>
            </Group>
          ) : null}
          {notice ? (
            <div className="stack-row stack-notice" role="status" data-testid="harness-status">
              <span className="stack-icon">
                <IconClock size={13} />
              </span>
              <span className="stack-text">{notice}</span>
            </div>
          ) : null}
          {lost ? (
            <div className="stack-row stack-notice" role="status">
              <span className="stack-text">That message ran before the edit was saved; the edit is in the composer.</span>
              <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setLost(false)}>
                <IconX size={11} />
              </button>
            </div>
          ) : null}
          {queued.length > 0 ? (
            <ul ref={queueList} className="stack-queue" aria-label="Queued messages">
              {queued.map((q) => {
                const open = editing && editing.k === q.k && editing.i === q.i ? editing : null;
                return (
                  <li key={`${q.k}${q.i}`} className={`stack-row${open ? " is-editing" : ""}`} data-testid="queue-row">
                    <span className="stack-icon">{q.k === "Steering" ? <IconSteer size={13} /> : <IconQueue size={13} />}</span>
                    <span className="stack-kind">{q.k}</span>
                    {open ? (
                      <textarea
                        className="stack-edit"
                        aria-label={`Edit the queued ${q.k.toLowerCase()}`}
                        autoFocus
                        rows={Math.min(6, open.draft.split("\n").length)}
                        value={open.draft}
                        onChange={(e) => setEditing({ ...open, draft: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            e.preventDefault();
                            setEditing(null);
                          } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void change(q.k, q.i, open.original, open.draft);
                          }
                        }}
                      />
                    ) : (
                      <span className="stack-text">{q.t}</span>
                    )}
                    {onEditQueue && !open ? (
                      <span className="stack-actions">
                        <button type="button" className="icon-btn" aria-label={`Edit the queued ${q.k.toLowerCase()}`} onClick={() => setEditing({ k: q.k, i: q.i, original: q.t, draft: q.t })}>
                          <IconEdit size={12} />
                        </button>
                        <button type="button" className="icon-btn" aria-label={`Remove the queued ${q.k.toLowerCase()}`} onClick={() => void change(q.k, q.i, q.t, null)}>
                          <IconX size={12} />
                        </button>
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : null}
          {chain.length > 0 ? (
            <div className={`stack-chain${chainPaused ? " is-paused" : ""}`} data-testid="chain">
              {chainPaused ? (
                <div className="stack-row stack-paused" role="status">
                  <span className="stack-icon">
                    <IconWarning size={13} />
                  </span>
                  <span className="stack-text">Paused: {chainPaused}</span>
                  <span className="stack-actions is-shown">
                    <button type="button" className="btn btn-small" onClick={() => void onChain?.(chain, true)}>
                      Resume
                    </button>
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => void onChain?.([])}>
                      Clear
                    </button>
                  </span>
                </div>
              ) : null}
              <ol className="stack-queue" aria-label="Then">
                {chain.map((step, n) => (
                  <li key={step.id} className="stack-row chain-row" data-testid="chain-row">
                    <span className="stack-icon">{step.kind === "send" ? <IconQueue size={13} /> : <IconSwap size={13} />}</span>
                    <span className="stack-kind">{n === 0 ? "Then" : "and then"}</span>
                    <span className="stack-text">{step.kind === "send" ? step.text : `Hand off to ${harnessName(step.harness)}${step.prompt?.trim() ? `: ${step.prompt}` : ""}`}</span>
                    {onChain ? (
                      <span className="stack-actions">
                        <button type="button" className="icon-btn" aria-label={`Remove step ${n + 1} of the chain`} onClick={() => void onChain(chain.filter((s) => s.id !== step.id))}>
                          <IconX size={12} />
                        </button>
                      </span>
                    ) : null}
                  </li>
                ))}
              </ol>
            </div>
          ) : null}
          {showTasks ? (
            <Group title="Delegated" meta={tasksMeta(tasks) ?? undefined} defaultOpen>
              <DelegatedTasks tasks={tasks} harnessName={harnessName} onOpen={onOpenTask} onCancel={onCancelTask} />
            </Group>
          ) : null}
          {todos.length > 0 ? (
            <Group title="Todos" meta={`${done}/${todos.length}`} defaultOpen>
              <TodoTree todos={todos} working={working} jobs={jobsById} />
            </Group>
          ) : null}
        </div>
      </Collapse>
    </>
  );
  if (card) lastCard.current = card;
  if (empty && !lingering && !base && !top) return null;

  return (
    <div className={`status-stack${empty ? " is-base-only" : ""}${hidden ? " is-hidden" : ""}`} data-testid={empty ? undefined : "status-stack"}>
      {!empty || lingering ? (
        <Collapse open={!empty && (shownAtMount || entered)}>
          <div className="stack-card">{card ?? lastCard.current}</div>
        </Collapse>
      ) : base || top ? (
        /* The git row alone (base-only): the ridge hides it too. */
        <button
          type="button"
          className="stack-ridge"
          aria-expanded={!hidden}
          aria-label={hidden ? "Show status" : "Hide status"}
          onClick={() => {
            setHidden(!hidden);
            save(key, !hidden);
          }}
        >
          <span className="ridge-bar" aria-hidden="true" />
        </button>
      ) : null}
      {/* The git row folds with the rest on the ridge. */}
      {base || (empty && top) ? (
        <Collapse open={!hidden}>
          {empty ? top : null}
          {base}
        </Collapse>
      ) : null}
    </div>
  );
}

/** How long the stack's card takes to shrink away (Collapse's grow), before it leaves the page. */
const STACK_SHRINK_MS = 320;
