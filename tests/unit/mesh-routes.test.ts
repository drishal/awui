// The mesh's owner-facing REST surface (P2 §4, src/server/mesh/routes.ts):
// the Settings dialog's Peers half, over supertest against a real app with
// fake harnesses. The cases are the spec's: the routes sit behind the same
// auth as every other owner route (a remote device without a session is
// refused), the mesh off is one honest GET and 409 mesh_off everywhere else,
// peers.json is the store an Add writes and a Remove forgets, a pending
// caller is accepted under a real policy or rejected, an invite mints a code
// with a QR, the ask-approval queue is decidable (and raises the note that
// wakes the owner), and a peer-owned task's request — the review finding these
// routes exist to fix — answers through /api/mesh exactly as a chat's own
// approval route would, first answer winning. Finding #1's case feeds a real
// GET /api/mesh answer into the web's own peerTerminals() — the round trip the
// hand-crafted payloads used to miss — and finding #2's covers the owner's
// read-only listing of peer terminals with its kill action.
import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { IDisposable } from "@lydell/node-pty";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { makeTestApp, type TestApp } from "../helpers/app.js";
import { AuditLog } from "../../src/server/mesh/audit.js";
import { decodeInviteCode, encodeInviteCode } from "../../src/server/mesh/pairing.js";
import { nodeIdOf, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { PeerManager, type PeerSpawn } from "../../src/server/mesh/manager.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { serve, type ServeDeps } from "../../src/server/mesh/serve.js";
import { TermHost } from "../../src/server/mesh/terms.js";
import { TerminalManager } from "../../src/server/terminal.js";
import type { ProjectPty } from "../../src/server/terminal-backend.js";
import { memoryLink } from "../../src/server/mesh/transport.js";
import type { MeshConfig } from "../../src/server/user-config.js";
import { peerTerminals } from "../../src/web/terminal-peers.js";
import type { MeshApprovalRow, MeshHostTermRow, MeshOverview, MeshTaskRow } from "../../src/shared/protocol.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

/** A remote device's host, the shape security.test.ts uses: needs a session. */
const LAN = "192.168.1.50";
const lanHost = (port: number) => `${LAN}:${port}`;

/** A fresh identity for a fake remote node, the shape loadOrCreateIdentity returns. */
function identity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
  return { publicKey: raw, privateKey, nodeId: nodeIdOf(raw) };
}

/** Polls until probe returns a value; the fake harness streams on real timers. */
async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const value = await probe();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("auth and the mesh switch", () => {
  it("answers 404 without the mesh deps, like every feature this app was built without", async () => {
    t = await makeTestApp();
    expect((await request(t.server).get("/api/mesh")).status).toBe(404);
  });

  it("refuses a remote device without a session, like every other /api route", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: [LAN], mesh: { enabled: () => true } });
    const refused = await request(t.server).get("/api/mesh").set("Host", lanHost(t.port));
    expect(refused.status).toBe(401);
    expect(refused.body.code).toBe("unauthenticated");
  });

  it("answers one honest GET with the mesh off, and 409 mesh_off everywhere else", async () => {
    t = await makeTestApp({ mesh: { enabled: () => false } });
    const view = (await request(t.server).get("/api/mesh")).body as MeshOverview;
    expect(view.enabled).toBe(false);
    expect(view.pending).toEqual([]);
    expect(view.approvals).toEqual([]);
    expect(view.listen).toBeNull();
    for (const [method, path, body] of [
      ["post", "/peers", { name: "lab", tls: "lab.internal:4784" }],
      ["delete", "/peers/lab", {}],
      ["post", "/peers/lab/test", {}],
      ["post", "/pending/nodeid/accept", { policy: "worker" }],
      ["post", "/pending/nodeid/reject", {}],
      ["post", "/invites", { policy: "worker" }],
      ["post", "/join", { code: "awui-invite:1:AAAA" }],
      ["post", "/approvals/ap_1", { decision: "deny" }],
      ["post", "/tasks/rt_1/answer", { requestId: "rq", answer: { kind: "confirm", confirmed: true } }],
      ["post", "/tasks/rt_1/abort", {}],
      ["post", "/terms/tt_1/close", {}],
    ] as const) {
      const res = await (request(t.server) as unknown as Record<string, (path: string) => request.Test>)[method]!(`/api/mesh${path}`).send(body);
      expect(res.status).toBe(409);
      expect(res.body.code).toBe("mesh_off");
    }
    // The task and terminal lists are reads: honestly empty, not a refusal.
    expect((await request(t.server).get("/api/mesh/tasks")).body).toEqual({ tasks: [] });
    expect((await request(t.server).get("/api/mesh/terms")).body).toEqual({ terms: [] });
  });
});

