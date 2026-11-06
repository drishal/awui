// The bottom of the pane, which Tern keeps pinned while the chat scrolls: the
// agent's questions and approvals, what waits to run next, the git row, the
// composer card (Tern's editor and the chips under it, as the web UI's
// composer), and a status strip. Pure apart from the handlers it attaches.
import { span, ui, html, type Node, type Span } from "@stencil-hq/tern";
import type { GitStatus, HarnessStatus, InteractionRequest, UsageLimits } from "../shared/protocol.js";
import type { ChatState } from "../web/chat-state.js";
import { isBusy } from "../web/session-groups.js";
import { blanks } from "../web/prompt-blanks.js";
import { accountName, tokens, windowLabel } from "../atui/format.js";
import { optionsOf } from "../atui/requests.js";
import type { Connection } from "../atui/client.js";
import { selection, type Draft } from "./draft.js";

/** The editor's node id, for focus and caret-anchored menus. */
export const EDITOR_ID = "dock.d.comp.ed";
/** A text question's input. */
export const ANSWER_ID = "dock.d.req.in";

/**
 * Whether the client can take input for a real screen, which is when the editor stops asking Tern to hold what
 * is typed: the server has answered (a shown chat's stream is connected, or a chat that is gone says so; the
 * start screen has its data) and that screen is the one drawn, not a session still opening.
 */
export function inputReady(s: { chat: { gone?: string } | null; conn: Connection | "idle"; booted: boolean; opening: boolean }): boolean {
  if (s.opening) return false;
  return s.chat ? s.chat.gone !== undefined || s.conn === "connected" : s.booted;
}

export interface DockCx {
  chat: ChatState | null;
  harness: HarnessStatus | null;
  git: GitStatus | null;
  limits: UsageLimits | null;
  connected: boolean;
  /** True until the client can take input for a real screen (inputReady); Tern buffers what the user typed meanwhile. */
  typeahead: boolean;
  version: string;
  project: string | null;
  draft: Draft;
  /** What Tab would add (a slash command's rest). */
  ghost: string;
  /** A prompt being edited: Enter replaces it. */
  editing: number | null;
  /** The text typed for a question that wants text. */
  answer: Draft;
  /** The C-x prefix is waiting for its key. */
  leader: boolean;
  /** The todo card is open (it starts open, as the web UI's does). */
  todosOpen: boolean;
  on: {
    toggleTodos: (open: boolean) => void;
    send: () => void;
    stop: () => void;
    answer: (request: InteractionRequest, index: number) => void;
    submitText: (request: InteractionRequest) => void;
    cancel: (request: InteractionRequest) => void;
    pickHarness: () => void;
    pickModel: () => void;
    pickThinking: () => void;
    pickPermission: () => void;
    sessions: () => void;
    palette: () => void;
    dropStep: (index: number) => void;
    resumeChain: () => void;
    focusEditor: () => void;
    focusAnswer: () => void;
    editDraft: (e: { from: number; to: number; text: string; cursor: number; len: number }) => void;
    editAnswer: (e: { from: number; to: number; text: string; cursor: number; len: number }) => void;
    undoDraft: () => void;
    sendText: (text: string) => void;
  };
}

/** The draft's @mentions and {{blanks}}, coloured in the editor. */
export function decorations(text: string): Array<{ from: number; to: number; s: string }> {
  const out: Array<{ from: number; to: number; s: string }> = [];
  for (const m of text.matchAll(/(^|\s)(@[^\s@]+)/g)) {
    const from = (m.index ?? 0) + (m[1] as string).length;
    out.push({ from, to: from + (m[2] as string).length, s: "accent" });
  }
  for (const b of blanks(text)) out.push({ from: b.start, to: b.end, s: "warning mark" });
  return out;
}

/** What the composer asks for, by state: the web UI's placeholders. */
export function placeholder(chat: ChatState | null, harness: HarnessStatus | null, editing: number | null): string {
  if (editing !== null) return `Edit message ${editing}: Enter runs it again, Esc keeps the original`;
  if (!chat) return harness ? `Message ${harness.displayName}… (/ commands, @ files, # saved prompts)` : "Message the agent…";
  if (chat.status === "running") return chat.capabilities.supportsSteer ? "Steer the agent…" : chat.capabilities.supportsFollowUp ? "Queue a follow-up…" : "The agent is working…";
  if (chat.status === "compacting") return "Compacting the context…";
  return "Message the agent…";
}

