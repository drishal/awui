// The composer's context chip, opened: what fills the context window, how it got there, and
// what this session has spent, as the web UI's popover (ContextRing.tsx) lays it out. The figures
// come from the chat snapshot (context, its history, the session's usage) and the draft from
// token-estimate.ts, the same modules the web draws; this file only lays them out with the
// richest kinds the terminal announced.
import { span, ui, type Node } from "@stencil-hq/tern";
import type { ChatState } from "../web/chat-state.js";
import type { ContextUsage, SessionUsage } from "../shared/protocol.js";
import { percents } from "../web/sparkline.js";
import { shortTokens } from "../web/usage.js";
import { formatDuration } from "../web/turns.js";
import { draftRow, draftSize, draftWarning, type DraftSize } from "../web/token-estimate.js";
import type { Draft } from "./draft.js";

/** The scroll container's node id inside the layer, for `surface.scroll`. */
export const CONTEXT_SCROLL_ID = "layer.context.body";

export interface ContextCx {
  chat: ChatState;
  draft: Draft;
  /** "Compacted ✓" for a moment after a compaction ended. */
  compacted: boolean;
  /** Whether this terminal announced the kind (session.caps.kinds). */
  supports: (kind: string) => boolean;
  on: { close: () => void };
}

const share = (pct: number) => (pct < 1 ? "<1%" : `${Math.round(pct)}%`);

