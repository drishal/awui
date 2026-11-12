// Opt-in PR activity watches. Each record names its original chat's native session, project,
// and HTTPS PR URL; the caller resolves that session and performs the actual delivery. This
// module never invents a transcript, contacts a harness directly, or stores credentials.
import { z } from "zod";
import path from "node:path";
import { readJson, writeJsonChecked, isObj } from "./state-file.js";
import type { WorkspaceInfo } from "../shared/protocol.js";
import type { GitHubCheck } from "./github.js";
import { pullRequestChecks, runGh } from "./github.js";
import { ChatError } from "./chats/chat.js";

export const MAX_PR_WATCHES = 12;
export const PR_WATCH_INTERVAL_MS = 30_000;
export const MAX_REPAIR_EVIDENCE_CHARS = 32_000;
export const MAX_REVIEW_EXCERPT_CHARS = 600;

export interface PrSnapshot {
  url: string;
  title: string;
  state: string;
  isDraft: boolean;
  checks: GitHubCheck[];
  failingRuns: Array<{ name: string; runId: string | null }>;
  reviewExcerpts: string[];
}

export interface PrWatch {
  id: string;
  workspaceId: string;
  harnessId: string;
  nativeId: string;
  url: string;
  title: string;
  lastSnapshot: PrSnapshot;
  lastDelivered: string | null;
  deliveredCount: number;
  createdAt: number;
}

export type PrDelivery = (watch: PrWatch, report: string) => Promise<void>;

type PRWatchData = { version: 1; watches: PrWatch[]; repairs: Array<{ ownerSession: string; chatId: string; url: string; createdAt: number }> };

/** Same shapes as PrSnapshot as an untrusted control record. No huge transcripts or wrong owners. */
const watchRowSchema = z.object({
  id: z.string().min(1).max(512), workspaceId: z.string().min(1).max(64), harnessId: z.string().min(1).max(64), nativeId: z.string().min(1).max(512),
  url: z.string().url().max(2048).refine((value) => /^https:\/\/[^\s]+\/pull\/[0-9]{1,18}\/?$/.test(value)),
  title: z.string().max(4_000),
  lastSnapshot: z.object({
    url: z.string().url().max(2048), title: z.string().max(4_000), state: z.string().max(100), isDraft: z.boolean(),
    checks: z.array(z.object({ name: z.string().max(120), state: z.string().max(64), link: z.string().nullable() })).max(200),
    failingRuns: z.array(z.object({ name: z.string().max(120), runId: z.string().nullable() })).max(200),
    reviewExcerpts: z.array(z.string().max(MAX_REVIEW_EXCERPT_CHARS)).max(20),
  }),
  lastDelivered: z.string().max(16000).nullable(),
  deliveredCount: z.number().int().nonnegative().default(0),
  createdAt: z.number().nonnegative(),
}).passthrough();

export function prFingerprint(snapshot: PrSnapshot): string {
  return JSON.stringify({ url: snapshot.url, state: snapshot.state, draft: snapshot.isDraft, checks: snapshot.checks, failingRuns: snapshot.failingRuns, reviews: snapshot.reviewExcerpts });
}

export function checkRunId(link: string | null): string | null {
  const part = link?.split("/runs/")[1];
  if (!part) return null;
  const tail = part.split("/")[0] ?? "";
  return /^\d{1,20}$/.test(tail) ? tail : null;
}

export function clipRepairLog(raw: string, budget = MAX_REPAIR_EVIDENCE_CHARS): string {
  if (raw.length <= budget) return raw;
  const marker = "[awui: earlier log lines omitted]\n";
  return marker + raw.slice(-Math.max(0, budget - marker.length));
}

/** Actual gh output, bounded and labelled as the failing check's evidence in the repair chat. */
export function repairPrompt(title: string, url: string, checks: GitHubCheck[], log: string): string {
  const names = checks.filter((check) => /fail|error|cancel|timeout|block/i.test(check.state)).map((check) => check.name);
  return [
    `Investigate only this pull request's failing CI: ${title}\n${url}`,
    `Reported failing checks: ${names.join(", ") || "see the log"}. Read the current change and evidence first, then make the smallest relevant fix and run the appropriate local checks. Report the actual result; do not push or create another PR.`,
    clipRepairLog(log),
  ].join("\n\n");
}