describe("peers.json from the dialog", () => {
  it("adds a peer, lists it as saved here, refuses a config.yml name and a duplicate, and removes it", async () => {
    t = await makeTestApp({
      mesh: {
        enabled: () => true,
        config: () => ({ enabled: true, peers: [{ name: "from-yaml", ssh: "ci@yaml-box" }] }),
      },
    });
    const add = await request(t.server).post("/api/mesh/peers").send({ name: "lab", tls: "lab.internal:4784" });
    expect(add.status).toBe(200);
    expect(add.body).toEqual({ added: true });
    const clash = await request(t.server).post("/api/mesh/peers").send({ name: "From-YAML", ssh: "x@y" });
    expect(clash.status).toBe(409);
    expect(clash.body.code).toBe("config_peer");
    const dup = await request(t.server).post("/api/mesh/peers").send({ name: "lab", tls: "other:4784" });
    expect(dup.status).toBe(400);
    expect(dup.body.code).toBe("peer_not_added");

    const view = (await request(t.server).get("/api/mesh")).body as MeshOverview;
    expect(view.peers).toEqual([
      { name: "from-yaml", transport: "ssh", address: "ci@yaml-box", source: "config", pinned: false },
      { name: "lab", transport: "tls", address: "lab.internal:4784", source: "ui", pinned: false },
    ]);

    // A config.yml peer is not this route's to remove.
    expect((await request(t.server).delete("/api/mesh/peers/from-yaml")).status).toBe(409);
    const remove = await request(t.server).delete("/api/mesh/peers/lab");
    expect(remove.status).toBe(200);
    expect((await request(t.server).get("/api/mesh")).body.peers.map((p: { name: string }) => p.name)).toEqual(["from-yaml"]);
    expect((await request(t.server).delete("/api/mesh/peers/lab")).status).toBe(404);
  });

  it("refuses a peer shape config.yml would refuse", async () => {
    t = await makeTestApp({ mesh: { enabled: () => true } });
    expect((await request(t.server).post("/api/mesh/peers").send({ name: "lab", ssh: "ci@box", docker: "c1" })).status).toBe(400);
    expect((await request(t.server).post("/api/mesh/peers").send({ name: "lab" })).status).toBe(400);
    expect((await request(t.server).post("/api/mesh/peers").send({ name: "lab", tls: "not a port" })).status).toBe(400);
  });
});

describe("pairing requests", () => {
  it("accepts a pending caller under a policy, and rejects one", async () => {
    t = await makeTestApp({
      mesh: { enabled: () => true, config: () => ({ enabled: true, policies: { worker: { roots: [t?.root ?? "/"] } } }) },
    });
    const who = identity();
    await t.mesh!.pins.addPending(who.publicKey, "leader-box");
    const other = identity();
    await t.mesh!.pins.addPending(other.publicKey, "other-box");

    const view = (await request(t.server).get("/api/mesh")).body as MeshOverview;
    expect(view.pending.length).toBe(2);
    const mine = view.pending.find((p) => p.name === "leader-box")!;
    expect(mine.sas).toMatch(/^\d{3} \d{3}$/);

    // A typo'd policy must never pin a caller to the floor silently.
    const bad = await request(t.server).post(`/api/mesh/pending/${mine.nodeId}/accept`).send({ policy: "typo" });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe("unknown_policy");

    const accept = await request(t.server).post(`/api/mesh/pending/${mine.nodeId}/accept`).send({ policy: "worker" });
    expect(accept.status).toBe(200);
    expect(accept.body).toEqual({ accepted: true, name: "leader-box" });
    const pinned = await t.mesh!.pins.inbound(mine.nodeId);
    expect(pinned?.policy).toBe("worker");

    const reject = await request(t.server).post(`/api/mesh/pending/${view.pending.find((p) => p.name === "other-box")!.nodeId}/reject`).send({});
    expect(reject.status).toBe(200);
    expect((await request(t.server).get("/api/mesh")).body.pending.map((p: { name: string }) => p.name)).toEqual([]);
    expect((await request(t.server).post("/api/mesh/pending/unknown/reject").send({})).status).toBe(404);
  });
});

