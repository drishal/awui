// Mesh peer policy (P0): the closed vocabulary of what an inbound remote peer
// may do on this machine, enforced on the target. The capability set is fixed
// and has no exec of any kind; a cap named in both `caps` and `ask` resolves
// to `ask` (stricter wins), and a requested permission ceiling can never be
// raised above the policy's own. Roots are the only filesystem surface, and
// they are resolved through realpath exactly like workspace roots, so a `..`
// or a symlink pointing outside never reaches a file.
import { promises as fs } from "node:fs";
import path from "node:path";
import { isWithin } from "../workspaces.js";

/** The closed capability vocabulary. Nothing outside this list exists, and there is no exec. */
export const CAPS = ["discover", "task.run", "task.approve", "fs.read", "fs.write", "term.open"] as const;
export type Cap = (typeof CAPS)[number];
export const isCap = (v: unknown): v is Cap => typeof v === "string" && (CAPS as readonly string[]).includes(v);

/** The permission ceiling, weakest to strongest; P1 maps these to per-harness modes. */
export const CEILINGS = ["read-only", "default", "auto-edit"] as const;
export type Ceiling = (typeof CEILINGS)[number];

/** Which harnesses a peer may drive by default; empty in the `none` policy. */
export const DEFAULT_HARNESSES = ["pi", "claude", "codex"] as const;

/** The spec's default file bound: 50 MiB, the same figure config.yml spells out. */
export const DEFAULT_MAX_FILE_BYTES = 50 * 1024 * 1024;

export type ApprovalsAt = "origin" | "target" | "both";

export interface PeerPolicy {
  /** Allowed without asking. */
  caps: Cap[];
  /** Allowed only after an approval, raised where `approvalsAt` says. */
  ask: Cap[];
  /** Absolute or ~-prefixed dirs; empty means no filesystem or workspace access at all. */
  roots: string[];
  harnesses: string[];
  permissionCeiling: Ceiling;
  /** Concurrent inbound tasks from that peer, 1..32. */
  maxTasks: number;
  /** One file's biggest payload, 1 .. 1 GiB. */
  maxFileBytes: number;
  approvalsAt: ApprovalsAt;
}

/**
 * One config.yml `mesh.policies` entry, snake_case exactly as written, all
 * fields optional: it is merged over the built-in of the same name, or over
 * `none` for a name the built-ins do not have.
 */
export interface RawPolicy {
  caps?: Cap[];
  ask?: Cap[];
  roots?: string[];
  harnesses?: string[];
  permission_ceiling?: Ceiling;
  max_tasks?: number;
  max_file_bytes?: number;
  approvals_at?: ApprovalsAt;
}

/** The built-in policies. `none` cannot be overridden; `worker` and `peer` can. */
export const BUILTIN_POLICIES: Readonly<Record<"none" | "worker" | "peer", PeerPolicy>> = Object.freeze({
  none: Object.freeze({
    caps: [],
    ask: [],
    roots: [],
    harnesses: [],
    permissionCeiling: "read-only",
    maxTasks: 1,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    approvalsAt: "target",
  } satisfies PeerPolicy),
  worker: Object.freeze({
    caps: ["discover", "task.run", "task.approve", "fs.read"],
    ask: ["fs.write", "term.open"],
    roots: [],
    harnesses: [...DEFAULT_HARNESSES],
    permissionCeiling: "auto-edit",
    maxTasks: 4,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    approvalsAt: "origin",
  } satisfies PeerPolicy),
  peer: Object.freeze({
    caps: ["discover"],
    ask: ["task.run", "fs.read", "fs.write", "term.open"],
    roots: [],
    harnesses: [...DEFAULT_HARNESSES],
    permissionCeiling: "read-only",
    maxTasks: 2,
    maxFileBytes: DEFAULT_MAX_FILE_BYTES,
    approvalsAt: "target",
  } satisfies PeerPolicy),
});

const dedupe = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** One merged policy: every array deduped, and a cap in both lists kept only in ask (stricter wins). */
function mergePolicy(base: PeerPolicy, raw: RawPolicy): PeerPolicy {
  const ask = dedupe(raw.ask ?? base.ask);
  const caps = dedupe(raw.caps ?? base.caps).filter((cap) => !ask.includes(cap));
  return {
    caps,
    ask,
    roots: dedupe(raw.roots ?? base.roots),
    harnesses: dedupe(raw.harnesses ?? base.harnesses),
    permissionCeiling: raw.permission_ceiling ?? base.permissionCeiling,
    maxTasks: raw.max_tasks ?? base.maxTasks,
    maxFileBytes: raw.max_file_bytes ?? base.maxFileBytes,
    approvalsAt: raw.approvals_at ?? base.approvalsAt,
  };
}

/** The built-in a config entry of this name is merged over: its namesake, or `none` for a new name. */
function baseOf(name: string): PeerPolicy {
  if (name === "worker") return BUILTIN_POLICIES.worker;
  if (name === "peer") return BUILTIN_POLICIES.peer;
  return BUILTIN_POLICIES.none;
}

