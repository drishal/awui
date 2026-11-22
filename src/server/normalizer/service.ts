// The normalizer: a decision model that fills the one gap the built-in parsers leave.
//
// A settled tool call whose family is still the fallback (`command` / `other`) has output the sniffers
// in shared/output-facts.ts could not place. If — and only if — the operator turned this on and the
// selected backend is usable, one System One request asks two things about that call: a Noul
// ("should this be a test-run card?") and a Choice over the kinds still open. The reply's own
// probabilities decide, nothing else does, and only a call that clears both gates is patched.
//
// Fire and forget: `decide` is called after the row has been drawn and streamed, and the patch goes
// back through the chat as one ordinary item update. The event stream never waits on a model.
//
// The four backends (systemone.ts builds and reads their wire; config.ts resolves the block):
//
//   local-clef-flash      normalizer.endpoint        clef-flash  no key       400 ms  stays here
//   command-code-jev      api.commandcode.ai/...     typesafe/jev-1.14.0  CMD_API_KEY  2500 ms  remote
//   jev                   normalizer.jev_base_url    normalizer.jev_model  TYPESAFE_API_KEY  2500 ms  remote
//   workers-ai-clef-flash Cloudflare's account URL   clef-flash  token        1000 ms  remote
//
// The Command Code entry is the fixed preset (its Provider API in front of TypeSafe's Jev, model
// pinned to the version that answered `typesafe/jev-1.14.0`); `jev` is the configurable one, so it can
// point at any System One-compatible proxy. Jev's 2500 ms default comes from a measured 1749 ms
// answer on a cold connection, above the vendor's own p95; the eval re-measures it.
//
// Every remote request goes through buildEgressState (redact.ts) inside this file, and this file
// holds the only `fetch`: there is no other path from a tool call to a wire.
import type { NormalizerProbe, NormalizerStatus, ToolDecision, ToolItem, ToolKind } from "../../shared/protocol.js";
import { DecisionCache, decisionKey } from "./cache.js";
import { LOCAL_CLEF_MODEL, type NormalizerConfig } from "./config.js";
import { buildEgressState, candidatePairs } from "./redact.js";
import { buildSystemOneRequest, readSystemOneReply, replyErrorOf, type BackendCall, type ChoiceQuestion, type NoulQuestion, type SystemOneQuestion, type SystemOneReply } from "./systemone.js";

/** One chat's budget: it cannot spend without bound, however busy the chat is. */
const CALLS_PER_MINUTE = 20;
const CALLS_PER_RUN = 200;
/** A reply is small; anything larger is not one, and reading it all would be the only cost. */
const MAX_REPLY_CHARS = 256 * 1024;
/** Live chats tracked for the budget; past this the counters start over (they are only a guard). */
const MAX_BUDGET_CHATS = 500;

/** What the patch one decision applies to a row: its new family, and why. */
export interface ToolDecisionPatch {
  toolKind: ToolKind;
  decided: ToolDecision;
}

/** Where a call is being decided: the chat's own place in the world, read by redaction and the budget. */
export interface DecisionContext {
  chatId: string;
  harness: string;
  /** The chat's project folder: its absolute prefix is rewritten before anything is sent. */
  workspace: string;
  /** When this chat's current run started, so the per-run budget resets with the run. */
  runStartedAt: number | null;
}

/**
 * The one call the service makes, narrowed so a test or the eval can pass a plain function: Bun's own
 * `fetch` type carries more (a `preconnect`), and nothing here needs it.
 */
export type NormalizerFetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface NormalizerDeps {
  /** The resolved config, read at each decision so a saved change needs no restart; null when there is none. */
  config: () => NormalizerConfig | null;
  /** The user's home folder, whose prefix is rewritten to `~`. */
  home: () => string;
  /** Where decisions are saved (null: memory only, as in tests). */
  cacheFile?: string | null;
  /** For the eval and tests; the global fetch otherwise. */
  fetchImpl?: NormalizerFetch;
  now?: () => number;
}

/** One request's shape for the questions a call gets (see decide): two always, a third when it can choose. */
export function questionsFor(item: ToolItem): Record<string, SystemOneQuestion> {
  const questions: Record<string, SystemOneQuestion> = {
    show_test_card: SHOW_CARD_QUESTION,
    // Only the families still open for an ambiguous call: never the whole ToolKind union.
    kind: { type: "choice", instructions: "What kind of tool call produced this output?", criteria: { ...KIND_CRITERIA } },
  };
  const named = namedFailures(item);
  if (named.size >= 2) questions.failing_test = failingTestQuestion(item, named);
  return questions;
}

