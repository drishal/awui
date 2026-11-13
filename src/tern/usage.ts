// The Usage screen of the Tern client: what the chats spent (the server's
// /api/usage report, the web UI's Usage dialog) and how full the plan limits
// are, as an overlay in Tern's layer. The figures are worked out apart from the
// drawing (every number and word from web/usage.ts, as the dialog words them),
// so they are tested without Tern; usageNode only lays them out, with the
// richest kind this terminal announced for each part and plain text for a
// terminal that announced none. Tern never takes the keyboard: app.ts keeps the
// range and the scrolling, and closes the screen on Esc.
import { span, ui, type Node } from "@stencil-hq/tern";
import type { LimitAccount, UsageLimits, UsageReport, UsageTotals } from "../shared/protocol.js";
import { cacheShare, dayBars, dayLabels, dollars, shortTokens, tokensOf } from "../web/usage.js";
import { accountName } from "../atui/format.js";
import { resetsIn } from "../web/limit-words.js";

/** The ranges the screen offers, in days, as the web UI's dialog does. */
export const RANGES = [7, 30, 90] as const;
export type UsageRange = (typeof RANGES)[number];

/** The scroll container's node id inside the layer, for `surface.scroll`. */
export const USAGE_SCROLL_ID = "layer.usage.body";

/** The screen while it is open: the range, and the report once it has come (or why it did not). */
export interface UsageScreen {
  days: UsageRange;
  report: UsageReport | null;
  error: string | null;
  /** A report is being read: the one shown (if any) is for another range or older. */
  busy: boolean;
}

/** The range `by` steps from `days` (-1 shorter, 1 longer), stopping at the ends. */
export function stepRange(days: UsageRange, by: number): UsageRange {
  const i = RANGES.indexOf(days) + by;
  return RANGES[Math.min(RANGES.length - 1, Math.max(0, i))] ?? days;
}

/** One total as a tile: "Tokens", "1.2M", "34 model calls". */
export interface Figure {
  label: string;
  value: string;
  sub: string;
  tone?: "accent" | "success" | "warning" | "rare";
}

const cost = (t: UsageTotals) => dollars(t.cost, t.calls > t.unpriced);
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** The totals as the dialog's cards: tokens, output, the cache's share, cost (only what the harnesses priced), chats. */
export function figures(report: UsageReport): Figure[] {
  const t = report.totals;
  const share = cacheShare(t);
  return [
    { label: "Tokens", value: shortTokens(tokensOf(t)), sub: plural(t.calls, "model call", "model calls"), tone: "accent" },
    { label: "Output", value: shortTokens(t.output), sub: `${shortTokens(t.input)} fresh input` },
    { label: "From cache", value: share === null ? "—" : `${Math.round(share * 100)}%`, sub: `${shortTokens(t.cachedInput)} input tokens`, tone: "success" },
    { label: "Cost", value: cost(t), sub: t.unpriced > 0 ? `${plural(t.unpriced, "call", "calls")} not priced` : "every call priced", tone: "rare" },
    { label: "Chats", value: t.sessions.toLocaleString(), sub: `with calls in ${report.days} days` },
  ];
}

/** A day's bar: its height in tokens, the date under it where it is labelled, and the hover text. */
export interface DayPoint {
  value: number;
  label?: string;
  title: string;
}

/** The days of the chart, oldest first; the hover names the day, its tokens, and each harness's part when there are several. */
export function dayPoints(report: UsageReport, name: (harnessId: string) => string): DayPoint[] {
  const bars = dayBars(report);
  const labels = dayLabels(bars.map((b) => b.day), report.days <= 7 ? 1 : report.days <= 30 ? 5 : 15);
  return bars.map((b, i) => ({
    value: b.total,
    ...(labels[i] ? { label: labels[i] } : {}),
    title: `${b.day}: ${shortTokens(b.total)} tokens${b.segments.length > 1 ? ` (${b.segments.map((s) => `${name(s.harnessId)} ${shortTokens(s.tokens)}`).join(", ")})` : ""}`,
  }));
}

/** One line of a breakdown: a harness or a model, its share of the largest in the list, its tokens and cost. */
export interface Row {
  id: string;
  name: string;
  share: number;
  tokens: string;
  cost: string;
}

function rowsOf(list: Array<{ id: string; name: string; totals: UsageTotals }>): Row[] {
  const most = Math.max(1, ...list.map((x) => tokensOf(x.totals)));
  return list.map((x) => ({ id: x.id, name: x.name, share: tokensOf(x.totals) / most, tokens: shortTokens(tokensOf(x.totals)), cost: cost(x.totals) }));
}

/** The harnesses, most tokens first (the report's order). */
export const harnessRows = (report: UsageReport, name: (harnessId: string) => string): Row[] => rowsOf(report.byHarness.map((h) => ({ id: h.harnessId, name: name(h.harnessId), totals: h.totals })));

