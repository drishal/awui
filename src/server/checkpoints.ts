// File checkpoints: before each prompt, the work tree of the git repository
// holding the project is written as a tree into a shadow repository in the
// state folder (its own index, the project's objects borrowed through
// alternates). The project's own .git is only read: no refs, no index, no
// objects are written there. Restoring a turn puts the files back as they were
// before its prompt, whoever changed them since (the agent's edits or its
// commands), after a preview naming each file.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { CheckpointChange, CheckpointCompareFile, CheckpointComparison, CheckpointFile, CheckpointPoint } from "../shared/protocol.js";
import { git } from "./git.js";
import { parseUnified } from "./harness/tool-diff.js";
import { isObj, readJson, writeJson } from "./state-file.js";

/** Past this, the prompt goes without a checkpoint; the snapshot still finishes and warms the next one. */
const SNAPSHOT_WAIT_MS = 10_000;
const MAX_TURNS_KEPT = 200;
const TREE = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
/** A comparison lists at most this many files with their lines; the rest are counted. */
const COMPARE_FILES = 60;

export interface Snapshot {
  /** The repository's top level: the work tree that was captured. */
  repo: string;
  tree: string;
}

export class Checkpoints {
  private queues = new Map<string, Promise<unknown>>();
  private ready = new Map<string, Promise<string>>();

  constructor(private readonly dir: string) {}

  /** Snapshots run one at a time per repository: they share the shadow index. */
  private serial<T>(key: string, task: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(key) ?? Promise.resolve()).then(task, task);
    this.queues.set(
      key,
      next.catch(() => undefined),
    );
    return next;
  }

  /** The shadow repository for a work tree, made on first use. */
  private shadow(repo: string): Promise<string> {
    let ready = this.ready.get(repo);
    if (!ready) {
      ready = (async () => {
        const dir = path.join(this.dir, `${createHash("sha256").update(repo).digest("hex").slice(0, 16)}.git`);
        try {
          await fs.access(path.join(dir, "HEAD"));
        } catch {
          await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
          await git(["init", "--quiet", "--bare", dir]);
          await fs.writeFile(path.join(dir, "awui-worktree"), `${repo}\n`);
        }
        const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: repo })).trim();
        await fs.mkdir(path.join(dir, "objects", "info"), { recursive: true });
        await fs.writeFile(path.join(dir, "objects", "info", "alternates"), `${path.join(common, "objects")}\n`);
        // The project's own ignore rules beyond .gitignore.
        const exclude = await fs.readFile(path.join(common, "info", "exclude"), "utf8").catch(() => "");
        await fs.mkdir(path.join(dir, "info"), { recursive: true });
        await fs.writeFile(path.join(dir, "info", "exclude"), exclude);
        return dir;
      })();
      this.ready.set(repo, ready);
      ready.catch(() => this.ready.delete(repo));
    }
    return ready;
  }

  /** The repository holding `cwd`, or null outside one. */
  async repoOf(cwd: string): Promise<string | null> {
    try {
      const top = (await git(["rev-parse", "--show-toplevel"], { cwd })).trim();
      return top ? await fs.realpath(top) : null;
    } catch {
      return null;
    }
  }

  private run(repo: string, shadow: string, args: string[], input?: string): Promise<string> {
    return git([`--git-dir=${shadow}`, `--work-tree=${repo}`, ...args], { cwd: repo, ...(input !== undefined ? { input } : {}) });
  }

  async snapshot(repo: string): Promise<Snapshot> {
    const shadow = await this.shadow(repo);
    return this.serial(repo, async () => {
      await this.run(repo, shadow, ["add", "--all", "--ignore-errors", "--", "."]).catch((error: unknown) => {
        // Unreadable files are left out (--ignore-errors); the rest is staged.
        if (!/error: |warning: /.test(String(error))) throw error;
      });
      const tree = (await this.run(repo, shadow, ["write-tree"])).trim();
      return { repo, tree };
    });
  }

  /** `snapshot`, unless it takes too long: then null, and the prompt goes on without it. */
  async snapshotSoon(repo: string): Promise<Snapshot | null> {
    const snap = this.snapshot(repo).catch(() => null);
    return Promise.race([snap, new Promise<null>((r) => setTimeout(() => r(null), SNAPSHOT_WAIT_MS).unref())]);
  }

  /** What restoring `then` over the files as they are now would do, file by file. */
  async preview(repo: string, then: string): Promise<{ now: string; files: CheckpointFile[] }> {
    if (!TREE.test(then)) throw new Error("Not a checkpoint");
    const { tree: now } = await this.snapshot(repo);
    const shadow = await this.shadow(repo);
    const out = await this.run(repo, shadow, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", then, now]);
    const parts = out.split("\0").filter(Boolean);
    const files: CheckpointFile[] = [];
    const change: Record<string, CheckpointChange> = { M: "restore", T: "restore", A: "delete", D: "recreate" };
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const kind = change[(parts[i] as string)[0] as string];
      if (kind) files.push({ path: parts[i + 1] as string, change: kind });
    }
    return { now, files };
  }

  /** Every file that differs between two trees, each with its lines (bounded), in path order. */
  async compare(repo: string, from: string, to: string): Promise<CheckpointComparison> {
    if (!TREE.test(from) || !TREE.test(to)) throw new Error("Not a checkpoint");
    const shadow = await this.shadow(repo);
    const out = await this.run(repo, shadow, ["diff-tree", "-r", "-z", "--no-renames", "--name-status", from, to]);
    const parts = out.split("\0").filter(Boolean);
    const kinds: Record<string, CheckpointCompareFile["change"]> = { A: "added", D: "deleted", M: "modified", T: "modified" };
    const listed: Array<{ path: string; change: CheckpointCompareFile["change"] }> = [];
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const change = kinds[(parts[i] as string)[0] as string];
      if (change) listed.push({ path: parts[i + 1] as string, change });
    }
    const files: CheckpointCompareFile[] = [];
    for (const f of listed.slice(0, COMPARE_FILES)) {
      // Literal: a file named like pathspec magic is that file.
      const patch = await this.run(repo, shadow, ["--literal-pathspecs", "diff-tree", "-p", "--no-color", "--no-ext-diff", from, to, "--", f.path]).catch(() => "");
      const diff = parseUnified(patch);
      files.push(diff ? { ...f, diff } : { ...f, diff: null, note: /^Binary files /m.test(patch) ? "Binary file" : "No line changes (its mode only)" });
    }
    return { files, more: Math.max(0, listed.length - COMPARE_FILES) };
  }

  /**
   * Put `paths` back as they were in `then`; files that did not exist then are
   * deleted. Returns the tree from just before, so the restore can be undone.
   */
  async restore(repo: string, then: string, paths: string[]): Promise<{ undo: string; files: CheckpointFile[] }> {
    const { now, files } = await this.preview(repo, then);
    const wanted = new Set(paths);
    const chosen = files.filter((f) => wanted.has(f.path));
    const shadow = await this.shadow(repo);
    await this.serial(repo, async () => {
      const back = chosen.filter((f) => f.change !== "delete").map((f) => f.path);
      // Literal: a file named like pathspec magic (":(glob)*") is that file, not a pattern.
      if (back.length > 0) await this.run(repo, shadow, ["--literal-pathspecs", "checkout", then, "--pathspec-from-file=-", "--pathspec-file-nul"], `${back.join("\0")}\0`);
      for (const f of chosen.filter((x) => x.change === "delete")) {
        const file = path.resolve(repo, f.path);
        if (!file.startsWith(`${repo}${path.sep}`)) continue;
        await fs.rm(file, { force: true });
      }
    });
    return { undo: now, files: chosen };
  }
}

