// The worker end of remote terminals (P3 §1): one in-process serve link per
// test, exactly as mesh-serve.test.ts builds them, with the target's own
// TerminalManager over an injected fake pty (node-pty cannot be assumed in a
// test run) and a TermHost whose coalescing window, ring, and clock are seams.
// Every rule the spec spells out gets its own test: the closed schema (a
// caller cannot name a shell or an env), the one term.open cap with its
// ephemeral ask refusal, roots and the per-node terminal bound, coalescing
// bounds, attach replay and the other-node not_found, daemon survival with
// reaping on a fake clock, ephemeral close-with-link, and audit lines that
// carry byte counts, never what was typed.
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ChatManager } from "../../src/server/chats/manager.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import type { ProjectPty } from "../../src/server/terminal-backend.js";
import { TerminalManager } from "../../src/server/terminal.js";
import { AuditLog } from "../../src/server/mesh/audit.js";
import { clientHandshake } from "../../src/server/mesh/handshake.js";
import { nodeIdOf, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { ApprovalQueue } from "../../src/server/mesh/approvals.js";
import { TaskHost } from "../../src/server/mesh/host.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import type { RawPolicy } from "../../src/server/mesh/policy.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { serve, type ServeDeps } from "../../src/server/mesh/serve.js";
import { TermHost } from "../../src/server/mesh/terms.js";
import { memoryLink } from "../../src/server/mesh/transport.js";
import type { MeshConfig } from "../../src/server/user-config.js";
import type { IDisposable } from "@lydell/node-pty";

/** A fresh in-memory identity, the shape loadOrCreateIdentity returns. */
function identity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
  return { publicKey: raw, privateKey, nodeId: nodeIdOf(raw) };
}

/** The fake pty the TerminalManager spawns over: it records what it was given and never runs anything. */
class FakePty implements ProjectPty {
  /** A pid nothing on this machine owns, so the manager's kill path falls back to kill() here. */
  readonly pid = 999_999;
  readonly written: string[] = [];
  readonly resized: { cols: number; rows: number }[] = [];
  killed = false;
  exited = false;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: { exitCode: number; signal?: number }) => void>();

  constructor(
    readonly file: string,
    readonly options: { name?: string; cols?: number; rows?: number; cwd?: string; env?: { [key: string]: string | undefined } },
  ) {}

  onData(listener: (data: string) => void): IDisposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    this.written.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resized.push({ cols, rows });
  }

  kill(): void {
    this.killed = true;
  }

  /** The test plays the shell's output. */
  emit(data: string): void {
    for (const listener of [...this.dataListeners]) listener(data);
  }

  /** The test plays the shell's exit. */
  exit(code: number, signal?: number): void {
    if (this.exited) return;
    this.exited = true;
    for (const listener of [...this.exitListeners]) listener({ exitCode: code, ...(signal !== undefined ? { signal } : {}) });
  }
}

/** One worker's world: a temp state folder, a root the policy grants, a fake-pty manager, and the term host. */
interface Fixture {
  stateDir: string;
  root: string;
  outside: string;
  serverIdentity: NodeIdentity;
  /** The one leader identity every link in a test connects as: ownership is by node id, so a second link must be the same node. */
  leader: NodeIdentity;
  pins: PinStore;
  auditFile: string;
  adapter: FakeAdapter;
  manager: TerminalManager;
  host: TaskHost | null;
  /** The daemon's ask-approval queue, wired in only by the test that answers a card. */
  approvals?: ApprovalQueue;
  terms: TermHost;
  ptys: FakePty[];
  mesh: MeshConfig;
  clock: number;
}

