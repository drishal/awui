// Stacked pull requests for a project: "stack this PR above #N" puts a new PR on
// top of an existing one (that PR's head branch becomes the new PR's target), the
// ordered stack is kept per project in the state folder, and a merge goes
// bottom-up through `gh pr merge --merge` only — no rebase, no squash, no branch
// moves of our own. Per-layer status comes from the same bounded `gh pr view` /
// `gh pr checks` calls the panel already reads; no credential is ever read,
// stored, or sent to a client, and nothing here pushes by itself.
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { GitHubCheckView, PrStack, PrStackLayer, WorkspaceInfo } from "../shared/protocol.js";
import { git } from "./git.js";
import { ChatError, errorMessage } from "./chats/chat.js";
import { createPullRequest, currentPullRequest, githubStatus, pullRequestChecksParse, pullRequestDetail, pushBranch, runGh } from "./github.js";
import { isObj, readJson, writeJsonChecked } from "./state-file.js";

/** Stacks kept in the state file. The oldest with no open layer is the one dropped. */
export const MAX_STACKS = 50;
/** A stack holds a few layers; this only bounds a hand-edited file. */
export const MAX_LAYERS = 12;
/** A layer's checks are reused for a moment, so a refresh does not re-run gh per keystroke. */
const CHECKS_TTL_MS = 15_000;

/** A layer from the state file, or null when it is not one (a hand-edited row drops out alone). */
function cleanLayer(raw: unknown): PrStackLayer | null {
  if (!isObj(raw)) return null;
  const pr = raw.pr;
  if (typeof pr !== "number" || !Number.isInteger(pr) || pr < 1) return null;
  const url = raw.url;
  if (typeof url !== "string" || !/^https:\/\//.test(url)) return null;
  const baseBranch = typeof raw.baseBranch === "string" ? raw.baseBranch : "";
  const headBranch = typeof raw.headBranch === "string" ? raw.headBranch : "";
  if (!baseBranch || !headBranch) return null;
  const worktreeId = typeof raw.worktreeId === "string" ? raw.worktreeId : undefined;
  const checks = Array.isArray(raw.checks)
    ? raw.checks.flatMap((entry): GitHubCheckView[] => {
        if (!isObj(entry)) return [];
        const name = typeof entry.name === "string" ? entry.name.slice(0, 120) : "";
        const state = typeof entry.state === "string" ? entry.state : "unknown";
        const link = typeof entry.link === "string" && /^https:\/\//i.test(entry.link) ? entry.link : null;
        return name ? [{ name, state, link }] : [];
      })
    : [];
  return {
    pr,
    url,
    title: typeof raw.title === "string" ? raw.title : "",
    state: typeof raw.state === "string" ? raw.state : "UNKNOWN",
    baseBranch,
    headBranch,
    ...(worktreeId ? { worktreeId } : {}),
    checks,
  };
}

/** A stack from the state file, or null when it is not one (a row naming another project drops out). */
function cleanStack(raw: unknown, workspaceId: string): PrStack | null {
  if (!isObj(raw)) return null;
  if (raw.workspaceId !== workspaceId) return null;
  const id = raw.id;
  if (typeof id !== "string" || !id) return null;
  const createdAt = raw.createdAt;
  if (typeof createdAt !== "number") return null;
  const base = raw.base;
  if (typeof base !== "string" || !base) return null;
  const layers = Array.isArray(raw.layers) ? raw.layers.slice(0, MAX_LAYERS).map(cleanLayer).filter((l): l is PrStackLayer => l !== null) : [];
  const mergedThrough = typeof raw.mergedThrough === "number" ? raw.mergedThrough : undefined;
  const mergedAt = typeof raw.mergedAt === "number" ? raw.mergedAt : undefined;
  return {
    id,
    workspaceId,
    workspaceName: typeof raw.workspaceName === "string" ? raw.workspaceName : "",
    createdAt,
    base,
    layers,
    ...(mergedThrough !== undefined ? { mergedThrough } : {}),
    ...(mergedAt !== undefined ? { mergedAt } : {}),
  };
}

/** The PR number in a gh URL, or NaN when the URL names none. */
const prFromUrl = (url: string): number => Number(/\/pull\/(\d+)/i.exec(url)?.[1] ?? NaN);

/** The branch the checked-out commit is on, or null when HEAD is detached. */
async function currentBranch(ws: WorkspaceInfo): Promise<string | null> {
  try {
    return (await git(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: ws.path, timeoutMs: 5000 })).trim() || null;
  } catch {
    return null;
  }
}

/** What a merge needs to run in: the stack's project, revalidated by the routes' own getter. */
export interface PrStackWorkspaces {
  get(id: string): Promise<WorkspaceInfo>;
}