/** An approval's three answers as Tern's ask panel has them: the option each button sends. */
export interface AskShape {
  allow: number;
  deny: number;
  /** "Always allow" or "Allow for this session", when the harness offers one. */
  always: number | null;
}

/**
 * Whether a request is a yes/no the tool row's ask panel can draw: an approval (Approve, Deny), or Allow once,
 * one standing allowance, and Deny (Claude Code, OpenCode). Anything else (a question, more choices) stays a card.
 */
export function askShape(r: InteractionRequest): AskShape | null {
  const options = optionsOf(r);
  if (options.length < 2 || options.length > 3) return null;
  const labels = options.map((o) => o.label.toLowerCase());
  const deny = labels.findIndex((l) => l === "deny");
  const allow = labels.findIndex((l) => l === "approve" || l === "allow once");
  if (deny < 0 || allow < 0) return null;
  const always = labels.findIndex((l, i) => i !== deny && i !== allow && (l.startsWith("always allow") || l.startsWith("allow for this session")));
  if (options.length === 3 && always < 0) return null;
  return { allow, deny, always: always < 0 ? null : always };
}

/** The icon a request's words suggest (a request names no tool, only its title and message). */
export function askIcon(r: InteractionRequest): string {
  const words = `${r.title} ${r.message ?? ""}`;
  if (/\b(bash|shell|command|run|exec)/i.test(words)) return "bash";
  if (/\b(edit|patch)/i.test(words)) return "edit";
  if (/\b(write|create)/i.test(words)) return "write";
  if (/\b(fetch|web|url|http)/i.test(words)) return "web";
  if (/\b(read|open)/i.test(words)) return "read";
  return "";
}

/** An approval as a tool row waiting for its yes: Tern draws the buttons, and a click reaches `answer` with the option's index. */
function approvalNode(r: InteractionRequest, shape: AskShape, cx: DockCx): Node {
  const options = optionsOf(r);
  const first = (r.message ?? "").split("\n").find((l) => l.trim()) ?? "";
  const name = askIcon(r);
  const key = (i: number) => (i < 9 ? ` · ${i + 1}` : "");
  const alwaysLabel = shape.always === null ? null : options[shape.always]?.label.replace(/ \(.*\)$/, "");
  const alwaysTitle = shape.always === null ? undefined : options[shape.always]?.label;
  return ui.tool(
    {
      key: "req",
      role: "awui.approval",
      name,
      title: r.title.replace(/\?$/, ""),
      ...(first ? { target: first, targetKind: name === "bash" ? "command" : "text" } : {}),
      status: "ask",
      confirm: "card",
      ask: {
        allow: `${options[shape.allow]?.label ?? "Approve"}${key(shape.allow)}`,
        deny: `Deny${key(shape.deny)}`,
        always: alwaysLabel === null || alwaysLabel === undefined ? false : `${alwaysLabel}${key(shape.always as number)}`,
      },
      ...(alwaysTitle && alwaysTitle !== alwaysLabel ? { intent: alwaysTitle } : {}),
      onAction: {
        allow: () => cx.on.answer(r, shape.allow),
        deny: () => cx.on.answer(r, shape.deny),
        ...(shape.always !== null ? { always: () => cx.on.answer(r, shape.always as number) } : {}),
      },
    },
    r.message && (r.message.includes("\n") || r.message.length > 120) ? ui.text({ key: "m", text: r.message }) : null,
  );
}

