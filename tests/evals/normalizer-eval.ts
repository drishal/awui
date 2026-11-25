// The tool-card normalizer's eval: awui's own traces, replayed.
//
// Default mode is recorded replay, with no network at all: every fixture under
// tests/fixtures/normalizer/ carries the reply a backend gave for its call, and the real
// `NormalizerService.decide` runs against a stubbed fetch, so what is scored is the production
// gate, cache, redaction and parse — not a copy of them. `tests/evals/normalizer-replay.test.ts`
// drives the same function in CI, so the corpus is a test rather than a habit.
//
// `--live` is opt-in and spends money: it needs CMD_API_KEY and sends each fixture's (clipped and
// redacted) state to Command Code's Provider API once, then writes the reply back into the fixture
// so the next replay run uses a real one. `--sweep` replays the recorded replies at 0.4–0.9 in 0.05
// steps and reports the operating point with a false-card rate under 1% and the highest coverage.
//
// Fixture recorded bodies are marked `"source": "synthetic"` until a live run replaces them: the
// report says how many of each, and no number here is a vendor benchmark.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { NormalizerBackend, ToolCandidate, ToolCategory, ToolItem, ToolKind } from "../../src/shared/protocol.js";
import { NORMALIZER_DEFAULTS, type NormalizerConfig } from "../../src/server/normalizer/config.js";
import { eligibleForDecision, NormalizerService, type NormalizerFetch, type ToolDecisionPatch } from "../../src/server/normalizer/service.js";
import { SECRET_PROBES } from "./normalizer-secrets.js";

export const FIXTURES_DIR = path.join(import.meta.dirname, "..", "fixtures", "normalizer");
export const REPORT_FILE = path.join(FIXTURES_DIR, "report.json");

/** What a backend answered one call, as the fixture holds it. */
export interface RecordedReply {
  /** "synthetic" until a live run records a real one. The report counts both. */
  source?: "synthetic" | "live";
  status: number;
  latencyMs: number;
  body: unknown;
}

export interface NormalizerFixture {
  id: string;
  harness: string;
  toolName: string;
  category: ToolCategory;
  /** The family the fold would have given the call: "command"/"other" are eligible, a card family is not. */
  toolKind: ToolKind;
  command: string;
  ended: "done" | "error";
  output: string;
  candidates: ToolCandidate[];
  /** Human labels: the card yes/no, the family, and the one failing test to name. */
  labels: { show_card: boolean; kind?: ToolKind; failing_test?: string };
  recorded: Partial<Record<NormalizerBackend, RecordedReply>>;
}

/** The price per million input tokens, as each vendor's page states it; output is free on all of them. */
export const PRICE_PER_MILLION: Record<NormalizerBackend, number> = {
  "local-clef-flash": 0,
  "command-code-jev": 0.04,
  jev: 0.042,
  "workers-ai-clef-flash": 0.038,
};

export interface EvalReport {
  backend: NormalizerBackend;
  model: string;
  fixtures: number;
  synthetic: number;
  live: number;
  /** Calls the normalizer was actually asked about. */
  sent: number;
  /** Calls the built-in parsers had already settled (never sent). */
  settled: number;
  /** Below a threshold, or a reply the gate refused: the row kept its look. */
  belowThreshold: number;
  cards: number;
  positives: number;
  negatives: number;
  falseCards: number;
  kindCorrect: number;
  kindTotal: number;
  confusion: Array<{ label: string; got: string; count: number }>;
  picksNamed: number;
  latency: { p50: number; p95: number };
  timeouts: number;
  cost: { inputTokens: number; usd: number };
  cache: { hits: number; misses: number };
  /** Requests whose body still carried one of the probe secrets: must be 0. */
  leaks: number;
  /** Fixtures whose decision disagreed with a label, by id, with what was expected. */
  misses: string[];
  /** Fixtures decided with the network blocked: every one must keep its ordinary row. */
  offlineKept: number;
  /** "recorded" for a replay, "blocked" for the offline check. */
  network: "recorded" | "blocked";
}

export function loadFixtures(dir = FIXTURES_DIR): NormalizerFixture[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && name !== "report.json")
    .sort()
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as NormalizerFixture);
}

/** One fixture as the fold would have handed it to the reducer. */
export function itemOf(fixture: NormalizerFixture): ToolItem {
  return {
    kind: "tool",
    id: `t:${fixture.id}`,
    name: fixture.toolName,
    args: "",
    status: fixture.ended,
    output: fixture.output,
    truncated: false,
    category: fixture.category,
    toolKind: fixture.toolKind,
    summary: fixture.command,
    paths: [],
    ...(fixture.candidates.length > 0 ? { candidates: fixture.candidates } : {}),
  };
}

