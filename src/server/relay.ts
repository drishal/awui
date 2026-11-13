// The encrypted relay protocol (E2's slice): an outbound-only tunnel from this awui
// server to a relay, so a paired device reaches the UI without a port forward. The
// relay is zero-knowledge: it holds ciphertext frames and a channel id, never a key
// or plaintext. Both sides derive the frame key from a one-time pairing secret with
// HKDF-SHA256; frames are AES-256-GCM (12-byte nonce, 16-byte tag), length-prefixed.
//
// Slice boundary (docs/security.md): one tunnel, one channel, reconnect by re-handshake,
// no multiplexing, and no hosted relay ships — the reference relay under contrib/relay/
// is what a person runs themselves. Nothing here opens an inbound port.
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";

/** The pairing secret's length (bytes): one-time, shown once as a base64url string. */
export const PAIRING_SECRET_BYTES = 32;
/** One frame's biggest ciphertext: bounded like every other payload (256 KB). */
export const MAX_FRAME_BYTES = 256 * 1024;
/** HKDF info string: domain separation, so the key is only a relay key. */
const HKDF_INFO = "awui-relay-frame-v1";

/** The frame key both sides derive from the pairing secret. */
export function frameKey(secret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", Buffer.from(secret, "base64url"), Buffer.alloc(0), HKDF_INFO, 32));
}

/** A channel id: derived from the secret, so the relay never sees the secret itself. */
export function channelIdOf(secret: string): string {
  return createHmac("sha256", frameKey(secret)).update("channel-id").digest("base64url").slice(0, 32);
}

/** One frame as the wire sees it: nonce + ciphertext + tag, length-prefixed by the caller. */
export function sealFrame(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const sealed = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([nonce, sealed]);
}

export function openFrame(key: Buffer, frame: Buffer): Buffer | null {
  if (frame.length < 12 + 16) return null;
  const nonce = frame.subarray(0, 12);
  const tag = frame.subarray(frame.length - 16);
  const body = frame.subarray(12, frame.length - 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    return null; // A tampered or foreign frame is dropped, never trusted.
  }
}

/** One pairing secret, shown once: base64url, the client and the relay both derive from it. */
export function pairingSecret(): string {
  return randomBytes(PAIRING_SECRET_BYTES).toString("base64url");
}

/** Constant-time comparison for a presented secret against the channel it claims. */
export function secretMatches(presented: string, secret: string): boolean {
  const a = Buffer.from(channelIdOf(presented));
  const b = Buffer.from(channelIdOf(secret));
  return a.length === b.length && timingSafeEqual(a, b);
}
