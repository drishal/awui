// The mesh's direct TLS transport (P2): a real TLS 1.3 listener running the
// real serve() loop, dialed by a real client, with real identities, pins, and
// audit in temp state folders. What these tests must show, in order: the
// hand-encoded certificate parses and verifies under Node itself; a link
// completes the signed handshake with the channel binding folded in and
// answers ping; a MITM that terminates TLS on both sides cannot satisfy the
// pin because its two sessions bind differently; a TLS 1.2 client is refused;
// and the listener's bounds — handshake deadline, per-IP and global caps,
// connection rate, idle timeout — bite at small injected values.
import { mkdir, stat, writeFile } from "node:fs/promises";
import { generateKeyPairSync, X509Certificate } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import tls, { type TLSSocket } from "node:tls";
import { describe, expect, it } from "vitest";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { AuditLog } from "../../src/server/mesh/audit.js";
import { buildSelfSignedCert, ensureTlsCertificate, loadOrCreateTlsKey, tlsCertFileOf, tlsKeyFileOf } from "../../src/server/mesh/cert.js";
import { clientHandshake } from "../../src/server/mesh/handshake.js";
import { nodeIdOf, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { PeerManager } from "../../src/server/mesh/manager.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { serve, type ServeDeps } from "../../src/server/mesh/serve.js";
import { connectTls, startTlsListener } from "../../src/server/mesh/tls.js";
import type { MeshConfig } from "../../src/server/user-config.js";
import { tempDir } from "../helpers/app.js";

/** A fresh in-memory identity, the shape loadOrCreateIdentity returns. */
function identity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
  return { publicKey: raw, privateKey, nodeId: nodeIdOf(raw) };
}

/** One worker behind a live TLS listener: real serve(), real pins and audit, the fake harness. */
interface Worker {
  port: number;
  identity: NodeIdentity;
  pins: PinStore;
  close(): void;
}

/** The serve loop every accepted socket runs, with the listener's binding folded into its handshake. */
async function startWorker(opts: { limits?: Parameters<typeof startTlsListener>[0]["limits"] } = {}): Promise<Worker> {
  const stateDir = tempDir("awui-mesh-tls-state-");
  const who = identity();
  const pins = PinStore(path.join(stateDir, "mesh", "pins.json"));
  const audit = new AuditLog(path.join(stateDir, "mesh", "audit.jsonl"), () => undefined);
  const adapter = new FakeAdapter({ chunkDelayMs: 1 });
  const mesh: MeshConfig = { enabled: true };
  const deps: ServeDeps = {
    identity: who,
    name: "target-box",
    pins,
    audit,
    registry: {
      get: (id: string) => (id === "fake" ? adapter : undefined),
      available: async (id: string) => id === "fake",
    },
    config: () => mesh,
    enabled: () => true,
    home: tmpdir(),
  };
  const material = await ensureTlsCertificate(stateDir);
  const listener = startTlsListener({
    host: "127.0.0.1",
    port: 0,
    key: material.keyPem,
    cert: material.cert,
    limits: opts.limits,
    log: () => undefined,
    onLink: (link, binding) => {
      // Wired the way the daemon wires a real TLS link: the listener's unpaired bounds lift when the serve loop resolves the caller as paired.
      serve({ input: link.input, output: link.output }, { ...deps, binding, linkPaired: link.paired });
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      const at = listener.port();
      if (at !== null) resolve(at);
      else if (Date.now() - started > 3000) reject(new Error("the TLS listener never came up"));
      else setTimeout(tick, 10);
    };
    tick();
  });
  return { port, identity: who, pins, close: () => listener.close() };
}

/** Dials the worker, runs the client handshake with the session's binding, and returns the live link. */
async function dial(port: number, who: NodeIdentity, pin: Buffer): Promise<{ rpc: RpcPeer; link: TLSSocket; binding: Buffer }> {
  const { link, binding } = await connectTls(`127.0.0.1:${port}`);
  const rpc = new RpcPeer(link, link, { role: "client" });
  rpc.start();
  await clientHandshake(rpc, { identity: who, name: "leader-box", hops: 0, expectedServerKey: pin, tofu: false, binding });
  return { rpc, link, binding };
}

