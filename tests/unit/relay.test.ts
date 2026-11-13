// The relay's protocol, verified against the reference relay (contrib/relay/relay.mjs):
// one key per direction, counter-bound frames, replay and reflection refusal, the
// header-only secret hash, acknowledged frames dropped from the channel, and a
// tampered frame's drop. The relay never sees the secret or a key.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { channelIdOf, channelKeyHash, frameKey, openFrame, pairingSecret, sealFrame, secretMatches } from "../../src/server/relay.js";

let relay: ChildProcess | undefined;
/** Set once the relay prints the free port it bound (`--port 0`), so no fixed port is taken. */
let base = "";
const header = (hash: string) => ({ "x-awui-relay-key": hash });

/** One read of the relay's frames: the cursor it names, and each frame with its sequence. */
async function readFrames(channel: string, hash: string, after: number) {
  const res = await fetch(`${base}/channels/${channel}/frames?after=${after}`, { headers: header(hash) });
  if (res.status !== 200) return { status: res.status, cursor: Number(res.headers.get("x-awui-cursor")), frames: [] as Buffer[] };
  const body = Buffer.from(await res.arrayBuffer());
  const frames: Buffer[] = [];
  let at = 4;
  for (let i = 0; i < body.readUInt32BE(0); i++) {
    const len = body.readUInt32BE(at);
    frames.push(body.subarray(at + 4, at + 4 + len));
    at += 4 + len;
  }
  return { status: res.status, cursor: Number(res.headers.get("x-awui-cursor")), frames };
}

beforeAll(async () => {
  // A free port, reported by the relay's own line: a fixed one collides with whatever else
  // runs on this machine, and then the suite fails for a reason that is not the protocol.
  const child = spawn(process.execPath, [path.join("contrib", "relay", "relay.mjs"), "--port", "0"], { stdio: ["ignore", "pipe", "ignore"] });
  relay = child;
  base = await new Promise<string>((resolve, reject) => {
    let printed = "";
    const timer = setTimeout(() => reject(new Error("reference relay did not start")), 10_000);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      printed += chunk;
      const match = /awui reference relay on (http:\/\/127\.0\.0\.1:\d+)/.exec(printed);
      if (!match) return;
      clearTimeout(timer);
      resolve(match[1]!);
    });
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("reference relay exited before it listened"));
    });
  });
});

afterAll(async () => {
  relay?.kill();
});

