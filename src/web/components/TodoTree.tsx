// The status stack's todo list as a tree (omp's TUI shape): each phase a row
// with a ring of its progress, its numeral, its name, and done/total, its tasks
// hanging under it on a drawn branch. A finished phase folds itself away, and a
// click opens or shuts any phase. A list without phases is one flat branch. A
// task that names a background job ("running as bg_19") shows that job's state.
import { useMemo, useRef, useState } from "react";
import type { BackgroundJob, TodoItem } from "../../shared/protocol.js";
import { IconCheck, IconChevronDown, IconCircle, IconClock, IconX, Spinner } from "../icons.js";
import { jobIdsIn, todoTree, type TodoPhase } from "../todo-tree.js";
import { Collapse } from "./Collapse.js";

/**
 * A todo's mark. One the agent marked as in progress spins only while the chat is working: a run that
 * was stopped, or a session reopened later, leaves its last list behind, and a spinner there reads as
 * work going on when nothing is.
 */
function TodoIcon({ status, working }: { status: string; working: boolean }) {
  const done = /done|complete/.test(status);
  // The check draws only when this row changes to done while it is on screen (not when a list first appears), and keeps its class
  // after, so a later re-render does not cut the drawing short.
  const was = useRef(status);
  const drew = useRef(false);
  if (!done) drew.current = false;
  else if (was.current !== status && !/done|complete/.test(was.current)) drew.current = true;
  was.current = status;
  if (done) return <IconCheck size={13} draw={drew.current} />;
  if (/progress|active|doing/.test(status)) {
    return working ? (
      <Spinner size={12} />
    ) : (
      <span className="todo-stalled" role="img" aria-label="Started, not running now" title="Started, not running now">
        <IconClock size={13} />
      </span>
    );
  }
  return <IconCircle size={13} />;
}

/** A phase's progress as a small ring: the done share drawn round, full and green when it is finished. */
function PhaseRing({ done, total }: { done: number; total: number }) {
  const r = 5.5;
  const length = 2 * Math.PI * r;
  const share = total > 0 ? done / total : 0;
  return (
    <svg className={`todo-ring${share >= 1 ? " is-full" : ""}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <circle className="todo-ring-track" cx="7" cy="7" r={r} />
      <circle className="todo-ring-fill" cx="7" cy="7" r={r} strokeDasharray={`${share * length} ${length}`} transform="rotate(-90 7 7)" />
    </svg>
  );
}

function JobChip({ job }: { job: BackgroundJob }) {
  const word = job.status === "running" ? "running" : job.status === "done" ? "done" : job.status;
  return (
    <span className={`todo-job is-${job.status}`} title={`${job.id}: ${job.title ?? job.label}`}>
      {job.status === "running" ? <Spinner size={10} /> : job.status === "done" ? <IconCheck size={10} /> : <IconX size={10} />}
      {job.id} · {word}
    </span>
  );
}

function TodoRows({ items, working, jobs }: { items: TodoItem[]; working: boolean; jobs: ReadonlyMap<string, BackgroundJob> }) {
  const known = useMemo(() => new Set(jobs.keys()), [jobs]);
  return (
    <>
      {items.map((todo, i) => (
        <li key={`${i}:${todo.text}`} className={`stack-row todo-row todo-${todo.status.replace(/[^a-z_]/gi, "")}`}>
          <span className="stack-icon">
            <TodoIcon status={todo.status} working={working} />
          </span>
          <span className="stack-text">{todo.text}</span>
          {jobIdsIn(todo.text, known).map((id) => {
            const job = jobs.get(id);
            return job ? <JobChip key={id} job={job} /> : null;
          })}
        </li>
      ))}
    </>
  );
}

/** `lone`: the list's only phase, whose count would repeat the Todos header's. */
function Phase({ phase, working, jobs, lone }: { phase: TodoPhase; working: boolean; jobs: ReadonlyMap<string, BackgroundJob>; lone: boolean }) {
  const total = phase.items.length;
  const finished = phase.done === total;
  // Untouched, a phase follows its work: open while any of it is left, folded once it is all done.
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? !finished;
  return (
    <li className={`todo-phase${finished ? " is-done" : ""}${phase.active ? " is-active" : ""}`}>
      <button type="button" className="todo-phase-head" aria-expanded={open} onClick={() => setChosen(!open)}>
        <PhaseRing done={phase.done} total={total} />
        {phase.numeral ? <span className="todo-phase-numeral">{phase.numeral}</span> : null}
        <span className="todo-phase-name">{phase.name ?? "Other"}</span>
        {lone ? null : (
          <span className="todo-phase-count">
            {phase.done}/{total}
          </span>
        )}
        <IconChevronDown size={12} className="todo-phase-chevron" />
      </button>
      <Collapse open={open}>
        <ul className="todo-branch">
          <TodoRows items={phase.items} working={working} jobs={jobs} />
        </ul>
      </Collapse>
    </li>
  );
}

const NO_JOBS: ReadonlyMap<string, BackgroundJob> = new Map();

export function TodoTree({ todos, working, jobs = NO_JOBS }: { todos: TodoItem[]; working: boolean; jobs?: ReadonlyMap<string, BackgroundJob> }) {
  const tree = useMemo(() => todoTree(todos), [todos]);
  const only = tree[0];
  if (tree.length === 1 && only && only.name === null) {
    return (
      <ul className="stack-list">
        <TodoRows items={only.items} working={working} jobs={jobs} />
      </ul>
    );
  }
  return (
    <ol className="todo-tree" aria-label="Todo phases">
      {tree.map((phase, i) => (
        <Phase key={`${i}:${phase.name ?? ""}`} phase={phase} working={working} jobs={jobs} lone={tree.length === 1} />
      ))}
    </ol>
  );
}

