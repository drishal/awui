// The conversation as Tern nodes: the web UI's turns (web/turns.ts), drawn
// with Tern's own components. A prompt is a pill on the right; each stretch
// of work folds to one "Worked for …" line holding native tool rows (commands
// with their output, edits as real diffs, jobs as meter/chart/key-value rows,
// JSON as trees, subagents as agent rows); replies stream as Markdown. Tern
// clocks every timer and spinner from the ages sent
// here, so nothing re-renders to make time pass. Pure apart from the
// handlers it attaches, which call back into the app: the clock (`now`) and
// the live phase's wording come in through ConversationCx, never read here.
import { span, ui, html, type IconName, type Json, type Node, type PropsOf, type Span } from "@stencil-hq/tern";
import { formatFullWhen, formatWhen } from "../web/turn-time.js";
import { iconStack, toolKind, toolKinds, type ToolKind } from "../web/tool-kinds.js";
import type { AssistantItem, ChatItem, HarnessStatus, JobBlock, JobTone, NoticeItem, RequestItem, SubagentRun, ToolItem, UserItem } from "../shared/protocol.js";
import { buildTurns, countSummary, formatDuration, latestThought, segmentStartsOpen, workAfterSegment, workSegments, type Turn, type WorkSegment } from "../web/turns.js";
import { isBusy } from "../web/session-groups.js";
import { plainTitle } from "../web/plain-title.js";
import { chatJobs, jobElapsed, jobStart, type ChatJob } from "../web/jobs.js";
import { OPEN_DEPTH, parseJsonContainer } from "../web/json-tree.js";
import type { ChatState } from "../web/chat-state.js";
import { fileUrl, STATUS_LABEL, unifiedDiff } from "../atui/format.js";
import { commandLine, toolSentence } from "../web/tool-sentence.js";
import { testProgress, type TestProgress } from "../web/tool-facts.js";
import { neatRow, shortPath, thoughtTitle } from "../atui/neat.js";

/** The conversation's column in the surface (main > page): a node's id is this, then its keys down the tree, which is how a row is revealed. */
export const PAGE_KEY = "page";
export const PAGE_ID = `main.${PAGE_KEY}`;

/** Turns drawn at first; older ones wait behind "Show earlier" (Tern keeps what is drawn, so a long chat stays light). */
export const TURN_WINDOW = 30;

/** What the conversation needs from the app: its state, and what clicks do. */
export interface ConversationCx {
  chat: ChatState;
  harness: HarnessStatus | null;
  /** The server's address, for links into the web UI (a rendered page, which Tern cannot show). */
  webUrl: string;
  /** The time of this view (epoch ms), read by the app once per build: a running job's elapsed time is worked out from it. */
  now: number;
  /**
   * What the live turn is doing, in the web UI's words ("Thinking", "Running npm test", "Writing"), held steady
   * by the app so a burst of fast calls does not flicker; empty when it has none yet.
   */
  phase: string;
  /**
   * How long ago `at` was, for a timer keyed `key`: worked out once per key
   * and kept, so later frames send the same age and Tern's clock runs on
   * untouched (a new age would restart it).
   */
  age: (key: string, at: number | undefined) => number | undefined;
  /** Whether the terminal can draw a rich kind; unsupported job and JSON blocks stay plain text. */
  supports: (kind: string) => boolean;
  /** How many turns to draw from the end. */
  shown: number;
  /** Folds the user opened or closed, by key: true is open. */
  folds: ReadonlyMap<string, boolean>;
  /** The turn whose prompt shows its actions. */
  picked: string | null;
  /**
   * Whether a turn arrived while this chat was on screen (not drawn with it when it opened): only those
   * animate in, as the web UI's `is-arriving` rows do, so a resume or a tab switch draws still.
   */
  arrived?: (turnId: string) => boolean;
  /** A prompt image's blob id once Tern has it; asks for it (and re-renders) when not. */
  blob: (imageId: string, mimeType: string) => string | null;
  on: {
    fold: (key: string, open: boolean) => void;
    pick: (turnId: string | null) => void;
    showEarlier: () => void;
    retry: (turn: Turn) => void;
    edit: (turn: Turn) => void;
    /** A new session holding the chat through prompt `through`. */
    fork: (through: number) => void;
    undo: (turn: Turn) => void;
    copy: (text: string) => void;
    /** The turn as Markdown on the clipboard (the web UI's Copy turn). */
    copyTurn: (turn: Turn) => void;
    /** The turn's time as the waterfall overlay. */
    timing: (turn: Turn) => void;
  };
}

/** When the prompt was sent, quiet under its pill as the web UI shows it ("3:41 pm", "Mon 3:41 pm"); nothing when unknown. */
function promptTime(prompt: UserItem): Node | null {
  if (prompt.at === undefined) return null;
  return ui.text({ key: "when", role: "awui.prompt-time", title: formatFullWhen(prompt.at) }, formatWhen(prompt.at));
}

/**
 * What the prompt says about itself under its pill: when it was sent, and who sent it when not the person at
 * this keyboard (the web UI's little "agent" or "guest" word beside the clock).
 */
function promptMeta(prompt: UserItem): Node | null {
  const time = promptTime(prompt);
  const source = prompt.source
    ? ui.text(
        { key: "src", role: "awui.prompt-source", title: prompt.source === "guest" ? "Released from a guest link by this chat's owner, not typed here" : "Sent by another agent or a routine, not typed here" },
        prompt.source,
      )
    : null;
  if (!time && !source) return null;
  return ui.row({ key: "meta", role: "awui.prompt-meta", justify: "end", align: "center", gap: "sm" }, time, source);
}