describe("invites and joins", () => {
  it("mints a code with a QR, and joins from a code with no address by pinning its key", async () => {
    t = await makeTestApp({ mesh: { enabled: () => true, config: () => ({ enabled: true, policies: { worker: { roots: [t?.root ?? "/"] } } }) } });
    expect((await request(t.server).post("/api/mesh/invites").send({ policy: "nope" })).status).toBe(400);
    const made = await request(t.server).post("/api/mesh/invites").send({ policy: "worker", ttlMinutes: 10 });
    expect(made.status).toBe(200);
    expect(made.body.code).toMatch(/^awui-invite:1:/);
    expect(made.body.qrSvg).toMatch(/^<svg/);
    const code = decodeInviteCode(made.body.code as string);
    expect(code?.name).toBe("test-box");
    expect(code?.addresses).toEqual([]); // no listener: the code pins, it does not redeem

    const join = await request(t.server).post("/api/mesh/join").send({ code: made.body.code });
    expect(join.status).toBe(200);
    expect(join.body).toEqual({ pinned: true, redeemed: false, saved: false, name: "test-box" });
    const pinned = await t.mesh!.pins.outbound("test-box");
    expect(pinned).not.toBeNull();
    expect(t.mesh!.invites.list().length).toBe(1); // unredeemed: still live
  });

  it("refuses a code that is not one, and says when no address could be reached", async () => {
    t = await makeTestApp({ mesh: { enabled: () => true } });
    expect((await request(t.server).post("/api/mesh/join").send({ code: "not-a-code" })).status).toBe(400);
    // A loopback port nothing listens on: the dial fails at once, so the join
    // is a refusal, never a hang.
    const { publicKey } = generateKeyPairSync("ed25519");
    const key = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
    const code = encodeInviteCode({ v: 1, name: "far-box", addresses: ["127.0.0.1:1"], targetKey: key, inviteId: Buffer.alloc(8, 7), secret: Buffer.alloc(16, 9) });
    const unreachable = await request(t.server).post("/api/mesh/join").send({ code, name: "far" });
    expect(unreachable.status).toBe(502);
    expect(unreachable.body.code).toBe("peer_unreachable");
  });
});

describe("ask approvals", () => {
  it("lists the queue, decides a card, and wakes the owner when one is raised", async () => {
    t = await makeTestApp({ mesh: { enabled: () => true } });
    const queue = t.mesh!.approvals;
    const link = queue.openLink();
    const asked = queue.ask(link, { nodeId: "node-9", peerName: "lab-vm-3", method: "fs.write", cap: "fs.write", root: "/tmp", summary: "fs.write into /tmp/scratch" });

    const view = (await request(t.server).get("/api/mesh")).body as MeshOverview;
    const card = view.approvals.find((a: MeshApprovalRow) => a.peerName === "lab-vm-3")!;
    expect(card.summary).toBe("fs.write into /tmp/scratch");
    // The raise reached the owner's note pipeline: fixed wording, the bounded
    // summary, never the waiting call's bytes.
    expect(t.mesh!.notes.length).toBe(1);
    expect(t.mesh!.notes[0]!.kind).toBe("mesh");
    expect(t.mesh!.notes[0]!.title).toBe("Mesh approval from lab-vm-3");

    expect((await request(t.server).post("/api/mesh/approvals/unknown").send({ decision: "deny" })).status).toBe(404);
    const deny = await request(t.server).post(`/api/mesh/approvals/${card.id}`).send({ decision: "deny" });
    expect(deny.status).toBe(200);
    expect(deny.body).toEqual({ decided: true });
    expect(await asked).toBe("deny");
    expect((await request(t.server).get("/api/mesh")).body.approvals).toEqual([]);

    // The other two decisions settle their waiter the same way.
    const again = queue.ask(queue.openLink(), { nodeId: "node-9", peerName: "lab-vm-3", method: "fs.read", cap: "fs.read", root: null, summary: "fs.read of a folder" });
    const listed = (await request(t.server).get("/api/mesh")).body.approvals as MeshApprovalRow[];
    const allow = await request(t.server).post(`/api/mesh/approvals/${listed[0]!.id}`).send({ decision: "allow-once" });
    expect(allow.status).toBe(200);
    expect(await again).toBe("allow");
  });
});

