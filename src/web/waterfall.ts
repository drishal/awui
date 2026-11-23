// A turn's time as a waterfall: every model step, tool call, and subagent of the turn as a
// row with a start and an end on one axis (the prompt to the settle), the slowest call marked,
// plus the "nice" axis under it (ticks at round values). Pure, so the dialog only draws and the
// unit tests give the clock. Nothing is invented: an item with no time is left out, a call that
// has not ended yet ends at `now`, a subagent run is placed at its call's start for as long as
// the run reports (its own start is not known), and tokens and cost appear only on the runs
// whose harness reported them (no harness reports them per model step or tool call).
import type { AssistantItem, ChatItem } from "../shared/protocol.js";
import { dollars, shortTokens } from "./usage.js";
import { toolSentence } from "../shared/tool-row.js";
import { formatDuration, type Turn } from "./turns.js";

export type WaterfallKind = "thinking" | "reply" | "tool" | "agent" | "subagent";

export interface WaterfallRow {
  id: string;
  label: string;
  kind: WaterfallKind;
  /** 0 for a step or call, 1 for a subagent run under its call. */
  depth: number;
  /** Milliseconds from the start of the axis (the prompt). */
  start: number;
  end: number;
  /** Still going: it ends at `now`. */
  running: boolean;
  /** The slowest tool call of the turn (only marked when there are two or more calls). */
  slowest: boolean;
  /** What the harness reported for it: "12k tokens · $0.04". Empty when nothing was. */
  extra: string;
}

export interface Waterfall {
  rows: WaterfallRow[];
  /** The axis's length in milliseconds (the last tick). 0 when the turn has no times. */
  total: number;
  /** The turn's real length: from its start to the end of its last step or its settle, before the axis rounds up. 0 when the turn has no times. */
  span: number;
  ticks: Array<{ ms: number; label: string }>;
}

const SUBAGENT_CUT = 48;

