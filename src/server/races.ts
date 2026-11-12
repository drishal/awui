// Races: one prompt sent to several isolated worktree chats, the record of that
// comparison, and what git can safely say and do about each member afterwards.
// The record is a group (a chat, its worktree, its branch, its fork point); the
// chats stay the chat manager's, the trees and branches stay the project's own
// git. Nothing here commits, pushes, or moves a branch, and a removal is only
// ever the plain `git worktree remove` plus `git branch -d` git itself agrees to.
// Records live in the state folder so a comparison outlives its open chats.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { ChatItem, ChatStatus, RaceCleanupResult, RaceFile, RaceFileDiff, RaceMemberStatus, RaceMemberView, RaceSummary, RaceWinnerResult, WorkspaceInfo } from "../shared/protocol.js";
import type { Chat } from "./chats/chat.js";
import { ChatError, errorMessage } from "./chats/chat.js";
import { git, gitBuffer } from "./git.js";
import { parseUnified } from "./harness/tool-diff.js";
import { isObj, readJson, writeJsonChecked } from "./state-file.js";
import { isWithin } from "./workspaces.js";
import type { WorktreeService } from "./worktrees.js";

/** Races kept in the state file. The oldest that has nothing running is the one dropped. */
export const MAX_RACES = 50;
/** A record's members; a comparison starts two to four, so this only bounds a hand-edited file. */
export const MAX_RACE_MEMBERS = 8;
/** Stored prompt text: far more than the panel shows, far less than a message may be. */
const MAX_PROMPT_CHARS = 2_000;
/** The last answer's opening words in a view: how the panel tells members apart at a glance. */
const ANSWER_CHARS = 300;
/** Files a member's view lists: past this the counts still add up, the list just stops. */
const MAX_RACE_FILES = 200;
/** A patch this route may write into a project; a larger one is merged by hand instead. */
const MAX_PATCH_BYTES = 2 * 1024 * 1024;
/** A member's git counts, reused for a moment so a panel's refresh does not re-run git per row. */
const CACHE_TTL_MS = 5_000;
const READ = { timeoutMs: 20_000 };
/**
 * A patch is read back by `git apply`, so the diff that makes it must not follow the
 * user's own config: `diff.noprefix` would write a new file `src/g` as `src/g` where the
 * patch needs `a/src/g`, and apply would then create `./g`; `diff.relative` would move
 * every path; a textconv driver would rewrite a file's bytes. Pinned here, once, for
 * both the bytes we generate and the diff the panel shows.
 */
const DIFF_OPTIONS = ["--no-color", "--no-ext-diff", "--no-textconv", "--no-relative", "--src-prefix=a/", "--dst-prefix=b/"];
/** The same options, plus whole files: `--binary` carries what a text patch cannot. */
const PATCH_OPTIONS = ["--binary", ...DIFF_OPTIONS];
/** A chat in one of these states is working: cleanup leaves its worktree alone. */
const BUSY: readonly ChatStatus[] = ["starting", "running", "stopping", "compacting"];

/** One member of a race, as the record keeps it: where its work and its fork point are. */
export interface RaceRecordMember {
  chatId: string;
  /** The project's own managed-worktree id, so its metadata goes when the tree does. */
  worktreeId: string;
  /** The worktree's folder name, for the panel's row. */
  worktree: string;
  /** Absolute path inside the project; re-validated on every use. */
  path: string;
  branch: string;
  harnessId: string;
  model?: string;
  startedAt: number;
  /** The commit this member's branch was forked from; empty when the base could not be resolved. */
  fork: string;
}

/** One comparison group, as the state folder keeps it. */
export interface RaceRecord {
  id: string;
  workspaceId: string;
  /** The project as it was when the race started. */
  workspacePath: string;
  workspaceName: string;
  prompt: string;
  base: string;
  createdAt: number;
  members: RaceRecordMember[];
  winner?: { chatId: string; mode: "keep" | "apply"; at: number };
  cleanedAt?: number;
}

