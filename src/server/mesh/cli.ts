// The mesh peer CLI (P1): `awui peer …`, the person-facing half of the mesh. Every
// pairing decision a human makes runs through here — the pin a first contact is
// confirmed into (`add`, asked by default), the accept a pending request waits for
// (`accept`, with the policy it will be held to), the check that a link really
// works (`test`), and the revocation that takes effect on the peer's next call
// (`remove`). It reads config.yml and the state folder the way the server does and
// never prints private key material; the only key on stdout is the public one, so a
// person can copy it to the other side. `serve-stdio` is the worker end of a link
// and delegates to serve.ts, which keeps protocol off stderr and logs off stdout.
// `bootstrap` (P3) is the worker setup the other way round: it prints the exact
// commands a target needs — install, config.yml, an authorized_keys forced command —
// and with --run runs them over ssh, argv only, after showing them and asking.
import { spawn as nodeSpawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { hostname, homedir } from "node:os";
import path from "node:path";
import { ConfigError, loadConfig } from "../config.js";
import { UserConfigError, configDir, configEnv, meshConfig, meshEnabled, readUserConfig, type MeshConfig } from "../user-config.js";
import { AuditLog } from "./audit.js";
import { SAS_CONTEXT } from "./handshake.js";
import { loadOrCreateIdentity, nodeIdOf, sasOf } from "./identity.js";
import { PeerManager } from "./manager.js";
import { expandRoot, resolvePolicies } from "./policy.js";
import { PinStore } from "./pins.js";
import { MeshErrorCode, MeshRpcError } from "./rpc.js";
import { runServeStdio } from "./serve.js";
import { checkSshDest, shellQuote, sshRemoteArgv } from "./transport.js";

/** OK; the command did what was asked. */
export const EXIT_OK = 0;
/** A real failure (a refused pin, a link that would not come up). */
export const EXIT_FAILED = 1;
/** The command line itself was wrong. */
export const EXIT_USAGE = 2;
/** The mesh is off, or config.yml is broken (EX_CONFIG): retrying cannot help. */
export const EXIT_CONFIG = 78;

const MESH_OFF_HINT = "the mesh is off on this node; set mesh.enabled: true in awui's config.yml";

export const PEER_USAGE = `awui peer — the mesh's peer commands

Usage:
  awui peer status                          The mesh here: on/off, this node's id and public key, pins
  awui peer add <name> [--yes]              First contact with a configured peer: pin its key (asked)
  awui peer accept <name> --policy <p> [--yes]   On the target: pin a pending caller under a policy
  awui peer list                            The configured peers and what is pinned about them
  awui peer test <name>                     Handshake and peer.info, without opening a task
  awui peer remove <name>                   Forget a peer: drop its outbound, inbound and pending pins
  awui peer log [--peer <name>] [--tail N]  The audit log of decisions this node made
  awui peer ls <name> <path>                A folder on a peer: names, types, sizes
  awui peer cat <name> <path>               A file on a peer, raw to stdout (at most 4 MiB)
  awui peer tasks <name>                    The peer's live tasks (its awui service runs them)
  awui peer serve-stdio [--peer <name>] [--policy <p>] [--ephemeral] [--attach]   The worker end of a link (SSH/docker)
  awui peer bootstrap <ssh-dest> [--policy <p>] [--root <path>] [--repo <url>] [--pubkey <path>] [--run]
                                            Print the setup commands a worker needs (with --run: run them
                                            over ssh after showing and asking)

add and accept are the two halves of one pairing: add pins the other machine's
key here (TOFU, confirmed by comparing node ids and the six-digit SAS), accept
pins this machine's key there. Policy names come from mesh.policies or the
built-ins (none, worker, peer).

Exit codes: 0 ok, 1 failed, 2 usage, 78 the mesh is off or config.yml is broken.`;

/** What the CLI reads and writes; a test hands in its own collectors instead of the process's. */
export interface PeerCliIo {
  env: NodeJS.ProcessEnv;
  /** One line to stdout. */
  out: (line: string) => void;
  /** Raw bytes to stdout (`cat` writes the file exactly; absent, out is used as text). */
  write?: (chunk: string | Buffer) => void;
  /** One line to stderr. */
  err: (line: string) => void;
  /** One question, answered with the typed line; absent when there is no terminal to ask on. */
  ask?: (question: string) => Promise<string>;
  /**
   * How one `bootstrap --run` step is executed (an ssh argv, spawned without a
   * shell, inheriting this process's stdio); the real ssh by default. A test
   * hands in a recorder instead of a network.
   */
  runStep?: (argv: string[]) => Promise<number>;
}

/** What one run reads once: config.yml's mesh block, where state lives, whether the mesh is on. */
interface Settings {
  mesh: MeshConfig | undefined;
  stateDir: string;
  on: boolean;
}

/** This node's mesh name: config.yml's `mesh.name`, else the hostname as a peer name may be written. */
export function localMeshName(mesh: MeshConfig | undefined): string {
  const fallback = hostname().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return mesh?.name ?? (fallback.length > 0 ? fallback : "awui");
}

/** A peer name as config.yml spells it (P0). */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/** The flags one command takes, as parsed strictly. */
interface Flags {
  yes: boolean;
  policy: string | null;
  peer: string | null;
  tail: number | null;
  root: string | null;
  repo: string | null;
  pubkey: string | null;
  run: boolean;
}

const emptyFlags = (): Flags => ({ yes: false, policy: null, peer: null, tail: null, root: null, repo: null, pubkey: null, run: false });

/**
 * One command line, parsed strictly: its positional words and its flags, in any
 * order, with nothing else. The value-taking flags are named per command, and
 * so are the bare ones (`--yes`/`-y` everywhere; `--run` only for bootstrap) —
 * a flag a command does not take is a usage error, never an ignored word.
 * Returns the error to print instead when the line is wrong — an unknown flag
 * is a usage error, never a best-effort read.
 */
function parseLine(args: string[], valueFlags: string[], bareFlags: string[] = ["--yes", "-y"]): { words: string[]; flags: Flags } | { error: string } {
  const words: string[] = [];
  const flags = emptyFlags();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (bareFlags.includes(arg)) {
      if (arg === "--run") flags.run = true;
      else flags.yes = true;
      continue;
    }
    if (!valueFlags.includes(arg)) {
      if (arg.startsWith("--")) return { error: `unknown option: ${arg}` };
      words.push(arg);
      continue;
    }
    const value = args[i + 1];
    if (value === undefined) return { error: `${arg} needs a value` };
    if (arg === "--policy") flags.policy = value;
    else if (arg === "--peer") flags.peer = value;
    else if (arg === "--root") flags.root = value;
    else if (arg === "--repo") flags.repo = value;
    else if (arg === "--pubkey") flags.pubkey = value;
    else {
      const n = Number(value);
      if (!value || !Number.isInteger(n) || n <= 0) return { error: `${arg} takes a positive number` };
      flags.tail = n;
    }
    i++;
  }
  return { words, flags };
}

