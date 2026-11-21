// The mesh attach socket (P1.5): the target end of a peer link can be the
// already-running awui service instead of a fresh `serve-stdio` process, so a
// peer's tasks outlive the SSH session that carried them. This module is only
// the plumbing: where the socket lives (socketPath), the listener that vets
// one short prologue line before handing the stream to the P1 serve loop
// (startAttachListener), the client half that connects and pipes
// (connectAndPipe), and serve-stdio's attach/fallback decision
// (planServeStdio). The trust argument is narrow and worth spelling out: only
// this uid can open the socket (0600, in a 0700 directory), and this uid could
// already edit pins.json or run the CLI, so the prologue is trusted exactly as
// much as the command line is — everything after it is the ordinary signed
// mesh handshake, which is where any other bytes are actually judged.
import { promises as fs, type Stats } from "node:fs";
import net from "node:net";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

/** The first line an attaching client writes: `AWUI-MESH-ATTACH/1 <json>\n`. */
export const ATTACH_PREFIX = "AWUI-MESH-ATTACH/1 ";
const ATTACH_PREFIX_BYTES = Buffer.from(ATTACH_PREFIX, "utf8");
/** The whole prologue line's bound: a policy name and a peer name never come near it. */
const MAX_PROLOGUE_BYTES = 4096;

/** Peer and policy names exactly as serve.ts and the handshake spell them. */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const POLICY_RE = /^[a-z0-9_-]{1,32}$/;

/** The prologue's one json document: the authorized_keys forced pair, or null. Strict, so nothing extra rides along. */
const prologueSchema = z.object({
  forced: z.object({ policy: z.string().regex(POLICY_RE), peer: z.string().regex(NAME_RE) }).nullable(),
}).strict();

/** The forced pair a prologue may carry, exactly the shape serve() takes as `forced`. */
export type AttachForced = { policy: string; peer: string } | null;

/** One parsed prologue: `forced: null` is a valid answer, so failure is its own shape. */
type Prologue = { ok: true; forced: AttachForced } | { ok: false };

/** Strict parse of one complete prologue line (without its newline): exact prefix, bounded, valid json, no extra keys. */
function parsePrologue(line: Buffer): Prologue {
  if (line.length > MAX_PROLOGUE_BYTES || !line.subarray(0, ATTACH_PREFIX_BYTES.length).equals(ATTACH_PREFIX_BYTES)) return { ok: false };
  let doc: unknown;
  try {
    doc = JSON.parse(line.subarray(ATTACH_PREFIX_BYTES.length).toString("utf8"));
  } catch {
    return { ok: false };
  }
  const parsed = prologueSchema.safeParse(doc);
  return parsed.success ? { ok: true, forced: parsed.data.forced } : { ok: false };
}

/**
 * Where the attach socket lives. `$XDG_RUNTIME_DIR/awui-mesh.sock` when that
 * directory is genuinely this user's runtime dir (a directory, owned by this
 * uid, mode 0700) — anything looser or foreign falls back to the state
 * folder's `mesh/attach.sock`, created 0700. `AWUI_MESH_SOCKET` overrides both
 * (tests, or a machine that wants the socket elsewhere); whoever listens still
 * tightens the directory the socket lands in.
 */
export async function socketPath(env: NodeJS.ProcessEnv, stateDir: string): Promise<string> {
  const override = env["AWUI_MESH_SOCKET"];
  if (override !== undefined && override !== "") return override;
  const runtime = env["XDG_RUNTIME_DIR"];
  if (runtime !== undefined && runtime !== "") {
    try {
      const st = await fs.stat(runtime);
      // The spec's three checks, all of them: a directory this uid owns at 0700. A runtime
      // dir that is looser or belongs to someone else is not this node's to serve from.
      if (st.isDirectory() && (typeof process.getuid !== "function" || st.uid === process.getuid()) && (st.mode & 0o777) === 0o700) {
        return path.join(runtime, "awui-mesh.sock");
      }
    } catch {
      // Not there or not stat-able: the state folder below is the answer.
    }
  }
  const dir = path.join(stateDir, "mesh");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(dir, 0o700);
  return path.join(dir, "attach.sock");
}

export interface AttachLink {
  /** The client's bytes from the end of its prologue on; reads begin where the prologue ended. */
  input: Readable;
  /** Where the link's protocol output goes; ending it closes the link's writable half. */
  output: Writable;
}

export interface AttachListenerOpts {
  path: string;
  /** One accepted link: the prologue has validated, and the rest of the stream is the caller's (the P1 serve loop). */
  onLink: (link: AttachLink, forced: AttachForced) => void;
  log?: (message: string) => void;
}