export class PrStacks {
  private readonly records: PrStack[] = [];
  /** Projects with a merge running, so two merges can never interleave in one stack. */
  private readonly busy = new Set<string>();
  /** The last time a layer's checks were read, keyed by PR number. */
  private readonly checksAt = new Map<number, number>();

  private constructor(
    private readonly file: string | null,
    private readonly workspaces: PrStackWorkspaces,
  ) {}

  /** Tests: a store without a backing file. */
  static inMemory(workspaces: PrStackWorkspaces): PrStacks {
    return new PrStacks(null, workspaces);
  }

  static async open(stateDir: string, workspaces: PrStackWorkspaces): Promise<PrStacks> {
    const store = new PrStacks(path.join(stateDir, "pr-stacks.json"), workspaces);
    await store.load();
    return store;
  }

  list(workspaceId: string): PrStack[] {
    return this.records.filter((stack) => stack.workspaceId === workspaceId);
  }

  required(id: string): PrStack {
    const stack = this.records.find((stack) => stack.id === id);
    if (!stack) throw new ChatError(404, "no_stack", "No such pull-request stack; it may have been pruned");
    return stack;
  }

  async load(): Promise<void> {
    const raw = await readJson(this.file);
    if (!Array.isArray(raw)) return;
    const byId = new Map<string, PrStack>();
    for (const value of raw.slice(0, MAX_STACKS * 2)) {
      if (!isObj(value)) continue;
      const workspaceId = typeof value.workspaceId === "string" ? value.workspaceId : "";
      if (!workspaceId) continue;
      const stack = cleanStack(value, workspaceId);
      if (stack && !byId.has(stack.id)) byId.set(stack.id, stack);
    }
    this.records.length = 0;
    this.records.push(...byId.values());
    this.records.sort((a, b) => b.createdAt - a.createdAt);
    this.records.length = Math.min(this.records.length, MAX_STACKS);
  }

  private write(): Promise<void> {
    return writeJsonChecked(this.file, this.records);
  }

  /** Drop the oldest stacks that have no open layer; a stack in progress is never pruned. */
  private trim(): void {
    if (this.records.length <= MAX_STACKS) return;
    for (let i = this.records.length - 1; i >= 0 && this.records.length > MAX_STACKS; i -= 1) {
      const stack = this.records[i];
      if (!stack) continue;
      if (!stack.layers.some((l) => l.state === "OPEN" || l.state === "DRAFT")) this.records.splice(i, 1);
    }
  }

  /** A new stack whose bottom layer targets the given base; layers join it one request at a time. */
  async create(workspaceId: string, workspaceName: string, base: string): Promise<PrStack> {
    const record: PrStack = { id: randomUUID(), workspaceId, workspaceName, createdAt: Date.now(), base, layers: [] };
    this.records.unshift(record);
    this.trim();
    await this.write();
    return record;
  }

  /** A layer's checks, reused for a moment: a panel's refresh must not run gh once per layer per look. */
  private async checksFor(ws: WorkspaceInfo, layer: PrStackLayer): Promise<void> {
    const now = Date.now();
    if (layer.checks.length > 0 && now - (this.checksAt.get(layer.pr) ?? 0) < CHECKS_TTL_MS) return;
    try {
      layer.checks = pullRequestChecksParse(await runGh(["pr", "checks", String(layer.pr), "--json", "name,state,link,bucket"], ws.path));
    } catch {
      layer.checks = [];
    }
    this.checksAt.set(layer.pr, now);
  }

  /**
   * The stack as the panel draws it: each layer's live state, title, and target
   * branch from `gh pr view` (GitHub retargets a stacked PR when the layer below
   * merges, so the recorded base follows GitHub's), plus its reported checks.
   * One call per layer; what was last seen is written back for a restart.
   */
  async view(stack: PrStack): Promise<PrStack> {
    const ws = await this.workspaces.get(stack.workspaceId);
    let changed = false;
    for (const layer of stack.layers) {
      const detail = await pullRequestDetail(ws, layer.pr);
      if (detail) {
        if (detail.state !== layer.state) { layer.state = detail.state; changed = true; }
        if (detail.title && detail.title !== layer.title) { layer.title = detail.title; changed = true; }
        if (detail.baseRefName !== layer.baseBranch) { layer.baseBranch = detail.baseRefName; changed = true; }
        await this.checksFor(ws, layer);
      }
    }
    if (changed) await this.write();
    return stack;
  }

