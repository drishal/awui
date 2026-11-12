// Groups the flat item list into turns: the user's prompt, the work the agent
// did (folded into one "Worked for …" line), and the final answer. Pattern
// from DeepSeek Harness (process fold) with OpenCode-style tool counts.
import type { AssistantItem, ChatItem, ChatStatus, HtmlRenderRef, NoticeItem, ToolCategory, UserItem } from "../shared/protocol.js";

/** The lines a turn's edits and writes added and removed, over the files they changed. */
export interface ChangeStat {
  added: number;
  removed: number;
  /** How many files the turn changed (0 when the calls named none). */
  files: number;
  /** True when a finished edit reported no line counts, so the sums are a lower bound. */
  partial: boolean;
}

export interface Turn {
  id: string;
  index: number;
  /** 1-based ordinal of stored user turns (what the server's fork `through` counts); 0 for a preamble or a command the harness answered itself. */
  through: number;
  prompt: UserItem | null;
  /** Everything before the answer: thinking, intermediate text, tools, notices, requests. */
  process: ChatItem[];
  answer: AssistantItem | null;
  /** Work that came after the answer — tools the agent called after writing its reply — drawn below it, in order. */
  workAfter: ChatItem[];
  /** Error notices stay visible under the answer instead of inside the fold. */
  errors: NoticeItem[];
  /** Notices that arrived while the agent was idle, shown after the turn. */
  after: NoticeItem[];
  live: boolean;
  startedAt?: number;
  endedAt?: number;
  counts: Partial<Record<ToolCategory, number>>;
  changedFiles: string[];
  /** Lines added and removed by this turn's edits, or null when none reported any (no badge). */
  changeStat: ChangeStat | null;
  /** HTML pages this turn's render calls published, shown full-width above the answer. */
  renders: HtmlRenderRef[];
  /** Plans this turn's calls handed over for review (ExitPlanMode, plan_mode_complete), shown as cards above the answer. */
  plans: Array<{ id: string; plan: string }>;
  /**
   * How many process items came before the answer: the answer's own thought belongs at the end of them.
   * Anything the agent did after writing the answer is in `workAfter`, drawn below the reply.
   */
  answerAt: number;
  /** The model that answered (its last model call), when the harness says. */
  model?: string;
}


/** The most emoji a reaction-sized prompt may carry: more than that reads as art, not as a reaction. */
const REACTION_MAX_CHARS = 12;

/**
 * A prompt made only of emoji (a 👍, a 🎉 with a modifier) reads as a reaction, not as a
 * sentence: the chat draws it small. Letters, digits, and words never count, and anything
 * longer than a couple of emoji does not either.
 */
