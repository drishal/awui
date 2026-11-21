// The mesh's direct TLS transport (P2): node-to-node links that need no SSH
// hop and no container, only a host:port and the pinned key. The wire is raw
// TLS 1.3 carrying the same awui-mesh/1 NDJSON as stdio — deliberately not
// WebSocket framing, because node-to-node needs a byte stream and raw TLS
// keeps one parser (rpc.ts) instead of a second one. Trust never comes from
// the certificate: the client does not verify it at all, and pins the *node
// key* instead; what makes that sound is the channel binding — both sides
// fold this one TLS session's exporter value into the signed handshake
// transcript, so a MITM terminating TLS on both sides, however faithfully it
// relays, signs over a different binding and fails the pin. Every socket that
// has not finished the mesh handshake counts against the unauthenticated
// bounds and dies at the deadline; an authenticated link may idle no longer
// than the spec's patience (a peer's ping keeps it alive).
import { PassThrough, type Readable, type Writable } from "node:stream";
import tls, { type TLSSocket } from "node:tls";
import { parseMeshTlsAddress } from "../user-config.js";

/** The exporter label both sides derive the channel binding from: one string, one session. */
export const TLS_EXPORTER_LABEL = "EXPORTER-awui-mesh/1";
/** How many binding bytes fold into the handshake transcript. */
const BINDING_BYTES = 32;

/** The spec's bounds; every one can be tightened by tests through `limits`. */
const DEFAULT_LIMITS = {
  /** The mesh handshake must complete (TLS included) within this many milliseconds. */
  handshakeDeadlineMs: 10_000,
  /** Concurrent sockets whose mesh handshake has not completed, across every peer. */
  unauthTotal: 16,
  /** The same, per remote IP. */
  unauthPerIp: 4,
  /** New TLS connections per remote IP in any sliding minute; excess is destroyed. */
  connectsPerIpMinute: 30,
  /** An authenticated link with no traffic for this long is closed; ping keeps one alive. */
  idleMs: 10 * 60_000,
};

/** Which bound a test wants to shrink; anything absent keeps its default. */
export interface TlsListenerLimits extends Partial<typeof DEFAULT_LIMITS> {
  /** The clock the per-IP rate window reads; tests may inject one. */
  now?: () => number;
}

/** One accepted TLS link, as the serve loop sees it: the decrypted stream from connect on. */
export interface TlsMeshLink {
  input: Readable;
  output: Writable;
  /**
   * Marks this link's mesh handshake as done: the 10 s deadline lifts and the
   * socket stops counting against the unauthenticated caps. The serve loop
   * calls it when it can see its own handshake state; the listener also
   * detects the client's `peer.auth` line on its own, so a caller that never
   * calls this is still bounded correctly.
   */
  authenticated(): void;
}

export interface TlsListenerOpts {
  host: string;
  port: number;
  /** The dedicated TLS key (PKCS8 PEM) and its certificate, as cert.ts mints them. */
  key: string | Buffer;
  cert: string | Buffer;
  /** One accepted link: TLS is up, the binding is computed, the rest is the caller's (the serve loop). */
  onLink: (link: TlsMeshLink, binding: Buffer, remoteAddress: string) => void;
  limits?: TlsListenerLimits;
  log?: (message: string) => void;
}

export interface TlsListener {
  /** Stops listening and closes every link, authenticated or not. */
  close(): void;
  /** The port actually listening (an ephemeral one when started on port 0), once up; null before. */
  port(): number | null;
}

/**
 * How much pre-auth wire the listener scans for the client's `peer.auth` line
 * before it stops trying: a handshake never needs more, and everything past
 * the preamble bound (64 KiB) plus two short lines is a client the serve
 * loop's own bounds will close anyway.
 */
const AUTH_SCAN_CAP = 64 * 1024;
/** A line longer than this cannot be part of a handshake, so it ends the scan. */
const AUTH_LINE_CAP = 16 * 1024;
/** How many remote IPs keep a rate window: beyond this, stale windows are swept. */
const RATE_IP_CAP = 1024;

