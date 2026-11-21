// Mesh handoff, leader side (P3 §2): moving a chat's work to a peer. Three
// pieces live here, all on the machine that chats. First the snapshot — a
// commit of the working tree (tracked and untracked, .gitignore respected)
// onto refs/awui/handoff/<id>, built through a temporary index so the user's
// own index, worktree, and HEAD never move. Second the transport — `git bundle
// create` under a hard size cap, then the chunks over the peer link
// (handoff.begin / chunk / finish). Third the way back — handoff.export /
// handoff.read pull a bundle of the peer worktree's HEAD and `git fetch` it
// into refs/awui/from-peer/<peer>/<id>, never merging or checking out: what
// comes home is a ref a person reads, not a change to their tree. Every git
// call goes through meshGit below — argv only, no hooks, no network protocol,
// no system config, no prompt — because a handoff is driven by a tool call an
// agent made, not by a person at a keyboard.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ChatItem } from "../../shared/protocol.js";
import { MeshRpcError } from "./rpc.js";
import type { PeerManager } from "./manager.js";
import { HANDOFF_CHUNK_BYTES, HANDOFF_MAX_BUNDLE_BYTES } from "./handoff-worker.js";

/** One handoff's biggest bundle, both directions: the spec's 256 MiB. */
export const HANDOFF_BUNDLE_CAP = HANDOFF_MAX_BUNDLE_BYTES;
/** How long the leader waits on one handoff wire call: a finish runs a fetch of up to the whole cap. */
export const HANDOFF_RPC_MS = 10 * 60_000;
/** The transcript digest's bounds (P3 §2): the last turns, never more than 32 KiB. */
export const DIGEST_MAX_TURNS = 20;
export const DIGEST_MAX_BYTES = 32 * 1024;
/** One digest line's text: enough to carry a real instruction, never a transcript. */
const DIGEST_ITEM_CHARS = 4_000;

/**
 * The one git runner every handoff step uses, on either side of the link.
 * argv only (no shell), hooks pinned to /dev/null, every network protocol
 * refused (protocol.allow=never) — the file transport stays open because a
 * bundle is a local file and that is the one transport handoff needs — the
 * system config ignored, and prompts off. The environment's own GIT_* never
 * reach git except the ones a caller names on purpose (the throwaway index).
 */
export function meshGit(args: string[], opts: { cwd?: string; env?: Record<string, string>; input?: string | Buffer; timeoutMs?: number; okExit?: number[] } = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_TERMINAL_PROMPT = "0";
  Object.assign(env, opts.env);
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never", "-c", "protocol.file.allow=always", ...args],
      { cwd: opts.cwd, env, maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 120_000, encoding: "utf8" },
      (error, stdout, stderr) => {
        const code = (error as { code?: unknown } | null)?.code;
        if (!error || (typeof code === "number" && opts.okExit?.includes(code))) resolve(stdout);
        else reject(new Error((stderr || "").trim() || error?.message || "git failed"));
      },
    );
    if (opts.input !== undefined) {
      // git may exit before draining stdin (an early exit, a failed update-index or
      // hash-object); an unread pipe then raises EPIPE on this end, and without a
      // listener Node turns it into an uncaught exception instead of the callback's
      // own error path.
      child.stdin?.on("error", () => {});
      child.stdin?.end(opts.input);
    }
  });
}

/** One fresh handoff id, the same shape on both sides of a link. */
export function newHandoffId(): string {
  return `ho_${randomBytes(8).toString("hex")}`;
}

/** Whether a directory is a git work tree at all, and its toplevel if so. */
export async function gitWorkTreeRoot(cwd: string): Promise<string | null> {
  try {
    const out = await meshGit(["rev-parse", "--show-toplevel"], { cwd });
    const top = out.trim();
    return top === "" ? null : top;
  } catch {
    return null;
  }
}

export interface HandoffSnapshot {
  id: string;
  /** The ref the snapshot commit landed on: refs/awui/handoff/<id>. */
  ref: string;
  commit: string;
  /** The HEAD the snapshot was parented on, sent along in the bundle. */
  head: string;
}

/**
 * Commits the working tree as it stands onto refs/awui/handoff/<id> without
 * touching the user's own index, worktree, or HEAD: the tree is recorded into
 * a throwaway index (GIT_INDEX_FILE, in a 0700 temp dir), `git add -A`
 * respects .gitignore, `git write-tree` turns it into a tree, and
 * `git commit-tree -p HEAD` makes it a real commit parented on the current
 * HEAD — which is why the repo must already have one. Only the new ref is
 * written into the user's repo; nothing else in it moves.
 */
