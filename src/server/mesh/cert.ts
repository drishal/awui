// The mesh's TLS certificate (P2): TLS needs an X.509 certificate, but the
// mesh's trust never comes from one — identity is the pinned Ed25519 key the
// signed handshake presents, and a MITM terminating TLS on both sides fails
// that handshake on the channel binding. So the certificate here is the bare
// minimum a TLS stack accepts: hand-encoded DER (no dependency, no openssl
// call, nothing to shell out to), self-signed by a *dedicated* TLS key stored
// beside the identity — never the identity key itself, which other nodes pin
// and which must therefore never ride inside a TLS envelope. The file is
// written the way identity.ts writes its own: atomically, 0600, and a
// malformed one is a hard error, because silently replacing key material is
// how a node stops being itself.
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as cryptoSign, X509Certificate, type KeyObject } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

/** The Ed25519 signature algorithm's OID (1.3.101.112), DER-encoded as content bytes. */
const ED25519_OID = Buffer.from([0x2b, 0x65, 0x70]);
/** The commonName attribute's OID (2.5.4.3), DER-encoded as content bytes. */
const CN_OID = Buffer.from([0x55, 0x04, 0x03]);
/** One whole day, milliseconds: the cert is valid from one day ago (clock skew). */
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long the certificate lives: the same ~27 months public CAs settled on. */
const VALID_FOR_DAYS = 825;
/** Regenerate when less than this remains, so no restart ever serves an expired cert. */
const RENEW_WITHIN_MS = 30 * DAY_MS;

/** Where the dedicated TLS key lives: the state folder's mesh dir, mode 0600. */
export const tlsKeyFileOf = (stateDir: string): string => path.join(stateDir, "mesh", "tls-key.pem");
/** Where the certificate lives, beside its key. */
export const tlsCertFileOf = (stateDir: string): string => path.join(stateDir, "mesh", "tls-cert.pem");

/** DER length octets: short form under 128, long form (minimal, big-endian) above. */
function derLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

/** One DER TLV. */
function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

/** A positive INTEGER; a high set bit gets a leading zero so the value never reads as negative. */
function derInteger(bytes: Buffer): Buffer {
  const body = (bytes[0]! & 0x80) !== 0 ? Buffer.concat([Buffer.from([0]), bytes]) : bytes;
  return tlv(0x02, body);
}

/** One OID, tag 0x06, from its already-encoded content bytes. */
const derOid = (content: Buffer): Buffer => tlv(0x06, content);

/** A UTCTime, the form every 20xx date encodes in (GeneralizedTime is only owed past 2049). */
function utcTime(at: Date): Buffer {
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  return tlv(0x17, Buffer.from(`${p(at.getUTCFullYear() % 100)}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}Z`, "ascii"));
}

/** The one name both issuer and subject carry: CN=awui-mesh, nothing else worth asserting. */
function nameOf(): Buffer {
  const cn = tlv(0x30, Buffer.concat([derOid(CN_OID), tlv(0x0c, Buffer.from("awui-mesh", "utf8"))]));
  return tlv(0x30, tlv(0x31, cn));
}

