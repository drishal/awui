// Workspace selection is confined to WORKSPACE_ROOTS using realpath and
// path.relative descendant checks, never string prefixes, so `..` and
// symlinks pointing outside a root are rejected.
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { BrowseResult, DirEntry, WorkspaceInfo } from "../shared/protocol.js";
import { ChatError } from "./chats/chat.js";
import { expandHome } from "./config.js";
import { direnvState, findEnvrc } from "./direnv.js";

const MAX_ENTRIES = 2000;
/** Opened workspaces remembered by id. The listing routes re-touch theirs on
 *  every refresh, so the cap only ever drops projects nobody is looking at. */
const MAX_OPENED = 512;

export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

export class Workspaces {
  private roots: string[] = [];
  private byId = new Map<string, WorkspaceInfo>();

  private constructor(private readonly home: string) {}

  static async create(configuredRoots: string[], home: string): Promise<{ workspaces: Workspaces; warnings: string[] }> {
    const ws = new Workspaces(home);
    const warnings: string[] = [];
    for (const root of configuredRoots) {
      try {
        const real = await fs.realpath(root);
        const stat = await fs.stat(real);
        if (!stat.isDirectory()) throw new Error("not a directory");
        if (!ws.roots.includes(real)) ws.roots.push(real);
      } catch (error) {
        warnings.push(`Ignoring workspace root ${root}: ${(error as Error).message}`);
      }
    }
    return { workspaces: ws, warnings };
  }

  get rootList(): string[] {
    return [...this.roots];
  }

  private allowed(real: string): boolean {
    return this.roots.some((root) => isWithin(root, real));
  }

  /** Resolve user input to a real directory inside a root, or throw 403/404. */
  async resolve(input: string): Promise<string> {
    if (input.includes("\0")) throw new ChatError(400, "bad_path", "Invalid path");
    const absolute = path.resolve(expandHome(input.trim(), this.home));
    let real: string;
    try {
      real = await fs.realpath(absolute);
    } catch {
      throw new ChatError(404, "missing_project", "That folder does not exist");
    }
    if (!this.allowed(real)) throw new ChatError(403, "outside_roots", "That folder is outside the allowed workspace roots");
    const stat = await fs.stat(real);
    if (!stat.isDirectory()) throw new ChatError(400, "not_directory", "That path is not a folder");
    return real;
  }

  async open(input: string): Promise<WorkspaceInfo> {
    const real = await this.resolve(input);
    const id = createHash("sha256").update(real).digest("base64url").slice(0, 22);
    return this.remember({ id, path: real, name: path.basename(real) || real });
  }

  /** Insert or refresh a workspace as most-recently-used, evicting past the cap. */
  private remember(info: WorkspaceInfo): WorkspaceInfo {
    // The direnv state rides along so the composer and the start screen can
    // offer to allow a blocked .envrc. Only the state is read (direnvState): evaluating the
    // .envrc here, for every folder the sidebar lists, once cost seconds per page load.
    if (findEnvrc(info.path)) info.direnv = direnvState(info.path);
    this.byId.delete(info.id);
    this.byId.set(info.id, info);
    if (this.byId.size > MAX_OPENED) {
      const oldest = this.byId.keys().next().value;
      if (oldest !== undefined) this.byId.delete(oldest);
    }
    return info;
  }

  /** Look up an opened workspace and revalidate it: a directory replaced by a link must not escape the approved roots. */
  async get(id: string): Promise<WorkspaceInfo> {
    const info = this.byId.get(id);
    if (!info) throw new ChatError(404, "unknown_workspace", "Open the workspace again");
    const real = await this.resolve(info.path);
    if (real !== info.path) throw new ChatError(403, "outside_roots", "The project folder changed; open its new location again");
    return this.remember(info);
  }

  async browse(input?: string): Promise<BrowseResult> {
    if (!input) {
      return {
        path: null,
        parent: null,
        entries: this.roots.map((root) => ({ name: root, path: root, hidden: false })),
      };
    }
    const real = await this.resolve(input);
    const dirents = await fs.readdir(real, { withFileTypes: true });
    const entries: DirEntry[] = [];
    for (const d of dirents) {
      if (entries.length >= MAX_ENTRIES) break;
      const full = path.join(real, d.name);
      if (d.isDirectory()) {
        entries.push({ name: d.name, path: full, hidden: d.name.startsWith(".") });
      } else if (d.isSymbolicLink()) {
        // Follow symlinks to directories only when they stay inside a root.
        try {
          const target = await fs.realpath(full);
          if ((await fs.stat(target)).isDirectory() && this.allowed(target)) {
            entries.push({ name: d.name, path: full, hidden: d.name.startsWith(".") });
          }
        } catch {
          // Dangling link: skip.
        }
      }
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const parentPath = path.dirname(real);
    const parent = parentPath !== real && this.allowed(parentPath) ? parentPath : null;
    return { path: real, parent, entries };
  }
}