/**
 * A phone's long-press menu (`actions.hold`) with the same entries as the right-click one. Tern 0.9.14
 * lists them on a long press and sends the pick as an action event with that name, which the node's
 * onMenu handler of the same name answers; SDK 0.2.0's types predate `hold`, hence the casts above.
 */
export function holdMenu(names: string[]): { actions: { hold: string[] } } {
  return { actions: { hold: names } };
}

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A finished call shows how long it took only past this, as the web UI's rows do (a "0.2s" on every quick read is noise). */
const TOOK_AFTER_MS = 1500;

/** Tern's tool icons are picked by name: our categories in its words. */
const TOOL_NAMES: Record<ToolItem["category"], string> = { read: "read", edit: "edit", write: "write", command: "bash", search: "grep", web: "web", agent: "task", other: "" };

/** The name a call's row is drawn under (Tern picks its icon by it): a todo or plan call wears the checklist, as the web UI's row does. */
function rowName(item: ToolItem): string {
  if (toolKind(item).plan) return "todo";
  return TOOL_NAMES[item.category] || item.name;
}

/** A kind's glyph in the fold head's icon stack, Tern's nearest to the web UI's (tool-kinds.ts). */
function kindIcon(kind: ToolKind): IconName {
  if (kind.server) return "plug";
  if (kind.test) return "run";
  if (kind.plan) return "list-checks";
  const icons: Record<ToolItem["category"], IconName> = { read: "doc", edit: "pen", write: "file-plus", command: "terminal", search: "search", web: "globe", agent: "agent", other: "plug" };
  return icons[kind.category];
}

function toolStatus(item: ToolItem): "running" | "done" | "error" {
  return item.status;
}

/** How far a test run has got: a bar of the passed and failed shares, "12/80 tests", the failures, and the test running now. */
export function progressNode(p: TestProgress): Node {
  const passed = Math.max(0, Math.min(p.done - p.failed, p.total)) / p.total;
  const failed = Math.min(p.failed, p.done) / p.total;
  return ui.col(
    { key: "tests", gap: "xs" },
    ui.meter({
      key: "m",
      size: "md",
      parts: [
        { value: passed, token: "success", label: "passed" },
        { value: failed, token: "error", label: "failed" },
      ],
      label: [span(`${p.done}/${p.total} tests`)],
      ...(p.failed > 0 ? { total: [span(`${p.failed} failed`, "error")] } : {}),
    }),
    p.current ? ui.text({ key: "now", truncate: "end" }, span(p.current, "muted")) : null,
  );
}

/** A subagent's run as an `agent` row, its answer folded under it. */
function agentNode(run: SubagentRun): Node {
  const status = run.status === "stopped" ? "aborted" : run.status;
  const last = run.activity?.[run.activity.length - 1];
  return ui.agent(
    {
      key: run.id,
      name: run.agent,
      task: run.task.split("\n")[0] ?? "",
      status,
      ...(run.model ? { model: run.model } : {}),
      stats: {
        ...(run.toolCount !== undefined ? { tools: run.toolCount } : {}),
        ...(run.tokens !== undefined ? { tokens: run.tokens } : {}),
        ...(run.cost !== undefined ? { cost: run.cost } : {}),
        ...(run.durationMs !== undefined && status !== "running" ? { took: run.durationMs } : {}),
      },
      ...(status === "running" && last ? { tool: { name: last } } : {}),
      collapsible: Boolean(run.output || run.error),
      collapsed: true,
    },
    run.error ? ui.text({ key: "err", tone: "error" }, run.error) : null,
    run.output ? ui.md({ key: "out" }, run.output) : null,
  );
}

/** A widget block without its native kind keeps every label and value as plain text. */
function plainJobBlock(block: JobBlock, key: string): Node {
  const rows: Array<{ text: string; tone?: JobTone }> = [];
  switch (block.kind) {
    case "meter":
      rows.push({ text: `${block.label ? `${block.label}: ` : ""}${block.text ?? `${Math.round(block.value * 100)}%`}`, tone: block.tone });
      break;
    case "stat":
      rows.push(...block.items.map((item) => ({ text: `${item.label} ${item.text}`, tone: item.tone })));
      break;
    case "text":
      rows.push({ text: block.text });
      break;
    case "bars":
      if (block.label) rows.push({ text: block.label });
      rows.push(...block.items.map((item) => ({ text: `${item.label}: ${item.text ?? item.value}`, tone: item.tone })));
      break;
    case "spark":
      rows.push({ text: [block.label, block.values.join(" "), block.last].filter(Boolean).join(" · ") });
      break;
    case "grid":
      if (block.label) rows.push({ text: block.label });
      rows.push(...block.items.map((item) => ({ text: `${item.label}${item.text ? ` ${item.text}` : ""}`, tone: item.tone })));
      break;
  }
  return ui.col({ key, role: "awui.job-block", gap: "xs" }, rows.map((row, i) => ui.text({ key: `r${i}`, text: row.text, tone: row.tone })));
}

