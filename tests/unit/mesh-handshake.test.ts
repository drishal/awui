// The mutual signed handshake (handshake.ts): two real identities over a
// PassThrough link, the happy path both paired and unpaired, and every
// failure the protocol must refuse — a wrong pin, a tampered signature on
// either side, messages out of order, and a signature recorded from an
// earlier session replayed at a fresh one.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type NodeIdentity, nodeIdOf, sasOf, sign } from "../../src/server/mesh/identity.js";
import { authSigInput, authSchema, clientHandshake, helloSchema, helloSigInput, SAS_CONTEXT, ServerHandshake, transcript } from "../../src/server/mesh/handshake.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";

/** A fresh in-memory identity, the shape loadOrCreateIdentity returns. */
function identity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
  return { publicKey: raw, privateKey, nodeId: nodeIdOf(raw) };
}

/** One link end's peer.hello reply, as the wire carries it. */
interface HelloReply {
  v: number;
  name: string;
  publicKey: string;
  nonce: string;
  sig: string;
}

/** A client and a server peer wired through a ServerHandshake that answers nothing else. */
function link(serverIdentity: NodeIdentity, resolve: (clientKey: Buffer, clientName: string) => Promise<{ paired: boolean; policy: string }>): { client: RpcPeer; server: RpcPeer; hs: ServerHandshake } {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const server = new RpcPeer(c2s, s2c, { role: "server" });
  const hs = new ServerHandshake({ identity: serverIdentity, name: "target-box", resolve });
  server.onRequest((method, params) => {
    const answer = hs.handle(method, params);
    if (answer !== null) return answer;
    // The serve loop's other half: nothing runs before the handshake completes.
    throw new MeshRpcError(MeshErrorCode.not_paired, `the handshake must finish before "${method}"`, { code: "not_paired" });
  });
  server.start();
  const client = new RpcPeer(s2c, c2s, { role: "client" });
  client.start();
  return { client, server, hs };
}

/** A client's hello params, for the manual flows that need to hold the nonce. */
const helloParams = (who: NodeIdentity, name: string, nonce: Buffer) => ({
  v: 1,
  name,
  publicKey: who.publicKey.toString("base64url"),
  nonce: nonce.toString("base64url"),
  hops: 0,
});

describe("the bytes both sides sign", () => {
  const a = Buffer.alloc(32, 1);
  const b = Buffer.alloc(32, 2);
  const c = Buffer.alloc(32, 3);
  const d = Buffer.alloc(32, 4);

  it("builds the transcript and both signature inputs from exact bytes", () => {
    expect(transcript(a, b, c, d)).toEqual(Buffer.concat([a, b, c, d]));
    expect(helloSigInput(transcript(a, b, c, d))).toEqual(Buffer.concat([Buffer.from("awui-mesh/1 hello\n", "utf8"), a, b, c, d]));
    expect(authSigInput(transcript(a, b, c, d))).toEqual(Buffer.concat([Buffer.from("awui-mesh/1 auth\n", "utf8"), a, b, c, d]));
  });

  it("accepts only the promised field shapes", () => {
    const good = { v: 1, name: "leader-box", publicKey: Buffer.alloc(32, 7).toString("base64url"), nonce: Buffer.alloc(32, 8).toString("base64url"), hops: 0 };
    expect(helloSchema.safeParse(good).success).toBe(true);
    // A wrong version, a short key, a name with foreign characters, and a negative hop count.
    expect(helloSchema.safeParse({ ...good, v: 2 }).success).toBe(false);
    expect(helloSchema.safeParse({ ...good, publicKey: Buffer.alloc(31, 7).toString("base64url") }).success).toBe(false);
    expect(helloSchema.safeParse({ ...good, name: "leader box!" }).success).toBe(false);
    expect(helloSchema.safeParse({ ...good, hops: -1 }).success).toBe(false);
    // Extra fields do not ride along the first message.
    expect(helloSchema.safeParse({ ...good, extra: true }).success).toBe(false);
    expect(authSchema.safeParse({ sig: Buffer.alloc(64, 1).toString("base64url") }).success).toBe(true);
    expect(authSchema.safeParse({ sig: Buffer.alloc(63, 1).toString("base64url") }).success).toBe(false);
  });
});

