// Mesh handoff, worker side (P3 §2): the target's half of moving a chat's
// work onto this machine. A handoff arrives as a git bundle in bounded
// chunks — begin accepts the size and sha256 the upload must end up holding,
// chunk writes them strictly in order, finish verifies the digest, runs
// `git bundle verify`, fetches the bundle into refs/awui/handoff/<id> of the
// repo the caller named, and checks out a detached worktree at
// <repo>/.awui/handoff-<id> — the one place a peer's work may land, never
// the caller's own tree. Bringing work back is the mirror: export bundles a
// worktree's HEAD, read pages it out. Every cap is decided here per call
// against the inbound policy (task.run and fs.write for an inbound handoff,
// fs.read for the way back), temp files live under this node's state dir with
// 0600 modes, at most two uploads per node id run at once, and an upload that
// never finishes is reaped after fifteen minutes. Every git call goes through
// handoff.ts's meshGit: argv only, hooks pinned off, network protocols
// refused, no prompts.
import { promises as fs } from "node:fs";
import path from "node:path";
import { decide, resolveInRoots, type PeerPolicy } from "./policy.js";
import { meshGit, newHandoffId, sha256Bytes } from "./handoff.js";
import { MeshErrorCode, MeshRpcError } from "./rpc.js";

/** One handoff's biggest bundle, both directions: the spec's 256 MiB. */
export const HANDOFF_MAX_BUNDLE_BYTES = 256 * 1024 * 1024;
/** One chunk's raw size: base64 inside one JSON-RPC line still fits the wire's 1 MiB bound. */
export const HANDOFF_CHUNK_BYTES = 512 * 1024;
/** An upload that never finished is reaped after this long (spec: 15 minutes). */
export const HANDOFF_REAP_MS = 15 * 60_000;
/** How many uploads one node id may hold open at once (spec: 2). */
export const HANDOFF_UPLOADS_PER_NODE = 2;

const denied = (message: string): MeshRpcError => new MeshRpcError(MeshErrorCode.denied, message, { code: "denied" });
const invalidParams = (message: string): MeshRpcError => new MeshRpcError(MeshErrorCode.invalid_params, message, { code: "invalid_params" });
const limit = (message: string): MeshRpcError => new MeshRpcError(MeshErrorCode.limit, message, { code: "limit" });
const notFound = (message: string): MeshRpcError => new MeshRpcError(MeshErrorCode.not_found, message, { code: "not_found" });

export interface HandoffWorkerOpts {
  /** This node's state folder: temp bundle parts land under <stateDir>/mesh/handoff (0700). */
  stateDir: string;
  home: string;
  /** Epoch milliseconds; injected so the reap is testable without waiting. */
  clock?: () => number;
  /** Test seam: a smaller bundle cap (the leader side injects its own too). */
  maxBundleBytes?: number;
  /** Test seam: how many uploads one node may hold open. */
  maxUploadsPerNode?: number;
  /** Test seam: how long an unfinished upload waits before the reap. */
  reapMs?: number;
  log?: (message: string) => void;
}

interface Upload {
  id: string;
  nodeId: string;
  /** The repo the caller named, resolved through the policy's roots and confirmed a git work tree. */
  repo: string;
  size: number;
  sha256: string;
  file: string;
  /** Chunks must land strictly in order: this is the index the next one must carry. */
  nextIndex: number;
  written: number;
  startedAt: number;
}

interface Exported {
  id: string;
  nodeId: string;
  file: string;
  size: number;
  sha256: string;
  head: string;
  nextIndex: number;
  createdAt: number;
}

/** handoff.begin, as serve.ts has already parsed and cap-gated it. */
export interface HandoffBeginParams {
  repoCwd: string;
  size: number;
  sha256: string;
}

export interface HandoffChunkParams {
  uploadId: string;
  index: number;
  data: string;
}

export interface HandoffReadParams {
  exportId: string;
  index: number;
}

/**
 * The worker's handoff state: the uploads being received and the exports
 * being paged out, both bounded and both keyed by the node id the link
 * authenticated. One instance is meant to be shared by every link a service
 * serves (daemon.ts), so a dropped link does not strand an upload a later
 * link from the same node cannot finish; an ephemeral serve keeps its own,
 * which dies with the link, exactly as its tasks do.
 */
export class HandoffWorker {
  private readonly uploads = new Map<string, Upload>();
  private readonly exports = new Map<string, Exported>();
  private readonly now: () => number;
  private readonly dir: string;

  constructor(private readonly opts: HandoffWorkerOpts) {
    this.now = opts.clock ?? (() => Date.now());
    this.dir = path.join(opts.stateDir, "mesh", "handoff");
  }