export class PrWatches {
  private readonly rows = new Map<string, PrWatch>();
  private readonly repairs = new Map<string, { chatId: string; url: string; createdAt: number }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling: Promise<void> = Promise.resolve();
  private stopped = false;

  private constructor(private readonly file: string | null, private readonly deliver: PrDelivery, private readonly resolve: (workspaceId: string) => Promise<WorkspaceInfo>) {}

  static async open(stateDir: string | null, deliver: PrDelivery, resolve: (workspaceId: string) => Promise<WorkspaceInfo>): Promise<PrWatches> {
    const store = new PrWatches(stateDir ? path.join(stateDir, "pr-watches.json") : null, deliver, resolve);
    const raw = (await readJson(store.file)) as Partial<PRWatchData> | null;
    if (raw?.version !== 1 || !Array.isArray(raw.watches)) return store;
    // Old or hand-edited rows must prove their source identities before they can wake anyone.
    for (const row of raw.watches) {
      const parsed = watchRowSchema.safeParse(row);
      if (!parsed.success) continue;
      const watch = parsed.data satisfies PrWatch;
      if (watch.lastSnapshot.url !== watch.url) continue;
      store.rows.set(`${watch.nativeId}\0${watch.url}`, watch);
    }
    store.ensurePolling();
    return store;
  }

  list(nativeId?: string): PrWatch[] { return [...this.rows.values()].filter((watch) => !nativeId || watch.nativeId === nativeId); }

  async add(chat: { workspace: WorkspaceInfo; harnessId: string; sessionId: string | null }, snapshot: PrSnapshot): Promise<PrWatch> {
    if (!chat.sessionId) throw new ChatError(409, "no_session", "A chat needs its own harness session before creating a persistent PR watch");
    const key = `${chat.sessionId}\0${snapshot.url}`;
    if (this.rows.has(key)) throw new ChatError(409, "watch_exists", "This chat already watches this pull request");
    if (this.list(chat.sessionId).length >= MAX_PR_WATCHES) throw new ChatError(409, "watch_limit", `At most ${MAX_PR_WATCHES} watches for one chat`);
    const watch: PrWatch = {
      id: key, workspaceId: chat.workspace.id, harnessId: chat.harnessId, nativeId: chat.sessionId,
      url: snapshot.url, title: snapshot.title, lastSnapshot: snapshot,
      // The registration poll is a baseline, never a false "activity" wake.
      lastDelivered: prFingerprint(snapshot), createdAt: Date.now(), deliveredCount: 0,
    };
    this.rows.set(key, watch);
    await this.persist(); // An accepted watch reaches durable state before the timer can observe it.
    this.ensurePolling();
    return watch;
  }

  async remove(nativeId: string, url: string): Promise<boolean> {
    const removed = this.rows.delete(`${nativeId}\0${url}`);
    await this.persist();
    return removed;
  }

  repaired(chatId: string): boolean {
    return [...this.repairs.values()].some((entry) => entry.chatId === chatId && Date.now() - entry.createdAt < 7 * 86_400_000);
  }

  async recordRepair(ownerSession: string, chatId: string, url: string): Promise<void> {
    this.repairs.set(`${ownerSession}\0${url}`, { chatId, url, createdAt: Date.now() });
    await this.persist();
  }

  tick(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.polling = this.polling.then(async () => {
      for (const watch of this.rows.values()) {
        try {
          const snapshot = await readPrSnapshot(await this.resolve(watch.workspaceId), watch.url);
          await this.observe(watch, snapshot);
        } catch (error) {
          const now = Date.now();
          const text = error instanceof Error ? error.message : String(error);
          // Provider failures are reported once as progress information, never hidden as durable silence.
          const previousError = (watch as PrWatch & { lastError?: string }).lastError;
          if (previousError !== text) {
            (watch as PrWatch & { lastError?: string }).lastError = text;
            await this.deliver(watch, `[awui PR watch] Could not read ${watch.url} now: ${text.slice(0, 240)}. Your watch stays active.`).catch(() => undefined);
            void now;
          }
        }
      }
      if (this.rows.size === 0) {
        if (this.timer !== null) clearInterval(this.timer);
        this.timer = null;
      }
    });
    return this.polling;
  }

