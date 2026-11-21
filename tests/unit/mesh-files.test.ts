// Mesh fs.* (P1.5 §3): every rule the worker enforces on a file request gets
// its own test, against the real functions with a real temp root first (the
// resolution guards, the symlink refusals, the size bounds, create vs
// overwrite, the expectMtimeMs conflict, atomic temp cleanup), then through a
// real serve() link over a memoryLink pair for what only the link decides: the
// fs.read / fs.write caps, the per-link write pace, and audit lines that carry
// the path and byte counts, never the bytes themselves.
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { AuditLog } from "../../src/server/mesh/audit.js";
import { fsList, fsRead, fsStat, fsWrite, MAX_RW_BYTES } from "../../src/server/mesh/files.js";
import { clientHandshake } from "../../src/server/mesh/handshake.js";
import { nodeIdOf, type NodeIdentity } from "../../src/server/mesh/identity.js";
import { DEFAULT_MAX_FILE_BYTES, type PeerPolicy } from "../../src/server/mesh/policy.js";
import { PinStore } from "../../src/server/mesh/pins.js";
import { MeshErrorCode, MeshRpcError, RpcPeer } from "../../src/server/mesh/rpc.js";
import { serve, type ServeDeps } from "../../src/server/mesh/serve.js";
import { memoryLink } from "../../src/server/mesh/transport.js";
import type { MeshConfig } from "../../src/server/user-config.js";

const HOME = tmpdir();
const b64 = (bytes: Buffer | string): string => Buffer.from(bytes).toString("base64");

/** One fs call that must fail, answered with the MeshRpcError it threw. */
async function refuse<T>(call: () => Promise<T>): Promise<MeshRpcError> {
  return call().then(
    () => {
      throw new Error("expected the call to be refused");
    },
    (error) => {
      expect(error).toBeInstanceOf(MeshRpcError);
      return error as MeshRpcError;
    },
  );
}

