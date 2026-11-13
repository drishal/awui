// Usage across sessions: the tokens and cost of every model call the
// sidebar's sessions made in a range of days, from the harnesses' own files
// (adapter.readUsage, never starting a harness), added up by day, harness,
// model, and session. A session's calls are read once per version of it; a
// time budget bounds a long history, and the report says what it could not
// read (Hermes keeps its sessions in its own database).
import type { ProjectSession, UsageReport, UsageTotals, WorkspaceInfo } from "../shared/protocol.js";
import type { UsageEntry } from "./harness/types.js";

export interface UsageTarget {
  session: ProjectSession;
  /** Its calls, or null when they cannot be read. */
  read: (() => Promise<UsageEntry[] | null>) | null;
}

const DAY_MS = 86_400_000;
const BUDGET_MS = 6000;
const PARALLEL = 6;
const TOP_MODELS = 12;
const TOP_SESSIONS = 8;
/**
 * What is kept between reports is bounded by calls, since that is what costs memory (about 100 bytes each);
 * a cap of 600 sessions once lay below the number of sessions in a long history, so each report evicted what
 * the next one needed and every one re-read the files.
 */
const CACHED_SESSIONS = 5000;
const CACHED_CALLS = 600_000;

const zero = (): UsageTotals => ({ input: 0, cachedInput: 0, cacheWrite: 0, output: 0, cost: 0, calls: 0, unpriced: 0 });

/** Every token a call moved, in and out. */
export const tokensOf = (t: Pick<UsageTotals, "input" | "cachedInput" | "cacheWrite" | "output">): number => t.input + t.cachedInput + t.cacheWrite + t.output;

function add(into: UsageTotals, e: UsageEntry): void {
  into.input += e.input;
  into.cachedInput += e.cachedInput;
  into.cacheWrite += e.cacheWrite;
  into.output += e.output;
  into.calls += 1;
  if (e.cost === null) into.unpriced += 1;
  else into.cost += e.cost;
}

/** `at`'s day, as "2026-10-14", in the zone `tz` minutes behind UTC (getTimezoneOffset's sign). */
export function dayOf(at: number, tz: number): string {
  return new Date(at - tz * 60_000).toISOString().slice(0, 10);
}

/** The first moment of the range: midnight, in that zone, `days - 1` days before today. */
export function rangeStart(now: number, days: number, tz: number): number {
  const local = now - tz * 60_000;
  const midnight = local - (((local % DAY_MS) + DAY_MS) % DAY_MS);
  return midnight - (days - 1) * DAY_MS + tz * 60_000;
}

