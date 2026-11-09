// Subscription limits from the harnesses' own reports, in one shape: Claude
// Code's rate_limit_event (per run) and its get_usage answer (asked for), and
// omp's `usage --json` (every signed-in account). Account names and emails
// are dropped here.
import type { LimitAccount, LimitWindow } from "../../shared/protocol.js";
import { isObj, type Obj } from "./agent-events.js";

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

const CLAUDE_WINDOWS: Record<string, string> = {
  five_hour: "5 hours",
  seven_day: "7 days",
  seven_day_opus: "7 days · Opus",
  seven_day_sonnet: "7 days · Sonnet",
};

/** Seconds or milliseconds since the epoch, as milliseconds. */
const epochMs = (v: unknown): number | null => {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n < 1e12 ? n * 1000 : n;
};

const share = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.min(1, Math.max(0, n));
};

/** Claude Code's `rate_limit_info`: every window it lists, else the one it is about. */
export function claudeLimits(info: Obj, at = Date.now()): LimitAccount {
  const windows: LimitWindow[] = [];
  const unified = isObj(info.unifiedWindows) ? info.unifiedWindows : null;
  if (unified) {
    for (const [key, w] of Object.entries(unified)) {
      if (!isObj(w)) continue;
      windows.push({ label: CLAUDE_WINDOWS[key] ?? key.replaceAll("_", " "), used: share(w.utilization), resetsAt: epochMs(w.resetsAt) });
    }
  }
  if (windows.length === 0 && str(info.rateLimitType)) {
    const key = str(info.rateLimitType);
    windows.push({ label: CLAUDE_WINDOWS[key] ?? key.replaceAll("_", " "), used: share(info.utilization), resetsAt: epochMs(info.resetsAt) });
  }
  return {
    id: "claude",
    source: "Claude Code",
    provider: "Anthropic",
    windows,
    limited: info.status === "rejected",
    at,
  };
}

/** Claude Code's named weekly windows beyond the session and week (codenamed rows it also sends are left out). */
const CLAUDE_USAGE_WINDOWS: Array<[key: string, label: string]> = [
  ["five_hour", "5 hours"],
  ["seven_day", "7 days"],
  ["seven_day_opus", "7 days · Opus"],
  ["seven_day_sonnet", "7 days · Sonnet"],
  ["seven_day_oauth_apps", "7 days · apps"],
];

/**
 * Claude Code's `get_usage` control reply (the data its /usage shows):
 * the plan's windows, utilization 0-100 and an ISO reset time each, plus
 * per-model weekly windows. Null when the plan has no limits (an API key, a
 * cloud provider) or the CLI could not fetch them.
 */
export function claudeUsageLimits(usage: unknown, at = Date.now()): LimitAccount | null {
  if (!isObj(usage) || usage.rate_limits_available !== true || !isObj(usage.rate_limits)) return null;
  const limits = usage.rate_limits;
  const windows: LimitWindow[] = [];
  const add = (label: string, w: unknown) => {
    if (!isObj(w)) return;
    const pct = num(w.utilization);
    const resets = typeof w.resets_at === "string" ? Date.parse(w.resets_at) : Number.NaN;
    windows.push({ label, used: pct === null ? null : Math.min(1, Math.max(0, pct / 100)), resetsAt: Number.isFinite(resets) ? resets : null });
  };
  for (const [key, label] of CLAUDE_USAGE_WINDOWS) add(label, limits[key]);
  for (const m of Array.isArray(limits.model_scoped) ? limits.model_scoped : []) if (isObj(m) && str(m.display_name)) add(`7 days · ${str(m.display_name)}`, m);
  if (windows.length === 0) return null;
  return {
    id: "claude",
    source: "Claude Code",
    provider: "Anthropic",
    ...(str(usage.subscription_type) ? { plan: str(usage.subscription_type) } : {}),
    windows,
    limited: windows.some((w) => (w.used ?? 0) >= 1),
    at,
  };
}

/** `omp usage --json`: one account per report, its windows in the order omp gives them. */
export function ompLimits(json: unknown, at = Date.now()): LimitAccount[] {
  if (!isObj(json) || !Array.isArray(json.reports)) return [];
  const seen = new Map<string, number>();
  const accounts: LimitAccount[] = [];
  for (const report of json.reports) {
    if (!isObj(report)) continue;
    const provider = str(report.provider) || "unknown";
    const n = seen.get(provider) ?? 0;
    seen.set(provider, n + 1);
    const meta = isObj(report.metadata) ? report.metadata : {};
    const windows: LimitWindow[] = [];
    let limited = meta.limitReached === true || meta.allowed === false;
    const limits = (Array.isArray(report.limits) ? report.limits : []).filter(isObj);
    const windowLabel = (limit: Obj) => (isObj(limit.window) ? str(limit.window.label) : "");
    // Two limits on one window (xAI's credits and its GrokChat cap, both "Weekly") go by their own names.
    const shared = new Map<string, number>();
    for (const limit of limits) shared.set(windowLabel(limit), (shared.get(windowLabel(limit)) ?? 0) + 1);
    for (const limit of limits) {
      const window = isObj(limit.window) ? limit.window : {};
      const amount = isObj(limit.amount) ? limit.amount : {};
      const own = windowLabel(limit);
      windows.push({
        label: (own && (shared.get(own) ?? 0) < 2 ? own : str(limit.label) || own) || "limit",
        used: share(amount.usedFraction),
        resetsAt: epochMs(window.resetsAt),
      });
      if (["exhausted", "exceeded", "limit_reached", "blocked"].includes(str(limit.status))) limited = true;
    }
    accounts.push({
      id: `omp:${provider}:${n}`,
      source: "omp",
      provider,
      ...(str(meta.planType) ? { plan: str(meta.planType) } : {}),
      windows,
      limited,
      at: epochMs(report.fetchedAt) ?? at,
    });
  }
  return accounts;
}

/** A Codex window's length as its name: 10080 minutes → "7 days". */
function codexWindowLabel(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "limit";
  if (minutes < 60) return `${Math.round(minutes)} minutes`;
  if (minutes < 1440) {
    const hours = Math.round(minutes / 60);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const days = Math.round(minutes / 1440);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Codex's `account/rateLimits/read` (and the `account/rateLimits/updated`
 * notification): the plan's two windows, a used percentage each. Codex names no
 * account, so one row stands for the CLI's login.
 */
export function codexLimits(snapshot: Obj, at = Date.now()): LimitAccount {
  const windows: LimitWindow[] = [];
  for (const key of ["primary", "secondary"]) {
    const window = isObj(snapshot[key]) ? (snapshot[key] as Obj) : null;
    if (!window) continue;
    if (num(window.usedPercent) === null && num(window.windowDurationMins) === null) continue;
    windows.push({
      label: codexWindowLabel(num(window.windowDurationMins) ?? 0),
      used: share((num(window.usedPercent) ?? 0) / 100),
      resetsAt: epochMs(window.resetsAt),
    });
  }
  return {
    id: "codex",
    source: "Codex",
    provider: "OpenAI",
    ...(str(snapshot.planType) ? { plan: str(snapshot.planType) } : {}),
    windows,
    limited: str(snapshot.rateLimitReachedType) !== "" || snapshot.spendControlReached === true,
    at,
  };
}
