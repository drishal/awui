// The conversation as Tern nodes: the web UI's turns (web/turns.ts), drawn
// with Tern's own components. A prompt is a pill on the right; each stretch
// of work folds to one "Worked for …" line holding native tool rows (commands
// with their output, edits as real diffs, subagents as agent rows); replies
// stream as Markdown. Tern clocks every timer and spinner from the ages sent
// here, so nothing re-renders to make time pass. Pure apart from the
// handlers it attaches, which call back into the app.
import { span, ui, html, type Node, type Span } from "@stencil-hq/tern";
import type { AssistantItem, ChatItem, HarnessStatus, NoticeItem, RequestItem, SubagentRun, ToolItem, UserItem } from "../shared/protocol.js";
import { buildTurns, countSummary, formatDuration, latestThought, workAfterSegment, workSegments, type Turn, type WorkSegment } from "../web/turns.js";
import { isBusy } from "../web/session-groups.js";
import type { ChatState } from "../web/chat-state.js";
import { fileUrl, STATUS_LABEL, unifiedDiff } from "../atui/format.js";
import { commandLine, toolSentence } from "../web/tool-sentence.js";
import { neatRow, shortPath, thoughtTitle } from "../atui/neat.js";

/** Turns drawn at first; older ones wait behind "Show earlier" (Tern keeps what is drawn, so a long chat stays light). */
export const TURN_WINDOW = 30;

