// The Timing overlay of the Tern client: one turn's time as the web UI's waterfall (web/waterfall.ts,
// pure), laid out as a table the terminal draws natively: each model step, call, and subagent run a
// row with where it started, how long it took, and its share of the turn; the slowest call and a
// running one marked. Tern never takes the keyboard, so app.ts closes it on Esc and scrolls it; the
// figures never come from here.
import { span, ui, type Node } from "@stencil-hq/tern";
import type { Turn } from "../web/turns.js";
import { atLabel, rowName, turnWaterfall, type WaterfallRow } from "../web/waterfall.js";

/** The scroll container's node id inside the layer, for `surface.scroll`. */
export const TIMING_SCROLL_ID = "layer.timing.body";

export interface TimingCx {
  turn: Turn;
  workspace: string;
  /** The time of this view (epoch ms): a running row ends here. */
  now: number;
  /** Whether this terminal announced the kind (session.caps.kinds). */
  supports: (kind: string) => boolean;
  on: { close: () => void };
}

/** A row's label with what the web UI marks beside it: the slowest call, a run still going. */
function rowLabel(row: WaterfallRow) {
  const spans = [span(row.label)];
  if (row.slowest) spans.push(span("  slowest", "warning"));
  if (row.running) spans.push(span("  running", "accent"));
  if (row.extra) spans.push(span(`  ${row.extra}`, "muted"));
  return spans;
}

/** The rows as a table with a meter a row, else as lines; a terminal with neither still reads them. */
function rowsNode(rows: WaterfallRow[], total: number, supports: TimingCx["supports"]): Node[] {
  if (rows.length === 0) return [ui.text({ key: "none" }, span("The harness did not report times for this turn.", "muted"))];
  if (supports("table")) {
    return [
      ui.table({
        key: "t",
        cols: [
          { id: "name", head: "Step", grow: 3, truncate: "end" },
          { id: "start", head: "Start", align: "end", mono: true, priority: 3 },
          { id: "took", head: "Took", align: "end", mono: true, priority: 2 },
          { id: "share", head: "", priority: 1, grow: 1 },
        ],
        rows: rows.map((row) => ({
          id: row.id,
          title: rowName(row),
          cells: {
            name: rowLabel(row),
            start: atLabel(row.start),
            took: atLabel(row.end - row.start),
            share: total > 0 ? { meter: { value: (row.end - row.start) / total, title: rowName(row) } } : "",
          },
        })),
      }),
    ];
  }
  return rows.map((row) =>
    ui.text(
      { key: row.id, title: rowName(row) },
      span(`${row.label}${row.slowest ? " · slowest" : ""}${row.running ? " · running" : ""}`, row.slowest ? "warning" : "neutral"),
      span(`  ${atLabel(row.start)} → ${atLabel(row.end)}`, "muted"),
      row.extra ? span(`  ${row.extra}`, "dim") : null,
    ),
  );
}

/** The Timing overlay: the total, the axis, and a row per step, call, and subagent run. */
export function timingNode(cx: TimingCx): Node {
  const { rows, total, ticks } = turnWaterfall(cx.turn, cx.workspace, cx.now);
  const end = rows.length > 0 ? Math.max(...rows.map((r) => r.end)) : 0;
  const from = cx.turn.live ? "now" : "settle";
  const axis = ticks.length > 0 ? ui.text({ key: "axis", title: `The turn's axis, from 0 to ${atLabel(total)}` }, span(ticks.map((t) => t.label).join("   ·   "), "muted")) : null;
  return ui.overlay(
    {
      key: "timing",
      anchor: "center",
      size: "lg",
      head: "Timing",
      meta: rows.length > 0 ? `${atLabel(end)} from prompt to ${from}` : "no times",
      end: ui.button({ key: "close", text: "Close", keys: ["esc"], variant: "quiet", size: "sm", onClick: cx.on.close }),
      foot: ui.text({ key: "keys" }, span("↑/↓ PgUp/PgDn Home End scroll · Esc closes", "muted")),
    },
    ui.scroll({ key: "body", gap: "sm" }, axis, ...rowsNode(rows, total, cx.supports)),
  );
}
