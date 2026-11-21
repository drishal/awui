// Mesh policy (policy.ts): the closed capability vocabulary, the built-ins and
// their config merges, the ceiling a request can never raise, hop refusal, and
// the roots' realpath confinement (a `..`, an outside symlink, a NUL byte, or
// a relative path never reaches a file).
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_POLICIES,
  CAPS,
  CEILINGS,
  clampCeiling,
  checkHops,
  decide,
  expandRoot,
  harnessAllowed,
  resolveInRoots,
  resolvePolicies,
  type Cap,
  type PeerPolicy,
} from "../../src/server/mesh/policy.js";

describe("the closed vocabulary", () => {
  it("is exactly the spec's caps, ordered, with no exec of any kind", () => {
    expect([...CAPS]).toEqual(["discover", "task.run", "task.approve", "fs.read", "fs.write", "term.open"]);
    expect(CEILINGS).toEqual(["read-only", "default", "auto-edit"]);
  });

  it("ships the three built-ins with the spec's values", () => {
    expect([...BUILTIN_POLICIES.none.caps, ...BUILTIN_POLICIES.none.ask]).toEqual([]);
    expect(BUILTIN_POLICIES.none.roots).toEqual([]);
    expect(BUILTIN_POLICIES.none.harnesses).toEqual([]);
    expect(BUILTIN_POLICIES.none.permissionCeiling).toBe("read-only");
    expect(BUILTIN_POLICIES.none.maxTasks).toBe(1);
    expect(BUILTIN_POLICIES.none.approvalsAt).toBe("target");
    expect(BUILTIN_POLICIES.worker.caps).toEqual(["discover", "task.run", "task.approve", "fs.read"]);
    expect(BUILTIN_POLICIES.worker.ask).toEqual(["fs.write", "term.open"]);
    expect(BUILTIN_POLICIES.worker.permissionCeiling).toBe("auto-edit");
    expect(BUILTIN_POLICIES.worker.maxTasks).toBe(4);
    expect(BUILTIN_POLICIES.worker.approvalsAt).toBe("origin");
    expect(BUILTIN_POLICIES.peer.caps).toEqual(["discover"]);
    expect(BUILTIN_POLICIES.peer.ask).toEqual(["task.run", "fs.read", "fs.write", "term.open"]);
    expect(BUILTIN_POLICIES.peer.harnesses).toEqual(["pi", "claude", "codex"]);
    expect(BUILTIN_POLICIES.peer.permissionCeiling).toBe("read-only");
    expect(BUILTIN_POLICIES.peer.maxTasks).toBe(2);
    expect(BUILTIN_POLICIES.peer.approvalsAt).toBe("target");
    // The built-ins are frozen: a merged copy is never a way to edit them in place.
    expect(Object.isFrozen(BUILTIN_POLICIES)).toBe(true);
  });
});

describe("resolvePolicies", () => {
  it("returns the built-ins when nothing is configured", () => {
    const resolved = resolvePolicies(undefined);
    expect([...resolved.keys()].sort()).toEqual(["none", "peer", "worker"]);
    expect(resolved.get("worker")).toEqual(BUILTIN_POLICIES.worker);
    expect(resolved.get("none")).toEqual(BUILTIN_POLICIES.none);
  });

  it("merges a config entry over the built-in of the same name", () => {
    const resolved = resolvePolicies({
      worker: {
        caps: ["discover", "task.run", "task.run"],
        ask: ["fs.write"],
        roots: ["~/code"],
        harnesses: ["pi"],
        permission_ceiling: "read-only",
        max_tasks: 2,
        max_file_bytes: 52428800,
        approvals_at: "both",
      },
    });
    const worker = resolved.get("worker")!;
    expect(worker.caps).toEqual(["discover", "task.run"]); // deduped, rest inherited
    expect(worker.ask).toEqual(["fs.write"]);
    expect(worker.roots).toEqual(["~/code"]);
    expect(worker.harnesses).toEqual(["pi"]);
    expect(worker.permissionCeiling).toBe("read-only");
    expect(worker.maxTasks).toBe(2);
    expect(worker.approvalsAt).toBe("both");
    // A merged policy is a copy: editing it never touches the built-in or a fresh resolve.
    worker.caps.push("term.open");
    expect(BUILTIN_POLICIES.worker.caps).not.toContain("term.open");
    expect(resolvePolicies(undefined).get("worker")!.caps).not.toContain("term.open");
  });

  it("starts a new name from none's defaults", () => {
    const resolved = resolvePolicies({ guest: { caps: ["discover"] } });
    const guest = resolved.get("guest")!;
    expect(guest.caps).toEqual(["discover"]);
    expect(guest.ask).toEqual([]);
    expect(guest.roots).toEqual([]);
    expect(guest.harnesses).toEqual([]);
    expect(guest.permissionCeiling).toBe("read-only");
    expect(guest.maxTasks).toBe(1);
    expect(guest.approvalsAt).toBe("target");
  });

  it("refuses an override of none, and keeps a cap in both lists only in ask", () => {
    expect(() => resolvePolicies({ none: { caps: ["fs.write"] } })).toThrow();
    const worker = resolvePolicies({ worker: { caps: ["fs.write"], ask: ["fs.write"] } }).get("worker")!;
    expect(worker.caps).toEqual([]);
    expect(worker.ask).toEqual(["fs.write"]);
    expect(decide(worker, "fs.write")).toEqual({ kind: "ask", at: "origin" });
  });
});

