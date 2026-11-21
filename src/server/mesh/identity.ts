// Mesh node identity (P0): one Ed25519 keypair per machine, held in the state
// folder and never regenerated. Discovery names change; this key is the
// identity other nodes pin, so a silently replaced key would break every pin
// and look like a different machine. The nodeId is Syncthing-like (base32 of
// the public key's SHA-256, dashed groups) so a person can compare two of them
// by eye, and the SAS digits are what two people read aloud to each other
// after a first handshake: both sides must derive the same six digits from
// the same two keys, in whichever order they hold them.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** The RFC4648 base32 alphabet, uppercase, no padding: what a nodeId is read in. */
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** The SPKI DER prefix that wraps a raw 32-byte Ed25519 public key for node:crypto. */
const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex");

export interface NodeIdentity {
  /** The public key as raw 32 bytes, as it travels on the wire and is pinned. */
  publicKey: Buffer;
  privateKey: KeyObject;
  nodeId: string;
}

/** Raw base32 (no padding) of any buffer; used for nodeIds only. */
function base32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  // The last partial group is zero-padded on the right; a 32-byte input ends exactly at 52 chars.
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]!;
  return out;
}

/**
 * The node's stable name: base32 (uppercase, no padding) of SHA-256(publicKey),
 * first 52 chars in 7-char groups joined by "-". Pure and deterministic, so
 * both sides of a handshake print the same string for the same key.
 */
export function nodeIdOf(publicKey: Buffer): string {
  const chars = base32(createHash("sha256").update(publicKey).digest()).slice(0, 52);
  const groups: string[] = [];
  for (let i = 0; i < chars.length; i += 7) groups.push(chars.slice(i, i + 7));
  return groups.join("-");
}

/** The lexicographically first of two buffers: both sides sort, so they hash the same bytes. */
function minBuffer(a: Buffer, b: Buffer): Buffer {
  return Buffer.compare(a, b) <= 0 ? a : b;
}

/**
 * The six-digit SAS a person reads aloud after a first contact: derived from
 * the two public keys (byte-order sorted, so each side computes the same value
 * whichever key is "mine") and the handshake's context string, which keeps one
 * session's digits useless as a confirmation of another.
 */
export function sasOf(a: Buffer, b: Buffer, context: string): string {
  const lo = minBuffer(a, b);
  const hi = lo === a ? b : a;
  const digest = createHash("sha256").update(Buffer.concat([Buffer.from(`awui-mesh-sas/1\n${context}\n`, "utf8"), lo, hi])).digest();
  const six = digest.readUInt32BE(0) % 1_000_000;
  const digits = String(six).padStart(6, "0");
  return `${digits.slice(0, 3)} ${digits.slice(3)}`;
}

/** Wraps a raw 32-byte Ed25519 public key in its SPKI DER prefix as a KeyObject. */
export function publicKeyObject(raw: Buffer): KeyObject {
  return createPublicKey({ key: Buffer.concat([ED25519_SPKI, raw]), format: "der", type: "spki" });
}

/** The raw 32 bytes of a private key's own public key. */
function rawOf(privateKey: KeyObject): Buffer {
  return createPublicKey(privateKey).export({ type: "spki", format: "der" }).subarray(-32);
}

/** One Ed25519 signature over data, made with the node's own identity key. */
export function sign(identity: NodeIdentity, data: Buffer): Buffer {
  return Buffer.from(cryptoSign(null, data, identity.privateKey));
}

/**
 * Whether sig is a valid signature of data under publicKey. Malformed keys,
 * signatures, or data are false, never a throw: a bad packet is dropped, not a
 * crash.
 */
export function verify(publicKey: Buffer, data: Buffer, sig: Buffer): boolean {
  if (publicKey.length !== 32 || sig.length !== 64) return false;
  try {
    return cryptoVerify(null, data, publicKeyObject(publicKey), sig);
  } catch {
    return false;
  }
}

/** Where the identity lives: the state folder's mesh dir, mode 0700. */
export const identityFileOf = (stateDir: string): string => path.join(stateDir, "mesh", "identity.json");

interface IdentityFile {
  v: 1;
  publicKey: string;
  privateKey: string;
}

/** Reads and validates an existing identity file; every failure is a thrown, named error. */
function parseIdentityFile(file: string, text: string): { publicKey: Buffer; privateKey: KeyObject } {
  const fail = (reason: string): Error =>
    new Error(`The mesh identity file ${file} is invalid (${reason}). It was not regenerated: a new identity would break the peers pinned to this one.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw fail("not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw fail("not an object");
  const record = parsed as Record<string, unknown>;
  if (record.v !== 1) throw fail("unsupported version");
  if (typeof record.publicKey !== "string" || typeof record.privateKey !== "string") throw fail("missing key material");
  const publicKey = Buffer.from(record.publicKey, "base64url");
  if (publicKey.length !== 32) throw fail("the stored public key is not 32 bytes");
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(record.privateKey);
  } catch {
    throw fail("the stored private key cannot be parsed");
  }
  // The stored public key must be the one the stored private key actually derives:
  // a mismatched pair would sign as one node and present as another.
  if (!rawOf(privateKey).equals(publicKey)) throw fail("the stored private key does not match the stored public key");
  return { publicKey, privateKey };
}

/**
 * Loads the node's identity, creating it on first run. Creation is atomic
 * (temp file written `wx`, then renamed over) and never happens when a file is
 * merely malformed: a broken file is a hard error, because regenerating it
 * would silently change who this node is. On POSIX an existing file looser
 * than 0600 is tightened, since the file holds the private key.
 */
export async function loadOrCreateIdentity(stateDir: string): Promise<NodeIdentity> {
  const file = identityFileOf(stateDir);
  const dir = path.dirname(file);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(file, "utf8");
  } catch (error) {
    // Only a missing file means first run; an unreadable one is never overwritten.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`The mesh identity file ${file} could not be read: ${(error as Error).message}`);
  }
  if (existing !== null) {
    const { publicKey, privateKey } = parseIdentityFile(file, existing);
    if (process.platform !== "win32") {
      const mode = (await fs.stat(file)).mode & 0o777;
      // Looser than 0600 is any group/other bit, or a set of owner bits beyond it.
      if ((mode & 0o177) !== 0 || mode > 0o600) await fs.chmod(file, 0o600);
    }
    return { publicKey, privateKey, nodeId: nodeIdOf(publicKey) };
  }
  const { publicKey: rawPublic, privateKey } = generateKeyPairSync("ed25519");
  const publicKey = Buffer.from(rawPublic.export({ type: "spki", format: "der" }).subarray(-32));
  const record: IdentityFile = {
    v: 1,
    publicKey: publicKey.toString("base64url"),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(dir, 0o700);
  // `wx` fails if the temp name is taken, so a concurrent creator never writes over
  // another's temp. The temp is then hard-linked into place, which (unlike rename)
  // fails when the identity already exists: two processes starting at once can never
  // each return a different key while only one of them is on disk.
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
  try {
    await fs.link(tmp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another process created it first: theirs is the identity.
    await fs.unlink(tmp).catch(() => undefined);
    return loadOrCreateIdentity(stateDir);
  }
  await fs.unlink(tmp).catch(() => undefined);
  return { publicKey, privateKey, nodeId: nodeIdOf(publicKey) };
}
