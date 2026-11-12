// A project's own `awui.yml`, checked in at its root: the base ref a new worktree
// starts from, gitignored folders it shares with the project (symlinked into the
// tree), and one setup command to run there. It is UNTRUSTED input — a repository
// anyone can propose a change to — so the command never runs on its own: awui
// records the file's hash in its own state folder once a person trusts that exact
// file, and a run needs both the trust and an explicit click. Nothing here writes
// to the repository; the trust lives in `$XDG_STATE_HOME/awui/project-config-trust.json`.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { ProjectConfigStatus } from "../shared/protocol.js";
import { isObj, readJson, writeJson } from "./state-file.js";

/** The file a repository declares its own worktree behaviour in. */
export const PROJECT_CONFIG_FILE = "awui.yml";
/** The most of it awui reads: a settings file, not a script or a dataset. */
export const MAX_CONFIG_BYTES = 64 * 1024;
/** Entries one file may share, and the longest path or command it may name. */
export const MAX_SHARED_ENTRIES = 32;
const MAX_ENTRY_CHARS = 256;
/** A setup command's limit: long enough for a real install line, short enough to read. */
export const MAX_SETUP_CHARS = 1_000;

/** `awui.yml` as it is written: every key optional, nothing else allowed. */
export const projectConfigSchema = z
  .object({
    /** The commit-ish a new managed worktree starts from unless the person picks another. */
    base: z.string().trim().min(1).max(MAX_ENTRY_CHARS).optional(),
    /** Project-relative gitignored folders and files symlinked into a new worktree. */
    shared: z.array(z.string().trim().min(1).max(MAX_ENTRY_CHARS)).max(MAX_SHARED_ENTRIES).optional(),
    /** One command run in a new worktree, by hand, once the file is trusted. */
    setup: z.string().trim().min(1).max(MAX_SETUP_CHARS).optional(),
  })
  .strict();

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

/** A file as read: its parsed settings, its hash, and why it was refused when it was. */
export interface ProjectConfigFile {
  /** The file's sha256, cut short: enough to name one version of it in a dialog. */
  hash: string;
  config: ProjectConfig;
  /** Why the file's settings cannot be used (a bad key, an oversized file); absent when it parsed. */
  problem?: string;
}

const shortHash = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex").slice(0, 16);

/** A path a repository may name: project-relative, never absolute and never through `..`. */
const contained = (entry: string): boolean => !path.isAbsolute(entry) && !entry.split(/[\\/]/).includes("..");

/**
 * Read the project's `awui.yml`: its settings, its hash, or (a bad or oversized file)
 * the problem and no settings. A missing file is null. Nothing is cached here: the
 * file can change between two glances, and the hash is what trust is keyed on.
 */
export async function readProjectConfig(root: string): Promise<ProjectConfigFile | null> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(path.join(root, PROJECT_CONFIG_FILE));
  } catch {
    return null;
  }
  const hash = shortHash(bytes);
  if (bytes.length > MAX_CONFIG_BYTES) return { hash, config: {}, problem: `${PROJECT_CONFIG_FILE} is larger than ${MAX_CONFIG_BYTES / 1024} KB` };
  let raw: unknown;
  try {
    // The same alias cap user-config.ts uses: a settings file has no business expanding YAML tricks.
    raw = parseYaml(bytes.toString("utf8"), { maxAliasCount: 10 }) as unknown;
  } catch {
    return { hash, config: {}, problem: `${PROJECT_CONFIG_FILE} is not valid YAML` };
  }
  const parsed = projectConfigSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.join(".") || "a key";
    return { hash, config: {}, problem: `${PROJECT_CONFIG_FILE}: ${where} — ${issue?.message ?? "not allowed"}` };
  }
  const config = parsed.data;
  // An entry that leaves the project is refused here rather than half-applied later.
  const escaped = (config.shared ?? []).find((entry) => !contained(entry));
  if (escaped !== undefined) return { hash, config: {}, problem: `${PROJECT_CONFIG_FILE}: shared entries stay inside the project (${escaped})` };
  return { hash, config };
}

/**
 * Which versions of which projects' `awui.yml` a person has trusted, in awui's own
 * state folder. The map is keyed by the project's real path and holds the hash of
 * the file that was trusted: editing the file (or pulling a commit that does) makes
 * it untrusted again, which is the point.
 */
export class ProjectConfigTrust {
  private readonly trusted = new Map<string, string>();

  private constructor(private readonly file: string | null) {}

  static inMemory(): ProjectConfigTrust {
    return new ProjectConfigTrust(null);
  }

  static async open(file: string | null): Promise<ProjectConfigTrust> {
    const store = new ProjectConfigTrust(file);
    const raw = await readJson(file);
    if (!isObj(raw)) return store;
    for (const [root, hash] of Object.entries(raw)) if (typeof hash === "string" && hash !== "") store.trusted.set(root, hash);
    return store;
  }

  /** Whether this exact version of this project's file has been trusted. */
  isTrusted(root: string, hash: string): boolean {
    return this.trusted.get(root) === hash;
  }

  /** Trust one version of one project's file; the answer is what is stored. */
  trust(root: string, hash: string): Promise<void> {
    this.trusted.set(root, hash);
    return writeJson(this.file, Object.fromEntries(this.trusted));
  }
}

/**
 * What the worktree picker shows of a project's file: its hash, its settings, why it
 * was refused, and whether this version is trusted. No paths leave the server.
 */
export async function projectConfigStatus(root: string, trust: ProjectConfigTrust): Promise<ProjectConfigStatus | null> {
  const read = await readProjectConfig(root);
  if (!read) return null;
  return {
    file: PROJECT_CONFIG_FILE,
    hash: read.hash,
    trusted: trust.isTrusted(root, read.hash),
    config: { ...(read.config.base ? { base: read.config.base } : {}), ...(read.config.shared ? { shared: read.config.shared } : {}), ...(read.config.setup ? { setup: read.config.setup } : {}) },
    ...(read.problem ? { problem: read.problem } : {}),
  };
}