describe("decide", () => {
  it("allows a granted cap, asks for an ask cap where the policy says, denies the rest", () => {
    const resolved = resolvePolicies(undefined);
    const worker = resolved.get("worker")!;
    const peer = resolved.get("peer")!;
    expect(decide(worker, "fs.read")).toEqual({ kind: "allow" });
    expect(decide(worker, "fs.write")).toEqual({ kind: "ask", at: "origin" });
    expect(decide(peer, "discover")).toEqual({ kind: "allow" });
    expect(decide(peer, "task.run")).toEqual({ kind: "ask", at: "target" });
    expect(decide(worker, "term.open")).toEqual({ kind: "ask", at: "origin" });
    // The deny carries a reason a person can read.
    const denied = decide(worker, "nope" as Cap);
    expect(denied.kind).toBe("deny");
    if (denied.kind === "deny") expect(denied.reason).toMatch(/nope/);
  });

  it("denies every capability under none: handshakes only", () => {
    const none = resolvePolicies(undefined).get("none")!;
    for (const cap of CAPS) expect(decide(none, cap).kind).toBe("deny");
  });
});

describe("clampCeiling", () => {
  it("never raises what the policy grants", () => {
    const resolved = resolvePolicies(undefined);
    const peer = resolved.get("peer")!; // read-only
    expect(clampCeiling(peer, undefined)).toBe("read-only");
    expect(clampCeiling(peer, "read-only")).toBe("read-only");
    expect(clampCeiling(peer, "default")).toBe("read-only");
    expect(clampCeiling(peer, "auto-edit")).toBe("read-only");
    const worker = resolved.get("worker")!; // auto-edit
    expect(clampCeiling(worker, undefined)).toBe("auto-edit");
    expect(clampCeiling(worker, "auto-edit")).toBe("auto-edit");
    expect(clampCeiling(worker, "default")).toBe("default");
    expect(clampCeiling(worker, "read-only")).toBe("read-only");
  });
});

describe("harnesses and hops", () => {
  it("allows exactly the policy's harness allowlist, pi/claude/codex by default", () => {
    const peer = resolvePolicies(undefined).get("peer")!;
    expect(harnessAllowed(peer, "pi")).toBe(true);
    expect(harnessAllowed(peer, "claude")).toBe(true);
    expect(harnessAllowed(peer, "codex")).toBe(true);
    expect(harnessAllowed(peer, "omp")).toBe(false);
    const narrowed = resolvePolicies({ worker: { harnesses: ["pi"] } }).get("worker")!;
    expect(harnessAllowed(narrowed, "pi")).toBe(true);
    expect(harnessAllowed(narrowed, "claude")).toBe(false);
    expect(harnessAllowed(resolvePolicies(undefined).get("none")!, "pi")).toBe(false);
  });

  it("refuses anything that has already hopped once", () => {
    expect(checkHops(0)).toBe(true);
    expect(checkHops(1)).toBe(false);
    expect(checkHops(2)).toBe(false);
    // The parameter is the schema's literal 1; the refusal is the point, not the default.
    expect(checkHops(1, 2)).toBe(true);
  });
});

describe("expandRoot", () => {
  const home = "/home/whoever";

  it("expands ~ and ~/ and keeps absolute paths", () => {
    expect(expandRoot("~", home)).toBe(home);
    expect(expandRoot("~/code", home)).toBe(path.join(home, "code"));
    expect(expandRoot("/srv/projects", home)).toBe("/srv/projects");
  });

  it("throws on relative paths and NUL bytes", () => {
    expect(() => expandRoot("code", home)).toThrow();
    expect(() => expandRoot("./code", home)).toThrow();
    expect(() => expandRoot("~other/code", home)).toThrow();
    expect(() => expandRoot("/a\0b", home)).toThrow();
  });
});

