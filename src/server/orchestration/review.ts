// Review-gated integration (A6): "completed" is not "reviewed". A delegated worker's
// finished work becomes a review record — the worktree it worked in, its branch, the
// lead checkout's HEAD as the worker's own snapshot saw it, and the fork point — and a
// person's explicit review decision unlocks applying it into the lead checkout. The
// apply is races.ts's own: a clean lead checkout still at the recorded heads, a patch
// generated with fixed diff options and carried as bytes (gitBuffer), written unstaged.
// Nothing is committed, pushed, or moved, and a stale state never erases work: a
// mismatched head keeps the worktree with an actionable reason instead.
//
// The records live in the state folder (`integration.json`), so a review outlives its
// open chats; a worktree without a review decision is refused at cleanup, the inverse
// unreview puts a decision back, and ordinary user worktrees and races are untouched —
// this service only ever touches worktrees it created for delegation isolation.
import { promises as fs } from "node:fs";
import path from "node:path";
import { git, gitBuffer } from "../git.js";
import { isObj, readJson, writeJsonChecked } from "../state-file.js";
import { isWithin } from "../workspaces.js";
import { ChatError, errorMessage } from "../chats/chat.js";
import type { WorktreeService } from "../worktrees.js";

/** The fixed diff options races.ts pins its patches with, shared here for the same reason:
 *  `git apply` reads back the very bytes a diff makes, so the user's own `diff.noprefix`,
 *  `diff.relative`, or a textconv driver must not rewrite them. Pinned once, in races.ts;
 *  this list must match `PATCH_OPTIONS` there (plus `--binary`). */
const DIFF_OPTIONS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"];
const PATCH_OPTIONS = ["--binary", ...DIFF_OPTIONS];
/** A patch this route may write into the lead checkout; a larger one is merged by hand. */
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
/** A git read that must answer: past this, unknown counts as unsafe. */
const READ = { timeoutMs: 20_000 };
/** A git status that fails says nothing about the tree, so it counts as dirty: unknown is not safe. */
async function isDirty(tree: string): Promise<boolean> {
  let status: string;
  try {
    status = await git(["status", "--porcelain"], { cwd: tree, ...READ });
  } catch {
    return true;
  }
  return status
    .split("\n")
    .map((line) => line.trim())
    .some((line) => line.length > 0 && !line.endsWith(".awui") && !line.includes(".awui/"));
}

/** Commits in `tree` that `ref` does not have, or null when git cannot say. */
async function unmergedInTree(tree: string, ref: string): Promise<number | null> {
  try {
    const out = await git(["rev-list", "--count", "HEAD", `^${ref}`], { cwd: tree, ...READ });
    const count = Number(out.trim());
    return Number.isInteger(count) ? count : null;
  } catch {
    return null;
  }
}

/**
 * One worker's review record, as the state folder keeps it. The two heads are what a
 * review gates on: `fork` is the commit the worker's worktree was created from, and
 * `leadHead` is the lead checkout's HEAD when the record was made — the snapshot the
 * worker's changes were measured against. A review applies only when both still stand.
 */
import type { IntegrationRecord } from "../../shared/protocol.js";
export type { IntegrationRecord } from "../../shared/protocol.js";

/** What the store needs: the projects' roots and their managed trees. */
export interface ReviewProject {
  root: string;
  ws: { id: string; path: string };
  trees: WorktreeService;
}

/** A record from the state file, or null when it is not one (a hand-edited row loses only itself). */
function cleanRecord(raw: unknown): IntegrationRecord | null {
  if (!isObj(raw)) return null;
  const { taskId, workspaceId, workspacePath, worktreeId, branch, fork, leadHead, createdAt, review, appliedAt, discardedAt } = raw;
  if (typeof taskId !== "string" || !/^[0-9a-f]{4,16}$/.test(taskId)) return null;
  if (typeof workspaceId !== "string" || !workspaceId) return null;
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) return null;
  if (typeof worktreeId !== "string" || !worktreeId) return null;
  if (typeof branch !== "string" || !branch) return null;
  if (typeof fork !== "string" || !/^[0-9a-f]{40}$/.test(fork)) return null;
  if (typeof leadHead !== "string" || !/^[0-9a-f]{40}$/.test(leadHead)) return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  const record: IntegrationRecord = {
    taskId,
    workspaceId,
    workspacePath,
    worktreeId,
    branch,
    fork,
    leadHead,
    createdAt,
    review: null,
    appliedAt: null,
    discardedAt: null,
  };
  if (isObj(review) && (review.decision === "apply" || review.decision === "discard")) {
    record.review = {
      decision: review.decision,
      note: typeof review.note === "string" ? review.note.slice(0, 2000) : "",
      at: typeof review.at === "number" ? review.at : createdAt,
      by: typeof review.by === "string" ? review.by.slice(0, 128) : "",
    };
  }
  if (typeof appliedAt === "number" && Number.isFinite(appliedAt)) record.appliedAt = appliedAt;
  if (typeof discardedAt === "number" && Number.isFinite(discardedAt)) record.discardedAt = discardedAt;
  return record;
}