const fixtures: string[] = [];
afterAll(async () => {
  await Promise.all(fixtures.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * One worker, with the policy the test wants (the caller shapes caps and
 * max_tasks) and daemon mode when a host is asked for, so the same fixture
 * serves the ephemeral and the daemon story.
 */
async function makeFixture(policy: RawPolicy, over: { daemon?: boolean; terms?: { coalesce?: { maxMs: number; maxBytes: number }; ringMaxBytes?: number; detachedTtlMs?: number } } = {}): Promise<Fixture> {
  const stateDir = await mkdtemp(path.join(tmpdir(), "mesh-terms-state-"));
  const rawRoot = await mkdtemp(path.join(tmpdir(), "mesh-terms-root-"));
  const root = await realpath(rawRoot);
  const rawOutside = await mkdtemp(path.join(tmpdir(), "mesh-terms-out-"));
  const outside = await realpath(rawOutside);
  fixtures.push(stateDir, rawRoot, rawOutside);
  const ptys: FakePty[] = [];
  const manager = new TerminalManager({
    spawn: (file, options) => {
      const pty = new FakePty(file, options);
      ptys.push(pty);
      return pty;
    },
  });
  const f: Fixture = {
    stateDir,
    root,
    outside,
    serverIdentity: identity(),
    leader: identity(),
    pins: PinStore(path.join(stateDir, "mesh", "pins.json")),
    auditFile: path.join(stateDir, "mesh", "audit.jsonl"),
    adapter: new FakeAdapter({ chunkDelayMs: 1 }),
    manager,
    host: null,
    terms: null as unknown as TermHost,
    ptys,
    // The built-in worker policy, rooted, with the caps and the task bound the test asked for.
    mesh: { enabled: true, policies: { worker: { roots: [root], harnesses: ["fake"], ...policy } } },
    clock: Date.now(),
  };
  f.terms = new TermHost({
    manager,
    clock: () => f.clock,
    detachedTtlMs: over.terms?.detachedTtlMs,
    ...(over.terms?.coalesce !== undefined ? { coalesce: over.terms.coalesce } : {}),
    ...(over.terms?.ringMaxBytes !== undefined ? { ringMaxBytes: over.terms.ringMaxBytes } : {}),
    log: () => undefined,
  });
  if (over.daemon === true) {
    f.host = new TaskHost({
      // The real chat registry, exactly as mesh-host.test.ts builds a daemon: a host
      // task is a real chat. No test here opens one; the host only marks daemon mode.
      chats: new ChatManager(),
      registry: {
        get: (id: string) => (id === "fake" ? f.adapter : undefined),
        available: async (id: string) => id === "fake",
      },
      workspace: async (real) => ({ id: "ws", path: real, name: path.basename(real) || real }),
      clock: () => f.clock,
      detachedTtlHours: () => 24,
      log: () => undefined,
    });
  }
  return f;
}

/** One served link against the fixture, plus its client end. */
function serveLink(f: Fixture): { client: RpcPeer; closed: Promise<string> } {
  const link = memoryLink();
  const deps: ServeDeps = {
    identity: f.serverIdentity,
    name: "target-box",
    pins: f.pins,
    audit: new AuditLog(f.auditFile, () => undefined),
    registry: {
      get: (id: string) => (id === "fake" ? f.adapter : undefined),
      available: async (id: string) => id === "fake",
    },
    config: () => f.mesh,
    enabled: () => f.mesh.enabled === true,
    home: tmpdir(),
    terms: f.terms,
    ...(f.host !== null ? { host: f.host } : {}),
    ...(f.approvals !== undefined ? { approvals: f.approvals } : {}),
  };
  const { closed } = serve({ input: link.server.input, output: link.server.output }, deps);
  const client = new RpcPeer(link.client.input, link.client.output, { role: "client" });
  client.start();
  return { client, closed };
}

/** A paired client: the worker has already accepted this identity under this name and policy. */
async function connectPaired(f: Fixture, name = "leader-box", who: NodeIdentity = f.leader): Promise<{ client: RpcPeer; closed: Promise<string> }> {
  await f.pins.setInbound(who.publicKey, name, "worker", "accept");
  const end = serveLink(f);
  await clientHandshake(end.client, { identity: who, name, hops: 0, expectedServerKey: f.serverIdentity.publicKey, tofu: false });
  return end;
}

interface TermOutput {
  termId: string;
  seq: number;
  data: string;
}

/** The term.* notifications one client saw, in arrival order. */
function collect(rpc: RpcPeer): { outputs: TermOutput[]; exits: { termId: string; code: number; signal?: number }[] } {
  const outputs: TermOutput[] = [];
  const exits: { termId: string; code: number; signal?: number }[] = [];
  rpc.onNotification((method, params) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (method === "term.output") outputs.push({ termId: String(p.termId), seq: p.seq as number, data: String(p.data) });
    else if (method === "term.exit") exits.push({ termId: String(p.termId), code: p.code as number, ...(p.signal !== undefined ? { signal: p.signal as number } : {}) });
  });
  return { outputs, exits };
}

/** One request that must fail, answered with the error the worker sent. */
async function refuse(rpc: RpcPeer, method: string, params: unknown): Promise<MeshRpcError> {
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

const ALLOW: RawPolicy = { caps: ["discover", "task.run", "fs.read", "term.open"], ask: [] };
const DENY: RawPolicy = { caps: ["discover"], ask: [] };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function openTerm(rpc: RpcPeer, f: Fixture, over: { cwd?: string; cols?: number; rows?: number } = {}): Promise<{ termId: string }> {
  return rpc.request<{ termId: string }>("term.open", { cwd: over.cwd ?? f.root, cols: over.cols ?? 80, rows: over.rows ?? 24 });
}

describe("term.open (worker)", () => {
  it("opens a terminal in a root and answers its id", async () => {
    const f = await makeFixture(ALLOW);
    const { client } = await connectPaired(f);
    const opened = await openTerm(client, f);
    expect(opened.termId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.ptys).toHaveLength(1);
    expect(f.ptys[0]!.options.cwd).toBe(f.root);
    expect(f.ptys[0]!.options.cols).toBe(80);
    expect(f.ptys[0]!.options.rows).toBe(24);
  });

  it("spawns the target's own shell and env, never a caller's", async () => {
    const f = await makeFixture(ALLOW);
    const { client } = await connectPaired(f);
    await openTerm(client, f);
    const pty = f.ptys[0]!;
    // The shell is what the target user runs (terminal.ts's own rule), and the env is the
    // target process's, stripped of GIT_/AWUI_ — nothing the caller sent can reach either.
    expect(pty.file).toBe(process.env.SHELL || "/bin/sh");
    expect(pty.options.env).toBeDefined();
    for (const key of Object.keys(pty.options.env ?? {})) {
      expect(key.startsWith("GIT_")).toBe(false);
      expect(key.startsWith("AWUI_")).toBe(false);
    }
  });

  it("refuses a caller that tries to name a shell or an env: the schema is closed", async () => {
    const f = await makeFixture(ALLOW);
    const { client } = await connectPaired(f);
    const error = await refuse(client, "term.open", { cwd: f.root, cols: 80, rows: 24, shell: "/bin/sh" });
    expect(error.code).toBe(MeshErrorCode.invalid_params);
    const error2 = await refuse(client, "term.open", { cwd: f.root, cols: 80, rows: 24, env: { PATH: "/tmp" } });
    expect(error2.code).toBe(MeshErrorCode.invalid_params);
    expect(f.ptys).toHaveLength(0);
  });

  it("refuses the cwd outside the roots, one that climbs with .., and one that does not exist", async () => {
    const f = await makeFixture(ALLOW);
    const { client } = await connectPaired(f);
    for (const cwd of [f.outside, `${f.root}/../escape`, `${f.root}/no-such-dir`]) {
      const error = await refuse(client, "term.open", { cwd, cols: 80, rows: 24 });
      expect(error.code).toBe(MeshErrorCode.denied);
    }
    expect(f.ptys).toHaveLength(0);
  });

  it("is denied under a policy without the term.open cap, and an ephemeral ask fails closed", async () => {
    const f = await makeFixture(DENY);
    const { client } = await connectPaired(f);
    const error = await refuse(client, "term.open", { cwd: f.root, cols: 80, rows: 24 });
    expect(error.code).toBe(MeshErrorCode.denied);
    // The built-in worker has term.open as ask; an ephemeral link has no one to ask.
    // The built-in worker keeps term.open as ask; an ephemeral link has no one to ask.
    const f2 = await makeFixture({});
    const second = await connectPaired(f2);
    const asked = await refuse(second.client, "term.open", { cwd: f2.root, cols: 80, rows: 24 });
    expect(asked.code).toBe(MeshErrorCode.needs_approval);
  });

  it("bounds live terminals per node: four, and never more than max_tasks", async () => {
    const f = await makeFixture({ ...ALLOW, max_tasks: 4 });
    const { client } = await connectPaired(f);
    for (let n = 0; n < 4; n++) await openTerm(client, f);
    const error = await refuse(client, "term.open", { cwd: f.root, cols: 80, rows: 24 });
    expect(error.code).toBe(MeshErrorCode.limit);
    expect(f.ptys).toHaveLength(4);

    const g = await makeFixture({ ...ALLOW, max_tasks: 1 });
    const second = await connectPaired(g);
    await openTerm(second.client, g);
    const capped = await refuse(second.client, "term.open", { cwd: g.root, cols: 80, rows: 24 });
    expect(capped.code).toBe(MeshErrorCode.limit);
  });

  it("answers the target's own dims refusal when the caller asks past what this machine serves", async () => {
    const f = await makeFixture(ALLOW);
    const { client } = await connectPaired(f);
    // The wire schema allows 10..500 columns; the target's own terminal bound is narrower
    // (10..400), and the refusal is the target's words, not a silent clamp.
    const error = await refuse(client, "term.open", { cwd: f.root, cols: 450, rows: 24 });
    expect(error.code).toBe(MeshErrorCode.invalid_params);
    expect(error.message).toContain("cols");
  });

  it("bounds concurrent opens: eight term.opens at once still leave only four live (finding #5)", async () => {
    const f = await makeFixture({ ...ALLOW, max_tasks: 4 });
    const { client } = await connectPaired(f);
    // Fired all at once over the one link: every open is in flight before any
    // PTY lands, and the check-then-count must still hold the line of four.
    const attempts = Array.from({ length: 8 }, () => client.request<{ termId: string }>("term.open", { cwd: f.root, cols: 80, rows: 24 }));
    const settled = await Promise.allSettled(attempts);
    expect(settled.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(4);
    for (const outcome of settled.filter((it) => it.status === "rejected")) {
      const error = (outcome as PromiseRejectedResult).reason as MeshRpcError;
      expect(error.code).toBe(MeshErrorCode.limit);
      expect(error.message).toMatch(/live or opening terminals/);
    }
    expect(f.ptys).toHaveLength(4);
  });

  it("bounds a node's terminal openings to 30 a minute (finding #5)", async () => {
    const f = await makeFixture({ ...ALLOW, max_tasks: 4 });
    const { client } = await connectPaired(f);
    // The fixture's clock is frozen, so the sliding window never moves: open
    // and close until the 30 create slots are spent, then the next is refused.
    for (let n = 0; n < 30; n++) {
      const { termId } = await openTerm(client, f);
      await client.request("term.close", { termId });
    }
    const refused = await refuse(client, "term.open", { cwd: f.root, cols: 80, rows: 24 });
    expect(refused.code).toBe(MeshErrorCode.limit);
    expect(refused.message).toContain("in the last minute");
  });
});

describe("term.input / term.resize (worker)", () => {
  it("carries bytes to the pty and sizes it, and audits one aggregated count per minute, never the text", async () => {
    const f = await makeFixture(ALLOW);
    const { client, closed } = await connectPaired(f);
    const { termId } = await openTerm(client, f);
    await client.request("term.input", { termId, data: Buffer.from("typed text").toString("base64") });
    await client.request("term.input", { termId, data: Buffer.from(" more").toString("base64") });
    await client.request("term.resize", { termId, cols: 120, rows: 40 });
    await sleep(10);
    expect(f.ptys[0]!.written).toEqual(["typed text", " more"]);
    expect(f.ptys[0]!.resized).toEqual([{ cols: 120, rows: 40 }]);
    // Finding #12: allowed inputs are traffic, not decisions — nothing is
    // written until the link closes (or a minute passes), and then one line.
    let audit = await readFile(f.auditFile, "utf8");
    expect(audit.includes('"term.input"')).toBe(false);
    client.close("done");
    await closed;
    await sleep(50);
    audit = await readFile(f.auditFile, "utf8");
    const inputLines = audit.trim().split("\n").filter((line) => line.includes('"term.input"'));
    expect(inputLines).toHaveLength(1);
    expect(inputLines[0]).toContain("15 bytes in 2 call(s)");
    expect(inputLines[0]).not.toContain("typed text");
  });

  it("bounds one input to 64 KiB and refuses what is not base64", async () => {
    const f = await makeFixture(ALLOW);
    const { client } = await connectPaired(f);
    const { termId } = await openTerm(client, f);
    const big = Buffer.alloc(64 * 1024 + 1, 0x61).toString("base64");
    const error = await refuse(client, "term.input", { termId, data: big });
    expect(error.code).toBe(MeshErrorCode.limit);
    const error2 = await refuse(client, "term.input", { termId, data: "!!!not base64!!!" });
    expect(error2.code).toBe(MeshErrorCode.invalid_params);
    expect(f.ptys[0]!.written).toEqual([]);
  });

  it("answers not_found for another node's terminal, never a denial to probe with", async () => {
    const f = await makeFixture(ALLOW, { daemon: true });
    const owner = await connectPaired(f);
    const { termId } = await openTerm(owner.client, f);
    const stranger = identity();
    await f.pins.setInbound(stranger.publicKey, "stranger-box", "worker", "accept");
    const link = serveLink(f);
    await clientHandshake(link.client, { identity: stranger, name: "stranger-box", hops: 0, expectedServerKey: f.serverIdentity.publicKey, tofu: false });
    for (const method of ["term.input", "term.resize", "term.close"]) {
      const params = method === "term.input" ? { termId, data: Buffer.from("x").toString("base64") } : method === "term.resize" ? { termId, cols: 100, rows: 30 } : { termId };
      const error = await refuse(link.client, method, params);
      expect(error.code).toBe(MeshErrorCode.not_found);
    }
    const error = await refuse(link.client, "term.attach", { termId, afterSeq: 0 });
    expect(error.code).toBe(MeshErrorCode.not_found);
    expect(f.ptys[0]!.written).toEqual([]);
  });
});

describe("term.output (worker)", () => {
  it("coalesces chunks within the window into one numbered frame", async () => {
    const f = await makeFixture(ALLOW, { terms: { coalesce: { maxMs: 12, maxBytes: 4096 } } });
    const { client } = await connectPaired(f);
    const seen = collect(client);
    const { termId } = await openTerm(client, f);
    f.ptys[0]!.emit("hello ");
    f.ptys[0]!.emit("world");
    await sleep(40);
    expect(seen.outputs).toHaveLength(1);
    expect(Buffer.from(seen.outputs[0]!.data, "base64").toString()).toBe("hello world");
    expect(seen.outputs[0]!.seq).toBe(1);
    expect(seen.outputs[0]!.termId).toBe(termId);
  });

  it("splits a frame at the byte bound instead of waiting for the window", async () => {
    const f = await makeFixture(ALLOW, { terms: { coalesce: { maxMs: 5000, maxBytes: 4096 } } });
    const { client } = await connectPaired(f);
    const seen = collect(client);
    await openTerm(client, f);
    const text = "x".repeat(10_000);
    f.ptys[0]!.emit(text);
    await sleep(30);
    // 10 KiB over a 4096-byte frame bound: three frames (4096 + 4096 + 1808), in order.
    expect(seen.outputs.map((o) => o.seq)).toEqual([1, 2, 3]);
    for (const frame of seen.outputs) expect(Buffer.from(frame.data, "base64").length).toBeLessThanOrEqual(4096);
    expect(Buffer.concat(seen.outputs.map((o) => Buffer.from(o.data, "base64"))).toString()).toBe(text);
  });

  it("numbers the exit after the last frame and carries its code and signal", async () => {
    const f = await makeFixture(ALLOW, { terms: { coalesce: { maxMs: 5000, maxBytes: 4096 } } });
    const { client } = await connectPaired(f);
    const seen = collect(client);
    const { termId } = await openTerm(client, f);
    f.ptys[0]!.emit("bye");
    f.ptys[0]!.exit(1, 9);
    await sleep(30);
    // The exit flushed what was pending first: the frame is not lost to the exit.
    expect(seen.outputs.map((o) => Buffer.from(o.data, "base64").toString())).toEqual(["bye"]);
    expect(seen.exits).toEqual([{ termId, code: 1, signal: 9 }]);
  });
});

describe("term.attach and daemon survival (worker)", () => {
  it("keeps a terminal across the link that opened it, and replays the ring to a reattaching one", async () => {
    const f = await makeFixture(ALLOW, { daemon: true });
    const first = await connectPaired(f);
    const seenFirst = collect(first.client);
    const { termId } = await openTerm(first.client, f);
    f.ptys[0]!.emit("first frame");
    await sleep(40);
    expect(Buffer.from(seenFirst.outputs[0]!.data, "base64").toString()).toBe("first frame");
    // The link that opened it goes away; the terminal must not.
    first.client.close("the ssh session ended");
    await first.closed;
    await sleep(20);
    expect(f.ptys[0]!.killed).toBe(false);

    const second = await connectPaired(f);
    const seenSecond = collect(second.client);
    const listed = await second.client.request<{ termId: string; cwd: string; exited: boolean }[]>("term.list", {});
    expect(listed).toHaveLength(1);
    expect(listed[0]!.termId).toBe(termId);
    const attached = await second.client.request<{ replayed: number; gap: boolean }>("term.attach", { termId, afterSeq: 0 });
    expect(attached.replayed).toBe(1);
    expect(attached.gap).toBe(false);
    await sleep(20);
    expect(Buffer.from(seenSecond.outputs[0]!.data, "base64").toString()).toBe("first frame");
    // Then live, without a duplicate of the replay.
    f.ptys[0]!.emit("second frame");
    await sleep(40);
    expect(seenSecond.outputs.map((o) => Buffer.from(o.data, "base64").toString())).toEqual(["first frame", "second frame"]);
  });

  it("says gap when the ring no longer reaches back to afterSeq", async () => {
    const f = await makeFixture(ALLOW, { daemon: true, terms: { coalesce: { maxMs: 5, maxBytes: 64 }, ringMaxBytes: 4 } });
    const first = await connectPaired(f);
    const { termId } = await openTerm(first.client, f);
    f.ptys[0]!.emit("one");
    await sleep(20);
    f.ptys[0]!.emit("two");
    await sleep(20);
    first.client.close("done");
    await first.closed;
    const second = await connectPaired(f);
    const attached = await second.client.request<{ replayed: number; gap: boolean }>("term.attach", { termId, afterSeq: 0 });
    expect(attached.gap).toBe(true);
    expect(attached.replayed).toBeLessThanOrEqual(1);
  });

  it("reaps a detached terminal on the clock, and never one a link still holds", async () => {
    const f = await makeFixture(ALLOW, { daemon: true, terms: { detachedTtlMs: 3_600_000, coalesce: { maxMs: 5, maxBytes: 4096 } } });
    const first = await connectPaired(f);
    const { termId } = await openTerm(first.client, f);
    first.client.close("the ssh session ended");
    await first.closed;
    await sleep(10);
    expect(f.ptys[0]!.killed).toBe(false);
    // An hour passes with no link holding the terminal.
    f.clock += 2 * 3_600_000;
    await f.terms.reap();
    expect(f.ptys[0]!.killed).toBe(true);
    const second = await connectPaired(f);
    const error = await refuse(second.client, "term.attach", { termId, afterSeq: 0 });
    expect(error.code).toBe(MeshErrorCode.not_found);

    // A terminal somebody still watches survives the same sweep.
    const third = await connectPaired(f);
    const held = await openTerm(third.client, f);
    f.clock += 2 * 3_600_000;
    await f.terms.reap();
    expect(f.ptys[1]!.killed).toBe(false);
    expect(held.termId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("waits on the target's approval queue when the cap is ask, and opens once the owner allows", async () => {
    // The default worker policy has term.open as ask: in daemon mode the call waits
    // for this node's owner instead of failing closed, exactly as fs.write does.
    const f = await makeFixture({}, { daemon: true });
    f.approvals = new ApprovalQueue();
    const { client } = await connectPaired(f);
    const pending = openTerm(client, f);
    for (let attempt = 0; attempt < 100; attempt++) {
      if (f.approvals.list().length > 0) break;
      await sleep(10);
    }
    const [card] = f.approvals.list();
    expect(card).toBeDefined();
    if (card === undefined) throw new Error("the ask never raised a card");
    expect(card.method).toBe("term.open");
    expect(card.cap).toBe("term.open");
    // Nothing was spawned while the question stood.
    expect(f.ptys).toHaveLength(0);
    expect(f.approvals.decide(card.id, "allow-once")).toBe("ok");
    const opened = await pending;
    expect(opened.termId).toMatch(/^[0-9a-f-]{36}$/);
    expect(f.ptys).toHaveLength(1);
  });

  it("answers method_not_found for term.attach on an ephemeral worker", async () => {
    const f = await makeFixture(ALLOW);
    const { client } = await connectPaired(f);
    const { termId } = await openTerm(client, f);
    const error = await refuse(client, "term.attach", { termId, afterSeq: 0 });
    expect(error.code).toBe(MeshErrorCode.method_not_found);
  });
});

describe("ephemeral close-with-link (worker)", () => {
  it("closes the terminal with the link that opened it", async () => {
    const f = await makeFixture(ALLOW);
    const { client, closed } = await connectPaired(f);
    await openTerm(client, f);
    expect(f.ptys).toHaveLength(1);
    client.close("the ssh session ended");
    await closed;
    await sleep(20);
    expect(f.ptys[0]!.killed).toBe(true);
    expect(await f.terms.list("")).toEqual([]);
  });

  it("closes every terminal the link held when the mesh is turned off", async () => {
    const f = await makeFixture(ALLOW, { daemon: true });
    const { client } = await connectPaired(f);
    await openTerm(client, f);
    // The next call re-reads the switch and disposes the node's terminals with its answer.
    f.mesh = { enabled: false, policies: f.mesh.policies };
    const error = await refuse(client, "term.list", {});
    expect(error.code).toBe(MeshErrorCode.mesh_off);
    await sleep(20);
    expect(f.ptys[0]!.killed).toBe(true);
  });
});
