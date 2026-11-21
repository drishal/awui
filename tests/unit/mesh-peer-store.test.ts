// The peers.json store (P2): peers added from the UI or CLI, validated with
// the same schema config.yml uses, written atomically at 0600, capped at 64,
// and merged with config's list wherever both name a machine — config wins.
// A malformed file is a hard error, never a reset, exactly like pins.json.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { mergePeers, PeerPeersStore, type MeshPeerEntry } from "../../src/server/mesh/peer-store.js";
import { tempDir } from "../helpers/app.js";

/** A valid saved peer, with one field replaced per test. */
const entry = (over: Partial<MeshPeerEntry> = {}): MeshPeerEntry => ({ name: "lab-vm-3", tls: "lab-vm-3.internal:4784", ...over });

function store(): { file: string; peers: ReturnType<typeof PeerPeersStore> } {
  const dir = tempDir("awui-mesh-peers-");
  mkdirSync(path.join(dir, "mesh"), { recursive: true });
  const file = path.join(dir, "mesh", "peers.json");
  return { file, peers: PeerPeersStore(file) };
}

describe("the mesh peers store", () => {
  it("starts empty without a file, and round-trips an added peer", async () => {
    const { peers } = store();
    expect(await peers.list()).toEqual([]);
    await peers.add(entry());
    expect(await peers.list()).toEqual([entry()]);
    expect((await peers.list()).length).toBe(1);
  });

  it("writes atomically at 0600 and reads back with the same shape", async () => {
    const { file, peers } = store();
    await peers.add(entry({ name: "ci-box", tls: "10.0.0.9:4784", inbound_policy: "worker" }));
    const text = readFileSync(file, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(text) as { v: number; peers: unknown[] };
    expect(parsed.v).toBe(1);
    expect(parsed.peers.length).toBe(1);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(await peers.list()).toMatchObject([{ name: "ci-box", tls: "10.0.0.9:4784", inbound_policy: "worker" }]);
  });

  it("refuses a duplicate name, case-insensitively, and forgets by name", async () => {
    const { peers } = store();
    await peers.add(entry());
    await expect(peers.add(entry({ name: "Lab-VM-3" }))).rejects.toThrow(/already saved/);
    await peers.add(entry({ name: "other-box", tls: "10.0.0.2:4784" }));
    await peers.remove("LAB-vm-3");
    expect((await peers.list()).map((peer) => peer.name)).toEqual(["other-box"]);
    // Removing what is not there is fine: forget means forget.
    await peers.remove("never-saved");
  });

  it("refuses an entry config.yml would also refuse, and the 64-entry cap", async () => {
    const { peers } = store();
    await expect(peers.add(entry({ tls: "10.0.0.9", name: "a" }))).rejects.toThrow(/host:port/);
    await expect(peers.add(entry({ name: "b", ssh: "a@b", tls: "b:1" }))).rejects.toThrow(/shape/);
    // No transport at all: not one of the three ways in.
    await expect(peers.add({ name: "c" })).rejects.toThrow(/shape/);
    for (let i = 0; i < 64; i++) await peers.add(entry({ name: `p${i}`, tls: `10.0.0.1:${1000 + i}` }));
    await expect(peers.add(entry({ name: "over", tls: "10.0.0.9:4784" }))).rejects.toThrow(/maximum/);
  });

  it("refuses to serve from a malformed file, never resetting it", async () => {
    const { file, peers } = store();
    writeFileSync(file, "{ not json");
    await expect(peers.list()).rejects.toThrow(/peers\.json.*not valid JSON/);
    expect(() => peers.snapshot()).toThrow(/peers\.json/);
    writeFileSync(file, JSON.stringify({ v: 2, peers: [] }));
    await expect(peers.list()).rejects.toThrow(/unsupported version/);
  });

  it("sees an external write on the next snapshot, without a restart", async () => {
    const { file, peers } = store();
    expect(peers.snapshot()).toEqual([]);
    writeFileSync(file, `${JSON.stringify({ v: 1, peers: [entry()] })}\n`);
    expect(peers.snapshot()).toEqual([entry()]);
    // And back again: the snapshot follows the file, not its first read.
    writeFileSync(file, `${JSON.stringify({ v: 1, peers: [] })}\n`);
    expect(peers.snapshot()).toEqual([]);
  });
});

describe("the merge with config", () => {
  it("lists both sources, config winning wherever both name the same peer", () => {
    const config = [{ name: "lab-vm-3", ssh: "drishal@lab-vm-3" }] as MeshPeerEntry[];
    const saved = [
      entry({ name: "lab-vm-3", tls: "elsewhere:4784" }), // shadowed by config
      entry({ name: "ci-box", tls: "10.0.0.9:4784" }),
    ];
    const merged = mergePeers(config, saved);
    expect(merged.map((peer) => peer.name)).toEqual(["lab-vm-3", "ci-box"]);
    // The name that clashed is config's, not the saved one.
    expect(merged[0]?.ssh).toBe("drishal@lab-vm-3");
    expect(merged[0]?.tls).toBeUndefined();
  });

  it("keeps each source's own order otherwise", () => {
    const merged = mergePeers(
      [
        { name: "cfg-a", ssh: "a@h" },
        { name: "cfg-b", ssh: "b@h" },
      ] as MeshPeerEntry[],
      [entry({ name: "ui-z", tls: "z:1" }), entry({ name: "ui-a", tls: "a:1" })],
    );
    expect(merged.map((peer) => peer.name)).toEqual(["cfg-a", "cfg-b", "ui-z", "ui-a"]);
  });
});