/** The newest fifty are kept; the store's file is one per process. */
export const MAX_INTEGRATIONS = 50;

/** A relative path a caller named: no absolute paths, no `..`, nothing a shell would read specially. */
function cleanRelative(raw: string): string {
  if (!raw || raw.length > 4096 || raw.includes("\0") || raw.includes("\\")) throw new ChatError(400, "bad_path", "Name a file inside the worktree");
  if (raw.startsWith("/") || raw.split("/").some((part) => part === "" || part === "." || part === "..")) throw new ChatError(400, "bad_path", "Paths are relative to the worktree, with no `..`");
  return raw;
}

/** A file's diff against the fork point, bounded like a race member's. */
export interface IntegrationFileDiff {
  path: string;
  diff: string;
}

/**
 * The review ledger. One instance per process; the record store is its own file so the
 * delegation records' file never carries a person's decisions.
 */
export class IntegrationReview {
  private records: IntegrationRecord[] = [];
  /** Project roots with an apply running, so two of them never interleave in one checkout. */
  private readonly busy = new Set<string>();
  private loaded: Promise<void> | null = null;

  constructor(
    private readonly file: string | null,
    /** The lead checkout's diff preview for one file, read from the worker's worktree. */
    private readonly diffFile: (record: IntegrationRecord, file: string, project: ReviewProject) => Promise<{ path: string; diff: string }>,
  ) {}

  static async open(stateDir: string | null | undefined, diffFile: IntegrationReview["diffFile"]): Promise<IntegrationReview> {
    const review = new IntegrationReview(stateDir ? path.join(stateDir, "orchestration", "integration.json") : null, diffFile);
    await review.ready();
    return review;
  }

  private ready(): Promise<void> {
    this.loaded ??= this.load();
    return this.loaded;
  }

  private async load(): Promise<void> {
    const raw = await readJson(this.file);
    if (!Array.isArray(raw)) return;
    for (const value of raw.slice(0, MAX_INTEGRATIONS * 2)) {
      const record = cleanRecord(value);
      if (record) this.records.push(record);
    }
    this.records.sort((a, b) => b.createdAt - a.createdAt);
    this.records.length = Math.min(this.records.length, MAX_INTEGRATIONS);
  }

  list(): IntegrationRecord[] {
    return [...this.records];
  }

  get(taskId: string): IntegrationRecord | undefined {
    return this.records.find((record) => record.taskId === taskId);
  }

  private required(taskId: string): IntegrationRecord {
    const record = this.get(taskId);
    if (!record) throw new ChatError(404, "no_integration", `No review record for task ${taskId}`);
    return record;
  }

  private async write(): Promise<void> {
    await writeJsonChecked(this.file, this.records);
  }

  /**
   * Record a finished worker's work for review. Made once per task: a repeat returns the
   * standing record, so a retried finish never duplicates a review. The lead head is read
   * here, at the moment the work finished — the point a later review measures drift from.
   */
  async track(input: {
    taskId: string;
    workspaceId: string;
    workspacePath: string;
    worktreeId: string;
    branch: string;
    fork: string;
  }): Promise<IntegrationRecord> {
    await this.ready();
    const standing = this.get(input.taskId);
    if (standing) return standing;
    const head = (await git(["rev-parse", "--verify", "--end-of-options", "HEAD"], { cwd: input.workspacePath, ...READ }).catch(() => "")).trim();
    const record: IntegrationRecord = {
      taskId: input.taskId,
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      worktreeId: input.worktreeId,
      branch: input.branch,
      fork: input.fork,
      leadHead: head,
      createdAt: Date.now(),
      review: null,
      appliedAt: null,
      discardedAt: null,
    };
    this.records.unshift(record);
    this.records.length = Math.min(this.records.length, MAX_INTEGRATIONS);
    await this.write().catch((error: unknown) => {
      this.records = this.records.filter((r) => r !== record);
      throw new ChatError(500, "store_failed", `Could not record the review: ${errorMessage(error)}`);
    });
    return record;
  }

