// Mesh handoff (P3 §2), both sides of one link. The leader helpers are
// tested against real git in temp repos — the snapshot must leave the
// user's index, worktree, and HEAD untouched while carrying untracked
// files, the bundle has a hard cap, and the digest bounds itself. The
// worker methods are driven through a real serve() over a memory link, so
// what is under test is exactly what production runs: caps and policy per
// call, chunk ordering, digest and size verification, hooks pinned off,
// the worktree inside the repo's .awui dir, upload reaping on an injected
// clock, and the way home (export → read → fetch into refs/awui/from-peer
// only). The orchestration refusals ride the same makeTestApp route the
// other mesh orchestration tests use.
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { Agent } from "supertest";
import type { ChatItem } from "../../src/shared/protocol.js";
import { git } from "../../src/server/git.js";
import { AuditLog } from "../../src/server/mesh/audit.js";
import {
  createHandoffBundle,
  exportFromPeer,
  fetchPeerWork,
  meshGit,
  sha256Bytes,
  snapshotWorkingTree,
  transcriptDigest,
  uploadHandoff,
  DIGEST_MAX_BYTES,
  type HandoffSnapshot,
} from "../../src/server/mesh/handoff.js";
import { HandoffWorker, HANDOFF_CHUNK_BYTES } from "../../src/server/mesh/handoff-worker.js";
import { clientHandshake } from "../../src/server/mesh/handshake.js";
import { loadOrCreateIdentity, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { PeerManager } from "../../src/server/mesh/manager.js";
import { DEFAULT_MAX_FILE_BYTES } from "../../src/server/mesh/policy.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { serve, type ServeDeps } from "../../src/server/mesh/serve.js";
import { memoryLink } from "../../src/server/mesh/transport.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import { ChatManager } from "../../src/server/chats/manager.js";
import { Workspaces } from "../../src/server/workspaces.js";
import { Orchestrator, type OrchestratorDeps } from "../../src/server/orchestration/orchestrator.js";
import { DEFAULT_ORCHESTRATION_LIMITS } from "../../src/server/orchestration/limits.js";
import { makeTestApp, signedIn, tempDir, type TestApp } from "../helpers/app.js";
import type { MeshConfig } from "../../src/server/user-config.js";
import type { Readable, Writable } from "node:stream";

const HOME = tmpdir();
const fixtures: string[] = [];
afterAll(async () => {
  await Promise.all(fixtures.map((dir) => rm(dir, { recursive: true, force: true })));
});

const remember = async (dir: string): Promise<string> => {
  fixtures.push(dir);
  return dir;
};

/** One git repo with a base commit, as the tests' fixture builder leaves them. */
async function makeRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  await git(["init", "-q", dir]);
  await git(["config", "user.email", "t@awui"], { cwd: dir });
  await git(["config", "user.name", "awui test"], { cwd: dir });
  await writeFile(path.join(dir, "base.txt"), "base\n");
  await git(["add", "-A"], { cwd: dir });
  await git(["commit", "-qm", "base"], { cwd: dir });
  return dir;
}

/** One request that must fail, answered with the MeshRpcError it threw. */
async function refuse<T>(call: () => Promise<T>): Promise<MeshRpcError> {
  return call().then(
    () => {
      throw new Error("expected the call to be refused");
    },
    (error) => {
      expect(error).toBeInstanceOf(MeshRpcError);
      return error as MeshRpcError;
    },
  );
}