/** What the store needs from the chats: their live state, their last answer, and closing them. */
export interface RaceChats {
  /** The live status of a member's chat, or null when no chat is open for it. */
  status(chatId: string): ChatStatus | null;
  /** The opening words of its last answer, or null when it has none (or is closed). */
  answer(chatId: string): string | null;
  /** Close a chat through the chat manager (never by touching a session file). */
  close(chatId: string, reason: string): Promise<void>;
}

/** A race's view of the chat manager. */
export function raceChatsFor(manager: { peek(chatId: string): Chat | undefined }): RaceChats {
  return {
    status: (chatId) => manager.peek(chatId)?.status ?? null,
    answer: (chatId) => {
      const items = manager.peek(chatId)?.snapshot().items;
      if (!items) return null;
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i] as ChatItem | undefined;
        if (item?.kind === "assistant" && item.text.trim()) return item.text.trim().slice(0, ANSWER_CHARS);
      }
      return null;
    },
    close: async (chatId, reason) => {
      await manager.peek(chatId)?.dispose(reason);
    },
  };
}

export interface RaceStart {
  workspaceId: string;
  workspacePath: string;
  workspaceName: string;
  prompt: string;
  base: string;
  members: RaceRecordMember[];
}

/** Where a race's git work runs: the project's root, its workspace record, and its managed trees. */
export interface RaceProject {
  root: string;
  ws: WorkspaceInfo;
  trees: WorktreeService;
}

const isHex = (value: unknown): value is string => typeof value === "string" && (/^[0-9a-f]{4,64}$/.test(value) || value === "");

/** A member from the state file, or null when it is not one (a hand-edited file loses only that row). */
function cleanMember(raw: unknown, root: string): RaceRecordMember | null {
  if (!isObj(raw)) return null;
  const { chatId, worktreeId, worktree, path: tree, branch, harnessId, model, startedAt, fork } = raw;
  if (typeof chatId !== "string" || !chatId || typeof worktreeId !== "string") return null;
  if (typeof worktree !== "string" || !worktree || typeof branch !== "string" || !branch) return null;
  if (typeof harnessId !== "string" || !harnessId) return null;
  if (typeof model !== "string" && model !== undefined) return null;
  if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
  if (!isHex(fork)) return null;
  // A tree outside its own project is not this record's to remove or read.
  if (typeof tree !== "string" || !isWithin(root, tree)) return null;
  return { chatId, worktreeId, worktree, path: tree, branch, harnessId, startedAt, fork, ...(typeof model === "string" ? { model } : {}) };
}

function cleanRecord(raw: unknown): RaceRecord | null {
  if (!isObj(raw)) return null;
  const { id, workspaceId, workspacePath, workspaceName, prompt, base, createdAt, winner, cleanedAt } = raw;
  if (typeof id !== "string" || !id || typeof workspaceId !== "string" || !workspaceId) return null;
  if (typeof workspacePath !== "string" || !path.isAbsolute(workspacePath)) return null;
  if (typeof workspaceName !== "string" || typeof prompt !== "string" || typeof base !== "string") return null;
  if (typeof createdAt !== "number" || !Number.isFinite(createdAt)) return null;
  if (!Array.isArray(raw.members)) return null;
  const members: RaceRecordMember[] = [];
  for (const value of raw.members.slice(0, MAX_RACE_MEMBERS)) {
    const member = cleanMember(value, workspacePath);
    if (member) members.push(member);
  }
  if (members.length === 0) return null;
  const record: RaceRecord = { id, workspaceId, workspacePath, workspaceName, prompt: prompt.slice(0, MAX_PROMPT_CHARS), base, createdAt, members };
  if (isObj(winner) && typeof winner.chatId === "string" && members.some((m) => m.chatId === winner.chatId)) {
    const mode = winner.mode === "apply" ? "apply" : "keep";
    record.winner = { chatId: winner.chatId, mode, at: typeof winner.at === "number" ? winner.at : createdAt };
  }
  if (typeof cleanedAt === "number" && Number.isFinite(cleanedAt)) record.cleanedAt = cleanedAt;
  return record;
}