  /**
   * Whether the record's heads still stand: the worker's branch at its fork, and the lead
   * checkout at the head the snapshot recorded. A moved checkout or an advanced branch is
   * stale, and a stale record is never applied — it is guarded and kept actionable.
   */
  async headsMatch(record: IntegrationRecord, project: ReviewProject): Promise<{ match: boolean; leadHead: string | null; reason: string | null }> {
    if (!(await existsDir(project.root))) return { match: false, leadHead: null, reason: "workspace_gone" };
    const leadHead = (await git(["rev-parse", "--verify", "--end-of-options", "HEAD"], { cwd: project.root, ...READ }).catch(() => "")).trim() || null;
    if (leadHead === null) return { match: false, leadHead: null, reason: "git_failed" };
    if (leadHead !== record.leadHead) {
      return { match: false, leadHead, reason: "lead_moved" };
    }
    const branchHead = (await git(["rev-parse", "--verify", "--end-of-options", `refs/heads/${record.branch}`], { cwd: project.root, ...READ, okExit: [1] }).catch(() => "")).trim() || null;
    if (branchHead !== record.fork) return { match: false, leadHead, reason: "worker_changed" };
    return { match: true, leadHead, reason: null };
  }

  /**
   * The person's review. `apply` records the decision and puts the worker's changes
   * against the fork point into the lead checkout — only while both heads still match,
   * and only into a clean checkout; the patch is written unstaged and nothing is
   * committed or pushed. `discard` records the decision and leaves the worktree for the
   * cleanup call to take (it refuses unreviewed modifications, so the decision is the key).
   * Either way a mismatched head refuses before anything is written.
   */
  async reviewTask(taskId: string, decision: "apply" | "discard", note: string, by: string, project: ReviewProject): Promise<{ record: IntegrationRecord; applied: boolean; instructions: string }> {
    await this.ready();
    const record = this.required(taskId);
    if (record.appliedAt !== null || record.discardedAt !== null) {
      throw new ChatError(409, "already_settled", `Task ${taskId}'s work was already ${record.appliedAt !== null ? "applied" : "discarded"}`);
    }
    const heads = await this.headsMatch(record, project);
    if (!heads.match) {
      throw new ChatError(409, heads.reason ?? "heads_moved", staleMessage(record, heads.reason, heads.leadHead));
    }
    if (decision === "apply") {
      this.lock(project.root);
      let applied = false;
      try {
        const tree = await this.treePath(record, project);
        if (tree === null || !(await existsDir(tree))) throw new ChatError(410, "worktree_gone", "This worker's worktree is gone, so its changes cannot be applied");
        applied = await this.applyPatch(record, tree, project);
      } finally {
        this.busy.delete(project.root);
      }
      record.review = { decision, note: note.slice(0, 2000), at: Date.now(), by: by.slice(0, 128) };
      record.appliedAt = Date.now();
      await this.write();
      return {
        record,
        applied,
        instructions: `Task ${taskId}'s changes are in the lead checkout's working tree, unstaged. Review them with git diff, then commit what you want; the worktree is kept until cleanup takes it.`,
      };
    }
    record.review = { decision, note: note.slice(0, 2000), at: Date.now(), by: by.slice(0, 128) };
    record.discardedAt = Date.now();
    await this.write();
    return {
      record,
      applied: false,
      instructions: `Task ${taskId}'s work is marked discarded. Run cleanup to remove its worktree and branch; the record keeps the decision.`,
    };
  }

