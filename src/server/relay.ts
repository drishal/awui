// The encrypted relay protocol (E2's slice): an outbound-only tunnel from this awui
// server to a relay, so a paired device reaches the UI without a port forward. The
// relay is zero-knowledge: it holds ciphertext frames, their channel id, and a hash
// of the pairing secret, never a key or plaintext.
//
// What the wire promises:
//   - one frame key per direction, derived from a one-time pairing secret with
//     HKDF-SHA256 (info `awui-relay-c2s` / `awui-relay-s2c`), so a reflected frame
//     never opens: each side encrypts with the key only it sends with;
//   - frames are AES-256-GCM with a fresh 12-byte nonce and the direction plus a
//     monotonic counter as associated data, so a receiver that already accepted
//     counter N drops any frame with a counter at or below N (a replay or reorder);
//   - the counter travels in the frame's own 4-byte header, so the receiver can check
//     it before decrypting;
//   - the relay sees only the secret's SHA-256 in the `x-awui-relay-key` header, never
//     the secret, a key, or plaintext, and drops acknowledged frames.
//
// Slice boundary (docs/security.md): one tunnel, one channel, reconnect by re-handshake,
// no multiplexing, and no hosted relay ships — the reference relay under contrib/relay/
// is what a person runs themselves. Nothing here opens an inbound port.
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** The pairing secret's length (bytes): one-time, shown once as a base64url string. */
export const PAIRING_SECRET_BYTES = 32;
/** One frame's biggest ciphertext: bounded like every other payload (256 KB). */
export const MAX_FRAME_BYTES = 256 * 1024;
/** The direction a frame is sealed for. Each has its own key and its own counter space. */
export type RelayDirection = "c2s" | "s2c";

/** HKDF info per direction: domain separation, so one side's key never opens the other's frames. */
const KEY_INFO: Record<RelayDirection, string> = { c2s: "awui-relay-c2s", s2c: "awui-relay-s2c" };
/** The channel id's own derivation, neither direction's key. */
const CHANNEL_INFO = "awui-relay-channel-id";
/** The 4-byte counter header precedes the nonce; the tag ends the frame. */
const HEADER_BYTES = 4;

/** The frame key one direction sends with (both sides derive both, each sends with one). */
export function frameKey(secret: string, direction: RelayDirection): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), Buffer.alloc(0), KEY_INFO[direction], 32));
}

/** A channel id: derived from the secret's own domain, so the relay never sees the secret itself. */
export function channelIdOf(secret: string): string {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), Buffer.alloc(0), CHANNEL_INFO, 32)).toString("base64url").slice(0, 32);
}

/** What the relay stores and checks in its header: SHA-256 of the pairing secret, never the secret. */
export function channelKeyHash(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

/** The associated data a frame is bound to: its direction and counter, which the receiver re-derives. */
function associated(direction: RelayDirection, counter: number): Buffer {
  return Buffer.from(`awui-relay-frame:${direction}:${counter}`, "utf8");
}

function assertCounter(counter: number): void {
  if (!Number.isInteger(counter) || counter < 1 || counter > 0xffffffff) throw new RangeError("A relay frame's counter is a positive 32-bit integer");
}

/**
 * One frame as the wire sees it: `[counter:u32][nonce:12][ciphertext][tag:16]`, bound
 * to its direction and counter. The caller keeps the counter monotonic per direction.
 */
export function sealFrame(key: Buffer, direction: RelayDirection, counter: number, plaintext: Buffer): Buffer {
  assertCounter(counter);
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(counter);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(associated(direction, counter));
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([header, nonce, sealed]);
}

/**
 * Open one frame for `direction`, refusing any counter at or below `after` (the newest
 * one this receiver accepted) before touching the cipher. Null on a replayed, reflected,
 * reordered, wrong-direction, foreign-key, or tampered frame.
 */
export function openFrame(key: Buffer, direction: RelayDirection, frame: Buffer, after: number): { counter: number; plaintext: Buffer } | null {
  if (frame.length < HEADER_BYTES + 12 + 16) return null;
  const counter = frame.readUInt32BE(0);
  if (counter <= after) return null;
  const nonce = frame.subarray(HEADER_BYTES, HEADER_BYTES + 12);
  const tag = frame.subarray(frame.length - 16);
  const body = frame.subarray(HEADER_BYTES + 12, frame.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(associated(direction, counter));
    decipher.setAuthTag(tag);
    return { counter, plaintext: Buffer.concat([decipher.update(body), decipher.final()]) };
  } catch {
    return null; // A tampered, foreign, or reflected frame is dropped, never trusted.
  }
}

/** One pairing secret, shown once: base64url, the client and the relay both derive from it. */
export function pairingSecret(): string {
  return randomBytes(PAIRING_SECRET_BYTES).toString("base64url");
}

/** Constant-time comparison of a presented secret hash against the one this secret derives. */
export function secretMatches(presentedHash: string, secret: string): boolean {
  const a = Buffer.from(presentedHash, "utf8");
  const b = Buffer.from(channelKeyHash(secret), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