/**
 * The full policy set: the three built-ins, each config entry merged over the
 * built-in of the same name (over `none` for a new name). An entry named
 * `none` throws — `none` is the floor every unexpected peer falls back to, so
 * it can never be loosened from config.
 */
export function resolvePolicies(raw: Record<string, RawPolicy> | undefined): Map<string, PeerPolicy> {
  const resolved = new Map<string, PeerPolicy>();
  for (const [name, policy] of Object.entries(BUILTIN_POLICIES)) resolved.set(name, mergePolicy(policy, {}));
  if (!raw) return resolved;
  for (const [name, entry] of Object.entries(raw)) {
    if (name === "none") throw new Error('The built-in mesh policy "none" cannot be overridden');
    resolved.set(name, mergePolicy(baseOf(name), entry));
  }
  return resolved;
}

/** What a capability request resolved to, and where an approval must happen if it is needed. */
export type Decision = { kind: "allow" } | { kind: "ask"; at: ApprovalsAt } | { kind: "deny"; reason: string };

/** Whether one capability is open to a peer, asked for, or refused outright. */
export function decide(policy: PeerPolicy, cap: Cap): Decision {
  if (policy.caps.includes(cap)) return { kind: "allow" };
  if (policy.ask.includes(cap)) return { kind: "ask", at: policy.approvalsAt };
  return { kind: "deny", reason: `The policy allows no "${cap}"` };
}

/** The weaker of a requested ceiling and the policy's own: a request never raises what the policy grants. */
export function clampCeiling(policy: PeerPolicy, requested: Ceiling | undefined): Ceiling {
  const want = requested ?? policy.permissionCeiling;
  const mine = CEILINGS.indexOf(policy.permissionCeiling);
  const theirs = CEILINGS.indexOf(want);
  if (theirs <= mine) return want;
  return policy.permissionCeiling;
}

/** Whether a peer may drive one harness; the closed allowlist is the policy's own. */
export function harnessAllowed(policy: PeerPolicy, harnessId: string): boolean {
  return policy.harnesses.includes(harnessId);
}

/** Expands `~` and `~/` against `home`, and refuses anything that is not absolute after that. */
export function expandRoot(root: string, home: string): string {
  if (root.includes("\0")) throw new Error("A mesh policy root contains a NUL byte");
  const expanded = root === "~" ? home : root.startsWith("~/") ? path.join(home, root.slice(2)) : root;
  if (!path.isAbsolute(expanded)) throw new Error(`A mesh policy root must be absolute or start with ~: "${root}"`);
  return expanded;
}

/** Same ~ expansion for a requested path; the two share one rule so roots and requests agree. */
function expandRequested(requestedPath: string, home: string): string {
  return requestedPath === "~" ? home : requestedPath.startsWith("~/") ? path.join(home, requestedPath.slice(2)) : requestedPath;
}

export type RootResolution = { ok: true; real: string; root: string } | { ok: false; reason: string };

/**
 * Resolves a peer's requested path against the policy's roots, after
 * realpath: the roots themselves are realpathed, and the target's nearest
 * existing ancestor is realpathed with the remaining (not yet existing)
 * segments re-appended — so a symlink anywhere in the path that leaves the
 * root is caught, and a file that does not exist yet still resolves if its
 * place is inside a root. Containment is checked with the same `isWithin`
 * workspace roots use, never a string prefix.
 */
export async function resolveInRoots(policy: PeerPolicy, requestedPath: string, home: string): Promise<RootResolution> {
  if (policy.roots.length === 0) return { ok: false, reason: "The policy grants no roots, so no filesystem access" };
  if (requestedPath.includes("\0")) return { ok: false, reason: "The requested path contains a NUL byte" };
  const expanded = expandRequested(requestedPath, home);
  if (!path.isAbsolute(expanded)) return { ok: false, reason: "A requested path must be absolute or start with ~" };
  const absolute = path.resolve(expanded);
  const realRoots: string[] = [];
  for (const root of policy.roots) {
    let real: string;
    try {
      real = await fs.realpath(expandRoot(root, home));
    } catch {
      continue; // A root that does not exist grants nothing; the others still can.
    }
    realRoots.push(real);
  }
  if (realRoots.length === 0) return { ok: false, reason: "No configured root exists on this machine" };
  // Walk up to the nearest existing ancestor, collecting the not-yet-existing tail.
  const tail: string[] = [];
  let cur = absolute;
  let existing: string | null = null;
  for (;;) {
    try {
      existing = await fs.realpath(cur);
      break;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return { ok: false, reason: "The requested path does not resolve" };
      tail.unshift(path.basename(cur));
      cur = parent;
    }
  }
  if (tail.includes("..")) return { ok: false, reason: "The requested path climbs out with '..'" };
  const real = path.join(existing, ...tail);
  const root = realRoots.find((r) => isWithin(r, real));
  if (root === undefined) return { ok: false, reason: "The requested path is outside the policy's roots" };
  return { ok: true, real, root };
}

/**
 * Whether an inbound request may run at all: true only while its hop count is
 * below max_hops (1). A request that already hopped once is refused, so a
 * remote task can never start another remote task.
 */
export function checkHops(hops: number, maxHops = 1): boolean {
  return hops < maxHops;
}