/** One harness-drawn job block, using the richest kind this terminal announced. */
function jobBlockNode(block: JobBlock, key: string, supports: ConversationCx["supports"]): Node {
  switch (block.kind) {
    case "meter":
      return supports("meter") ? ui.meter({ key, value: block.value, label: block.label, total: block.text ?? `${Math.round(block.value * 100)}%`, tone: block.tone }) : plainJobBlock(block, key);
    case "stat":
      if (supports("stats")) return ui.stats({ key, items: block.items.map((item) => ({ label: item.label, value: item.text, tone: item.tone })) });
      if (supports("kv")) return ui.kv({ key, items: block.items.map((item) => ({ k: item.label, v: item.tone ? [span(item.text, item.tone)] : item.text })) });
      return plainJobBlock(block, key);
    case "bars":
      return supports("chart")
        ? ui.chart({
            key,
            kind: "bars",
            summary: block.label,
            max: block.max ?? Math.max(...block.items.map((item) => item.value), 1),
            series: block.items.map((item) => ({ value: item.value, label: item.label, title: item.text, tone: item.tone })),
          })
        : plainJobBlock(block, key);
    case "spark":
      return supports("chart")
        ? ui.chart({
            key,
            kind: "spark",
            summary: [block.last, block.label].filter(Boolean).join(" · "),
            series: block.values,
            min: block.min ?? 0,
            max: block.max ?? Math.max(...block.values, 1),
          })
        : plainJobBlock(block, key);
    case "grid":
      if (!supports("kv")) return plainJobBlock(block, key);
      return ui.col(
        { key, gap: "xs" },
        block.label ? ui.text({ key: "label" }, span(block.label, "muted")) : null,
        ui.kv({ key: "kv", layout: "grid", items: block.items.map((item) => ({ k: item.label, v: item.text ? (item.tone ? [span(item.text, item.tone)] : item.text) : "" })) }),
      );
    case "text":
      return ui.text({ key, text: block.text });
  }
}

/** A background job as a native row, with the web card's wording, timing, and widget. */
function jobNode(job: ChatJob, age: ConversationCx["age"], supports: ConversationCx["supports"], now: number): Node {
  const running = job.status === "running";
  const widget = job.widget;
  const title = job.title ?? widget?.title ?? null;
  const elapsed = jobElapsed(job, now);
  const started = jobStart(job) ?? (elapsed !== undefined ? now - elapsed : undefined);
  const stage = widget?.stage && widget.stage !== title ? widget.stage : null;
  const children: Node[] = (widget?.blocks ?? []).map((block, i) => jobBlockNode(block, `b${i}`, supports));
  // A job without a widget may still be a test run whose output announces its progress.
  const progress = !widget?.blocks.length && job.output ? testProgress(job.output) : null;
  if (progress && progress.total > 0) children.push(progressNode(progress));
  if (stage) children.push(ui.text({ key: "stage" }, span(stage, "muted")));
  if (job.status === "failed" && job.exitCode !== undefined) children.push(ui.text({ key: "exit", text: `exit ${job.exitCode}`, tone: "error" }));
  return ui.tool(
    {
      key: job.id,
      role: "awui.job",
      name: "job",
      title: title ?? job.label,
      ...(title ? { target: job.label, targetKind: job.kind === "shell" ? "command" : "text" } : {}),
      status: job.status === "failed" ? "error" : job.status === "stopped" ? "cancelled" : job.status,
      badges: [{ text: job.id, tone: "muted" }],
      ...(widget?.headline ? { meta: [`${widget.headline.text}${widget.headline.label ? ` ${widget.headline.label}` : ""}`] } : {}),
      ...(running && started !== undefined ? { age: age(`job:${job.id}`, started) } : !running && elapsed !== undefined ? { took: elapsed } : {}),
      frame: "inline",
      ...(children.length > 0 ? { collapsible: true, collapsed: false } : {}),
    },
    children,
  );
}

/** A parsed JSON container as Tern's own collapsible tree, open to the same depth as the web UI's. */
function jsonSection(key: string, label: string, value: object): Node {
  return ui.col({ key, gap: "xs" }, ui.text({ key: "label" }, span(label, "muted")), ui.json({ key: "json", value: value as Json, open: OPEN_DEPTH, aria: `${label} as JSON` }));
}

/** The head of a call's body for its hovercard: a dozen lines, cut hard in bytes so a huge output stays light. */
function previewHead(text: string, lines = 12, chars = 1200): string {
  const cut = text.split("\n").slice(0, lines).join("\n");
  return cut.length > chars ? `${cut.slice(0, chars)}…` : cut;
}

/**
 * What a tool row shows while the pointer rests on it: Tern has no hover event to fetch a file with, so
 * this is the call's own body (its diff, its output, its command), bounded, never a request.
 */
function rowPreview(item: ToolItem, path: string | undefined): Node | null {
  if (item.subagents) return null;
  if (item.diff && item.diff.lines.length > 0) {
    const lines = item.diff.lines.slice(0, 12);
    return ui.diff({ text: unifiedDiff(path ?? "file", { lines, added: lines.filter((l) => l.kind === "add").length, removed: lines.filter((l) => l.kind === "del").length }) });
  }
  if (item.output.trim()) return item.category === "read" ? ui.code({ text: previewHead(item.output), ...(path ? { path } : {}) }) : ui.ansi({ text: previewHead(item.output) });
  if (item.category === "command" && item.summary) return ui.code({ text: previewHead(item.summary, 6) });
  return null;
}

/**
 * One tool call as Tern's `tool` row: icon, verb, target, facts, timer, and its output folded under it.
 * `now` is read only by the jobs a wait or list call shows; a live view always passes the cx's.
 */
