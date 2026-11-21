// The mesh handshake (P1): two nodes prove themselves to each other before
// anything else may cross the link. Both sides sign the same four values —
// client key, client nonce, server key, server nonce — under different
// one-line prefixes, so a hello signature can never be replayed as an auth
// signature, and neither signature is bound to anything but this one
// session's fresh nonces. The client also holds the server to its pin (or,
// explicitly, to TOFU on a first contact with no pin at all), and both sides
// derive the same SAS from the two public keys, so two people can compare a
// first pairing by reading six digits aloud.
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { type NodeIdentity, sasOf, sign, verify } from "./identity.js";
import { MeshErrorCode, MeshRpcError, type RpcPeer } from "./rpc.js";

/** The domain string folded into both sides' SAS: one session type, one set of digits. */
export const SAS_CONTEXT = "awui-mesh/1";
/** The hello signature's one-line domain: what makes a hello sig useless as an auth sig. */
const HELLO_PREFIX = "awui-mesh/1 hello\n";
/** The auth signature's one-line domain: the same transcript, a different promise. */
const AUTH_PREFIX = "awui-mesh/1 auth\n";

/** A peer name as config.yml spells it (P0): the shape both sides of a handshake present. */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** A policy name: the built-ins and anything configured all match this (P0). */
const POLICY_RE = /^[a-z0-9_-]{1,32}$/;

/**
 * A base64url string of exactly n bytes: the charset is checked first because
 * Buffer.from(base64url) silently skips characters it does not know, which
 * would let a malformed key decode to a shorter, different key.
 */
