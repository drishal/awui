// Usage: the subscriptions' limits first (a card per account), then what the
// chats spent in the last 7, 30, or 90 days, from the server's report
// (usage-report.ts, read from the harnesses' own files): the totals as cards, a
// bar a day split by harness in its colour, the harnesses and models side by
// side, and the chats that used the most (a click opens one). Days are the
// browser's. Above the bars, a heatmap of the days (heatmap.ts): weeks as
// columns, shaded by tokens or by cost, an arrow-key grid.
import { useEffect, useMemo, useRef, useState } from "react";
import type { HarnessStatus, ProjectSession, UsageLimits, UsageReport, UsageTotals, WorkspaceInfo } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { harnessColor } from "../harness-colors.js";
import { heatMonths, heatmapCells, heatStep, type HeatMetric } from "../heatmap.js";
import { IconRefresh, Spinner } from "../icons.js";
import { ago } from "../turns.js";
import { cacheShare, dayBars, dayLabels, dollars, shortTokens, tokensOf } from "../usage.js";
import { Dialog } from "./Dialog.js";
import { LimitsPanel } from "./LimitsMeter.js";
import { dotted } from "./Dot.js";
import { SlidingIndicator } from "./SlidingIndicator.js";

const RANGES = [7, 30, 90] as const;

function Card({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div className={`usage-card${tone ? ` is-${tone}` : ""}`}>
      <span className="usage-card-label">{label}</span>
      <span className="usage-card-value">{value}</span>
      {sub ? <span className="usage-card-sub">{sub}</span> : null}
    </div>
  );
}

/** A row with a bar: its share of the largest in its list. */
function BarRow({ label, share, value, detail, style }: { label: React.ReactNode; share: number; value: string; detail?: string; style?: React.CSSProperties }) {
  return (
    <div className="usage-bar-row" style={style}>
      <span className="usage-row-label">{label}</span>
      <span className="usage-row-bar" aria-hidden="true">
        <span style={{ width: `${Math.max(2, Math.round(share * 100))}%` }} />
      </span>
      <span className="usage-row-value">{value}</span>
      {detail !== undefined ? <span className="usage-row-detail">{detail}</span> : null}
    </div>
  );
}

const cost = (t: UsageTotals) => dollars(t.cost, t.calls > t.unpriced);