export function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > REACTION_MAX_CHARS || /\p{L}|\p{Nd}/u.test(trimmed)) return false;
  return /^(?:[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}\s])+$/u.test(trimmed);
}
export function buildTurns(items: ChatItem[], status: ChatStatus): Turn[] {
  const groups: ChatItem[][] = [];
  let current: ChatItem[] = [];
  for (const item of items) {
    if (item.kind === "user" && current.length > 0) {
      groups.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) groups.push(current);

  const busy = status === "running" || status === "stopping" || status === "compacting";
  let userTurns = 0;
  return groups.map((group, index) => {
    const prompt = group[0]?.kind === "user" ? group[0] : null;
    const through = prompt && !prompt.command ? ++userTurns : 0;
    const rest = prompt ? group.slice(1) : group;
    const live = busy && index === groups.length - 1;

    // The answer is the last assistant message with text. When work follows it,
    // it stays the answer only if it reads as a reply: models write their reply
    // and then call a tool (render_html, a todo, omp's yield), and that reply
    // must not drop into the fold as grey process text. Short narration before
    // more work ("Let me check the config") belongs in the fold. The same rule
    // holds live and settled, so nothing changes style when a run ends.
    let answerIndex = -1;
    let workAfter = false;
    // A message streaming straight after a reply, with no tool between (the agent
    // carrying on after a steer or an extension's nudge), may still become the answer:
    // until it says something, the reply is not, so it stays put instead of jumping.
    const tail = rest[rest.length - 1];
    let carryingOn = false;
    if (live && tail?.kind === "assistant" && tail.streaming && !saysSomething(tail.text)) {
      for (let i = rest.length - 2; i >= 0; i--) {
        const item = rest[i] as ChatItem;
        if (item.kind === "tool" || item.kind === "request") break;
        if (item.kind === "assistant" && saysSomething(item.text)) {
          carryingOn = true;
          break;
        }
      }
    }
    for (let i = carryingOn ? -1 : rest.length - 1; i >= 0; i--) {
      const item = rest[i] as ChatItem;
      if (item.kind === "tool" || item.kind === "request") workAfter = true;
      else if (item.kind === "assistant" && (saysSomething(item.text) || item.error)) {
        if (!workAfter || readsAsReply(item.text)) answerIndex = i;
        break;
      }
    }
    const answer = answerIndex >= 0 ? (rest[answerIndex] as AssistantItem) : null;
    const process: ChatItem[] = [];
    // Work that came after the answer: an agent can call tools after writing its reply (a todo, a
    // render, a memory note), and those calls belong below it, not in the fold drawn above it.
    const afterWork: ChatItem[] = [];
    const errors: NoticeItem[] = [];
    const after: NoticeItem[] = [];
    let answerAt = -1;
    rest.forEach((item, i) => {
      if (i === answerIndex) {
        answerAt = process.length;
        return;
      }
      if (item.kind === "notice" && item.ambient) after.push(item);
      else if (item.kind === "notice" && item.level === "error") errors.push(item);
      else if (answerIndex >= 0 && i > answerIndex) afterWork.push(item);
      else process.push(item);
    });

    let model: string | undefined;
    for (const item of rest) if (item.kind === "assistant" && item.model) model = item.model;
    const counts: Partial<Record<ToolCategory, number>> = {};
    const changed = new Set<string>();
    let added = 0;
    let removed = 0;
    let unknown = false;
    const renders: HtmlRenderRef[] = [];
    const plans: Array<{ id: string; plan: string }> = [];
    let startedAt = prompt?.at;
    let endedAt: number | undefined;
    for (const item of rest) {
      if (item.kind === "tool") {
        counts[item.category] = (counts[item.category] ?? 0) + 1;
        if ((item.category === "edit" || item.category === "write") && item.status !== "error") {
          for (const p of item.paths) changed.add(p);
          // The stat counts every line of a diff, including the ones the wire cut, so a cut diff still sums in full.
          // A finished edit with neither a stat nor a diff (a harness that reports none) is what makes the sums a lower bound.
          const stat = item.diffStat ?? item.diff;
          if (stat) {
            added += stat.added;
            removed += stat.removed;
          } else if (item.status === "done") unknown = true;
        }
        if (item.htmlRender) renders.push(item.htmlRender);
        if (item.plan && item.status !== "error") plans.push({ id: item.id, plan: item.plan });
      }
      // Timing comes from the agent's own work, never from notices.
      if (item.kind === "notice") continue;
      const a = "at" in item ? item.at : undefined;
      const e = "endedAt" in item ? item.endedAt : undefined;
      if (startedAt === undefined && a !== undefined) startedAt = a;
      for (const t of [a, e]) if (t !== undefined && (endedAt === undefined || t > endedAt)) endedAt = t;
    }
    return {
      id: prompt?.id ?? `pre-${group[0]?.id ?? index}`,
      index,
      through,
      prompt,
      process,
      workAfter: afterWork,
      answer,
      errors,
      after,
      live,
      ...(startedAt !== undefined ? { startedAt } : {}),
      ...(endedAt !== undefined ? { endedAt } : {}),
      counts,
      changedFiles: [...changed],
      changeStat: added + removed > 0 ? { added, removed, files: changed.size, partial: unknown } : null,
      renders,
      plans,
      answerAt: answerAt >= 0 ? answerAt : process.length,
      ...(model ? { model } : {}),
    };
  });
}

export function sameChangeStat(a: ChangeStat | null, b: ChangeStat | null): boolean {
  return a === b || (a !== null && b !== null && a.added === b.added && a.removed === b.removed && a.files === b.files && a.partial === b.partial);
}

/** A change stat in words, for a screen reader: "42 additions, 7 deletions, 3 files" ("at least 42 …" when partial). */
export function changeStatLabel(stat: ChangeStat, withFiles = true): string {
  const parts = [`${stat.partial ? "at least " : ""}${stat.added} ${stat.added === 1 ? "addition" : "additions"}`, `${stat.removed} ${stat.removed === 1 ? "deletion" : "deletions"}`];
  if (withFiles && stat.files > 0) parts.push(`${stat.files} ${stat.files === 1 ? "file" : "files"}`);
  return parts.join(", ");
}

const COUNT_LABELS: Array<[ToolCategory, string, string]> = [
  ["read", "read", "reads"],
  ["search", "search", "searches"],
  ["edit", "edit", "edits"],
  ["write", "file written", "files written"],
  ["command", "command", "commands"],
  ["web", "web lookup", "web lookups"],
  ["agent", "delegation", "delegations"],
  ["other", "tool call", "tool calls"],
];

/** A stretch of a turn's work, and the reply the agent wrote to the user after it (null for the work after the last one). */
export interface WorkSegment {
  key: string;
  /** The work: tools, notices, requests, and thinking (a reply's own thought stays here, before it). */
  items: ChatItem[];
  reply: AssistantItem | null;
  counts: Partial<Record<ToolCategory, number>>;
  /** Where in `items` the answer's thought goes, or -1 when it is in another stretch. */
  answerAt: number;
}

/**
 * A turn's process in the order it happened: work, a reply to the user, more
 * work, another reply. What the agent writes to the user between tool calls is
 * a reply, shown as one, not grey process text inside the fold ("Reply with X,
 * then run a command, then say done" reads X, the command's fold, done). Only
 * the stretches of work fold away. With no reply between work, there is one
 * stretch: the turn's single fold.
 */
export function workSegments(turn: Turn): WorkSegment[] {
  const segments: WorkSegment[] = [];
  let items: ChatItem[] = [];
  let answerAt = -1;
  const close = (reply: AssistantItem | null) => {
    segments.push({ key: `${turn.id}#${segments.length}`, items, reply, counts: workCounts(items), answerAt });
    items = [];
    answerAt = -1;
  };
  turn.process.forEach((item, i) => {
    if (i === turn.answerAt) answerAt = items.length;
    if (item.kind === "assistant" && saysSomething(item.text)) {
      if (item.thinking.trim()) items.push(item);
      close(item);
      return;
    }
    items.push(item);
  });
  if (turn.answerAt >= turn.process.length) answerAt = items.length;
  if (items.length > 0 || segments.length === 0 || answerAt >= 0) close(null);
  return segments;
}

/** The work the agent did after writing its answer, as a fold of its own below the reply (null when it did none). */
export function workAfterSegment(turn: Turn): WorkSegment | null {
  if (turn.workAfter.length === 0) return null;
  return { key: `${turn.id}#after`, items: turn.workAfter, reply: null, counts: workCounts(turn.workAfter), answerAt: -1 };
}

/**
 * Whether a stretch's fold starts open: the one still running is open, while a stretch that already ends in a
 * reply has been read, so it folds away as the reply lands. A live failed call keeps its stretch open (its
 * failure is being seen now); a settled turn opens nothing, and its failures are read from the tally.
 */
export function segmentStartsOpen(turnOpen: boolean, segment: WorkSegment, failedCalls: number): boolean {
  if (!turnOpen) return false;
  return failedCalls > 0 || segment.reply === null;
}

/** What a stretch of work ran, by kind: the fold's summary line. */
export function workCounts(items: ChatItem[]): Partial<Record<ToolCategory, number>> {
  const counts: Partial<Record<ToolCategory, number>> = {};
  for (const item of items) if (item.kind === "tool") counts[item.category] = (counts[item.category] ?? 0) + 1;
  return counts;
}

/** One category's count, as the fold draws it: the number rolls, the word does not. */
export interface CountPart {
  category: ToolCategory;
  n: number;
  /** "command" for one, "commands" for more. */
  word: string;
}

export function countParts(counts: Turn["counts"]): CountPart[] {
  const parts: CountPart[] = [];
  for (const [category, one, many] of COUNT_LABELS) {
    const n = counts[category] ?? 0;
    if (n > 0) parts.push({ category, n, word: n === 1 ? one : many });
  }
  return parts;
}

export function countSummary(counts: Turn["counts"]): string {
  const parts = countParts(counts).map((p) => `${p.n} ${p.word}`);
  // One quiet line: the first three counts, and the open fold for everything else.
  return parts.length > 3 ? `${parts.slice(0, 3).join(", ")}, …` : parts.join(", ");
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** A tool's name as a row shows it: an MCP tool's `mcp__server__tool` as "tool · server", any other as it is. */
export function toolLabel(name: string): string {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return mcp ? `${mcp[2]} · ${mcp[1]}` : name;
}

/** Show workspace-relative paths when the file is inside the project. */
export function relativePath(path: string, workspace: string): string {
  const base = workspace.endsWith("/") ? workspace : `${workspace}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** "3m ago", "2h ago", "4d ago", else the date. */
export function ago(at: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(at).toLocaleDateString();
}

/** Where the model changes between turns: turn id → the model it switched to. Turns that name no model are skipped over. */
export function modelSwitches(turns: Turn[]): Map<string, string> {
  const switches = new Map<string, string>();
  let last: string | undefined;
  for (const turn of turns) {
    if (!turn.model) continue;
    if (last !== undefined && turn.model !== last) switches.set(turn.id, turn.model);
    last = turn.model;
  }
  return switches;
}

/** A model's display name from the chat's list (by key or id), else what the harness called it. */
export function modelName(model: string, models: ReadonlyArray<{ key: string; id: string; name: string }>): string {
  return models.find((m) => m.key === model || m.id === model)?.name ?? model;
}

/** Text worth a row in the fold: some letter or digit, not a stray "." or blank lines a model sent between tool calls. */
export const saysSomething = (text: string): boolean => /[\p{L}\p{N}]/u.test(text);

/**
 * Text that is a reply rather than a remark before more work: long, or shaped
 * like an answer (paragraphs, a list, a heading, a table, a code block).
 */
export function readsAsReply(text: string): boolean {
  const t = text.trim();
  return t.length >= 280 || /\n\s*\n|^\s*(?:[-*+]|\d+[.)]|#{1,6}|\||```)\s?/m.test(t);
}

/** A live turn's latest thought as one line: the first sentence of the newest thinking (T3 Code's live row). */
export function latestThought(turn: Turn): string | null {
  const steps = [...turn.process, ...(turn.answer ? [turn.answer] : []), ...turn.workAfter];
  for (let i = steps.length - 1; i >= 0; i--) {
    const item = steps[i];
    if (item?.kind !== "assistant") continue;
    const thinking = item.thinking.replace(/\s+/g, " ").trim();
    if (!thinking) continue;
    const sentence = /^.*?[.!?](?=\s|$)/.exec(thinking)?.[0] ?? thinking;
    return sentence.length > 240 ? `${sentence.slice(0, 239)}…` : sentence;
  }
  return null;
}

