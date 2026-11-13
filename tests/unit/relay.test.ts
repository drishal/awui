// The relay's protocol, verified against the reference relay (contrib/relay/relay.mjs):
// key derivation, frame sealing, channel registration, ciphertext round-trip, a wrong
// key's refusal, and a tampered frame's drop. The relay never sees the secret or key.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { channelIdOf, frameKey, openFrame, pairingSecret, sealFrame } from "../../src/server/relay.js";

const RELAY_PORT = 4797;
let relay: ChildProcess | undefined;

beforeAll(async () => {
  relay = spawn(process.execPath, [path.join("contrib", "relay", "relay.mjs"), "--port", String(RELAY_PORT)], { stdio: "ignore" });
  // The relay is up once its health answers; a moment is enough for a listen().
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${RELAY_PORT}/channels/nope/frames?secretHash=${"0".repeat(64)}`);
      if (res.status === 404) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("reference relay did not start");
});

afterAll(async () => {
  relay?.kill();
});

const base = `http://127.0.0.1:${RELAY_PORT}`;

describe("the relay protocol", () => {
  it("derives one key from the secret and seals frames both ways", () => {
    const secret = pairingSecret();
    const key = frameKey(secret);
    expect(key).toHaveLength(32);
    expect(frameKey(secret)).toEqual(key);
    expect(channelIdOf(secret)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const sealed = sealFrame(key, Buffer.from("hello relay"));
    const opened = openFrame(key, sealed);
    expect(opened?.toString("utf8")).toBe("hello relay");
    // A foreign key opens nothing, and a tampered frame is dropped, never trusted.
    expect(openFrame(frameKey(pairingSecret()), sealed)).toBeNull();
    const tampered = Buffer.from(sealed);
    tampered[sealed.length - 1]! ^= 0xff;
    expect(openFrame(key, tampered)).toBeNull();
  });

  it("registers a channel, moves ciphertext through it, and refuses a wrong key", async () => {
    const secret = pairingSecret();
    const key = frameKey(secret);
    const channel = channelIdOf(secret);
    const keyHash = "f".repeat(64); // The relay sees only the key's hash, never the key.
    const registered = await fetch(`${base}/register`, { method: "POST", body: JSON.stringify({ channelId: channel, secretHash: keyHash }) });
    expect(registered.status).toBe(201);
    // A second registration of the same channel is refused.
    expect((await fetch(`${base}/register`, { method: "POST", body: JSON.stringify({ channelId: channel, secretHash: keyHash }) })).status).toBe(409);

    const frame = sealFrame(key, Buffer.from("a sealed prompt"));
    const posted = await fetch(`${base}/channels/${channel}/frames`, { method: "POST", headers: { "x-awui-relay-key": keyHash }, body: new Uint8Array(frame) });
    expect(posted.status).toBe(202);

    // The client reads the frames back and opens them; the relay saw only ciphertext.
    const read = await fetch(`${base}/channels/${channel}/frames?secretHash=${keyHash}&after=0`);
    expect(read.status).toBe(200);
    const cursor = Number(read.headers.get("x-awui-cursor"));
    const body = Buffer.from(await read.arrayBuffer());
    const count = body.readUInt32BE(0);
    expect(count).toBe(1);
    let at = 4;
    const len = body.readUInt32BE(at);
    const opened = openFrame(key, body.subarray(at + 4, at + 4 + len));
    expect(opened?.toString("utf8")).toBe("a sealed prompt");
    at += 4 + len;
    expect(cursor).toBe(1);

    // A wrong key reads nothing: the relay refuses it before any frame moves.
    const wrong = await fetch(`${base}/channels/${channel}/frames?secretHash=${"e".repeat(64)}&after=0`);
    expect(wrong.status).toBe(403);

    // Tearing the channel down ends it; a further read is 404.
    expect((await fetch(`${base}/channels/${channel}?secretHash=${keyHash}`, { method: "DELETE" })).status).toBe(200);
    expect((await fetch(`${base}/channels/${channel}/frames?secretHash=${keyHash}&after=0`)).status).toBe(404);
  });
});