export function toolNode(item: ToolItem, workspace: string, age: ConversationCx["age"], supports: ConversationCx["supports"] = () => true, now = 0): Node {
  const row = neatRow(item, workspace);
  // The words are the web UI's ("Ran npm test", "Couldn't read src/a.ts"), with the facts it reads from the output.
  const sentence = toolSentence(item, workspace);
  const running = item.status === "running";
  // A command is shown whole (Tern cuts it to the pane's width), minus the `cd` agents start with.
  // What follows the target joins it when it is a continuation (": triage ticket"), else is a fact beside it ("in src").
  const subject = item.category === "command" && !item.subagents && row.detail?.startsWith("$ ") ? commandLine(row.detail.slice(2), Infinity) : sentence.target;
  const target = sentence.rest?.startsWith(":") ? `${subject}${sentence.rest}` : subject;
  const targetKind = item.category === "command" ? "command" : item.category === "search" ? "pattern" : item.category === "web" ? "query" : item.paths.length > 0 ? "path" : "text";
  // The web UI's row: the diff count at the end, else the facts its output holds ("412 lines", "12 passed").
  const exit = /^exit (\d+)$/.exec(sentence.facts.find((f) => f.startsWith("exit ")) ?? "");
  const meta: string[] = [];
  if (sentence.rest && !sentence.rest.startsWith(":")) meta.push(sentence.rest);
  if (item.diffStat && (item.diffStat.added || item.diffStat.removed)) meta.push(`+${item.diffStat.added}`, `−${item.diffStat.removed}`);
  else meta.push(...sentence.facts.filter((f) => !f.startsWith("exit ")));
  const path = item.paths[0] ? shortPath(item.paths[0], workspace) : undefined;
  const took = !running && item.at !== undefined && item.endedAt !== undefined ? item.endedAt - item.at : undefined;

  const watchedJobs = item.jobs && item.jobs.length > 0 && item.category !== "command" ? chatJobs([item]) : null;
  const hovercard = rowPreview(item, item.paths[0] ? shortPath(item.paths[0], workspace) : undefined);
  let body: Node | Node[] | null = null;
  let collapsed = !running;
  let preview: { lines: number } | { tail: number } | undefined;
  if (item.subagents) {
    body = item.subagents.runs.map((r) => agentNode(r));
    collapsed = false;
  } else if (watchedJobs) {
    // As in the web UI, a wait or list call shows the jobs themselves rather than its raw status output.
    body = watchedJobs.map((job) => jobNode(job, age, supports, now));
    collapsed = false;
  } else if (item.plan) {
    body = ui.md({ key: "plan" }, item.plan);
  } else if (item.diff && item.diff.lines.length > 0) {
    // Folded like every other row, as in the web UI: the +/− count says how big it is, a click shows it.
    body = ui.diff({ key: "diff", text: unifiedDiff(path ?? "file", item.diff), ...(path ? { path } : {}) });
  } else {
    const parts: Node[] = [];
    // Commands, reads, and edits already name their input in the row; other calls show structured arguments as the web UI does.
    const args = item.category === "other" && supports("json") ? parseJsonContainer(item.args) : null;
    if (args) parts.push(jsonSection("in", "Input", args));
    if (item.output.trim()) {
      if (item.category === "read" && path) parts.push(ui.code({ key: "out", text: item.output, path }));
      else {
        const output = supports("json") ? parseJsonContainer(item.output) : null;
        parts.push(output ? jsonSection("out", "Output", output) : ui.ansi({ key: "out", text: item.output, ...(running ? { follow: true } : {}) }));
      }
      if (running && item.category === "command") {
        preview = { tail: 4 };
        // A test run that announced its total shows how far it has got, its failures as a red stretch at the end.
        const progress = testProgress(item.output);
        if (progress && progress.total > 0) parts.unshift(progressNode(progress));
      }
    }
    if (parts.length > 0) body = parts;
  }
  return ui.tool(
    {
      key: item.id,
      name: rowName(item),
      title: sentence.verb,
      ...(target ? { target } : {}),
      targetKind,
      ...(meta.length > 0 ? { meta } : {}),
      ...(sentence.error ? { note: [span(sentence.error, "error")] } : row.note ? { note: row.note } : {}),
      ...(exit ? { exit: Number(exit[1]) } : {}),
      status: toolStatus(item),
      ...(running && item.at !== undefined ? { age: age(item.id, item.at) } : took !== undefined && took >= TOOK_AFTER_MS ? { took } : {}),
      frame: "inline",
      ...(path ? { href: fileUrl(item.paths[0] as string, workspace) } : {}),
      ...(body ? { collapsible: true, collapsed: running ? false : collapsed } : {}),
      ...(preview ? { preview } : {}),
      ...(hovercard ? { hovercard } : {}),
      ...(item.truncated ? { badges: [{ text: "cut", tone: "muted", title: "The output was cut to its head and tail" }] } : {}),
    },
    body,
  );
}

/** A thought: a row like the calls around it (the web UI's), its title as the target and the reasoning folded under it. */
function thoughtNode(item: AssistantItem, cx: ConversationCx, key: string): Node {
  const open = cx.folds.get(key) ?? false;
  const thinking = item.streaming && !item.text;
  return ui.tool(
    {
      key,
      role: "awui.thought",
      name: "thinking",
      title: thinking ? "Thinking" : "Thought",
      target: thoughtTitle(item.thinking),
      targetKind: "text",
      status: thinking ? "running" : "done",
      frame: "inline",
      collapsible: true,
      collapsed: !open,
      onToggle: (e) => cx.on.fold(key, !e.collapsed),
    },
    open ? ui.md({ key: "t", stream: item.streaming }, item.thinking) : null,
  );
}