/** A relative path a caller named: no absolute paths, no `..`, nothing a shell would read specially. */
function cleanRelative(raw: string): string {
  if (!raw || raw.length > 4096 || raw.includes("\0") || raw.includes("\\")) throw new ChatError(400, "bad_path", "Name a file inside the worktree");
  if (raw.startsWith("/") || raw.split("/").some((part) => part === "" || part === "." || part === "..")) throw new ChatError(400, "bad_path", "Paths are relative to the worktree, with no `..`");
  return raw;
}

/** A member's path, resolved so a symlink cannot carry a read or a diff outside its worktree. */
async function confine(tree: string, file: string): Promise<void> {
  const full = path.join(tree, file);
  if (!isWithin(tree, full)) throw new ChatError(400, "bad_path", "Paths stay inside the worktree");
  const realTree = await fs.realpath(tree).catch(() => tree);
  let real: string;
  try {
    real = await fs.realpath(full);
  } catch {
    // A file the agent deleted has a diff but no path to resolve: its folder must still be inside.
    real = await fs.realpath(path.dirname(full)).catch(() => path.dirname(full));
  }
  if (!isWithin(realTree, real)) throw new ChatError(400, "bad_path", "Paths stay inside the worktree");
}

/** A member's whole tree, resolved: the project a route just revalidated must still hold it. */
async function confineTree(root: string, tree: string): Promise<void> {
  if (!isWithin(root, tree)) throw new ChatError(400, "bad_path", "That member's worktree is outside this project");
  const realRoot = await fs.realpath(root).catch(() => root);
  const realTree = await fs.realpath(tree).catch(() => tree);
  if (!isWithin(realRoot, realTree)) throw new ChatError(400, "bad_path", "That member's worktree is outside this project");
}

async function existsDir(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Uncommitted work in a tree, `.awui` aside: what cleanup refuses to delete. A `git
 * status` that fails says nothing about the tree, so it counts as dirty: unknown is
 * not safe.
 */
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

/** A member's tracked files against its fork point: names and counts only, never a diff. */
async function numstat(tree: string, fork: string): Promise<{ added: number; removed: number; files: RaceFile[] }> {
  if (!fork) return { added: 0, removed: 0, files: [] };
  const out = await git(["diff", "--numstat", "--no-color", "--no-ext-diff", "--no-textconv", fork], { cwd: tree, ...READ });
  const files: RaceFile[] = [];
  let added = 0;
  let removed = 0;
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [left, right, ...rest] = line.split("\t");
    const file = rest.join("\t");
    if (!file || left === undefined || right === undefined) continue;
    const binary = left === "-" || right === "-";
    const plus = binary ? 0 : Number(left);
    const minus = binary ? 0 : Number(right);
    added += Number.isFinite(plus) ? plus : 0;
    removed += Number.isFinite(minus) ? minus : 0;
    if (files.length < MAX_RACE_FILES) files.push({ path: file, added: Number.isFinite(plus) ? plus : 0, removed: Number.isFinite(minus) ? minus : 0, binary });
  }
  return { added, removed, files };
}

/** Commits `branch` has that `ref` does not, or null when git cannot say (a branch already gone). */
async function unmergedCount(root: string, branch: string, ref: string): Promise<number | null> {
  try {
    const out = await git(["rev-list", "--count", branch, `^${ref}`], { cwd: root, ...READ });
    const count = Number(out.trim());
    return Number.isInteger(count) ? count : null;
  } catch {
    return null;
  }
}