function requestNode(r: InteractionRequest, cx: DockCx): Node {
  const shape = askShape(r);
  if (shape) return approvalNode(r, shape, cx);
  const options = optionsOf(r);
  const text = r.kind === "input" || r.kind === "editor";
  const buttons = options.map((o, i) =>
    html.button(
      {
        key: `o${i}`,
        class: `answer${i === 0 && (o.recommended || o.label === "Approve") ? " primary" : ""}${o.label === "Deny" ? " deny" : ""}`,
        title: o.detail ?? o.label,
        onClick: () => cx.on.answer(r, i),
      },
      i < 9 ? html.span({ key: "n", class: "n", text: String(i + 1) }) : null,
      o.label,
    ),
  );
  if (text) {
    buttons.push(html.button({ key: "ok", class: "answer primary", text: "Send ⏎", onClick: () => cx.on.submitText(r) }));
  }
  // An approval's Esc is its Deny, already a button; anything else can be skipped.
  const approval = options.length === 2 && options[1]?.label === "Deny";
  if (!approval) buttons.push(html.button({ key: "skip", class: "answer", text: "Skip · Esc", onClick: () => cx.on.cancel(r) }));
  const details = options.some((o) => o.detail) && options.length > 2;
  return ui.col(
    { key: "req", role: "awui.request" },
    ui.row({ key: "h", gap: "sm", align: "center" }, ui.icon({ key: "i", name: options.length === 2 ? "shield" : "question", tone: "warning" }), ui.text({ key: "t", role: "awui.request-title", text: r.title, grow: 1 })),
    r.message ? ui.md({ key: "m" }, r.message) : null,
    details
      ? ui.col(
          { key: "d", gap: "xs" },
          options.map((o, i) => (o.detail ? ui.text({ key: `d${i}` }, span(`${i + 1}. ${o.label}`, "strong"), span(` — ${o.detail}`, "muted")) : null)),
        )
      : null,
    text
      ? ui.input({
          key: "in",
          text: cx.answer.text,
          cursor: cx.answer.cursor,
          ...(cx.answer.anchor !== null ? { anchor: cx.answer.anchor } : {}),
          placeholder: r.placeholder ?? "Your answer",
          onFocus: cx.on.focusAnswer,
          onEdit: cx.on.editAnswer,
        })
      : null,
    ui.row({ key: "b", role: "awui.request-buttons" }, buttons),
  );
}

/** What runs next: steering and follow-ups the harness queued, and the server's chain. */
function queueNode(chat: ChatState, cx: DockCx): Node | null {
  const rows: Node[] = [];
  chat.queue.steering.forEach((t, i) => rows.push(ui.text({ key: `s${i}`, truncate: "end" }, span("↳ steer ", "accent"), t)));
  chat.queue.followUp.forEach((t, i) => rows.push(ui.text({ key: `f${i}`, truncate: "end" }, span("⏵ next ", "accent"), t)));
  chat.chain.forEach((step, i) => {
    const label = step.kind === "handoff" ? `hand off to ${step.harness}` : step.text;
    rows.push(
      ui.row(
        { key: `c${i}`, gap: "sm", align: "center" },
        ui.text({ key: "t", truncate: "end", grow: 1 }, span(`then ${i + 1} `, "accent"), label),
        ui.icon({ key: "x", name: "x", title: "Remove this step", aria: "Remove this step", onClick: () => cx.on.dropStep(i) }),
      ),
    );
  });
  if (chat.chainPaused && chat.chain.length > 0) {
    rows.push(ui.row({ key: "paused", gap: "sm", align: "center" }, ui.text({ key: "t", grow: 1 }, span(`Paused: ${chat.chainPaused}`, "warning")), html.button({ key: "go", class: "chip", text: "Resume", onClick: cx.on.resumeChain })));
  }
  return rows.length > 0 ? ui.col({ key: "queue", role: "awui.queue" }, rows) : null;
}

/** The todo list as the web UI's status stack shows it: a "Todos 1/3" card over the composer, each item's phase beside it. */
function todosNode(chat: ChatState, cx: DockCx): Node {
  const status = (s: string) => (s === "completed" || s === "done" ? "done" : s === "in_progress" || s === "active" ? "active" : "pending");
  const done = chat.todos.filter((t) => status(t.status) === "done").length;
  // Todos in a row under one phase share its heading, which keeps each item to one line.
  const phases: Array<{ id: string; title?: string; items: Array<{ id: string; text: string; status: string }> }> = [];
  chat.todos.forEach((t, i) => {
    const last = phases.at(-1);
    const item = { id: String(i), text: t.text, status: status(t.status) };
    if (last && last.title === t.phase) last.items.push(item);
    else phases.push({ id: `p${phases.length}`, ...(t.phase ? { title: t.phase } : {}), items: [item] });
  });
  return ui.card(
    {
      key: "todo",
      role: "awui.todos",
      head: [span("Todos", "strong"), span(`  ${done}/${chat.todos.length}`, "muted")],
      collapsible: true,
      collapsed: !cx.todosOpen,
      onToggle: (e) => cx.on.toggleTodos(!e.collapsed),
    },
    cx.todosOpen
      ? ui.checklist({ key: "list", mode: "full", phases })
      : null,
  );
}