describe("the happy path", () => {
  it("pairs two identities, and both sides derive the same SAS", async () => {
    const clientIdentity = identity();
    const serverIdentity = identity();
    let resolvedKey: Buffer | null = null;
    const end = link(serverIdentity, async (clientKey, clientName) => {
      resolvedKey = clientKey;
      expect(clientName).toBe("leader-box");
      return { paired: true, policy: "worker" };
    });
    const result = await clientHandshake(end.client, {
      identity: clientIdentity,
      name: "leader-box",
      hops: 0,
      expectedServerKey: serverIdentity.publicKey,
      tofu: false,
    });
    expect(result.serverKey).toEqual(serverIdentity.publicKey);
    expect(result.serverName).toBe("target-box");
    expect(result.paired).toBe(true);
    expect(result.policy).toBe("worker");
    expect(resolvedKey).toEqual(clientIdentity.publicKey);
    // Both sides hold the same six digits for the same two keys.
    expect(result.sas).toBe(sasOf(clientIdentity.publicKey, serverIdentity.publicKey, SAS_CONTEXT));
    expect(end.hs.state).toBe("done");
    expect(end.hs.client).toEqual({ publicKey: clientIdentity.publicKey, name: "leader-box", hops: 0 });
  });

  it("tells an unpaired client so, with the floor policy", async () => {
    const clientIdentity = identity();
    const serverIdentity = identity();
    const end = link(serverIdentity, async () => ({ paired: false, policy: "none" }));
    const result = await clientHandshake(end.client, {
      identity: clientIdentity,
      name: "leader-box",
      hops: 0,
      expectedServerKey: serverIdentity.publicKey,
      tofu: false,
    });
    expect(result.paired).toBe(false);
    expect(result.policy).toBe("none");
    expect(result.sas).toBe(sasOf(clientIdentity.publicKey, serverIdentity.publicKey, SAS_CONTEXT));
  });

  it("trusts a first contact when TOFU is explicitly on", async () => {
    const clientIdentity = identity();
    const serverIdentity = identity();
    const end = link(serverIdentity, async () => ({ paired: true, policy: "worker" }));
    const result = await clientHandshake(end.client, { identity: clientIdentity, name: "leader-box", hops: 0, expectedServerKey: null, tofu: true });
    expect(result.serverKey).toEqual(serverIdentity.publicKey);
    expect(result.paired).toBe(true);
  });
});

describe("pins", () => {
  it("refuses a server whose key is not the pinned one, and nothing further runs", async () => {
    const clientIdentity = identity();
    const serverIdentity = identity();
    let resolved = false;
    const end = link(serverIdentity, async () => {
      resolved = true;
      return { paired: true, policy: "worker" };
    });
    // The pin says this peer is a different machine entirely.
    const pinned = identity();
    const error = await clientHandshake(end.client, {
      identity: clientIdentity,
      name: "leader-box",
      hops: 0,
      expectedServerKey: pinned.publicKey,
      tofu: false,
    }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error).toBeInstanceOf(MeshRpcError);
    expect(error.code).toBe(MeshErrorCode.pin_mismatch);
    expect(error.data).toEqual({ code: "pin_mismatch" });
    // The link closed before any auth left the client, so the server never paired anyone.
    await end.client.closed;
    expect(end.hs.state).toBe("hello");
    expect(resolved).toBe(false);
  });

  it("refuses an unpinned server when TOFU is off", async () => {
    const clientIdentity = identity();
    const end = link(identity(), async () => ({ paired: true, policy: "worker" }));
    const error = await clientHandshake(end.client, { identity: clientIdentity, name: "leader-box", hops: 0, expectedServerKey: null, tofu: false }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error).toBeInstanceOf(MeshRpcError);
    expect(error.code).toBe(MeshErrorCode.pin_mismatch);
    await end.client.closed;
  });

  it("still refuses a different key when TOFU is on and a pin exists", async () => {
    const clientIdentity = identity();
    const end = link(identity(), async () => ({ paired: true, policy: "worker" }));
    const pinned = identity();
    const error = await clientHandshake(end.client, {
      identity: clientIdentity,
      name: "leader-box",
      hops: 0,
      expectedServerKey: pinned.publicKey,
      tofu: true,
    }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error.code).toBe(MeshErrorCode.pin_mismatch);
    await end.client.closed;
  });
});

