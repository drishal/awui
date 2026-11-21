// Pins (pins.ts): the trust file's atomic writes and modes, its bounds on
// pending requests, removal by name, and the rule that a stored nodeId is
// never believed over the key it claims to describe.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { nodeIdOf } from "../../src/server/mesh/identity.js";
import { PinStore } from "../../src/server/mesh/pins.js";

/** A scratch state folder, as the server's state dir is one: created fresh per test. */
const stateDir = (): string => mkdtempSync(path.join(tmpdir(), "awui-mesh-pins-"));
const pinsFile = (): string => {
  const file = path.join(stateDir(), "mesh", "pins.json");
  mkdirSync(path.dirname(file), { recursive: true });
  return file;
};
/** A distinct 32-byte key per call; nodeIdOf gives each one its own node id. */
const key = (byte: number): Buffer => Buffer.alloc(32, byte);

describe("the pins file", () => {
  it("writes atomically and keeps the file 0600 in a 0700 dir", async () => {
    const file = pinsFile();
    const pins = PinStore(file);
    await pins.setOutbound("lab-vm-3", key(1));
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { v: number; outbound: Record<string, { publicKey: string; nodeId: string }> };
    expect(parsed.v).toBe(1);
    expect(Buffer.from(parsed.outbound["lab-vm-3"]!.publicKey, "base64url")).toEqual(key(1));
    if (process.platform !== "win32") {
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
    }
    // The rename landed: no temp file was left behind.
    expect(readdirSync(path.dirname(file)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("round-trips every kind of pin, and re-reads the file per call", async () => {
    const file = pinsFile();
    const pins = PinStore(file);
    expect(await pins.outbound("nobody")).toBeNull();
    expect(await pins.inbound(nodeIdOf(key(2)))).toBeNull();
    const pub = key(2);
    await pins.setOutbound("ci-box", pub);
    await pins.setInbound(pub, "leader", "worker", "accept");
    await pins.addPending(key(3), "scanner");
    const out = await pins.outbound("ci-box");
    expect(out).not.toBeNull();
    expect(out!.publicKey).toEqual(pub);
    expect(out!.nodeId).toBe(nodeIdOf(pub));
    const byId = await pins.inbound(nodeIdOf(pub));
    expect(byId).toMatchObject({ publicKey: pub, name: "leader", policy: "worker", via: "accept" });
    expect(await pins.inboundByName("leader")).toMatchObject({ publicKey: pub });
    expect(await pins.pending("scanner")).toMatchObject({ publicKey: key(3) });
    // A second store over the same file sees the same pins: nothing is cached in the process.
    const again = PinStore(file);
    expect((await again.outbound("ci-box"))!.publicKey).toEqual(pub);
  });

  it("serializes concurrent writes so every pin lands", async () => {
    const file = pinsFile();
    const pins = PinStore(file);
    await Promise.all([
      pins.setOutbound("a", key(1)),
      pins.setOutbound("b", key(2)),
      pins.setInbound(key(3), "c", "worker", "accept"),
      pins.addPending(key(4), "d"),
      pins.removeByName("nobody"),
    ]);
    expect((await pins.outbound("a"))!.publicKey).toEqual(key(1));
    expect((await pins.outbound("b"))!.publicKey).toEqual(key(2));
    expect(await pins.inboundByName("c")).not.toBeNull();
    expect(await pins.pending("d")).not.toBeNull();
  });
});

describe("pending requests", () => {
  it("caps them at 16, dropping the oldest, and keeps the newest", async () => {
    const file = pinsFile();
    const pins = PinStore(file);
    for (let n = 1; n <= 17; n++) await pins.addPending(key(n), `peer-${n}`);
    expect(await pins.pending("peer-1")).toBeNull();
    expect(await pins.pending("peer-2")).not.toBeNull();
    expect(await pins.pending("peer-16")).not.toBeNull();
    expect(await pins.pending("peer-17")).not.toBeNull();
  });

  it("prunes entries older than an hour on the next write", async () => {
    const file = pinsFile();
    const pins = PinStore(file);
    await pins.addPending(key(2), "peer-2");
    await pins.addPending(key(9), "peer-9");
    // Age one entry past the hour by hand, then trigger an unrelated write.
    const raw = JSON.parse(readFileSync(file, "utf8")) as { pending: Record<string, { seenAt: number }> };
    raw.pending[nodeIdOf(key(2))]!.seenAt = Date.now() - 2 * 60 * 60 * 1000;
    writeFileSync(file, JSON.stringify(raw));
    await pins.setOutbound("whatever", key(9));
    expect(await pins.pending("peer-2")).toBeNull();
    expect(await pins.pending("peer-9")).not.toBeNull();
  });
});

describe("removal", () => {
  it("removeByName drops the outbound pin, that peer's inbound pin, and its pending record", async () => {
    const file = pinsFile();
    const pins = PinStore(file);
    await pins.setOutbound("lab-vm-3", key(1));
    await pins.setInbound(key(1), "lab-vm-3", "worker", "accept");
    await pins.setInbound(key(5), "ci-box", "peer", "forced");
    await pins.addPending(key(6), "lab-vm-3");
    await pins.removeByName("lab-vm-3");
    expect(await pins.outbound("lab-vm-3")).toBeNull();
    expect(await pins.inboundByName("lab-vm-3")).toBeNull();
    expect(await pins.inbound(nodeIdOf(key(1)))).toBeNull();
    expect(await pins.pending("lab-vm-3")).toBeNull();
    // An unrelated peer's pins survive.
    expect(await pins.inboundByName("ci-box")).not.toBeNull();
  });
});

describe("a broken file is a hard error", () => {
  it("throws clearly on garbage and never resets the file", async () => {
    const file = pinsFile();
    const pins = PinStore(file);
    writeFileSync(file, "{oops");
    await expect(pins.outbound("x")).rejects.toThrow(/mesh pins file .* is invalid/);
    await expect(pins.setOutbound("x", key(1))).rejects.toThrow(/not reset/);
    // The file was not quietly rewritten into an empty one.
    expect(readFileSync(file, "utf8")).toBe("{oops");
  });

  it("throws on a wrong version and on malformed entries", async () => {
    for (const bad of [
      JSON.stringify({ v: 2 }),
      JSON.stringify({ v: 1, outbound: { "a box": { publicKey: key(1).toString("base64url"), pinnedAt: 1 } } }),
      JSON.stringify({ v: 1, outbound: { a: { publicKey: key(1).toString("base64url"), pinnedAt: "soon" } } }),
      JSON.stringify({ v: 1, inbound: { whatever: { publicKey: key(1).toString("base64url"), name: "a", policy: "worker", pinnedAt: 1, via: "maybe" } } }),
      JSON.stringify({ v: 1, outbound: [] }),
    ]) {
      const file = pinsFile();
      const pins = PinStore(file);
      writeFileSync(file, bad);
      await expect(pins.inbound("x")).rejects.toThrow(/is invalid/);
    }
  });
});

describe("a stored nodeId is never trusted", () => {
  it("recomputes every node id from the stored public key", async () => {
    const file = pinsFile();
    const pub = key(7);
    const id = nodeIdOf(pub);
    const bogus = "AAAAAAA-BOGUS-AAAAAAA";
    writeFileSync(
      file,
      JSON.stringify({
        v: 1,
        outbound: { "lab-vm-3": { publicKey: pub.toString("base64url"), nodeId: bogus, pinnedAt: 1 } },
        inbound: { [bogus]: { publicKey: pub.toString("base64url"), name: "lab-vm-3", policy: "worker", pinnedAt: 1, via: "accept" } },
        pending: { [bogus]: { publicKey: pub.toString("base64url"), name: "lab-vm-3", seenAt: Date.now() } },
      }),
    );
    const pins = PinStore(file);
    // Lookups land under the recomputed id, and the returned id is the recomputed one.
    expect((await pins.outbound("lab-vm-3"))!.nodeId).toBe(id);
    expect(await pins.inbound(id)).not.toBeNull();
    expect(await pins.inbound(bogus)).toBeNull();
    expect(await pins.inboundByName("lab-vm-3")).not.toBeNull();
    expect(await pins.pending("lab-vm-3")).not.toBeNull();
    // And the next write back corrects the file's keys for a person to read.
    await pins.setOutbound("other", key(8));
    const raw = readFileSync(file, "utf8");
    expect(raw).toContain(`"${id}"`);
    expect(raw).not.toContain(bogus);
  });
});