describe("resolveInRoots", () => {
  /** A scratch tree: <dir>/root exists with a file and a subfolder; <dir>/secret is outside. */
  const scratch = (): { dir: string; root: string; outside: string } => {
    const dir = mkdtempSync(path.join(tmpdir(), "awui-mesh-roots-"));
    const root = path.join(dir, "root");
    mkdirSync(root);
    mkdirSync(path.join(root, "sub"), { recursive: true });
    writeFileSync(path.join(root, "file.txt"), "x");
    const outside = path.join(dir, "secret");
    mkdirSync(outside);
    writeFileSync(path.join(outside, "s.txt"), "x");
    return { dir, root, outside };
  };

  /** A none-based policy granting exactly these roots. */
  const withRoots = (roots: string[]): PeerPolicy => ({ ...BUILTIN_POLICIES.none, roots });

  it("resolves existing files, ~ forms, and not-yet-existing paths inside a root", async () => {
    const { dir, root } = scratch();
    const ok = await resolveInRoots(withRoots([root]), path.join(root, "file.txt"), dir);
    expect(ok).toEqual({ ok: true, real: path.join(root, "file.txt"), root });
    // A file that does not exist yet resolves through its nearest existing ancestor.
    const future = await resolveInRoots(withRoots([root]), path.join(root, "new", "deep", "f.txt"), dir);
    expect(future).toEqual({ ok: true, real: path.join(root, "new", "deep", "f.txt"), root });
    // Tilde forms work on both sides: the root as ~/meshroot, the request as ~/....
    mkdirSync(path.join(dir, "meshroot"));
    const viaTilde = await resolveInRoots(withRoots(["~/meshroot"]), "~/meshroot", dir);
    expect(viaTilde).toEqual({ ok: true, real: path.join(dir, "meshroot"), root: path.join(dir, "meshroot") });
    // A missing root is skipped, not fatal: the second root still grants.
    const second = await resolveInRoots(withRoots([path.join(dir, "nope"), root]), path.join(root, "file.txt"), dir);
    expect(second).toEqual({ ok: true, real: path.join(root, "file.txt"), root });
  });

  it("refuses a .. escape, an outside symlink, a NUL byte, a relative path, and empty or missing roots", async () => {
    const { dir, root, outside } = scratch();
    // Lexical and appended ".." both land outside the root.
    expect((await resolveInRoots(withRoots([root]), path.join(root, "..", "secret", "s.txt"), dir)).ok).toBe(false);
    expect((await resolveInRoots(withRoots([root]), path.join(root, "new", "..", "..", "secret"), dir)).ok).toBe(false);
    // A literal ".." is refused even when it would fold back inside the root.
    expect((await resolveInRoots(withRoots([root]), `${root}/sub/../file.txt`, dir)).ok).toBe(false);
    // A symlink inside the root pointing outside it: realpath resolves away, containment fails.
    symlinkSync(outside, path.join(root, "leak"));
    expect((await resolveInRoots(withRoots([root]), path.join(root, "leak", "s.txt"), dir)).ok).toBe(false);
    expect((await resolveInRoots(withRoots([root]), path.join(root, "leak"), dir)).ok).toBe(false);
    // A symlink that stays inside the root resolves to the real path.
    symlinkSync(path.join(root, "sub"), path.join(root, "in"));
    const inside = await resolveInRoots(withRoots([root]), path.join(root, "in"), dir);
    expect(inside).toEqual({ ok: true, real: path.join(root, "sub"), root });
    // A NUL byte and a relative path never touch the filesystem.
    expect((await resolveInRoots(withRoots([root]), `${root}/a\0b`, dir)).ok).toBe(false);
    expect((await resolveInRoots(withRoots([root]), "sub/file.txt", dir)).ok).toBe(false);
    // No roots at all (none's policy), and a root that does not exist, grant nothing.
    expect((await resolveInRoots(BUILTIN_POLICIES.none, path.join(root, "file.txt"), dir)).ok).toBe(false);
    expect((await resolveInRoots(withRoots([path.join(dir, "missing")]), path.join(root, "file.txt"), dir)).ok).toBe(false);
  });
});