const SHOW_CARD_QUESTION: NoulQuestion = {
  type: "noul",
  instructions: "Should this tool output be shown as a test-run card rather than a plain command row?",
  criteria: {
    true: "The output is a test runner's report of tests that ran, with pass or fail results.",
    false: "The output is a build, a lint, an install, or a command that ran no tests.",
  },
};

const KIND_CRITERIA: Record<string, string> = {
  test: "A test runner reporting per-test results",
  command: "A shell command that is not a test run",
  other: "Neither of the above",
};

const OPEN_KINDS = ["test", "command", "other"] as const;
/** A Choice is only as bounded as its criteria: a long failure list is not a question. */
const MAX_NAMED_FAILURES = 8;

/** The failing-test names the sniffers proposed, in order and without duplicates. */
function namedFailures(item: ToolItem): Set<string> {
  const names = new Set<string>();
  for (const candidate of item.candidates ?? []) {
    if (candidate.key !== "failing_test" || candidate.value === "") continue;
    names.add(String(candidate.value));
    if (names.size >= MAX_NAMED_FAILURES) break;
  }
  return names;
}

/** The candidates' own strings as the Choice's keys, so the model cannot answer a name it invented. */
function failingTestQuestion(item: ToolItem, named: Set<string>): ChoiceQuestion {
  const evidence = new Map<string, string>();
  for (const candidate of item.candidates ?? []) {
    const value = String(candidate.value);
    if (candidate.key === "failing_test" && !evidence.has(value) && candidate.evidence) evidence.set(value, candidate.evidence.split("\n")[0]?.trim().slice(0, 160) ?? "");
  }
  const criteria: Record<string, string> = {};
  for (const name of named) criteria[name] = evidence.get(name) || "A failing test this output names";
  return {
    type: "choice",
    instructions: "Which test does this output identify as the failing test to name on the card?",
    criteria,
  };
}

/**
 * Whether this settled call is one the built-in parsers could not place. Phase 1's `toolKindOf`
 * always returns a value (it falls back to the category), so "the sniffers were unsure" is "the
 * fallback won": `command` or `other`. A card family, an MCP server, or any category the classifier
 * chose is already a decision and is never sent.
 */
export function eligibleForDecision(item: ToolItem): boolean {
  if (item.kind !== "tool" || item.status === "running") return false;
  const kind = item.toolKind;
  // Unset is only reachable on a replayed call; with the fold's fallback it means the same thing.
  const family = kind ?? item.category;
  if (family !== "command" && family !== "other") return false;
  return item.output.trim().length > 0;
}

