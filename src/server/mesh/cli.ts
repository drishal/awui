// The mesh peer CLI (P1): `awui peer …`, the person-facing half of the mesh. Every
// pairing decision a human makes runs through here — the pin a first contact is
// confirmed into (`add`, asked by default), the accept a pending request waits for
// (`accept`, with the policy it will be held to), the check that a link really
// works (`test`), and the revocation that takes effect on the peer's next call
// (`remove`). It reads config.yml and the state folder the way the server does and
// never prints private key material; the only key on stdout is the public one, so a
// person can copy it to the other side. `serve-stdio` is the worker end of a link
// and delegates to serve.ts, which keeps protocol off stderr and logs off stdout.
import net from "node:net";
import { hostname } from "node:os";
import path from "node:path";
import { encodeQr, qrToTerminal } from "../../shared/qr.js";
import { ConfigError, loadConfig } from "../config.js";
import { UserConfigError, configDir, configEnv, meshConfig, meshEnabled, readUserConfig, type MeshConfig } from "../user-config.js";
import { ATTACH_PREFIX, socketPath } from "./attach.js";
import { AuditLog } from "./audit.js";
import type { MeshApprovalDecision } from "./approvals.js";
import { clientHandshake, SAS_CONTEXT } from "./handshake.js";
import { loadOrCreateIdentity, nodeIdOf, sasOf, type NodeIdentity } from "./identity.js";
import { PeerManager } from "./manager.js";
import { decodeInviteCode, inviteMac } from "./pairing.js";
import { PeerPeersStore } from "./peer-store.js";
import { resolvePolicies } from "./policy.js";
import { PinStore } from "./pins.js";
import { connectTls } from "./tls.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "./rpc.js";
import { runServeStdio } from "./serve.js";

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
  awui peer approvals                       What this node's service is waiting for you to answer
  awui peer approve <id> [--for-link]      Answer one: allow once, or for this link's lifetime
  awui peer deny <id>                       Answer one: no
  awui peer invite [--policy <p>] [--ttl 10m] [--address host:port]   A single-use pairing code
  awui peer join <code> [--name <n>]        Pin the key an invite code carries, redeem it over TLS, save the peer
  awui peer serve-stdio [--peer <name>] [--policy <p>] [--ephemeral] [--attach]   The worker end of a link (SSH/docker)

add and accept are the two halves of one pairing: add pins the other machine's
key here (TOFU, confirmed by comparing node ids and the six-digit SAS), accept
pins this machine's key there. invite and join are the same pairing when the
two machines cannot be side by side: invite prints a single-use code carrying
this node's key, join pins the key the code carries, redeems the invite over TLS,
and leaves a request the target's owner still accepts. approvals, approve, deny,
and invite talk to this node's own running awui service (its attach socket).
Policy names come from mesh.policies or the built-ins (none, worker, peer).

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
  /** `join`'s local name for the peer it pins. */
  name: string | null;
  /** `invite`'s lifetime, unparsed text (`10m`); the command judges it. */
  ttl: string | null;
  /** `approve`'s wider answer: allow for the link's lifetime, not once. */
  forLink: boolean;
  /** `invite`'s addresses, every --address in order. */
  addresses: string[];
}

const emptyFlags = (): Flags => ({ yes: false, policy: null, peer: null, tail: null, name: null, ttl: null, forLink: false, addresses: [] });

/**
 * One command line, parsed strictly: its positional words and its flags, in any
 * order, with nothing else. The value-taking flags are named per command;
 * `--yes`/`-y` is the one bare flag. Returns the error to print instead when the
 * line is wrong — an unknown flag is a usage error, never a best-effort read.
 */
