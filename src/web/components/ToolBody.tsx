// What an opened tool row shows, by kind: an edit or write as its diff
// (green additions, red removals, the changed words marked), a command as a
// terminal, a read under its file, a search under its pattern, a fetch under
// its URL, and anything else as its arguments' key-value rows. Each sits in
// one card with a header naming what it touched.
import { createContext, Fragment, useContext, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import type { DiffLine, ToolDiff, ToolItem } from "../../shared/protocol.js";
import type { LineOrigin } from "../../shared/review.js";
import { IconCheck, IconCircle, IconDot, IconFile, IconGlobe, IconSearch, IconTerminal, IconX } from "../icons.js";
import { parseJsonContainer } from "../json-tree.js";
import { relativePath } from "../turns.js";
import { toolFacts } from "../tool-facts.js";
import { FileLink } from "./FileLink.js";
import { JsonTree } from "./JsonTree.js";

type Args = Record<string, unknown>;

/** The arguments the server stored, when they are a JSON object. */
function parseArgs(args: string): Args | null {
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Args) : null;
  } catch {
    return null;
  }
}

const str = (args: Args | null, keys: string[]): string | null => {
  for (const key of keys) {
    const v = args?.[key];
    if (typeof v === "string" && v.trim()) return v;
  }
  return null;
};

function display(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? "";
  } catch {
    return String(value);
  }
}

/** Whether any argument is an object or array: those read better as a tree than as a block of JSON text. */
const hasNested = (args: Args): boolean => Object.values(args).some((v) => v !== null && typeof v === "object");

/** Arguments as key-value rows; long or multi-line values get a block of their own. */
function ArgRows({ args, skip = [] }: { args: Args; skip?: string[] }) {
  const rows = Object.entries(args).filter(([key, v]) => !skip.includes(key) && v !== undefined && v !== null && v !== "");
  if (rows.length === 0) return null;
  return (
    <dl className="io-kv">
      {rows.map(([key, value]) => {
        const text = display(value);
        const block = text.includes("\n") || text.length > 120;
        return (
          <div className={`io-kv-row${block ? " is-block" : ""}`} key={key}>
            <dt className="io-kv-key">{key}</dt>
            <dd className="io-kv-value">{block ? <pre className="io-kv-pre">{text}</pre> : text}</dd>
          </div>
        );
      })}
    </dl>
  );
}

/** Lines past this many start folded behind "Show all". */
const FOLDED_LINES = 400;

/** The changed middle of a removed/added pair, when the rest of the line stayed. */
function changedSpan(a: string, b: string): [number, number, number] | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head += 1;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail += 1;
  // Only worth marking when most of the line is shared.
  if (head + tail < Math.max(a.length, b.length) * 0.35) return null;
  return [head, a.length - tail, b.length - tail];
}

/** Per line: the [start, end) of the words that changed, for lines paired across a removal and an addition. */
function wordMarks(lines: DiffLine[]): Map<number, [number, number]> {
  const marks = new Map<number, [number, number]>();
  let i = 0;
  while (i < lines.length) {
    if (lines[i]?.kind !== "del") {
      i += 1;
      continue;
    }
    const delStart = i;
    while (lines[i]?.kind === "del") i += 1;
    const addStart = i;
    while (lines[i]?.kind === "add") i += 1;
    const pairs = Math.min(addStart - delStart, i - addStart);
    for (let k = 0; k < pairs; k += 1) {
      const a = lines[delStart + k] as DiffLine;
      const b = lines[addStart + k] as DiffLine;
      const span = changedSpan(a.text, b.text);
      if (!span) continue;
      if (span[1] > span[0]) marks.set(delStart + k, [span[0], span[1]]);
      if (span[2] > span[0]) marks.set(addStart + k, [span[0], span[2]]);
    }
  }
  return marks;
}

function lineText(text: string, mark: [number, number] | undefined): ReactNode {
  if (!text) return " ";
  if (!mark) return text;
  return (
    <>
      {text.slice(0, mark[0])}
      <mark className="diff-word">{text.slice(mark[0], mark[1])}</mark>
      {text.slice(mark[1])}
    </>
  );
}