/**
 * What a loser's own tree would lose: the commits its HEAD has that `ref` does not. Counted
 * in the tree, from HEAD, rather than by the branch the record names, because the removal
 * takes the tree as it stands now. Null when git cannot say, which is never "nothing to lose".
 */
async function unmergedInTree(tree: string, ref: string): Promise<number | null> {
  try {
    const out = await git(["rev-list", "--count", "HEAD", `^${ref}`], { cwd: tree, ...READ });
    const count = Number(out.trim());
    return Number.isInteger(count) ? count : null;
  } catch {
    return null;
  }
}

/** The branch a cleanup compares a loser against: the winner's, else the project's current one. */
async function referenceBranch(race: RaceRecord, root: string): Promise<string> {
  const winner = race.winner ? race.members.find((m) => m.chatId === race.winner?.chatId) : undefined;
  if (winner) return winner.branch;
  const branch = (await git(["symbolic-ref", "-q", "--short", "HEAD"], { cwd: root, ...READ, okExit: [1] })).trim();
  return branch || "HEAD";
}

/** A member's git figures, reused for a moment: a panel's refresh must not run git once per row per keystroke. */
interface Figure {
  at: number;
  value: Promise<{ added: number; removed: number; files: RaceFile[] }>;
}
const figures = new Map<string, Figure>();

function figuresFor(member: RaceRecordMember): Promise<{ added: number; removed: number; files: RaceFile[] }> {
  const key = `${member.chatId}:${member.fork}`;
  const now = Date.now();
  const hit = figures.get(key);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.value;
  const value = numstat(member.path, member.fork).catch(() => ({ added: 0, removed: 0, files: [] }));
  figures.set(key, { at: now, value });
  if (figures.size > 200) for (const [other, entry] of figures) if (now - entry.at >= CACHE_TTL_MS) figures.delete(other);
  return value;
}

function forgetFigures(race: RaceRecord): void {
  for (const member of race.members) figures.delete(`${member.chatId}:${member.fork}`);
}

export class Races {
  /** Newest first, as the panel lists them. */
  private readonly records: RaceRecord[] = [];
  /**
   * Project roots with an apply or a cleanup running, so two of them can never interleave in
   * one checkout. Keyed by project, not by race: two races in the same project write the same
   * working tree.
   */
  private readonly busy = new Set<string>();

  private constructor(
    private readonly file: string | null,
    private readonly chats: RaceChats,
  ) {}

  static inMemory(chats: RaceChats): Races {
    return new Races(null, chats);
  }

  static async open(stateDir: string, chats: RaceChats): Promise<Races> {
    const store = new Races(path.join(stateDir, "races.json"), chats);
    const raw = await readJson(store.file);
    if (!Array.isArray(raw)) return store;
    for (const value of raw.slice(0, MAX_RACES * 2)) {
      const record = cleanRecord(value);
      if (record) store.records.push(record);
    }
    store.records.sort((a, b) => b.createdAt - a.createdAt);
    store.records.length = Math.min(store.records.length, MAX_RACES);
    return store;
  }

  list(): RaceRecord[] {
    return [...this.records];
  }

  get(id: string): RaceRecord | undefined {
    return this.records.find((race) => race.id === id);
  }

