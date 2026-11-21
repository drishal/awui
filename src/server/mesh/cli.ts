// The mesh peer CLI (P1): `awui peer …`, the person-facing half of the mesh. Every
// pairing decision a human makes runs through here — the pin a first contact is
// confirmed into (`add`, asked by default), the accept a pending request waits for
// (`accept`, with the policy it will be held to), the check that a link really
// works (`test`), and the revocation that takes effect on the peer's next call
// (`remove`). It reads config.yml and the state folder the way the server does and
// never prints private key material; the only key on stdout is the public one, so a
// person can copy it to the other side. `serve-stdio` is the worker end of a link
// and delegates to serve.ts, which keeps protocol off stderr and logs off stdout.
import { hostname } from "node:os";
import path from "node:path";
import { ConfigError, loadConfig } from "../config.js";
import { UserConfigError, configDir, configEnv, meshConfig, meshEnabled, readUserConfig, type MeshConfig } from "../user-config.js";
import { AuditLog } from "./audit.js";
import { SAS_CONTEXT } from "./handshake.js";
import { loadOrCreateIdentity, nodeIdOf, sasOf } from "./identity.js";
import { PeerManager } from "./manager.js";
import { resolvePolicies } from "./policy.js";
import { PinStore } from "./pins.js";
import { MeshErrorCode, MeshRpcError } from "./rpc.js";
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
  awui peer serve-stdio [--peer <name>] [--policy <p>]   The worker end of a link (SSH/docker)

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
}

const emptyFlags = (): Flags => ({ yes: false, policy: null, peer: null, tail: null });

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
    if (!valueFlags.includes(arg)) {
      if (arg.startsWith("--")) return { error: `unknown option: ${arg}` };
      words.push(arg);
      continue;
    }
    const value = args[i + 1];
    if (value === undefined) return { error: `${arg} needs a value` };
    if (arg === "--policy") flags.policy = value;
    else if (arg === "--peer") flags.peer = value;
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
