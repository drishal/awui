// Mesh invite pairing (P2 §3): the pre-pairing half of a first contact, for
// when two machines cannot sit next to each other to compare node ids and a
// SAS. One side's service mints a single-use invite — a random 8-byte id and
// a 16-byte secret held in memory only, ≤ 16 live, expiring within 1..60
// minutes — and prints it as one code, `awui-invite:1:` + base64url(JSON).
// The code carries the target's name, addresses, public key, the invite id,
// and the secret; the joiner's key arrives out-of-band only in the sense that
// the code IS the out-of-band channel, so the joiner pins `k` outright (no
// TOFU) and then proves possession of the secret by binding it to this one
// link's handshake transcript: mac = HMAC-SHA256(HKDF-SHA256(secret, salt
// "awui-mesh/1", info "invite"), "awui-mesh/1 invite\n" || transcript). A
// MITM cannot forge that without the secret, and the secret never crosses the
// link. Five bad macs burn the invite. A good mac is spent on the spot —
// single use — and what it buys is deliberately small: a pending inbound
// record marked `invited:{inviteId, policy}`, which the target's owner still
// has to Accept (UI or CLI), with the invite's policy pre-filled.
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PinStore } from "./pins.js";
import { MeshErrorCode, MeshRpcError } from "./rpc.js";

/** What every printed code starts with, version included so the shape can change one day. */
export const INVITE_CODE_PREFIX = "awui-invite:1:";
/** The spec's bounds: how many invites may be live at once, and how many bad macs burn one. */
export const MAX_LIVE_INVITES = 16;
export const MAX_INVITE_ATTEMPTS = 5;
export const MIN_INVITE_TTL_MINUTES = 1;
export const MAX_INVITE_TTL_MINUTES = 60;
/** The invite id's and secret's sizes, exactly as the spec spells them. */
export const INVITE_ID_BYTES = 8;
export const INVITE_SECRET_BYTES = 16;

/** The domain strings of the invite MAC: the HKDF's salt and info, and the HMAC's one-line domain. */
const HKDF_SALT = "awui-mesh/1";
const HKDF_INFO = "invite";
const MAC_PREFIX = "awui-mesh/1 invite\n";

/** A peer name as config.yml spells it (P0). */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** A policy name: the built-ins and anything configured all match this (P0). */
const POLICY_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * A base64url string of exactly n bytes: the charset is checked first because
 * Buffer.from(base64url) silently skips characters it does not know, which
 * would let a malformed field decode to a shorter, different value.
 */