/** Milliseconds as the web's panel writes them: 800ms, 4.2s, 2m 5s. */
function ms(value: number): string {
  if (value < 1000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  return formatDuration(value);
}

const heading = (key: string, text: string) => ui.text({ key }, span(text, "strong"));

const MUTED = (key: string, text: string) => ui.text({ key }, span(text, "muted"));

/** Rows as key/value when the terminal draws them, else as lines; each row is a label and its value. */
function rowsNode(key: string, rows: Array<{ label: string; value: string; tone?: string }>, supports: ContextCx["supports"]): Node {
  if (supports("kv")) return ui.kv({ key, layout: "grid", items: rows.map((r) => ({ k: r.label, v: r.tone ? [span(r.value, r.tone)] : r.value })) });
  return ui.col({ key }, rows.map((r, i) => ui.text({ key: `${key}${i}` }, span(`${r.label}  `, "muted"), span(r.value, r.tone ?? "neutral"))));
}

/** The categories as a table with a meter a row (the share of the window), else the plain rows. */
function categoriesNode(context: ContextUsage, supports: ContextCx["supports"]): Node | null {
  const categories = (context.categories ?? []).filter((c) => c.tokens > 0);
  if (categories.length === 0) return null;
  if (supports("table")) {
    return ui.col(
      { key: "cats", gap: "xs" },
      heading("h", "What fills the window"),
      ui.table({
        key: "t",
        cols: [
          { id: "name", head: "Part", grow: 2, truncate: "end" },
          { id: "tokens", head: "Tokens", align: "end", mono: true },
          { id: "share", head: "", priority: 1, grow: 3 },
        ],
        rows: categories.map((c) => ({
          id: c.id,
          title: `${c.label}: ${Math.round(c.tokens).toLocaleString()} tokens (estimated)`,
          cells: { name: c.label, tokens: shortTokens(c.tokens), share: { meter: { value: context.window > 0 ? c.tokens / context.window : 0 } } },
        })),
      }),
    );
  }
  return ui.col(
    { key: "cats", gap: "xs" },
    heading("h", "What fills the window"),
    ...categories.map((c) =>
      ui.text({ key: c.id, title: `${Math.round(c.tokens).toLocaleString()} tokens (estimated)` }, span(c.label, "muted"), span(`  ${shortTokens(c.tokens)}`, "strong"), span(`  ${share((c.tokens / context.window) * 100)}`, "dim")),
    ),
  );
}

/** The context's growth, oldest first, on a fixed 0–100 % axis with the 90 % mark drawn (web/sparkline.ts). */
function sparkNode(history: ChatState["contextHistory"], supports: ContextCx["supports"]): Node | null {
  const points = percents(history ?? []);
  if (points.length < 2 || !supports("chart")) return null;
  const first = Math.round(points[0] as number);
  const last = Math.round(points[points.length - 1] as number);
  return ui.chart({
    key: "spark",
    kind: "line",
    size: "sm",
    min: 0,
    max: 100,
    unit: "%",
    series: points.map((value) => ({ value })),
    marks: [{ value: 90, tone: "warning", title: "90% — near the limit" }],
    summary: `Context per turn: ${first}% … ${last}%`,
  });
}

/** The session's tokens and timing, the web panel's "Tokens this session" and "Session" sections. */
function sessionNode(usage: SessionUsage | null, supports: ContextCx["supports"]): Node | null {
  if (!usage || usage.steps === 0) return null;
  const uncached = usage.input + usage.cacheWrite;
  const inputTotal = uncached + usage.cachedInput;
  const cacheHit = inputTotal > 0 ? `${Math.round((usage.cachedInput / inputTotal) * 100)}%` : "—";
  const tokens = [
    { label: "Tokens", value: shortTokens(inputTotal + usage.output) },
    { label: "Cache hit", value: cacheHit },
    { label: "Uncached input", value: shortTokens(uncached) },
    { label: "Cached input", value: shortTokens(usage.cachedInput) },
    { label: "Output", value: shortTokens(usage.output) },
    ...(usage.cost !== null ? [{ label: "Cost", value: `$${usage.cost.toFixed(usage.cost < 1 ? 4 : 2)}` }] : []),
  ];
  const timing = [
    { label: "Turns", value: `${usage.turns} · ${usage.steps} ${usage.steps === 1 ? "step" : "steps"}` },
    { label: "LLM time", value: usage.llmMs !== null ? ms(usage.llmMs) : "—" },
    { label: "Time to first token", value: usage.ttftMs !== null ? ms(usage.ttftMs) : "—" },
    { label: "Tokens per second", value: usage.tokensPerSecond !== null ? `${usage.tokensPerSecond} tok/s` : "—" },
  ];
  return ui.col(
    { key: "session", gap: "sm" },
    ui.col({ key: "tokens", gap: "xs" }, heading("th", "Tokens this session"), rowsNode("tr", tokens, supports)),
    ui.col({ key: "timing", gap: "xs" }, heading("hh", "Session"), rowsNode("sr", timing, supports)),
  );
}

/** The context panel: the headline, its growth, what fills it, the draft's size, and the session. */
export function contextNode(cx: ContextCx): Node {
  const context = cx.chat.context;
  const pct = Math.max(0, Math.min(100, context?.percent ?? 0));
  const size: DraftSize | null = draftSize(cx.draft.text, 0, context ?? null);
  const warning = size ? draftWarning(size, cx.chat.capabilities.supportsCompact) : null;
  const model = cx.chat.config.models.find((m) => m.key === cx.chat.config.model || m.id === cx.chat.config.model)?.name ?? cx.chat.config.model ?? "";
  return ui.overlay(
    {
      key: "context",
      anchor: { node: "dock.d.comp.chips.r.ctx", side: "above" },
      size: "md",
      head: "Context and usage",
      meta: model,
      end: ui.button({ key: "close", text: "Close", keys: ["esc"], variant: "quiet", size: "sm", onClick: cx.on.close }),
      foot: ui.text({ key: "keys" }, span("Esc closes · ↑/↓ PgUp/PgDn scroll", "muted")),
    },
    ui.scroll(
      { key: "body", gap: "md" },
      context
        ? ui.col(
            { key: "headline", gap: "xs" },
            ui.row(
              { key: "h", justify: "between", align: "center" },
              ui.text({ key: "p" }, span(share(pct), "strong"), span(" of context used", "muted")),
              context.tokens !== null ? ui.text({ key: "t" }, span(`${shortTokens(context.tokens)} / ${shortTokens(context.window)}`, "muted")) : ui.text({ key: "t" }, span(`${shortTokens(context.window)} window`, "muted")),
            ),
            sparkNode(cx.chat.contextHistory, cx.supports),
          )
        : MUTED("none", "This harness has not reported the context yet."),
      context ? categoriesNode(context, cx.supports) : null,
      cx.compacted ? ui.text({ key: "compacted" }, span("Compacted ✓", "success")) : null,
      size ? ui.text({ key: "draft" }, [span(draftRow(size), size.near ? "warning" : "muted"), ...(warning ? [span(`  ${warning}`, "warning")] : [])]) : null,
      sessionNode(cx.chat.usage, cx.supports),
    ),
  );
}