describe("mesh tasks on this node", () => {
  /** One task opened on the host directly, as a served link's open would. */
  /** One task opened on the host directly, as a served link's open would. */
  async function openTask(app: TestApp, peerName = "leader-box", approvalsAt: "target" | "both" | "origin" = "target"): Promise<{ remoteTaskId: string }> {
    const link = app.mesh!.host.openLink(() => undefined);
    const opened = await app.mesh!.host.open(link, "node-1", peerName, {
      clientRequestId: `crq-${Math.random().toString(36).slice(2)}`,
      harness: "fake",
      cwd: await realpath(app.project),
      ceiling: "auto-edit",
      maxTasks: 4,
      approvalsAt,
    });
    return { remoteTaskId: opened.remoteTaskId };
  }

  const chatOf = (app: TestApp, remoteTaskId: string) => app.manager.list().find((c) => c.owner?.kind === "peer" && c.owner.remoteTaskId === remoteTaskId)!;

  it("lists a peer-owned task with its request, answers it through the route, and only the first answer wins", async () => {
    t = await makeTestApp({ mesh: { enabled: () => true } });
    const task = await openTask(t);
    const chat = chatOf(t, task.remoteTaskId);
    void chat.send("please ask before reading", "normal");
    const requestId = await waitFor(() => (chat.pendingCount > 0 ? chat.snapshot().pending[0]?.id : undefined), "the pending request");

    const rows = (await request(t.server).get("/api/mesh/tasks")).body.tasks as MeshTaskRow[];
    const row = rows.find((r) => r.remoteTaskId === task.remoteTaskId)!;
    expect(row.peerName).toBe("leader-box");
    expect(row.harness).toBe("fake");
    expect(row.cwd).toBe(await realpath(t.project));
    expect(row.pendingRequests[0]!.approval).toEqual({ approve: { kind: "confirm", confirmed: true }, deny: { kind: "confirm", confirmed: false } });

    expect((await request(t.server).post("/api/mesh/tasks/rt_none/answer").send({ requestId, answer: { kind: "confirm", confirmed: true } })).status).toBe(404);
    const answer = await request(t.server).post(`/api/mesh/tasks/${task.remoteTaskId}/answer`).send({ requestId, answer: { kind: "confirm", confirmed: true } });
    expect(answer.status).toBe(200);
    expect(answer.body.outcome).toBe("Approved");
    expect(chat.pendingCount).toBe(0);
    // First answer wins: the request is gone, exactly as the chat's own route answers a second click.
    const late = await request(t.server).post(`/api/mesh/tasks/${task.remoteTaskId}/answer`).send({ requestId, answer: { kind: "confirm", confirmed: false } });
    expect(late.status).toBe(409);
    await waitFor(() => (chat.status === "idle" ? true : undefined), "the approved run to settle");
  });

  it("aborts a running peer task", async () => {
    t = await makeTestApp({ mesh: { enabled: () => true } });
    const task = await openTask(t);
    const chat = chatOf(t, task.remoteTaskId);
    void chat.send("slow", "normal");
    await waitFor(() => (chat.status === "running" ? true : undefined), "the run to start");
    const abort = await request(t.server).post(`/api/mesh/tasks/${task.remoteTaskId}/abort`).send({});
    expect(abort.status).toBe(200);
    expect(abort.body).toEqual({ aborted: true });
    await waitFor(() => (chat.status === "idle" ? true : undefined), "the aborted run to settle");
  });

  it("raises the peer chat's ask as a mesh note with fixed wording, but never under approvals_at origin", async () => {
    t = await makeTestApp({ mesh: { enabled: () => true } });
    const task = await openTask(t, "leader-box", "target");
    const chat = chatOf(t, task.remoteTaskId);
    void chat.send("please ask before reading", "normal");
    const request = await waitFor(() => (chat.pendingCount > 0 ? chat.snapshot().pending[0] : undefined), "the pending request");
    // The manager's news gate (app.ts) turns a peer-owned chat's ask into one
    // note for this machine's owner: fixed words, the chat's own answer route
    // on its buttons — never the request's title, which may quote a prompt.
    const note = await waitFor(() => (t!.mesh!.notifier.since(0).find((n) => n.kind === "mesh") ?? undefined), "the mesh note");
    expect(note.title).toBe("Mesh task from leader-box");
    expect(note.body).toBe("asks for an approval");
    expect(note.approval?.requestId).toBe(request.id);
    expect(JSON.stringify(note)).not.toContain("please ask");

    // An origin task's approvals are the leader's to answer: no note here.
    const origin = await openTask(t, "leader-box", "origin");
    const originChat = chatOf(t, origin.remoteTaskId);
    const app = t;
    const meshNotes = () => app!.mesh!.notifier.since(0).filter((n) => n.kind === "mesh").length;
    const before = meshNotes();
    void originChat.send("please ask before reading", "normal");
    await waitFor(() => (originChat.pendingCount > 0 ? true : undefined), "the origin task's request");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(meshNotes()).toBe(before);
  });

});