function noticeNode(item: NoticeItem): Node {
  const tone = item.level === "error" ? "error" : item.level === "warning" ? "warning" : "muted";
  if (item.detail) {
    return ui.section({ key: item.id, role: "awui.note", head: [span(item.title ?? item.text, tone)], collapsible: true, collapsed: true }, ui.md({ key: "d" }, item.detail));
  }
  return ui.text({ key: item.id, role: "awui.note" }, span(item.text, tone));
}

function requestNode(item: RequestItem): Node {
  const outcome = item.outcome ? ` — ${item.outcome}` : "";
  return ui.text({ key: item.id, role: "awui.note" }, span("Asked ", "muted"), span(item.request.title), span(outcome, "dim"));
}

/** One item of a stretch of work. */
function workItem(item: ChatItem, cx: ConversationCx): Node | Node[] | null {
  const ws = cx.chat.workspace.path;
  switch (item.kind) {
    case "tool":
      return toolNode(item, ws, cx.age, cx.supports, cx.now);
    case "assistant": {
      const out: Node[] = [];
      if (item.thinking.trim()) out.push(thoughtNode(item, cx, `${item.id}~t`));
      // Narration before more work ("Let me check the config"): quiet text in the fold.
      if (item.text.trim()) out.push(ui.md({ key: item.id, role: "awui.note", stream: item.streaming }, item.text));
      return out;
    }
    case "notice":
      return noticeNode(item);
    case "request":
      return requestNode(item);
    default:
      return null;
  }
}

/** How many of a stretch's calls failed. */
const failedCalls = (items: ChatItem[]) => items.filter((item) => item.kind === "tool" && item.status === "error").length;

/**
 * The first failed call of the latest turn that has one, for "Show failed calls": the index of its turn, the key
 * of the fold holding it (the folds map's), and its row's node id under the conversation's column `page`. The
 * ids are the ones `turnNode` gives its fold (`w<n>`, or `after`) and `toolNode` its row.
 */
export function firstFailedCall(turns: Turn[], page: string): { turn: number; fold: string; row: string } | null {
  for (let t = turns.length - 1; t >= 0; t--) {
    const turn = turns[t] as Turn;
    // A turn without a prompt draws no fold (its rows stand bare), so there is nothing to open there.
    if (!turn.prompt) continue;
    const stretches = workSegments(turn).map((segment, i) => ({ segment, node: `w${i}` }));
    const after = workAfterSegment(turn);
    if (after) stretches.push({ segment: after, node: "after" });
    for (const { segment, node } of stretches) {
      const call = segment.items.find((item) => item.kind === "tool" && item.status === "error");
      if (call) return { turn: t, fold: segment.key, row: `${page}.${turn.id}.${node}.items.${call.id}` };
    }
  }
  return null;
}

/** A stretch's fold line: "Worked for 27s · 3 commands", "Working · 2 reads" while it runs, "1 command" between replies. */
export function foldHead(turn: Turn, segment: WorkSegment, place: "first" | "middle" | "last" | "only"): string {
  const counts = countSummary(segment.counts);
  const live = turn.live && (place === "last" || place === "only");
  if (!live && (place === "middle" || place === "last")) return counts ? counts.charAt(0).toUpperCase() + counts.slice(1) : "Worked";
  if (live) return counts ? `Working · ${counts}` : "Working";
  const duration = turn.startedAt !== undefined ? formatDuration((turn.endedAt ?? turn.startedAt) - turn.startedAt) : null;
  const head = duration ? `Worked for ${duration}` : "Worked";
  return counts ? `${head} · ${counts}` : head;
}

/**
 * The fold line with what the web UI's header adds to it: the turn's +/− on the first stretch, and a tally of
 * failed calls (a settled turn opens nothing, so the tally is how a failure is found; C-x f goes to it).
 */
export function foldHeadSpans(turn: Turn, segment: WorkSegment, place: "first" | "middle" | "last" | "only"): Span[] {
  const spans: Span[] = [span(foldHead(turn, segment, place), "muted")];
  const stat = place === "first" || place === "only" ? turn.changeStat : null;
  if (stat) {
    const more = stat.partial ? "+" : "";
    if (stat.added > 0) spans.push(span(`  +${stat.added}${more}`, "ins"));
    if (stat.removed > 0) spans.push(span(`${stat.added > 0 ? " " : "  "}−${stat.removed}${more}`, "del"));
  }
  const failed = failedCalls(segment.items);
  if (failed > 0) spans.push(span(`  ${failed} failed`, "error"));
  return spans;
}

/**
 * The fold's head as the web UI's card header draws it: the kinds of tool the stretch used as a stack of
 * round icons ("+N" past three), the words, and the turn's +/− at the right edge.
 */
