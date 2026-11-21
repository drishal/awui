// Mesh pins (P1): the peers this machine already trusts, in the state folder.
// A pin is an Ed25519 public key — the only identity in the mesh, since names
// and addresses change and keys do not. The store is one small JSON file read
// fresh from disk on every call (the spec re-reads pins per call, so a pin
// written by another process, or a revocation, is seen immediately) and
// written whole through a temp file and a rename, one write at a time. A
// malformed file is a hard error, never a silent reset: resetting would
// quietly turn every paired peer into a stranger. Node ids are always
// recomputed from the stored public key and never read back from the file, so
// the file cannot lie about who a key is.
import { promises as fs } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { nodeIdOf } from "./identity.js";

/** How many pending (seen but not yet accepted) requests may be remembered. */
const MAX_PENDING = 16;
/** A pending request older than this is stale and pruned on the next write. */
const PENDING_TTL_MS = 60 * 60 * 1000;
/** A peer name as config.yml spells it (P0). */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** A policy name: the built-ins and anything configured both match this (P0). */
const POLICY_RE = /^[a-z0-9_-]{1,32}$/;

/** What this machine pinned about a peer it connects to, keyed by that peer's configured name. */
export interface OutboundPin {
  publicKey: Buffer;
  nodeId: string;
  pinnedAt: number;
}

/** What this machine accepted about a peer that connects to it, keyed by that peer's node id. */
export interface InboundPin {
  publicKey: Buffer;
  name: string;
  policy: string;
  pinnedAt: number;
  via: "accept" | "forced";
}

/** A peer that said hello but was never accepted; recorded so a person can compare before saying yes. */
export interface PendingPin {
  publicKey: Buffer;
  name: string;
  seenAt: number;
}

export interface PinStore {
  /** The pin for a configured peer name, or null when this peer was never pinned. */
  outbound(name: string): Promise<OutboundPin | null>;
  /** Pins (or re-pins) a peer's key under its configured name. */
  setOutbound(name: string, publicKey: Buffer): Promise<void>;
  /** The pin for a node id, or null when this node was never accepted. */
  inbound(nodeId: string): Promise<InboundPin | null>;
  /** The newest inbound pin under a peer name, or null. */
  inboundByName(name: string): Promise<InboundPin | null>;
  /** Accepts (or re-accepts) a peer's key with a name and the policy it is held to. */
  setInbound(publicKey: Buffer, name: string, policy: string, via: "accept" | "forced"): Promise<void>;
  /** Records that an unpinned peer said hello; capped and pruned by age on write. */
  addPending(publicKey: Buffer, name: string): Promise<void>;
  /** The newest pending request under a peer name, or null. */
  pending(name: string): Promise<PendingPin | null>;
  /** Drops the outbound pin, every inbound pin, and every pending record under a peer name. */
  removeByName(name: string): Promise<void>;
  /** The whole store, read-only, as a listing shows it (node ids recomputed from the keys). */
  snapshot(): Promise<PinSnapshot>;
}

/** What a listing reads back: every pin's name and node id, never the raw file. */
export interface PinSnapshot {
  outbound: Array<{ name: string; nodeId: string; pinnedAt: number }>;
  inbound: Array<{ name: string; policy: string; nodeId: string; pinnedAt: number; via: "accept" | "forced" }>;
  pending: Array<{ name: string; nodeId: string; seenAt: number }>;
}

/** The in-memory state between one read and one write; keys for inbound/pending are recomputed node ids. */
interface PinState {
  outbound: Map<string, { publicKey: Buffer; pinnedAt: number }>;
  inbound: Map<string, InboundPin>;
  pending: Map<string, { publicKey: Buffer; name: string; seenAt: number }>;
}

const emptyState = (): PinState => ({ outbound: new Map(), inbound: new Map(), pending: new Map() });

function fail(file: string, reason: string): Error {
  return new Error(`The mesh pins file ${file} is invalid (${reason}). It was not reset: a reset would forget every peer this machine has paired with.`);
}

/** Decodes a stored public key: charset checked first, because Buffer.from silently skips bad characters. */
function decodeKey(file: string, where: string, value: unknown): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw fail(file, `${where} has no base64url publicKey`);
  const publicKey = Buffer.from(value, "base64url");
  if (publicKey.length !== 32) throw fail(file, `${where} has a public key that is not 32 bytes`);
  return publicKey;
}

function numberField(file: string, where: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw fail(file, `${where} has a non-numeric timestamp`);
  return value;
}