/** The composer's git row: branch, how far from upstream, and what changed. */
function gitNode(git: GitStatus): Node {
  const { counts } = git;
  const dirty = counts.staged + counts.changed + counts.untracked + counts.conflicts;
  const sync = [git.ahead ? `↑${git.ahead}` : "", git.behind ? `↓${git.behind}` : ""].filter(Boolean).join(" ");
  const right: (string | Span)[] = [];
  if (git.operation) right.push(span(`${git.operation} in progress  `, "warning"));
  if (dirty === 0) right.push(span("● clean", "success"));
  else {
    right.push(span(`● ${dirty} changed  `, "warning"));
    if (git.added || git.removed) right.push(span(`+${git.added}`, "ins"), span(" "), span(`−${git.removed}`, "del"));
  }
  return ui.row(
    { key: "git", role: "awui.git" },
    ui.icon({ key: "i", name: "git-branch" }),
    ui.text({ key: "b", grow: 1, truncate: "end" }, span(git.branch ?? `detached ${git.head ?? ""}`, "mono"), sync ? span(`  ${sync}`, "muted") : "", git.lastCommit ? span(`  ${git.lastCommit.subject}`, "dim") : ""),
    ui.text({ key: "s" }, right),
  );
}

/** The composer card: the editor, then the harness, model, and thinking chips, the context ring, and Send or Stop. */
function composerNode(cx: DockCx): Node {
  const chat = cx.chat;
  const busy = isBusy(chat?.status);
  const config = chat?.config;
  const model = config?.models.find((m) => m.key === config.model || m.id === config.model);
  const modelLabel = model?.name ?? config?.model ?? null;
  const level = config?.thinkingLevel ?? null;
  const permission = config?.permissionModes?.find((m) => m.id === config.permissionMode);
  const caps = chat?.capabilities ?? cx.harness?.capabilities;
  const percent = chat?.context?.percent ?? null;
  const ready = cx.draft.text.trim() !== "";
  const sel = selection(cx.draft);
  return ui.col(
    { key: "comp", role: busy ? "awui.composer-busy" : "awui.composer" },
    ui.editor({
      key: "ed",
      text: cx.draft.text,
      cursor: cx.draft.cursor,
      ...(sel ? { anchor: cx.draft.anchor as number } : {}),
      placeholder: placeholder(chat, cx.harness, cx.editing),
      ...(cx.ghost ? { ghost: cx.ghost } : {}),
      decor: decorations(cx.draft.text),
      maxLines: 10,
      sendable: true,
      ...(cx.typeahead ? { typeahead: true } : {}),
      aria: "Message",
      onFocus: cx.on.focusEditor,
      onEdit: cx.on.editDraft,
      onUndo: cx.on.undoDraft,
      onSend: (e) => cx.on.sendText(e.text),
    }),
    ui.row(
      { key: "chips", role: "awui.chips", justify: "between" },
      ui.row(
        { key: "l", gap: "sm", align: "center" },
        cx.harness ? html.button({ key: "h", class: "chip harness-chip", text: cx.harness.displayName, title: chat ? "Hand off to another harness (C-x h)" : "The harness for this chat (C-x h)", onClick: cx.on.pickHarness }) : null,
        // Before the first message there is no chat to read the model from: the chips still offer the pickers (picking starts the chat).
        caps?.supportsModelSelection ? html.button({ key: "m", class: "chip", text: `${modelLabel ?? "Model"} ⌄`, title: "Model (C-x m)", onClick: cx.on.pickModel }) : null,
        // The effort glyph goes inside the chip, before its level, as the web UI's thinking chip draws it.
        caps?.supportsThinkingLevel
          ? html.button({ key: "t", class: "chip think", title: "Thinking (C-x t)", onClick: cx.on.pickThinking }, level ? ui.effort({ key: "e", level }) : null, `${level ?? "Thinking"} ⌄`)
          : null,
        // The web UI's permission pill: the mode in force, open mid-run too; a mode that asks nothing is marked.
        chat?.capabilities.supportsPermissionMode && config?.permissionModes?.length
          ? html.button(
              { key: "p", class: permission?.caution ? "chip think caution" : "chip think", title: permission?.description ?? "Permission mode", onClick: cx.on.pickPermission },
              ui.icon({ key: "i", name: "shield" }),
              `${permission?.label ?? config.permissionMode ?? "Default"} ⌄`,
            )
          : null,
      ),
      ui.row(
        { key: "r", gap: "sm", align: "center" },
        percent !== null
          ? ui.meter({ key: "ctx", style: "ring", value: percent / 100, thresholds: { warn: 0.65, bad: 0.9 }, label: `${Math.round(percent)}%`, title: `Context: ${Math.round(percent)}% of ${tokens(chat?.context?.window ?? 0)} tokens` })
          : null,
        busy && !ready
          ? html.button({ key: "go", class: "send stop", text: "■", title: "Stop (Esc Esc)", onClick: cx.on.stop })
          : html.button({ key: "go", class: ready ? "send ready" : "send", text: "↑", title: busy ? "Steer (Enter)" : "Send (Enter)", onClick: cx.on.send }),
      ),
    ),
  );
}