  private get maxBundleBytes(): number {
    return this.opts.maxBundleBytes ?? HANDOFF_MAX_BUNDLE_BYTES;
  }

  /** Drops every upload and export past its lifetime, then returns the clock it ran on. */
  private reap(): void {
    const now = this.now();
    const ttl = this.opts.reapMs ?? HANDOFF_REAP_MS;
    for (const [id, upload] of this.uploads) {
      if (now - upload.startedAt > ttl) {
        this.uploads.delete(id);
        void fs.rm(upload.file, { force: true }).catch(() => undefined);
        this.opts.log?.(`mesh handoff: reaped the unfinished upload ${id}`);
      }
    }
    for (const [id, exported] of this.exports) {
      if (now - exported.createdAt > ttl) {
        this.exports.delete(id);
        void fs.rm(exported.file, { force: true }).catch(() => undefined);
      }
    }
  }

  /** How many uploads one node holds open, for the begin cap. */
  private openUploads(nodeId: string): number {
    let count = 0;
    for (const upload of this.uploads.values()) if (upload.nodeId === nodeId) count++;
    return count;
  }

  /**
   * The per-call re-check a mid-upload method makes: a policy edit is read
   * fresh by serve() before every call, so a cap that has become a plain
   * denial ends the upload right here. An "ask" does not raise a card per
   * chunk — the begin that accepted the upload already waited on one, and a
   * card per chunk would hand the target's owner hundreds of them — but the
   * accept must have come from this same policy family: the cap may only
   * have stayed askable or been widened, never silently kept while the
   * config now denies it.
   */
  private stillAllowed(policy: PeerPolicy, cap: "fs.write" | "fs.read", method: string): void {
    const decision = decide(policy, cap);
    if (decision.kind === "deny") {
      throw denied(`the policy refuses "${method}": ${decision.reason}`);
    }
  }