describe("tampering", () => {
  it("refuses a server that presents the pinned key but cannot sign with it", async () => {
    const clientIdentity = identity();
    const pinned = identity();
    const c2s = new PassThrough();
    const s2c = new PassThrough();
    const client = new RpcPeer(s2c, c2s, { role: "client" });
    const server = new RpcPeer(c2s, s2c, { role: "server" });
    server.onRequest(async (method, params) => {
      const hello = helloSchema.parse(params);
      const nonce = randomBytes(32);
      // Presents the pinned key, signs with another key's private half.
      const t = transcript(hello.publicKey, hello.nonce, pinned.publicKey, nonce);
      return { v: 1, name: "target-box", publicKey: pinned.publicKey.toString("base64url"), nonce: nonce.toString("base64url"), sig: sign(identity(), helloSigInput(t)).toString("base64url") };
    });
    server.start();
    client.start();
    const error = await clientHandshake(client, { identity: clientIdentity, name: "leader-box", hops: 0, expectedServerKey: pinned.publicKey, tofu: false }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error).toBeInstanceOf(MeshRpcError);
    expect(error.code).toBe(MeshErrorCode.invalid_request);
    expect(error.message).toMatch(/signature/);
    await client.closed;
  });

  it("refuses a tampered client auth signature, and the caller must close", async () => {
    const clientIdentity = identity();
    const serverIdentity = identity();
    const end = link(serverIdentity, async () => ({ paired: true, policy: "worker" }));
    const nonce = randomBytes(32);
    const hello = await end.client.request<HelloReply>("peer.hello", helloParams(clientIdentity, "leader-box", nonce));
    const t = transcript(clientIdentity.publicKey, nonce, Buffer.from(hello.publicKey, "base64url"), Buffer.from(hello.nonce, "base64url"));
    // Signed, but by a key that is not the one the client presented.
    const error = await end.client.request("peer.auth", { sig: sign(identity(), authSigInput(t)).toString("base64url") }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error).toBeInstanceOf(MeshRpcError);
    expect(error.code).toBe(MeshErrorCode.invalid_request);
    expect(error.data).toEqual({ code: "invalid_request" });
    // The signature failed, so pairing never happened and the link must not live on.
    expect(end.hs.state).toBe("hello");
    expect(end.hs.client).toBeNull(); // never exposed until auth verifies
    end.server.close("auth signature failed");
    await end.server.closed;
  });
});

describe("ordering and replay", () => {
  it("refuses peer.auth before peer.hello", async () => {
    const end = link(identity(), async () => ({ paired: true, policy: "worker" }));
    const error = await end.client.request("peer.auth", { sig: Buffer.alloc(64, 1).toString("base64url") }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error).toBeInstanceOf(MeshRpcError);
    expect(error.code).toBe(MeshErrorCode.invalid_request);
    expect(end.hs.state).toBe("init");
    expect(end.hs.client).toBeNull();
  });

  it("refuses a second peer.hello", async () => {
    const clientIdentity = identity();
    const end = link(identity(), async () => ({ paired: true, policy: "worker" }));
    const nonce = randomBytes(32);
    await end.client.request<HelloReply>("peer.hello", helloParams(clientIdentity, "leader-box", nonce));
    expect(end.hs.state).toBe("hello");
    const error = await end.client.request("peer.hello", helloParams(clientIdentity, "leader-box", randomBytes(32))).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error.code).toBe(MeshErrorCode.invalid_request);
    expect(end.hs.state).toBe("hello");
  });

  it("refuses a previous session's auth signature: both sides draw fresh nonces", async () => {
    const clientIdentity = identity();
    const serverIdentity = identity();
    // Session 1, driven by hand so its auth signature can be kept.
    const end1 = link(serverIdentity, async () => ({ paired: true, policy: "worker" }));
    const nonce1 = randomBytes(32);
    const hello1 = await end1.client.request<HelloReply>("peer.hello", helloParams(clientIdentity, "leader-box", nonce1));
    const t1 = transcript(clientIdentity.publicKey, nonce1, serverIdentity.publicKey, Buffer.from(hello1.nonce, "base64url"));
    const oldSig = sign(clientIdentity, authSigInput(t1)).toString("base64url");
    const first = await end1.client.request<{ paired: boolean; policy: string; sas: string }>("peer.auth", { sig: oldSig });
    expect(first.paired).toBe(true);
    // Both sides read the same digits off the same two keys.
    expect(first.sas).toBe(sasOf(clientIdentity.publicKey, serverIdentity.publicKey, SAS_CONTEXT));
    end1.client.close("session 1 done");

    // Session 2: the same two machines, but fresh nonces, so the old signature cannot open it.
    const end2 = link(serverIdentity, async () => ({ paired: true, policy: "worker" }));
    const nonce2 = randomBytes(32);
    const hello2 = await end2.client.request<HelloReply>("peer.hello", helloParams(clientIdentity, "leader-box", nonce2));
    expect(Buffer.from(hello2.nonce, "base64url")).not.toEqual(Buffer.from(hello1.nonce, "base64url"));
    const error = await end2.client.request("peer.auth", { sig: oldSig }).then(
      () => {
        throw new Error("expected a rejection");
      },
      (e) => e,
    );
    expect(error).toBeInstanceOf(MeshRpcError);
    expect(error.code).toBe(MeshErrorCode.invalid_request);
    expect(end2.hs.state).toBe("hello");
  });
});