/** The strip under the composer: connection, model, project, the limits closest to running out, and the keys. */
function statusNode(cx: DockCx): Node {
  const chat = cx.chat;
  const config = chat?.config;
  const model = config?.models.find((m) => m.key === config.model || m.id === config.model)?.name ?? config?.model;
  const what = [cx.harness?.displayName, model, config?.thinkingLevel].filter(Boolean).join(" · ");
  const tight = (cx.limits?.accounts ?? [])
    .flatMap((a) => a.windows.filter((w) => w.used !== null).map((w) => ({ a, w })))
    .sort((x, y) => (y.w.used ?? 0) - (x.w.used ?? 0))[0];
  const usage = chat?.usage;
  return ui.status(
    { key: "st" },
    ui.seg({ key: "conn", icon: cx.connected ? "success" : "warning", tone: cx.connected ? "success" : "warning", priority: 9 }, cx.connected ? "Connected" : "Reconnecting"),
    what ? ui.seg({ key: "model", icon: "model", priority: 7 }, what) : null,
    cx.project ? ui.seg({ key: "proj", icon: "folder", priority: 3, min: { w: "14ch" } }, cx.project) : null,
    usage && usage.tokensPerSecond ? ui.seg({ key: "rate", icon: "fast", priority: 2 }, ui.rate({ key: "r", value: Math.round(usage.tokensPerSecond), unit: "tok/s" })) : null,
    usage?.cost ? ui.seg({ key: "cost", icon: "cost", priority: 2 }, usage.cost < 0.01 ? "<$0.01" : `$${usage.cost.toFixed(2)}`) : null,
    tight ? ui.seg({ key: "limit", icon: "gauge", side: "right", priority: 4, tone: (tight.w.used ?? 0) > 0.8 ? "warning" : "neutral" }, `${accountName(tight.a)} ${windowLabel(tight.w.label)} ${Math.round((tight.w.used ?? 0) * 100)}%`) : null,
    ui.seg({ key: "keys", side: "right", priority: 6, actions: { click: "palette" }, onAction: { palette: cx.on.palette } }, cx.leader ? "C-x …" : "C-k commands · C-x more"),
    ui.seg({ key: "v", side: "right", priority: 1 }, cx.version),
  );
}

/** The dock's content. */
export function dock(cx: DockCx): Node {
  const chat = cx.chat;
  const request = chat?.pending[0];
  return ui.col(
    { key: "d", role: "awui.dock" },
    request ? requestNode(request, cx) : null,
    chat ? queueNode(chat, cx) : null,
    chat && chat.todos.length > 0 ? todosNode(chat, cx) : null,
    cx.git ? gitNode(cx.git) : null,
    composerNode(cx),
    statusNode(cx),
  );
}