export interface ReplayOptions {
  backend?: NormalizerBackend;
  minChoice?: number;
  minNoul?: number;
  cache?: boolean;
}

/** A config for one backend, with the keys the environment holds (never printed). */
function configFor(backend: NormalizerBackend, options: ReplayOptions, live: boolean): NormalizerConfig {
  return {
    enabled: true,
    backend,
    endpoint: live && backend === "local-clef-flash" ? "http://127.0.0.1:8000/v1/systemone" : live ? "" : "http://replay.invalid/v1/systemone",
    jevBaseUrl: NORMALIZER_DEFAULTS.jevBaseUrl,
    jevModel: NORMALIZER_DEFAULTS.jevModel,
    cloudflareAccountId: live ? "" : "replay-account",
    minChoice: options.minChoice ?? NORMALIZER_DEFAULTS.minChoice,
    minNoul: options.minNoul ?? NORMALIZER_DEFAULTS.minNoul,
    cache: options.cache ?? true,
    timeoutMs: null,
    allowFreeText: false,
    // Replay never reaches a network: these values only let backendPlan exercise the real decision path.
    keys: live
      ? { jev: process.env.TYPESAFE_API_KEY?.trim() || null, commandCode: process.env.CMD_API_KEY?.trim() || null, cloudflare: null }
      : { jev: "replay-jev", commandCode: "replay-command-code", cloudflare: "replay-cloudflare" },
  };
}

const percentile = (sorted: number[], share: number): number => (sorted.length === 0 ? 0 : (sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))] ?? 0));

/**
 * The recorded replay: every fixture through the real service, with `fetch` answering from the
 * fixture. `network` is "blocked" for the offline check, which must leave every row alone.
 */