/** Where one backend's request goes: the four-row table in this file's header, as data. */
export function backendPlan(config: NormalizerConfig): BackendCall | null {
  const timeoutMs = config.timeoutMs;
  switch (config.backend) {
    case "local-clef-flash": {
      if (!config.endpoint) return null;
      return { backend: config.backend, url: config.endpoint, model: LOCAL_CLEF_MODEL, key: null, timeoutMs: timeoutMs ?? 400, remote: false };
    }
    case "command-code-jev": {
      if (!config.keys.commandCode) return null;
      return {
        backend: config.backend,
        url: "https://api.commandcode.ai/provider/v1/systemone",
        model: "typesafe/jev-1.14.0",
        key: config.keys.commandCode,
        timeoutMs: timeoutMs ?? 2500,
        remote: true,
      };
    }
    case "jev": {
      if (!config.keys.jev) return null;
      return { backend: config.backend, url: config.jevBaseUrl, model: config.jevModel, key: config.keys.jev, timeoutMs: timeoutMs ?? 2500, remote: true };
    }
    case "workers-ai-clef-flash": {
      if (!config.keys.cloudflare || !config.cloudflareAccountId) return null;
      return {
        backend: config.backend,
        url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.cloudflareAccountId)}/ai/run/@cf/cloudflare/${LOCAL_CLEF_MODEL}`,
        model: LOCAL_CLEF_MODEL,
        key: config.keys.cloudflare,
        timeoutMs: timeoutMs ?? 1000,
        remote: true,
      };
    }
  }
}

/** Why the selected backend cannot be used yet, in the words the settings' Test shows. */
export function unusableReason(config: NormalizerConfig): string {
  switch (config.backend) {
    case "local-clef-flash":
      return "The local Clef-flash backend has no endpoint yet: set where your own server answers (for example http://127.0.0.1:8000/v1/systemone).";
    case "command-code-jev":
      return "The Command Code backend has no key: set it in Settings → Tool cards, or set CMD_API_KEY for the server.";
    case "jev":
      return "The Jev backend has no key: set it in Settings → Tool cards, or set TYPESAFE_API_KEY for the server.";
    case "workers-ai-clef-flash":
      return "The Workers AI backend needs an account id and an API token: set both in Settings → Tool cards.";
  }
}

/** The canned state the settings' Test sends: a fixed two-line example, never a stored call's output. */
const PROBE_STATE: Record<string, unknown> = {
  harness: "probe",
  tool: "Bash",
  command: "npm run test",
  ended: "done",
  truncated: false,
  output: "Test Files  1 passed (1)\n     Tests  3 passed (3)",
  sniffer_candidates: [],
};

/** What one chat has spent: this minute's window, and the run's own count. */
interface Budget {
  windowStart: number;
  windowCount: number;
  run: number | null;
  runCount: number;
}

export class NormalizerService {
  private readonly cache: DecisionCache;
  private readonly budgets = new Map<string, Budget>();
  private spentInputTokens = 0;
  private decisions = 0;
  private lastError: string | null = null;

  constructor(private readonly deps: NormalizerDeps) {
    this.cache = new DecisionCache(deps.cacheFile ?? null, deps.now ?? Date.now);
    void this.cache.ready();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private config(): NormalizerConfig | null {
    try {
      return this.deps.config();
    } catch {
      // A config.yml the server cannot parse is startup's problem; here it simply means no decision.
      return null;
    }
  }

  /** One call, at most once: the patch a decision adds to the row, or null (the row keeps what it had). */
  async decide(item: ToolItem, where: DecisionContext): Promise<ToolDecisionPatch | null> {
    const config = this.config();
    if (!config?.enabled) return null;
    const call = backendPlan(config);
    if (!call) return null;
    if (!eligibleForDecision(item)) return null;
    if (!this.maySpend(where)) return null;

    const pairs = candidatePairs(item).map((c) => [c.key, c.value] as [string, string | number]);
    const { state, sent } = buildEgressState(item, { harness: where.harness, workspace: where.workspace, home: this.deps.home() }, call.remote);
    const key = decisionKey({ backend: call.backend, model: call.model, minChoice: config.minChoice, minNoul: config.minNoul, toolName: item.name, candidates: pairs, output: sent });
    if (config.cache) {
      await this.cache.ready();
      const cached = this.cache.get(key);
      if (cached) {
        this.decisions += 1;
        return { toolKind: cached.toolKind, decided: cached.decided };
      }
    }

    const reply = await this.send(call, state, questionsFor(item));
    if (!reply) return null;
    this.spentInputTokens += reply.usage.input_tokens;
    const patch = this.gate(reply, config, call);
    if (!patch) return null;
    if (config.cache) this.cache.set(key, { toolKind: patch.toolKind, decided: patch.decided });
    this.decisions += 1;
    return patch;
  }

  /**
   * The gate (§8.3): both the Noul's probability and the selected option's own probability must clear
   * their thresholds. `confidence` is deliberately not read as a gate — it is derived from the same
   * distribution and is 0.04 on a correct 0.52/0.48 pick — but it is recorded on the decision.
   */
  private gate(reply: SystemOneReply, config: NormalizerConfig, call: BackendCall): ToolDecisionPatch | null {
    const show = reply.answers.show_test_card;
    const kind = reply.answers.kind;
    if (show?.type !== "noul" || kind?.type !== "choice") return null;
    if (show.noul < config.minNoul) return null;
    const probability = kind.probabilities[kind.choice];
    if (probability === undefined || probability < config.minChoice) return null;
    if (!(OPEN_KINDS as readonly string[]).includes(kind.choice)) return null;
    const picks: Record<string, string> = {};
    const failing = reply.answers.failing_test;
    if (failing?.type === "choice") {
      const pick = failing.probabilities[failing.choice];
      // Below its threshold the card shows the sniffer's counts and no name: no pick at all.
      if (pick !== undefined && pick >= config.minChoice) picks.failing_test = failing.choice;
    }
    const decided: ToolDecision = {
      by: call.backend,
      probability,
      ...(kind.confidence === undefined ? {} : { confidence: kind.confidence }),
      field: "kind",
      ...(Object.keys(picks).length > 0 ? { picks } : {}),
      at: this.now(),
    };
    return { toolKind: kind.choice as ToolKind, decided };
  }

  /** One request, bounded by its backend's timeout; every failure keeps the row and records one class of it. */
  private async send(call: BackendCall, state: Record<string, unknown>, questions: Record<string, SystemOneQuestion>): Promise<SystemOneReply | null> {
    const built = buildSystemOneRequest(call, state, questions);
    // Resolved at each request, so a test can stub the global between two decisions.
    const fetchImpl: NormalizerFetch = this.deps.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    let text: string;
    try {
      const res = await fetchImpl(built.url, { method: "POST", headers: built.headers, body: JSON.stringify(built.body), signal: AbortSignal.timeout(call.timeoutMs) });
      text = await res.text();
      if (!res.ok) {
        this.lastError = replyErrorOf(res.status, text.slice(0, 4096));
        return null;
      }
    } catch (error) {
      const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
      this.lastError = timedOut ? `no answer within ${call.timeoutMs} ms` : "the request did not complete";
      return null;
    }
    if (text.length > MAX_REPLY_CHARS) {
      this.lastError = "the reply was too large";
      return null;
    }
    let json: unknown = null;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = null;
    }
    const reply = readSystemOneReply(json);
    if (!reply) {
      this.lastError = "the reply carried no answers";
      return null;
    }
    this.lastError = null;
    return reply;
  }

  /** The settings' Test: one canned request through the same builder, reader and gate, with no user data. */
  async probe(): Promise<NormalizerProbe> {
    const config = this.config();
    if (!config?.enabled) {
      return { ok: false, backend: "disabled", model: "", latencyMs: 0, inputTokens: 0, answersSeen: [], error: "The tool-card normalizer is off.", status: this.status() };
    }
    const call = backendPlan(config);
    if (!call) {
      return { ok: false, backend: config.backend, model: "", latencyMs: 0, inputTokens: 0, answersSeen: [], error: unusableReason(config), status: this.status() };
    }
    const started = this.now();
    const reply = await this.send(call, PROBE_STATE, questionsFor(PROBE_ITEM));
    const latencyMs = this.now() - started;
    if (!reply) {
      return { ok: false, backend: call.backend, model: "", latencyMs, inputTokens: 0, answersSeen: [], error: this.lastError ?? "no answer", status: this.status() };
    }
    this.spentInputTokens += reply.usage.input_tokens;
    return {
      ok: true,
      backend: call.backend,
      model: reply.model || call.model,
      latencyMs,
      inputTokens: reply.usage.input_tokens,
      answersSeen: Object.keys(reply.answers),
      error: null,
      status: this.status(),
    };
  }

  status(): NormalizerStatus {
    const config = this.config();
    const backend = !config?.enabled ? "disabled" : backendPlan(config) ? config.backend : "unusable";
    return {
      backend,
      lastError: this.lastError,
      cacheHits: this.cache.hits,
      cacheMisses: this.cache.misses,
      decisions: this.decisions,
      spentInputTokens: this.spentInputTokens,
    };
  }

  /** Whether this chat may spend another request: 20 a minute, 200 a run, then the row keeps its look. */
  private maySpend(where: DecisionContext): boolean {
    const now = this.now();
    if (this.budgets.size > MAX_BUDGET_CHATS) this.budgets.clear();
    const budget = this.budgets.get(where.chatId) ?? { windowStart: now, windowCount: 0, run: null, runCount: 0 };
    this.budgets.set(where.chatId, budget);
    if (now - budget.windowStart >= 60_000) {
      budget.windowStart = now;
      budget.windowCount = 0;
    }
    if (budget.run !== where.runStartedAt) {
      budget.run = where.runStartedAt;
      budget.runCount = 0;
    }
    if (budget.windowCount >= CALLS_PER_MINUTE || budget.runCount >= CALLS_PER_RUN) return false;
    budget.windowCount += 1;
    budget.runCount += 1;
    return true;
  }
}

/** The question set the probe asks: the same two a real call gets, with no candidates to choose among. */
const PROBE_ITEM: ToolItem = {
  kind: "tool",
  id: "probe",
  name: "Bash",
  args: "",
  status: "done",
  output: String(PROBE_STATE.output),
  truncated: false,
  category: "command",
  summary: "npm run test",
  paths: [],
};