describe("caps advertisement end to end (finding #1)", () => {
  const workerDirs: string[] = [];
  afterAll(async () => {
    // maxRetries: the worker's audit log may still be flushing its last line
    // when the suite tears down, and a directory mid-write is not empty yet.
    await Promise.all(workerDirs.map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })));
  });

  it("GET /api/mesh warms and carries a peer's advertised caps, and real rows feed the terminal menu", async () => {
    // The worker side exactly as a real target serves it: a real serve() over a
    // memory link whose worker policy plainly allows term.open.
    const stateDir = await mkdtemp(path.join(tmpdir(), "mesh-routes-worker-"));
    workerDirs.push(stateDir);
    const who = identity();
    const workerPins = PinStore(path.join(stateDir, "pins.json"));
    const adapter = new FakeAdapter({ chunkDelayMs: 1 });
    const mesh: MeshConfig = {
      enabled: true,
      policies: { worker: { roots: [], harnesses: ["fake"], caps: ["discover", "task.run", "task.approve", "fs.read", "term.open"], ask: [] } },
    };
    const spawn = (): PeerSpawn => {
      const pair = memoryLink();
      const deps: ServeDeps = {
        identity: who,
        name: "target-box",
        pins: workerPins,
        audit: new AuditLog(path.join(stateDir, "audit.jsonl"), () => undefined),
        registry: { get: (id: string) => (id === "fake" ? adapter : undefined), available: async (id: string) => id === "fake" },
        config: () => mesh,
        enabled: () => true,
        home: tmpdir(),
      };
      serve({ input: pair.server.input, output: pair.server.output }, deps);
      return { input: pair.client.input, output: pair.client.output, kill: () => undefined };
    };
    const leader = identity();
    await workerPins.setInbound(leader.publicKey, "leader-box", "worker", "accept");
    const leaderPins = PinStore(path.join(stateDir, "leader-pins.json"));
    await leaderPins.setOutbound("lab", who.publicKey);
    const manager = new PeerManager({
      identity: async () => leader,
      pins: leaderPins,
      config: () => ({ enabled: true, peers: [{ name: "lab", docker: "awui-worker-1" }] }),
      enabled: () => true,
      localName: () => "leader-box",
      spawn: (_name, _link) => spawn(),
      log: () => undefined,
    });
    const app = await makeTestApp({ mesh: { enabled: () => true, peers: manager, config: () => ({ enabled: true, peers: [{ name: "lab", ssh: "ci@lab" }] }) } });
    t = app;

    // Before any probe the row carries no caps: absent never means "everything".
    const first = (await request(app.server).get("/api/mesh")).body as MeshOverview;
    expect(first.peers[0]!.caps).toBeUndefined();

    // The GET's own background probe warms the cache without hanging the answer.
    const view = await waitFor(async () => {
      const body = (await request(app.server).get("/api/mesh")).body as MeshOverview;
      return body.peers[0]?.caps !== undefined ? body : undefined;
    }, "the background caps probe");
    expect(view.peers[0]!.caps).toEqual({ allow: expect.arrayContaining(["term.open"]), ask: [] });

    // The contract the whole feature hangs on: real peerRows() output, straight
    // from the route, into the web's own menu reader.
    expect(peerTerminals(view)).toEqual([{ name: "lab" }]);

    // The Test button answers with the same caps straight from peer.info.
    const test = await request(t.server).post("/api/mesh/peers/lab/test").send({});
    expect(test.status).toBe(200);
    expect((test.body.info as { caps: unknown }).caps).toEqual({ allow: expect.arrayContaining(["term.open"]), ask: [] });
  });
});