const b64uBytes = (n: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.floor((4 * n + 2) / 3)}}$`)).transform((s) => Buffer.from(s, "base64url"));

/** One address as a code carries it: `host:port` or `[v6]:port`, port 1..65535, no spaces or tricks. */
export const inviteAddressSchema = z
  .string()
  .min(3)
  .max(256)
  .refine((v) => {
    const colon = v.lastIndexOf(":");
    if (colon <= 0) return false;
    const host = v.slice(0, colon);
    const port = Number(v.slice(colon + 1));
    if (!/^\d{1,5}$/.test(v.slice(colon + 1)) || port < 1 || port > 65535) return false;
    // A bare IPv6 has colons and would split wrong, so it must be bracketed, exactly as URLs spell it.
    return /^\[[0-9A-Fa-f:.]+\]$/.test(host) || /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(host);
  }, "must be host:port or [IPv6]:port with a port from 1 to 65535");

/** The code's JSON, strict on decode: nothing extra rides along, and every byte field is its exact size. */
const inviteCodeSchema = z
  .object({
    v: z.literal(1),
    n: z.string().regex(NAME_RE),
    a: z.array(inviteAddressSchema).max(8),
    k: b64uBytes(32),
    i: b64uBytes(INVITE_ID_BYTES),
    s: b64uBytes(INVITE_SECRET_BYTES),
  })
  .strict();

/** One decoded invite code: the target's name, where it listens, its key, and the one invite's id and secret. */
export interface InviteCode {
  v: 1;
  name: string;
  addresses: string[];
  targetKey: Buffer;
  inviteId: Buffer;
  secret: Buffer;
}

/** One live invite as the service holds it; the secret never leaves except inside a code. */
export interface InviteRecord {
  id: Buffer;
  secret: Buffer;
  policy: string;
  addresses: string[];
  createdAt: number;
  expiresAt: number;
  attempts: number;
}

/** `local.invite.create`'s params, strict: policy, minutes, and the addresses to try in order. */
export const inviteCreateSchema = z
  .object({
    policy: z.string().regex(POLICY_RE).optional(),
    ttlMinutes: z.number().int().min(MIN_INVITE_TTL_MINUTES).max(MAX_INVITE_TTL_MINUTES).optional(),
    addresses: z.array(inviteAddressSchema).max(8).optional(),
  })
  .strict();

/** The invite MAC exactly as the spec spells it: HKDF over the secret, HMAC over a domain line and the transcript. */
export function inviteMac(secret: Buffer, transcript: Buffer): Buffer {
  const key = Buffer.from(hkdfSync("sha256", secret, Buffer.from(HKDF_SALT, "utf8"), Buffer.from(HKDF_INFO, "utf8"), 32));
  return createHmac("sha256", key).update(Buffer.concat([Buffer.from(MAC_PREFIX, "utf8"), transcript])).digest();
}

/** One invite as one printable code: prefix + base64url of the strict JSON shape. */
export function encodeInviteCode(code: InviteCode): string {
  const doc = {
    v: 1,
    n: code.name,
    a: code.addresses,
    k: code.targetKey.toString("base64url"),
    i: code.inviteId.toString("base64url"),
    s: code.secret.toString("base64url"),
  };
  return INVITE_CODE_PREFIX + Buffer.from(JSON.stringify(doc), "utf8").toString("base64url");
}

/**
 * One code back into its facts, or null for anything that is not exactly the
 * promised shape: wrong prefix, a body that is not base64url, broken JSON, an
 * extra field, a key of the wrong size, an address that is not host:port. A
 * code that does not decode is refused, never best-effort read.
 */
export function decodeInviteCode(text: string): InviteCode | null {
  if (!text.startsWith(INVITE_CODE_PREFIX)) return null;
  const body = text.slice(INVITE_CODE_PREFIX.length);
  // Charset first: Buffer.from(base64url) skips unknown characters instead of failing.
  if (body === "" || !/^[A-Za-z0-9_-]+$/.test(body)) return null;
  let doc: unknown;
  try {
    doc = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const parsed = inviteCodeSchema.safeParse(doc);
  if (!parsed.success) return null;
  return {
    v: 1,
    name: parsed.data.n,
    addresses: parsed.data.a,
    targetKey: parsed.data.k,
    inviteId: parsed.data.i,
    secret: parsed.data.s,
  };
}

export interface InviteStoreOpts {
  /** Epoch milliseconds; injected so tests run an expiry without waiting. */
  now?: () => number;
  /** Test seams for the spec's caps; production passes nothing. */
  maxLive?: number;
  maxAttempts?: number;
}

export type InviteVerdict = { ok: true; policy: string } | { ok: false; reason: "unknown" | "expired" | "bad-mac" };

/**
 * The service's live invites, in memory only: nothing is written to the state
 * folder, so a restart simply ends every invite made before it, and a minted
 * but never redeemed invite costs nothing but its 1..60 minutes. `create`
 * throws the wire's -33004 over the live cap; `check` is the spec's redeem
 * ladder — exists, not expired, then a constant-time MAC over this link's
 * transcript — and burns the invite after five bad macs and on the first
 * good one, because single use means single use.
 */
export class InviteStore {
  private readonly live = new Map<string, InviteRecord>();
  private readonly now: () => number;
  private readonly maxLive: number;
  private readonly maxAttempts: number;

  constructor(opts: InviteStoreOpts = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.maxLive = opts.maxLive ?? MAX_LIVE_INVITES;
    this.maxAttempts = opts.maxAttempts ?? MAX_INVITE_ATTEMPTS;
  }

  /** One fresh single-use invite. The TTL is 1..60 minutes and is not a suggestion. */
  create(policy: string, ttlMinutes: number, addresses: string[]): InviteRecord {
    if (!POLICY_RE.test(policy)) throw new Error(`a policy name must match ${POLICY_RE}`);
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < MIN_INVITE_TTL_MINUTES || ttlMinutes > MAX_INVITE_TTL_MINUTES) {
      throw new Error(`an invite's TTL is ${MIN_INVITE_TTL_MINUTES}..${MAX_INVITE_TTL_MINUTES} minutes`);
    }
    this.prune();
    if (this.live.size >= this.maxLive) {
      throw new MeshRpcError(MeshErrorCode.limit, `${this.live.size} invites are already live on this node`, { code: "limit" });
    }
    const record: InviteRecord = {
      id: randomBytes(INVITE_ID_BYTES),
      secret: randomBytes(INVITE_SECRET_BYTES),
      policy,
      addresses,
      createdAt: this.now(),
      expiresAt: this.now() + ttlMinutes * 60_000,
      attempts: 0,
    };
    this.live.set(record.id.toString("hex"), record);
    return { ...record };
  }

  /** The redeem ladder for one link's transcript; see the class comment for the order and the burn rules. */
  check(inviteId: Buffer, mac: Buffer, transcript: Buffer): InviteVerdict {
    // No prune first: an expired invite answers "expired" in its own words once, and is
    // spent by that very answer; only then does it read as unknown. Prune runs on
    // create and list, so nothing expired ever holds a live slot for long.
    const key = inviteId.toString("hex");
    const record = this.live.get(key);
    if (record === undefined) return { ok: false, reason: "unknown" };
    if (this.now() >= record.expiresAt) {
      this.live.delete(key);
      return { ok: false, reason: "expired" };
    }
    const expected = inviteMac(record.secret, transcript);
    // A schema-valid mac is always 32 bytes, but this module is also called directly; a wrong
    // length is a bad mac, compared as one answer, never a throw.
    if (mac.length !== 32 || !timingSafeEqual(expected, mac)) {
      record.attempts++;
      if (record.attempts >= this.maxAttempts) this.live.delete(key);
      return { ok: false, reason: "bad-mac" };
    }
    // The first good mac spends the invite; a replayed redeem finds nothing.
    this.live.delete(key);
    return { ok: true, policy: record.policy };
  }

  /** The live invites, for a listing; the secrets are the store's own and never leave. */
  list(): Array<Omit<InviteRecord, "secret">> {
    this.prune();
    return [...this.live.values()].map(({ secret: _secret, ...rest }) => ({ ...rest }));
  }

  /** Drops the expired; every read and every mint prunes first. */
  private prune(): void {
    const now = this.now();
    for (const [key, record] of this.live) if (now >= record.expiresAt) this.live.delete(key);
  }
}