describe("handoff snapshot (leader)", () => {
  it("commits tracked and untracked work onto refs/awui/handoff/<id> without touching index, worktree, or HEAD", async () => {
    const repo = await makeRepo(await remember(await mkdtemp(path.join(HOME, "handoff-src-"))));
    await writeFile(path.join(repo, "f.txt"), "edited\n");
    await writeFile(path.join(repo, "untracked.txt"), "new work\n");
    await writeFile(path.join(repo, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(repo, "ignored.txt"), "never carried\n");
    const statusBefore = await git(["status", "--porcelain"], { cwd: repo });
    const headBefore = (await git(["rev-parse", "HEAD"], { cwd: repo })).trim();

    const snap = await snapshotWorkingTree(repo);

    expect(await git(["status", "--porcelain"], { cwd: repo })).toBe(statusBefore);
    expect((await git(["rev-parse", "HEAD"], { cwd: repo })).trim()).toBe(headBefore);
    expect(snap.ref).toMatch(/^refs\/awui\/handoff\/ho_[0-9a-f]{16}$/);
    expect((await git(["rev-parse", "--verify", snap.ref], { cwd: repo })).trim()).toBe(snap.commit);
    // The snapshot's parent is the HEAD the tree stood on, and its tree is the working tree's.
    expect((await git(["rev-parse", `${snap.commit}^`], { cwd: repo })).trim()).toBe(headBefore);
    expect(await git(["show", `${snap.ref}:untracked.txt`], { cwd: repo })).toBe("new work\n");
    expect(await git(["show", `${snap.ref}:f.txt`], { cwd: repo })).toBe("edited\n");
    // .gitignore is respected exactly as git respects it.
    await expect(git(["show", `${snap.ref}:ignored.txt`], { cwd: repo })).rejects.toThrow();
  });

  it("refuses a repo with no commits, with a message that says what to do", async () => {
    const empty = await remember(await mkdtemp(path.join(HOME, "handoff-empty-")));
    await git(["init", "-q", empty]);
    await expect(snapshotWorkingTree(empty)).rejects.toThrow(/no commits/);
  });

  it("rejects cleanly when git exits before draining stdin: no unhandled EPIPE, repeated (finding #15)", async () => {
    const empty = await remember(await mkdtemp(path.join(HOME, "handoff-epipe-")));
    await git(["init", "-q", empty]);
    // 2 MiB can never fit the pipe before `rev-parse --verify HEAD` fails in the
    // empty repo and exits, so the write side hits EPIPE; without the stdin error
    // listener Node raises it as an uncaught exception and the run dies.
    for (let i = 0; i < 5; i++) {
      await expect(meshGit(["rev-parse", "--verify", "HEAD"], { cwd: empty, input: "x".repeat(2 * 1024 * 1024) })).rejects.toThrow(/fatal/i);
    }
  });
});

describe("handoff bundle cap (leader)", () => {
  it("bundles HEAD plus the snapshot ref, and refuses a bundle over the cap without leaving a file", async () => {
    const repo = await makeRepo(await remember(await mkdtemp(path.join(HOME, "handoff-src-"))));
    await writeFile(path.join(repo, "f.txt"), "more\n");
    const snap = await snapshotWorkingTree(repo);
    const outDir = await remember(await mkdtemp(path.join(HOME, "handoff-out-")));
    const made = await createHandoffBundle(repo, snap, outDir);
    expect(made.size).toBeGreaterThan(0);
    expect(made.sha256).toBe(sha256Bytes(await readFile(made.file)));
    expect((await readdir(outDir)).length).toBe(1);
    // The bundle names exactly what the worker's fetch will look for.
    const heads = await git(["bundle", "list-heads", made.file]);
    expect(heads).toContain(snap.ref);
    expect(heads).toContain("HEAD");

    // An injected cap under the bundle's real size: a refusal, and no file left behind.
    const capDir = await remember(await mkdtemp(path.join(HOME, "handoff-cap-")));
    const tooBig = await createHandoffBundle(repo, snap, capDir, { maxBundleBytes: 10 }).then(
      () => {
        throw new Error("expected the over-cap bundle to be refused");
      },
      (error: unknown) => error as Error,
    );
    expect(tooBig.message).toMatch(/over the .* cap/);
    expect((await readdir(capDir)).length).toBe(0);
  });
});

describe("handoff transcript digest (leader)", () => {
  const user = (text: string): ChatItem => ({ kind: "user", id: `u${text}`, at: 0, text });
  const answer = (text: string): ChatItem => ({ kind: "assistant", id: `a${text}`, at: 0, text, thinking: "", streaming: false });
  const tool = (name: string, output: string): ChatItem => ({ kind: "tool", id: `t${name}`, at: 0, name, args: "", status: "done", output, truncated: false, category: "read", summary: "src/app.ts", paths: [] });

  it("keeps the last 20 turns, elides tool outputs, and fits its byte cap", () => {
    const items: ChatItem[] = [];
    for (let i = 1; i <= 30; i++) {
      items.push(user(`prompt number ${i}`), tool(`read_${i}`, `the entire file content ${i} — never carried`), answer(`answer number ${i}`));
    }
    const digest = transcriptDigest(items);
    expect(digest).toContain("prompt number 30");
    expect(digest).toContain("answer number 30");
    expect(digest).toContain("Tool: read_30 — src/app.ts (output elided)");
    expect(digest).not.toContain("prompt number 10");
    expect(digest).not.toContain("the entire file content");
    expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(DIGEST_MAX_BYTES);
    expect(digest).toContain("20 turn(s)");
  });

  it("drops whole oldest turns to fit a smaller cap", () => {
    const items: ChatItem[] = [];
    for (let i = 1; i <= 40; i++) items.push(user(`turn ${i}`), answer(`reply ${i}`));
    const digest = transcriptDigest(items, { maxBytes: 200, maxTurns: 40 });
    expect(digest).not.toContain("turn 1\n");
    expect(digest).toContain("turn 40");
    expect(Buffer.byteLength(digest, "utf8")).toBeLessThanOrEqual(200);
  });
});

// ---- the worker side: a real serve() over a memory link, a real repo ----

interface WorkerFixture {
  root: string;
  stateDir: string;
  serverIdentity: NodeIdentity;
  leaderIdentity: NodeIdentity;
  strangerIdentity: NodeIdentity;
  handoffs: HandoffWorker;
  /** Advances the injected clock, for the reap test. */
  advance: (ms: number) => void;
  /** One fresh served link's client end, not yet handshaken. */
  spawn: () => { input: Readable; output: Writable; kill: () => void };
}

async function makeWorkerFixture(over: Partial<ConstructorParameters<typeof HandoffWorker>[0]> = {}, policy: NonNullable<MeshConfig["policies"]>[string] = { caps: ["discover", "task.run", "task.approve", "fs.read", "fs.write"], ask: [], roots: [] }): Promise<WorkerFixture> {
  const root = await remember(await mkdtemp(path.join(HOME, "handoff-root-")));
  const stateDir = await remember(await mkdtemp(path.join(HOME, "handoff-state-")));
  const serverIdentity = await loadOrCreateIdentity(await remember(await mkdtemp(path.join(HOME, "handoff-sid-"))));
  const leaderIdentity = await loadOrCreateIdentity(await remember(await mkdtemp(path.join(HOME, "handoff-lid-"))));
  const strangerIdentity = await loadOrCreateIdentity(await remember(await mkdtemp(path.join(HOME, "handoff-xid-"))));
  let now = Date.now();
  const clock = (): number => now;
  const handoffs = new HandoffWorker({ stateDir, home: HOME, clock, ...over });
  const pins = PinStore(path.join(stateDir, "mesh", "pins.json"));
  // The ends pair exactly as a real pair does: the target pins the callers
  // inbound under the handoff policy, the leader pins the target outbound.
  // The stranger is paired too, so the upload-keying test is about keys, not pairing.
  await pins.setInbound(leaderIdentity.publicKey, "leader-box", "hander", "accept");
  await pins.setInbound(strangerIdentity.publicKey, "stranger-box", "hander", "accept");
  // The one policy every worker test serves under: both handoff caps allowed, one root.
  const mesh: MeshConfig = { enabled: true, policies: { hander: { ...policy, roots: [root], max_file_bytes: DEFAULT_MAX_FILE_BYTES } } };
  const spawn = () => {
    const pair = memoryLink();
    const deps: ServeDeps = {
      identity: serverIdentity,
      name: "target-box",
      pins,
      audit: new AuditLog(path.join(stateDir, "mesh", "audit.jsonl"), () => undefined),
      registry: { get: () => undefined, available: async () => false },
      config: () => mesh,
      enabled: () => true,
      home: HOME,
      handoffs,
    };
    serve({ input: pair.server.input, output: pair.server.output }, deps);
    return { input: pair.client.input, output: pair.client.output, kill: () => undefined };
  };
  return { root, stateDir, serverIdentity, leaderIdentity, strangerIdentity, handoffs, advance: (ms) => (now += ms), spawn };
}

/** A PeerManager over the fixture's spawn, with the target's key pinned (what `awui peer add` leaves). */
async function managerFor(f: WorkerFixture): Promise<PeerManager> {
  const pins = PinStore(path.join(await remember(await mkdtemp(path.join(HOME, "handoff-pins-"))), "pins.json"));
  const manager = new PeerManager({
    identity: async () => f.leaderIdentity,
    pins,
    config: () => ({ enabled: true, peers: [{ name: "lab", docker: "awui-worker-1" }] }),
    enabled: () => true,
    localName: () => "leader-box",
    spawn: (_name, _link) => f.spawn(),
  });
  const first = await manager.connect("lab", { tofu: true });
  await manager.pin("lab", f.serverIdentity.publicKey);
  first.close();
  return manager;
}

/** One leader repo with dirty work, snapshotted and bundled, ready to upload. */
async function makeBundle(f: WorkerFixture): Promise<{ repo: string; snap: HandoffSnapshot; file: string }> {
  const repo = await makeRepo(await remember(await mkdtemp(path.join(HOME, "handoff-leader-"))));
  await writeFile(path.join(repo, "f.txt"), "dirty work\n");
  await writeFile(path.join(repo, "new.txt"), "brand new\n");
  const snap = await snapshotWorkingTree(repo);
  const outDir = await remember(await mkdtemp(path.join(HOME, "handoff-out-")));
  const made = await createHandoffBundle(repo, snap, outDir);
  return { repo, snap, file: made.file };
}

/** One handshaken client over a fresh link to the fixture's serve(). */
async function openClient(f: WorkerFixture, who: NodeIdentity = f.leaderIdentity, name = "leader-box"): Promise<RpcPeer> {
  const spawn = f.spawn();
  const client = new RpcPeer(spawn.input, spawn.output, { role: "client" });
  client.start();
  await clientHandshake(client, { identity: who, name, hops: 0, expectedServerKey: f.serverIdentity.publicKey, tofu: false });
  return client;
}

/** One request that must fail on a link, answered with the error the worker sent. */
async function refuseOnLink(rpc: RpcPeer, method: string, params: unknown): Promise<MeshRpcError> {
  return rpc.request(method, params).then(
    () => {
      throw new Error(`expected "${method}" to be refused`);
    },
    (error) => {
      expect(error).toBeInstanceOf(MeshRpcError);
      return error as MeshRpcError;
    },
  );
}

describe("handoff over a served link (worker)", () => {
  it("lands a handoff into <repo>/.awui/handoff-<id>, hooks never run, and the repo's own tree is untouched", async () => {
    const f = await makeWorkerFixture();
    const target = await makeRepo(await remember(await mkdtemp(path.join(f.root, "target-"))));
    const statusBefore = await git(["status", "--porcelain"], { cwd: target });
    // A failing post-checkout hook: if any git call here ever ran hooks, the
    // handoff would fail and the marker would name the step that ran it.
    const marker = path.join(f.root, "hook-ran");
    await mkdir(path.join(target, ".git", "hooks"), { recursive: true });
    await writeFile(path.join(target, ".git", "hooks", "post-checkout"), `#!/bin/sh\necho ran > ${JSON.stringify(marker)}\nexit 1\n`);
    await chmod(path.join(target, ".git", "hooks", "post-checkout"), 0o755);
    const manager = await managerFor(f);
    const bundle = await makeBundle(f);

    const landed = await uploadHandoff(manager, "lab", target, bundle.file);

    expect(landed.worktree.startsWith(path.join(target, ".awui"))).toBe(true);
    expect(path.basename(landed.worktree)).toBe(`handoff-${bundle.snap.id}`);
    // The peer's copy holds the dirty and the untracked work, checked out detached.
    expect(await readFile(path.join(landed.worktree, "f.txt"), "utf8")).toBe("dirty work\n");
    expect(await readFile(path.join(landed.worktree, "new.txt"), "utf8")).toBe("brand new\n");
    expect((await git(["rev-parse", "--verify", `refs/awui/handoff/${bundle.snap.id}`], { cwd: target })).trim()).toBe(bundle.snap.commit);
    // The target's own tree never moved, and no hook ran anywhere.
    // The target's own tree never moved: the only new status line is the .awui
    // dir the worktree lives in, which the spec places inside the repo.
    expect(await git(["status", "--porcelain"], { cwd: target })).toBe(`${statusBefore}?? .awui/\n`);
    await expect(readFile(marker)).rejects.toThrow();
    // The part file is gone: only the ref and the worktree remain.
    expect(await readdir(path.join(f.stateDir, "mesh", "handoff"))).toEqual([]);
    // The leader's own ref is the record of what was sent.
    expect((await git(["rev-parse", "--verify", bundle.snap.ref], { cwd: bundle.repo })).trim()).toBe(bundle.snap.commit);
  });

  it("refuses a handoff the policy's caps do not grant, before any chunk is taken", async () => {
    // The read-only floor: no task.run, no fs.write, so nothing about a
    // handoff is allowed, and the refusal is the policy's own words.
    const f = await makeWorkerFixture({}, { caps: ["discover"], ask: [], roots: [] });
    const target = await makeRepo(await remember(await mkdtemp(path.join(f.root, "target-"))));
    const client = await openClient(f);
    const sha = sha256Bytes(Buffer.from("x"));
    const refused = await refuseOnLink(client, "handoff.begin", { repoCwd: target, size: 1, sha256: sha });
    expect(refused.code).toBe(MeshErrorCode.denied);
    expect(refused.message).toMatch(/task\.run|fs\.write/);
    client.close();
  });

  it("refuses a chunk out of order, a repeated chunk, and an unknown upload", async () => {
    const f = await makeWorkerFixture();
    const target = await makeRepo(await remember(await mkdtemp(path.join(f.root, "target-"))));
    const client = await openClient(f);
    const sha = sha256Bytes(Buffer.from("hello handoff"));
    const begun = await client.request<{ uploadId: string }>("handoff.begin", { repoCwd: target, size: 13, sha256: sha });
    const wrong = await refuseOnLink(client, "handoff.chunk", { uploadId: begun.uploadId, index: 1, data: Buffer.from("hello handoff").toString("base64") });
    expect(wrong.code).toBe(MeshErrorCode.invalid_params);
    expect(wrong.message).toMatch(/in order/);
    await client.request("handoff.chunk", { uploadId: begun.uploadId, index: 0, data: Buffer.from("hello handoff").toString("base64") });
    const repeated = await refuseOnLink(client, "handoff.chunk", { uploadId: begun.uploadId, index: 0, data: Buffer.from("hello handoff").toString("base64") });
    expect(repeated.code).toBe(MeshErrorCode.invalid_params);
    const unknown = await refuseOnLink(client, "handoff.chunk", { uploadId: "ho_ffffffffffffffff", index: 0, data: "" });
    expect(unknown.code).toBe(MeshErrorCode.not_found);
    client.close();
  });

  it("refuses a sha mismatch and a size mismatch at finish, and never keeps the part file", async () => {
    const f = await makeWorkerFixture();
    const target = await makeRepo(await remember(await mkdtemp(path.join(f.root, "target-"))));
    const client = await openClient(f);
    const bytes = Buffer.from("hello handoff");
    // The right digest, the wrong size: finish says size mismatch.
    const short = await client.request<{ uploadId: string }>("handoff.begin", { repoCwd: target, size: bytes.length + 1, sha256: sha256Bytes(bytes) });
    await client.request("handoff.chunk", { uploadId: short.uploadId, index: 0, data: bytes.toString("base64") });
    const sizeMiss = await refuseOnLink(client, "handoff.finish", { uploadId: short.uploadId });
    expect(sizeMiss.code).toBe(MeshErrorCode.invalid_params);
    expect(sizeMiss.message).toMatch(/size mismatch/);
    // A chunk that would pass the claimed size is refused mid-upload, and drops the upload.
    const tiny = await client.request<{ uploadId: string }>("handoff.begin", { repoCwd: target, size: 2, sha256: sha256Bytes(bytes) });
    const overflow = await refuseOnLink(client, "handoff.chunk", { uploadId: tiny.uploadId, index: 0, data: bytes.toString("base64") });
    expect(overflow.code).toBe(MeshErrorCode.invalid_params);
    expect(overflow.message).toMatch(/would pass it/);
    const dropped = await refuseOnLink(client, "handoff.finish", { uploadId: tiny.uploadId });
    expect(dropped.code).toBe(MeshErrorCode.not_found);
    // The right size, a lying digest: finish says sha mismatch.
    const bad = await client.request<{ uploadId: string }>("handoff.begin", { repoCwd: target, size: bytes.length, sha256: sha256Bytes(Buffer.from("not these bytes")) });
    await client.request("handoff.chunk", { uploadId: bad.uploadId, index: 0, data: bytes.toString("base64") });
    const shaMiss = await refuseOnLink(client, "handoff.finish", { uploadId: bad.uploadId });
    expect(shaMiss.code).toBe(MeshErrorCode.denied);
    expect(shaMiss.message).toMatch(/sha256 mismatch/);
    expect(await readdir(path.join(f.stateDir, "mesh", "handoff"))).toEqual([]);
    client.close();
  });

  it("caps a node at two open uploads and frees the slot on abort", async () => {
    const f = await makeWorkerFixture();
    const target = await makeRepo(await remember(await mkdtemp(path.join(f.root, "target-"))));
    const client = await openClient(f);
    const sha = sha256Bytes(Buffer.from("x"));
    await client.request<{ uploadId: string }>("handoff.begin", { repoCwd: target, size: 1, sha256: sha });
    await client.request<{ uploadId: string }>("handoff.begin", { repoCwd: target, size: 1, sha256: sha });
    const third = await refuseOnLink(client, "handoff.begin", { repoCwd: target, size: 1, sha256: sha });
    expect(third.code).toBe(MeshErrorCode.limit);
    expect(third.message).toMatch(/2 open handoff upload/);
    client.close();
  });

  it("reaps an unfinished upload after fifteen minutes on the injected clock", async () => {
    const f = await makeWorkerFixture();
    const target = await makeRepo(await remember(await mkdtemp(path.join(f.root, "target-"))));
    const client = await openClient(f);
    const sha = sha256Bytes(Buffer.from("x"));
    const stale = await client.request<{ uploadId: string }>("handoff.begin", { repoCwd: target, size: 1, sha256: sha });
    await client.request("handoff.chunk", { uploadId: stale.uploadId, index: 0, data: Buffer.from("x").toString("base64") });
    f.advance(16 * 60_000);
    // The next begin sweeps: the stale upload and its part file are gone, and
    // the per-node slot it held is free again.
    const fresh = await client.request<{ uploadId: string }>("handoff.begin", { repoCwd: target, size: 1, sha256: sha });
    expect(fresh.uploadId).not.toBe(stale.uploadId);
    const gone = await refuseOnLink(client, "handoff.finish", { uploadId: stale.uploadId });
    expect(gone.code).toBe(MeshErrorCode.not_found);
    expect(await readdir(path.join(f.stateDir, "mesh", "handoff"))).toEqual([`${fresh.uploadId}.part`]);
    client.close();
  });

  it("refuses a repo outside the roots, a non-repo, and one node touching another's upload", async () => {
    const f = await makeWorkerFixture();
    const outsideRepo = await makeRepo(await remember(await mkdtemp(path.join(HOME, "handoff-outside-"))));
    const plainDir = await remember(await mkdtemp(path.join(f.root, "not-a-repo-")));
    const client = await openClient(f);
    const sha = sha256Bytes(Buffer.from("x"));
    const outside = await refuseOnLink(client, "handoff.begin", { repoCwd: outsideRepo, size: 1, sha256: sha });
    expect(outside.code).toBe(MeshErrorCode.denied);
    expect(outside.message).toMatch(/outside the policy's roots/);
    const notRepo = await refuseOnLink(client, "handoff.begin", { repoCwd: plainDir, size: 1, sha256: sha });
    expect(notRepo.code).toBe(MeshErrorCode.denied);
    expect(notRepo.message).toMatch(/not a git work tree/);
    // A second node, also paired: it may begin its own upload but never touch the first's.
    const target = await makeRepo(await remember(await mkdtemp(path.join(f.root, "target-"))));
    const mine = await client.request<{ uploadId: string }>("handoff.begin", { repoCwd: target, size: 1, sha256: sha });
    const other = await openClient(f, f.strangerIdentity, "stranger-box");
    const theirs = await refuseOnLink(other, "handoff.chunk", { uploadId: mine.uploadId, index: 0, data: Buffer.from("x").toString("base64") });
    expect(theirs.code).toBe(MeshErrorCode.not_found);
    other.close();
    client.close();
  });

  it("exports a worktree's HEAD and fetches it home into refs/awui/from-peer only", async () => {
    const f = await makeWorkerFixture();
    const target = await makeRepo(await remember(await mkdtemp(path.join(f.root, "target-"))));
    const manager = await managerFor(f);
    const bundle = await makeBundle(f);
    const landed = await uploadHandoff(manager, "lab", target, bundle.file);

    // The peer's worker commits its work — the thing "fetch back" is for.
    await git(["config", "user.email", "peer@awui"], { cwd: landed.worktree });
    await git(["config", "user.name", "peer"], { cwd: landed.worktree });
    await writeFile(path.join(landed.worktree, "result.txt"), "done on the peer\n");
    await git(["add", "-A"], { cwd: landed.worktree });
    await git(["commit", "-qm", "peer work"], { cwd: landed.worktree });

    const exported = await exportFromPeer(manager, "lab", landed.worktree);
    expect(exported.bytes.length).toBeGreaterThan(0);
    expect(exported.meta.size).toBe(exported.bytes.length);
    // The ref lands in the leader's repo, names the peer, and is never a branch.
    const scratch = await remember(await mkdtemp(path.join(HOME, "handoff-back-")));
    const file = path.join(scratch, "work.bundle");
    await writeFile(file, exported.bytes);
    const headsBefore = await git(["for-each-ref", "refs/heads"], { cwd: bundle.repo });
    const ref = await fetchPeerWork(bundle.repo, "lab", file, exported.meta.head);
    expect(ref).toMatch(/^refs\/awui\/from-peer\/lab\/[0-9a-f]{12}$/);
    expect(await git(["for-each-ref", "refs/heads"], { cwd: bundle.repo })).toBe(headsBefore);
    expect(await git(["show", `${ref}:result.txt`], { cwd: bundle.repo })).toBe("done on the peer\n");
    expect((await git(["log", "-1", "--format=%s", ref], { cwd: bundle.repo })).trim()).toBe("peer work");
    // Nothing was checked out: the leader's own tree still holds its dirty work.
    expect(await readFile(path.join(bundle.repo, "f.txt"), "utf8")).toBe("dirty work\n");
  });

  it("refuses an export outside the roots, a read past the end, and a read out of order", async () => {
    const f = await makeWorkerFixture();
    const target = await makeRepo(await remember(await mkdtemp(path.join(f.root, "target-"))));
    const manager = await managerFor(f);
    const bundle = await makeBundle(f);
    const landed = await uploadHandoff(manager, "lab", target, bundle.file);
    // The leader's own state dir is not a worktree inside the peer's roots.
    const outside = await refuse(() => manager.handoffExport("lab", f.stateDir));
    expect(outside.message).toMatch(/outside the policy's roots|not a git work tree/);
    const meta = await manager.handoffExport("lab", landed.worktree);
    expect(meta.size).toBeGreaterThan(0);
    // Reading every page drops the export at eof: a page past the end is not_found.
    const pages = Math.ceil(meta.size / HANDOFF_CHUNK_BYTES);
    for (let index = 0; index < pages; index++) await manager.handoffRead("lab", meta.exportId, index);
    const past = await refuse(() => manager.handoffRead("lab", meta.exportId, pages));
    expect(past.code).toBe(MeshErrorCode.not_found);
    // A fresh export refuses a read that skips a page.
    const meta2 = await manager.handoffExport("lab", landed.worktree);
    const skipped = await refuse(() => manager.handoffRead("lab", meta2.exportId, 1));
    expect(skipped.code).toBe(MeshErrorCode.invalid_params);
    expect(skipped.message).toMatch(/in order/);
  });

  it("refuses two concurrent chunks of the same index: only one lands, and the upload still finishes (finding #11)", async () => {
    const f = await makeWorkerFixture();
    const target = await makeRepo(await remember(await mkdtemp(path.join(f.root, "target-"))));
    const client = await openClient(f);
    const bytes = Buffer.from("hello handoff");
    const begun = await client.request<{ uploadId: string }>("handoff.begin", { repoCwd: target, size: bytes.length, sha256: sha256Bytes(bytes) });
    const data = bytes.toString("base64");
    const both = await Promise.allSettled([
      client.request("handoff.chunk", { uploadId: begun.uploadId, index: 0, data }),
      client.request("handoff.chunk", { uploadId: begun.uploadId, index: 0, data }),
    ]);
    const rejected = both.filter((outcome) => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    const error = (rejected[0] as PromiseRejectedResult).reason as MeshRpcError;
    expect(error.code).toBe(MeshErrorCode.invalid_params);
    expect(error.message).toMatch(/expects index 1, not 0/);
    // The upload survived in order: the next index is exactly what it now expects.
    await client.request("handoff.chunk", { uploadId: begun.uploadId, index: 1, data: "" });
    await client.request("handoff.abort", { uploadId: begun.uploadId });
    client.close();
  });

  it("runs git bundle verify before the fetch: bytes with a matching size and sha but no bundle inside never touch the repo (finding #8)", async () => {
    const f = await makeWorkerFixture();
    const target = await makeRepo(await remember(await mkdtemp(path.join(f.root, "target-"))));
    const client = await openClient(f);
    const garbage = Buffer.from("definitely not a git bundle, just chosen bytes");
    const begun = await client.request<{ uploadId: string }>("handoff.begin", { repoCwd: target, size: garbage.length, sha256: sha256Bytes(garbage) });
    await client.request("handoff.chunk", { uploadId: begun.uploadId, index: 0, data: garbage.toString("base64") });
    const refused = await refuseOnLink(client, "handoff.finish", { uploadId: begun.uploadId });
    expect(refused.code).toBe(MeshErrorCode.denied);
    expect(refused.message).toMatch(/could not land/);
    // No ref landed, no worktree dir, and the part file is gone.
    expect((await readdir(target)).includes(".awui")).toBe(false);
    expect(await readdir(path.join(f.stateDir, "mesh", "handoff"))).toEqual([]);
    client.close();
  });

  it("reaps an abandoned upload on its own sweep timer, with no later handoff to run it (finding #7)", async () => {
    const f = await makeWorkerFixture({ reapMs: 100, sweepMs: 100, clock: () => Date.now() });
    const target = await makeRepo(await remember(await mkdtemp(path.join(f.root, "target-"))));
    const client = await openClient(f);
    const sha = sha256Bytes(Buffer.from("x"));
    const stale = await client.request<{ uploadId: string }>("handoff.begin", { repoCwd: target, size: 1, sha256: sha });
    // Nothing else touches handoff state on this node; only the sweep can drop it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const gone = await refuseOnLink(client, "handoff.finish", { uploadId: stale.uploadId });
    expect(gone.code).toBe(MeshErrorCode.not_found);
    expect(await readdir(path.join(f.stateDir, "mesh", "handoff"))).toEqual([]);
    client.close();
  });

  it("refuses a lying export size before the first read, and a stream that passes the cap (finding #4)", async () => {
    // A canned manager that answers export and read with whatever the test
    // wants: the leader-side bounds must not need an honest peer to hold.
    const honest = {
      handoffExport: async () => ({ exportId: "x1", size: 2 ** 40, sha256: "0".repeat(64), head: "0123456789ab" }),
      handoffRead: async () => Buffer.alloc(0),
    } as unknown as PeerManager;
    const liar = await exportFromPeer(honest, "lab", "/wt").then(
      () => {
        throw new Error("expected the lying size to be refused");
      },
      (error: unknown) => error as Error,
    );
    expect(liar.message).toMatch(/claims .* bytes, over the .* bundle cap/);

    const oversize = {
      handoffExport: async () => ({ exportId: "x2", size: 100, sha256: "0".repeat(64), head: "0123456789ab" }),
      handoffRead: async () => Buffer.alloc(65 * 1024, 0x61),
    } as unknown as PeerManager;
    const flooded = await exportFromPeer(oversize, "lab", "/wt", { maxBundleBytes: 64 * 1024 }).then(
      () => {
        throw new Error("expected the over-cap stream to be refused");
      },
      (error: unknown) => error as Error,
    );
    expect(flooded.message).toMatch(/passed the .* bundle cap/);
  });

  it("refuses a real export over the cap before any read, leaving the export unpaged (finding #4)", async () => {
    const f = await makeWorkerFixture();
    const target = await makeRepo(await remember(await mkdtemp(path.join(f.root, "target-"))));
    const manager = await managerFor(f);
    const bundle = await makeBundle(f);
    const landed = await uploadHandoff(manager, "lab", target, bundle.file);
    const meta = await manager.handoffExport("lab", landed.worktree);
    const refused = await exportFromPeer(manager, "lab", landed.worktree, { maxBundleBytes: Math.max(1, meta.size - 1) }).then(
      () => {
        throw new Error("expected the over-cap export to be refused");
      },
      (error: unknown) => error as Error,
    );
    expect(refused.message).toMatch(/over the .* bundle cap/);
    // Refused before the first handoff.read: the export's file is still there,
    // dropped only by the worker's own reap, never by an eof read.
    expect((await readdir(path.join(f.stateDir, "mesh", "handoff"))).some((name) => name.endsWith(".export"))).toBe(true);
  });
});

// ---- peer_handoff, the orchestration surface ----

/** The orchestrator's peers dep, as app.ts would wire it from config.yml. */
function peersOf(manager: PeerManager, over: { enabled?: () => boolean; chats?: () => "lead-only" | "all" } = {}): NonNullable<OrchestratorDeps["peers"]> {
  return { manager, enabled: over.enabled ?? (() => true), chats: over.chats ?? (() => "lead-only"), maxRemoteTasks: () => 8 };
}

/** A canned manager that names one configured peer without ever opening a link. */
async function cannedManager(): Promise<PeerManager> {
  const f = await makeWorkerFixture();
  return managerFor(f);
}

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup(peers: NonNullable<OrchestratorDeps["peers"]>): Promise<{ agent: Agent; token: string }> {
  const app = await makeTestApp({ orchestrationPeers: peers });
  t = app;
  const agent = await signedIn(app);
  const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
  const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as { chatId: string };
  const token = app.manager.list().find((c) => c.chatId === chat.chatId)?.orchestration?.token;
  if (!token) throw new Error("the chat was spawned without an orchestration token");
  return { agent, token };
}

function call(agent: Agent, token: string, tool: string, args: unknown) {
  return agent.post("/api/orchestration/call").set("x-awui-orch-token", token).send({ tool, args });
}

describe("peer_handoff (orchestration)", () => {
  it("refuses the tool while the mesh is off", async () => {
    const manager = await cannedManager();
    const off = await setup(peersOf(manager, { enabled: () => false }));
    const res = await call(off.agent, off.token, "peer_handoff", { peer: "lab", peerRepo: "/srv/proj" });
    expect(res.status).toBeGreaterThan(399);
    expect(res.body).toMatchObject({ ok: false, code: "mesh_off" });
  });

  it("refuses a peer the config does not name", async () => {
    const manager = await cannedManager();
    const on = await setup(peersOf(manager));
    const res = await call(on.agent, on.token, "peer_handoff", { peer: "ghost", peerRepo: "/srv/proj" });
    expect(res.status).toBeGreaterThan(399);
    expect(res.body).toMatchObject({ ok: false, code: "unknown_peer" });
  });

  it("refuses a handoff from a chat that is not a lead, and one that arrived over the mesh", async () => {
    const manager = await cannedManager();
    const chats = new ChatManager();
    const registry = new HarnessRegistry();
    registry.register(new FakeAdapter({}));
    await registry.refreshStatus();
    const project = tempDir("awui-handoff-hop-");
    await mkdir(project, { recursive: true });
    const { workspaces } = await Workspaces.create([project], project);
    const orch = new Orchestrator({ chats, registry, workspaces, file: null, decisionsFile: null, limits: () => DEFAULT_ORCHESTRATION_LIMITS, peers: peersOf(manager), log: () => undefined });
    await orch.start();
    const caller = await chats.create(registry.get("fake")!, await workspaces.open(project));
    // A delegated child (depth 1) is not a lead: mesh.chats is lead-only.
    (caller as unknown as { lineage: unknown }).lineage = { kind: "delegate", taskId: "t1", parentChatId: "p", parentTitle: null, depth: 1 };
    await expect(orch.run("peer_handoff", { peer: "lab", peerRepo: "/srv/proj" }, caller)).rejects.toMatchObject({ code: "mesh_lead_only" });
    // A chat that arrived over the mesh can never reach another peer (max_hops 1).
    (caller as unknown as { lineage: unknown }).lineage = undefined;
    (caller as unknown as { owner: unknown }).owner = { kind: "peer", peerId: "node-1", peerName: "leader-box", remoteTaskId: "rt_upstream" };
    await expect(orch.run("peer_handoff", { peer: "lab", peerRepo: "/srv/proj" }, caller)).rejects.toMatchObject({ code: "hop_limit" });
  });

  it("refuses a handoff from a workspace that is not a git repo", async () => {
    const manager = await cannedManager();
    const { agent, token } = await setup(peersOf(manager));
    const res = await call(agent, token, "peer_handoff", { peer: "lab", peerRepo: "/srv/proj", brief: "keep going" });
    expect(res.status).toBeGreaterThan(399);
    expect(res.body).toMatchObject({ ok: false, code: "workspace_unsupported" });
    expect(JSON.stringify(res.body)).toMatch(/no commits/);
  });
});