/** The models, most tokens first; a model run by several harnesses names them. */
export const modelRows = (report: UsageReport, name: (harnessId: string) => string): Row[] =>
  rowsOf(report.byModel.map((m) => ({ id: m.model, name: m.harnesses.length > 1 ? `${m.model} (${m.harnesses.map(name).join(", ")})` : m.model, totals: m.totals })));

/** What the dialog's foot says: where the numbers come from, what is missing from them, and a stop for time. */
export function notes(report: UsageReport): string[] {
  const out = ["Read from the harnesses' own session files, never by starting one."];
  const gone = report.unreadable;
  if (gone.length > 0) out.push(`${gone.join(", ")} ${gone.length === 1 ? "keeps" : "keep"} sessions in a database of its own, so ${gone.length === 1 ? "its" : "their"} calls are not counted.`);
  if (report.truncated) out.push(`Stopped after ${report.scanned} of ${report.total} chats to stay quick.`);
  return out;
}

/** One limit window: "Claude 5 hours", how full (null when the source gives only a status), and "42% · resets in 2h 10m". */
export interface WindowRow {
  id: string;
  label: string;
  used: number | null;
  total: string;
}

export interface AccountRows {
  id: string;
  /** "Claude · Max", "ChatGPT · limited". */
  name: string;
  limited: boolean;
  windows: WindowRow[];
}

/** The plan limits an account at a time, a row a window, in the harness's own order. */
export function accountRows(accounts: LimitAccount[], now: number): AccountRows[] {
  return accounts.map((a) => ({
    id: a.id,
    name: [accountName(a), a.plan, a.limited ? "limited" : null].filter(Boolean).join(" · "),
    limited: a.limited,
    windows: a.windows.map((w, i) => ({
      // Two limits may share a window's name.
      id: `${i}`,
      label: `${accountName(a)} ${w.label}`,
      used: w.used,
      total: [w.used === null ? "no figure" : `${Math.round(w.used * 100)}%`, w.resetsAt ? `resets ${resetsIn(w.resetsAt, now)}` : null].filter(Boolean).join(" · "),
    })),
  }));
}

export interface UsageCx {
  screen: UsageScreen;
  limits: UsageLimits | null;
  name: (harnessId: string) => string;
  /** Whether this terminal announced the kind (session.caps.kinds). */
  supports: (kind: string) => boolean;
  now: number;
  on: { close: () => void; range: (days: UsageRange) => void };
}

const muted = (key: string, text: string) => ui.text({ key }, span(text, "muted"));

/** A heading over a part of the screen. */
const heading = (key: string, text: string) => ui.text({ key }, span(text, "strong"));

/** The plan limits: a meter a window where the terminal draws meters, else a line each. */
function limitsNode(cx: UsageCx): Node | null {
  const accounts = accountRows(cx.limits?.accounts ?? [], cx.now);
  const errors = cx.limits?.errors ?? [];
  if (accounts.length === 0 && errors.length === 0) return null;
  const meters = cx.supports("meter");
  return ui.col(
    { key: "limits", gap: "xs" },
    heading("h", "Plan limits"),
    accounts.map((a) =>
      ui.col(
        { key: `a${a.id}`, gap: "xs" },
        ui.text({ key: "n" }, span(a.name, a.limited ? "error" : "muted")),
        a.windows.map((w) =>
          meters && w.used !== null
            ? ui.meter({ key: `w${w.id}`, value: w.used, thresholds: { warn: 0.7, bad: 0.9 }, label: w.label, total: w.total })
            : ui.text({ key: `w${w.id}` }, span(`${w.label}  `), span(w.total, "muted")),
        ),
      ),
    ),
    errors.map((e, i) => ui.text({ key: `e${i}` }, span(e, "warning"))),
  );
}

/** The totals as tiles, else key-value rows, else lines. */
function figuresNode(report: UsageReport, supports: UsageCx["supports"]): Node {
  const list = figures(report);
  if (supports("stats")) return ui.stats({ key: "totals", items: list.map((f) => ({ label: f.label, value: f.value, sub: f.sub, ...(f.tone ? { tone: f.tone } : {}) })) });
  if (supports("kv")) return ui.kv({ key: "totals", layout: "grid", items: list.map((f) => ({ k: f.label, v: [span(f.value), span(`  ${f.sub}`, "muted")] })) });
  return ui.col({ key: "totals" }, list.map((f, i) => ui.text({ key: `f${i}` }, span(`${f.label}: ${f.value}`), span(`  ${f.sub}`, "muted"))));
}