/** One positional word that must be a peer name, or the error to print. */
function peerName(words: string[], command: string): string | { error: string } {
  const word = words[0];
  if (word === undefined) return { error: `${command} needs a peer name` };
  if (words.length > 1) return { error: `unexpected word ${words[1]}` };
  if (!NAME_RE.test(word)) return { error: `peer name ${JSON.stringify(word)} must match ${NAME_RE}` };
  return word;
}

/** Config and the mesh block as this process reads them, once: a CLI run is one shot. */
function settings(env: NodeJS.ProcessEnv): Settings | { error: string } {
  try {
    const read = readUserConfig(configDir(env));
    const config = loadConfig({ ...(read ? configEnv(read.config) : {}), ...env }, read?.config);
    return { mesh: meshConfig(read?.config), stateDir: config.stateDir, on: meshEnabled(read?.config, env) };
  } catch (error) {
    if (error instanceof ConfigError || error instanceof UserConfigError) return { error: error.message };
    throw error;
  }
}

/** Whether a `y/N` question is answered yes; no terminal and no --yes means no. */
async function confirmed(io: PeerCliIo, flags: Flags, question: string): Promise<boolean> {
  if (flags.yes) return true;
  if (!io.ask) {
    io.err("awui: this command asks before it pins, and there is no terminal to ask on; pass --yes for scripts");
    return false;
  }
  return /^y(es)?$/i.test((await io.ask(question)).trim());
}

/** A PeerManager wired to this run's own config, identity, and pins. */
function managerFor(read: Settings, pins: ReturnType<typeof PinStore>, io: PeerCliIo): PeerManager {
  return new PeerManager({
    identity: () => loadOrCreateIdentity(read.stateDir),
    pins,
    config: () => read.mesh,
    enabled: () => read.on,
    localName: () => localMeshName(read.mesh),
    log: (m) => io.err(`awui peer: ${m}`),
  });
}

/**
 * `awui peer …`: the exit code, after printing what the command found. Reading
 * commands (status, list, log, remove) work with the mesh off and say so; the
 * commands that open a link or write a pin refuse with 78 instead.
 */