export function foldHeadNode(turn: Turn, segment: WorkSegment, place: "first" | "middle" | "last" | "only"): Node {
  const spans = foldHeadSpans(turn, segment, place);
  const stat = spans.filter((s) => s.s === "ins" || s.s === "del").map((s) => span(s.t.trim(), s.s));
  const words = spans.filter((s) => s.s !== "ins" && s.s !== "del");
  const { shown, more } = iconStack(toolKinds(segment.items));
  return ui.row(
    { key: "head", role: "awui.work-head", align: "center", gap: "sm" },
    shown.length > 0
      ? ui.row(
          { key: "kinds", role: "awui.kinds", align: "center" },
          shown.map((k) => ui.icon({ key: k.key, name: kindIcon(k), title: k.server ?? k.category })),
          more > 0 ? ui.text({ key: "more", role: "awui.kinds-more" }, `+${more}`) : null,
        )
      : null,
    ui.text({ key: "t", grow: 1, truncate: "end" }, words),
    stat.length > 0 ? ui.text({ key: "s", role: "awui.work-stat" }, stat.flatMap((s, i) => (i > 0 ? [" ", s] : [s]))) : null,
  );
}

/** The prompt: a pill, its images, and (picked) the things a past prompt offers. */
function promptNode(turn: Turn, prompt: UserItem, cx: ConversationCx): Node {
  const picked = cx.picked === turn.id;
  const caps = cx.chat.capabilities;
  const canBranch = turn.through > 0;
  const acts: Node[] = [];
  if (picked && canBranch) {
    const icon = (key: string, name: string, title: string, run: () => void) => ui.icon({ key, name, title, aria: title, onClick: run });
    if (!isBusy(cx.chat.status)) {
      acts.push(icon("retry", "repeat", caps.supportsRewind ? "Retry: run it again in place" : "Retry in a branch from before it", () => cx.on.retry(turn)));
      acts.push(icon("edit", "pencil", caps.supportsRewind ? "Edit and run again in place" : "Edit, in a branch from before it", () => cx.on.edit(turn)));
    }
    if (caps.supportsFork && turn.through > 1) acts.push(icon("fork", "branch", "Fork: a new session from before this prompt", () => cx.on.fork(turn.through - 1)));
    if (cx.chat.checkpoints.includes(turn.through)) acts.push(icon("undo", "undo", "Undo files: put them back as they were before it", () => cx.on.undo(turn)));
    acts.push(icon("copy", "copy", "Copy the prompt", () => cx.on.copy(prompt.text)));
  }
  const images = (prompt.images ?? []).map((ref, i) => {
    const blob = cx.blob(ref.id, ref.mimeType);
    return blob ? ui.image({ key: `img${i}`, blob, alt: "An image sent with the prompt", h: 120 }) : null;
  });
  const menu = {
    ...(canBranch && !isBusy(cx.chat.status) ? { retry: () => cx.on.retry(turn), edit: () => cx.on.edit(turn) } : {}),
    ...(canBranch && caps.supportsFork && turn.through > 1 ? { "fork-before": () => cx.on.fork(turn.through - 1) } : {}),
    ...(canBranch && cx.chat.checkpoints.includes(turn.through) ? { "undo-files": () => cx.on.undo(turn) } : {}),
    "copy-prompt": () => cx.on.copy(prompt.text),
    // The web UI's Copy turn as Markdown: the prompt, one line a call, the replies, the answer.
    "copy-turn-as-markdown": () => cx.on.copyTurn(turn),
  };
  // A steer the agent took mid-run is a note inside that run, not the next prompt: the web UI draws it as a
  // divider row across the thread, so here it is Tern's rule labelled "while it ran" and the words quiet under
  // it, still clickable for the same Retry/Copy menu a prompt has.
  if (prompt.interjected) {
    return ui.col(
      { key: "ask", role: "awui.interjection" },
      ui.rule({ key: "r", variant: "line", label: "while it ran", tone: "muted" }),
      images.some(Boolean) ? ui.row({ key: "imgs", gap: "sm" }, images) : null,
      ui.text({
        key: "p",
        role: "awui.interjection-text",
        text: prompt.text,
        title: "A steer the agent took while it ran",
        onClick: () => cx.on.pick(picked ? null : turn.id),
        onMenu: menu,
        ...holdMenu(Object.keys(menu)),
      } as PropsOf<"text">),
      acts.length > 0 ? ui.row({ key: "acts", role: "awui.prompt-acts" }, acts) : null,
      promptMeta(prompt),
    );
  }
  return ui.col(
    { key: "ask", role: "awui.ask" },
    images.some(Boolean) ? ui.row({ key: "imgs", gap: "sm" }, images) : null,
    ui.text({
      key: "p",
      role: "awui.prompt",
      text: prompt.text,
      title: canBranch ? "Click for Retry, Edit, Fork, Undo, and Copy" : "",
      onClick: () => cx.on.pick(picked ? null : turn.id),
      onMenu: menu,
      ...holdMenu(Object.keys(menu)),
    } as PropsOf<"text">),
    promptMeta(prompt),
    acts.length > 0 ? ui.row({ key: "acts", role: "awui.prompt-acts" }, acts) : null,
    !prompt.text.trim() && (prompt.imageCount ?? 0) > 0 && !images.some(Boolean) ? ui.text({ key: "n", role: "awui.prompt-meta" }, plural(prompt.imageCount ?? 0, "image")) : null,
  );
}

/**
 * The live turn's last line: what the agent is doing, shimmering, with Tern's own timer. The words are the
 * web UI's phase ("Thinking", the running call's sentence, "Writing"), held steady by the app (cx.phase).
 * While the live fold is closed its latest thought shows after them, muted, as the web UI's closed card shows
 * it under the phase; open, the thought is in the fold already.
 */