  /**
   * The patch races.ts would write: the worker's worktree diffed against the fork point
   * (its changes live there), applied into a clean lead checkout at the fork, with fixed
   * options and carried as bytes (gitBuffer).
   */
  private async applyPatch(record: IntegrationRecord, workerTree: string, project: ReviewProject): Promise<boolean> {
    const status = await git(["status", "--porcelain", "--untracked-files=normal"], { cwd: project.root, ...READ });
    if (status.trim()) throw new ChatError(409, "dirty_checkout", "The lead checkout has uncommitted changes. Commit or stash them, then review again; nothing was changed");
    const head = (await git(["rev-parse", "--verify", "--end-of-options", "HEAD"], { cwd: project.root, ...READ })).trim();
    if (head !== record.fork) throw new ChatError(409, "head_moved", `The lead checkout's HEAD is not the fork point, so nothing was applied. Merge \`${record.branch}\` by hand instead`);
    // Bytes, not text (gitBuffer): `git apply` writes these very bytes back.
    const patch = await gitBuffer(["diff", ...PATCH_OPTIONS, record.fork], { cwd: workerTree, ...READ }).catch((error: unknown) => {
      throw new ChatError(422, "git_failed", errorMessage(error));
    });
    if (patch.length === 0) return true; // Empty work is also an explicit review outcome; it must not erase or fabricate lead changes.
    if (patch.length > MAX_PATCH_BYTES) throw new ChatError(413, "patch_too_large", "This change is too large to apply from here; merge its branch by hand instead");
    // A clean checkout at the fork point cannot conflict, so a plain apply is enough,
    // and only a plain apply leaves the result unstaged (`--3way` writes the index).
    await git(["apply", "--check", "-"], { cwd: project.root, ...READ, input: patch }).catch((error: unknown) => {
      throw new ChatError(409, "apply_failed", `The patch does not apply: ${errorMessage(error)}`);
    });
    await git(["apply", "-"], { cwd: project.root, ...READ, input: patch }).catch((error: unknown) => {
      throw new ChatError(409, "apply_failed", `The patch could not be written: ${errorMessage(error)}`);
    });
    return true;
  }

  /**
   * Take a settled worker's worktree back: the review decision must exist, the tree must
   * be clean (`.awui` aside), and the branch must still be the one the record names —
   * git's own `-d` refuses an unmerged branch, which stays for the user. An unreviewed
   * record with uncommitted work is refused: nothing here erases work nobody reviewed.
   */
  async cleanup(taskId: string, project: ReviewProject): Promise<{ removed: boolean; branchRemoved: boolean; reason: string | null }> {
    await this.ready();
    const record = this.required(taskId);
    if (!(await existsDir(project.root))) throw new ChatError(410, "workspace_gone", "The lead workspace is gone");
    if (!isWithin(project.root, project.ws.path)) throw new ChatError(400, "bad_path", "That worktree is outside this project");
    const tree = await this.treePath(record, project);
    if (tree === null) {
      // The tree is already gone (a race's cleanup, a user's own removal): drop the record's pointer.
      await project.trees.forget(project.ws as never, record.worktreeId).catch(() => undefined);
      return { removed: false, branchRemoved: false, reason: "worktree_gone" };
    }
    if (!(await existsDir(tree))) {
      await project.trees.forget(project.ws as never, record.worktreeId).catch(() => undefined);
      return { removed: false, branchRemoved: false, reason: "worktree_gone" };
    }
    if (record.review === null) {
      // Unreviewed modifications: the refusal is the feature. The worktree stays with an
      // actionable reason, never erased behind a person's review.
      if (await isDirty(tree)) throw new ChatError(409, "unreviewed", `Task ${taskId}'s worktree has unreviewed changes. Review or discard them before cleanup; nothing was removed`);
      // A clean tree with no decision is still unreviewed by definition (A6): keep it.
      throw new ChatError(409, "unreviewed", `Task ${taskId}'s work has not been reviewed. Apply or discard it before cleanup; nothing was removed`);
    }
    // A reviewed tree's uncommitted work is exactly what the person reviewed and decided
    // on (the diff route showed it); refusing would only force a ceremony commit in a
    // tree that is about to be taken. An unreviewed tree above is still guarded.
    const dirty = await isDirty(tree);
    if (dirty && record.appliedAt === null && record.discardedAt === null) {
      throw new ChatError(409, "uncommitted", `Task ${taskId}'s worktree has uncommitted changes. Commit or resolve them first; nothing was removed`);
    }
    const head = (await git(["symbolic-ref", "-q", "HEAD"], { cwd: tree, ...READ, okExit: [1] }).catch(() => "")).trim();
    if (head !== `refs/heads/${record.branch}`) throw new ChatError(409, "moved", `The worktree's HEAD is no longer ${record.branch}; merge or delete it by hand`);
    // A reviewed tree may hold uncommitted work (exactly what the person reviewed); git's
    // plain remove refuses a dirty one, so a settled record removes with --force behind
    // the review guard above. A clean tree removes the plain way, as a race's cleanup does.
    const removed = await git(["worktree", "remove", "--", tree], { cwd: project.root, ...READ }).then(() => true).catch(() =>
      git(["worktree", "remove", "--force", "--", tree], { cwd: project.root, ...READ }).then(() => true).catch(() => false),
    );
    if (!removed) throw new ChatError(409, "worktree_refused", "Git refused to remove the worktree; resolve its locks or nested checkouts first");
    await project.trees.forget(project.ws as never, record.worktreeId).catch(() => undefined);
    // `-d` refuses a branch with commits the lead lacks; that refusal keeps committed work.
    const branchRemoved = await git(["branch", "-d", "--", record.branch], { cwd: project.root, ...READ }).then(() => true).catch(() => false);
    return { removed, branchRemoved, reason: branchRemoved ? null : "branch_kept" };
  }