export async function runPeerCli(args: string[], io: PeerCliIo): Promise<number> {
  const [command, ...rest] = args;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    if (command === undefined) io.err(PEER_USAGE);
    else io.out(PEER_USAGE);
    return command === undefined ? EXIT_USAGE : EXIT_OK;
  }
  const fail = (message: string, code: number): number => {
    io.err(`awui peer ${command}: ${message}`);
    return code;
  };
  /** A usage error carries the usage: the line was wrong, so show how to write it. */
  const failUsage = (message: string): number => {
    io.err(`awui peer ${command}: ${message}\n\n${PEER_USAGE}`);
    return EXIT_USAGE;
  };

  switch (command) {
    case "status":
    case "list": {
      const parsed = parseLine(rest, []);
      if ("error" in parsed) return failUsage(parsed.error);
      if (parsed.words.length > 0) return failUsage(`unexpected word ${parsed.words[0]}`);
      const read = settings(io.env);
      if ("error" in read) return fail(read.error, EXIT_CONFIG);
      return command === "status" ? statusCommand(io, read) : listCommand(io, read);
    }
    case "log": {
      const parsed = parseLine(rest, ["--peer", "--tail"]);
      if ("error" in parsed) return failUsage(parsed.error);
      const read = settings(io.env);
      if ("error" in read) return fail(read.error, EXIT_CONFIG);
      return logCommand(io, read, parsed);
    }
    case "remove": {
      const parsed = parseLine(rest, []);
      if ("error" in parsed) return failUsage(parsed.error);
      const name = peerName(parsed.words, command);
      if (typeof name !== "string") return failUsage(name.error);
      const read = settings(io.env);
      if ("error" in read) return fail(read.error, EXIT_CONFIG);
      // Revocation is local state, so it works with the mesh off too.
      const pins = PinStore(path.join(read.stateDir, "mesh", "pins.json"));
      await pins.removeByName(name);
      io.out(`Forgot ${name}: its outbound, inbound and pending pins are dropped here. It takes effect on the peer's next call.`);
      return EXIT_OK;
    }
    case "ls":
    case "cat": {
      // Peer name and path, exactly two words: the path is the peer's own to interpret.
      const parsed = parseLine(rest, []);
      if ("error" in parsed) return failUsage(parsed.error);
      if (parsed.words.length < 2) return failUsage(`${command} needs a peer name and a path on that peer`);
      if (parsed.words.length > 2) return failUsage(`unexpected word ${parsed.words[2]}`);
      const read = settings(io.env);
      if ("error" in read) return fail(read.error, EXIT_CONFIG);
      if (!read.on) return fail(MESH_OFF_HINT, EXIT_CONFIG);
      return command === "ls" ? lsCommand(io, read, parsed.words[0]!, parsed.words[1]!) : catCommand(io, read, parsed.words[0]!, parsed.words[1]!);
    }
    case "tasks": {
      const parsed = parseLine(rest, []);
      if ("error" in parsed) return failUsage(parsed.error);
      const name = peerName(parsed.words, command);
      if (typeof name !== "string") return failUsage(name.error);
      const read = settings(io.env);
      if ("error" in read) return fail(read.error, EXIT_CONFIG);
      if (!read.on) return fail(MESH_OFF_HINT, EXIT_CONFIG);
      return tasksCommand(io, read, name);
    }
    case "serve-stdio":
      // The worker end: protocol on stdout, logs on stderr, its own mesh-off refusal (78).
      return runServeStdio(rest, io.env);
    case "add":
    case "accept":
    case "test": {
      // The command line is judged first (usage is usage whatever the config says).
      const parsed = parseLine(rest, command === "accept" ? ["--policy"] : []);
      if ("error" in parsed) return failUsage(parsed.error);
      const name = peerName(parsed.words, command);
      if (typeof name !== "string") return failUsage(name.error);
      if (command === "accept" && parsed.flags.policy === null) return failUsage("--policy is needed (built-ins: none, worker, peer; or a mesh.policies name)");
      const read = settings(io.env);
      if ("error" in read) return fail(read.error, EXIT_CONFIG);
      if (!read.on) return fail(MESH_OFF_HINT, EXIT_CONFIG);
      const pins = PinStore(path.join(read.stateDir, "mesh", "pins.json"));
      if (command === "accept") return acceptCommand(io, read, pins, parsed);
      return command === "add" ? addCommand(io, read, pins, name, parsed.flags) : testCommand(io, read, pins, name);
    }
    case "bootstrap":
      return bootstrapCommand(io, failUsage, rest);
    default:
      io.err(`awui peer: unknown command ${command}\n\n${PEER_USAGE}`);
      return EXIT_USAGE;
  }
}