  /**
   * Stack a new PR above #above: that PR's head branch becomes the target of a PR
   * from the checked-out branch. When `push` is set the checked-out branch goes to
   * origin first — one deliberate action carried in the same request.
   */
  async stackAbove(id: string, above: number, title: string, body: string, push: boolean): Promise<{ stack: PrStack; layer: PrStackLayer }> {
    const stack = this.required(id);
    const ws = await this.workspaces.get(stack.workspaceId);
    const status = await githubStatus(ws);
    if (!status.available) throw new ChatError(409, "github_unavailable", status.reason ?? "gh is not logged in here");
    const detail = await pullRequestDetail(ws, above);
    if (!detail) throw new ChatError(404, "no_pr", `GitHub has no pull request #${above} in this repository`);
    const head = await currentBranch(ws);
    if (!head) throw new ChatError(409, "detached_head", "Check out a branch before stacking a pull request on it");
    if (detail.headRefName === head) throw new ChatError(409, "same_branch", `#${above}'s head branch \`${detail.headRefName}\` is checked out; stack its changes on another branch`);
    const layer = await this.createLayer(stack, ws, detail.headRefName, title, body, push);
    return { stack, layer };
  }

  /** Open the first pull request of a stack, targeting the explicit base branch. */
  async start(id: string, base: string, title: string, body: string, push: boolean): Promise<{ stack: PrStack; layer: PrStackLayer }> {
    const stack = this.required(id);
    const ws = await this.workspaces.get(stack.workspaceId);
    const status = await githubStatus(ws);
    if (!status.available) throw new ChatError(409, "github_unavailable", status.reason ?? "gh is not logged in here");
    const head = await currentBranch(ws);
    if (!head) throw new ChatError(409, "detached_head", "Check out a branch before opening the first pull request of a stack");
    if (base === head) throw new ChatError(409, "same_branch", `\`${base}\` is checked out; a pull request needs another branch checked out`);
    const layer = await this.createLayer(stack, ws, base, title, body, push);
    return { stack, layer };
  }

  /** The one place a layer is created: the asked-for push, then gh's own PR create. */
  private async createLayer(stack: PrStack, ws: WorkspaceInfo, baseBranch: string, title: string, body: string, push: boolean): Promise<PrStackLayer> {
    if (push) await pushBranch(ws);
    const created = await createPullRequest(ws, baseBranch, title, body);
    let pr = prFromUrl(created.url);
    if (!Number.isInteger(pr)) pr = prFromUrl((await currentPullRequest(ws))?.url ?? "");
    const layer: PrStackLayer = { pr, url: created.url, title: created.title, state: "OPEN", baseBranch, headBranch: (await currentBranch(ws)) ?? "", checks: [] };
    if (!Number.isInteger(layer.pr)) throw new ChatError(502, "github_failed", "GitHub created no PR number in its URL; inspect the result with gh");
    stack.layers.unshift(layer);
    stack.layers.length = Math.min(stack.layers.length, MAX_LAYERS);
    await this.write();
    return layer;
  }

  /**
   * Merge bottom-up: the oldest open layer first, then the next, until a merge is
   * refused or the stack is through. GitHub retargets each upper PR as the layer
   * below merges, so one `gh pr merge --merge` per layer is the whole story. A
   * refusal stops the merge with the layers that did merge persisted, never thrown
   * away; an archive refusal is collected beside it, its worktree kept.
   */
  async merge(id: string, archive?: (ws: WorkspaceInfo, pr: number, worktreeId: string | undefined) => Promise<void>): Promise<{
    stack: PrStack;
    mergedThrough: number | undefined;
    refusal: { pr: number; message: string } | undefined;
    archiveRefusals: Array<{ pr: number; message: string }>;
  }> {
    const stack = this.required(id);
    if (this.busy.has(stack.workspaceId)) throw new ChatError(409, "busy", "This project is already merging a stack; try again in a moment");
    this.busy.add(stack.workspaceId);
    const archiveRefusals: Array<{ pr: number; message: string }> = [];
    let mergedThrough: number | undefined;
    let refusal: { pr: number; message: string } | undefined;
    try {
      const ws = await this.workspaces.get(stack.workspaceId);
      const open = [...stack.layers].filter((l) => l.state === "OPEN" || l.state === "DRAFT").reverse();
      for (const layer of open) {
        try {
          await runGh(["pr", "merge", String(layer.pr), "--merge"], ws.path);
        } catch (error) {
          refusal = { pr: layer.pr, message: errorMessage(error) };
          break;
        }
        layer.state = "MERGED";
        mergedThrough = layer.pr;
        await this.write();
        if (layer.worktreeId && archive) {
          try {
            await archive(ws, layer.pr, layer.worktreeId);
          } catch (error) {
            archiveRefusals.push({ pr: layer.pr, message: errorMessage(error) });
          }
        }
      }
      if (mergedThrough !== undefined) {
        stack.mergedThrough = mergedThrough;
        stack.mergedAt = Date.now();
        await this.write();
      }
    } finally {
      this.busy.delete(stack.workspaceId);
    }
    return { stack, mergedThrough, refusal, archiveRefusals };
  }

  /** Forget a stack (the panel's Delete): its records are awui's own, nothing else is touched. */
  async forget(id: string): Promise<void> {
    const at = this.records.findIndex((stack) => stack.id === id);
    if (at < 0) return;
    this.records.splice(at, 1);
    await this.write();
  }
}
