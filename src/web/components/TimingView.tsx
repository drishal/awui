// A turn's time as bars on one axis: every model step, tool call, and subagent
// from the prompt to the settle, the slowest call marked, subagent runs under
// their call, each row named for a screen reader and stepped with the arrow
// keys. The Timing dialog draws it on its own; the context chip's full view puts
// it under the usage sections. Rows and axis come from waterfall.ts, so this
// only lays them out (percentages, no canvas). A running turn keeps ticking.
import { useRef } from "react";
import { useNow } from "../hooks.js";
import type { Turn } from "../turns.js";
import { atLabel, rowName, turnWaterfall } from "../waterfall.js";

export function TimingView({ turn, workspace }: { turn: Turn; workspace: string }) {
  const now = useNow(turn.live);
  const { rows, total, ticks } = turnWaterfall(turn, workspace, now);
  const list = useRef<HTMLDivElement>(null);
  // Arrow keys step through the rows (each is a tab stop too), Home and End jump.
  const onKey = (e: React.KeyboardEvent) => {
    const els = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
    const at = els.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "ArrowDown" ? at + 1 : e.key === "ArrowUp" ? at - 1 : e.key === "Home" ? 0 : e.key === "End" ? els.length - 1 : null;
    if (next === null || els.length === 0) return;
    e.preventDefault();
    els[Math.max(0, Math.min(els.length - 1, next))]?.focus();
  };
  if (rows.length === 0) return <p className="timing-empty" data-testid="timing-empty">The harness did not report times for this turn.</p>;
  return (
    <div className="timing" data-testid="timing">
      <p className="timing-total">
        {atLabel(Math.max(...rows.map((r) => r.end)))} from prompt to {turn.live ? "now" : "settle"}
      </p>
      <div className="timing-line timing-axisrow" aria-hidden="true">
        <span />
        <span className="timing-axis">
          {ticks.map((t) => (
            <span key={t.ms} className="timing-tick" style={{ left: `${(t.ms / total) * 100}%` }}>
              {t.label}
            </span>
          ))}
        </span>
        <span />
      </div>
      <div className="timing-rows" role="list" ref={list} onKeyDown={onKey}>
        {rows.map((r) => {
          const left = (r.start / total) * 100;
          const width = Math.max(((r.end - r.start) / total) * 100, 0.6);
          return (
            <div key={r.id} className={`timing-line timing-row is-${r.kind}${r.slowest ? " is-slowest" : ""}${r.running ? " is-running" : ""}`} role="listitem" tabIndex={0} data-row data-depth={r.depth} aria-label={rowName(r)}>
              <span className="timing-label" aria-hidden="true">
                <span className="timing-text">{r.label}</span>
                {r.slowest ? <span className="timing-slowest" data-testid="timing-slowest">slowest</span> : null}
                {r.extra ? <span className="timing-extra">{r.extra}</span> : null}
              </span>
              <span className="timing-track" aria-hidden="true">
                {ticks.map((t) => (
                  <span key={t.ms} className="timing-grid" style={{ left: `${(t.ms / total) * 100}%` }} />
                ))}
                <span className="timing-bar" style={{ left: `${left}%`, width: `${Math.min(width, 100 - left)}%` }} />
              </span>
              <span className="timing-dur" aria-hidden="true">
                {atLabel(r.end - r.start)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
