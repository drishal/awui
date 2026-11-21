// Mesh identity (identity.ts): the node's keypair on disk (created once, never
// regenerated), the nodeId and SAS forms a person compares by eye or aloud, and
// the Ed25519 signatures a peer's requests arrive under.
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { identityFileOf, loadOrCreateIdentity, nodeIdOf, publicKeyObject, sasOf, sign, verify } from "../../src/server/mesh/identity.js";

/** A scratch state folder, as the server's state dir is one: created fresh per test. */
const stateDir = (): string => mkdtempSync(path.join(tmpdir(), "awui-mesh-identity-"));

describe("node ids", () => {
  it("derives a stable dashed base32 id from the public key", () => {
    const key = Buffer.alloc(32, 7);
    const id = nodeIdOf(key);
    // 52 base32 chars (a 32-byte digest's whole encoding) in 7-char groups.
    expect(id).toMatch(/^[A-Z2-7]{7}(-[A-Z2-7]{7}){6}-[A-Z2-7]{3}$/);
    expect(nodeIdOf(key)).toBe(id);
    expect(nodeIdOf(Buffer.alloc(32, 8))).not.toBe(id);
  });

  it("is the base32 of the key's SHA-256, not of the key itself", () => {
    const key = Buffer.alloc(32, 3);
    // An independent read of the same derivation, so the format is pinned by the
    // test and not just self-consistent with the implementation.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    const digest = createHash("sha256").update(key).digest();
    let bits = 0;
    let value = 0;
    let expected = "";
    for (const byte of digest) {
      value = (value << 8) | byte;
      bits += 8;
      while (bits >= 5) {
        expected += alphabet[(value >>> (bits - 5)) & 31]!;
        bits -= 5;
      }
    }
    if (bits > 0) expected += alphabet[(value << (5 - bits)) & 31]!;
    expect(nodeIdOf(key).replaceAll("-", "")).toBe(expected);
  });
});

describe("the SAS", () => {
  const a = Buffer.alloc(32, 1);
  const b = Buffer.alloc(32, 2);

  it("is symmetric in the two keys, and moves with key and context", () => {
    expect(sasOf(a, b, "handshake-1")).toMatch(/^\d{3} \d{3}$/);
    expect(sasOf(b, a, "handshake-1")).toBe(sasOf(a, b, "handshake-1"));
    expect(sasOf(a, b, "handshake-2")).not.toBe(sasOf(a, b, "handshake-1"));
    expect(sasOf(a, Buffer.alloc(32, 9), "handshake-1")).not.toBe(sasOf(a, b, "handshake-1"));
  });

  it("is the fixed domain, the context, and both keys in byte order", () => {
    const [lo, hi] = Buffer.compare(a, b) <= 0 ? [a, b] : [b, a];
    const digest = createHash("sha256")
      .update(Buffer.concat([Buffer.from("awui-mesh-sas/1handshake-1", "utf8"), lo, hi]))
      .digest();
    const digits = (digest.readUInt32BE(0) % 1_000_000).toString().padStart(6, "0");
    expect(sasOf(a, b, "handshake-1")).toBe(`${digits.slice(0, 3)} ${digits.slice(3)}`);
  });
});

describe("signatures", () => {
  it("round-trips, and refuses a wrong key, edited data, or garbage", async () => {
    const identity = await loadOrCreateIdentity(stateDir());
    const data = Buffer.from("a peer's request");
    const sig = sign(identity, data);
    expect(sig).toHaveLength(64);
    expect(verify(identity.publicKey, data, sig)).toBe(true);
    // A different key, edited data, or malformed inputs are false, never a throw.
    expect(verify(Buffer.alloc(32, 9), data, sig)).toBe(false);
    expect(verify(identity.publicKey, Buffer.from("edited"), sig)).toBe(false);
    expect(verify(identity.publicKey, data, Buffer.alloc(64))).toBe(false);
    expect(verify(identity.publicKey, data, sig.subarray(0, 63))).toBe(false);
    expect(verify(Buffer.alloc(31), data, sig)).toBe(false);
  });

  it("wraps a raw public key in the SPKI prefix node:crypto wants", async () => {
    const identity = await loadOrCreateIdentity(stateDir());
    const spki = Buffer.from(publicKeyObject(identity.publicKey).export({ type: "spki", format: "der" }));
    expect(spki.subarray(-32)).toEqual(identity.publicKey);
    expect(spki.subarray(0, 12)).toEqual(Buffer.from("302a300506032b6570032100", "hex"));
  });
});

describe("the identity file", () => {
  it("is created once, reloaded unchanged, and kept 0700/0600", async () => {
    const dir = stateDir();
    const file = identityFileOf(dir);
    expect(file).toBe(path.join(dir, "mesh", "identity.json"));
    const first = await loadOrCreateIdentity(dir);
    expect(first.publicKey).toHaveLength(32);
    expect(first.nodeId).toBe(nodeIdOf(first.publicKey));
    // The stored shape: versioned, raw public key as base64url, private key as PEM.
    const record = JSON.parse(readFileSync(file, "utf8")) as { v: number; publicKey: string; privateKey: string };
    expect(record.v).toBe(1);
    expect(Buffer.from(record.publicKey, "base64url")).toEqual(first.publicKey);
    expect(record.privateKey).toContain("PRIVATE KEY");
    // A reload (a restart) yields the very same identity, and its key signs what
    // the first load's public key verifies.
    const again = await loadOrCreateIdentity(dir);
    expect(again.publicKey).toEqual(first.publicKey);
    expect(again.nodeId).toBe(first.nodeId);
    expect(verify(first.publicKey, Buffer.from("hi"), sign(again, Buffer.from("hi")))).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      // A loosened file mode is tightened back: the file holds the private key.
      chmodSync(file, 0o644);
      await loadOrCreateIdentity(dir);
      expect(statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("never regenerates over a tampered or malformed file", async () => {
    const dir = stateDir();
    const file = identityFileOf(dir);
    const before = await loadOrCreateIdentity(dir);
    const saved = readFileSync(file, "utf8");
    const record = JSON.parse(saved) as { publicKey: string; privateKey: string };
    // Another key's public key under the same private key: a node presenting as
    // someone else. A hard error, never a silent new identity.
    const other = generateKeyPairSync("ed25519");
    const otherRaw = Buffer.from(other.publicKey.export({ type: "spki", format: "der" })).subarray(-32);
    writeFileSync(file, JSON.stringify({ ...record, publicKey: otherRaw.toString("base64url") }));
    await expect(loadOrCreateIdentity(dir)).rejects.toThrow(/does not match/);
    await expect(loadOrCreateIdentity(dir)).rejects.toThrow(/not regenerated/);
    // An unreadable private key, and garbage JSON, are equally hard errors.
    writeFileSync(file, JSON.stringify({ ...record, privateKey: "not a pem" }));
    await expect(loadOrCreateIdentity(dir)).rejects.toThrow(/not regenerated/);
    writeFileSync(file, "{oops");
    await expect(loadOrCreateIdentity(dir)).rejects.toThrow(/not regenerated/);
    // Nothing above replaced the identity: the original file still loads as-is.
    writeFileSync(file, saved);
    const after = await loadOrCreateIdentity(dir);
    expect(after.publicKey).toEqual(before.publicKey);
    expect(after.nodeId).toBe(before.nodeId);
  });
});