const SIGN: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: " ", hunk: "", gap: "" };

/** What a gutter mark says, in words: the agent wrote this line, or someone changed it since. */
const ORIGIN_TITLE: Record<LineOrigin, string> = {
  agent: "Written by the agent in this chat, and still the same line",
  changed: "The agent wrote this line, and it has been changed since (outside this chat's edits)",
};

export function DiffView({
  diff,
  expanded = false,
  onLine,
  notes,
  origins,
}: {
  diff: ToolDiff;
  /** Every line at once, without the "Show all" fold. */
  expanded?: boolean;
  /** Lines are buttons: the review panel's "comment on this line". */
  onLine?: (index: number, line: DiffLine) => void;
  /** Shown under a line, by its index. */
  notes?: ReadonlyMap<number, ReactNode>;
  /** Where each line came from, by its index (the review panel's attribution): adds a gutter mark. */
  origins?: ReadonlyMap<number, LineOrigin>;
}) {
  const [all, setAll] = useState(expanded);
  const marks = useMemo(() => wordMarks(diff.lines), [diff.lines]);
  const numbered = diff.lines.some((l) => l.line !== undefined);
  // Every row is its own grid, so the number column takes one width from the widest number: otherwise line 9's
  // code started a digit left of line 11's.
  const digits = useMemo(() => Math.max(2, ...diff.lines.map((l) => String(l.line ?? "").length)), [diff.lines]);
  const shown = all ? diff.lines : diff.lines.slice(0, FOLDED_LINES);
  return (
    <div
      className={`diff${numbered ? " is-numbered" : ""}${onLine ? " is-commentable" : ""}${origins ? " is-attributed" : ""}`}
      role="table"
      aria-label="Changes"
      style={numbered ? ({ "--diff-digits": digits } as CSSProperties) : undefined}
    >
      {shown.map((l, i) =>
        l.kind === "gap" ? (
          <div className="diff-gap" role="row" key={i}>
            <span>{l.text || "⋯"}</span>
          </div>
        ) : l.kind === "hunk" ? (
          <div className="diff-hunk" role="row" key={i}>
            {l.text}
          </div>
        ) : (
          <Fragment key={i}>
            <div
              className={`diff-line is-${l.kind}${notes?.has(i) ? " has-note" : ""}`}
              role="row"
              {...(onLine
                ? {
                    tabIndex: 0,
                    title: "Comment on this line",
                    onClick: () => onLine(i, l),
                    onKeyDown: (e: React.KeyboardEvent) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onLine(i, l);
                      }
                    },
                  }
                : {})}
            >
              {origins ? <span className={`diff-origin is-${origins.get(i) ?? "none"}`} role="img" aria-label={origins.has(i) ? ORIGIN_TITLE[origins.get(i) as LineOrigin] : undefined} title={origins.has(i) ? ORIGIN_TITLE[origins.get(i) as LineOrigin] : undefined} /> : null}
              {numbered ? <span className="diff-no">{l.line ?? ""}</span> : null}
              <span className="diff-sign" aria-label={l.kind === "add" ? "added" : l.kind === "del" ? "removed" : undefined}>
                {SIGN[l.kind]}
              </span>
              <span className="diff-text">{lineText(l.text, marks.get(i))}</span>
            </div>
            {notes?.get(i) ?? null}
          </Fragment>
        ),
      )}
      {!all && diff.lines.length > FOLDED_LINES ? (
        <button type="button" className="diff-more" onClick={() => setAll(true)}>
          Show all {diff.lines.length} lines
        </button>
      ) : null}
    </div>
  );
}

export function DiffBadge({ added, removed }: { added: number; removed: number }) {
  if (added === 0 && removed === 0) return null;
  return (
    <span className="diff-stat" aria-label={`${added} additions, ${removed} deletions`}>
      {added > 0 ? <span className="diff-added">+{added}</span> : null}
      {added > 0 && removed > 0 ? " " : null}
      {removed > 0 ? <span className="diff-removed">−{removed}</span> : null}
    </span>
  );
}

