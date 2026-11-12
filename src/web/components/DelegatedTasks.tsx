// The parent chat's delegated tasks, one row each, in the notice stack above the composer:
// a chip for how the task stands, its title, the agent that runs it (harness · model · role),
// how long it has run, the child's last line, and the two things a user wants from here —
// **Open** (the child chat, beside this one) and **Cancel** (stop the whole subtree). Fed by the
// chat's snapshot and its `task` events (chat-state.ts), so nothing here polls.
import { useState } from "react";
import type { DelegatedTaskView } from "../../shared/protocol.js";
import { metaText, stateClass, stateWords, taskElapsed, taskLine, tasksMeta } from "../delegated-tasks.js";
import { useNow } from "../hooks.js";
import { IconChevronDown } from "../icons.js";
import { ago } from "../turns.js";
import { ConfirmButton } from "./ConfirmButton.js";

/** Rows the panel draws before it counts the rest. */
const MAX_ROWS = 8;

function Row({
  task,
  now,
  harnessName,
  onOpen,
  onCancel,
}: {
  task: DelegatedTaskView;
  now: number;
  harnessName: (id: string) => string;
  onOpen: (task: DelegatedTaskView) => void;
  onCancel: (task: DelegatedTaskView) => void;
}) {
  const [open, setOpen] = useState(false);
  const line = taskLine(task);
  const who = metaText(task, harnessName);
  const finished = task.state === "result_available";
  return (
    <li className={`task-row is-${task.state}`} data-testid="task-row">
      <button type="button" className="task-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <IconChevronDown size={12} className="task-chevron" />
        <span className={`task-state is-${stateClass(task)}`}>{stateWords(task)}</span>
        <span className="task-title">{task.title}</span>
        <span className="task-meta">{who}</span>
        <span className="task-clock" title={finished ? "How long it took" : `Started ${ago(task.createdAt, now)}`}>
          {taskElapsed(task, now)}
        </span>
      </button>
      <div className="task-actions">
        <button type="button" className="btn btn-small task-open" disabled={task.childChatId === null} onClick={() => onOpen(task)}>
          Open
        </button>
        <ConfirmButton label={`Cancel ${task.title}`} confirmLabel="Stop it?" className="ghost-icon" iconOnly danger disabled={finished} onConfirm={() => onCancel(task)}>
          <span aria-hidden="true">✕</span>
        </ConfirmButton>
      </div>
      {open && line ? (
        <p className="task-line" data-testid="task-line">
          {line}
        </p>
      ) : null}
    </li>
  );
}

export function DelegatedTasks({
  tasks,
  harnessName = (id) => id,
  onOpen,
  onCancel,
}: {
  tasks: DelegatedTaskView[];
  harnessName?: (id: string) => string;
  onOpen: (task: DelegatedTaskView) => void;
  onCancel: (task: DelegatedTaskView) => void;
}) {
  // A running task's clock ticks while it runs; a finished list does not re-render.
  const live = tasks.some((task) => task.state !== "result_available");
  const now = useNow(live, 1000);
  // The newest few rows are what a panel shows; the rest are in the status tool's answer.
  const shown = tasks.slice(0, MAX_ROWS);
  return (
    <ul className="tasks" aria-label="Delegated tasks">
      {shown.map((task) => (
        <Row key={task.id} task={task} now={now} harnessName={harnessName} onOpen={onOpen} onCancel={onCancel} />
      ))}
      {tasks.length > shown.length ? <li className="task-more muted">{tasks.length - shown.length} more, in the parent's tool calls</li> : null}
    </ul>
  );
}