describe("the relay protocol", () => {
  it("derives a separate key per direction and binds every frame to one", () => {
    const secret = pairingSecret();
    const c2s = frameKey(secret, "c2s");
    const s2c = frameKey(secret, "s2c");
    expect(c2s).toHaveLength(32);
    expect(c2s).not.toEqual(s2c);
    expect(frameKey(secret, "c2s")).toEqual(c2s);
    expect(channelIdOf(secret)).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const sealed = sealFrame(c2s, "c2s", 1, Buffer.from("hello relay"));
    expect(openFrame(c2s, "c2s", sealed, 0)?.plaintext.toString("utf8")).toBe("hello relay");
    // A reflection does not open: the other direction's key, the right key under the
    // other direction's associated data, or a foreign secret all refuse it.
    expect(openFrame(s2c, "c2s", sealed, 0)).toBeNull();
    expect(openFrame(c2s, "s2c", sealed, 0)).toBeNull();
    expect(openFrame(frameKey(pairingSecret(), "c2s"), "c2s", sealed, 0)).toBeNull();
    const tampered = Buffer.from(sealed);
    tampered[sealed.length - 1]! ^= 0xff;
    expect(openFrame(c2s, "c2s", tampered, 0)).toBeNull();
    // The relay's bearer check is the secret's hash, compared constant-time.
    expect(channelKeyHash(secret)).toMatch(/^[0-9a-f]{64}$/);
    expect(secretMatches(channelKeyHash(secret), secret)).toBe(true);
    expect(secretMatches("0".repeat(64), secret)).toBe(false);
  });

  it("refuses a replayed, reordered, or counter-edited frame", () => {
    const secret = pairingSecret();
    const c2s = frameKey(secret, "c2s");
    const one = sealFrame(c2s, "c2s", 1, Buffer.from("one"));
    const two = sealFrame(c2s, "c2s", 2, Buffer.from("two"));
    // The receiver's floor is the newest counter it accepted.
    expect(openFrame(c2s, "c2s", one, 0)?.counter).toBe(1);
    expect(openFrame(c2s, "c2s", one, 1)).toBeNull(); // a replay
    expect(openFrame(c2s, "c2s", two, 1)?.plaintext.toString("utf8")).toBe("two");
    expect(openFrame(c2s, "c2s", one, 2)).toBeNull(); // behind the newest: a reorder
    // The counter rides in the clear header, so editing it must break the tag.
    const forged = Buffer.from(two);
    forged.writeUInt32BE(3, 0);
    expect(openFrame(c2s, "c2s", forged, 0)).toBeNull();
    expect(() => sealFrame(c2s, "c2s", 0, Buffer.from("x"))).toThrow(RangeError);
  });

  it("moves ciphertext through a channel, refuses a wrong key in the URL, and trims acknowledged frames", async () => {
    const secret = pairingSecret();
    const channel = channelIdOf(secret);
    const keyHash = channelKeyHash(secret);
    expect((await fetch(`${base}/register`, { method: "POST", body: JSON.stringify({ channelId: channel }) })).status).toBe(400);
    expect((await fetch(`${base}/register`, { method: "POST", headers: header(keyHash), body: JSON.stringify({ channelId: channel }) })).status).toBe(201);
    // A second registration of the same channel is refused.
    expect((await fetch(`${base}/register`, { method: "POST", headers: header(keyHash), body: JSON.stringify({ channelId: channel }) })).status).toBe(409);

    const key = frameKey(secret, "c2s");
    for (const [counter, text] of [[1, "a sealed prompt"], [2, "a second frame"], [3, "a third"]] as const) {
      const frame = sealFrame(key, "c2s", counter, Buffer.from(text));
      const posted = await fetch(`${base}/channels/${channel}/frames`, { method: "POST", headers: header(keyHash), body: new Uint8Array(frame) });
      expect(posted.status).toBe(202);
    }

    // The client reads with the relay's cursor and opens what it gets; the relay saw only ciphertext.
    const read = await readFrames(channel, keyHash, 0);
    expect(read.status).toBe(200);
    expect(read.frames).toHaveLength(3);
    expect(read.cursor).toBe(3);
    let after = 0;
    const opened: string[] = [];
    for (const frame of read.frames) {
      const openedFrame = openFrame(key, "c2s", frame, after);
      expect(openedFrame).not.toBeNull();
      after = openedFrame!.counter;
      opened.push(openedFrame!.plaintext.toString("utf8"));
    }
    expect(opened).toEqual(["a sealed prompt", "a second frame", "a third"]);

    // The secret hash in a query string is not a bearer check: only the header is.
    expect((await fetch(`${base}/channels/${channel}/frames?after=0&secretHash=${keyHash}`)).status).toBe(403);
    expect((await fetch(`${base}/channels/${channel}/frames?after=0`, { headers: header("e".repeat(64)) })).status).toBe(403);

    // Acknowledging a cursor drops those frames and frees them; an earlier ack never
    // moves the cursor backwards, and a too-large one clamps to what exists.
    const ack = await fetch(`${base}/channels/${channel}/ack`, { method: "POST", headers: header(keyHash), body: JSON.stringify({ cursor: 2 }) });
    expect(ack.status).toBe(200);
    expect(await ack.json()).toEqual({ cursor: 2, dropped: 2 });
    const again = await fetch(`${base}/channels/${channel}/ack`, { method: "POST", headers: header(keyHash), body: JSON.stringify({ cursor: 1 }) });
    expect(await again.json()).toEqual({ cursor: 2, dropped: 0 });
    const trimmed = await readFrames(channel, keyHash, 0);
    expect(trimmed.frames).toHaveLength(1);
    expect(trimmed.frames[0]!.readUInt32BE(0)).toBe(3);
    expect(openFrame(key, "c2s", trimmed.frames[0]!, 2)?.counter).toBe(3);
    const ahead = await fetch(`${base}/channels/${channel}/ack`, { method: "POST", headers: header(keyHash), body: JSON.stringify({ cursor: 99 }) });
    expect(await ahead.json()).toEqual({ cursor: 3, dropped: 1 });
    expect((await readFrames(channel, keyHash, 0)).status).toBe(204);

    // Tearing the channel down ends it; a further read is 404, and the delete needs the header.
    expect((await fetch(`${base}/channels/${channel}?secretHash=${keyHash}`, { method: "DELETE" })).status).toBe(403);
    expect((await fetch(`${base}/channels/${channel}`, { method: "DELETE", headers: header(keyHash) })).status).toBe(200);
    expect((await readFrames(channel, keyHash, 0)).status).toBe(404);
  });
});