function parseLine(args: string[], valueFlags: string[]): { words: string[]; flags: Flags } | { error: string } {
  const words: string[] = [];
  const flags = emptyFlags();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--yes" || arg === "-y") {
      flags.yes = true;
      continue;
    }
    if (arg === "--for-link") {
      flags.forLink = true;
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
    else if (arg === "--name") flags.name = value;
    else if (arg === "--ttl") flags.ttl = value;
    else if (arg === "--address") flags.addresses.push(value);
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

/** A PeerManager wired to this run's own config, identity, pins, and saved peers. */
function managerFor(read: Settings, pins: ReturnType<typeof PinStore>, io: PeerCliIo): PeerManager {
  return new PeerManager({
    identity: () => loadOrCreateIdentity(read.stateDir),
    pins,
    config: () => read.mesh,
    enabled: () => read.on,
    localName: () => localMeshName(read.mesh),
    // Peers a join saved (mesh/peers.json) are as reachable as config's own: the
    // snapshot is a cached sync read, so this costs a stat per call.
    savedPeers: () => PeerPeersStore(path.join(read.stateDir, "mesh", "peers.json")).snapshot(),
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
    case "approvals": {
      const parsed = parseLine(rest, []);
      if ("error" in parsed) return failUsage(parsed.error);
      if (parsed.words.length > 0) return failUsage(`unexpected word ${parsed.words[0]}`);
      const read = settings(io.env);
      if ("error" in read) return fail(read.error, EXIT_CONFIG);
      if (!read.on) return fail(MESH_OFF_HINT, EXIT_CONFIG);
      return approvalsCommand(io, read);
    }
    case "approve":
    case "deny": {
      const parsed = parseLine(rest, []);
      if ("error" in parsed) return failUsage(parsed.error);
      const id = parsed.words[0];
      if (id === undefined) return failUsage(`${command} needs an approval id (see "awui peer approvals")`);
      if (parsed.words.length > 1) return failUsage(`unexpected word ${parsed.words[1]}`);
      if (command === "deny" && parsed.flags.forLink) return failUsage("--for-link answers an approval for its whole link; it is an approve flag");
      const read = settings(io.env);
      if ("error" in read) return fail(read.error, EXIT_CONFIG);
      if (!read.on) return fail(MESH_OFF_HINT, EXIT_CONFIG);
      return decideCommand(io, read, command, id, parsed.flags.forLink);
    }
    case "invite": {
      const parsed = parseLine(rest, ["--policy", "--ttl", "--address"]);
      if ("error" in parsed) return failUsage(parsed.error);
      if (parsed.words.length > 0) return failUsage(`unexpected word ${parsed.words[0]}`);
      const ttl = inviteTtlMinutes(parsed.flags.ttl);
      if (ttl !== null && typeof ttl === "object") return failUsage(ttl.error);
      const read = settings(io.env);
      if ("error" in read) return fail(read.error, EXIT_CONFIG);
      if (!read.on) return fail(MESH_OFF_HINT, EXIT_CONFIG);
      return inviteCommand(io, read, parsed.flags.policy, ttl, parsed.flags.addresses);
    }
    case "join": {
      const parsed = parseLine(rest, ["--name"]);
      if ("error" in parsed) return failUsage(parsed.error);
      const word = parsed.words[0];
      if (word === undefined) return failUsage("join needs an invite code");
      if (parsed.words.length > 1) return failUsage(`unexpected word ${parsed.words[1]}`);
      const read = settings(io.env);
      if ("error" in read) return fail(read.error, EXIT_CONFIG);
      if (!read.on) return fail(MESH_OFF_HINT, EXIT_CONFIG);
      return joinCommand(io, read, word, parsed.flags.name);
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
      // accept's --policy is judged inside the command: an invited request (P2 §3) carries
      // its own policy, and only the pending entry can say whether this is one.
      const read = settings(io.env);
      if ("error" in read) return fail(read.error, EXIT_CONFIG);
      if (!read.on) return fail(MESH_OFF_HINT, EXIT_CONFIG);
      const pins = PinStore(path.join(read.stateDir, "mesh", "pins.json"));
      if (command === "accept") return acceptCommand(io, read, pins, parsed);
      return command === "add" ? addCommand(io, read, pins, name, parsed.flags) : testCommand(io, read, pins, name);
    }
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
 * `awui peer join <code> [--name <n>]`: the invite's other half. The code
 * carries the target's key, so it is pinned outright — no TOFU, no comparison
 * to make — and the local name is the joiner's own choice. With an address in
 * the code the joiner then dials it over TLS (the same signed handshake, the
 * channel binding folded in), proves the invite's secret by binding it to
 * this one link's transcript, and saves the peer to peers.json. Joining does
 * not pair anything: the redeem leaves a pending request on the target that
 * its owner still has to accept.
 */
async function joinCommand(io: PeerCliIo, read: Settings, text: string, nameFlag: string | null): Promise<number> {
  const code = decodeInviteCode(text);
  if (code === null) {
    io.err('awui peer join: that is not an awui invite code; it must start with "awui-invite:1:" and come from `awui peer invite` on the target');
    return EXIT_FAILED;
  }
  const name = nameFlag ?? code.name;
  if (!NAME_RE.test(name)) {
    io.err(`awui peer join: peer name ${JSON.stringify(name)} must match ${NAME_RE}`);
    return EXIT_USAGE;
  }
  const pins = PinStore(path.join(read.stateDir, "mesh", "pins.json"));
  const existing = await pins.outbound(name);
  if (existing !== null && !existing.publicKey.equals(code.targetKey)) {
    io.err(`awui peer join: "${name}" is already pinned to a different key; run \`awui peer remove ${name}\` first if you mean to re-pin it`);
    return EXIT_FAILED;
  }
  await pins.setOutbound(name, code.targetKey);
  io.out(`Pinned ${name} (${nodeIdOf(code.targetKey)}) from the invite code; no first-contact comparison is needed.`);
  if (code.addresses.length === 0) {
    io.out("The code carries no address, so the invite was not redeemed; ask the target for a code minted with --address.");
    return EXIT_OK;
  }
  let who: NodeIdentity;
  try {
    who = await loadOrCreateIdentity(read.stateDir);
  } catch (error) {
    io.err(`awui peer join: the mesh identity could not be loaded: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_FAILED;
  }
  return joinRedeem(io, read, code, name, who);
}

/** How long a join gives the target's redeem to answer: in-memory work, so this is a hang guard. */
const REDEEM_RPC_MS = 10_000;

/**
 * The redeem half of a join: try the code's addresses in order over TLS until
 * one completes the handshake, then prove the invite's secret against exactly
 * that link. The addresses name one target, so a handshake that failed on a
 * bad address just moves on to the next, while a redeem that failed is final
 * — the invite lives in the target's one service, and its verdict is the same
 * on every address it answers on.
 */
async function joinRedeem(io: PeerCliIo, read: Settings, code: NonNullable<ReturnType<typeof decodeInviteCode>>, name: string, who: NodeIdentity): Promise<number> {
  let unreachable: string | null = null;
  for (const address of code.addresses) {
    let dialed: Awaited<ReturnType<typeof connectTls>>;
    try {
      dialed = await connectTls(address, { timeoutMs: 10_000 });
    } catch (error) {
      unreachable = error instanceof Error ? error.message : String(error);
      continue;
    }
    const rpc = new RpcPeer(dialed.link, dialed.link, { role: "client", log: () => undefined });
    rpc.start();
    try {
      // The key came in the code, so the pin is exact and TOFU is off: a target
      // that presents anything else is not the machine the invite named.
      const outcome = await clientHandshake(rpc, {
        identity: who,
        name: localMeshName(read.mesh),
        hops: 0,
        expectedServerKey: code.targetKey,
        tofu: false,
        binding: dialed.binding,
      });
      const mac = inviteMac(code.secret, outcome.transcript);
      await rpc.request("peer.redeem", { inviteId: code.inviteId.toString("base64url"), mac: mac.toString("base64url") }, REDEEM_RPC_MS);
      // First working address is what peers.json keeps; it is how this node will
      // reach the peer from now on, and re-running join would need a fresh invite.
      await PeerPeersStore(path.join(read.stateDir, "mesh", "peers.json")).add({ name, tls: address });
      io.out(`Saved ${name} to this node's peers.json (tls: ${address}); it can be removed with \`awui peer remove ${name}\`.`);
      io.out(`Waiting for ${name} to accept: its owner runs \`awui peer accept ${localMeshName(read.mesh)}\` there.`);
      return EXIT_OK;
    } catch (error) {
      io.err(`awui peer join: ${name} (${address}): ${error instanceof Error ? error.message : String(error)}`);
      return EXIT_FAILED;
    } finally {
      rpc.close("the join is done");
      dialed.link.destroy();
    }
  }
  io.err(`awui peer join: no address in the code could be reached (${code.addresses.join(", ")})${unreachable === null ? "" : `: ${unreachable}`}; the invite was not redeemed`);
  return EXIT_FAILED;
}

/** `--ttl 10m`: the one form an invite's lifetime takes. Returns null for the default, or the usage error. */
function inviteTtlMinutes(flag: string | null): number | null | { error: string } {
  if (flag === null) return null;
  const match = /^(\d{1,2})m$/.exec(flag);
  if (match === null) return { error: `--ttl takes a form like 10m (1..60 minutes), not ${JSON.stringify(flag)}` };
  const minutes = Number(match[1]);
  if (minutes < 1 || minutes > 60) return { error: "--ttl is 1..60 minutes" };
  return minutes;
}

/** How long the owner's CLI gives its own service to answer: local and in memory, so this is a hang guard. */
const SERVICE_RPC_MS = 10_000;

/**
 * One call to this node's own running service over its attach socket: the
 * owner's CLI reaches the daemon's local.* methods (approvals, invites),
 * which no peer link may ever serve. The mesh handshake still runs — the
 * service answers only a caller holding this state folder's identity, which
 * is exactly the CLI — and the socket is this uid's, so the prologue is
 * trusted exactly as the command line is (P1.5's rule).
 */
async function serviceCall<T>(io: PeerCliIo, read: Settings, method: string, params: unknown): Promise<{ ok: true; value: T } | { ok: false; message: string }> {
  let at: string;
  try {
    at = await socketPath(io.env, read.stateDir);
  } catch (error) {
    return { ok: false, message: `the attach socket path could not be prepared: ${error instanceof Error ? error.message : String(error)}` };
  }
  let who: NodeIdentity;
  try {
    who = await loadOrCreateIdentity(read.stateDir);
  } catch (error) {
    return { ok: false, message: `the mesh identity could not be loaded: ${error instanceof Error ? error.message : String(error)}` };
  }
  return await new Promise((resolve) => {
    const sock = net.createConnection(at);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let rpc: RpcPeer | null = null;
    let done = false;
    const finish = (answer: { ok: true; value: T } | { ok: false; message: string }): void => {
      if (done) return;
      done = true;
      if (timer !== null) clearTimeout(timer);
      // The link's own close, not a bare destroy: a pending request is answered link_closed, never left open.
      rpc?.close("the CLI is done");
      resolve(answer);
    };
    timer = setTimeout(() => finish({ ok: false, message: `no running awui service answered at ${at}; is the awui server running with the mesh on?` }), 1000);
    timer.unref?.();
    sock.once("error", (error) => finish({ ok: false, message: `no running awui service at ${at}: ${error.message}` }));
    sock.once("connect", () => {
      if (timer !== null) clearTimeout(timer);
      // The one prologue line, exactly as serve-stdio writes it; then nothing but protocol.
      sock.write(`${ATTACH_PREFIX}${JSON.stringify({ forced: null })}\n`);
      rpc = new RpcPeer(sock, sock, { role: "client", log: () => undefined });
      rpc.start();
      void (async () => {
        try {
          // Our own service holds the same identity key this CLI just loaded, so the
          // pin is exact, never TOFU: a different awui at that path is a mismatch.
          await clientHandshake(rpc, { identity: who, name: localMeshName(read.mesh), hops: 0, expectedServerKey: who.publicKey, tofu: false });
          finish({ ok: true, value: await rpc.request<T>(method, params, SERVICE_RPC_MS) });
        } catch (error) {
          finish({ ok: false, message: error instanceof Error ? error.message : String(error) });
        }
      })();
    });
  });
}

/** `awui peer approvals`: what the service is holding for a person to answer, each with its wait left. */
async function approvalsCommand(io: PeerCliIo, read: Settings): Promise<number> {
  const answer = await serviceCall<unknown>(io, read, "local.approvals.list", {});
  if (!answer.ok) {
    io.err(`awui peer approvals: ${answer.message}`);
    return EXIT_FAILED;
  }
  const rows = Array.isArray(answer.value)
    ? answer.value.filter((row): row is Record<string, unknown> => typeof row === "object" && row !== null)
    : [];
  if (rows.length === 0) {
    io.out("No approvals are pending on this node's service.");
    return EXIT_OK;
  }
  for (const row of rows) {
    const id = typeof row.id === "string" ? row.id : "?";
    const peer = typeof row.peerName === "string" ? row.peerName : "?";
    const method = typeof row.method === "string" ? row.method : "?";
    const summary = typeof row.summary === "string" ? row.summary : "";
    const expiresAt = typeof row.expiresAt === "number" ? row.expiresAt : Date.now();
    const left = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    io.out(`${id}  ${peer}  ${method}  ${summary}  (waits ${left} s more)`);
  }
  return EXIT_OK;
}

/** `awui peer approve <id> [--for-link]` and `awui peer deny <id>`: one answer, one card, over the attach socket. */
async function decideCommand(io: PeerCliIo, read: Settings, command: string, id: string, forLink: boolean): Promise<number> {
  const decision: MeshApprovalDecision = command === "deny" ? "deny" : forLink ? "allow-for-link" : "allow-once";
  const answer = await serviceCall<unknown>(io, read, "local.approvals.decide", { id, decision });
  if (!answer.ok) {
    io.err(`awui peer ${command}: ${answer.message}`);
    return EXIT_FAILED;
  }
  io.out(decision === "deny" ? `Denied ${id}.` : decision === "allow-for-link" ? `Allowed ${id} for that link's lifetime.` : `Allowed ${id} once.`);
  return EXIT_OK;
}

/** `awui peer invite`: the service mints the single-use code; this side only prints it. */
async function inviteCommand(io: PeerCliIo, read: Settings, policy: string | null, ttlMinutes: number | null, addresses: string[]): Promise<number> {
  const answer = await serviceCall<{ code?: unknown; policy?: unknown; expiresAt?: unknown }>(io, read, "local.invite.create", {
    ...(policy !== null ? { policy } : {}),
    ...(ttlMinutes !== null ? { ttlMinutes } : {}),
    ...(addresses.length > 0 ? { addresses } : {}),
  });
  if (!answer.ok) {
    io.err(`awui peer invite: ${answer.message}`);
    return EXIT_FAILED;
  }
  const value = answer.value;
  if (typeof value.code !== "string" || value.code === "") {
    io.err("awui peer invite: the service answered without a code");
    return EXIT_FAILED;
  }
  const when = typeof value.expiresAt === "number" ? new Date(value.expiresAt).toISOString() : "unknown time";
  const under = typeof value.policy === "string" ? value.policy : "worker";
  io.out(`invite (policy ${under}, single use, expires ${when}):`);
  io.out(value.code);
  io.out("");
  // The QR is the same code: a phone or a second terminal scans it instead of a
  // hand-copy, so the two never disagree about the key the pin will hold.
  for (const line of qrToTerminal(encodeQr(value.code)).split("\n")) io.out(line);
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
  let policies: Map<string, unknown>;
  try {
    policies = resolvePolicies(read.mesh?.policies);
  } catch (error) {
    io.err(`awui peer accept: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT_CONFIG;
  }
  // An explicitly named policy is judged before anything is read: a typo is a typo
  // whether or not the caller has a pending entry yet.
  if (flags.policy !== null && !policies.has(flags.policy)) {
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
    io.err(`awui peer accept: no pending request from "${name}". It appears after that node first contacts this one (its leader runs \`awui peer add ${name}\`), or after it redeems an invite.`);
    return EXIT_FAILED;
  }
  // An invited request (P2 §3) carries the policy its invite named, so --policy is
  // optional there and pre-filled; a plain first contact still needs it spelled out.
  const policy = flags.policy ?? pending.invited?.policy ?? null;
  if (policy === null) return failParse(io, "--policy is needed (built-ins: none, worker, peer; or a mesh.policies name; an invited request pre-fills its own)");
  if (!policies.has(policy)) {
    // Only the invited policy reaches this unchecked: it must still exist here, since
    // pinning a name that resolves to "none" would silently hold a caller to the floor.
    io.err(`awui peer accept: the invite's policy "${policy}" is not configured here (have: ${[...policies.keys()].join(", ")})`);
    return EXIT_CONFIG;
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
  io.out(`policy: ${policy}${flags.policy === null ? " (pre-filled from the invite)" : ""}`);
  if (!(await confirmed(io, flags, `Accept and pin this key under policy "${policy}"? [y/N] `))) {
    io.err("awui peer accept: not accepted; the request stays pending");
    return EXIT_FAILED;
  }
  await pins.setInbound(pending.publicKey, name, policy, "accept");
  io.out(`Accepted ${name} (policy ${policy}). It takes effect on the peer's next call.`);
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