export interface AttachListener {
  /** Stops listening, removes the socket file, and closes every attached link. */
  close(): void;
}

/** Whether something currently answers connections at this path (a live listener). */
function answers(at: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createConnection(at);
    const done = (ok: boolean): void => {
      probe.destroy();
      resolve(ok);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
    probe.once("close", () => done(false));
  });
}

/**
 * Serves the attach socket: vet the one prologue line, then hand the stream to
 * `onLink`. A stale socket file (a crashed listener's leftovers) is probed and
 * unlinked; a file that is not a socket, or a socket another awui answers, is
 * a refusal — mesh attach stays off rather than touching what it does not
 * own. The socket ends up 0600 in a 0700 directory: only this uid may open it,
 * which is the whole trust basis of the prologue. Windows never attaches
 * (peers there get ephemeral links only).
 */
export function startAttachListener(opts: AttachListenerOpts): AttachListener {
  const log = opts.log ?? (() => undefined);
  let listening = false;
  let closing = false;
  const links = new Set<net.Socket>();

  /** One connection: collect the prologue line, then forward every later byte untouched. */
  const handleConn = (sock: net.Socket): void => {
    if (closing) {
      sock.destroy();
      return;
    }
    links.add(sock);
    let input: PassThrough | null = null;
    let buffered: Buffer = Buffer.alloc(0);
    let done = false;
    /** The link's end, seen from the socket side: idempotent, and the serve loop's input always ends exactly once. */
    const finish = (): void => {
      if (done) return;
      done = true;
      input?.end();
    };
    const forward = (chunk: Buffer): void => {
      if (done || input === null) return;
      if (!input.write(chunk)) {
        // The serve loop is behind (or not started yet): hold the client rather than buffer without bound.
        sock.pause();
        input.once("drain", () => {
          if (!done) sock.resume();
        });
      }
    };
    const onData = (chunk: Buffer): void => {
      if (done) return;
      if (input !== null) {
        forward(chunk);
        return;
      }
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      const nl = buffered.indexOf(0x0a);
      if (nl < 0) {
        // Close early when these bytes can never become the prefix, and never hold more than the bound.
        if (buffered.length <= ATTACH_PREFIX_BYTES.length) {
          if (!ATTACH_PREFIX_BYTES.subarray(0, buffered.length).equals(buffered)) {
            done = true;
            sock.destroy();
          }
          return;
        }
        if (buffered.length > MAX_PROLOGUE_BYTES) {
          done = true;
          sock.destroy();
        }
        return;
      }
      const line = buffered.subarray(0, nl);
      const rest = buffered.subarray(nl + 1);
      const prologue = parsePrologue(line);
      if (!prologue.ok) {
        // Anything else → close: the stream has already misbehaved, so nothing more is read from it.
        done = true;
        sock.destroy();
        return;
      }
      input = new PassThrough();
      sock.removeListener("data", onData);
      sock.on("data", forward);
      // The client finished writing → the serve loop sees eof; the socket dying → the link's input ends too.
      sock.on("end", finish);
      sock.on("close", () => {
        links.delete(sock);
        finish();
      });
      sock.on("error", () => {
        links.delete(sock);
        finish();
        sock.destroy();
      });
      try {
        opts.onLink({ input, output: sock }, prologue.forced);
      } catch (error) {
        log(`an attached link was refused by its handler: ${error instanceof Error ? error.message : String(error)}`);
        done = true;
        sock.destroy();
        return;
      }
      // The client may have pipelined protocol bytes behind its prologue; they are already here.
      if (rest.length > 0) forward(rest);
    };
    sock.on("data", onData);
  };

  const server = net.createServer((sock) => handleConn(sock));
  const close = (): void => {
    if (closing) return;
    closing = true;
    for (const sock of links) sock.destroy();
    links.clear();
    server.close(() => undefined);
    // Only a file this listener created is ever removed: a refused path (a regular file, another awui's socket) stays as it is.
    if (listening) void fs.unlink(opts.path).catch(() => undefined);
  };
  server.on("error", (error) => {
    if (closing) return;
    log(`the attach socket failed: ${error.message}`);
    close();
  });
  if (process.platform === "win32") {
    log("no attach listener on Windows; peers get ephemeral links only");
    return { close };
  }
  void (async () => {
    try {
      // The directory the socket lands in is this uid's alone: it exists, and it is 0700.
      const dir = path.dirname(opts.path);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700);
      let existing: Stats | null = null;
      try {
        existing = await fs.lstat(opts.path);
      } catch {
        existing = null;
      }
      if (existing !== null) {
        if (!existing.isSocket()) {
          log(`refusing to listen: ${opts.path} exists and is not a socket; mesh attach stays off`);
          return;
        }
        if (await answers(opts.path)) {
          log(`refusing to listen: another awui already serves ${opts.path}`);
          return;
        }
        // A socket nobody answers is a crashed listener's leftovers: safe to take over.
        await fs.unlink(opts.path).catch(() => undefined);
      }
      if (closing) return;
      await new Promise<void>((resolve) => {
        server.listen(opts.path, () => resolve());
      });
      if (closing) {
        // close() ran while the socket was coming up; remove the file it never saw.
        void fs.unlink(opts.path).catch(() => undefined);
        return;
      }
      listening = true;
      await fs.chmod(opts.path, 0o600);
      log(`listening on ${opts.path}`);
    } catch (error) {
      if (!closing) log(`the attach listener could not start: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
  return { close };
}

export interface ConnectPipeOpts {
  /** How long to wait for the service's socket to answer before giving up on it. */
  timeoutMs?: number;
}

/** What connectAndPipe found: a live link to pipe, or why there is nothing to attach to. */
export type AttachConnect = { ok: true; closed: Promise<string> } | { ok: false; reason: string };

/**
 * The client half of attach: connect, write the one prologue line, then pipe
 * `stdin` into the socket and the socket into `stdout`, byte-for-byte, until
 * either side ends. `closed` resolves once with the link's end reason —
 * "closed" for a clean end after the peer's own input ended, "closed by the
 * service" when the daemon hung up first (a refused prologue or handshake),
 * anything else a socket error the caller reports.
 */
export function connectAndPipe(
  at: string,
  forced: AttachForced,
  stdin: Readable,
  stdout: Writable,
  opts: ConnectPipeOpts = {},
): Promise<AttachConnect> {
  if (process.platform === "win32") return Promise.resolve({ ok: false, reason: "no attach socket on Windows" });
  return new Promise((resolve) => {
    const sock = net.createConnection(at);
    let piped = false;
    let inputEnded = false;
    let finish: ((reason: string) => void) | null = null;
    const timer = setTimeout(() => {
      if (piped) return;
      sock.destroy();
      resolve({ ok: false, reason: `connecting to ${at} timed out` });
    }, opts.timeoutMs ?? 1000);
    timer.unref?.();
    sock.on("error", (error) => {
      if (!piped) {
        clearTimeout(timer);
        sock.destroy();
        resolve({ ok: false, reason: `socket error: ${error.message}` });
      } else if (finish !== null) finish(`error: ${error.message}`);
    });
    sock.on("close", () => {
      if (!piped) {
        clearTimeout(timer);
        resolve({ ok: false, reason: "the socket closed before the link came up" });
      } else if (finish !== null) {
        // Finding #16 (P15R #9): a link the *service* closed — a refused
        // prologue, a pin mismatch at the handshake — is not a finished
        // session, and the caller could not tell the two apart. The peer's
        // own stdin ending first is what a clean close looks like; anything
        // else resolves with its own reason, so serve-stdio exits 1.
        finish(inputEnded ? "closed" : "closed by the service");
      }
    });
    sock.once("connect", () => {
      piped = true;
      clearTimeout(timer);
      // The one prologue line, then nothing but protocol bytes in both directions.
      sock.write(`${ATTACH_PREFIX}${JSON.stringify({ forced })}\n`);
      stdin.pipe(sock);
      sock.pipe(stdout);
      stdin.once("end", () => {
        inputEnded = true;
      });
      stdin.once("close", () => {
        inputEnded = true;
      });
      const closed = new Promise<string>((resolveClosed) => {
        let ended = false;
        finish = (reason: string): void => {
          if (ended) return;
          ended = true;
          resolveClosed(reason);
        };
      });
      resolve({ ok: true, closed });
    });
  });
}

/** The one fallback line the spec spells exactly; serve-stdio writes it to stderr and then serves in-process. */
export const ATTACH_FALLBACK_NOTE = "awui: mesh: no running awui service, serving this link in-process (tasks end with the link)";

export interface ServeStdioPlan {
  /** Try the attach socket of a running service before serving in-process. */
  tryAttach: boolean;
  /** What a failed attach attempt means: fall back to the in-process serve, or refuse (exit 75, --attach). */
  onAttachFailure: "fallback" | "tempfail";
}

/**
 * serve-stdio's attach decision, factored out so it can be judged without a
 * process: --ephemeral never tries the socket, --attach makes a missing
 * service an error instead of a fallback, and Windows never attaches.
 */
export function planServeStdio(flags: { ephemeral: boolean; attach: boolean; canAttach: boolean }): ServeStdioPlan {
  return {
    tryAttach: !flags.ephemeral && flags.canAttach,
    onAttachFailure: flags.attach ? "tempfail" : "fallback",
  };
}