/** The report for `targets` (newest first) over `days` days ending today. */
export function buildReport(
  calls: Array<{ session: ProjectSession; entries: UsageEntry[] }>,
  opts: { days: number; tz: number; now: number; workspaces: WorkspaceInfo[]; unreadable: string[]; scanned: number; total: number; truncated: boolean },
): UsageReport {
  const since = rangeStart(opts.now, opts.days, opts.tz);
  const totals = { ...zero(), sessions: 0 };
  const days = new Map<string, { totals: UsageTotals; tokensByHarness: Record<string, number> }>();
  for (let i = 0; i < opts.days; i++) days.set(dayOf(since + i * DAY_MS + 12 * 3_600_000, opts.tz), { totals: zero(), tokensByHarness: {} });
  const harnesses = new Map<string, { totals: UsageTotals; sessions: number }>();
  const models = new Map<string, { model: string; harnesses: Map<string, number>; totals: UsageTotals }>();
  const sessions: Array<{ session: ProjectSession; totals: UsageTotals }> = [];
  for (const { session, entries } of calls) {
    const mine = zero();
    for (const e of entries) {
      if (e.at < since || e.at > opts.now + DAY_MS) continue;
      add(mine, e);
      add(totals, e);
      const day = days.get(dayOf(e.at, opts.tz));
      if (day) {
        add(day.totals, e);
        day.tokensByHarness[session.harnessId] = (day.tokensByHarness[session.harnessId] ?? 0) + tokensOf(e);
      }
      // One row per model name, not per harness: the panel shows the name alone, so a
      // key that included the harness would list "deepseek-v4.1-flash" three times.
      // The name is the part the panel shows (a provider prefix is dropped).
      const key = (e.model ?? "unknown").split("/").pop() || "unknown";
      const model = models.get(key) ?? { model: key, harnesses: new Map(), totals: zero() };
      add(model.totals, e);
      model.harnesses.set(session.harnessId, (model.harnesses.get(session.harnessId) ?? 0) + tokensOf(e));
      models.set(key, model);
    }
    if (mine.calls === 0) continue;
    totals.sessions += 1;
    const h = harnesses.get(session.harnessId) ?? { totals: zero(), sessions: 0 };
    for (const k of ["input", "cachedInput", "cacheWrite", "output", "cost", "calls", "unpriced"] as const) h.totals[k] += mine[k];
    h.sessions += 1;
    harnesses.set(session.harnessId, h);
    sessions.push({ session, totals: mine });
  }
  const top = sessions.sort((a, b) => tokensOf(b.totals) - tokensOf(a.totals)).slice(0, TOP_SESSIONS);
  const used = new Set(top.map((t) => t.session.workspaceId));
  return {
    days: opts.days,
    since,
    totals,
    byDay: [...days.entries()].map(([day, d]) => ({ day, ...d })),
    byHarness: [...harnesses.entries()].map(([harnessId, h]) => ({ harnessId, ...h })).sort((a, b) => tokensOf(b.totals) - tokensOf(a.totals)),
    byModel: [...models.values()]
      .map((m) => ({
        model: m.model,
        // Who ran it, most tokens first: the row is tinted with the first.
        harnesses: [...m.harnesses.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id),
        totals: m.totals,
      }))
      .sort((a, b) => tokensOf(b.totals) - tokensOf(a.totals))
      .slice(0, TOP_MODELS),
    top,
    workspaces: opts.workspaces.filter((w) => used.has(w.id)),
    unreadable: opts.unreadable,
    scanned: opts.scanned,
    total: opts.total,
    truncated: opts.truncated,
  };
}

/** Reads sessions' calls, keeping each session's between reports (the newest version of each). */
export class UsageReader {
  private cache = new Map<string, { version: string; entries: UsageEntry[] | null }>();
  private cachedCalls = 0;

  private forget(id: string): void {
    const old = this.cache.get(id);
    if (!old) return;
    this.cachedCalls -= old.entries?.length ?? 0;
    this.cache.delete(id);
  }

  private async entriesOf(target: UsageTarget, refresh: boolean): Promise<UsageEntry[] | null> {
    if (!target.read) return null;
    const { session } = target;
    const version = `${session.updatedAt ?? ""}`;
    const hit = this.cache.get(session.id);
    if (hit && hit.version === version && !session.liveChatId && !refresh) return hit.entries;
    const entries = await target.read().catch(() => null);
    this.forget(session.id);
    this.cache.set(session.id, { version, entries });
    this.cachedCalls += entries?.length ?? 0;
    while (this.cache.size > 1 && (this.cache.size > CACHED_SESSIONS || this.cachedCalls > CACHED_CALLS)) this.forget(this.cache.keys().next().value as string);
    return entries;
  }

  async report(targets: UsageTarget[], opts: { days: number; tz: number; workspaces: WorkspaceInfo[]; unreadable: string[]; refresh?: boolean; now?: number; budgetMs?: number }): Promise<UsageReport> {
    const now = opts.now ?? Date.now();
    const since = rangeStart(now, opts.days, opts.tz);
    // A session last active before the range made no call in it.
    const inRange = targets.filter((t) => !t.session.updatedAt || Date.parse(t.session.updatedAt) >= since);
    const started = Date.now();
    const budget = opts.budgetMs ?? BUDGET_MS;
    const read: Array<{ session: ProjectSession; entries: UsageEntry[] }> = [];
    let next = 0;
    let scanned = 0;
    let outOfTime = false;
    const worker = async () => {
      while (next < inRange.length) {
        if (Date.now() - started > budget) {
          outOfTime = true;
          return;
        }
        const target = inRange[next++] as UsageTarget;
        const entries = await this.entriesOf(target, opts.refresh === true);
        scanned += 1;
        if (entries && entries.length > 0) read.push({ session: target.session, entries });
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, inRange.length) }, worker));
    return buildReport(read, { days: opts.days, tz: opts.tz, now, workspaces: opts.workspaces, unreadable: opts.unreadable, scanned, total: inRange.length, truncated: outOfTime });
  }
}