/** The mesh's own state here, honest about off: nothing is created on disk just to look. */
async function statusCommand(io: PeerCliIo, read: Settings): Promise<number> {
  if (!read.on) {
    io.out("mesh: off");
    io.out(`  ${MESH_OFF_HINT}`);
    return EXIT_OK;
  }
  let identity;
  try {
    identity = await loadOrCreateIdentity(read.stateDir);
  } catch (error) {
    io.err(`awui peer status: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
  const pins = PinStore(path.join(read.stateDir, "mesh", "pins.json"));
  const snapshot = await pins.snapshot().catch(() => null);
  io.out("mesh: on");
  io.out(`name: ${localMeshName(read.mesh)}`);
  io.out(`node id: ${identity.nodeId}`);
  // The one key on stdout, on purpose: it is the value a person pastes into the
  // other side's accept. The private key never leaves the state folder.
  io.out(`public key: ${identity.publicKey.toString("base64url")}`);
  const peers = read.mesh?.peers ?? [];
  io.out(`configured peers: ${peers.length === 0 ? "none" : peers.map((p) => `${p.name} (${p.ssh !== undefined ? "ssh" : "docker"})`).join(", ")}`);
  if (snapshot !== null) {
    io.out(`outbound pins: ${snapshot.outbound.length === 0 ? "none" : snapshot.outbound.map((p) => p.name).join(", ")}`);
    io.out(`inbound pins: ${snapshot.inbound.length === 0 ? "none" : snapshot.inbound.map((p) => `${p.name} (policy ${p.policy})`).join(", ")}`);
    io.out(`pending requests: ${snapshot.pending.length === 0 ? "none" : snapshot.pending.map((p) => p.name).join(", ")}`);
  }
  return EXIT_OK;
}

/** The configured inventory with what is pinned about each, without opening a link. */
async function listCommand(io: PeerCliIo, read: Settings): Promise<number> {
  if (!read.on) {
    io.out("mesh: off");
    io.out(`  ${MESH_OFF_HINT}`);
    return EXIT_OK;
  }
  const pins = PinStore(path.join(read.stateDir, "mesh", "pins.json"));
  const snapshot = await pins.snapshot();
  const pinned = new Set(snapshot.outbound.map((p) => p.name));
  const peers = read.mesh?.peers ?? [];
  if (peers.length === 0) io.out("No peers are configured under mesh.peers in config.yml.");
  for (const peer of peers) {
    io.out(`${peer.name}  ${peer.ssh !== undefined ? `ssh ${peer.ssh}` : `docker ${peer.docker ?? ""}`}  ${pinned.has(peer.name) ? "pinned" : "not pinned"}`);
  }
  if (snapshot.pending.length > 0) {
    io.out(`pending requests: ${snapshot.pending.map((p) => `${p.name} (accept with --policy <p>)`).join(", ")}`);
  }
  return EXIT_OK;
}

/** The audit log's tail: who asked for what, and what this node answered. */
async function logCommand(io: PeerCliIo, read: Settings, parsed: { words: string[]; flags: Flags }): Promise<number> {
  if (parsed.words.length > 0) return failParse(io, `unexpected word ${parsed.words[0]}`);
  if (!read.on) {
    io.out("mesh: off");
    io.out(`  ${MESH_OFF_HINT}`);
    return EXIT_OK;
  }
  const audit = new AuditLog(path.join(read.stateDir, "mesh", "audit.jsonl"));
  const entries = await audit.tail(parsed.flags.tail ?? 20);
  const shown = parsed.flags.peer === null ? entries : entries.filter((e) => e.peer === parsed.flags.peer);
  if (shown.length === 0) {
    io.out(parsed.flags.peer === null ? "The audit log has no entries yet." : `The audit log has no entries for peer "${parsed.flags.peer}".`);
    return EXIT_OK;
  }
  for (const entry of shown) {
    const at = new Date(entry.ts).toISOString();
    io.out([at, entry.peer ?? "-", entry.method, entry.decision, entry.target ?? "", entry.outcome ?? ""].filter((v) => v !== "").join("  "));
  }
  return EXIT_OK;
}

/** A usage refusal raised inside a command body. */
function failParse(io: PeerCliIo, message: string): number {
  io.err(`awui: ${message}\n\n${PEER_USAGE}`);
  return EXIT_USAGE;
}

/** One failed call to a peer: its own words for why, at the CLI's failure code. */
function peerFailure(io: PeerCliIo, command: string, name: string, error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  io.err(`awui peer ${command}: ${name}: ${message}`);
  return EXIT_FAILED;
}

/** `awui peer ls <name> <path>`: one folder on the peer, as its worker lists it. */
async function lsCommand(io: PeerCliIo, read: Settings, name: string, target: string): Promise<number> {
  const manager = managerFor(read, PinStore(path.join(read.stateDir, "mesh", "pins.json")), io);
  let listing;
  try {
    listing = await manager.list(name, target);
  } catch (error) {
    return peerFailure(io, "ls", name, error);
  }
  io.out(`${name}:${target}${listing.truncated ? " (truncated)" : ""}`);
  if (listing.entries.length === 0) io.out("  (empty)");
  for (const entry of listing.entries) {
    io.out(`  ${entry.name}  ${entry.type}${entry.type === "file" ? `  ${entry.size} B` : ""}`);
  }
  return EXIT_OK;
}

/** How much `cat` will carry: the wire's own bound for one read, and the file cap (P1.5 §4). */
const CAT_CHUNK_BYTES = 512 * 1024;
const CAT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * `awui peer cat <name> <path>`: the file's bytes, exactly, to stdout — read in 1 MiB
 * chunks up to the 4 MiB cap, so a peer file larger than that is a refusal, not a truncation.
 */
async function catCommand(io: PeerCliIo, read: Settings, name: string, target: string): Promise<number> {
  const manager = managerFor(read, PinStore(path.join(read.stateDir, "mesh", "pins.json")), io);
  const parts: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const chunk = await manager.read(name, target, { offset: total, length: CAT_CHUNK_BYTES });
      parts.push(chunk.data);
      total += chunk.data.length;
      if (chunk.eof) break;
      if (total >= CAT_MAX_BYTES) throw new Error(`the file is larger than ${CAT_MAX_BYTES} bytes`);
    }
  } catch (error) {
    return peerFailure(io, "cat", name, error);
  }
  const file = Buffer.concat(parts);
  const sink = io.write ?? ((chunk: string | Buffer) => io.out(typeof chunk === "string" ? chunk : chunk.toString("utf8")));
  sink(file);
  return EXIT_OK;
}

/** `awui peer tasks <name>`: what that peer's awui service is running for this machine. */
async function tasksCommand(io: PeerCliIo, read: Settings, name: string): Promise<number> {
  const manager = managerFor(read, PinStore(path.join(read.stateDir, "mesh", "pins.json")), io);
  let rows;
  try {
    rows = await manager.taskList(name);
  } catch (error) {
    return peerFailure(io, "tasks", name, error);
  }
  if (rows.length === 0) {
    io.out(`No tasks are live on ${name}.`);
    return EXIT_OK;
  }
  for (const row of rows) {
    io.out(`${row.remoteTaskId}  ${row.harness}  ${row.state}  ${row.cwd}  (event ${row.lastSeq})`);
  }
  return EXIT_OK;
}

/**
 * `awui peer add <name>`: the leader's first contact. The peer must already be in
 * config.yml (this command never edits it); the link comes up in TOFU mode, and
 * the key it presents is pinned only after the person has compared the node id
 * and SAS. A pin held under a different key is never silently replaced.
 */
async function addCommand(io: PeerCliIo, read: Settings, pins: ReturnType<typeof PinStore>, name: string, flags: Flags): Promise<number> {
  const configured = (read.mesh?.peers ?? []).some((p) => p.name.toLowerCase() === name.toLowerCase());
  if (!configured) {
    io.err(`awui peer add: no mesh peer called "${name}" is configured. Add to config.yml first:`);
    io.err("");
    io.err("mesh:");
    io.err("  peers:");
    io.err(`    - name: ${name}`);
    io.err("      ssh: user@host        # or docker: container");
    return EXIT_FAILED;
  }
  const manager = managerFor(read, pins, io);
  let connection;
  try {
    connection = await manager.connect(name, { tofu: true });
  } catch (error) {
    if (error instanceof MeshRpcError && error.code === MeshErrorCode.pin_mismatch) {
      io.err(`awui peer add: ${error.message} Run \`awui peer remove ${name}\` first if you mean to re-pin it.`);
      return EXIT_FAILED;
    }
    io.err(`awui peer add: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
  try {
    io.out(`peer: ${connection.name}`);
    io.out(`node id: ${nodeIdOf(connection.serverKey)}`);
    io.out(`SAS: ${connection.sas}`);
    if (!(await confirmed(io, flags, "Pin this key? [y/N] "))) {
      io.err("awui peer add: not pinned; the peer stays unpinned here");
      return EXIT_FAILED;
    }
    await manager.pin(name, connection.serverKey);
    io.out(`Pinned ${name} (${nodeIdOf(connection.serverKey)}).`);
    if (!connection.paired) {
      // The worker has not accepted this machine yet; that half runs over there.
      io.out(`On the target, run: awui peer accept ${localMeshName(read.mesh)} --policy worker`);
    }
    return EXIT_OK;
  } finally {
    connection.close();
  }
}

/**
 * `awui peer accept <name> --policy <p>`: the target's half. The pending request
 * the caller left on its first hello is pinned inbound under the named policy —
 * which must exist, because a typo would otherwise pin a floor silently.
 */
async function acceptCommand(io: PeerCliIo, read: Settings, pins: ReturnType<typeof PinStore>, parsed: { words: string[]; flags: Flags }): Promise<number> {
  const name = peerName(parsed.words, "accept");
  if (typeof name !== "string") return failParse(io, name.error);
  const flags = parsed.flags;
  if (flags.policy === null) return failParse(io, "--policy is needed (built-ins: none, worker, peer; or a mesh.policies name)");
  let policies: Map<string, unknown>;
  try {
    policies = resolvePolicies(read.mesh?.policies);
  } catch (error) {
    io.err(`awui peer accept: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_CONFIG;
  }
  if (!policies.has(flags.policy)) {
    io.err(`awui peer accept: no mesh policy named "${flags.policy}" (have: ${[...policies.keys()].join(", ")})`);
    return EXIT_CONFIG;
  }
  // The name in a pending request is whatever the caller claimed, so two callers can
  // claim the same one; never guess which key the person meant.
  const sameName = (await pins.snapshot()).pending.filter((entry) => entry.name === name);
  if (sameName.length > 1) {
    io.err(`awui peer accept: ${sameName.length} pending requests claim the name "${name}" (${sameName.map((e) => e.nodeId).join(", ")}); \`awui peer remove ${name}\` and have the right node contact this one again`);
    return EXIT_FAILED;
  }
  const pending = await pins.pending(name);
  if (pending === null) {
    io.err(`awui peer accept: no pending request from "${name}". It appears after that node first contacts this one (its leader runs \`awui peer add ${name}\`).`);
    return EXIT_FAILED;
  }
  let identity;
  try {
    identity = await loadOrCreateIdentity(read.stateDir);
  } catch (error) {
    io.err(`awui peer accept: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
  io.out(`name: ${pending.name}`);
  io.out(`node id: ${nodeIdOf(pending.publicKey)}`);
  io.out(`SAS: ${sasOf(pending.publicKey, identity.publicKey, SAS_CONTEXT)}`);
  io.out(`policy: ${flags.policy}`);
  if (!(await confirmed(io, flags, `Accept and pin this key under policy "${flags.policy}"? [y/N] `))) {
    io.err("awui peer accept: not accepted; the request stays pending");
    return EXIT_FAILED;
  }
  await pins.setInbound(pending.publicKey, name, flags.policy, "accept");
  io.out(`Accepted ${name} (policy ${flags.policy}). It takes effect on the peer's next call.`);
  return EXIT_OK;
}

/** `awui peer test <name>`: the link comes up, peer.info is asked, nothing more. */
async function testCommand(io: PeerCliIo, read: Settings, pins: ReturnType<typeof PinStore>, name: string): Promise<number> {
  const manager = managerFor(read, pins, io);
  let connection;
  try {
    connection = await manager.connect(name);
  } catch (error) {
    io.err(`awui peer test: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
  try {
    const info = (await connection.info()) as Record<string, unknown>;
    io.out(`peer: ${String(info.name ?? name)}`);
    io.out(`node id: ${String(info.nodeId ?? "?")}`);
    io.out(`harnesses: ${Array.isArray(info.harnesses) && info.harnesses.length > 0 ? info.harnesses.join(", ") : "none"}`);
    io.out(`roots: ${Array.isArray(info.roots) && info.roots.length > 0 ? info.roots.join(", ") : "none"}`);
    io.out(`ceiling: ${String(info.ceiling ?? "?")}`);
    io.out(`approvals at: ${String(info.approvalsAt ?? "?")}`);
    io.out(`max tasks: ${String(info.maxTasks ?? "?")}`);
    return EXIT_OK;
  } catch (error) {
    io.err(`awui peer test: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  } finally {
    connection.close();
  }
}

/** ----- bootstrap (P3) ------------------------------------------------------ */

/** The built-in policies a bootstrap may write on the target: a custom policy name would arrive there with no caps at all, a silent floor. */
const BOOTSTRAP_POLICIES = ["none", "worker", "peer"] as const;

/** The one repository `git clone` installs from, when --repo does not name another. */
const BOOTSTRAP_REPO = "https://github.com/drishal/awui.git";

/** Where a bootstrap puts the checkout on the target, and what it links onto the PATH. */
const BOOTSTRAP_DIR = "~/.local/share/awui";
const BOOTSTRAP_BIN = "~/.local/bin/awui";

/** The public keys the bootstrap looks for on this machine (the leader), in order. */
const BOOTSTRAP_KEY_FILES = ["id_ed25519.pub", "id_ecdsa.pub", "id_rsa.pub"];

/** One setup step: a name to print, an optional note about what it skips, and the remote script itself. */
interface BootstrapStep {
  name: string;
  note?: string;
  script: string;
}

/** One string as YAML needs it: double-quoted with the two escapes YAML's double-quoted style allows. */
function yamlScalar(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`a bootstrap value must be printable text: ${JSON.stringify(value.slice(0, 32))}`);
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** An ssh public key line (`type key comment…`) held to the two argv-safe fields the authorized_keys line needs. */
function parsePublicKey(raw: string): { key: string; comment: string } | null {
  const parts = raw.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const [type, key, ...rest] = parts as [string, string, ...string[]];
  if (!/^[a-z0-9-]{1,64}$/.test(type) || !/^[A-Za-z0-9+/=]{1,4096}$/.test(key)) return null;
  return { key: `${type} ${key}`, comment: rest.join(" ") };
}

/** The leader's default public key, the first one found under ~/.ssh, or null. */
async function findPublicKey(env: NodeJS.ProcessEnv): Promise<{ key: string; comment: string } | null> {
  const sshDir = path.join(homedir(), ".ssh");
  for (const name of BOOTSTRAP_KEY_FILES) {
    try {
      const parsed = parsePublicKey(await fs.readFile(path.join(sshDir, name), "utf8"));
      if (parsed !== null) return parsed;
    } catch {
      continue; // A key file that is not there is not an error; the next one may be.
    }
  }
  void env;
  return null;
}

/**
 * `awui peer bootstrap <ssh-dest>` (P3 §3): the commands that turn a plain ssh
 * destination into a mesh worker — awui installed, the mesh on in its
 * config.yml under the given policy and root, and an authorized_keys forced
 * command binding one ssh key to `peer serve-stdio`. Printed first, always; run
 * only with --run, after showing them and asking, one ssh invocation per step
 * with the script as one argv word (the local side never builds a shell line).
 * Only built-in policies may be written: a custom policy name would arrive on
 * the target with no capabilities at all, a floor that looks configured.
 */
async function bootstrapCommand(io: PeerCliIo, failUsage: (message: string) => number, rest: string[]): Promise<number> {
  const parsed = parseLine(rest, ["--policy", "--root", "--repo", "--pubkey"], ["--yes", "-y", "--run"]);
  if ("error" in parsed) return failUsage(parsed.error);
  const dest = parsed.words[0];
  if (dest === undefined) return failUsage("bootstrap needs an ssh destination ([user@]host) to set up");
  if (parsed.words.length > 1) return failUsage(`unexpected word ${parsed.words[1]}`);
  const flags = parsed.flags;
  const policy = flags.policy ?? "worker";
  if (!(BOOTSTRAP_POLICIES as readonly string[]).includes(policy)) {
    return failUsage(`--policy must be a built-in mesh policy (${BOOTSTRAP_POLICIES.join(", ")}); a policy of another name needs the full caps spelled out in the target's config.yml by hand`);
  }
  const root = flags.root ?? "~/code";
  const repo = flags.repo ?? BOOTSTRAP_REPO;
  try {
    checkSshDest(dest);
  } catch (error) {
    return failUsage(error instanceof Error ? error.message : String(error));
  }
  try {
    expandRoot(root, homedir());
  } catch (error) {
    return failUsage(`--root: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const [name, value] of [["--root", root], ["--repo", repo]] as const) {
    try {
      shellQuote(value);
    } catch {
      return failUsage(`${name} must be one printable line (no newline or NUL)`);
    }
    if (value.length > 4096) return failUsage(`${name} is longer than 4096 characters`);
  }
  const read = settings(io.env);
  if ("error" in read) {
    io.err(`awui peer bootstrap: ${read.error}`);
    return EXIT_CONFIG;
  }
  // The name the forced command pins the caller under is this machine's own mesh name, exactly as a link would present it.
  const leaderName = localMeshName(read.mesh);
  const q = shellQuote;

  // Step 1 — the checkout and the build, skipped by the step itself when the binary is already there.
  const install = [
    "mkdir -p ~/.local/bin ~/.local/share",
    `if [ ! -x ${BOOTSTRAP_BIN} ]; then`,
    `  git clone ${q(repo)} ${BOOTSTRAP_DIR}`,
    `  (cd ${BOOTSTRAP_DIR} && npm ci && npm run build)`,
    `  ln -sf ${BOOTSTRAP_DIR}/bin/awui ${BOOTSTRAP_BIN}`,
    "fi",
  ].join("\n");

  // Step 2 — the mesh block, appended only when config.yml has no mesh block yet.
  const config = [
    "mkdir -p ~/.config/awui",
    `grep -qs '^mesh:' ~/.config/awui/config.yml || cat >> ~/.config/awui/config.yml <<'AWUI-MESH'`,
    "mesh:",
    "  enabled: true",
    "  policies:",
    `    ${policy}:`,
    `      roots: [${yamlScalar(root)}]`,
    "AWUI-MESH",
  ].join("\n");

  // Step 3 — the forced command. The line ends in a marker this step's grep
  // finds, so re-running never appends a second copy; the command runs under
  // the user's own shell on the target, so $HOME expands there.
  let publicKey: { key: string; comment: string } | null = null;
  if (flags.pubkey !== null) {
    // An explicit key is read from one file, bounded: a value the parser
    // refuses is a usage error, never a guess at what the person meant.
    try {
      if (flags.pubkey.includes("\u0000")) throw new Error("the path holds a NUL byte");
      publicKey = parsePublicKey(await fs.readFile(flags.pubkey, "utf8"));
    } catch (error) {
      return failUsage(`--pubkey: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (publicKey === null) return failUsage(`--pubkey: ${flags.pubkey} does not hold one ssh public key line ("type key comment")`);
  } else {
    publicKey = await findPublicKey(io.env);
  }
  const forcedCommand = `$HOME/.local/bin/awui peer serve-stdio --policy ${q(policy)} --peer ${q(leaderName)}`;
  const authorizedKeys = publicKey === null
    ? null
    : [
        "mkdir -p ~/.ssh && chmod 700 ~/.ssh",
        "touch ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys",
        `grep -qF ${q(`awui-mesh ${leaderName}`)} ~/.ssh/authorized_keys || printf '%s\\n' ${q(`restrict,command="${forcedCommand}" ${publicKey.key}${publicKey.comment ? ` ${publicKey.comment}` : ""} awui-mesh ${leaderName}`)} >> ~/.ssh/authorized_keys`,
      ].join("\n");

  const steps: BootstrapStep[] = [
    { name: "1 — install awui", script: install },
    { name: "2 — turn the mesh on in config.yml", note: "the step appends nothing when a mesh block is already there; check it by hand (it may be off, or lack the policy's roots)", script: config },
    ...(authorizedKeys === null
      ? [{ name: "3 — bind an ssh key to the worker", note: "no public key was found under ~/.ssh here; add the forced-command line to the target's authorized_keys by hand", script: "" }]
      : [{ name: "3 — bind an ssh key to the worker", script: authorizedKeys }]),
  ];

  io.out(`awui peer bootstrap: set up ${dest} as a mesh worker for ${leaderName} (policy ${policy}, root ${root})`);
  io.out("");
  io.out("Run these on " + dest + " as the user the leader will ssh in as:");
  io.out("");
  for (const step of steps) {
    io.out(`# step ${step.name}`);
    io.out(step.script);
    io.out("");
  }
  io.out("Then, on this machine, add the peer to config.yml (mesh.peers: name, ssh " + dest + ") and run `awui peer add <name>`; with the forced-command key the worker pins this machine's key on first contact, so no `accept` is needed over there.");
  io.out("ssh runs the steps with BatchMode, so the key must already be accepted on the target.");

  if (!flags.run) return EXIT_OK;

  if (!(await confirmed(io, flags, `Run these steps on ${dest} over ssh now? [y/N] `))) {
    io.err("awui peer bootstrap: not run; the commands are printed above");
    return EXIT_FAILED;
  }
  const runStep = io.runStep ?? defaultRunStep;
  for (const step of steps) {
    if (step.script === "") {
      io.err(`awui peer bootstrap: skipped "step ${step.name}" (${step.note})`);
      continue;
    }
    let argv: string[];
    try {
      argv = sshRemoteArgv({ kind: "ssh", host: dest }, step.script);
    } catch (error) {
      io.err(`awui peer bootstrap: ${error instanceof Error ? error.message : String(error)}`);
      return EXIT_FAILED;
    }
    io.err(`awui peer bootstrap: running "step ${step.name}" on ${dest}…`);
    const code = await runStep(argv);
    if (code !== 0) {
      io.err(`awui peer bootstrap: "step ${step.name}" exited ${code}; stopped before the next step`);
      return EXIT_FAILED;
    }
  }
  io.out("Done. The worker's mesh turns on the next time its awui service (or a serve-stdio link) starts.");
  return EXIT_OK;
}

/** One ssh step, real: spawned argv-only, this process's stdio passed through. */
function defaultRunStep(argv: string[]): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const child = nodeSpawn(argv[0]!, argv.slice(1), { stdio: "inherit", shell: false });
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
}