const b64uBytes = (n: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.floor((4 * n + 2) / 3)}}$`)).transform((s) => Buffer.from(s, "base64url"));

/** peer.hello params, exactly as the spec spells them; strict, so nothing extra rides along the first message. */
export const helloSchema = z.object({
  v: z.literal(1),
  name: z.string().regex(NAME_RE),
  publicKey: b64uBytes(32),
  nonce: b64uBytes(32),
  hops: z.number().int().min(0),
}).strict();

/** peer.auth params: the client's signature over the auth input. */
export const authSchema = z.object({ sig: b64uBytes(64) }).strict();

/** What the server's peer.hello reply must look like; checked before anything in it is trusted. */
const helloResultSchema = z.object({
  v: z.literal(1),
  name: z.string().regex(NAME_RE),
  publicKey: b64uBytes(32),
  nonce: b64uBytes(32),
  sig: b64uBytes(64),
}).strict();

/** What the server's peer.auth reply must look like. */
const authResultSchema = z.object({
  paired: z.boolean(),
  policy: z.string().regex(POLICY_RE),
  sas: z.string().regex(/^\d{3} \d{3}$/),
}).strict();

/**
 * The transcript body both signatures cover, without either prefix. A TLS
 * link appends its channel binding (P2) — the exporter value no other TLS
 * session can produce — so a MITM terminating TLS on both sides cannot
 * satisfy a pin even with perfectly relayed messages; a stdio link has none,
 * and the bytes stay exactly the P1 transcript.
 */
export function transcript(clientPub: Buffer, clientNonce: Buffer, serverPub: Buffer, serverNonce: Buffer, binding?: Buffer): Buffer {
  const base = Buffer.concat([clientPub, clientNonce, serverPub, serverNonce]);
  if (binding === undefined || binding.length === 0) return base;
  return Buffer.concat([base, binding]);
}

/** What the server signs in its peer.hello reply. */
export function helloSigInput(t: Buffer): Buffer {
  return Buffer.concat([Buffer.from(HELLO_PREFIX, "utf8"), t]);
}

/** What the client signs in peer.auth. */
export function authSigInput(t: Buffer): Buffer {
  return Buffer.concat([Buffer.from(AUTH_PREFIX, "utf8"), t]);
}

export interface ClientHandshakeOpts {
  identity: NodeIdentity;
  name: string;
  hops: number;
  /** The pin for this peer name, or null on a first contact that TOFU allows. */
  expectedServerKey: Buffer | null;
  tofu: boolean;
  /** TLS links only: this session's exporter value, folded into the signed transcript. */
  binding?: Buffer;
}

/** What a finished handshake left the client holding. */
export interface HandshakeOutcome {
  serverKey: Buffer;
  serverName: string;
  paired: boolean;
  policy: string;
  sas: string;
}

/**
 * The client half of the handshake: hello, verify the server's signed reply,
 * hold it to its pin, auth with our own signature, and check the pairing
 * verdict. Every local failure closes the link before throwing — a peer that
 * failed verification is never sent anything further.
 */
export async function clientHandshake(rpc: RpcPeer, opts: ClientHandshakeOpts): Promise<HandshakeOutcome> {
  if (opts.expectedServerKey === null && !opts.tofu) {
    rpc.close("pin: no pinned key, and TOFU is off");
    throw new MeshRpcError(MeshErrorCode.pin_mismatch, "This peer has no pinned key, and TOFU is not enabled for this contact", { code: "pin_mismatch" });
  }
  const clientNonce = randomBytes(32);
  const hello = await rpc.request<unknown>("peer.hello", {
    v: 1,
    name: opts.name,
    publicKey: opts.identity.publicKey.toString("base64url"),
    nonce: clientNonce.toString("base64url"),
    hops: opts.hops,
  });
  const server = helloResultSchema.safeParse(hello);
  if (!server.success) {
    rpc.close("handshake: the server's hello reply was malformed");
    throw new MeshRpcError(MeshErrorCode.invalid_request, "The server's hello reply was not the shape the protocol promises", { code: "invalid_request" });
  }
  const t = transcript(opts.identity.publicKey, clientNonce, server.data.publicKey, server.data.nonce, opts.binding);
  if (!verify(server.data.publicKey, helloSigInput(t), server.data.sig)) {
    rpc.close("handshake: the server's hello signature failed");
    throw new MeshRpcError(MeshErrorCode.invalid_request, "The server's hello signature did not verify under the key it presented", { code: "invalid_request" });
  }
  // A pin, when one exists, is always enforced: TOFU only covers a first contact with no pin at all,
  // so a `peer add` can never quietly re-pin a peer that was already pinned.
  if (opts.expectedServerKey !== null && !opts.expectedServerKey.equals(server.data.publicKey)) {
    rpc.close("pin: the server's key is not the pinned one");
    throw new MeshRpcError(MeshErrorCode.pin_mismatch, "The server's key does not match the pinned key for this peer; the link was closed", { code: "pin_mismatch" });
  }
  const auth = await rpc.request<unknown>("peer.auth", { sig: sign(opts.identity, authSigInput(t)).toString("base64url") });
  const authed = authResultSchema.safeParse(auth);
  if (!authed.success) {
    rpc.close("handshake: the server's auth reply was malformed");
    throw new MeshRpcError(MeshErrorCode.invalid_request, "The server's auth reply was not the shape the protocol promises", { code: "invalid_request" });
  }
  const sas = sasOf(opts.identity.publicKey, server.data.publicKey, SAS_CONTEXT);
  if (authed.data.sas !== sas) {
    rpc.close("handshake: the server reported a different SAS");
    throw new MeshRpcError(MeshErrorCode.invalid_request, "The server reported a SAS this side does not derive from the two keys", { code: "invalid_request" });
  }
  return { serverKey: server.data.publicKey, serverName: server.data.name, paired: authed.data.paired, policy: authed.data.policy, sas };
}

export type HandshakeState = "init" | "hello" | "done";

export interface ServerHandshakeOpts {
  identity: NodeIdentity;
  /** This server's mesh name, what the client pins beside the key. */
  name: string;
  /** Decides pairing once the client's auth signature has verified. */
  resolve: (clientKey: Buffer, clientName: string) => Promise<{ paired: boolean; policy: string }>;
  /** TLS links only: this session's exporter value, folded into the signed transcript. */
  binding?: Buffer;
}

/**
 * The server half, as a small state machine the serve loop can route through:
 * `handle` answers `peer.hello` and `peer.auth` and returns null for anything
 * else. Out-of-order or repeated handshake messages are invalid requests; a
 * failed signature throws so the caller closes the link (spec P1) after the
 * error response has gone out.
 */
export class ServerHandshake {
  private phase: HandshakeState = "init";
  private clientInfo: { publicKey: Buffer; name: string; hops: number } | null = null;
  private clientNonce: Buffer | null = null;
  private serverNonce: Buffer | null = null;
  /** The transcript body this link's two signatures covered, kept for callers that need to prove it (peer.redeem). */
  private body: Buffer | null = null;

  constructor(private readonly opts: ServerHandshakeOpts) {}

  get state(): HandshakeState {
    return this.phase;
  }

  /**
   * The client, only once its auth signature has verified (state "done"); null before
   * that, so nothing can act on a key the peer has merely claimed in its hello.
   */
  get client(): { publicKey: Buffer; name: string; hops: number } | null {
    return this.phase !== "done" || this.clientInfo === null ? null : { ...this.clientInfo };
  }

  /**
   * The transcript body both signatures covered, only once the client's auth has
   * verified; null before that, so nothing can act on bytes an unauthenticated
   * peer merely caused to be signed. The TLS binding is included when the link
   * had one.
   */
  get transcript(): Buffer | null {
    return this.phase === "done" && this.body !== null ? this.body : null;
  }

  /** Routes one incoming request; null means "not a handshake method", and the caller answers it. */
  handle(method: string, params: unknown): Promise<unknown> | null {
    if (method !== "peer.hello" && method !== "peer.auth") return null;
    return method === "peer.hello" ? this.hello(params) : this.auth(params);
  }

  private async hello(params: unknown): Promise<unknown> {
    if (this.phase !== "init") throw new MeshRpcError(MeshErrorCode.invalid_request, "peer.hello has already been answered for this link", { code: "invalid_request" });
    const parsed = helloSchema.safeParse(params);
    if (!parsed.success) throw new MeshRpcError(MeshErrorCode.invalid_params, "peer.hello params were not the promised shape", { code: "invalid_params" });
    const client = parsed.data;
    this.clientInfo = { publicKey: client.publicKey, name: client.name, hops: client.hops };
    this.clientNonce = client.nonce;
    // A fresh nonce per link: what makes a signature recorded from an earlier session worthless here.
    this.serverNonce = randomBytes(32);
    this.phase = "hello";
    const t = transcript(client.publicKey, client.nonce, this.opts.identity.publicKey, this.serverNonce, this.opts.binding);
    this.body = t;
    return {
      v: 1,
      name: this.opts.name,
      publicKey: this.opts.identity.publicKey.toString("base64url"),
      nonce: this.serverNonce.toString("base64url"),
      sig: sign(this.opts.identity, helloSigInput(t)).toString("base64url"),
    };
  }

  private async auth(params: unknown): Promise<unknown> {
    if (this.phase === "init") throw new MeshRpcError(MeshErrorCode.invalid_request, "peer.auth arrived before peer.hello", { code: "invalid_request" });
    if (this.phase === "done") throw new MeshRpcError(MeshErrorCode.invalid_request, "the handshake has already completed", { code: "invalid_request" });
    const parsed = authSchema.safeParse(params);
    if (!parsed.success) throw new MeshRpcError(MeshErrorCode.invalid_params, "peer.auth params were not the promised shape", { code: "invalid_params" });
    const client = this.clientInfo;
    // Unreachable in practice (state is "hello" here, which hello always sets),
    // but the transcript is only ever signed over values this side actually holds.
    if (client === null || this.body === null) throw new MeshRpcError(MeshErrorCode.invalid_request, "peer.auth arrived before peer.hello", { code: "invalid_request" });
    // A failed signature is a failed identity: this side answers, and the caller closes the link.
    // The body is the transcript hello recorded — binding included.
    if (!verify(client.publicKey, authSigInput(this.body), parsed.data.sig)) {
      throw new MeshRpcError(MeshErrorCode.invalid_request, "The client's auth signature did not verify under the key it presented", { code: "invalid_request" });
    }
    const { paired, policy } = await this.opts.resolve(client.publicKey, client.name);
    this.phase = "done";
    return { paired, policy, sas: sasOf(client.publicKey, this.opts.identity.publicKey, SAS_CONTEXT) };
  }
}