/** Inside a tool card's row the row already names the call: a head that only repeats it is left out (ToolBody's `bare`). */
const BareContext = createContext(false);

/**
 * `repeats` says what of the head the row already shows: "all" (it says nothing new), "meta" (the diff count;
 * the file link stays), or "icon" (only the icon; the link and the line range stay). Bare, what is left is a
 * one-line caption, so the file still opens (and previews) from the body.
 */
function CardHead({ icon, children, meta, repeats }: { icon: ReactNode; children: ReactNode; meta?: ReactNode; repeats?: "all" | "meta" | "icon" }) {
  const bare = useContext(BareContext);
  if (bare && repeats === "all") return null;
  if (bare && repeats) {
    return (
      <div className="tool-card-caption">
        {children}
        {repeats === "icon" && meta ? <span className="tool-card-meta">{meta}</span> : null}
      </div>
    );
  }
  return (
    <div className="tool-card-head">
      <span className="tool-card-icon">{icon}</span>
      <span className="tool-card-title">{children}</span>
      {meta ? <span className="tool-card-meta">{meta}</span> : null}
    </div>
  );
}

function Output({ item, label = "Output", json = false }: { item: ToolItem; label?: string | null; json?: boolean }) {
  const failed = item.status === "error";
  const text = item.output || (item.status === "running" ? "" : "(no output)");
  const failedTest = toolFacts(item).failed === true && item.category === "command";
  const outputLines = failedTest ? text.split("\n") : [];
  if (!text && item.status === "running") {
    return (
      <div className="io-section">
        {label ? <span className="io-label">{label}</span> : null}
        <span className="io-pending" aria-label="Running">
          <span />
          <span />
          <span />
        </span>
      </div>
    );
  }
  // An output that is JSON (an MCP tool's result most of all) is a tree; Copy gives the raw text.
  const tree = json && !failed && !item.truncated ? parseJsonContainer(text) : null;
  if (tree) {
    return (
      <div className="io-section">
        {label ? <span className="io-label">{label}</span> : null}
        <JsonTree value={tree} raw={text} label="Output as JSON" />
      </div>
    );
  }
  return (
    <div className="io-section">
      {label ? <span className="io-label">{label}{item.truncated ? " (truncated)" : ""}</span> : null}
      <pre className={`io-text${failed ? " is-error" : ""}`}>{failedTest ? outputLines.map((line, i) => <span key={i} className={/^\s*(?:FAIL\b|×\s)/.test(line) ? "is-test-failure" : undefined}>{line}{i < outputLines.length - 1 ? "\n" : ""}</span>) : text}</pre>
    </div>
  );
}

/** Lines `offset`/`limit` (or start/end) name in a read, as "lines 10–60". */
function lineRange(args: Args | null): string | null {
  const n = (k: string) => (typeof args?.[k] === "number" ? (args[k] as number) : null);
  const start = n("offset") ?? n("start_line") ?? n("line") ?? n("start");
  const limit = n("limit");
  const end = n("end_line") ?? n("end") ?? (start !== null && limit !== null ? start + limit - 1 : null);
  if (start !== null && end !== null) return `lines ${start}–${end}`;
  if (start !== null) return `from line ${start}`;
  if (limit !== null) return `first ${limit} lines`;
  return null;
}

interface TodoEntry {
  text: string;
  status: "done" | "active" | "pending" | "cancelled";
  phase?: string;
}

const todoStatus = (raw: unknown): TodoEntry["status"] => {
  const s = String(raw ?? "");
  return /done|complete/.test(s) ? "done" : /progress|active|doing/.test(s) ? "active" : /cancel|abandon|skip/.test(s) ? "cancelled" : "pending";
};

/**
 * A todo call as a checklist: Claude Code's and Hermes's whole list, or what
 * omp's and Pi's operations planned and ticked off. Null when the arguments
 * are not a todo call.
 */