  /**
   * The inverse of a review: put the decision back, so a mis-taken one can be taken again.
   * The decision and its timestamp are cleared; the worktree and the record stay. Only an
   * applied review is final — the work has already moved into the lead checkout. A discard
   * left the worktree untouched, so it is exactly the useful case: the person can decide
   * again, apply this time.
   */
  async unreview(taskId: string): Promise<IntegrationRecord> {
    await this.ready();
    const record = this.required(taskId);
    if (record.appliedAt !== null) throw new ChatError(409, "already_settled", `Task ${taskId}'s work was already applied into the lead checkout; it cannot be unreviewed`);
    record.review = null;
    record.discardedAt = null;
    await this.write();
    return record;
  }

  /** One file of the worker's worktree, against its fork point, bounded like a race member's diff. */
  async diff(taskId: string, file: string, project: ReviewProject): Promise<{ path: string; diff: string }> {
    await this.ready();
    const record = this.required(taskId);
    const wanted = cleanRelative(file);
    if (!(await existsDir(project.root))) throw new ChatError(410, "workspace_gone", "The lead workspace is gone");
    const tree = await this.treePath(record, project);
    if (tree === null || !(await existsDir(tree))) throw new ChatError(410, "worktree_gone", "This worker's worktree is gone");
    return this.diffFile({ ...record, workspacePath: tree }, wanted, project);
  }

  /** The worktree's folder this record owns, from this service's own records: never a path the client sends. */
  private async treePath(record: IntegrationRecord, project: ReviewProject): Promise<string | null> {
    const listed = await project.trees.list(project.ws as never).catch(() => [] as Array<{ id: string; path: string }>);
    const tree = listed.find((t) => t.id === record.worktreeId);
    if (!tree) return null;
    if (!isWithin(project.root, tree.path)) return null;
    return tree.path;
  }

  /** Take the project's write lock, or refuse: two applies in one checkout would interleave. */
  private lock(root: string): void {
    if (this.busy.has(root)) throw new ChatError(409, "busy", "This project is already applying a review; try again in a moment");
    this.busy.add(root);
  }
}

/** The sentence a stale review record answers with: what moved, and what to do instead. */
function staleMessage(record: IntegrationRecord, reason: string | null, leadHead: string | null): string {
  if (reason === "lead_moved") {
    return `The lead checkout has moved past the recorded head (${record.leadHead.slice(0, 8)} → ${leadHead?.slice(0, 8) ?? "?"}), so the work cannot be applied from here. Its worktree and branch \`${record.branch}\` are kept; merge or cherry-pick by hand, then discard the record.`;
  }
  if (reason === "worker_changed") {
    return `The worker's branch \`${record.branch}\` has moved past the recorded fork point, so the recorded review no longer describes its work. The worktree is kept; re-review the branch's current state by hand.`;
  }
  if (reason === "workspace_gone") return "The lead workspace is gone, so the work cannot be applied from here; its worktree is kept.";
  return "The recorded heads no longer match, so the work cannot be applied from here; its worktree is kept.";
}

async function existsDir(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}