/** One redeem, everything the target needs: the id and mac the joiner sent, this link's transcript, and its key and name. */
export interface RedeemInput {
  inviteId: Buffer;
  mac: Buffer;
  transcript: Buffer;
  clientKey: Buffer;
  clientName: string;
}

/**
 * The target's whole redeem handling in one place: run the ladder, and on the
 * one good outcome record the caller exactly as a first hello would have — a
 * pending inbound entry — but marked `invited:{inviteId, policy}`, so the
 * owner's Accept (UI or `awui peer accept`) still has to say yes, with the
 * invite's policy pre-filled. The caller never becomes paired by redeeming.
 */
export async function redeemInvite(store: InviteStore, pins: PinStore, input: RedeemInput): Promise<{ ok: true; policy: string } | { ok: false; error: MeshRpcError }> {
  const verdict = store.check(input.inviteId, input.mac, input.transcript);
  if (!verdict.ok) {
    const error =
      verdict.reason === "unknown"
        ? new MeshRpcError(MeshErrorCode.not_found, "no invite with that id is live on this node; ask the target for a fresh code", { code: "not_found" })
        : verdict.reason === "expired"
          ? new MeshRpcError(MeshErrorCode.denied, "the invite has expired; ask the target for a fresh code", { code: "denied" })
          : new MeshRpcError(MeshErrorCode.denied, "the invite code's MAC did not verify against this link", { code: "denied" });
    return { ok: false, error };
  }
  await pins.addPending(input.clientKey, input.clientName, { inviteId: input.inviteId.toString("base64url"), policy: verdict.policy });
  return { ok: true, policy: verdict.policy };
}