  /** A changed fingerprint becomes pending before contacting its owner. Failed delivery retries next tick. */
  async observe(watch: PrWatch, snapshot: PrSnapshot): Promise<void> {
    const fingerprint = prFingerprint(snapshot);
    if (fingerprint === watch.lastDelivered) return;
    const before = watch.lastSnapshot;
    watch.lastSnapshot = snapshot;
    await this.persist();
    verifyGitHubSnapshot(snapshot);
    const flags = [...snapshot.checks].map((check) => `${check.name}: ${check.state}`).slice(0, 12);
    const reviewNote = snapshot.reviewExcerpts === before.reviewExcerpts ? "" : "\nReview activity has changed.";
    const message = `[awui PR activity] ${snapshot.title}\n${snapshot.url}\nState: ${snapshot.state}${snapshot.isDraft ? " (draft)" : ""}${flags.length ? `\nChecks: ${flags.join("; ")}` : ""}${reviewNote}`;
    await this.deliver(watch, message.slice(0, 6000));
    watch.lastDelivered = fingerprint;
    watch.deliveredCount += 1;
    await this.persist();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    await this.polling;
  }

  private ensurePolling(): void {
    if (this.rows.size === 0 || this.timer !== null) return;
    this.timer = setInterval(() => void this.tick().catch(() => undefined), PR_WATCH_INTERVAL_MS);
    this.timer.unref?.();
  }

  private async persist(): Promise<void> {
    if (!this.file) return;
    await writeJsonChecked(this.file, { version: 1, watches: [...this.rows.values()], repairs: [...this.repairs.entries()].map(([ownerSession, entry]) => ({ ownerSession, ...entry })) });
  }
}

export function assertPrUrl(url: string): number {
  const match = /^https:\/\/[^\s]+\/pull\/([0-9]{1,18})\/?$/.exec(url);
  if (!match) throw new ChatError(400, "bad_pr", "Use an HTTPS GitHub pull-request URL that ends in /pull/<number>");
  return Number(match[1]);
}

/** Reject unexpected gh shapes instead of mistaking a partial or malformed payload for CI state. */
function verifyGitHubSnapshot(snapshot: PrSnapshot): void {
  if (snapshot.state.length > 100 || snapshot.title.length > 4_000 || !Array.isArray(snapshot.checks) || snapshot.checks.length > 200) throw new ChatError(502, "github_bad_payload", "The PR activity response was out of bounds");
  if (snapshot.reviewExcerpts.some((line) => line.length > MAX_REVIEW_EXCERPT_CHARS)) throw new ChatError(502, "github_bad_payload", "A review excerpt was out of bounds");
}

export async function readPrSnapshot(ws: WorkspaceInfo, url: string): Promise<PrSnapshot> {
  assertPrUrl(url);
  const doc = JSON.parse(await runGh(["pr", "view", url, "--json", "url,title,state,isDraft,reviews"], ws.path)) as { url?: string; title?: string; state?: string; isDraft?: boolean; reviews?: Array<{ author?: { login?: string }; body?: string }> };
  if (doc.url !== url || typeof doc.title !== "string" || typeof doc.state !== "string" || typeof doc.isDraft !== "boolean") throw new ChatError(502, "github_bad_payload", "GitHub answered an unexpected PR payload");
  const checks = await pullRequestChecks(ws);
    const snapshot: PrSnapshot = {
    url: doc.url, title: doc.title, state: doc.state, isDraft: doc.isDraft, checks,
    failingRuns: checks.filter((check) => /fail|error|cancel|timeout/i.test(check.state)).map((check) => ({ name: check.name, runId: checkRunId(check.link) })),
    reviewExcerpts: (Array.isArray(doc.reviews) ? doc.reviews : []).slice(0, 20).map((review) => `${review.author?.login ?? "reviewer"}: ${(review.body ?? "").trim()}`).filter(Boolean).map((line) => line.slice(0, MAX_REVIEW_EXCERPT_CHARS)),
  };
  verifyGitHubSnapshot(snapshot);
  return snapshot;
}

export async function failingCheckLog(ws: WorkspaceInfo, runId: string | null, limit = 2100): Promise<string> {
  if (runId === null || !/^\d{1,20}$/.test(runId)) return "The failing check has no downloadable run log; inspect its checks locally.";
  return `gh run view ${runId} --log-failed\n\n${(await runGh(["run", "view", runId, "--log-failed"], ws.path)).slice(-limit)}`;
}