interface TurnCheckpoint {
  tree: string;
  /** The prompt's start, to check the turn is still the same one when the session comes back. */
  text: string;
  at: number;
}

interface Pending extends Snapshot {
  text: string;
  at: number;
}

const promptKey = (text: string) => text.trim().slice(0, 80);

/** What a chat needs: its harness and session, its user turns, and where to say which turns have a checkpoint. */
export interface CheckpointHost {
  readonly harnessId: string;
  readonly nativeId: string | null;
  readonly workspace: { path: string };
  /** The text of each stored user turn, in order (what fork's `through` counts). */
  userTurns(): string[];
  setCheckpointTurns(turns: number[]): void;
}

/**
 * One chat's checkpoints: a snapshot before each prompt, tied to the user turn
 * the harness then echoes (matched by its text), kept per session in the state
 * folder so a resumed session still has them.
 */
export class ChatCheckpoints {
  private pending: Pending[] = [];
  private turns = new Map<number, TurnCheckpoint>();
  private repo: string | null = null;
  /** The newest list write; flush() awaits it so a resumed session reads what this one saw. */
  private lastPersist: Promise<void> = Promise.resolve();
  /** Trees this chat may restore: its checkpoints, and the "put back" points of its restores. */
  private known = new Set<string>();

  constructor(
    private readonly service: Checkpoints,
    private readonly host: CheckpointHost,
    private readonly sessionsDir: string | null,
  ) {}

  private file(): string | null {
    if (!this.sessionsDir || !this.host.nativeId) return null;
    const safe = (s: string) => s.replace(/[^\w.-]/g, "_");
    return path.join(this.sessionsDir, safe(this.host.harnessId), `${safe(this.host.nativeId)}.json`);
  }

  private loading: Promise<void> | null = null;

  /** Find the repository and read the session's stored checkpoints; prompts wait for it. */
  start(): Promise<void> {
    this.loading ??= this.load().catch(() => undefined);
    return this.loading;
  }