export function startTlsListener(opts: TlsListenerOpts): TlsListener {
  const log = opts.log ?? (() => undefined);
  const L = { ...DEFAULT_LIMITS, ...opts.limits };
  const now = L.now ?? Date.now;
  let closing = false;
  let listeningPort: number | null = null;
  const sockets = new Set<TLSSocket>();
  /** Sockets whose mesh handshake has not completed: what the caps and the deadline bound. */
  const unauth = new Set<TLSSocket>();
  /** Connect times per remote IP in the last minute, for the rate bound. */
  const rates = new Map<string, number[]>();

  /** One remote IP's window, pruned of everything older than a minute. */
  const rateWindow = (ip: string): number[] => {
    const fresh: number[] = [];
    for (const at of rates.get(ip) ?? []) if (now() - at < 60_000) fresh.push(at);
    rates.set(ip, fresh);
    return fresh;
  };

  const server = tls.createServer(
    {
      key: opts.key,
      cert: opts.cert,
      // TLS 1.3 only: the channel binding is a TLS 1.3 exporter value, and no
      // older protocol is owed to any peer.
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      handshakeTimeout: L.handshakeDeadlineMs,
    },
    (socket) => {
      if (closing) {
        socket.destroy();
        return;
      }
      const ip = socket.remoteAddress ?? "unknown";
      // The rate bound counts every connection, refused or not: an IP that
      // hammers the port gets nothing for its trouble either way.
      const window = rateWindow(ip);
      if (window.length >= L.connectsPerIpMinute) {
        socket.destroy();
        return;
      }
      window.push(now());
      if (rates.size > RATE_IP_CAP) {
        // Memory bound: a window with nothing left in the last minute is forgotten.
        for (const [key, times] of rates) if (times.every((at) => now() - at >= 60_000)) rates.delete(key);
      }
      let perIp = 0;
      for (const sock of unauth) if ((sock.remoteAddress ?? "unknown") === ip) perIp++;
      if (unauth.size >= L.unauthTotal || perIp >= L.unauthPerIp) {
        socket.destroy();
        return;
      }
      let binding: Buffer;
      try {
        binding = socket.exportKeyingMaterial(BINDING_BYTES, TLS_EXPORTER_LABEL, Buffer.alloc(0));
      } catch (error) {
        log(`a TLS link could not export its binding: ${error instanceof Error ? error.message : String(error)}`);
        socket.destroy();
        return;
      }
      sockets.add(socket);
      unauth.add(socket);

      let authed = false;
      let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      /** What the link reads: the decrypted stream, replayed to the serve loop without loss. */
      const pending = new PassThrough();
      let scanBuf = Buffer.alloc(0);
      let scanned = 0;

      const clearDeadline = (): void => {
        if (deadlineTimer !== null) clearTimeout(deadlineTimer);
        deadlineTimer = null;
      };

      const touchIdle = (): void => {
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => socket.destroy(), L.idleMs);
        idleTimer.unref?.();
      };

      /** The handshake completed (either the serve loop said so, or the client's auth line arrived):
       *  the deadline lifts, the cap slot frees, and only the idle bound remains. */
      const markAuthed = (): void => {
        if (authed) return;
        authed = true;
        unauth.delete(socket);
        clearDeadline();
        scanBuf = Buffer.alloc(0);
        touchIdle();
      };

      /** Pre-auth only: watch complete decrypted lines for the client's peer.auth request. The
       *  serve loop either completes that auth or closes the link within one reply, so seeing the
       *  line is enough to lift the deadline — and a stall mid-line never counts, so an unauthenticated
       *  socket cannot outlive its bounds by writing half a line. */
      const scanForAuth = (chunk: Buffer): void => {
        scanned += chunk.length;
        if (scanned > AUTH_SCAN_CAP) {
          scanBuf = Buffer.alloc(0);
          return;
        }
        scanBuf = Buffer.concat([scanBuf, chunk]);
        for (;;) {
          const nl = scanBuf.indexOf(0x0a);
          if (nl < 0) return;
          const line = scanBuf.subarray(0, nl);
          scanBuf = scanBuf.subarray(nl + 1);
          if (line.length <= AUTH_LINE_CAP) {
            try {
              const message = JSON.parse(line.toString("utf8")) as { method?: unknown };
              if (message !== null && typeof message === "object" && message.method === "peer.auth") markAuthed();
            } catch {
              // Not this listener's to judge: the serve loop's own framing closes what it cannot parse.
            }
          } else {
            scanBuf = Buffer.alloc(0);
            return;
          }
          if (authed) return;
        }
      };

      socket.on("data", (chunk: Buffer) => {
        if (authed) touchIdle();
        else scanForAuth(chunk);
        if (!pending.write(chunk)) {
          // The serve loop is behind: hold the peer rather than buffer without bound.
          socket.pause();
          pending.once("drain", () => {
            if (!closing) socket.resume();
          });
        }
      });
      socket.on("end", () => pending.end());
      socket.on("close", () => {
        sockets.delete(socket);
        unauth.delete(socket);
        clearDeadline();
        if (idleTimer !== null) clearTimeout(idleTimer);
        idleTimer = null;
        pending.end();
      });
      // A TLS error on one link ends that link, never the process.
      socket.on("error", () => socket.destroy());

      // The deadline: a socket that never finishes the mesh handshake is gone
      // in ten seconds, whatever it sent.
      deadlineTimer = setTimeout(() => {
        if (!authed) socket.destroy();
      }, L.handshakeDeadlineMs);
      deadlineTimer.unref?.();

      try {
        opts.onLink({ input: pending, output: socket, authenticated: markAuthed }, binding, ip);
      } catch (error) {
        log(`a TLS link was refused by its handler: ${error instanceof Error ? error.message : String(error)}`);
        socket.destroy();
      }
    },
  );

  // A client that cannot speak TLS 1.3 is refused at the TLS layer; that refusal
  // is this listener's own business, not an error worth crashing or logging for.
  server.on("tlsClientError", (_error, socket) => socket.destroy());
  server.on("error", (error) => {
    if (closing) return;
    log(`the TLS listener failed: ${error.message}`);
    close();
  });

  const close = (): void => {
    if (closing) return;
    closing = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.close(() => undefined);
  };

  server.listen(opts.port, opts.host, () => {
    const at = server.address();
    listeningPort = typeof at === "object" && at !== null ? at.port : opts.port;
    log(`listening on ${opts.host}:${listeningPort}`);
  });

  return {
    close,
    port: () => listeningPort,
  };
}