  /** Record a comparison that has started; the oldest settled race makes room for it when full. */
  async create(input: RaceStart): Promise<RaceRecord> {
    const record: RaceRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId,
      workspacePath: input.workspacePath,
      workspaceName: input.workspaceName,
      prompt: input.prompt.slice(0, MAX_PROMPT_CHARS),
      base: input.base,
      createdAt: Date.now(),
      members: input.members.slice(0, MAX_RACE_MEMBERS),
    };
    this.records.unshift(record);
    this.trim();
    await this.write();
    return record;
  }

  /** Mark a winner and write it down; the apply itself is `pickWinner`'s. */
  async setWinner(id: string, chatId: string, mode: "keep" | "apply"): Promise<RaceRecord> {
    const race = this.required(id);
    if (!race.members.some((member) => member.chatId === chatId)) throw new ChatError(404, "no_member", "That chat is not in this comparison");
    race.winner = { chatId, mode, at: Date.now() };
    await this.write();
    return race;
  }

  /** Forget members a cleanup removed, and note that it ran. */
  async dropMembers(id: string, chatIds: string[]): Promise<RaceRecord> {
    const race = this.required(id);
    race.members = race.members.filter((member) => !chatIds.includes(member.chatId));
    race.cleanedAt = Date.now();
    if (race.winner && !race.members.some((member) => member.chatId === race.winner?.chatId)) delete race.winner;
    await this.write();
    return race;
  }

  /**
   * A race as the panel draws it. `project` adds what costs git: line counts, files,
   * uncommitted work, unmerged commits. Without it (the list) the answer is the
   * record plus each member's live status, so a list of fifty stays one cheap call.
   */
  async view(race: RaceRecord, project?: RaceProject): Promise<RaceSummary> {
    const reference = project ? await referenceBranch(race, project.root) : null;
    const members: RaceMemberView[] = [];
    for (const member of race.members) {
      const view: RaceMemberView = {
        chatId: member.chatId,
        harnessId: member.harnessId,
        model: member.model ?? null,
        branch: member.branch,
        worktree: member.worktree,
        startedAt: member.startedAt,
        status: this.statusOf(member.chatId),
        winner: race.winner?.chatId === member.chatId,
      };
      const answer = this.chats.answer(member.chatId);
      if (answer) view.answer = answer;
      if (project && reference) {
        const { added, removed, files } = await figuresFor(member);
        view.added = added;
        view.removed = removed;
        view.files = files;
        view.dirty = await isDirty(member.path);
        view.unmerged = race.winner?.chatId === member.chatId ? 0 : (await unmergedCount(project.root, member.branch, reference)) ?? undefined;
      }
      members.push(view);
    }
    return {
      id: race.id,
      workspaceId: race.workspaceId,
      workspaceName: race.workspaceName,
      prompt: race.prompt,
      base: race.base,
      createdAt: race.createdAt,
      winnerChatId: race.winner?.chatId ?? null,
      cleanedAt: race.cleanedAt ?? null,
      members,
    };
  }

  /**
   * One file of a member's worktree, against its fork point, bounded like a tool's diff.
   * The project is the one the route just revalidated, so a tree that is no longer inside
   * it (or is now a symlink out of it) is refused before any read.
   */
  async diff(race: RaceRecord, chatId: string, file: string, project: RaceProject): Promise<RaceFileDiff> {
    const member = race.members.find((m) => m.chatId === chatId);
    if (!member) throw new ChatError(404, "no_member", "That chat is not in this comparison");
    const wanted = cleanRelative(file);
    if (!member.fork) throw new ChatError(409, "no_fork_point", "This member's fork point was not recorded");
    await confineTree(project.root, member.path);
    if (!(await existsDir(member.path))) throw new ChatError(410, "worktree_gone", "This member's worktree is gone");
    await confine(member.path, wanted);
    const text = await git(["--literal-pathspecs", "diff", "-U3", ...DIFF_OPTIONS, member.fork, "--", wanted], { cwd: member.path, ...READ, okExit: [1] }).catch((error: unknown) => {
      throw new ChatError(422, "git_failed", errorMessage(error));
    });
    return { path: wanted, diff: parseUnified(text) };
  }

  /**
   * Pick a winner. `keep` only records it. `apply` also puts its changes against the
   * fork point into the project's working tree, unstaged, and only when that checkout
   * is clean and still at the fork point; nothing is committed, pushed, or moved.
   */
  async pickWinner(race: RaceRecord, chatId: string, mode: "keep" | "apply", project: RaceProject): Promise<RaceWinnerResult> {
    const member = race.members.find((m) => m.chatId === chatId);
    if (!member) throw new ChatError(404, "no_member", "That chat is not in this comparison");
    let applied = false;
    if (mode === "apply") {
      if (!member.fork) throw new ChatError(409, "no_fork_point", "This member's fork point was not recorded, so its changes cannot be applied");
      this.lock(project.root);
      try {
        const status = await git(["status", "--porcelain", "--untracked-files=normal"], { cwd: project.root, ...READ });
        if (status.trim()) throw new ChatError(409, "dirty_checkout", "This project has uncommitted changes. Commit or stash them, then pick apply again; nothing was changed");
        const head = (await git(["rev-parse", "--verify", "--end-of-options", "HEAD"], { cwd: project.root, ...READ })).trim();
        if (head !== member.fork) throw new ChatError(409, "head_moved", `The project's HEAD has moved past the fork point, so nothing was applied. Merge its branch \`${member.branch}\` by hand instead`);
        // Bytes, not text (see `gitBuffer`): `git apply` writes these very bytes back.
        const patch = await gitBuffer(["diff", ...PATCH_OPTIONS, member.fork], { cwd: member.path, ...READ }).catch((error: unknown) => {
          throw new ChatError(422, "git_failed", errorMessage(error));
        });
        if (patch.length === 0) throw new ChatError(409, "nothing_to_apply", "This member changed nothing against its fork point");
        if (patch.length > MAX_PATCH_BYTES) throw new ChatError(413, "patch_too_large", "This change is too large to apply from here; merge its branch by hand instead");
        // A clean checkout at the fork point cannot conflict, so a plain apply is enough,
        // and only a plain apply leaves the result unstaged (`--3way` writes the index).
        await git(["apply", "--check", "-"], { cwd: project.root, ...READ, input: patch }).catch((error: unknown) => {
          throw new ChatError(409, "apply_failed", `The patch does not apply: ${errorMessage(error)}`);
        });
        await git(["apply", "-"], { cwd: project.root, ...READ, input: patch }).catch((error: unknown) => {
          throw new ChatError(409, "apply_failed", `The patch could not be written: ${errorMessage(error)}`);
        });
        applied = true;
      } finally {
        this.busy.delete(project.root);
      }
    }
    const updated = await this.setWinner(race.id, chatId, mode);
    forgetFigures(updated);
    const instructions = applied
      ? `Its changes are in this project's working tree, unstaged. Review them with git diff, then commit what you want; its branch \`${member.branch}\` stays as it was.`
      : `Keep \`${member.branch}\` as the winner: merge it by hand, or pick apply to copy its changes into a clean checkout.`;
    return { race: await this.view(updated, project), mode, applied, instructions };
  }

  /**
   * Remove the losers' worktrees one at a time, and say what happened to each. A member
   * still running, one with uncommitted work, one whose HEAD is no longer on the branch
   * the record names, or one whose tree has a commit the winner (or the project) does not
   * has its tree kept; a branch git refuses to delete is kept too, unless this request
   * listed that member in `discard`.
   */
  async cleanup(race: RaceRecord, discard: string[], project: RaceProject): Promise<RaceCleanupResult> {
    this.lock(project.root);
    try {
      const reference = await referenceBranch(race, project.root);
      const results: RaceCleanupResult["results"] = [];
      const gone: string[] = [];
      for (const member of race.members) {
        if (race.winner?.chatId === member.chatId) continue;
        const status = this.statusOf(member.chatId);
        if (status === "running") {
          results.push({ chatId: member.chatId, removed: false, branchRemoved: false, reason: "running" });
          continue;
        }
        if (!isWithin(project.root, member.path)) {
          results.push({ chatId: member.chatId, removed: false, branchRemoved: false, reason: "outside_project" });
          continue;
        }
        if (!(await existsDir(member.path))) {
          gone.push(member.chatId);
          results.push({ chatId: member.chatId, removed: true, branchRemoved: false, reason: "worktree_gone" });
          await this.chats.close(member.chatId, "Its worktree was already gone, so its race chat was closed");
          await project.trees.forget(project.ws, member.worktreeId).catch(() => undefined);
          continue;
        }
        if (await isDirty(member.path)) {
          results.push({ chatId: member.chatId, removed: false, branchRemoved: false, reason: "uncommitted" });
          continue;
        }
        // `worktree remove` would take whatever is checked out there, so the branch the record
        // names must be the one in the tree: a detached HEAD, or another branch, may hold
        // commits that vanish with the folder and that no branch name here names.
        const head = (await git(["symbolic-ref", "-q", "HEAD"], { cwd: member.path, ...READ, okExit: [1] }).catch(() => "")).trim();
        if (head !== `refs/heads/${member.branch}`) {
          results.push({ chatId: member.chatId, removed: false, branchRemoved: false, reason: "moved" });
          continue;
        }
        const discarded = discard.includes(member.chatId);
        // Unknown is not zero: a count git cannot give keeps the tree, as an unmerged one does.
        const unmerged = await unmergedInTree(member.path, reference);
        if (!discarded && (unmerged === null || unmerged > 0)) {
          results.push({ chatId: member.chatId, removed: false, branchRemoved: false, reason: "unmerged" });
          continue;
        }
        // Plain `worktree remove`: git refuses a tree this record thought clean (a nested
        // checkout, a lock), and that refusal keeps the work rather than forcing it away.
        const removed = await git(["worktree", "remove", "--", member.path], { cwd: project.root, ...READ }).then(() => true).catch(() => false);
        if (!removed) {
          results.push({ chatId: member.chatId, removed: false, branchRemoved: false, reason: "worktree_refused" });
          continue;
        }
        // `-d` refuses a branch with commits the reference lacks; `-D` only when the user ticked discard.
        const branchRemoved = await git(["branch", discarded ? "-D" : "-d", "--", member.branch], { cwd: project.root, ...READ }).then(() => true).catch(() => false);
        gone.push(member.chatId);
        results.push({ chatId: member.chatId, removed: true, branchRemoved, reason: branchRemoved ? null : "branch_kept" });
        await this.chats.close(member.chatId, "Its race worktree was removed");
        await project.trees.forget(project.ws, member.worktreeId).catch(() => undefined);
      }
      const updated = gone.length > 0 ? await this.dropMembers(race.id, gone) : race;
      forgetFigures(updated);
      return { race: await this.view(updated, project), results };
    } finally {
      this.busy.delete(project.root);
    }
  }

  /** Take the project's write lock, or refuse: two applies (or an apply and a cleanup) in one checkout would interleave. */
  private lock(root: string): void {
    if (this.busy.has(root)) throw new ChatError(409, "busy", "This project is already applying or cleaning up a comparison; try again in a moment");
    this.busy.add(root);
  }

  /** Which of the three a member's chat is in: working, settled, failed, or gone. */
  private statusOf(chatId: string): RaceMemberStatus {
    const status = this.chats.status(chatId);
    if (status === null) return "closed";
    if (BUSY.includes(status)) return "running";
    if (status === "error") return "failed";
    return "settled";
  }

  private required(id: string): RaceRecord {
    const race = this.get(id);
    if (!race) throw new ChatError(404, "no_race", "No such comparison");
    return race;
  }

  /** Drop the oldest races that have nothing running; a race in progress is never pruned. */
  private trim(): void {
    if (this.records.length <= MAX_RACES) return;
    for (let i = this.records.length - 1; i >= 0 && this.records.length > MAX_RACES; i -= 1) {
      const race = this.records[i];
      if (!race) continue;
      if (race.members.every((member) => !BUSY.includes(this.chats.status(member.chatId) ?? "idle"))) this.records.splice(i, 1);
    }
  }

  private write(): Promise<void> {
    return writeJsonChecked(this.file, this.records);
  }
}