export async function replay(fixtures: NormalizerFixture[], options: ReplayOptions & { network?: "recorded" | "blocked" } = {}): Promise<EvalReport> {
  const backend = options.backend ?? "command-code-jev";
  const config = configFor(backend, options, false);
  let current: RecordedReply | null = null;
  let sent = 0;
  let leaks = 0;
  const latencies: number[] = [];
  let inputTokens = 0;
  let timeouts = 0;
  const fetchImpl: NormalizerFetch = async (_url, init) => {
    const body = String(init?.body ?? "");
    if (SECRET_PROBES.some((probe) => body.includes(probe))) leaks += 1;
    sent += 1;
    if (options.network === "blocked") throw new TypeError("fetch failed: getaddrinfo ENOTFOUND (network blocked)");
    const reply = current;
    if (!reply) throw new TypeError("no recording for this fixture");
    latencies.push(reply.latencyMs);
    if (reply.status >= 400) return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
    const body0 = reply.body as { usage?: { input_tokens?: number } } | null;
    inputTokens += body0?.usage?.input_tokens ?? 0;
    if (reply.latencyMs > 4000) timeouts += 1;
    return new Response(JSON.stringify(reply.body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const service = new NormalizerService({ config: () => config, home: () => "/home/eval", fetchImpl, now: () => Date.now() });

  const confusion = new Map<string, number>();
  const misses: string[] = [];
  let cards = 0;
  let positives = 0;
  let negatives = 0;
  let falseCards = 0;
  let kindCorrect = 0;
  let kindTotal = 0;
  let picksNamed = 0;
  let settled = 0;
  let belowThreshold = 0;
  let offlineKept = 0;

  const blocked = options.network === "blocked";
  for (const fixture of fixtures) {
    const item = itemOf(fixture);
    if (eligibleForDecision(item)) {
      current = fixture.recorded[backend] ?? null;
      const patch = await service.decide(item, { chatId: `eval-${fixture.id}`, harness: fixture.harness, workspace: "/home/eval/proj", runStartedAt: 1 });
      if (!blocked) score(fixture, patch);
      else if (patch === null) offlineKept += 1;
    } else if (!blocked) {
      settled += 1;
    }
  }

  function score(fixture: NormalizerFixture, patch: ToolDecisionPatch | null): void {
    const label = fixture.labels;
    if (label.show_card) positives += 1;
    else negatives += 1;
    if (patch) {
      cards += 1;
      if (!label.show_card) falseCards += 1;
      if (patch.decided.picks?.failing_test) picksNamed += 1;
    } else {
      belowThreshold += 1;
    }
    if (label.kind && patch) {
      kindTotal += 1;
      const key = `${label.kind}→${patch.toolKind}`;
      confusion.set(key, (confusion.get(key) ?? 0) + 1);
      if (patch.toolKind === label.kind) kindCorrect += 1;
    }
    if ((patch !== null) !== label.show_card) misses.push(`${fixture.id}: card ${patch ? "drawn" : "not drawn"}, label says ${label.show_card ? "draw" : "no"}`);
    else if (patch && label.kind && patch.toolKind !== label.kind) misses.push(`${fixture.id}: kind ${patch.toolKind}, label says ${label.kind}`);
    else if (patch && label.failing_test && patch.decided.picks?.failing_test && patch.decided.picks.failing_test !== label.failing_test) {
      misses.push(`${fixture.id}: named ${patch.decided.picks.failing_test}, label says ${label.failing_test}`);
    }
  }

  latencies.sort((a, b) => a - b);
  const status = service.status();
  return {
    backend,
    model: backend === "command-code-jev" ? "typesafe/jev-1.14.0" : backend === "jev" ? config.jevModel : "clef-flash",
    fixtures: fixtures.length,
    synthetic: fixtures.filter((f) => f.recorded[backend]?.source !== "live").length,
    live: fixtures.filter((f) => f.recorded[backend]?.source === "live").length,
    sent,
    settled,
    belowThreshold,
    cards,
    positives,
    negatives,
    falseCards,
    kindCorrect,
    kindTotal,
    confusion: [...confusion.entries()].map(([key, count]) => {
      const [label = "", got = ""] = key.split("→");
      return { label, got, count };
    }),
    picksNamed,
    latency: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95) },
    timeouts,
    cost: { inputTokens, usd: (inputTokens / 1_000_000) * PRICE_PER_MILLION[backend] },
    cache: { hits: status.cacheHits, misses: status.cacheMisses },
    leaks,
    misses,
    offlineKept,
    network: options.network ?? "recorded",
  };
}

const percent = (part: number, whole: number): string => (whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)}%`);

/** The report's table (§8.3): latency, kind accuracy and confusion, false cards, coverage, cost, cache. */
export function formatReport(report: EvalReport): string {
  const lines = [
    `${report.backend} (${report.model}) · ${report.fixtures} fixtures (${report.live} recorded live, ${report.synthetic} synthetic)`,
    `sent         ${report.sent} · already settled ${report.settled} · below a threshold ${report.belowThreshold}`,
    `latency      p50 ${report.latency.p50} ms · p95 ${report.latency.p95} ms · over 4 s ${report.timeouts}`,
    `kind         ${report.kindCorrect}/${report.kindTotal} (${percent(report.kindCorrect, report.kindTotal)})${report.confusion.length > 0 ? ` · ${report.confusion.map((c) => `${c.label}→${c.got} ${c.count}`).join(", ")}` : ""}`,
    `false cards  ${report.falseCards}/${report.negatives} (${percent(report.falseCards, report.negatives)})`,
    `coverage     ${report.cards}/${report.positives} cards (${percent(report.cards, report.positives)}) · ${report.picksNamed} named a failing test`,
    `cost         ${report.cost.inputTokens} input tokens × $${(PRICE_PER_MILLION[report.backend]).toFixed(3)}/M = $${report.cost.usd.toFixed(6)}`,
    `cache        ${report.cache.hits} hits · ${report.cache.misses} asked`,
    `egress       ${report.leaks} request bodies carried a probe secret (must be 0)`,
  ];
  // A synthetic corpus says so next to the score: these are the documented reply shapes, not a vendor's.
  if (report.synthetic > 0) lines.push(`corpus       ${report.synthetic} reply bodies are synthetic (hand-written to the documented shapes); --live replaces them`);
  if (report.network === "blocked") lines.push(`offline      ${report.offlineKept} of ${report.positives + report.negatives + report.settled} kept their ordinary row with the network blocked`);
  if (report.misses.length > 0) lines.push(`misses       ${report.misses.join(" · ")}`);
  return lines.join("\n");
}

/** `--sweep`: 0.4–0.9 in 0.05 steps, reporting the best operating point and how each one scored. */
export async function sweep(fixtures: NormalizerFixture[], backend: NormalizerBackend = "command-code-jev"): Promise<{ table: string; best: { minChoice: number; minNoul: number; falseCardRate: number; coverage: number } | null }> {
  const rows: string[] = [];
  let best: { minChoice: number; minNoul: number; falseCardRate: number; coverage: number } | null = null;
  for (let threshold = 0.4; threshold <= 0.9001; threshold += 0.05) {
    const value = Math.round(threshold * 100) / 100;
    const report = await replay(fixtures, { backend, minChoice: value, minNoul: value, cache: false });
    const falseCardRate = report.negatives === 0 ? 0 : report.falseCards / report.negatives;
    const coverage = report.positives === 0 ? 0 : report.cards / report.positives;
    rows.push(`  ${value.toFixed(2)}  false cards ${(falseCardRate * 100).toFixed(1)}%  coverage ${(coverage * 100).toFixed(1)}%`);
    if (falseCardRate <= 0.01 && (best === null || coverage > best.coverage)) best = { minChoice: value, minNoul: value, falseCardRate, coverage };
  }
  return { table: rows.join("\n"), best };
}

/**
 * The opt-in live mode: one real request per fixture against Command Code's Provider API, and each
 * reply written back into its fixture. It refuses without CMD_API_KEY, prints the pessimistic spend
 * before the first call, and prints latency and accuracy only — never a fixture's output, never a key.
 */
export async function live(fixtures: NormalizerFixture[], options: { limit?: number; writeBack?: boolean } = {}): Promise<EvalReport | null> {
  const key = process.env.CMD_API_KEY?.trim();
  if (!key) {
    console.error("--live needs CMD_API_KEY in the environment; nothing was sent.");
    return null;
  }
  const backend: NormalizerBackend = "command-code-jev";
  const chosen = fixtures.filter((fixture) => eligibleForDecision(itemOf(fixture))).slice(0, options.limit ?? 50);
  const byId = new Map(chosen.map((fixture) => [fixture.id, fixture]));
  // The pessimistic bound: ~1.2 k input tokens per call at $0.04 per million.
  console.log(`${chosen.length} calls, at most ~${chosen.length * 1200} input tokens ≈ $${((chosen.length * 1200 * 0.04) / 1_000_000).toFixed(5)} (${backend}).`);
  // One request at a time, each reply recorded against the fixture that asked for it. The recording
  // is the parsed body only: never the headers (a key rides in one), never a log of the request.
  let asking: NormalizerFixture | null = null;
  const fetchImpl: NormalizerFetch = async (input, init) => {
    const started = Date.now();
    const res = await fetch(input, init);
    const text = await res.text();
    const fixture = asking;
    if (fixture) {
      let body: unknown = null;
      try {
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        body = null;
      }
      fixture.recorded[backend] = { source: "live", status: res.status, latencyMs: Date.now() - started, body };
    }
    return new Response(text, { status: res.status, headers: { "content-type": res.headers.get("content-type") ?? "application/json" } });
  };
  const config = configFor(backend, { cache: false }, true);
  const service = new NormalizerService({ config: () => config, home: () => "/home/eval", fetchImpl });
  for (const fixture of chosen) {
    asking = byId.get(fixture.id) ?? null;
    const item = itemOf(fixture);
    const before = service.status().spentInputTokens;
    const patch = await service.decide(item, { chatId: `live-${fixture.id}`, harness: fixture.harness, workspace: "/home/eval/proj", runStartedAt: 1 });
    const spent = service.status().spentInputTokens - before;
    console.log(`${fixture.id}: ${patch ? `${patch.toolKind} at ${patch.decided.probability.toFixed(2)}` : "no card"} · ${spent} input tokens`);
    if (options.writeBack !== false && fixture.recorded[backend]) {
      // The corpus improves in place: the next replay run scores a real reply instead of a synthetic one.
      writeFileSync(path.join(FIXTURES_DIR, `${fixture.id}.json`), `${JSON.stringify(fixture, null, 2)}\n`);
    }
  }
  asking = null;
  return replay(chosen, { backend, cache: false });
}

/** The command line: replay (default), --live, or --sweep. Returns the exit code. */
export async function main(argv: string[]): Promise<number> {
  const fixtures = loadFixtures();
  if (fixtures.length === 0) {
    console.error(`No fixtures in ${FIXTURES_DIR}`);
    return 1;
  }
  if (argv.includes("--live")) {
    const limitAt = argv.indexOf("--limit");
    const limit = limitAt >= 0 ? Number(argv[limitAt + 1]) : undefined;
    const report = await live(fixtures, { limit: Number.isFinite(limit) ? limit : undefined });
    if (!report) return 1;
    console.log(formatReport(report));
    return 0;
  }
  if (argv.includes("--sweep")) {
    const { table, best } = await sweep(fixtures);
    console.log(table);
    console.log(best ? `\nbest: min_choice_probability = min_noul = ${best.minChoice.toFixed(2)} (false cards ${(best.falseCardRate * 100).toFixed(1)}%, coverage ${(best.coverage * 100).toFixed(1)}%)` : "\nNo threshold kept false cards under 1%.");
    return 0;
  }
  const report = await replay(fixtures);
  console.log(formatReport(report));
  writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nwritten ${path.relative(process.cwd(), REPORT_FILE)}`);
  return report.leaks === 0 ? 0 : 1;
}