export interface ConnectTlsOpts {
  /** Connecting and finishing TLS within this many milliseconds (default 10 s). */
  timeoutMs?: number;
}

/** One live TLS link to a peer's listener, with the binding its handshake will fold in. */
export interface TlsConnect {
  /** The TLS socket: it is both the input and the output of the wire protocol. */
  link: TLSSocket;
  binding: Buffer;
}

/**
 * Dials one peer's TLS listener. The certificate is never verified — not with
 * a CA, not with a hostname check — because it is not the trust: the pinned
 * node key signs the handshake, and the exporter binding makes that
 * signature worthless to anyone relaying between two sessions. The returned
 * binding is what clientHandshake's `binding` wants.
 */
export function connectTls(address: string, opts: ConnectTlsOpts = {}): Promise<TlsConnect> {
  const at = parseMeshTlsAddress(address);
  if (at === null) return Promise.reject(new Error(`"${address}" is not a host:port the mesh can dial`));
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      host: at.host,
      port: at.port,
      minVersion: "TLSv1.3",
      maxVersion: "TLSv1.3",
      rejectUnauthorized: false,
      // SNI for a named host; an IP literal gets none (there is no name to send).
      ...(/^[0-9.]+$/.test(at.host) || at.host.includes(":") ? {} : { servername: at.host }),
    });
    let done = false;
    const finish = (settle: () => void): void => {
      done = true;
      clearTimeout(timer);
      settle();
    };
    const timer = setTimeout(() => {
      if (!done) {
        socket.destroy();
        finish(() => reject(new Error(`connecting to ${address} timed out after ${timeoutMs} ms`)));
      }
    }, timeoutMs);
    timer.unref?.();
    socket.once("secureConnect", () => {
      try {
        const binding = socket.exportKeyingMaterial(BINDING_BYTES, TLS_EXPORTER_LABEL, Buffer.alloc(0));
        finish(() => resolve({ link: socket, binding }));
      } catch (error) {
        socket.destroy();
        finish(() => reject(error instanceof Error ? error : new Error(String(error))));
      }
    });
    socket.once("error", (error: Error) => {
      if (!done) {
        socket.destroy();
        finish(() => reject(new Error(`the TLS link to ${address} failed: ${error.message}`)));
      }
    });
    socket.once("close", () => {
      if (!done) finish(() => reject(new Error(`the TLS link to ${address} closed before TLS came up`)));
    });
  });
}