/** PEM of any DER blob, wrapped at the conventional 64 columns. */
function pemOf(label: string, der: Buffer): string {
  const b64 = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${b64.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * A minimal self-signed X.509 v3 certificate for one Ed25519 key: version 3,
 * a 16-random-byte serial, Ed25519 throughout, issuer = subject = CN=awui-mesh,
 * no extensions (nothing needs them — the cert is only the TLS envelope, never
 * the trust), signed over its own DER TBSCertificate. `opts` exists so tests
 * can mint short-lived or stale certificates, not so callers tune the shape.
 */
export function buildSelfSignedCert(
  privateKey: KeyObject,
  opts: { notBefore?: Date; notAfter?: Date; serial?: Buffer; now?: Date } = {},
): string {
  const now = opts.now ?? new Date();
  const notBefore = opts.notBefore ?? new Date(now.getTime() - DAY_MS);
  const notAfter = opts.notAfter ?? new Date(now.getTime() + VALID_FOR_DAYS * DAY_MS);
  const serial = opts.serial ?? randomBytes(16);
  // Ed25519's AlgorithmIdentifier carries the OID and nothing else: RFC 8410
  // makes any parameters field invalid, so none is written.
  const sigAlg = tlv(0x30, derOid(ED25519_OID));
  const name = nameOf();
  const validity = tlv(0x30, Buffer.concat([utcTime(notBefore), utcTime(notAfter)]));
  // The public key in its SPKI wrapper, straight from the private half.
  const spki = Buffer.from(createPublicKey(privateKey).export({ type: "spki", format: "der" }));
  // [0] EXPLICIT version 3: the one field that makes this a v3 certificate.
  const version = tlv(0xa0, tlv(0x02, Buffer.from([2])));
  const tbs = tlv(0x30, Buffer.concat([version, derInteger(serial), sigAlg, name, validity, name, spki]));
  const sig = Buffer.from(cryptoSign(null, tbs, privateKey));
  // BIT STRING: one leading 0x00 byte for "no unused bits".
  const cert = tlv(0x30, Buffer.concat([tbs, sigAlg, tlv(0x03, Buffer.concat([Buffer.from([0]), sig]))]));
  return pemOf("CERTIFICATE", cert);
}

/** The raw 32 bytes a public key object holds, for matching a stored key against a cert. */
function rawOf(publicKey: KeyObject): Buffer {
  return Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
}

/**
 * Loads the dedicated TLS key, creating it on first use exactly the way
 * identity.ts creates the node key: temp file written `wx` then hard-linked
 * into place, so two processes starting at once can never each end up holding
 * a different key while only one is on disk. A file that exists but does not
 * parse is a hard error, never a regeneration.
 */
export async function loadOrCreateTlsKey(stateDir: string): Promise<{ key: KeyObject; pem: string }> {
  const file = tlsKeyFileOf(stateDir);
  const dir = path.dirname(file);
  let existing: string | null = null;
  try {
    existing = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`The mesh TLS key file ${file} could not be read: ${(error as Error).message}`);
  }
  if (existing !== null) {
    let key: KeyObject;
    try {
      key = createPrivateKey(existing);
      if (createPublicKey(key).asymmetricKeyType !== "ed25519") throw new Error("not an Ed25519 key");
    } catch (error) {
      throw new Error(`The mesh TLS key file ${file} is invalid (${error instanceof Error ? error.message : String(error)}). It was not regenerated: a new key would change the certificate peers see.`);
    }
    if (process.platform !== "win32") {
      const mode = (await fs.stat(file)).mode & 0o777;
      if ((mode & 0o177) !== 0 || mode > 0o600) await fs.chmod(file, 0o600);
    }
    return { key, pem: existing };
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await fs.chmod(dir, 0o700);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, pem, { flag: "wx", mode: 0o600 });
  try {
    await fs.link(tmp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // Another process created it first; theirs is the key.
    await fs.unlink(tmp).catch(() => undefined);
    return loadOrCreateTlsKey(stateDir);
  }
  await fs.unlink(tmp).catch(() => undefined);
  return { key: privateKey, pem };
}

/** What ensureTlsCertificate hands the listener: the key and certificate, both as the PEM tls.createServer takes. */
export interface TlsMaterial {
  keyPem: string;
  cert: string;
}

/**
 * The listener's certificate, renewed before it can expire: the stored cert is
 * reused while it parses, matches the stored key, and has more than 30 days
 * left; anything else (missing, corrupt, re-keyed, nearly expired) is
 * regenerated and written atomically. Renewal needs no restart — the daemon
 * re-checks periodically and restarts its listener on a new certificate.
 */
export async function ensureTlsCertificate(stateDir: string): Promise<TlsMaterial> {
  const { key, pem } = await loadOrCreateTlsKey(stateDir);
  const file = tlsCertFileOf(stateDir);
  let stored: string | null = null;
  try {
    stored = await fs.readFile(file, "utf8");
  } catch {
    stored = null;
  }
  if (stored !== null) {
    try {
      const cert = new X509Certificate(stored);
      if (rawOf(cert.publicKey).equals(rawOf(createPublicKey(key))) && Date.parse(cert.validTo) - Date.now() > RENEW_WITHIN_MS) return { keyPem: pem, cert: stored };
    } catch {
      // An unreadable or mismatched certificate is regenerated below, never served.
    }
  }
  const cert = buildSelfSignedCert(key);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(tmp, cert, { flag: "wx", mode: 0o600 });
  await fs.rename(tmp, file);
  return { keyPem: pem, cert };
}