/** "Oct 12 · 1.2M tokens · $3.40" */
function dayText(day: string, t: UsageTotals): string {
  const date = new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${date} · ${shortTokens(tokensOf(t))} tokens · ${cost(t)}`;
}

/** The days as a grid of weeks: one cell a day, shaded by the chosen measure, the last day outlined. One cell is in the tab order; the arrow keys move between them. */
function Heatmap({ byDay }: { byDay: UsageReport["byDay"] }) {
  const [metric, setMetric] = useState<HeatMetric>("tokens");
  const [active, setActive] = useState(byDay.length - 1);
  const [shown, setShown] = useState<number | null>(null);
  const cellRefs = useRef<Array<HTMLDivElement | null>>([]);
  const metricsRef = useRef<HTMLDivElement>(null);
  const { cells, weeks } = useMemo(() => heatmapCells(byDay.map((d) => ({ day: d.day, tokens: tokensOf(d.totals), cost: d.totals.cost })), metric), [byDay, metric]);
  const months = useMemo(() => heatMonths(cells), [cells]);
  const rows = [0, 1, 2, 3, 4, 5, 6];
  const roving = Math.min(active, cells.length - 1);
  const caption = shown !== null ? byDay[shown] : undefined;
  const move = (e: React.KeyboardEvent, i: number) => {
    const to = heatStep(i, e.key, cells.length);
    if (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") e.preventDefault();
    if (to === null) return;
    setActive(to);
    cellRefs.current[to]?.focus();
  };
  if (cells.length === 0) return null;
  return (
    <section className="usage-heat" aria-label="Activity by day">
      <div className="usage-heat-head">
        <h3>Activity</h3>
        <div className="segmented" role="group" aria-label="Shade by" ref={metricsRef}>
          {(["tokens", "cost"] as const).map((m) => (
            <button key={m} type="button" className={m === metric ? "is-on" : undefined} aria-pressed={m === metric} onClick={() => setMetric(m)}>
              {m === "tokens" ? "Tokens" : "Cost"}
            </button>
          ))}
          <SlidingIndicator target={metricsRef} active={metric === "tokens" ? 0 : 1} of="button" className="segmented-pill" />
        </div>
      </div>
      <div className="usage-heat-scroll" data-sparse={weeks < 5 ? "" : undefined} style={{ "--heat-weeks": weeks } as React.CSSProperties}>
        <div className="usage-heat-months" style={{ gridTemplateColumns: `repeat(${weeks}, var(--heat-cell))` }} aria-hidden="true">
          {months.map((m) => (
            <span key={m.col} style={{ gridColumn: m.col + 1 }}>
              {m.label}
            </span>
          ))}
        </div>
        <div className="usage-heat-grid" role="grid" aria-label={`Days, shaded by ${metric}`} onMouseLeave={() => setShown(null)}>
          {rows.map((r) => (
            <div key={r} role="row" className="usage-heat-row" style={{ gridTemplateColumns: `repeat(${weeks}, var(--heat-cell))` }}>
              {cells.map((c, i) =>
                c.row !== r ? null : (
                  <div
                    key={c.day}
                    ref={(el) => {
                      cellRefs.current[i] = el;
                    }}
                    role="gridcell"
                    tabIndex={i === roving ? 0 : -1}
                    className={`usage-heat-cell${i === cells.length - 1 ? " is-today" : ""}`}
                    data-level={c.level}
                    style={{ gridColumn: c.col + 1 }}
                    aria-label={dayText(c.day, byDay[i]!.totals)}
                    onKeyDown={(e) => move(e, i)}
                    onFocus={() => {
                      setActive(i);
                      setShown(i);
                    }}
                    onBlur={() => setShown((s) => (s === i ? null : s))}
                    onMouseEnter={() => setShown(i)}
                  />
                ),
              )}
            </div>
          ))}
        </div>
      </div>
      <p className="usage-heat-caption muted" aria-hidden="true">
        {caption ? dayText(caption.day, caption.totals) : "Hover or arrow to a day"}
        <span className="usage-heat-scale">
          Less
          {[0, 1, 2, 3, 4].map((l) => (
            <span key={l} className="usage-heat-cell is-key" data-level={l} />
          ))}
          More
        </span>
      </p>
    </section>
  );
}

export function UsageDialog({
  harnesses,
  limits,
  onRefresh,
  onOpenSession,
  onClose,
}: {
  harnesses: HarnessStatus[];
  limits: UsageLimits | null;
  onRefresh: () => Promise<void>;
  onOpenSession: (s: ProjectSession, ws: WorkspaceInfo | undefined) => void;
  onClose: () => void;
}) {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [report, setReport] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  /** The range switch's row, for the sliding pill. */
  const rangesRef = useRef<HTMLDivElement>(null);

  /** Token reports refresh when the range changes; explicit refreshes increment this. */
  const [refreshed, setRefreshed] = useState(0);

  useEffect(() => {
    let live = true;
    setBusy(true);
    const report = api<UsageReport>(`/api/usage?days=${days}&tz=${new Date().getTimezoneOffset()}${refreshed > 0 ? "&refresh=1" : ""}`);
    const read = refreshed > 0 ? Promise.all([onRefresh(), report]).then(([, r]) => r) : report;
    read.then(
      (r) => {
        if (!live) return;
        setReport(r);
        setError(null);
        setBusy(false);
      },
      (e: unknown) => {
        if (!live) return;
        setError(errorText(e));
        setBusy(false);
      },
    );
    return () => {
      live = false;
    };
  }, [days, refreshed, onRefresh]);

  const name = (id: string) => harnesses.find((h) => h.id === id)?.displayName ?? id;
  const bars = useMemo(() => (report ? dayBars(report) : []), [report]);
  const labels = useMemo(() => dayLabels(bars.map((b) => b.day), days <= 7 ? 1 : days <= 30 ? 5 : 15), [bars, days]);
  const t = report?.totals;
  const share = t ? cacheShare(t) : null;
  const most = (list: Array<{ totals: UsageTotals }>) => Math.max(1, ...list.map((x) => tokensOf(x.totals)));
  const project = (id: string) => report?.workspaces.find((w) => w.id === id);

  return (
    <Dialog title="Usage" onClose={onClose} className="usage-dialog">
      <div className="usage-body">
        <LimitsPanel limits={limits} />
        <div className="usage-top">
          <div className="segmented" role="group" aria-label="Range" ref={rangesRef}>
            {RANGES.map((n) => (
              <button key={n} type="button" className={n === days ? "is-on" : undefined} aria-pressed={n === days} onClick={() => setDays(n)}>
                {n} days
              </button>
            ))}
            {/* The chosen selection's pill glides to it (SlidingIndicator). */}
            <SlidingIndicator target={rangesRef} active={RANGES.indexOf(days)} of="button" className="segmented-pill" />
          </div>
          <button
            type="button"
            className="icon-btn usage-refresh"
            aria-label="Refresh usage"
            title="Refresh plan limits and usage"
            disabled={busy}
            onClick={() => setRefreshed((n) => n + 1)}
          >
            <IconRefresh size={14} />
          </button>
          {busy ? (
            <span className="usage-busy muted">
              <Spinner size={12} /> Reading sessions…
            </span>
          ) : null}
        </div>
        {error ? (
          <p className="usage-error" role="alert">
            {error}
          </p>
        ) : null}
        {report && t ? (
          <div className={`usage-report${busy ? " is-stale" : ""}`}>
            {/* Only a figure that means something is tinted: tokens (the accent), and the cache share once at least half of the input is a hit. Money is not a warning. */}
            <div className="usage-cards">
              <Card label="Tokens" value={shortTokens(tokensOf(t))} sub={`${t.calls.toLocaleString()} model ${t.calls === 1 ? "call" : "calls"}`} tone="accent" />
              <Card label="Output" value={shortTokens(t.output)} sub={`${shortTokens(t.input)} fresh input`} />
              <Card label="From cache" value={share === null ? "—" : `${Math.round(share * 100)}%`} sub={`${shortTokens(t.cachedInput)} input tokens`} tone={share !== null && share >= 0.5 ? "ok" : undefined} />
              <Card label="Cost" value={cost(t)} sub={t.unpriced > 0 ? `${t.unpriced.toLocaleString()} ${t.unpriced === 1 ? "call" : "calls"} not priced` : "every call priced"} />
              <Card label="Chats" value={t.sessions.toLocaleString()} sub={`with calls in ${days} days`} />
            </div>

            <Heatmap byDay={report.byDay} />

            <section className="usage-chart" aria-label="Tokens by day">
              <div className="usage-bars">
                {bars.map((b, i) => (
                  <div key={b.day} className="usage-day" title={`${b.day}: ${shortTokens(b.total)} tokens${b.segments.length > 1 ? ` (${b.segments.map((s) => `${name(s.harnessId)} ${shortTokens(s.tokens)}`).join(", ")})` : ""}`}>
                    <div className="usage-stack">
                      {b.segments.map((s) => (
                        <span key={s.harnessId} className="usage-seg" style={{ ...harnessColor(s.harnessId), height: `${s.share * 100}%` }} />
                      ))}
                    </div>
                    <span className="usage-day-label">{labels[i] ?? ""}</span>
                  </div>
                ))}
              </div>
              <div className="usage-legend">
                {report.byHarness.map((h) => (
                  <span key={h.harnessId} className="usage-legend-item" style={harnessColor(h.harnessId)}>
                    <span className="usage-legend-dot" aria-hidden="true" />
                    {name(h.harnessId)}
                  </span>
                ))}
              </div>
            </section>

            <div className="usage-split">
              <section aria-label="By harness">
                <h3>By harness</h3>
                {report.byHarness.length === 0 ? <p className="muted usage-none">No calls in this range</p> : null}
                {report.byHarness.map((h) => (
                  <BarRow
                    key={h.harnessId}
                    style={harnessColor(h.harnessId)}
                    label={<span className="badge badge-harness">{name(h.harnessId)}</span>}
                    share={tokensOf(h.totals) / most(report.byHarness)}
                    value={shortTokens(tokensOf(h.totals))}
                    detail={cost(h.totals)}
                  />
                ))}
              </section>
              <section aria-label="By model">
                <h3>By model</h3>
                {report.byModel.length === 0 ? <p className="muted usage-none">No calls in this range</p> : null}
                {report.byModel.map((m) => (
                  <BarRow
                    key={m.model}
                    style={harnessColor(m.harnesses[0])}
                    label={
                      <span className="usage-model" title={`${m.model} (${m.harnesses.map(name).join(", ")})`}>
                        {m.model}
                      </span>
                    }
                    share={tokensOf(m.totals) / most(report.byModel)}
                    value={shortTokens(tokensOf(m.totals))}
                    detail={cost(m.totals)}
                  />
                ))}
              </section>
            </div>

            {report.top.length > 0 ? (
              <section className="usage-top-chats" aria-label="Chats that used the most">
                <h3>Chats that used the most</h3>
                <ul>
                  {report.top.map(({ session, totals }) => (
                    <li key={session.id} style={harnessColor(session.harnessId)}>
                      <button
                        type="button"
                        onClick={() => {
                          onOpenSession(session, project(session.workspaceId));
                          onClose();
                        }}
                      >
                        <span className="usage-chat-title">{session.title || "New chat"}</span>
                        <span className="usage-chat-meta">
                          <span className="badge badge-harness">{name(session.harnessId)}</span>
                          {dotted([project(session.workspaceId)?.name, session.updatedAt ? ago(Date.parse(session.updatedAt)) : null])}
                        </span>
                        <span className="usage-chat-tokens">{shortTokens(tokensOf(totals))}</span>
                        <span className="usage-chat-cost">{cost(totals)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}

            <p className="usage-foot muted">
              Read from the harnesses' own session files, never by starting one.
              {report.unreadable.length > 0 ? ` ${report.unreadable.join(", ")} ${report.unreadable.length === 1 ? "keeps" : "keep"} sessions in a database of its own, so ${report.unreadable.length === 1 ? "its" : "their"} calls are not counted.` : ""}
              {report.truncated ? ` Stopped after ${report.scanned} of ${report.total} chats to stay quick.` : ""}
            </p>
          </div>
        ) : !error ? (
          <p className="usage-loading muted">
            <Spinner size={13} /> Reading sessions…
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
