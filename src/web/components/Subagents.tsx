// A delegation call's subagents: one row per run with its status, agent
// type, brief, and live counts; opened, its brief, what it is doing, and its
// answer; and its own transcript in a side panel, read from the file its
// harness wrote (refreshed while it runs).
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ChatItem, SubagentRun, SubagentsInfo, ToolItem } from "../../shared/protocol.js";
import { api } from "../api.js";
import { IconAgents, IconCheck, IconChevronDown, IconX, Spinner } from "../icons.js";
import { formatDuration } from "../turns.js";
import { Markdown } from "./Markdown.js";
import { Dot, dotted } from "./Dot.js";

/** The chat whose transcript is on screen, for fetching a run's own transcript. */
export const ChatIdContext = createContext<string | null>(null);

const REFRESH_MS = 2_000;

/** omp names a run (CrookedThrush). A launch index or a session id is not a name. */
const namedRun = (id: string) => !/^\d+$/.test(id) && !/^[0-9a-f-]{36}$/i.test(id);

const firstLine = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/^#+\s*/, "").trim())
    .find((l) => l && !/^(complete assignment thoroughly:?|target)$/i.test(l)) ?? "";

const tokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}k` : String(n));

function meta(run: SubagentRun): string[] {
  const out: string[] = [];
  if (run.toolCount) out.push(`${run.toolCount} tool${run.toolCount === 1 ? "" : "s"}`);
  if (run.tokens) out.push(`${tokens(run.tokens)} tok`);
  if (run.durationMs) out.push(formatDuration(run.durationMs));
  if (run.cost) out.push(`$${run.cost < 0.01 ? run.cost.toFixed(4) : run.cost.toFixed(2)}`);
  return out;
}

const LABEL: Record<SubagentRun["status"], string> = { pending: "Queued", running: "Running", done: "Done", failed: "Failed", stopped: "Stopped" };

export function RunStatus({ status, size = 13 }: { status: SubagentRun["status"]; size?: number }) {
  return (
    <span className={`run-status is-${status}`} title={LABEL[status]} aria-label={LABEL[status]}>
      {status === "running" ? <Spinner size={size - 1} /> : status === "done" ? <IconCheck size={size} /> : status === "pending" ? <span className="run-dot" /> : <IconX size={size} />}
    </span>
  );
}

/** "3 agents · 1 running, 2 done" for the tool row's line. */
export function runsSummary(info: SubagentsInfo): React.ReactNode {
  const counts = new Map<SubagentRun["status"], number>();
  for (const r of info.runs) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const states = (["running", "pending", "done", "failed", "stopped"] as const)
    .filter((s) => counts.get(s))
    .map((s) => `${counts.get(s)} ${LABEL[s].toLowerCase()}`)
    .join(", ");
  if (info.runs.length === 1) {
    const run = info.runs[0] as SubagentRun;
    return dotted([run.agent, firstLine(run.task) || LABEL[run.status]]);
  }
  return dotted([`${info.runs.length} agents`, states]);
}

function RunRow({ run, onOpen }: { run: SubagentRun; onOpen: () => void }) {
  const [open, setOpen] = useState(false);
  const facts = meta(run);
  return (
    <li className={`run is-${run.status}${open ? " is-open" : ""}`}>
      <button type="button" className="run-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <RunStatus status={run.status} />
        {namedRun(run.id) ? <span className="run-name">{run.id}</span> : null}
        <span className="run-agent">{run.agent}</span>
        <span className="run-task">{firstLine(run.task)}</span>
        {facts.length > 0 ? <span className="run-meta">{dotted(facts)}</span> : null}
        <IconChevronDown size={13} className="run-chevron" />
      </button>
      {run.status === "running" && run.activity?.length ? (
        <div className="run-activity" aria-live="polite">
          <span className="run-activity-dot" />
          <code>{run.activity[run.activity.length - 1]}</code>
        </div>
      ) : null}
      {open ? (
        <div className="run-body">
          {run.task ? (
            <section>
              <h4>Brief</h4>
              <div className="run-brief">
                <Markdown text={run.task} />
              </div>
            </section>
          ) : null}
          {run.activity?.length && run.status === "running" ? (
            <section>
              <h4>Doing now</h4>
              <ul className="run-steps">
                {run.activity.map((a, i) => (
                  <li key={`${i}:${a}`}>
                    <code>{a}</code>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          {run.error ? <p className="run-error">{run.error}</p> : null}
          {run.output ? (
            <section>
              <h4>Answer</h4>
              <div className="run-output">
                {/^\s*[[{]/.test(run.output) ? <pre>{run.output}</pre> : <Markdown text={run.output} />}
              </div>
            </section>
          ) : null}
          <div className="run-actions">
            {run.model ? <span className="run-model">{run.model}</span> : null}
            {run.transcript ? (
              <button type="button" className="btn btn-small" onClick={onOpen}>
                Open transcript
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </li>
  );
}

export function AgentsCard({ item, renderItem }: { item: ToolItem; renderItem: (item: ChatItem) => React.ReactNode }) {
  const [viewing, setViewing] = useState<string | null>(null);
  const info = item.subagents as SubagentsInfo;
  const done = info.runs.filter((r) => r.status === "done").length;
  const mode = info.mode === "chain" ? "Chain" : info.mode === "parallel" || info.runs.length > 1 ? "Parallel" : "Single";
  const viewed = info.runs.find((r) => r.id === viewing) ?? null;
  return (
    <div className="tool-card is-agent">
      <div className="tool-card-head">
        <span className="tool-card-icon">
          <IconAgents size={13} />
        </span>
        <span className="tool-card-title">
          <span className="tool-card-prose">
            {mode}
            <Dot />
            {info.runs.length} agent{info.runs.length === 1 ? "" : "s"}
          </span>
          {info.background ? <span className="tool-chip is-quiet">background</span> : null}
        </span>
        <span className="tool-card-meta">
          {done}/{info.runs.length} done
        </span>
      </div>
      <ol className={`runs${info.mode === "chain" ? " is-chain" : ""}`}>
        {info.runs.map((run) => (
          <RunRow key={run.id} run={run} onOpen={() => setViewing(run.id)} />
        ))}
      </ol>
      {viewed ? <TranscriptPanel toolId={item.id} run={viewed} renderItem={renderItem} onClose={() => setViewing(null)} /> : null}
    </div>
  );
}

function TranscriptPanel({ toolId, run, renderItem, onClose }: { toolId: string; run: SubagentRun; renderItem: (item: ChatItem) => React.ReactNode; onClose: () => void }) {
  const chatId = useContext(ChatIdContext);
  const [items, setItems] = useState<ChatItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const live = run.status === "running" || run.status === "pending";

  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);

  useEffect(() => {
    if (!chatId) return;
    let stopped = false;
    let timer: number | undefined;
    const load = async () => {
      try {
        const res = await api<{ items: ChatItem[] }>(`/api/chats/${encodeURIComponent(chatId)}/tools/${encodeURIComponent(toolId)}/agents/${encodeURIComponent(run.id)}`);
        if (!stopped) {
          setItems(res.items);
          setError(null);
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      }
      if (!stopped && live) timer = window.setTimeout(() => void load(), REFRESH_MS);
    };
    void load();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [chatId, toolId, run.id, live]);

  const close = () => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return onClose();
    setClosing(true);
    window.setTimeout(onClose, 180);
  };

  const facts = meta(run);
  // At the document root: inside the tool card it would take on the card's type and row styles.
  return createPortal(
    <dialog
      ref={dialog}
      className={`run-panel${closing ? " is-closing" : ""}`}
      aria-label={`Transcript of ${run.id}`}
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="run-panel-sheet">
        <header className="run-panel-head">
          <RunStatus status={run.status} size={15} />
          <div className="run-panel-title">
            <strong>{namedRun(run.id) ? run.id : run.agent}</strong>
            <span>
              {dotted([namedRun(run.id) && run.agent !== run.id ? run.agent : null, run.model, ...facts])}
            </span>
          </div>
          <button type="button" className="icon-btn" aria-label="Close" onClick={close}>
            <IconX size={15} />
          </button>
        </header>
        <div className="run-panel-body">
          {items === null && !error ? <p className="muted">Loading the transcript…</p> : null}
          {error ? <p className="run-error">{error}</p> : null}
          {items && items.length === 0 ? <p className="muted">{live ? "Nothing recorded yet." : "This run left no transcript."}</p> : null}
          {items?.map((it) =>
            it.kind === "user" ? (
              <div key={it.id} className="run-panel-brief">
                <h4>Brief</h4>
                <Markdown text={it.text} />
              </div>
            ) : it.kind === "assistant" && it.text ? (
              <div key={it.id} className="run-panel-text">
                {it.thinking ? renderItem({ ...it, text: "" }) : null}
                <Markdown text={it.text} />
              </div>
            ) : (
              <div key={it.id}>{renderItem(it)}</div>
            ),
          )}
          {live && items ? (
            <p className="run-panel-live">
              <Spinner size={12} /> Still running — refreshing
            </p>
          ) : null}
        </div>
      </div>
    </dialog>,
    document.body,
  );
}
