// Moving a saved mesh peer into config.yml: comments and order survive, a
// rendered (symlinked) or mesh-off config is refused untouched, and a moved
// peer leaves peers.json so one machine has one entry.
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendMeshPeer, syncPeersToConfig } from "../../src/server/mesh/config-edit.js";
import { PeerPeersStore } from "../../src/server/mesh/peer-store.js";
import { readUserConfig } from "../../src/server/user-config.js";
import { tempDir } from "../helpers/app.js";

const CONFIG = `# keep this comment
mesh:
  enabled: true
  name: leader-box
  policies:
    worker:
      roots: [/tmp]
`;

function configDirWith(text = CONFIG): { dir: string; file: string } {
  const dir = tempDir("awui-mesh-config-edit-");
  const file = path.join(dir, "config.yml");
  writeFileSync(file, text);
  return { dir, file };
}

describe("mesh config.yml sync", () => {
  it("appends a peer under mesh.peers, keeps comments, and leaves the file valid", () => {
    const { dir, file } = configDirWith();
    expect(appendMeshPeer(dir, { name: "lab", tls: "127.0.0.1:4784" })).toEqual({ ok: true, already: false });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# keep this comment");
    expect(text).toContain("name: lab");
    expect(text).toContain("tls: 127.0.0.1:4784");
    const parsed = readUserConfig(dir)?.config;
    expect(parsed?.mesh?.peers?.map((peer) => peer.name)).toEqual(["lab"]);
    // The same peer twice is not an error and not a second entry.
    expect(appendMeshPeer(dir, { name: "lab", tls: "127.0.0.1:4784" })).toEqual({ ok: true, already: true });
    expect(readUserConfig(dir)?.config.mesh?.peers).toHaveLength(1);
  });

  it("refuses a symlinked config.yml, a config whose mesh is off, and a missing folder", () => {
    const target = configDirWith();
    const linkedDir = tempDir("awui-mesh-config-link-");
    symlinkSync(target.file, path.join(linkedDir, "config.yml"));
    expect(appendMeshPeer(linkedDir, { name: "lab", tls: "127.0.0.1:4784" })).toMatchObject({ ok: false, reason: expect.stringMatching(/symlink/) });
    const off = configDirWith(CONFIG.replace("enabled: true", "enabled: false"));
    expect(appendMeshPeer(off.dir, { name: "lab", tls: "127.0.0.1:4784" })).toMatchObject({ ok: false, reason: expect.stringMatching(/mesh\.enabled/) });
    expect(appendMeshPeer(null, { name: "lab", tls: "127.0.0.1:4784" })).toMatchObject({ ok: false, reason: expect.stringMatching(/settings folder/) });
    // Nothing was written through the refusal.
    expect(readFileSync(target.file, "utf8")).toContain("mesh:");
  });

  it("moves saved peers into config.yml and out of peers.json", async () => {
    const { dir, file } = configDirWith();
    const saved = PeerPeersStore(path.join(tempDir("awui-mesh-config-state-"), "mesh", "peers.json"));
    await saved.add({ name: "one", tls: "10.0.0.1:4784" });
    await saved.add({ name: "two", ssh: "user@two" });
    const result = await syncPeersToConfig(dir, saved);
    expect(result.moved.sort()).toEqual(["one", "two"]);
    expect(result.kept).toEqual([]);
    expect(await saved.list()).toEqual([]);
    const text = readFileSync(file, "utf8");
    expect(text).toContain("name: one");
    expect(text).toContain("name: two");
  });

  it("moves only the named peers, and reports a name no saved peer has", async () => {
    const { dir } = configDirWith();
    const saved = PeerPeersStore(path.join(tempDir("awui-mesh-config-state-"), "mesh", "peers.json"));
    await saved.add({ name: "one", tls: "10.0.0.1:4784" });
    await saved.add({ name: "two", tls: "10.0.0.2:4784" });
    const result = await syncPeersToConfig(dir, saved, ["one", "ghost"]);
    expect(result.moved).toEqual(["one"]);
    expect(result.unknown).toEqual(["ghost"]);
    expect((await saved.list()).map((peer) => peer.name)).toEqual(["two"]);
  });
});