/**
 * Resolves once the socket closes, or rejects if it is still up after `within`
 * ms. The socket is drained first: a stream nobody reads never surfaces the
 * peer's EOF, and a real client (the RpcPeer) always reads.
 */
function closedWithin(socket: TLSSocket, within: number): Promise<void> {
  socket.resume();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the link was still open after ${within} ms`)), within);
    socket.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** A settled link: read from, then destroyed, so the far side really saw it. */
async function hangUp(link: TLSSocket): Promise<void> {
  link.on("data", () => undefined);
  await new Promise((resolve) => setTimeout(resolve, 80));
  link.destroy();
}

/** A TLS MITM: terminates TLS on both sides and relays the plaintext NDJSON between them. */
async function startMitm(targetPort: number): Promise<{ port: number; close(): void }> {
  const material = await ensureTlsCertificate(tempDir("awui-mesh-tls-mitm-"));
  const server = tls.createServer({ key: material.keyPem, cert: material.cert, minVersion: "TLSv1.3", maxVersion: "TLSv1.3" }, (clientSide) => {
    const upstream = tls.connect({ host: "127.0.0.1", port: targetPort, minVersion: "TLSv1.3", maxVersion: "TLSv1.3", rejectUnauthorized: false });
    clientSide.pipe(upstream);
    upstream.pipe(clientSide);
    clientSide.on("error", () => upstream.destroy());
    upstream.on("error", () => clientSide.destroy());
  });
  server.on("tlsClientError", (_error, socket) => socket.destroy());
  server.listen(0, "127.0.0.1");
  const port = await new Promise<number>((resolve, reject) => {
    server.once("listening", () => {
      const address = server.address();
      if (typeof address === "object" && address !== null) resolve(address.port);
      else reject(new Error("the MITM listener never came up"));
    });
  });
  return {
    port,
    close: () => server.close(() => undefined),
  };
}

describe("the certificate", () => {
  it("parses under Node, verifies against its own key, and is reused while it is fresh", async () => {
    const dir = tempDir("awui-mesh-tls-cert-");
    const first = await ensureTlsCertificate(dir);
    const cert = new X509Certificate(first.cert);
    expect(cert.subject).toContain("awui-mesh");
    expect(cert.issuer).toContain("awui-mesh");
    expect(cert.verify(cert.publicKey)).toBe(true);
    expect(Date.parse(cert.validTo) - Date.now()).toBeGreaterThan(800 * 24 * 3600 * 1000);
    // A second call serves the stored certificate, not a new one.
    expect((await ensureTlsCertificate(dir)).cert).toBe(first.cert);
    if (process.platform !== "win32") {
      expect((await stat(tlsKeyFileOf(dir))).mode & 0o777).toBe(0o600);
      expect((await stat(tlsCertFileOf(dir))).mode & 0o777).toBe(0o600);
    }
  });

  it("regenerates a certificate with less than 30 days left", async () => {
    const dir = tempDir("awui-mesh-tls-cert-");
    await ensureTlsCertificate(dir);
    const { key } = await loadOrCreateTlsKey(dir);
    // Hand-minted with the same key but expiring inside the renewal window.
    const short = buildSelfSignedCert(key, { notAfter: new Date(Date.now() + 20 * 24 * 3600 * 1000) });
    await writeFile(tlsCertFileOf(dir), short);
    const renewed = await ensureTlsCertificate(dir);
    expect(renewed.cert).not.toBe(short);
    expect(Date.parse(new X509Certificate(renewed.cert).validTo) - Date.now()).toBeGreaterThan(800 * 24 * 3600 * 1000);
  });

  it("refuses to serve from a TLS key file that is not a key", async () => {
    const dir = tempDir("awui-mesh-tls-cert-");
    await mkdir(path.dirname(tlsKeyFileOf(dir)), { recursive: true });
    await writeFile(tlsKeyFileOf(dir), "not a key at all\n");
    await expect(ensureTlsCertificate(dir)).rejects.toThrow(/tls-key\.pem.*invalid/);
  });
});

describe("a TLS link", () => {
  it("completes the signed handshake with the binding folded in, and answers ping", async () => {
    const worker = await startWorker();
    const who = identity();
    const end = await dial(worker.port, who, worker.identity.publicKey);
    expect(end.binding.length).toBe(32);
    expect(await end.rpc.request("peer.ping", {})).toEqual({});
    // The binding is per session: a second link to the same listener derives a different one.
    const other = await dial(worker.port, identity(), worker.identity.publicKey);
    expect(other.binding.equals(end.binding)).toBe(false);
    end.rpc.close();
    other.rpc.close();
    worker.close();
  });

  it("reaches a worker through the manager as a tls peer", async () => {
    const worker = await startWorker();
    const leader = identity();
    await worker.pins.setInbound(leader.publicKey, "leader-box", "worker", "accept");
    const leaderPins = PinStore(path.join(tempDir("awui-mesh-tls-lp-"), "pins.json"));
    await leaderPins.setOutbound("lab", worker.identity.publicKey);
    const manager = new PeerManager({
      identity: async () => leader,
      pins: leaderPins,
      config: () => ({ enabled: true, peers: [{ name: "lab", tls: `127.0.0.1:${worker.port}` }] }),
      enabled: () => true,
      localName: () => "leader-box",
      log: () => undefined,
    });
    const connection = await manager.connect("lab");
    expect(await connection.rpc.request("peer.ping", {})).toEqual({});
    expect(manager.peers().find((peer) => peer.name === "lab")).toMatchObject({ kind: "tls", pinned: true });
    connection.close();
    worker.close();
  });

  it("refuses a MITM that terminates TLS on both sides: the binding differs per session", async () => {
    const worker = await startWorker();
    const mitm = await startMitm(worker.port);
    const who = identity();
    const { link } = await connectTls(`127.0.0.1:${mitm.port}`);
    const rpc = new RpcPeer(link, link, { role: "client" });
    rpc.start();
    // The relayed hello reply carries the true worker key, so the pin would
    // pass — but its signature covers the TARGET's binding, not this one's,
    // and the verification fails before any auth leaves this side.
    const error = await clientHandshake(rpc, {
      identity: who,
      name: "leader-box",
      hops: 0,
      expectedServerKey: worker.identity.publicKey,
      tofu: false,
      binding: link.exportKeyingMaterial(32, "EXPORTER-awui-mesh/1", Buffer.alloc(0)),
    }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error).toBeInstanceOf(MeshRpcError);
    expect(error.code).toBe(MeshErrorCode.invalid_request);
    rpc.close("mitm rejected");
    mitm.close();
    worker.close();
  });

  it("refuses a client that speaks only TLS 1.2", async () => {
    const worker = await startWorker();
    const refused = await new Promise<boolean>((resolve) => {
      const socket = tls.connect({ host: "127.0.0.1", port: worker.port, minVersion: "TLSv1.2", maxVersion: "TLSv1.2", rejectUnauthorized: false });
      let settled = false;
      const say = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.once("secureConnect", () => say(false));
      socket.once("error", () => say(true));
      socket.once("close", () => say(true));
      setTimeout(() => say(true), 3000);
    });
    expect(refused).toBe(true);
    worker.close();
  });

  it("refuses an address that is not a host:port", async () => {
    await expect(connectTls("not an address")).rejects.toThrow(/host:port/);
  });
});

describe("the listener's bounds", () => {
  it("closes a socket that never finishes the mesh handshake", async () => {
    const worker = await startWorker({ limits: { handshakeDeadlineMs: 250 } });
    const { link } = await connectTls(`127.0.0.1:${worker.port}`);
    await closedWithin(link, 4000);
    worker.close();
  });

  it("keeps a link that finished its handshake past the deadline", async () => {
    const worker = await startWorker({ limits: { handshakeDeadlineMs: 300, idleMs: 60_000 } });
    const end = await dial(worker.port, identity(), worker.identity.publicKey);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(await end.rpc.request("peer.ping", {})).toEqual({});
    end.rpc.close();
    worker.close();
  });

  it("bounds unauthenticated sockets per remote IP", async () => {
    const worker = await startWorker({ limits: { unauthPerIp: 2, unauthTotal: 16, connectsPerIpMinute: 1000, handshakeDeadlineMs: 60_000 } });
    const held: TLSSocket[] = [];
    for (let i = 0; i < 2; i++) held.push((await connectTls(`127.0.0.1:${worker.port}`)).link);
    // The third from this same IP never gets past the cap.
    const third = await connectTls(`127.0.0.1:${worker.port}`).then(
      ({ link }) =>
        new Promise<string>((resolve) => {
          link.once("close", () => resolve("closed"));
          setTimeout(() => resolve("still up"), 3000);
        }),
      () => "refused",
    );
    expect(["refused", "closed"]).toContain(third);
    for (const link of held) link.destroy();
    worker.close();
  });

  it("bounds unauthenticated sockets overall", async () => {
    const worker = await startWorker({ limits: { unauthPerIp: 16, unauthTotal: 2, connectsPerIpMinute: 1000, handshakeDeadlineMs: 60_000 } });
    const held: TLSSocket[] = [];
    for (let i = 0; i < 2; i++) held.push((await connectTls(`127.0.0.1:${worker.port}`)).link);
    const third = await connectTls(`127.0.0.1:${worker.port}`).then(
      ({ link }) =>
        new Promise<string>((resolve) => {
          link.once("close", () => resolve("closed"));
          setTimeout(() => resolve("still up"), 3000);
        }),
      () => "refused",
    );
    expect(["refused", "closed"]).toContain(third);
    for (const link of held) link.destroy();
    worker.close();
  });

  it("bounds new connections per remote IP per minute", async () => {
    const worker = await startWorker({ limits: { connectsPerIpMinute: 2, unauthPerIp: 16, unauthTotal: 16, handshakeDeadlineMs: 60_000 } });
    for (let i = 0; i < 2; i++) await hangUp((await connectTls(`127.0.0.1:${worker.port}`)).link);
    // Closing a link does not buy back rate: the window counts connections, not live ones.
    const third = await connectTls(`127.0.0.1:${worker.port}`).then(
      ({ link }) =>
        new Promise<string>((resolve) => {
          link.once("close", () => resolve("closed"));
          setTimeout(() => resolve("still up"), 3000);
        }),
      () => "refused",
    );
    expect(["refused", "closed"]).toContain(third);
    worker.close();
  });

  it("closes an authenticated link once it idles, and a ping keeps it alive", async () => {
    const worker = await startWorker({ limits: { idleMs: 250, handshakeDeadlineMs: 60_000 } });
    const end = await dial(worker.port, identity(), worker.identity.publicKey);
    // Traffic every 100 ms never reaches the 250 ms idle bound.
    for (let i = 0; i < 6; i++) {
      expect(await end.rpc.request("peer.ping", {})).toEqual({});
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // Silence does.
    await closedWithin(end.link, 4000);
    worker.close();
  });

  it("counts the target's own writes as traffic: a link that only streams is never idle (finding #3)", async () => {
    const material = await ensureTlsCertificate(tempDir("awui-mesh-tls-out-"));
    let writes: ReturnType<typeof setInterval> | null = null;
    const listener = startTlsListener({
      host: "127.0.0.1",
      port: 0,
      key: material.keyPem,
      cert: material.cert,
      // The grace and the deadline stay out of the way: this is about the idle bound.
      limits: { idleMs: 250, unpairedGraceMs: 60_000, handshakeDeadlineMs: 60_000 },
      log: () => undefined,
      onLink: (link) => {
        // This "worker" only writes: after the client's auth line, one frame
        // every 100 ms and never a byte of its own read.
        link.input.resume();
        link.input.on("data", (chunk: Buffer) => {
          if (!chunk.toString().includes("peer.auth")) return;
          writes = setInterval(() => link.output.write('{"jsonrpc":"2.0","id":1,"result":{}}\n'), 100);
          writes.unref();
        });
      },
    });
    const port = await new Promise<number>((resolve, reject) => {
      const started = Date.now();
      const tick = (): void => {
        const at = listener.port();
        if (at !== null) resolve(at);
        else if (Date.now() - started > 3000) reject(new Error("the TLS listener never came up"));
        else setTimeout(tick, 10);
      };
      tick();
    });
    const { link } = await connectTls(`127.0.0.1:${port}`);
    link.write('{"jsonrpc":"2.0","id":1,"method":"peer.auth","params":{}}\n');
    link.resume();
    // The target writes every 100 ms for 1.5 s: the 250 ms idle bound — which
    // before the fix counted only this side's bytes — never fires.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(link.destroyed).toBe(false);
    // The writes stop, and the silence does what streaming could not.
    clearInterval(writes!);
    await closedWithin(link, 4000);
    listener.close();
  });

  it("closes an authenticated link that never pairs after its grace, ping or no ping (finding #14)", async () => {
    const worker = await startWorker({ limits: { idleMs: 60_000, unpairedGraceMs: 400, handshakeDeadlineMs: 60_000 } });
    const end = await dial(worker.port, identity(), worker.identity.publicKey);
    // The handshake completed but this caller was never accepted: pings would
    // keep the idle bound fed forever, and the one-shot grace is what ends it.
    const pinger = setInterval(() => {
      void end.rpc.request("peer.ping", {}).catch(() => undefined);
    }, 100);
    pinger.unref();
    await closedWithin(end.link, 5000);
    clearInterval(pinger);
    // A paired link carries no grace: the same window passes and it stays up.
    const who = identity();
    await worker.pins.setInbound(who.publicKey, "leader-box", "worker", "accept");
    const paired = await dial(worker.port, who, worker.identity.publicKey);
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(await paired.rpc.request("peer.ping", {})).toEqual({});
    paired.rpc.close();
    worker.close();
  });

  it("bounds concurrent unpaired authenticated links per remote IP (finding #14)", async () => {
    const worker = await startWorker({ limits: { unpairedPerIp: 2, unpairedTotal: 16, unpairedGraceMs: 60_000, connectsPerIpMinute: 1000, handshakeDeadlineMs: 60_000 } });
    // Two unpaired-but-authenticated links from this IP are fine …
    const held: TLSSocket[] = [];
    for (let i = 0; i < 2; i++) held.push((await dial(worker.port, identity(), worker.identity.publicKey)).link);
    // … the third cannot even finish its handshake: the auth line is what
    // would take the third unpaired slot, and the listener closes it there.
    const third = await dial(worker.port, identity(), worker.identity.publicKey).then(
      () => {
        throw new Error("expected the third unpaired link to be refused");
      },
      () => "refused" as const,
    );
    expect(third).toBe("refused");
    for (const link of held) link.destroy();
    worker.close();
  });

  it("the leader pings a busy shared link, keeping it past the target's idle bound (finding #3)", async () => {
    const worker = await startWorker({ limits: { idleMs: 300, handshakeDeadlineMs: 60_000 } });
    const leader = identity();
    await worker.pins.setInbound(leader.publicKey, "leader-box", "worker", "accept");
    const leaderPins = PinStore(path.join(tempDir("awui-mesh-tls-ka-"), "pins.json"));
    await leaderPins.setOutbound("lab", worker.identity.publicKey);
    const manager = new PeerManager({
      identity: async () => leader,
      pins: leaderPins,
      config: () => ({ enabled: true, peers: [{ name: "lab", tls: `127.0.0.1:${worker.port}` }] }),
      enabled: () => true,
      localName: () => "leader-box",
      keepaliveMs: 150,
      log: () => undefined,
    });
    const connection = await manager.connect("lab");
    // A task listening on the link is what makes it busy: nothing else is sent
    // for well past the 300 ms idle bound — only the keepalive pings.
    const off = connection.onTaskEvent("rt_probe", () => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(connection.closed).toBe(false);
    // The listener gone, the link is no longer busy: the pings stop, and the
    // target's idle bound takes the link back.
    off();
    await connection.rpc.closed;
    expect(connection.closed).toBe(true);
    worker.close();
  });
});
