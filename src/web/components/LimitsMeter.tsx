// Subscription limits (Claude Code's five-hour and weekly windows, every
// account omp is signed in to): a card per account at the top of the Usage
// panel, a bar per window with when it resets.
import type { UsageLimits } from "../../shared/protocol.js";
import { accountName, level, percent, resetsIn } from "../limits.js";
import { dotted } from "./Dot.js";

/** Every account's windows, a card each. */
export function LimitsPanel({ limits }: { limits: UsageLimits | null }) {
  if (!limits || (limits.accounts.length === 0 && limits.errors.length === 0)) return null;
  return (
    <section className="usage-limits" aria-label="Plan limits">
      <h3>Plan limits</h3>
      <div className="limits-grid">
        {limits.accounts.map((a) => (
          <div key={a.id} className={`limits-account${a.limited ? " is-limited" : ""}`} title={`From ${a.source}, ${new Date(a.at).toLocaleString()}`}>
            <div className="limits-name">
              {accountName(a)}
              {a.plan ? <span className="limits-plan">{a.plan}</span> : null}
              {a.limited ? <span className="limits-plan is-full">limited</span> : null}
            </div>
            {a.windows.map((w, i) => (
              // Two limits may share a window's name; their order is the harness's own.
              <div key={`${w.label}:${i}`} className="limits-window">
                <span className="limits-label">{w.label}</span>
                <span className="limits-bar" role="meter" aria-label={`${accountName(a)} ${w.label}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={w.used === null ? undefined : Math.round(w.used * 100)}>
                  <span className={`limits-fill is-${level(w.used)}`} style={{ width: `${Math.round((w.used ?? 0) * 100)}%` }} />
                </span>
                <span className="limits-pct">{percent(w.used)}</span>
                {w.resetsAt ? <span className="limits-reset">resets {resetsIn(w.resetsAt)}</span> : null}
              </div>
            ))}
          </div>
        ))}
      </div>
      {limits.errors.map((e) => (
        <p key={e} className="sidebar-note is-warning">
          {e}
        </p>
      ))}
    </section>
  );
}