  /** Keep the stored checkpoints whose turn still starts the same. */
  private async load(): Promise<void> {
    this.repo = await this.service.repoOf(this.host.workspace.path);
    const raw = await readJson(this.file());
    if (!isObj(raw) || raw.repo !== this.repo || !isObj(raw.turns)) return;
    const texts = this.host.userTurns();
    for (const [n, cp] of Object.entries(raw.turns)) {
      const ordinal = Number(n);
      if (!isObj(cp) || typeof cp.tree !== "string" || !TREE.test(cp.tree) || typeof cp.text !== "string") continue;
      if (promptKey(texts[ordinal - 1] ?? "") !== cp.text) continue;
      this.turns.set(ordinal, { tree: cp.tree, text: cp.text, at: typeof cp.at === "number" ? cp.at : 0 });
      this.known.add(cp.tree);
    }
    this.publish();
  }

  /** Before a prompt goes to the harness. */
  async beforePrompt(text: string): Promise<void> {
    await this.start();
    if (!this.repo) return;
    const snap = await this.service.snapshotSoon(this.repo);
    if (snap) this.pending.push({ ...snap, text: promptKey(text), at: Date.now() });
    // A prompt the harness never echoes must not hold its place for ever.
    this.pending = this.pending.filter((p) => Date.now() - p.at < 10 * 60_000).slice(-8);
  }

  /** The harness echoed a user turn: the checkpoint taken for that prompt belongs to it. */
  onUserTurn(text: string, command: boolean): void {
    const key = promptKey(text);
    const i = this.pending.findIndex((p) => p.text === key || key.startsWith(p.text) || p.text.startsWith(key));
    if (i < 0) return;
    const [p] = this.pending.splice(i, 1);
    if (!p || command) return;
    const ordinal = this.host.userTurns().length;
    this.turns.set(ordinal, { tree: p.tree, text: key, at: p.at });
    this.known.add(p.tree);
    for (const n of [...this.turns.keys()].sort((a, b) => a - b).slice(0, -MAX_TURNS_KEPT)) this.turns.delete(n);
    this.publish();
    this.persistSoon();
  }

  /** Turns from `turn` on were replaced (a rewind): their checkpoints no longer belong to them. */
  forgetFrom(turn: number): void {
    for (const n of [...this.turns.keys()]) if (n >= turn) this.turns.delete(n);
    this.publish();
    this.persistSoon();
  }

  /** The session got its id: what was taken before it can now be kept. */
  sessionAssigned(): void {
    this.persistSoon();
  }

  private publish(): void {
    this.host.setCheckpointTurns([...this.turns.keys()].sort((a, b) => a - b));
  }

  /** Save without waiting; a failed write is logged, never an unhandled rejection (Node exits on one). */
  private persistSoon(): void {
    this.lastPersist = this.persist().catch((error: unknown) => console.error(`awui: could not save checkpoints: ${error instanceof Error ? error.message : String(error)}`));
  }

  /** Await the newest list write: a dispose must not let a resume read a stale file. */
  async flush(): Promise<void> {
    await this.lastPersist;
  }

  private persist(): Promise<void> {
    if (!this.repo || this.turns.size === 0) return Promise.resolve();
    return writeJson(this.file(), { repo: this.repo, turns: Object.fromEntries(this.turns) });
  }

  private target(turn: number): { repo: string; tree: string } {
    const cp = this.turns.get(turn);
    if (!this.repo || !cp) throw new Error("This turn has no checkpoint");
    return { repo: this.repo, tree: cp.tree };
  }

  async preview(turn: number): Promise<{ now: string; files: CheckpointFile[] }> {
    const { repo, tree } = this.target(turn);
    return this.service.preview(repo, tree);
  }

  async restore(turn: number | null, paths: string[], tree?: string): Promise<{ undo: string; files: CheckpointFile[] }> {
    const target = turn !== null ? this.target(turn) : tree && this.repo && this.known.has(tree) ? { repo: this.repo, tree } : null;
    if (!target) throw new Error("Not a checkpoint of this chat");
    const result = await this.service.restore(target.repo, target.tree, paths);
    this.known.add(result.undo);
    return result;
  }

  /** The timeline's points: each prompt's checkpoint, oldest first. */
  points(): CheckpointPoint[] {
    return [...this.turns.entries()].sort((a, b) => a[0] - b[0]).map(([turn, cp]) => ({ turn, at: cp.at, prompt: cp.text }));
  }

  /** What changed between two points of the timeline: prompts' checkpoints, or "now" (the files as they are). */
  async compare(from: number | "now", to: number | "now"): Promise<CheckpointComparison> {
    if (!this.repo) throw new Error("This chat keeps no file checkpoints");
    const tree = async (p: number | "now") => (p === "now" ? (await this.service.snapshot(this.repo as string)).tree : this.target(p).tree);
    return this.service.compare(this.repo, await tree(from), await tree(to));
  }

  /** The files a "put back" would touch. */
  async previewTree(tree: string): Promise<{ now: string; files: CheckpointFile[] }> {
    if (!this.repo || !this.known.has(tree)) throw new Error("Not a checkpoint of this chat");
    return this.service.preview(this.repo, tree);
  }
}