describe("peer terminals on this node (finding #2)", () => {
  /** The fake pty the manager spawns over: records what it was given, never runs anything. */
  class FakePty implements ProjectPty {
    readonly pid = 999_999;
    killed = false;
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

    write(): void {}

    resize(): void {}

    kill(): void {
      this.killed = true;
    }
  }

  /** A peer policy that grants this test's project folder as a root. */
  const rooted = (root: string) => ({
    caps: [] as never[],
    ask: [] as never[],
    roots: [root],
    harnesses: [] as string[],
    permissionCeiling: "read-only" as const,
    maxTasks: 4,
    maxFileBytes: 1024,
    approvalsAt: "origin" as const,
  });

  it("lists the terminals peers opened here, kills one, and answers honestly when the mesh is off", async () => {
    const ptys: FakePty[] = [];
    const manager = new TerminalManager({ spawn: (file, options) => { const pty = new FakePty(file, options); ptys.push(pty); return pty; } });
    const terms = new TermHost({ manager, clock: Date.now, log: () => undefined });
    const app = await makeTestApp({ mesh: { enabled: () => true, terms } });
    t = app;

    // A peer's terminal, opened on the host directly as a served link's open would.
    const link = terms.openLink(() => undefined);
    const opened = await terms.open(link, "node-7", "lab-vm-3", rooted(app.project), tmpdir(), { cwd: app.project, cols: 90, rows: 30 });

    const rows = (await request(t.server).get("/api/mesh/terms")).body.terms as MeshHostTermRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ termId: opened.termId, peerName: "lab-vm-3", nodeId: "node-7", cwd: await realpath(t.project), cols: 90, rows: 30, exited: false, lastSeq: 0 });

    const kill = await request(t.server).post(`/api/mesh/terms/${opened.termId}/close`).send({});
    expect(kill.body).toEqual({ closed: true });
    expect(ptys[0]!.killed).toBe(true);
    expect((await request(t.server).get("/api/mesh/terms")).body.terms).toEqual([]);
    expect((await request(t.server).post("/api/mesh/terms/no-such-term/close").send({})).status).toBe(404);
    // The kill is a decision: one audited line, by id.
    const audit = await readFile(path.join(t.stateDir, "mesh", "audit.jsonl"), "utf8");
    expect(audit).toContain('"ui.term.close"');
    expect(audit).toContain(opened.termId);
    await terms.shutdown();
  });

  it("answers an honestly empty list with the mesh off, and the kill refuses", async () => {
    const manager = new TerminalManager({ spawn: (file, options) => new FakePty(file, options) });
    const terms = new TermHost({ manager, clock: Date.now, log: () => undefined });
    t = await makeTestApp({ mesh: { enabled: () => false, terms } });
    expect((await request(t.server).get("/api/mesh/terms")).body).toEqual({ terms: [] });
    const kill = await request(t.server).post("/api/mesh/terms/tt_1/close").send({});
    expect(kill.status).toBe(409);
    expect(kill.body.code).toBe("mesh_off");
    await terms.shutdown();
  });
});