function todoEntries(args: Args | null): TodoEntry[] | null {
  if (!args) return null;
  const obj = (v: unknown): v is Args => typeof v === "object" && v !== null && !Array.isArray(v);
  if (Array.isArray(args.todos)) {
    return args.todos.filter(obj).map((t) => ({ text: String(t.content ?? t.text ?? t.title ?? ""), status: todoStatus(t.status) }));
  }
  // Pi lets a model leave `op` out of a `list` or `items` call.
  const single = typeof args.op === "string" || Array.isArray(args.list) || Array.isArray(args.items);
  const ops = Array.isArray(args.ops) ? args.ops.filter(obj) : single ? [args] : null;
  if (!ops) return null;
  const out: TodoEntry[] = [];
  const planned = (items: unknown, phase: unknown) => {
    for (const task of Array.isArray(items) ? items : []) {
      out.push({ text: String(task), status: "pending", ...(typeof phase === "string" ? { phase } : {}) });
    }
  };
  for (const op of ops) {
    const kind = String(op.op ?? "");
    if (Array.isArray(op.list)) {
      for (const phase of op.list.filter(obj)) planned(phase.items, phase.phase);
    } else if (Array.isArray(op.items)) {
      planned(op.items, op.phase);
    } else if (typeof op.task === "string" || typeof op.text === "string") {
      const status: TodoEntry["status"] = /done|complete/.test(kind) ? "done" : /start|progress/.test(kind) ? "active" : /drop|remove|cancel/.test(kind) ? "cancelled" : "pending";
      out.push({ text: String(op.task ?? op.text), status });
    }
  }
  return out.length > 0 ? out : null;
}

const TODO_ICON: Record<TodoEntry["status"], ReactNode> = {
  done: <IconCheck size={13} />,
  active: <IconDot size={13} />,
  pending: <IconCircle size={13} />,
  cancelled: <IconX size={13} />,
};

function TodoList({ entries }: { entries: TodoEntry[] }) {
  return (
    <ul className="todo-card">
      {entries.map((t, i) => (
        <li key={`${i}:${t.text}`} className={`todo-card-row is-${t.status}`}>
          {t.phase && t.phase !== entries[i - 1]?.phase ? <span className="todo-card-phase">{t.phase}</span> : null}
          <span className="todo-card-icon">{TODO_ICON[t.status]}</span>
          <span className="todo-card-text">{t.text}</span>
        </li>
      ))}
    </ul>
  );
}

/** A call's body: its diff, terminal, file, or input and output. `bare` (inside a card's row) leaves out heads that repeat the row. */
export function ToolBody({ item, workspace, bare = false }: { item: ToolItem; workspace: string; bare?: boolean }) {
  return (
    <BareContext.Provider value={bare}>
      <CallBody item={item} workspace={workspace} />
    </BareContext.Provider>
  );
}

