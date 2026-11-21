// The mesh attach socket (P1.5 §1): every rule the listener and the pipe
// client promise, against a real Unix socket and — where it matters — a real
// serve() loop behind it. The socket's own two promises come first (0600 in a
// 0700 directory, stale files taken over, foreign files refused), then the
// prologue's strictness (one exact prefix, bounded, strict json, nothing
// extra), then the bytes that follow a prologue in the same chunk, then a
// full round trip through connectAndPipe into a served link, and finally the
// serve-stdio attach decision without a process attached.
import { spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { chmod, chown, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, describe, expect, it } from "vitest";
import type { WorkspaceInfo } from "../../src/shared/protocol.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import type { HarnessRegistry } from "../../src/server/harness/registry.js";
import {
  ATTACH_FALLBACK_NOTE,
  ATTACH_PREFIX,
  connectAndPipe,
  planServeStdio,
  socketPath,
  startAttachListener,
  type AttachForced,
  type AttachLink,
} from "../../src/server/mesh/attach.js";
import { AuditLog } from "../../src/server/mesh/audit.js";
import { startMeshAttach } from "../../src/server/mesh/daemon.js";
import { clientHandshake } from "../../src/server/mesh/handshake.js";
import { loadOrCreateIdentity, nodeIdOf, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { RpcPeer } from "../../src/server/mesh/rpc.js";
import { runServeStdio, serve, type ServeDeps } from "../../src/server/mesh/serve.js";
import { TaskHost } from "../../src/server/mesh/host.js";
import { ChatManager } from "../../src/server/chats/manager.js";
import type { MeshConfig } from "../../src/server/user-config.js";

/** Unix sockets are the whole feature; the win32 branches are refusals, not testable here. */
const posix = process.platform !== "win32";
/** chown needs root; the not-owned runtime-dir case can only be probed as root. */
const root = typeof process.getuid === "function" && process.getuid() === 0;

const fixtures: string[] = [];
afterAll(async () => {
  await Promise.all(fixtures.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A fresh in-memory identity, the shape loadOrCreateIdentity returns. */
function identity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
  return { publicKey: raw, privateKey, nodeId: nodeIdOf(raw) };
}

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until probe returns a value; the listener's setup and the fake harness run on real timers. */
async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 800; i++) {
    const value = await probe();
    if (value !== undefined) return value;
    await tick(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Whether something currently answers connections at this path. */
const canConnect = (at: string): Promise<boolean> =>
  new Promise((resolve) => {
    const sock = net.createConnection(at);
    const done = (ok: boolean): void => {
      sock.destroy();
      resolve(ok);
    };
    sock.once("connect", () => done(true));
    sock.once("error", () => done(false));
    sock.once("close", () => done(false));
  });

/** One 0700 directory the test may put a socket in. */
async function sockDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "mesh-attach-"));
  fixtures.push(dir);
  return dir;
}

describe("socketPath", () => {
  it("lets AWUI_MESH_SOCKET override everything", async () => {
    const stateDir = await sockDir();
    expect(await socketPath({ AWUI_MESH_SOCKET: "/tmp/awui-test-mesh.sock" }, stateDir)).toBe("/tmp/awui-test-mesh.sock");
  });

  it("uses XDG_RUNTIME_DIR when it is this uid's 0700 directory", async () => {
    const stateDir = await sockDir();
    const runtime = await mkdtemp(path.join(tmpdir(), "mesh-attach-xdg-"));
    fixtures.push(runtime);
    await chmod(runtime, 0o700);
    expect(await socketPath({ XDG_RUNTIME_DIR: runtime }, stateDir)).toBe(path.join(runtime, "awui-mesh.sock"));
  });

  it("falls back to the state folder when the runtime dir is looser than 0700, and creates mesh/ 0700", async () => {
    const stateDir = await sockDir();
    const runtime = await mkdtemp(path.join(tmpdir(), "mesh-attach-xdg-"));
    fixtures.push(runtime);
    await chmod(runtime, 0o777);
    const at = await socketPath({ XDG_RUNTIME_DIR: runtime }, stateDir);
    expect(at).toBe(path.join(stateDir, "mesh", "attach.sock"));
    expect((await stat(path.dirname(at))).mode & 0o777).toBe(0o700);
  });

  it("falls back to the state folder when XDG_RUNTIME_DIR is unset or missing", async () => {
    const stateDir = await sockDir();
    expect(await socketPath({}, stateDir)).toBe(path.join(stateDir, "mesh", "attach.sock"));
    expect(await socketPath({ XDG_RUNTIME_DIR: path.join(stateDir, "not-there") }, stateDir)).toBe(path.join(stateDir, "mesh", "attach.sock"));
  });

  it.skipIf(!root)("falls back when the runtime dir belongs to another uid", async () => {
    const stateDir = await sockDir();
    const runtime = await mkdtemp(path.join(tmpdir(), "mesh-attach-xdg-"));
    fixtures.push(runtime);
    await chown(runtime, 65534, 65534);
    expect(await socketPath({ XDG_RUNTIME_DIR: runtime }, stateDir)).toBe(path.join(stateDir, "mesh", "attach.sock"));
  });
});

describe("startAttachListener", () => {
  it.skipIf(!posix)("listens with the socket 0600 in a 0700 directory, and close() removes the file", async () => {
    const dir = await sockDir();
    // A directory looser than the spec's is tightened, not trusted.
    await chmod(dir, 0o755);
    const at = path.join(dir, "attach.sock");
    const links: AttachLink[] = [];
    const listener = startAttachListener({ path: at, onLink: (link) => links.push(link), log: () => undefined });
    await waitFor(async () => ((await canConnect(at)) ? true : undefined), "the attach socket to answer");
    expect((await stat(at)).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    listener.close();
    await waitFor(async () => ((await stat(at).catch(() => null)) === null ? true : undefined), "the socket file to be removed");
    expect(links).toHaveLength(0);
  });

  it.skipIf(!posix)("takes over a stale socket a crashed listener left behind", async () => {
    const dir = await sockDir();
    const at = path.join(dir, "attach.sock");
    // A real crash, not server.close(): this Node removes the socket file on a clean
    // close, so only a SIGKILLed child leaves exactly the leftover a restart must handle.
    const child = spawn(process.execPath, ["-e", "require('node:net').createServer(() => {}).listen(process.argv[1], () => {});", at], { stdio: "ignore" });
    fixtures.push(dir);
    await waitFor(async () => ((await stat(at).catch(() => null))?.isSocket() ? true : undefined), "the child's socket file to exist");
    child.kill("SIGKILL");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    // The file is there and nothing answers it: exactly a crashed listener's leftovers.
    expect((await stat(at)).isSocket()).toBe(true);
    expect(await canConnect(at)).toBe(false);
    const listener = startAttachListener({ path: at, onLink: () => undefined, log: () => undefined });
    await waitFor(async () => ((await canConnect(at)) ? true : undefined), "the new listener to take the socket over");
    listener.close();
  });

  it.skipIf(!posix)("refuses a regular file at the path, says so once, and never listens", async () => {
    const dir = await sockDir();
    const at = path.join(dir, "attach.sock");
    await writeFile(at, "not a socket\n");
    const logs: string[] = [];
    const seen: AttachForced[] = [];
    const listener = startAttachListener({ path: at, onLink: (_link, forced) => seen.push(forced), log: (m) => logs.push(m) });
    await waitFor(() => (logs.some((m) => m.includes("not a socket")) ? true : undefined), "the refusal to be logged");
    expect(await canConnect(at)).toBe(false);
    expect(seen).toHaveLength(0);
    listener.close();
    // A refused path is never touched: the foreign file stays exactly as it was.
    expect((await stat(at)).isFile()).toBe(true);
  });

  it.skipIf(!posix)("closes every kind of bad prologue, and never calls onLink", async () => {
    const dir = await sockDir();
    const at = path.join(dir, "attach.sock");
    const seen: AttachForced[] = [];
    const listener = startAttachListener({ path: at, onLink: (_link, forced) => seen.push(forced), log: () => undefined });
    await waitFor(async () => ((await canConnect(at)) ? true : undefined), "the attach socket to answer");

    const badLines = [
      "WRONG-PREFIX/1 {}\n",
      `${ATTACH_PREFIX}{not json\n`,
      `${ATTACH_PREFIX}{"forced":null,"extra":1}\n`,
      `${ATTACH_PREFIX}{"forced":{"policy":"worker"}}\n`,
      `${ATTACH_PREFIX}null\n`,
    ];
    for (const bad of badLines) {
      const sock = net.createConnection(at);
      await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
      sock.write(bad);
      await waitFor(() => (sock.destroyed ? true : undefined), `the link to close on a bad prologue`);
    }
    // Over the 4 KiB bound without ever sending a newline: closed on size alone.
    const big = net.createConnection(at);
    await new Promise<void>((resolve) => big.once("connect", () => resolve()));
    big.write(ATTACH_PREFIX + "x".repeat(5000));
    await waitFor(() => (big.destroyed ? true : undefined), "the link to close on an oversized prologue");
    expect(seen).toHaveLength(0);
    listener.close();
  });

  it.skipIf(!posix)("hands onLink the forced pair and any bytes that followed the prologue in the same chunk", async () => {
    const dir = await sockDir();
    const at = path.join(dir, "attach.sock");
    const seen: Array<{ forced: AttachForced; chunks: Buffer[] }> = [];
    const listener = startAttachListener({
      path: at,
      onLink: (link, forced) => {
        const chunks: Buffer[] = [];
        link.input.on("data", (chunk: Buffer) => chunks.push(chunk));
        seen.push({ forced, chunks });
      },
      log: () => undefined,
    });
    await waitFor(async () => ((await canConnect(at)) ? true : undefined), "the attach socket to answer");

    const forced = { policy: "worker", peer: "leader-box" };
    const sock = net.createConnection(at);
    await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
    // One write, prologue and payload together: what a pipelining client actually sends.
    sock.write(`${ATTACH_PREFIX}${JSON.stringify({ forced })}\nAFTER-THE-NEWLINE`);
    const got = await waitFor(() => (seen[0]?.chunks.length ? seen[0] : undefined), "onLink to see the bytes after the prologue");
    expect(got.forced).toEqual(forced);
    expect(Buffer.concat(got.chunks).toString("utf8")).toBe("AFTER-THE-NEWLINE");
    sock.destroy();

    // The null form is a valid prologue: an ordinary link with no forced ceiling.
    const plain = net.createConnection(at);
    await new Promise<void>((resolve) => plain.once("connect", () => resolve()));
    plain.write(`${ATTACH_PREFIX}{"forced":null}\n`);
    await waitFor(() => (seen[1] !== undefined ? true : undefined), "the null-forced link to be accepted");
    expect(seen[1]!.forced).toBeNull();
    plain.destroy();
    listener.close();
  });

  it.skipIf(!posix)("close() closes every attached link", async () => {
    const dir = await sockDir();
    const at = path.join(dir, "attach.sock");
    let opened = 0;
    const listener = startAttachListener({ path: at, onLink: () => { opened++; }, log: () => undefined });
    await waitFor(async () => ((await canConnect(at)) ? true : undefined), "the attach socket to answer");
    const sock = net.createConnection(at);
    await new Promise<void>((resolve) => sock.once("connect", () => resolve()));
    sock.write(`${ATTACH_PREFIX}{"forced":null}\n`);
    await waitFor(() => (opened === 1 ? true : undefined), "the link to be accepted");
    listener.close();
    await waitFor(() => (sock.destroyed ? true : undefined), "the attached link to be closed with the listener");
  });

  it.skipIf(!posix)("reports a service-side close as its own reason, not a finished session (finding #16)", async () => {
    const dir = await sockDir();
    const at = path.join(dir, "attach.sock");
    // A daemon that refuses the link — a pin mismatch, a prologue it will not
    // take — closes the socket while the caller's stdin is still open.
    const listener = startAttachListener({
      path: at,
      onLink: (link) => {
        link.input.resume();
        link.output.destroy();
      },
      log: () => undefined,
    });
    await waitFor(async () => ((await canConnect(at)) ? true : undefined), "the attach socket to answer");
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    const piped = await connectAndPipe(at, null, toServer, fromServer, { timeoutMs: 1000 });
    if (!piped.ok) throw new Error(`connectAndPipe failed: ${piped.reason}`);
    // The peer never ended its side: the daemon hung up first, and the reason
    // says so — what serve-stdio turns into exit 1 instead of exit 0.
    expect(await piped.closed).toBe("closed by the service");
    listener.close();
  });
});

describe("connectAndPipe through a real serve()", () => {
  /** One worker world: a temp state folder with real pins and audit, a root the worker policy grants. */
  async function workerFixture() {
    const stateDir = await mkdtemp(path.join(tmpdir(), "mesh-attach-serve-"));
    fixtures.push(stateDir);
    const root = await mkdtemp(path.join(tmpdir(), "mesh-attach-root-"));
    fixtures.push(root);
    const adapter = new FakeAdapter();
    const registry: Pick<HarnessRegistry, "get" | "available"> = {
      get: (id: string) => (id === "fake" ? adapter : undefined),
      available: async (id: string) => id === "fake",
    };
    const mesh: MeshConfig = { enabled: true, policies: { worker: { roots: [root], harnesses: ["fake"] } } };
    return { stateDir, root, adapter, registry, mesh };
  }

  /** One client end piped through connectAndPipe, as an RpcPeer over the CLI's stdin/stdout. */
  async function pipeClient(at: string, forced: AttachForced): Promise<{ client: RpcPeer; closed: Promise<string> }> {
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    const piped = await connectAndPipe(at, forced, toServer, fromServer, { timeoutMs: 1000 });
    if (!piped.ok) throw new Error(`connectAndPipe failed: ${piped.reason}`);
    const client = new RpcPeer(fromServer, toServer, { role: "client" });
    client.start();
    return { client, closed: piped.closed };
  }

  it.skipIf(!posix)("round-trips a handshake and peer.ping through the socket", async () => {
    const f = await workerFixture();
    const dir = await sockDir();
    const at = path.join(dir, "attach.sock");
    const serverIdentity = identity();
    const listener = startAttachListener({
      path: at,
      onLink: (link, forced) => {
        const deps: ServeDeps = {
          identity: serverIdentity,
          name: "target-box",
          pins: PinStore(path.join(f.stateDir, "mesh", "pins.json")),
          audit: new AuditLog(path.join(f.stateDir, "mesh", "audit.jsonl"), () => undefined),
          registry: f.registry,
          config: () => f.mesh,
          enabled: () => true,
          home: tmpdir(),
        };
        serve({ input: link.input, output: link.output }, deps);
        expect(forced).toBeNull();
      },
      log: () => undefined,
    });
    await waitFor(async () => ((await canConnect(at)) ? true : undefined), "the attach socket to answer");

    const { client, closed } = await pipeClient(at, null);
    const hs = await clientHandshake(client, { identity: identity(), name: "leader-box", hops: 0, expectedServerKey: serverIdentity.publicKey, tofu: false });
    expect(hs.paired).toBe(false);
    expect(hs.policy).toBe("none");
    await expect(client.request("peer.ping", {})).resolves.toEqual({});
    client.close();
    expect(await closed).toBe("closed");
    listener.close();
  });

  it.skipIf(!posix)("carries the prologue's forced pair into the served link (TOFU pin, forced via)", async () => {
    const f = await workerFixture();
    const dir = await sockDir();
    const at = path.join(dir, "attach.sock");
    const pins = PinStore(path.join(f.stateDir, "mesh", "pins.json"));
    const serverIdentity = identity();
    const listener = startAttachListener({
      path: at,
      onLink: (link, forced) => {
        const deps: ServeDeps = {
          identity: serverIdentity,
          name: "target-box",
          pins,
          audit: new AuditLog(path.join(f.stateDir, "mesh", "audit.jsonl"), () => undefined),
          registry: f.registry,
          config: () => f.mesh,
          enabled: () => true,
          home: tmpdir(),
          ...(forced !== null ? { forced } : {}),
        };
        serve({ input: link.input, output: link.output }, deps);
      },
      log: () => undefined,
    });
    await waitFor(async () => ((await canConnect(at)) ? true : undefined), "the attach socket to answer");

    const { client, closed } = await pipeClient(at, { policy: "worker", peer: "leader-box" });
    const hs = await clientHandshake(client, { identity: identity(), name: "leader-box", hops: 0, expectedServerKey: serverIdentity.publicKey, tofu: false });
    expect(hs.paired).toBe(true);
    expect(hs.policy).toBe("worker");
    const pin = await pins.inboundByName("leader-box");
    expect(pin?.via).toBe("forced");
    expect(pin?.policy).toBe("worker");
    client.close();
    await closed;
    listener.close();
  });

  it.skipIf(!posix)("reports a failed connect instead of piping", async () => {
    const dir = await sockDir();
    const outcome = await connectAndPipe(path.join(dir, "nothing.sock"), null, new PassThrough(), new PassThrough(), { timeoutMs: 500 });
    expect(outcome.ok).toBe(false);
  });
});

describe("the attach daemon (startMeshAttach)", () => {
  it.skipIf(!posix)("serves links with the service's identity and follows the mesh switch", async () => {
    const dir = await sockDir();
    const stateDir = await mkdtemp(path.join(tmpdir(), "mesh-attach-daemon-"));
    fixtures.push(stateDir);
    const at = path.join(dir, "daemon.sock");
    const adapter = new FakeAdapter();
    const registry: Pick<HarnessRegistry, "get" | "available"> = {
      get: (id: string) => (id === "fake" ? adapter : undefined),
      available: async (id: string) => id === "fake",
    };
    const host = new TaskHost({
      chats: new ChatManager(),
      registry,
      workspace: async (cwd: string): Promise<WorkspaceInfo> => ({ id: "w", path: cwd, name: path.basename(cwd) }),
      clock: Date.now,
      log: () => undefined,
      detachedTtlHours: () => 24,
    });
    let on = true;
    const daemon = startMeshAttach({
      env: { AWUI_MESH_SOCKET: at },
      stateDir,
      identity: () => loadOrCreateIdentity(stateDir),
      name: () => "target-box",
      pins: PinStore(path.join(stateDir, "mesh", "pins.json")),
      audit: new AuditLog(path.join(stateDir, "mesh", "audit.jsonl"), () => undefined),
      registry,
      config: () => ({ enabled: true, policies: { worker: { roots: [dir], harnesses: ["fake"] } } }),
      enabled: () => on,
      home: tmpdir(),
      host,
      log: () => undefined,
    });
    await waitFor(async () => ((await canConnect(at)) ? true : undefined), "the daemon's attach socket to answer");

    // The daemon loads its own identity from the state folder; the test reads the same file to pin it.
    const serverIdentity = await loadOrCreateIdentity(stateDir);
    const { client, closed } = await (async () => {
      const toServer = new PassThrough();
      const fromServer = new PassThrough();
      const piped = await connectAndPipe(at, null, toServer, fromServer, { timeoutMs: 1000 });
      if (!piped.ok) throw new Error(`connectAndPipe failed: ${piped.reason}`);
      const client = new RpcPeer(fromServer, toServer, { role: "client" });
      client.start();
      return { client, closed: piped.closed };
    })();
    const hs = await clientHandshake(client, { identity: identity(), name: "leader-box", hops: 0, expectedServerKey: serverIdentity.publicKey, tofu: false });
    expect(hs.serverName).toBe("target-box");
    expect(hs.paired).toBe(false);
    await expect(client.request("peer.ping", {})).resolves.toEqual({});
    client.close();
    expect(await closed).toBe("closed");

    // The mesh switch is polled, not watched: within a couple of ticks the socket is gone.
    on = false;
    await waitFor(async () => ((await canConnect(at)) ? undefined : true), "the attach socket to close once the mesh is off");
    daemon.stop();
  });
});

describe("serve-stdio's attach decision", () => {
  it("plans the default as: try the socket, fall back in-process when there is none", () => {
    expect(planServeStdio({ ephemeral: false, attach: false, canAttach: true })).toEqual({ tryAttach: true, onAttachFailure: "fallback" });
  });

  it("never tries the socket with --ephemeral or on Windows, and refuses instead of falling back with --attach", () => {
    expect(planServeStdio({ ephemeral: true, attach: false, canAttach: true }).tryAttach).toBe(false);
    expect(planServeStdio({ ephemeral: false, attach: false, canAttach: false }).tryAttach).toBe(false);
    expect(planServeStdio({ ephemeral: false, attach: true, canAttach: true })).toEqual({ tryAttach: true, onAttachFailure: "tempfail" });
    expect(planServeStdio({ ephemeral: true, attach: true, canAttach: true }).tryAttach).toBe(false);
  });

  it("writes the fallback note exactly as the spec spells it", () => {
    expect(ATTACH_FALLBACK_NOTE).toBe("awui: mesh: no running awui service, serving this link in-process (tasks end with the link)");
  });

  it("parses its flags strictly, before touching any config", async () => {
    const env = { AWUI_CONFIG_DIR: "" };
    expect(await runServeStdio(["--ephemeral", "--attach"], env)).toBe(2);
    expect(await runServeStdio(["--wat"], env)).toBe(2);
    // The forced form still takes --policy and --peer together.
    expect(await runServeStdio(["--peer", "x"], env)).toBe(2);
  });
});