/** What the conversation needs from the app: its state, and what clicks do. */
export interface ConversationCx {
  chat: ChatState;
  harness: HarnessStatus | null;
  /** The server's address, for links into the web UI (a rendered page, which Tern cannot show). */
  webUrl: string;
  /**
   * How long ago `at` was, for a timer keyed `key`: worked out once per key
   * and kept, so later frames send the same age and Tern's clock runs on
   * untouched (a new age would restart it).
   */
  age: (key: string, at: number | undefined) => number | undefined;
  /** How many turns to draw from the end. */
  shown: number;
  /** Folds the user opened or closed, by key: true is open. */
  folds: ReadonlyMap<string, boolean>;
  /** The turn whose prompt shows its actions. */
  picked: string | null;
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
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A finished call shows how long it took only past this, as the web UI's rows do (a "0.2s" on every quick read is noise). */
const TOOK_AFTER_MS = 1500;

/** Tern's tool icons are picked by name: our categories in its words. */
const TOOL_NAMES: Record<ToolItem["category"], string> = { read: "read", edit: "edit", write: "write", command: "bash", search: "grep", web: "web", agent: "task", other: "" };

function toolStatus(item: ToolItem): "running" | "done" | "error" {
  return item.status;
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

/** One tool call as Tern's `tool` row: icon, verb, target, facts, timer, and its output folded under it. */
export function toolNode(item: ToolItem, workspace: string, age: ConversationCx["age"]): Node {
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

  let body: Node | Node[] | null = null;
  let collapsed = !running;
  let preview: { lines: number } | { tail: number } | undefined;
  if (item.subagents) {
    body = item.subagents.runs.map((r) => agentNode(r));
    collapsed = false;
  } else if (item.plan) {
    body = ui.md({ key: "plan" }, item.plan);
  } else if (item.diff && item.diff.lines.length > 0) {
    // Folded like every other row, as in the web UI: the +/− count says how big it is, a click shows it.
    body = ui.diff({ key: "diff", text: unifiedDiff(path ?? "file", item.diff), ...(path ? { path } : {}) });
  } else if (item.output.trim()) {
    if (item.category === "read" && path) body = ui.code({ key: "out", text: item.output, path });
    else body = ui.ansi({ key: "out", text: item.output, ...(running ? { follow: true } : {}) });
    if (running && item.category === "command") preview = { tail: 4 };
  }
  return ui.tool(
    {
      key: item.id,
      name: TOOL_NAMES[item.category] || item.name,
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
      return toolNode(item, ws, cx.age);
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
  return ui.col(
    { key: "ask", role: "awui.ask" },
    images.some(Boolean) ? ui.row({ key: "imgs", gap: "sm" }, images) : null,
    ui.text({
      key: "p",
      role: "awui.prompt",
      text: prompt.text,
      title: canBranch ? "Click for Retry, Edit, Fork, Undo, and Copy" : "",
      onClick: () => cx.on.pick(picked ? null : turn.id),
      onMenu: {
        ...(canBranch && !isBusy(cx.chat.status) ? { retry: () => cx.on.retry(turn), edit: () => cx.on.edit(turn) } : {}),
        ...(canBranch && caps.supportsFork && turn.through > 1 ? { "fork-before": () => cx.on.fork(turn.through - 1) } : {}),
        ...(canBranch && cx.chat.checkpoints.includes(turn.through) ? { "undo-files": () => cx.on.undo(turn) } : {}),
        "copy-prompt": () => cx.on.copy(prompt.text),
      },
    }),
    acts.length > 0 ? ui.row({ key: "acts", role: "awui.prompt-acts" }, acts) : null,
    !prompt.text.trim() && (prompt.imageCount ?? 0) > 0 && !images.some(Boolean) ? ui.text({ key: "n", role: "awui.prompt-meta" }, plural(prompt.imageCount ?? 0, "image")) : null,
  );
}

/**
 * The live turn's last line: what the agent is doing, shimmering, with Tern's own timer. Its latest
 * thought stands in for the work only while that fold is closed (the web UI's rule); open, the
 * thought is already a row in it.
 */
function workingNode(turn: Turn, cx: ConversationCx, foldOpen: boolean): Node {
  const thought = foldOpen ? null : latestThought(turn);
  const words = cx.chat.status === "compacting" ? "Compacting the context" : cx.chat.status === "stopping" ? "Stopping" : (thought ?? "Working");
  return ui.row(
    { key: "working", role: "awui.working", gap: "sm", align: "center" },
    ui.spinner({ key: "s", style: "braille", tone: "accent" }),
    ui.shimmer({ key: "w", text: words }),
    turn.startedAt !== undefined ? ui.elapsed({ key: "t", age: cx.age(`${turn.id}~start`, turn.startedAt) ?? 0 }) : null,
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
  let liveOpen = false;
  segments.forEach((segment, i) => {
    const place = segments.length === 1 ? "only" : i === 0 ? "first" : i === segments.length - 1 ? "last" : "middle";
    const live = turn.live && (place === "last" || place === "only") && turn.workAfter.length === 0;
    const work = segment.items.filter((item) => !(item.kind === "assistant" && !item.thinking.trim() && !item.text.trim()));
    const answerThought = segment.answerAt >= 0 && turn.answer?.thinking.trim() ? turn.answer : null;
    if (work.length > 0 || answerThought) {
      const key = segment.key;
      const open = cx.folds.get(key) ?? live;
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
            head: [span(foldHead(turn, segment, place), "muted")],
            collapsible: true,
            collapsed: !open,
            onToggle: (e) => cx.on.fold(key, !e.collapsed),
          },
          ui.col({ key: "items", gap: "sm" }, children),
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
  if (answer?.text.trim()) parts.push(ui.md({ key: "answer", role: "awui.reply", stream: answer.streaming, actions: { menu: ["copy"] } }, answer.text));
  // Work the agent did after writing its reply: its own fold below it.
  const after = workAfterSegment(turn);
  if (after) {
    const open = cx.folds.get(after.key) ?? turn.live;
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
          head: [span(foldHead(turn, after, "last"), "muted")],
          collapsible: true,
          collapsed: !open,
          onToggle: (e) => cx.on.fold(after.key, !e.collapsed),
        },
        ui.col({ key: "items", gap: "sm" }, children),
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
    const files: (string | Span)[] = [span(`Changed ${plural(turn.changedFiles.length, "file")} `, "muted")];
    turn.changedFiles.slice(0, 6).forEach((f, i) => {
      if (i > 0) files.push(span(", ", "dim"));
      files.push(span(shortPath(f, ws), "path", { href: fileUrl(f, ws) }));
    });
    if (turn.changedFiles.length > 6) files.push(span(` and ${turn.changedFiles.length - 6} more`, "dim"));
    parts.push(ui.text({ key: "changed", role: "awui.changed" }, files));
  }
  for (const n of turn.after) parts.push(ui.text({ key: n.id, role: "awui.after" }, span(n.text, n.level === "error" ? "error" : "muted")));
  return ui.col({ key: turn.id, role: "awui.turn", gap: "md" }, parts);
}

/** The chat's header: title, harness, state, project. */
export function headNode(chat: ChatState | null, harness: HarnessStatus | null, project: string | null, asks: boolean): Node {
  const status = chat?.status ?? "idle";
  const busy = isBusy(status);
  const state = asks ? "Needs you" : chat?.gone ? chat.gone : STATUS_LABEL[status];
  const stateClass = asks ? "state asks" : status === "error" ? "state failed" : busy ? "state busy" : "state";
  return ui.row(
    { key: "head", role: "awui.head" },
    ui.text({ key: "title", role: "awui.title", text: chat?.title || "New chat", truncate: "end", grow: 1 }),
    harness ? html.span({ key: "harness", class: "harness", text: harness.displayName }) : null,
    html.span({ key: "state", class: stateClass, text: state }),
    project ? ui.text({ key: "project" }, span(project, "muted")) : null,
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