function CallBody({ item, workspace }: { item: ToolItem; workspace: string }) {
  const args = useMemo(() => parseArgs(item.args), [item.args]);
  const failed = item.status === "error";
  const path = item.paths[0] ? relativePath(item.paths[0], workspace) : null;
  // `names`: the body spells out what the row's sentence names (the whole command, the file, the address), so an
  // opened row leaves it out of its sentence (tool-card.css) and the call reads once, as one tile.
  const card = (head: ReactNode, body: ReactNode, names = false) => (
    <div className={`tool-card is-${item.category}${failed ? " is-failed" : ""}${names ? " names-target" : ""}`}>
      {head}
      {body}
    </div>
  );

  if ((item.category === "edit" || item.category === "write") && item.diff) {
    const settledNote = item.output && item.status !== "running" && (failed || item.output.length < 400);
    return card(
      <CardHead icon={<IconFile size={13} />} meta={<DiffBadge added={item.diff.added} removed={item.diff.removed} />} repeats="meta">
        {path ? <FileLink path={path} /> : item.name}
      </CardHead>,
      <>
        <DiffView diff={item.diff} />
        {settledNote ? <div className={`tool-card-note${failed ? " is-error" : ""}`}>{item.output}</div> : null}
        {item.output && !settledNote && item.status !== "running" ? (
          <details className="tool-card-raw">
            <summary>Output</summary>
            <pre className="io-text">{item.output}</pre>
          </details>
        ) : null}
      </>,
      path !== null,
    );
  }

  const command = item.category === "command" ? str(args, ["command", "cmd", "script", "code"]) : null;
  if (command !== null) {
    const extra = args ? Object.fromEntries(Object.entries(args).filter(([k]) => !["command", "cmd", "script", "code", "description"].includes(k))) : {};
    const description = str(args, ["description"]);
    const chips = Object.keys(extra).length > 0 ? <ArgChips args={extra} /> : null;
    return card(
      description ? (
        <CardHead icon={<IconTerminal size={13} />} meta={chips}>
          <span className="tool-card-prose">{description}</span>
        </CardHead>
      ) : null,
      <div className={`term${item.status === "running" ? " is-running" : ""}`}>
        {!description && chips ? <div className="term-meta">{chips}</div> : null}
        <pre className="term-command">
          <span className="term-prompt" aria-hidden="true">
            $
          </span>
          {command}
        </pre>
        {item.output ? <pre className={`term-output${failed ? " is-error" : ""}`}>{item.output}</pre> : null}
        {item.status === "running" ? <span className="term-cursor" aria-hidden="true" /> : null}
        {item.truncated ? <div className="term-note">Output truncated</div> : null}
      </div>,
      true,
    );
  }

  if (item.category === "read" && path) {
    return card(
      <CardHead icon={<IconFile size={13} />} meta={lineRange(args)} repeats="icon">
        <FileLink path={path} />
      </CardHead>,
      <Output item={item} label={null} />,
      true,
    );
  }

  const pattern = item.category === "search" ? str(args, ["pattern", "query", "glob", "regex", "q"]) : null;
  if (pattern !== null) {
    const where = path && path !== "." ? path : null;
    return card(
      <CardHead icon={<IconSearch size={13} />} repeats="all">
        <code className="tool-chip">{pattern}</code>
        {where ? (
          <>
            <span className="tool-card-sep">in</span>
            <span>{where}</span>
          </>
        ) : null}
      </CardHead>,
      <Output item={item} label={null} json />,
    );
  }

  const url = item.category === "web" ? str(args, ["url", "uri", "href"]) : null;
  const query = item.category === "web" && url === null ? str(args, ["query", "q", "search"]) : null;
  if (url !== null || query !== null) {
    return card(
      <CardHead icon={url !== null ? <IconGlobe size={13} /> : <IconSearch size={13} />}>
        {url !== null && /^https?:\/\//.test(url) ? (
          <a className="tool-card-link" href={url} target="_blank" rel="noreferrer noopener">
            {url}
          </a>
        ) : (
          <span className="tool-card-prose">{url ?? query}</span>
        )}
      </CardHead>,
      <Output item={item} label={null} json />,
      true,
    );
  }

  const todos = /todo/i.test(item.name) ? todoEntries(args) : null;
  if (todos) {
    return card(
      null,
      <>
        <TodoList entries={todos} />
        {failed ? <div className="tool-card-note is-error">{item.output}</div> : null}
      </>,
    );
  }

  return card(
    null,
    <>
      {item.args ? (
        <div className="io-section">
          <span className="io-label">Input</span>
          {args && hasNested(args) ? <JsonTree value={args} raw={item.args} label="Input as JSON" /> : args ? <ArgRows args={args} /> : <pre className="io-text">{item.args}</pre>}
        </div>
      ) : null}
      {item.args ? <div className="io-divider" /> : null}
      <Output item={item} json />
    </>,
  );
}

/** Small arguments (a timeout, a flag) as chips beside the header. */
function ArgChips({ args }: { args: Args }) {
  return (
    <>
      {Object.entries(args)
        .filter(([, v]) => v !== undefined && v !== null && v !== "" && v !== false)
        .slice(0, 4)
        .map(([key, value]) => (
          <span className="tool-chip is-quiet" key={key} title={`${key}: ${display(value)}`}>
            {value === true ? key : `${key} ${display(value).slice(0, 24)}`}
          </span>
        ))}
    </>
  );
}