function workingNode(turn: Turn, cx: ConversationCx, foldOpen: boolean): Node {
  const words = cx.chat.status === "compacting" ? "Compacting the context" : cx.chat.status === "stopping" ? "Stopping" : cx.phase || "Working";
  const thought = foldOpen ? null : latestThought(turn);
  return ui.row(
    { key: "working", role: "awui.working", gap: "sm", align: "center" },
    ui.spinner({ key: "s", style: "braille", tone: "accent" }),
    ui.shimmer({ key: "w", text: words }),
    turn.startedAt !== undefined ? ui.elapsed({ key: "t", age: cx.age(`${turn.id}~start`, turn.startedAt) ?? 0 }) : null,
    thought ? ui.text({ key: "thought", role: "awui.working-thought" }, span(thought, "muted")) : null,
  );
}

/**
 * What comes before any prompt (startup notices, or what a compaction kept), as the web UI draws it: plain rows,
 * not a fold (the "Earlier conversation was compacted" notice must show), and the reply among them in its place.
 */
function preambleNode(turn: Turn, cx: ConversationCx): Node {
  const rows = (items: ChatItem[]) =>
    items.flatMap((item) => {
      const n = workItem(item, cx);
      return n === null ? [] : Array.isArray(n) ? n : [n];
    });
  const answer = turn.answer;
  return ui.col(
    { key: turn.id, role: "awui.turn", gap: "md" },
    rows(turn.process),
    answer?.text.trim() ? ui.md({ key: "answer", role: "awui.reply", stream: answer.streaming }, answer.text) : null,
    rows([...turn.workAfter, ...turn.errors, ...turn.after]),
    turn.live ? workingNode(turn, cx, true) : null,
  );
}

/** One turn: its prompt, then each stretch of work and the reply after it, then what it changed. */
function turnNode(turn: Turn, cx: ConversationCx): Node {
  if (!turn.prompt) return preambleNode(turn, cx);
  const parts: (Node | null)[] = [];
  if (turn.prompt) parts.push(promptNode(turn, turn.prompt, cx));
  const segments = workSegments(turn);
  // Whether the live stretch's fold is open: the working line shows the latest thought only while it is closed.
  let liveOpen = false;
  segments.forEach((segment, i) => {
    const place = segments.length === 1 ? "only" : i === 0 ? "first" : i === segments.length - 1 ? "last" : "middle";
    const live = turn.live && (place === "last" || place === "only") && turn.workAfter.length === 0;
    const work = segment.items.filter((item) => !(item.kind === "assistant" && !item.thinking.trim() && !item.text.trim()));
    const answerThought = segment.answerAt >= 0 && turn.answer?.thinking.trim() ? turn.answer : null;
    if (work.length > 0 || answerThought) {
      const key = segment.key;
      // The web UI's rule: a stretch nobody touched is open while it runs, and a live failure keeps it open.
      const open = cx.folds.get(key) ?? segmentStartsOpen(turn.live, segment, failedCalls(segment.items));
      if (live) liveOpen = open;
      const children = work.flatMap((item) => {
        const n = workItem(item, cx);
        return n === null ? [] : Array.isArray(n) ? n : [n];
      });
      if (answerThought) children.push(thoughtNode(answerThought, cx, `${answerThought.id}~t`));
      parts.push(
        ui.section(
          {
            key: `w${i}`,
            role: live ? "awui.fold-live" : "awui.fold",
            head: foldHeadNode(turn, segment, place),
            collapsible: true,
            collapsed: !open,
            onToggle: (e) => cx.on.fold(key, !e.collapsed),
          },
          ui.col({ key: "items", role: "awui.calls" }, children),
        ),
      );
    }
    if (segment.reply) parts.push(ui.md({ key: `r${i}`, role: "awui.reply", stream: segment.reply.streaming }, segment.reply.text));
  });

  for (const plan of turn.plans) {
    parts.push(ui.card({ key: `plan-${plan.id}`, head: [span("Plan", "strong")], collapsible: true, collapsed: false }, ui.md({ key: "m" }, plan.plan)));
  }
  for (const page of turn.renders) {
    // Tern runs no scripts, so an agent's HTML page opens in the browser, from the web UI's copy of this chat.
    const href = `${cx.webUrl}/#chat=${encodeURIComponent(cx.chat.chatId)}`;
    parts.push(
      ui.card(
        { key: `page-${page.id}`, role: "awui.render", head: [span(page.title, "strong")], href, actions: { click: "open" }, title: "Open the page in the web UI" },
        ui.text({ key: "t" }, span("An HTML page the agent made · ", "muted"), span("open it in the web UI", "link", { href })),
      ),
    );
  }

  const answer = turn.answer;
  if (answer?.text.trim()) parts.push(ui.md({ key: "answer", role: "awui.reply", stream: answer.streaming, actions: { menu: ["copy"], ...holdMenu(["copy"]).actions } } as PropsOf<"md">, answer.text));
  // Work the agent did after writing its reply: its own fold below it.
  const after = workAfterSegment(turn);
  if (after) {
    const open = cx.folds.get(after.key) ?? segmentStartsOpen(turn.live, after, failedCalls(after.items));
    if (turn.live) liveOpen = open;
    const children = after.items.flatMap((item) => {
      const n = workItem(item, cx);
      return n === null ? [] : Array.isArray(n) ? n : [n];
    });
    parts.push(
      ui.section(
        {
          key: "after",
          role: turn.live ? "awui.fold-live" : "awui.fold",
          head: foldHeadNode(turn, after, "last"),
          collapsible: true,
          collapsed: !open,
          onToggle: (e) => cx.on.fold(after.key, !e.collapsed),
        },
        ui.col({ key: "items", role: "awui.calls" }, children),
      ),
    );
  }
  if (answer?.error) parts.push(ui.card({ key: "failed", tone: "error", head: [span("The run failed", "error")] }, ui.text({ key: "e", text: answer.error })));
  for (const e of turn.errors) parts.push(ui.text({ key: e.id, role: "awui.note" }, span(e.text, "error")));

  if (turn.live) parts.push(workingNode(turn, cx, liveOpen));
  else if (answer?.text.trim()) {
    parts.push(
      ui.row(
        { key: "acts", role: "awui.answer-acts" },
        ui.icon({ key: "copy", name: "copy", title: "Copy the answer", aria: "Copy the answer", onClick: () => cx.on.copy(answer.text) }),
        ui.icon({ key: "markdown", name: "markdown", title: "Copy the turn as Markdown", aria: "Copy the turn as Markdown", onClick: () => cx.on.copyTurn(turn) }),
        ui.icon({ key: "timing", name: "clock", title: "Timing: every step, call, and subagent run", aria: "Timing", onClick: () => cx.on.timing(turn) }),
        turn.through > 0 && cx.chat.capabilities.supportsFork
          ? ui.icon({ key: "fork", name: "branch", title: "Fork: a new session through this answer", aria: "Fork", onClick: () => cx.on.fork(turn.through) })
          : null,
        cx.chat.checkpoints.includes(turn.through)
          ? ui.icon({ key: "undo", name: "undo", title: "Undo files: put them back as they were before this turn", aria: "Undo files", onClick: () => cx.on.undo(turn) })
          : null,
      ),
    );
  }
  if (!turn.live && turn.changedFiles.length > 0) {
    const ws = cx.chat.workspace.path;
    // The web UI's row: a pen, the count, the paths in mono, and the turn's +/− with the file count at the right.
    const files: (string | Span)[] = [span(`Changed ${plural(turn.changedFiles.length, "file")} · `, "muted")];
    turn.changedFiles.slice(0, 6).forEach((f, i) => {
      if (i > 0) files.push(span(", ", "dim"));
      files.push(span(shortPath(f, ws), "path", { href: fileUrl(f, ws) }));
    });
    if (turn.changedFiles.length > 6) files.push(span(` and ${turn.changedFiles.length - 6} more`, "dim"));
    const stat = turn.changeStat;
    parts.push(
      ui.row(
        { key: "changed", role: "awui.changed", align: "center", gap: "sm" },
        ui.icon({ key: "i", name: "pen" }),
        ui.text({ key: "t", grow: 1, truncate: "end" }, files),
        stat
          ? ui.text(
              { key: "s", role: "awui.work-stat" },
              span(`+${stat.added}`, "ins"),
              " ",
              span(`−${stat.removed}`, "del"),
              span(` · ${plural(stat.files, "file")}`, "muted"),
            )
          : null,
      ),
    );
  }
  for (const n of turn.after) parts.push(ui.text({ key: n.id, role: "awui.after" }, span(n.text, n.level === "error" ? "error" : "muted")));
  return ui.col({ key: turn.id, role: cx.arrived?.(turn.id) ? "awui.turn-new" : "awui.turn", gap: "md" }, parts);
}

