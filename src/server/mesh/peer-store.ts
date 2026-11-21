// Mesh peers added from the UI or CLI (P2): config.yml is not the only place a
// peer can live — pairing from the Settings dialog or a join writes here, so
// a person never has to edit YAML to add a machine. The store is one small
// JSON file in the state folder, written atomically like pins.json, validated
// with the exact same entry schema config.yml uses (so a peer is one shape
// wherever it came from), capped at the same 64, and merged with config's
// list wherever both name a peer — config wins, because a checked-in file
// outranks local state. A malformed file is a hard error, never a reset:
// forgetting a peer must be a decision, not a side effect.
import { promises as fs, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { meshPeerSchema, MAX_MESH_PEERS, type MeshConfig } from "../user-config.js";

/** One peer entry, exactly the shape config.yml's `mesh.peers[]` takes. */
export type MeshPeerEntry = NonNullable<MeshConfig["peers"]>[number];

/** The on-disk shape: a version and a flat list, nothing else ever rides along. */
interface PeerFileShape {
  v: 1;
  peers: MeshPeerEntry[];
}

/** One named refusal for a file this node refuses to serve from a broken copy of. */
function fail(file: string, reason: string): Error {
  return new Error(`The mesh peers file ${file} is invalid (${reason}). It was not reset: a reset would forget every peer added from the UI.`);
}

/** Parses the whole file; every entry is validated against the config schema, so the two sources agree on one shape. */
function parseFile(file: string, text: string): MeshPeerEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail(file, "not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw fail(file, "not an object");
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) throw fail(file, "unsupported version");
  if (!Array.isArray(record.peers)) throw fail(file, '"peers" is not an array');
  if (record.peers.length > MAX_MESH_PEERS) throw fail(file, `more than ${MAX_MESH_PEERS} peers`);
  const seen = new Set<string>();
  const peers: MeshPeerEntry[] = [];
  for (const [index, entry] of record.peers.entries()) {
    const validated = meshPeerSchema.safeParse(entry);
    if (!validated.success) throw fail(file, `the peer at index ${index} is not the shape config.yml takes (${validated.error.issues[0]?.message ?? "invalid"})`);
    const key = validated.data.name.toLowerCase();
    if (seen.has(key)) throw fail(file, `"${validated.data.name}" is defined twice`);
    seen.add(key);
    peers.push(validated.data);
  }
  return peers;
}

/** One whole-file write: temp file created `wx` (two writers never share one) then renamed into place, mode 0600. */
async function writeFile(file: string, peers: MeshPeerEntry[]): Promise<void> {
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(dir, 0o700);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const record: PeerFileShape = { v: 1, peers };
  await fs.writeFile(tmp, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
  await fs.rename(tmp, file);
}

export interface MeshPeerStore {
  /** Every saved peer, validated on the way in; an empty file and no file are the same empty list. */
  list(): Promise<MeshPeerEntry[]>;
  /** Saves one peer. Refuses a duplicate name in this file and the 64-entry cap; a name config.yml also uses is allowed here and shadowed at merge time. */
  add(entry: unknown): Promise<void>;
  /** Forgets the peer saved under this name (case-insensitively). */
  remove(name: string): Promise<void>;
  /**
   * The same list, read synchronously and cached by (mtime, size): the
   * manager's per-call lookup, where a write from the CLI, another process,
   * must land on the next lookup, not the next restart. Malformed is a thrown
   * error, like every read.
   */
  snapshot(): MeshPeerEntry[];
}

/** The peers of one state folder's `mesh/peers.json`. */
export function PeerPeersStore(file: string): MeshPeerStore {
  /** One pending write; the next mutation queues behind it, so read-modify-writes never interleave. */
  let chain: Promise<unknown> = Promise.resolve();
  let cachedKey: string | null = null;
  let cached: MeshPeerEntry[] = [];

  const read = async (): Promise<MeshPeerEntry[]> => {
    let text: string;
    try {
      text = await fs.readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error(`The mesh peers file ${file} could not be read: ${(error as Error).message}`);
    }
    return parseFile(file, text);
  };

  const mutate = (change: (peers: MeshPeerEntry[]) => MeshPeerEntry[]): Promise<void> => {
    const run = async (): Promise<void> => {
      const peers = change(await read());
      await writeFile(file, peers);
    };
    const next = chain.then(run, run);
    chain = next.catch(() => undefined);
    return next;
  };

  return {
    list: read,
    add(entry: unknown): Promise<void> {
      const validated = meshPeerSchema.safeParse(entry);
      if (!validated.success) {
        return Promise.reject(new Error(`a saved mesh peer must be the shape config.yml takes (${validated.error.issues[0]?.message ?? "invalid"})`));
      }
      return mutate((peers) => {
        const key = validated.data.name.toLowerCase();
        if (peers.some((peer) => peer.name.toLowerCase() === key)) throw new Error(`a mesh peer called "${validated.data.name}" is already saved`);
        if (peers.length >= MAX_MESH_PEERS) throw new Error(`the mesh peers file holds its maximum of ${MAX_MESH_PEERS} peers`);
        // Newest last: what a listing shows, and what a person reading the file expects.
        return [...peers, validated.data];
      });
    },
    remove(name: string): Promise<void> {
      return mutate((peers) => peers.filter((peer) => peer.name.toLowerCase() !== name.toLowerCase()));
    },
    snapshot(): MeshPeerEntry[] {
      let key: string | null = null;
      try {
        const st = statSync(file);
        key = `${st.mtimeMs}:${st.size}`;
      } catch {
        key = null;
      }
      // mtime and size together are the cache key: a same-size rewrite from
      // another process still changes the mtime, and a missing file is its own.
      if (key !== null && key === cachedKey) return cached;
      cachedKey = key;
      cached = key === null ? [] : parseFile(file, readFileSync(file, "utf8"));
      return cached;
    },
  };
}

/**
 * The list the manager works from: config.yml's peers plus the saved ones,
 * config winning wherever both name the same peer (a checked-in file outranks
 * local state), each source keeping its own order otherwise.
 */
export function mergePeers(config: MeshPeerEntry[], saved: MeshPeerEntry[]): MeshPeerEntry[] {
  const taken = new Set(config.map((peer) => peer.name.toLowerCase()));
  return [...config, ...saved.filter((peer) => !taken.has(peer.name.toLowerCase()))];
}