/** The step 1, 2, 5 times a power of ten that gives about `target` ticks across `total`. */
export function niceStep(total: number, target = 5): number {
  if (!(total > 0)) return 1;
  const raw = total / target;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/** An axis tick: "0", "250 ms", "2 s", "1.5 s", "2m". */
export function tickLabel(ms: number, step: number): string {
  if (ms === 0) return "0";
  if (step >= 60_000) return `${+(ms / 60_000).toFixed(2)}m`;
  if (ms >= 1000) return `${+(ms / 1000).toFixed(2)} s`;
  return `${Math.round(ms)} ms`;
}

/** The axis for a turn `total` ms long: ticks at round values from 0 up to the first one at or past the end. */
export function niceAxis(total: number): { total: number; ticks: Array<{ ms: number; label: string }> } {
  if (!(total > 0)) return { total: 0, ticks: [] };
  const step = niceStep(total);
  const count = Math.ceil(total / step - 1e-9);
  const ticks = Array.from({ length: count + 1 }, (_, i) => ({ ms: Math.round(i * step * 1e6) / 1e6, label: tickLabel(i * step, step) }));
  return { total: count * step, ticks };
}

/** A moment on the axis as a row's name says it: "412 ms", "38.2 s", "2m 5s". */
export function atLabel(ms: number): string {
  if (ms < 1000) return `${Math.round(Math.max(0, ms))} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return formatDuration(ms);
}

/** The words a row is named by, for the screen reader and the bar's title: "Ran npm test, 0.4 s to 38.2 s, slowest call". */
export function rowName(row: WaterfallRow): string {
  const parts = [row.label, `${atLabel(row.start)} to ${atLabel(row.end)}`];
  if (row.running) parts.push("still running");
  if (row.slowest) parts.push("slowest call");
  if (row.extra) parts.push(row.extra);
  return parts.join(", ");
}

function stepLabel(item: AssistantItem, answer: boolean): { label: string; kind: WaterfallKind } {
  if (item.text && item.thinking) return { label: answer ? "Thinking and answer" : "Thinking and reply", kind: "reply" };
  if (item.text) return { label: answer ? "Answer" : "Reply", kind: "reply" };
  return { label: "Thinking", kind: "thinking" };
}

function runExtra(run: { tokens?: number; cost?: number }): string {
  const parts: string[] = [];
  if (run.tokens !== undefined) parts.push(`${shortTokens(run.tokens)} tokens`);
  if (run.cost !== undefined) parts.push(dollars(run.cost, true));
  return parts.join(" · ");
}

/** The rows of a turn, its axis, and the slowest call. `now` ends whatever is still running. */
export function turnWaterfall(turn: Turn, workspace: string, now: number): Waterfall {
  const items: Array<{ item: ChatItem; answer: boolean }> = [
    ...turn.process.map((item) => ({ item, answer: false })),
    ...(turn.answer ? [{ item: turn.answer, answer: true }] : []),
    ...turn.workAfter.map((item) => ({ item, answer: false })),
  ];
  type Raw = Omit<WaterfallRow, "start" | "end" | "slowest"> & { at: number; endAt: number };
  const raw: Raw[] = [];
  for (const { item, answer } of items) {
    if (item.kind === "assistant") {
      if (item.at === undefined || (!item.text && !item.thinking)) continue;
      const { label, kind } = stepLabel(item, answer);
      raw.push({ id: item.id, label, kind, depth: 0, at: item.at, endAt: item.streaming ? now : Math.max(item.at, item.endedAt ?? item.at), running: item.streaming, extra: "" });
    } else if (item.kind === "tool") {
      if (item.at === undefined) continue;
      const running = item.status === "running" && item.endedAt === undefined;
      const endAt = running ? now : Math.max(item.at, item.endedAt ?? item.at);
      raw.push({ id: item.id, label: toolSentence(item, workspace).text, kind: item.category === "agent" ? "agent" : "tool", depth: 0, at: item.at, endAt, running, extra: "" });
      for (const run of item.subagents?.runs ?? []) {
        const live = run.status === "running" || run.status === "pending";
        const ms = run.durationMs ?? (live ? Math.max(0, now - item.at) : undefined);
        if (ms === undefined) continue;
        const task = run.task.replace(/\s+/g, " ").trim();
        const label = `${run.agent}${task ? `: ${task.length > SUBAGENT_CUT ? `${task.slice(0, SUBAGENT_CUT - 1)}…` : task}` : ""}`;
        raw.push({ id: `${item.id}:${run.id}`, label, kind: "subagent", depth: 1, at: item.at, endAt: item.at + ms, running: live && run.durationMs === undefined, extra: runExtra(run) });
      }
    }
  }
  if (raw.length === 0) return { rows: [], total: 0, span: 0, ticks: [] };
  const origin = Math.min(turn.prompt?.at ?? Infinity, ...raw.map((r) => r.at));
  const ended = Math.max(...raw.map((r) => r.endAt), turn.live ? now : (turn.endedAt ?? 0));
  const axis = niceAxis(Math.max(ended - origin, 1));
  // The slowest top-level tool call; a lone call, or calls that were all instant, is not "the slowest" of anything.
  const calls = raw.filter((r) => r.depth === 0 && (r.kind === "tool" || r.kind === "agent"));
  let slowestId: string | undefined;
  if (calls.length >= 2) {
    let best = 0;
    let second = 0;
    for (const r of calls) {
      const took = r.endAt - r.at;
      if (took > best) {
        second = best;
        best = took;
        slowestId = r.id;
      } else if (took > second) second = took;
    }
    // Calls that took about as long as one another have no slowest: a lead of a millisecond is not a finding.
    if (best < second * 1.2) slowestId = undefined;
  }
  const rows = raw.map(({ at, endAt, ...r }) => ({ ...r, start: at - origin, end: endAt - origin, slowest: r.id === slowestId }));
  return { rows, span: Math.max(ended - origin, 0), ...axis };
}