export async function snapshotWorkingTree(cwd: string, opts: { log?: (m: string) => void } = {}): Promise<HandoffSnapshot> {
  const head = (await meshGit(["rev-parse", "--verify", "HEAD"], { cwd }).catch(() => "")).trim();
  if (head === "") throw new Error("this workspace has no commits yet, so its working tree cannot be handed off");
  const id = newHandoffId();
  const scratch = await mkdtemp(path.join(tmpdir(), "awui-handoff-"));
  try {
    const indexEnv = { GIT_INDEX_FILE: path.join(scratch, "index") };
    await meshGit(["add", "--all", "--", "."], { cwd, env: indexEnv });
    const tree = (await meshGit(["write-tree"], { cwd, env: indexEnv })).trim();
    if (tree === "") throw new Error("git write-tree produced no tree");
    const commit = (await meshGit(["commit-tree", tree, "-p", head, "-m", `awui handoff ${id}`], { cwd, input: "" })).trim();
    if (commit === "") throw new Error("git commit-tree produced no commit");
    const ref = `refs/awui/handoff/${id}`;
    await meshGit(["update-ref", ref, commit], { cwd });
    opts.log?.(`mesh handoff: snapshotted ${cwd} as ${ref}`);
    return { id, ref, commit, head };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * `git bundle create` of HEAD plus the snapshot ref, refused with a clear
 * message when the bundle would cross the cap: a peer cannot be handed a
 * history it will never finish uploading. The file lands under `outDir`
 * (0700) with a 0600 mode, named `<id>.bundle`.
 *
 * The cap is enforced after `git bundle create` completes (finding #9, a
 * known residual): git itself has no "stop at N bytes" switch, so a repo
 * with a giant history writes the full bundle into the scratch dir before
 * the size check refuses it. That is a bounded local-disk cost of the
 * leader's own tool call (the same scratch the snapshot uses), never a peer's
 * lever: the bundle never leaves this machine unless it is under the cap.
 */
export async function createHandoffBundle(cwd: string, snap: HandoffSnapshot, outDir: string, opts: { maxBundleBytes?: number } = {}): Promise<{ file: string; size: number; sha256: string }> {
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  const file = path.join(outDir, `${snap.id}.bundle`);
  await meshGit(["bundle", "create", file, "HEAD", snap.ref], { cwd, timeoutMs: 300_000 });
  const st = await fs.stat(file);
  await fs.chmod(file, 0o600);
  const cap = opts.maxBundleBytes ?? HANDOFF_BUNDLE_CAP;
  if (st.size > cap) {
    await fs.rm(file, { force: true }).catch(() => undefined);
    throw new Error(`the handoff bundle is ${Math.round(st.size / (1024 * 1024))} MiB, over the ${Math.round(cap / (1024 * 1024))} MiB cap; commit or prune the repo and hand off again`);
  }
  return { file, size: st.size, sha256: sha256Bytes(await fs.readFile(file)) };
}

/** The hex sha256 of a buffer, the one digest both sides of a handoff check. */
export function sha256Bytes(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}


/**
 * Uploads one bundle over the peer link in bounded chunks: handoff.begin
 * names the repo, size, and sha256 the worker must end up holding;
 * handoff.chunk carries at most HANDOFF_CHUNK_BYTES raw (base64 inside one
 * JSON-RPC line still fits the wire's 1 MiB bound); handoff.finish asks for
 * the verify, the fetch, and the worktree. The worker's answer names the
 * worktree the peer's copy of the work now lives in.
 */
export async function uploadHandoff(manager: PeerManager, peerName: string, repoCwd: string, file: string, opts: { size?: number; sha256?: string } = {}): Promise<{ worktree: string }> {
  const bytes = await fs.readFile(file);
  const begin = await manager.handoffBegin(peerName, { repoCwd, size: opts.size ?? bytes.length, sha256: opts.sha256 ?? sha256Bytes(bytes) });
  try {
    for (let index = 0, at = 0; at < bytes.length; index++, at += HANDOFF_CHUNK_BYTES) {
      await manager.handoffChunk(peerName, begin.uploadId, index, bytes.subarray(at, at + HANDOFF_CHUNK_BYTES));
    }
    return await manager.handoffFinish(peerName, begin.uploadId);
  } catch (error) {
    // A failed upload is the worker's to reap; telling it so is best-effort cleanup, never a second failure.
    if (error instanceof MeshRpcError && error.code !== -34999) void manager.handoffAbort(peerName, begin.uploadId).catch(() => undefined);
    throw error;
  }
}

export interface PeerExport {
  exportId: string;
  size: number;
  sha256: string;
  /** The commit the bundle carries, so the local ref can be named after it. */
  head: string;
}

/**
 * Brings a peer's work home as bytes: handoff.export bundles the worktree's
 * HEAD on the peer, handoff.read pages it back in the same bounded chunks.
 * The digest is checked here too — the link is the same trust boundary it
 * was on the way out.
 */
export async function exportFromPeer(manager: PeerManager, peerName: string, worktree: string, opts: { maxBundleBytes?: number } = {}): Promise<{ bytes: Buffer; meta: PeerExport }> {
  const meta = await manager.handoffExport(peerName, worktree);
  const cap = opts.maxBundleBytes ?? HANDOFF_BUNDLE_CAP;
  // Finding #4: the peer's claimed size is never trusted — a paired peer that
  // lies ("size: 2^40") and then streams forever must not be able to make this
  // side buffer without bound. Refused before the first read, and the loop
  // below stops the moment the accumulated bytes pass the cap anyway.
  if (meta.size > cap) {
    throw new Error(`the peer's export claims ${meta.size} bytes, over the ${cap} byte handoff bundle cap`);
  }
  const parts: Buffer[] = [];
  let got = 0;
  for (let index = 0, at = 0; at < meta.size; index++, at += HANDOFF_CHUNK_BYTES) {
    const part = await manager.handoffRead(peerName, meta.exportId, index);
    if (part.length === 0) throw new Error(`the peer's export ended after ${got} of ${meta.size} bytes`);
    parts.push(part);
    got += part.length;
    if (got > cap) throw new Error(`the peer's export passed the ${cap} byte handoff bundle cap`);
    if (got > meta.size) throw new Error(`the peer's export delivered ${got} of ${meta.size} bytes`);
  }
  const bytes = Buffer.concat(parts);
  if (bytes.length !== meta.size) throw new Error(`the peer's export delivered ${bytes.length} of ${meta.size} bytes`);
  if (sha256Bytes(bytes) !== meta.sha256) throw new Error("the peer's export did not match the digest it promised");
  return { bytes, meta };
}

/**
 * Fetches a downloaded bundle into refs/awui/from-peer/<peer>/<id> of the
 * local repo — and nothing else: no checkout, no merge, no branch. The
 * bundle is verified first (self-contained by construction, so a failure is
 * corruption or truncation, never a missing parent), and the id is the head
 * sha the export carried, so the ref names exactly what came home.
 */
export async function fetchPeerWork(repo: string, peerName: string, bundleFile: string, head: string): Promise<string> {
  await meshGit(["bundle", "verify", bundleFile], { cwd: repo });
  const id = head.replace(/^refs\/heads\//, "").slice(0, 12);
  if (!/^[0-9a-f]{6,12}$/.test(id)) throw new Error("the peer's export carried no readable head");
  const ref = `refs/awui/from-peer/${peerName}/${id}`;
  await meshGit(["fetch", bundleFile, `HEAD:${ref}`], { cwd: repo, timeoutMs: 300_000 });
  return ref;
}

/**
 * The compact transcript digest that rides in a handoff brief: the chat's
 * last DIGEST_MAX_TURNS turns, tool outputs elided to the call's name and
 * one-line summary, newest last, whole turns dropped oldest-first until the
 * total fits DIGEST_MAX_BYTES. A peer's worker sees what the work was, not
 * every byte the tools printed.
 */
export function transcriptDigest(items: ChatItem[], opts: { maxTurns?: number; maxBytes?: number } = {}): string {
  const maxTurns = opts.maxTurns ?? DIGEST_MAX_TURNS;
  const maxBytes = opts.maxBytes ?? DIGEST_MAX_BYTES;
  type Turn = { lines: string[] };
  const turns: Turn[] = [];
  // Assistant and tool lines before any prompt (a resumed chat) still belong to one turn.
  const lastTurn = (): Turn => {
    const latest = turns[turns.length - 1];
    if (latest !== undefined) return latest;
    const fresh: Turn = { lines: [] };
    turns.push(fresh);
    return fresh;
  };
  for (const item of items) {
    if (item.kind === "user" && !item.interjected) {
      turns.push({ lines: [`User: ${cut(item.text)}`] });
    } else if (item.kind === "assistant") {
      const text = cut(item.text);
      if (text !== "") lastTurn().lines.push(`Assistant: ${text}`);
    } else if (item.kind === "tool") {
      // Elided on purpose: the call is the fact, the output is the bulk.
      lastTurn().lines.push(`Tool: ${item.name}${item.summary !== "" ? ` — ${cut(item.summary, 200)}` : ""} (output elided)`);
    }
  }
  let kept = turns.slice(-maxTurns);
  const render = (t: Turn[]): string =>
    `[awui handoff digest — the last ${t.length} turn(s) of the chat that handed this work off; tool outputs elided]\n` +
    t.map((turn) => turn.lines.join("\n")).join("\n\n");
  let text = render(kept);
  while (Buffer.byteLength(text, "utf8") > maxBytes && kept.length > 1) {
    kept = kept.slice(1);
    text = render(kept);
  }
  return Buffer.byteLength(text, "utf8") > maxBytes ? `${text.slice(0, maxBytes - 1)}…` : text;
}

function cut(text: string, cap = DIGEST_ITEM_CHARS): string {
  const trimmed = text.trim();
  return trimmed.length > cap ? `${trimmed.slice(0, cap - 1)}…` : trimmed;
}