/** One section of the file as entries, or {} when absent; anything else is a hard error. */
function entries(file: string, record: Record<string, unknown>, section: string): [string, Record<string, unknown>][] {
  const value = record[section];
  if (value === undefined) return [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw fail(file, `"${section}" is not an object`);
  return Object.entries(value).map(([key, entry]) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw fail(file, `the ${section} entry "${key}" is not an object`);
    return [key, entry as Record<string, unknown>] as [string, Record<string, unknown>];
  });
}

/** Parses the whole file. Everything is validated; a stored nodeId is read but never believed. */
function parseState(file: string, text: string): PinState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail(file, "not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw fail(file, "not an object");
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) throw fail(file, "unsupported version");
  const state = emptyState();
  for (const [name, entry] of entries(file, record, "outbound")) {
    if (!NAME_RE.test(name)) throw fail(file, `the outbound pin name "${name}" is not a peer name`);
    state.outbound.set(name, { publicKey: decodeKey(file, `the outbound pin "${name}"`, entry.publicKey), pinnedAt: numberField(file, `the outbound pin "${name}"`, entry.pinnedAt) });
  }
  for (const [, entry] of entries(file, record, "inbound")) {
    const where = `the inbound pin for "${typeof entry.name === "string" ? entry.name : "?"}"`;
    if (typeof entry.name !== "string" || !NAME_RE.test(entry.name)) throw fail(file, `${where} has no valid name`);
    if (typeof entry.policy !== "string" || !POLICY_RE.test(entry.policy)) throw fail(file, `${where} has no valid policy name`);
    if (entry.via !== "accept" && entry.via !== "forced") throw fail(file, `${where} has no valid via`);
    const publicKey = decodeKey(file, where, entry.publicKey);
    state.inbound.set(nodeIdOf(publicKey), { publicKey, name: entry.name, policy: entry.policy, pinnedAt: numberField(file, where, entry.pinnedAt), via: entry.via });
  }
  for (const [, entry] of entries(file, record, "pending")) {
    const where = `the pending entry for "${typeof entry.name === "string" ? entry.name : "?"}"`;
    if (typeof entry.name !== "string" || !NAME_RE.test(entry.name)) throw fail(file, `${where} has no valid name`);
    const publicKey = decodeKey(file, where, entry.publicKey);
    state.pending.set(nodeIdOf(publicKey), { publicKey, name: entry.name, seenAt: numberField(file, where, entry.seenAt) });
  }
  return state;
}

/** Reads the file fresh: missing means empty, malformed is a hard error, and nothing is cached. */
async function readState(file: string): Promise<PinState> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw new Error(`The mesh pins file ${file} could not be read: ${(error as Error).message}`);
  }
  return parseState(file, text);
}

/** The file's on-disk shape; node ids are written for a person to read and recomputed on the way back in. */
function toRecord(state: PinState): Record<string, unknown> {
  return {
    v: 1,
    outbound: Object.fromEntries(
      [...state.outbound].map(([name, pin]) => [name, { publicKey: pin.publicKey.toString("base64url"), nodeId: nodeIdOf(pin.publicKey), pinnedAt: pin.pinnedAt }]),
    ),
    inbound: Object.fromEntries(
      [...state.inbound].map(([id, pin]) => [id, { publicKey: pin.publicKey.toString("base64url"), name: pin.name, policy: pin.policy, pinnedAt: pin.pinnedAt, via: pin.via }]),
    ),
    pending: Object.fromEntries([...state.pending].map(([id, pin]) => [id, { publicKey: pin.publicKey.toString("base64url"), name: pin.name, seenAt: pin.seenAt }])),
  };
}