  /**
   * The repo a caller named, resolved through the policy's roots and
   * confirmed a real git work tree: the worktree a handoff lands in is
   * created inside it, so a repo outside the roots was never theirs to
   * offer. The toplevel git reports is the repo the ref and worktree use,
   * because a caller may name a subdirectory of it.
   */
  private async resolveRepo(policy: PeerPolicy, requested: string): Promise<string> {
    const resolved = await resolveInRoots(policy, requested, this.opts.home);
    if (!resolved.ok) throw denied(`the requested repo is refused: ${resolved.reason}`);
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(resolved.real);
    } catch {
      // Refused just below: a repo that does not exist is not a repo.
    }
    if (stat === null || !stat.isDirectory()) throw denied("the requested repo is not an existing directory");
    const top = (await meshGit(["rev-parse", "--show-toplevel"], { cwd: resolved.real }).catch(() => "")).trim();
    if (top === "") throw denied("the requested repo is not a git work tree");
    // The toplevel must itself sit in a root: naming a subdir of a repo whose
    // toplevel sits outside would place the worktree outside the roots.
    const topResolved = await resolveInRoots(policy, top, this.opts.home);
    if (!topResolved.ok) throw denied(`the requested repo's toplevel is refused: ${topResolved.reason}`);
    return top;
  }

  /** handoff.begin {repoCwd, size, sha256} → {uploadId}: accepts an upload under the caps. */
  async begin(policy: PeerPolicy, nodeId: string, params: HandoffBeginParams): Promise<{ uploadId: string }> {
    this.reap();
    if (params.size < 1 || params.size > this.maxBundleBytes) {
      throw limit(`a handoff bundle is bounded to ${this.maxBundleBytes} bytes; this one claims ${params.size}`);
    }
    if (!/^[0-9a-f]{64}$/.test(params.sha256)) throw invalidParams("sha256 must be 64 lowercase hex characters");
    const repo = await this.resolveRepo(policy, params.repoCwd);
    const open = this.openUploads(nodeId);
    if (open >= (this.opts.maxUploadsPerNode ?? HANDOFF_UPLOADS_PER_NODE)) {
      throw limit(`this peer already holds ${open} open handoff upload(s) and the cap is ${this.opts.maxUploadsPerNode ?? HANDOFF_UPLOADS_PER_NODE}`);
    }
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const id = newHandoffId();
    const file = path.join(this.dir, `${id}.part`);
    // 0600 from birth: the part file is peer data in this node's state folder, never world-readable.
    const handle = await fs.open(file, "wx", 0o600);
    await handle.close();
    this.uploads.set(id, { id, nodeId, repo, size: params.size, sha256: params.sha256, file, nextIndex: 0, written: 0, startedAt: this.now() });
    return { uploadId: id };
  }

  /** handoff.chunk {uploadId, index, data}: one strictly ordered slice of the bundle. */
  async chunk(policy: PeerPolicy, nodeId: string, params: HandoffChunkParams): Promise<{}> {
    const upload = this.uploads.get(params.uploadId);
    if (upload === undefined || upload.nodeId !== nodeId) throw notFound("no such upload is open on this link");
    this.stillAllowed(policy, "fs.write", "handoff.chunk");
    if (params.index !== upload.nextIndex) {
      throw invalidParams(`handoff chunks must arrive in order: upload ${upload.id} expects index ${upload.nextIndex}, not ${params.index}`);
    }
    const data = Buffer.from(params.data, "base64");
    if (data.length > HANDOFF_CHUNK_BYTES) {
      throw limit(`one handoff chunk is bounded to ${HANDOFF_CHUNK_BYTES} bytes`);
    }
    if (upload.written + data.length > upload.size) {
      // More bytes than begin promised: refuse now rather than at finish, so a
      // lying size cannot park an unbounded file in the state dir.
      await this.drop(upload);
      throw invalidParams(`the upload claims ${upload.size} bytes but chunk ${params.index} would pass it`);
    }
    const handle = await fs.open(upload.file, "r+");
    try {
      // The position is spelled out, never the handle's own: chunks land in
      // order at the offset the upload has already reached.
      await handle.write(data, 0, data.length, upload.written);
      await handle.sync();
    } finally {
      await handle.close();
    }
    upload.written += data.length;
    upload.nextIndex += 1;
    return {};
  }

  /**
   * handoff.finish {uploadId} → {worktree}: the whole upload in one answer —
   * size and digest verified, the bundle checked, the ref fetched, and the
   * worktree created detached inside the repo's own .awui directory. The
   * part file is gone either way: a failed finish never leaves one behind.
   */
  async finish(policy: PeerPolicy, nodeId: string, uploadId: string): Promise<{ worktree: string }> {
    const upload = this.uploads.get(uploadId);
    if (upload === undefined || upload.nodeId !== nodeId) throw notFound("no such upload is open on this link");
    this.stillAllowed(policy, "fs.write", "handoff.finish");
    if (upload.written !== upload.size) {
      await this.drop(upload);
      throw invalidParams(`size mismatch: the upload claims ${upload.size} bytes and received ${upload.written}`);
    }
    const digest = sha256Bytes(await fs.readFile(upload.file));
    if (digest !== upload.sha256) {
      await this.drop(upload);
      throw denied("sha256 mismatch: the received bundle does not match the digest the upload began with");
    }
    try {
      const heads = await meshGit(["bundle", "list-heads", upload.file], { cwd: upload.repo });
      // Exactly one handoff ref besides HEAD, spelled the way this flow spells
      // refs: a bundle that carries anything else is not a handoff.
      const ref = parseBundleRef(heads);
      await meshGit(["fetch", upload.file, `${ref}:${ref}`], { cwd: upload.repo, timeoutMs: 300_000 });
      const id = ref.replace(/^refs\/awui\/handoff\//, "");
      const worktree = path.join(upload.repo, ".awui", `handoff-${id}`);
      await fs.mkdir(path.dirname(worktree), { recursive: true, mode: 0o700 }).catch(() => undefined);
      if (await fs.stat(worktree).then(() => true, () => false)) {
        throw denied(`the worktree ${worktree} already exists on this machine`);
      }
      // --detach on purpose: a handoff is a place to work, never a branch the
      // repo's own HEAD could end up on.
      await meshGit(["worktree", "add", worktree, ref, "--detach"], { cwd: upload.repo, timeoutMs: 120_000 });
      this.uploads.delete(upload.id);
      await fs.rm(upload.file, { force: true }).catch(() => undefined);
      return { worktree };
    } catch (error) {
      // A failed finish reaps its own part file: the reap timer would get it
      // eventually, but a peer that saw the error should not hold the slot.
      await this.drop(upload);
      throw error instanceof MeshRpcError ? error : denied(`the handoff could not land on this machine: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** handoff.abort {uploadId}: the leader's cleanup when its own upload failed. */
  async abort(nodeId: string, uploadId: string): Promise<{}> {
    const upload = this.uploads.get(uploadId);
    if (upload === undefined || upload.nodeId !== nodeId) throw notFound("no such upload is open on this link");
    await this.drop(upload);
    return {};
  }

  /**
   * handoff.export {worktree} → {exportId, size, sha256, head}: bundles the
   * worktree's HEAD for the way home. The worktree is resolved through the
   * policy's roots like every peer-named path and must be a git work tree;
   * the bundle it produces is bounded by the same cap as the way in.
   */
  async export(policy: PeerPolicy, nodeId: string, worktree: string): Promise<{ exportId: string; size: number; sha256: string; head: string }> {
    this.reap();
    this.stillAllowed(policy, "fs.read", "handoff.export");
    const resolved = await resolveInRoots(policy, worktree, this.opts.home);
    if (!resolved.ok) throw denied(`the requested worktree is refused: ${resolved.reason}`);
    let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
    try {
      stat = await fs.stat(resolved.real);
    } catch {
      // Refused just below.
    }
    if (stat === null || !stat.isDirectory()) throw denied("the requested worktree is not an existing directory");
    const top = (await meshGit(["rev-parse", "--show-toplevel"], { cwd: resolved.real }).catch(() => "")).trim();
    if (top === "") throw denied("the requested worktree is not a git work tree");
    const head = (await meshGit(["rev-parse", "--verify", "HEAD"], { cwd: resolved.real }).catch(() => "")).trim();
    if (head === "") throw denied("the requested worktree has no commits to export");
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
    const id = newHandoffId();
    const file = path.join(this.dir, `${id}.export`);
    // A full-history bundle of the worktree's HEAD: self-contained, so the
    // leader's `git bundle verify` and fetch need nothing else from this repo.
    await meshGit(["bundle", "create", file, "HEAD"], { cwd: resolved.real, timeoutMs: 300_000 });
    await fs.chmod(file, 0o600);
    const st = await fs.stat(file);
    if (st.size > this.maxBundleBytes) {
      await fs.rm(file, { force: true }).catch(() => undefined);
      throw limit(`the worktree's bundle is ${st.size} bytes, over this node's ${this.maxBundleBytes} handoff cap`);
    }
    const bytes = await fs.readFile(file);
    const record: Exported = { id, nodeId, file, size: st.size, sha256: sha256Bytes(bytes), head, nextIndex: 0, createdAt: this.now() };
    this.exports.set(id, record);
    return { exportId: id, size: record.size, sha256: record.sha256, head };
  }

  /** handoff.read {exportId, index} → {data}: one strictly ordered slice of the export. */
  async read(policy: PeerPolicy, nodeId: string, params: HandoffReadParams): Promise<{ data: string; eof: boolean }> {
    const record = this.exports.get(params.exportId);
    if (record === undefined || record.nodeId !== nodeId) throw notFound("no such export is open on this link");
    this.stillAllowed(policy, "fs.read", "handoff.read");
    if (params.index !== record.nextIndex) {
      throw invalidParams(`export chunks must arrive in order: ${record.id} expects index ${record.nextIndex}, not ${params.index}`);
    }
    const handle = await fs.open(record.file, "r");
    try {
      const want = Math.min(HANDOFF_CHUNK_BYTES, record.size - record.nextIndex * HANDOFF_CHUNK_BYTES);
      const buf = Buffer.alloc(Math.max(0, want));
      const at = record.nextIndex * HANDOFF_CHUNK_BYTES;
      const { bytesRead } = await handle.read(buf, 0, buf.length, at);
      record.nextIndex += 1;
      const eof = at + bytesRead >= record.size;
      if (eof) {
        // The last page was read: the export's file is this call's own to drop,
        // and it is gone before the answer leaves (a reader that looks right
        // after eof sees an empty state dir, not a stale peer bundle).
        this.exports.delete(record.id);
        await fs.rm(record.file, { force: true }).catch(() => undefined);
      }
      return { data: buf.subarray(0, bytesRead).toString("base64"), eof };
    } finally {
      await handle.close();
    }
  }

  /**
   * Removes one upload and its part file before the refusal that caused it
   * reaches the peer: a dropped upload never holds its slot or its disk
   * past the reply. The reap's own removals stay fire-and-forget.
   */
  private async drop(upload: Upload): Promise<void> {
    this.uploads.delete(upload.id);
    await fs.rm(upload.file, { force: true }).catch(() => undefined);
  }
}

/**
 * The one handoff ref a bundle may carry, from `git bundle list-heads`
 * output: a line per `<sha> <ref>`. HEAD is expected and skipped; exactly
 * one refs/awui/handoff/<id> must remain, its id spelling an awui id, or
 * the bundle is not a handoff and never touches the repo.
 */
function parseBundleRef(listHeads: string): string {
  const refs: string[] = [];
  for (const line of listHeads.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const ref = trimmed.split(/\s+/)[1] ?? "";
    if (ref === "HEAD") continue;
    refs.push(ref);
  }
  const [only] = refs;
  if (refs.length !== 1 || only === undefined || !/^refs\/awui\/handoff\/[0-9a-z_-]{1,64}$/.test(only)) {
    throw denied("the bundle does not carry exactly one refs/awui/handoff/<id> ref, so it is not a handoff");
  }
  return only;
}