const fixtures: string[] = [];
afterAll(async () => {
  await Promise.all(fixtures.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A temp root the policy grants, a dir outside it, and a policy pointing at the root. */
async function makeRoot(): Promise<{ root: string; outside: string; policy: (over?: Partial<PeerPolicy>) => PeerPolicy }> {
  const root = await mkdtemp(path.join(HOME, "mesh-files-root-"));
  const outside = await mkdtemp(path.join(HOME, "mesh-files-out-"));
  fixtures.push(root, outside);
  const base: PeerPolicy = {
    caps: ["fs.read", "fs.write"],
    ask: [],
    roots: [root],
    harnesses: [],
    permissionCeiling: "read-only",
    maxTasks: 1,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    approvalsAt: "origin",
  };
  return { root, outside, policy: (over = {}) => ({ ...base, ...over }) };
}

describe("fs paths against the policy's roots", () => {
  it("refuses a path that climbs with .., one outside the roots, and a symlinked parent that leaves the root", async () => {
    const { root, outside, policy } = await makeRoot();
    const climb = await refuse(() => fsStat(policy(), { path: `${root}/../x` }, HOME));
    expect(climb.code).toBe(MeshErrorCode.denied);
    expect(climb.message).toContain("..");
    const foreign = await refuse(() => fsStat(policy(), { path: outside }, HOME));
    expect(foreign.code).toBe(MeshErrorCode.denied);
    expect(foreign.message).toContain("outside the policy's roots");
    await symlink(outside, path.join(root, "escape"));
    const throughParent = await refuse(() => fsRead(policy(), { path: path.join(root, "escape", "f") }, HOME));
    expect(throughParent.code).toBe(MeshErrorCode.denied);
    const writeThrough = await refuse(() => fsWrite(policy(), { path: path.join(root, "escape", "f"), data: b64("x"), mode: "create" }, HOME));
    expect(writeThrough.code).toBe(MeshErrorCode.denied);
  });

  it("refuses a final symlink for read and write, whatever it points at, and never follows one for stat", async () => {
    const { root, outside, policy } = await makeRoot();
    await writeFile(path.join(root, "real"), "hello");
    await symlink(path.join(root, "real"), path.join(root, "alias"));
    // A link whose referent sits inside the root is still described, never followed.
    const described = await fsStat(policy(), { path: path.join(root, "alias") }, HOME);
    expect(described.type).toBe("symlink");
    expect(described.size).toBe(Buffer.byteLength(path.join(root, "real")));
    const read = await refuse(() => fsRead(policy(), { path: path.join(root, "alias") }, HOME));
    expect(read.code).toBe(MeshErrorCode.denied);
    expect(read.message).toContain("symlink");
    const overwrite = await refuse(() => fsWrite(policy(), { path: path.join(root, "alias"), data: b64("x"), mode: "overwrite" }, HOME));
    expect(overwrite.code).toBe(MeshErrorCode.denied);
    const create = await refuse(() => fsWrite(policy(), { path: path.join(root, "alias"), data: b64("x"), mode: "create" }, HOME));
    expect(create.code).toBe(MeshErrorCode.denied);
    expect(create.message).toContain("already exists");
    // A link whose referent leaves the root is refused before anything is said about it.
    await symlink(outside, path.join(root, "out"));
    const outRead = await refuse(() => fsRead(policy(), { path: path.join(root, "out") }, HOME));
    expect(outRead.code).toBe(MeshErrorCode.denied);
    const outStat = await refuse(() => fsStat(policy(), { path: path.join(root, "out") }, HOME));
    expect(outStat.code).toBe(MeshErrorCode.denied);
  });

  it("follows a symlinked parent that stays inside the root, and refuses a final symlink named from outside", async () => {
    const { root, outside, policy } = await makeRoot();
    await mkdir(path.join(root, "b"));
    await writeFile(path.join(root, "b", "f"), "hello");
    await symlink(path.join(root, "b"), path.join(root, "a"));
    // The parent link resolves inside the root, so the read is of the entry the policy grants.
    const read = await fsRead(policy(), { path: path.join(root, "a", "f") }, HOME);
    expect(read.data).toBe(b64("hello"));
    expect(read.eof).toBe(true);
    // A final symlink named from outside the roots is refused even though its referent sits inside one.
    await symlink(path.join(root, "b", "f"), path.join(outside, "sneaky"));
    const sneaky = await refuse(() => fsRead(policy(), { path: path.join(outside, "sneaky") }, HOME));
    expect(sneaky.code).toBe(MeshErrorCode.denied);
    expect(sneaky.message).toContain("outside the policy's roots");
  });

  it("answers a missing path with not_found and the root itself with its own shape", async () => {
    const { root, policy } = await makeRoot();
    const missing = await refuse(() => fsStat(policy(), { path: path.join(root, "not-there") }, HOME));
    expect(missing.code).toBe(MeshErrorCode.not_found);
    const rootStat = await fsStat(policy(), { path: root }, HOME);
    expect(rootStat.type).toBe("dir");
    const listed = await fsList(policy(), { path: root }, HOME);
    expect(listed.truncated).toBe(false);
  });
});

describe("fs.stat and fs.list", () => {
  it("stats a file with its size, mtime, and mode", async () => {
    const { root, policy } = await makeRoot();
    await writeFile(path.join(root, "a.txt"), "hello");
    const st = await fsStat(policy(), { path: path.join(root, "a.txt") }, HOME);
    expect(st.type).toBe("file");
    expect(st.size).toBe(5);
    expect(st.mtimeMs).toBeGreaterThan(0);
    expect(st.mode & 0o777).toBe(0o644);
  });

  it("lists dotfiles, sorts by name, types each entry, and truncates at the limit", async () => {
    const { root, policy } = await makeRoot();
    await writeFile(path.join(root, "b.txt"), "12345");
    await writeFile(path.join(root, "a.md"), "1");
    await writeFile(path.join(root, ".hidden"), "");
    await fsWrite(policy(), { path: path.join(root, "made"), data: b64("ab"), mode: "create" }, HOME);
    await symlink(path.join(root, "a.md"), path.join(root, "link"));
    const full = await fsList(policy(), { path: root }, HOME);
    expect(full.entries.map((e) => e.name)).toEqual([".hidden", "a.md", "b.txt", "link", "made"]);
    expect(full.entries.map((e) => e.type)).toEqual(["file", "file", "file", "symlink", "file"]);
    expect(full.entries.find((e) => e.name === "b.txt")?.size).toBe(5);
    expect(full.truncated).toBe(false);
    const cut = await fsList(policy(), { path: root, limit: 2 }, HOME);
    expect(cut.entries.map((e) => e.name)).toEqual([".hidden", "a.md"]);
    expect(cut.truncated).toBe(true);
    const bad = await refuse(() => fsList(policy(), { path: root, limit: 1001 }, HOME));
    expect(bad.code).toBe(MeshErrorCode.invalid_params);
    const onFile = await refuse(() => fsList(policy(), { path: path.join(root, "a.md") }, HOME));
    expect(onFile.code).toBe(MeshErrorCode.denied);
    const throughLink = await refuse(() => fsList(policy(), { path: path.join(root, "link") }, HOME));
    expect(throughLink.code).toBe(MeshErrorCode.denied);
  });
});

describe("fs.read", () => {
  it("pages through a binary file with base64, and answers eof honestly", async () => {
    const { root, policy } = await makeRoot();
    const bytes = randomBytes(1000);
    await writeFile(path.join(root, "blob"), bytes);
    const first = await fsRead(policy(), { path: path.join(root, "blob"), offset: 10, length: 100 }, HOME);
    expect(Buffer.from(first.data, "base64")).toEqual(bytes.subarray(10, 110));
    expect(first.size).toBe(1000);
    expect(first.eof).toBe(false);
    const rest = await fsRead(policy(), { path: path.join(root, "blob"), offset: 900 }, HOME);
    expect(Buffer.from(rest.data, "base64")).toEqual(bytes.subarray(900));
    expect(rest.eof).toBe(true);
    const past = await fsRead(policy(), { path: path.join(root, "blob"), offset: 5000 }, HOME);
    expect(past.data).toBe("");
    expect(past.eof).toBe(true);
    const onDir = await refuse(() => fsRead(policy(), { path: root }, HOME));
    expect(onDir.code).toBe(MeshErrorCode.denied);
    const missing = await refuse(() => fsRead(policy(), { path: path.join(root, "gone") }, HOME));
    expect(missing.code).toBe(MeshErrorCode.not_found);
  });

  it("reads one wire-sized slice by default and refuses a longer slice with limit", async () => {
    const { root, policy } = await makeRoot();
    await writeFile(path.join(root, "big"), randomBytes(2 * MAX_RW_BYTES));
    const first = await fsRead(policy(), { path: path.join(root, "big") }, HOME);
    expect(Buffer.from(first.data, "base64").length).toBe(MAX_RW_BYTES);
    expect(first.eof).toBe(false);
    const second = await fsRead(policy(), { path: path.join(root, "big"), offset: MAX_RW_BYTES }, HOME);
    expect(Buffer.from(second.data, "base64").length).toBe(MAX_RW_BYTES);
    expect(second.eof).toBe(true);
    // A full slice, base64 inside a JSON-RPC reply, still fits one 1 MiB wire line.
    expect(JSON.stringify({ jsonrpc: "2.0", id: 1, result: first }).length + 1).toBeLessThan(1024 * 1024);
    const tooBig = await refuse(() => fsRead(policy(), { path: path.join(root, "big"), length: MAX_RW_BYTES + 1 }, HOME));
    expect(tooBig.code).toBe(MeshErrorCode.limit);
  });
});

describe("fs.write", () => {
  it("creates a file, and refuses to replace one that exists", async () => {
    const { root, policy } = await makeRoot();
    const made = await fsWrite(policy(), { path: path.join(root, "new.txt"), data: b64("hello"), mode: "create" }, HOME);
    expect(made.size).toBe(5);
    expect(await readFile(path.join(root, "new.txt"), "utf8")).toBe("hello");
    const again = await refuse(() => fsWrite(policy(), { path: path.join(root, "new.txt"), data: b64("other"), mode: "create" }, HOME));
    expect(again.code).toBe(MeshErrorCode.denied);
    expect(again.message).toContain("already exists");
    expect(await readFile(path.join(root, "new.txt"), "utf8")).toBe("hello");
  });

  it("overwrites only a regular file, keeps its mode, and refuses a directory", async () => {
    const { root, policy } = await makeRoot();
    const file = path.join(root, "kept.txt");
    await writeFile(file, "first", { mode: 0o600 });
    const before = await fsStat(policy(), { path: file }, HOME);
    const wrote = await fsWrite(policy(), { path: file, data: b64("second"), mode: "overwrite", expectMtimeMs: before.mtimeMs }, HOME);
    expect(wrote.size).toBe(6);
    expect(await readFile(file, "utf8")).toBe("second");
    // The original's mode survives the temp-file round trip.
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const onDir = await refuse(() => fsWrite(policy(), { path: root, data: b64("x"), mode: "overwrite" }, HOME));
    expect(onDir.code).toBe(MeshErrorCode.denied);
    expect(onDir.message).toContain("regular files");
    const missing = await refuse(() => fsWrite(policy(), { path: path.join(root, "gone"), data: b64("x"), mode: "overwrite" }, HOME));
    expect(missing.code).toBe(MeshErrorCode.not_found);
  });

  it("never carries setuid/setgid bits onto content a peer wrote", async () => {
    const { root, policy } = await makeRoot();
    const file = path.join(root, "tool");
    await writeFile(file, "orig");
    await chmod(file, 0o4755);
    await fsWrite(policy(), { path: file, data: b64("new"), mode: "overwrite" }, HOME);
    expect((await stat(file)).mode & 0o7777).toBe(0o755);
  });

  it("turns a stale expectMtimeMs into a conflict, never a clobber", async () => {
    const { root, policy } = await makeRoot();
    const file = path.join(root, "race.txt");
    await fsWrite(policy(), { path: file, data: b64("first"), mode: "create" }, HOME);
    // The caller's clock is pinned far in the past, so any later write certainly moves the mtime.
    const touched = new Date(Math.floor(Date.now() / 2));
    await utimes(file, touched, touched);
    const before = await fsStat(policy(), { path: file }, HOME);
    await fsWrite(policy(), { path: file, data: b64("second"), mode: "overwrite", expectMtimeMs: before.mtimeMs }, HOME);
    const stale = await refuse(() => fsWrite(policy(), { path: file, data: b64("third"), mode: "overwrite", expectMtimeMs: before.mtimeMs }, HOME));
    expect(stale.code).toBe(MeshErrorCode.invalid_params);
    expect(stale.message).toContain("changed since read");
    expect(await readFile(file, "utf8")).toBe("second");
    // An expected mtime for a file that no longer exists is a conflict too, not a create.
    await rm(file);
    const gone = await refuse(() => fsWrite(policy(), { path: file, data: b64("third"), mode: "overwrite", expectMtimeMs: before.mtimeMs }, HOME));
    expect(gone.code).toBe(MeshErrorCode.invalid_params);
    const created = await refuse(() => fsWrite(policy(), { path: path.join(root, "fresh"), data: b64("x"), mode: "create", expectMtimeMs: before.mtimeMs }, HOME));
    expect(created.code).toBe(MeshErrorCode.invalid_params);
  });

  it("round-trips binary bytes through base64", async () => {
    const { root, policy } = await makeRoot();
    const bytes = randomBytes(4096);
    await fsWrite(policy(), { path: path.join(root, "blob"), data: b64(bytes), mode: "create" }, HOME);
    const back = await fsRead(policy(), { path: path.join(root, "blob") }, HOME);
    expect(Buffer.from(back.data, "base64")).toEqual(bytes);
    expect(back.eof).toBe(true);
  });

  it("refuses a payload over the 4 MiB bound with limit", async () => {
    const { root, policy } = await makeRoot();
    const tooBig = await refuse(() => fsWrite(policy(), { path: path.join(root, "big"), data: b64(Buffer.alloc(MAX_RW_BYTES + 1)), mode: "create" }, HOME));
    expect(tooBig.code).toBe(MeshErrorCode.limit);
  });

  it("leaves no temp file behind and never touches the target when the rename fails", async () => {
    const { root, policy } = await makeRoot();
    const file = path.join(root, "kept.txt");
    await writeFile(file, "first");
    const wrote = await refuse(() =>
      fsWrite(policy(), { path: file, data: b64("second"), mode: "overwrite" }, HOME, { failBeforeRename: () => { throw new Error("injected rename failure"); } }),
    );
    // An unexpected failure stays a generic internal answer; its local detail never crosses the link.
    expect(wrote.code).toBe(MeshErrorCode.internal_error);
    expect(await readFile(file, "utf8")).toBe("first");
    const names = await readdir(root);
    expect(names.filter((name) => name.includes(".awui-") && name.endsWith(".tmp"))).toEqual([]);
    // The create case fails the same way: no target, and no temp left behind.
    const freshFail = await refuse(() =>
      fsWrite(policy(), { path: path.join(root, "fresh"), data: b64("second"), mode: "create" }, HOME, { failBeforeRename: () => { throw new Error("injected rename failure"); } }),
    );
    expect(freshFail.code).toBe(MeshErrorCode.internal_error);
    expect(await readdir(root)).toEqual(["kept.txt"]);
  });
});

// ---------------------------------------------------------------------------
// Through serve(): the caps, the write pace, and the audit line.

function identity(): NodeIdentity {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = Buffer.from(publicKey.export({ type: "spki", format: "der" })).subarray(-32);
  return { publicKey: raw, privateKey, nodeId: nodeIdOf(raw) };
}

/** One worker's world for a served link: temp state, real pins and audit, mutable mesh config. */
interface LinkFixture {
  root: string;
  serverIdentity: NodeIdentity;
  pins: PinStore;
  auditFile: string;
  mesh: MeshConfig;
}

async function makeLinkFixture(): Promise<LinkFixture> {
  const stateDir = await mkdtemp(path.join(HOME, "mesh-files-state-"));
  const root = await mkdtemp(path.join(HOME, "mesh-files-linkroot-"));
  fixtures.push(stateDir, root);
  return {
    root,
    serverIdentity: identity(),
    pins: PinStore(path.join(stateDir, "mesh", "pins.json")),
    auditFile: path.join(stateDir, "mesh", "audit.jsonl"),
    mesh: { enabled: true, policies: { filer: { caps: ["discover", "fs.read", "fs.write"], roots: [root] } } },
  };
}

/** One served link and a paired client under the named policy. */
async function connectPaired(f: LinkFixture, policy: string): Promise<{ client: RpcPeer; closed: Promise<string> }> {
  const link = memoryLink();
  const deps: ServeDeps = {
    identity: f.serverIdentity,
    name: "target-box",
    pins: f.pins,
    audit: new AuditLog(f.auditFile, () => undefined),
    registry: { get: () => undefined, available: async () => false },
    config: () => f.mesh,
    enabled: () => true,
    home: HOME,
  };
  const { closed } = serve({ input: link.server.input, output: link.server.output }, deps);
  const client = new RpcPeer(link.client.input, link.client.output, { role: "client" });
  client.start();
  const who = identity();
  await f.pins.setInbound(who.publicKey, "leader-box", policy, "accept");
  await clientHandshake(client, { identity: who, name: "leader-box", hops: 0, expectedServerKey: f.serverIdentity.publicKey, tofu: false });
  return { client, closed };
}

/** One request that must fail, answered with the error the worker sent. */
async function refuseOnLink(rpc: RpcPeer, method: string, params: unknown): Promise<MeshRpcError> {
  return rpc.request(method, params).then(
    () => {
      throw new Error(`expected "${method}" to be refused`);
    },
    (error) => {
      expect(error).toBeInstanceOf(MeshRpcError);
      return error as MeshRpcError;
    },
  );
}

const tick = (ms = 5): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls until probe returns a value; audit writes land behind the answer. */
async function waitFor<T>(probe: () => T | undefined | Promise<T | undefined>, what: string): Promise<T> {
  for (let i = 0; i < 600; i++) {
    const value = await probe();
    if (value !== undefined) return value;
    await tick(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Lets a served link end cleanly, so no listener outlives its test. */
async function endLink(client: RpcPeer, closed: Promise<string>): Promise<void> {
  client.close();
  await closed;
}

describe("fs.* through a served link", () => {
  it("serves stat/list/read under the fs.read cap and answers needs_approval when fs.write is only asked for", async () => {
    const f = await makeLinkFixture();
    // The built-in worker policy allows fs.read and only asks for fs.write.
    f.mesh = { enabled: true, policies: { worker: { roots: [f.root] } } };
    const { client, closed } = await connectPaired(f, "worker");
    await writeFile(path.join(f.root, "a.txt"), "hello");
    const st = await client.request<{ type: string; size: number }>("fs.stat", { path: path.join(f.root, "a.txt") });
    expect(st.type).toBe("file");
    expect(st.size).toBe(5);
    const listed = await client.request<{ entries: { name: string }[]; truncated: boolean }>("fs.list", { path: f.root });
    expect(listed.entries.map((e) => e.name)).toEqual(["a.txt"]);
    const read = await client.request<{ data: string; eof: boolean }>("fs.read", { path: path.join(f.root, "a.txt") });
    expect(Buffer.from(read.data, "base64").toString("utf8")).toBe("hello");
    expect(read.eof).toBe(true);
    const write = await refuseOnLink(client, "fs.write", { path: path.join(f.root, "b.txt"), data: b64("x"), mode: "create" });
    expect(write.code).toBe(MeshErrorCode.needs_approval);
    expect(write.data).toEqual({ code: "needs_approval" });
    const climb = await refuseOnLink(client, "fs.stat", { path: `${f.root}/../x` });
    expect(climb.code).toBe(MeshErrorCode.denied);
    await endLink(client, closed);
  });

  it("a read-only policy can stat and read but not write", async () => {
    const f = await makeLinkFixture();
    f.mesh = { enabled: true, policies: { reader: { caps: ["discover", "fs.read"], roots: [f.root] } } };
    const { client, closed } = await connectPaired(f, "reader");
    await writeFile(path.join(f.root, "a.txt"), "hello");
    const st = await client.request<{ type: string }>("fs.stat", { path: path.join(f.root, "a.txt") });
    expect(st.type).toBe("file");
    await client.request("fs.read", { path: path.join(f.root, "a.txt") });
    const write = await refuseOnLink(client, "fs.write", { path: path.join(f.root, "b.txt"), data: b64("x"), mode: "create" });
    expect(write.code).toBe(MeshErrorCode.denied);
    expect(write.message).toContain("fs.write");
    await endLink(client, closed);
  });

  it("limits a link to 32 writes a minute", async () => {
    const f = await makeLinkFixture();
    const { client, closed } = await connectPaired(f, "filer");
    for (let i = 0; i < 32; i++) {
      await client.request("fs.write", { path: path.join(f.root, `w${i}.txt`), data: b64(`x${i}`), mode: "create" });
    }
    const over = await refuseOnLink(client, "fs.write", { path: path.join(f.root, "w32.txt"), data: b64("x"), mode: "create" });
    expect(over.code).toBe(MeshErrorCode.limit);
    expect(over.message).toContain("32");
    // The refused write spent its slot before it ran, so nothing was created.
    await expect(stat(path.join(f.root, "w32.txt"))).rejects.toThrow();
    await endLink(client, closed);
  });

  it("writes and reads back over the link, and audits the path and byte counts, never the bytes", async () => {
    const f = await makeLinkFixture();
    const { client, closed } = await connectPaired(f, "filer");
    const secret = "MESH-SECRET";
    const wrote = await client.request<{ size: number; mtimeMs: number }>("fs.write", { path: path.join(f.root, "note.txt"), data: b64(secret), mode: "create" });
    expect(wrote.size).toBe(secret.length);
    const read = await client.request<{ data: string; eof: boolean }>("fs.read", { path: path.join(f.root, "note.txt") });
    expect(Buffer.from(read.data, "base64").toString("utf8")).toBe(secret);
    expect(read.eof).toBe(true);
    await client.request("fs.stat", { path: path.join(f.root, "note.txt") });
    // The conflict answer travels too: a stale expectMtimeMs is invalid_params, and the file keeps its words.
    const stale = await refuseOnLink(client, "fs.write", {
      path: path.join(f.root, "note.txt"),
      data: b64("other"),
      mode: "overwrite",
      expectMtimeMs: wrote.mtimeMs - 5000,
    });
    expect(stale.code).toBe(MeshErrorCode.invalid_params);
    expect(stale.message).toContain("changed since read");
    await endLink(client, closed);
    const text = await waitFor(async () => {
      const read = await readFile(f.auditFile, "utf8").catch(() => "");
      return read.includes('"link closed"') ? read : undefined;
    }, "the audit log to settle");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(b64(secret));
    const lines = text.trim().split("\n").map((line) => JSON.parse(line) as { method: string; target?: string; decision: string; outcome?: string });
    const writeLine = lines.find((line) => line.method === "fs.write" && line.decision === "allow");
    expect(writeLine?.target).toBe(path.join(f.root, "note.txt"));
    expect(writeLine?.outcome).toBe(`${secret.length} bytes`);
    const readLine = lines.find((line) => line.method === "fs.read" && line.decision === "allow");
    expect(readLine?.outcome).toBe(`${secret.length} bytes`);
    const statLine = lines.find((line) => line.method === "fs.stat" && line.decision === "allow");
    expect(statLine?.outcome).toBe(`${secret.length} bytes`);
  });
});