/** One whole-file write: a temp file created `wx` (two writers never share one) then renamed into place. */
async function writeState(file: string, state: PinState): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(dir, 0o700);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(toRecord(state))}\n`, { flag: "wx", mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Drops stale pending entries, then the oldest ones down to the cap, so the newest survive. */
function prune(state: PinState): void {
  const now = Date.now();
  for (const [id, entry] of state.pending) if (now - entry.seenAt > PENDING_TTL_MS) state.pending.delete(id);
  while (state.pending.size > MAX_PENDING) {
    let oldest: string | null = null;
    let oldestSeen = Infinity;
    for (const [id, entry] of state.pending) {
      if (entry.seenAt < oldestSeen) {
        oldestSeen = entry.seenAt;
        oldest = id;
      }
    }
    // Ties keep insertion order, so the first-seen of a same-moment batch is the one dropped.
    if (oldest === null) break;
    state.pending.delete(oldest);
  }
}

class Pins implements PinStore {
  /** One pending write; the next mutation queues behind it, so read-modify-writes never interleave. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async outbound(name: string): Promise<OutboundPin | null> {
    const pin = (await readState(this.file)).outbound.get(name);
    return pin === undefined ? null : { publicKey: pin.publicKey, nodeId: nodeIdOf(pin.publicKey), pinnedAt: pin.pinnedAt };
  }

  setOutbound(name: string, publicKey: Buffer): Promise<void> {
    if (!NAME_RE.test(name)) return Promise.reject(new Error(`a peer name must match ${NAME_RE}`));
    if (publicKey.length !== 32) return Promise.reject(new Error("a pinned public key must be 32 bytes"));
    return this.mutate((state) => {
      state.outbound.set(name, { publicKey, pinnedAt: Date.now() });
    });
  }

  async inbound(nodeId: string): Promise<InboundPin | null> {
    return (await readState(this.file)).inbound.get(nodeId) ?? null;
  }

  async inboundByName(name: string): Promise<InboundPin | null> {
    let found: InboundPin | null = null;
    for (const pin of (await readState(this.file)).inbound.values()) {
      if (pin.name === name && (found === null || pin.pinnedAt > found.pinnedAt)) found = pin;
    }
    return found;
  }

  setInbound(publicKey: Buffer, name: string, policy: string, via: "accept" | "forced"): Promise<void> {
    if (publicKey.length !== 32) return Promise.reject(new Error("a pinned public key must be 32 bytes"));
    if (!NAME_RE.test(name)) return Promise.reject(new Error(`a peer name must match ${NAME_RE}`));
    if (!POLICY_RE.test(policy)) return Promise.reject(new Error(`a policy name must match ${POLICY_RE}`));
    return this.mutate((state) => {
      state.inbound.set(nodeIdOf(publicKey), { publicKey, name, policy, pinnedAt: Date.now(), via });
    });
  }

  addPending(publicKey: Buffer, name: string): Promise<void> {
    if (publicKey.length !== 32) return Promise.reject(new Error("a pending public key must be 32 bytes"));
    if (!NAME_RE.test(name)) return Promise.reject(new Error(`a peer name must match ${NAME_RE}`));
    return this.mutate((state) => {
      state.pending.set(nodeIdOf(publicKey), { publicKey, name, seenAt: Date.now() });
    });
  }

  async pending(name: string): Promise<PendingPin | null> {
    let found: PendingPin | null = null;
    for (const entry of (await readState(this.file)).pending.values()) {
      if (entry.name === name && (found === null || entry.seenAt > found.seenAt)) found = { publicKey: entry.publicKey, name: entry.name, seenAt: entry.seenAt };
    }
    return found;
  }

  async snapshot(): Promise<PinSnapshot> {
    const state = await readState(this.file);
    const byName = (a: { name: string }, b: { name: string }): number => a.name.localeCompare(b.name);
    return {
      outbound: [...state.outbound].map(([name, pin]) => ({ name, nodeId: nodeIdOf(pin.publicKey), pinnedAt: pin.pinnedAt })).sort(byName),
      inbound: [...state.inbound.values()].map((pin) => ({ name: pin.name, policy: pin.policy, nodeId: nodeIdOf(pin.publicKey), pinnedAt: pin.pinnedAt, via: pin.via })).sort(byName),
      pending: [...state.pending.values()].map((entry) => ({ name: entry.name, nodeId: nodeIdOf(entry.publicKey), seenAt: entry.seenAt })).sort(byName),
    };
  }

  removeByName(name: string): Promise<void> {
    return this.mutate((state) => {
      state.outbound.delete(name);
      for (const [id, pin] of state.inbound) if (pin.name === name) state.inbound.delete(id);
      for (const [id, entry] of state.pending) if (entry.name === name) state.pending.delete(id);
    });
  }

  /** One serialized mutation: the freshest on-disk state, changed, pruned, written whole. */
  private mutate(change: (state: PinState) => void): Promise<void> {
    const file = this.file;
    const run = async (): Promise<void> => {
      const state = await readState(file);
      change(state);
      prune(state);
      await writeState(file, state);
    };
    const next = this.chain.then(run, run);
    // The chain the next mutation queues behind never carries this one's failure.
    this.chain = next.catch(() => undefined);
    return next;
  }
}

/** The pins for one state folder's mesh dir, exactly as the spec's file path is passed in. */
export function PinStore(file: string): PinStore {
  return new Pins(file);
}
