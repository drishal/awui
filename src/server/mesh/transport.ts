// Mesh transports (P1/P2): how the leader reaches a worker. Three ways in —
// ssh, a container runtime's exec, and a direct TLS listener — plus an
// in-process pair for tests. The spawn-based ones run the remote `awui peer
// serve-stdio`; TLS dials the worker's own listener (tls.ts) instead, with the
// channel binding that its handshake folds in. The local side never goes
// through a shell: every destination is held to a plain host/container/address
// shape so it cannot be read as an option, and the one string ssh itself has to
// hand to the remote shell is single-quoted token by token.
import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { PassThrough, type Readable, type Writable } from "node:stream";

/** A worker endpoint: one of the three real transports, as validated inputs. */
export type PeerLink =
  | { kind: "ssh"; host: string; sshOpts?: string[]; awuiPath?: string }
  | { kind: "docker"; container: string; engine?: "docker" | "podman"; awuiPath?: string }
  | { kind: "tls"; address: string };

/** A live link to a worker's stdio protocol. */
export interface SpawnedLink {
  /** What the worker writes (its stdout). */
  input: Readable;
  /** What the worker reads (its stdin). */
  output: Writable;
  /** The worker's stderr: diagnostics, never protocol. */
  stderr: Readable;
  kill(): void;
  /** Resolves with the exit code, or null when the child never ran or was signalled. */
  exited: Promise<number | null>;
  /** The last few KiB of stderr, for an error message about a link that failed. */
  stderrTail(): string;
}

/** How much stderr text is kept: enough for a startup failure, not a whole log. */
const STDERR_TAIL = 8 * 1024;

/** A destination ssh may be given: plain [user@]host, never an option. */
const SSH_HOST_RE = /^[A-Za-z0-9_.@:%\[\]][A-Za-z0-9_.@:%\[\]-]*$/;
/** A container name or id as `docker exec` takes it, never an option. */
const CONTAINER_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
/** This node's name, as the remote command's `--peer` value. */
const LOCAL_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** Characters that would break the one-line quoting contract. */
const BREAKING = /[\u0000\n\r]/;

/**
 * One string as a POSIX shell word: wrapped in single quotes, so the shell expands
 * nothing inside it, with each literal quote closed, escaped, and reopened.
 */
export function shellQuote(s: string): string {
  if (BREAKING.test(s)) throw new Error("a shell-quoted value must not hold a newline or a NUL");
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A config.yml `mesh.peers[]` entry as the link it describes. Throws when it does not name exactly one transport. */
export function linkOf(peer: { ssh?: string; docker?: string; tls?: string; ssh_opts?: string[]; awui_path?: string; engine?: "docker" | "podman" }): PeerLink {
  const ssh = peer.ssh?.trim();
  const docker = peer.docker?.trim();
  const tlsAddress = peer.tls?.trim();
  if (ssh && docker) throw new Error("a mesh peer names both ssh and docker; pick one");
  if (ssh && tlsAddress) throw new Error("a mesh peer names both ssh and tls; pick one");
  if (docker && tlsAddress) throw new Error("a mesh peer names both docker and tls; pick one");
  if (ssh) return { kind: "ssh", host: ssh, sshOpts: peer.ssh_opts, awuiPath: peer.awui_path };
  if (docker) return { kind: "docker", container: docker, engine: peer.engine, awuiPath: peer.awui_path };
  if (tlsAddress) return { kind: "tls", address: tlsAddress };
  throw new Error("a mesh peer names neither ssh, docker, nor tls");
}

/** Throws unless the value is safe to hand to a process as one argv word. */
function checkAwuiPath(awuiPath: string | undefined, kind: PeerLink["kind"]): void {
  if (awuiPath === undefined) return;
  if (BREAKING.test(awuiPath)) throw new Error("awui_path must not hold a newline or a NUL");
  if (kind === "docker" && awuiPath.startsWith("-")) throw new Error("awui_path must not start with '-'");
}

/** Throws unless this node's name is the plain token a peer name may be. */
function checkLocalName(localName: string): void {
  if (!LOCAL_NAME_RE.test(localName)) throw new Error(`peer name ${JSON.stringify(localName)} must match ${LOCAL_NAME_RE}`);
}

/** The exact argv that starts the worker's stdio protocol, without a local shell. */
export function argvFor(link: PeerLink, localName: string): string[] {
  checkLocalName(localName);
  if (link.kind === "tls") {
    // A TLS peer is dialed through tls.ts, never spawned; an argv for one is a programming error, so it is named, not guessed at.
    throw new Error("a TLS mesh peer is dialed, not spawned");
  }
  checkAwuiPath(link.awuiPath, link.kind);
  const awuiPath = link.awuiPath ?? "awui";
  if (link.kind === "docker") {
    if (!CONTAINER_RE.test(link.container)) throw new Error(`container ${JSON.stringify(link.container)} must match ${CONTAINER_RE}`);
    return [link.engine ?? "docker", "exec", "-i", link.container, awuiPath, "peer", "serve-stdio", "--peer", localName];
  }
  if (!SSH_HOST_RE.test(link.host)) throw new Error(`ssh host ${JSON.stringify(link.host)} must match ${SSH_HOST_RE}`);
  const sshOpts = link.sshOpts ?? [];
  for (const opt of sshOpts) {
    if (BREAKING.test(opt)) throw new Error(`ssh option ${JSON.stringify(opt)} must not hold a newline or a NUL`);
  }
  // ssh runs this through the remote shell, so every word of it is quoted.
  const remoteCmd = `${shellQuote(awuiPath)} peer serve-stdio --peer ${shellQuote(localName)}`;
  return ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4", ...sshOpts, "--", link.host, remoteCmd];
}

/**
 * Starts the transport. The child is spawned with its own stdio pipes and never a
 * shell: the argv was built as words, so nothing is re-parsed or re-expanded here.
 */
export function spawnLink(link: PeerLink, localName: string, opts: { spawn?: typeof nodeSpawn; env?: NodeJS.ProcessEnv } = {}): SpawnedLink {
  const argv = argvFor(link, localName);
  const command = argv[0] as string;
  const spawn = opts.spawn ?? nodeSpawn;
  const child = spawn(command, argv.slice(1), { stdio: ["pipe", "pipe", "pipe"], shell: false, env: opts.env }) as ChildProcessWithoutNullStreams;

  let tail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    tail = (tail + chunk).slice(-STDERR_TAIL);
  });
  const exited = new Promise<number | null>((resolve) => {
    // A spawn that never ran reports only `error`; a killed child reports a signal
    // with a null code. Both are "no exit code" for the caller.
    child.on("error", () => resolve(null));
    child.on("close", (code: number | null) => resolve(code));
  });

  return {
    input: child.stdout,
    output: child.stdin,
    stderr: child.stderr,
    kill: () => void child.kill(),
    exited,
    stderrTail: () => tail,
  };
}

/** An in-process link: two pipes cross-wired, so tests drive a worker `serve()` without a process. */
export function memoryLink(): {
  client: { input: Readable; output: Writable };
  server: { input: Readable; output: Writable };
} {
  const toServer = new PassThrough();
  const toClient = new PassThrough();
  return {
    client: { input: toClient, output: toServer },
    server: { input: toServer, output: toClient },
  };
}