/** The chat's header: title, harness, state, project. */
export function headNode(chat: ChatState | null, harness: HarnessStatus | null, project: string | null, asks: boolean): Node {
  const status = chat?.status ?? "idle";
  const busy = isBusy(status);
  const state = asks ? "Needs you" : chat?.gone ? chat.gone : STATUS_LABEL[status];
  const stateClass = asks ? "state asks" : status === "error" ? "state failed" : busy ? "state busy" : status === "idle" && !chat?.gone ? "state idle" : "state";
  // The web UI's header: the title on its own line, the harness, state, and project under it.
  return ui.col(
    { key: "head", role: "awui.head" },
    ui.text({ key: "title", role: "awui.title", text: chat?.title ? plainTitle(chat.title) : "New chat", truncate: "end" }),
    ui.row(
      { key: "meta", role: "awui.head-meta" },
      harness ? html.span({ key: "harness", class: "harness", text: harness.displayName }) : null,
      html.span({ key: "state", class: stateClass, text: state }),
      project ? ui.text({ key: "project" }, span(project, "muted")) : null,
    ),
  );
}

/** The conversation: the last `shown` turns, a way to the earlier ones, and the chat's own banners. */
export function conversation(cx: ConversationCx): Node[] {
  const turns = buildTurns(cx.chat.items, cx.chat.status);
  const from = Math.max(0, turns.length - cx.shown);
  const out: Node[] = [];
  if (from > 0) {
    out.push(
      html.button({ key: "earlier", class: "chip", text: `Show ${Math.min(from, TURN_WINDOW)} earlier ${from === 1 ? "turn" : "turns"} (${from} hidden)`, onClick: cx.on.showEarlier }),
    );
  }
  for (const turn of turns.slice(from)) out.push(turnNode(turn, cx));
  if (cx.chat.gone) out.push(ui.card({ key: "gone", tone: "muted", head: [span(cx.chat.gone, "muted")] }, ui.text({ key: "t", text: "Open the session again from the list (C-x s) to go on." })));
  return out;
}