/** The days as bars, else a line a day that had calls. */
function chartNode(report: UsageReport, name: UsageCx["name"], supports: UsageCx["supports"]): Node {
  const points = dayPoints(report, name);
  const total = `${shortTokens(tokensOf(report.totals))} tokens in ${report.days} days`;
  if (supports("chart")) return ui.col({ key: "days", gap: "xs" }, heading("h", "Tokens by day"), ui.chart({ key: "c", kind: "bars", size: "md", min: 0, summary: total, series: points.map((p) => ({ value: p.value, title: p.title, ...(p.label ? { label: p.label } : {}) })) }));
  return ui.col(
    { key: "days", gap: "xs" },
    heading("h", "Tokens by day"),
    muted("s", total),
    points.filter((p) => p.value > 0).slice(-14).map((p, i) => ui.text({ key: `d${i}` }, span(p.title))),
  );
}

/** A breakdown as a table with a bar in each row, else key-value rows, else lines. */
function breakdownNode(key: string, title: string, noun: string, rows: Row[], supports: UsageCx["supports"]): Node {
  if (rows.length === 0) return ui.col({ key, gap: "xs" }, heading("h", title), muted("none", "No calls in this range"));
  if (supports("table")) {
    return ui.col(
      { key, gap: "xs" },
      heading("h", title),
      ui.table({
        key: "t",
        cols: [
          { id: "name", head: noun, grow: 2, truncate: "end" },
          { id: "bar", head: "", priority: 2, grow: 1 },
          { id: "tokens", head: "Tokens", align: "end", mono: true },
          { id: "cost", head: "Cost", align: "end", mono: true },
        ],
        rows: rows.map((r) => ({ id: r.id, cells: { name: r.name, bar: { meter: { value: r.share } }, tokens: r.tokens, cost: r.cost } })),
      }),
    );
  }
  if (supports("kv")) return ui.col({ key, gap: "xs" }, heading("h", title), ui.kv({ key: "t", items: rows.map((r) => ({ k: r.name, v: [span(r.tokens), span(`  ${r.cost}`, "muted")] })) }));
  return ui.col({ key, gap: "xs" }, heading("h", title), rows.map((r, i) => ui.text({ key: `r${i}` }, span(`${r.name}  ${r.tokens}`), span(`  ${r.cost}`, "muted"))));
}

/** The report's parts, top to bottom. */
function reportNode(report: UsageReport, cx: UsageCx): Node {
  return ui.col(
    { key: "report", gap: "md" },
    figuresNode(report, cx.supports),
    chartNode(report, cx.name, cx.supports),
    breakdownNode("harness", "By harness", "Harness", harnessRows(report, cx.name), cx.supports),
    breakdownNode("model", "By model", "Model", modelRows(report, cx.name), cx.supports),
    ui.col({ key: "notes" }, notes(report).map((n, i) => muted(`n${i}`, n))),
  );
}

/** The Usage overlay: the plan limits, then the report (or the wait for it, or why there is none), in a scroll container. */
export function usageNode(cx: UsageCx): Node {
  const { screen } = cx;
  const waiting = screen.busy
    ? ui.row({ key: "busy", gap: "sm", align: "center" }, ui.spinner({ key: "s" }), ui.text({ key: "t" }, span(screen.report ? `Reading the last ${screen.days} days…` : "Reading sessions…", "muted")))
    : null;
  const failed = screen.error ? ui.text({ key: "error" }, span(`Could not read usage: ${screen.error}`, "error")) : null;
  // A sheet down the right edge rather than a floating card: Usage is a screen to read and scroll, and the
  // conversation behind it stays visible on the left (the web UI's Usage dialog is a wide panel too).
  return ui.overlay(
    {
      key: "usage",
      side: "right",
      variant: "inset",
      size: "lg",
      head: "Usage",
      meta: `last ${screen.days} days`,
      end: ui.row(
        { key: "end", gap: "sm", align: "center" },
        // The range as a segmented switch, beside the keys that step it: ←/→ still work.
        ui.buttons(
          { key: "range", variant: "joined", size: "sm", label: "Range" },
          RANGES.map((days) => ui.button({ key: `r${days}`, text: `${days} days`, size: "sm", on: days === screen.days, variant: days === screen.days ? "primary" : "quiet", onClick: () => cx.on.range(days) })),
        ),
        ui.button({ key: "close", text: "Close", keys: ["esc"], variant: "quiet", size: "sm", onClick: cx.on.close }),
      ),
      foot: ui.text({ key: "keys" }, span("←/→ range (7, 30, 90 days) · ↑/↓ Space Home End scroll · Esc closes", "muted")),
    },
    ui.scroll(
      { key: "body", gap: "md" },
      waiting,
      failed,
      limitsNode(cx),
      // The report of the last range stays while the next is read; a failed read leaves none to show.
      screen.report ? reportNode(screen.report, cx) : null,
    ),
  );
}
