// Mesh file methods (P1.5, worker side): fs.stat / fs.list / fs.read /
// fs.write over the peer link. Every call resolves its path through the
// policy twice on purpose: once with the spec's resolveInRoots over the whole
// path, so a `..`, a missing root, or a final symlink whose referent leaves
// the roots is refused before anything is said about it, and once over the
// directory above, so the final component itself can be lstat'ed without
// following it — a peer names an entry, never a referent. Writes go to a
// fresh temp file beside the target and are fsynced and renamed over it, so
// a target never holds half a payload and a failed write leaves nothing
// behind. Every size the spec bounds is checked before a byte moves. Errors
// are the wire's own codes: denials for policy and path refusals,
// invalid_params for a bad shape or a lost race against expectMtimeMs,
// not_found for missing paths, limit for oversized payloads. Nothing here
// knows about the link: serve() owns the caps, the write rate, and the audit
// line (path and byte counts, never contents).
import { randomBytes } from "node:crypto";
import { promises as fs, type Dirent, type Stats } from "node:fs";
import path from "node:path";
import { expandRoot, resolveInRoots, type PeerPolicy } from "./policy.js";
import { MeshErrorCode, MeshRpcError } from "./rpc.js";

/**
 * One fs.read's biggest slice and one fs.write's biggest payload. Base64 grows a
 * payload by 4/3 and the whole reply must fit one 1 MiB wire line (rpc.ts), so
 * 512 KiB is the most that crosses in one call; larger files page through.
 */
export const MAX_RW_BYTES = 512 * 1024;
/** fs.read's default slice: the most one call carries. */
const DEFAULT_READ_BYTES = MAX_RW_BYTES;
/** fs.list's biggest answer, and its default: the spec's figures. */
const MAX_LIST_ENTRIES = 1000;
/** The most entries one fs.list scans before sorting; past it the listing says truncated. */
const MAX_SCAN_ENTRIES = 10_000;
const DEFAULT_LIST_ENTRIES = 500;

/** Test seam only; production callers pass nothing. */
export interface FsOpts {
  /**
   * Called with the temp file and the target just before the rename, after
   * the payload is on disk and fsynced. A test throws here to prove the
   * failure path leaves no temp file behind and never touches the target.
   */
  failBeforeRename?: (tmp: string, target: string) => void;
}

export interface FsStatParams {
  path: string;
}
export interface FsStatResult {
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtimeMs: number;
  /** The raw st_mode as Node reports it (e.g. 0o100644), so a caller can see setuid bits and all. */
  mode: number;
}
export interface FsListParams {
  path: string;
  /** 1..1000, default 500. */
  limit?: number;
}
export interface FsListEntry {
  name: string;
  type: FsStatResult["type"];
  size: number;
}
export interface FsListResult {
  entries: FsListEntry[];
  truncated: boolean;
}
export interface FsReadParams {
  path: string;
  offset?: number;
  length?: number;
}
export interface FsReadResult {
  data: string;
  size: number;
  eof: boolean;
}
export interface FsWriteParams {
  path: string;
  /** Standard base64, decoded bounded to MAX_RW_BYTES. */
  data: string;
  mode: "create" | "overwrite";
  /** The mtime fs.stat reported when the caller last read the file; a mismatch is a conflict, never a clobber. */
  expectMtimeMs?: number;
}
export interface FsWriteResult {
  size: number;
  mtimeMs: number;
}

const denied = (message: string): MeshRpcError => new MeshRpcError(MeshErrorCode.denied, message, { code: "denied" });
const notFound = (message: string): MeshRpcError => new MeshRpcError(MeshErrorCode.not_found, message, { code: "not_found" });
const invalidParams = (message: string): MeshRpcError => new MeshRpcError(MeshErrorCode.invalid_params, message, { code: "invalid_params" });
const tooBig = (message: string): MeshRpcError => new MeshRpcError(MeshErrorCode.limit, message, { code: "limit" });

/**
 * A filesystem failure as the wire's own answer: a missing path is not_found,
 * ELOOP — which only O_NOFOLLOW produces — is a denial (the final component
 * became a symlink between the checks), and a permission problem is a denial
 * too, because the peer asked for something this machine will not hand over.
 * Everything else stays a generic internal error; its local detail never
 * crosses the link.
 */
function fsError(error: unknown, what: string): MeshRpcError {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return notFound(`no such ${what} inside the policy's roots`);
  if (code === "ELOOP") return denied(`the ${what} is a symlink, and no fs method follows the final component`);
  if (code === "EACCES" || code === "EPERM") return denied(`the ${what} refuses this operation on this machine`);
  return new MeshRpcError(MeshErrorCode.internal_error, `the ${what} could not be reached on this machine`, { code: "internal_error" });
}

/**
 * One fs.* path as an entry the caller may lstat: the directory above is
 * realpathed and must itself sit in a root, while the final component is kept
 * exactly as named so no method ever follows it. The spec's resolveInRoots
 * runs on the whole path first, so a final symlink whose referent leaves the
 * roots is refused there, whatever it points at. The one case where the
 * directory above cannot sit inside a root is a path that IS a root (its
 * parent is above the boundary by definition); that is the only fall-back,
 * and it lands on the root itself, which the policy grants.
 */
async function resolveEntry(policy: PeerPolicy, requestedPath: string, home: string): Promise<string> {
  const full = await resolveInRoots(policy, requestedPath, home);
  if (!full.ok) throw denied(`the requested path is refused: ${full.reason}`);
  const absolute = path.resolve(expandRoot(requestedPath, home));
  const parent = path.dirname(absolute);
  if (parent !== absolute) {
    const above = await resolveInRoots(policy, parent, home);
    // A directory outside the roots can only be named here through a final
    // symlink whose referent happens to sit inside one; the entry the peer
    // named is not the entry the policy granted, so refuse.
    if (above.ok) return path.join(above.real, path.basename(absolute));
  }
  if (full.real === full.root) return full.real;
  throw denied("the directory holding the requested path is outside the policy's roots");
}

function entryType(st: Stats): FsStatResult["type"] {
  if (st.isFile()) return "file";
  if (st.isDirectory()) return "dir";
  if (st.isSymbolicLink()) return "symlink";
  return "other";
}

function direntType(dirent: Dirent): FsStatResult["type"] {
  if (dirent.isFile()) return "file";
  if (dirent.isDirectory()) return "dir";
  if (dirent.isSymbolicLink()) return "symlink";
  return "other";
}

/** lstat with a missing path as the wire's not_found. */
async function lstatOrNotFound(entry: string): Promise<Stats> {
  try {
    return await fs.lstat(entry);
  } catch (error) {
    throw fsError(error, "path");
  }
}

/** fs.stat {path} → {type, size, mtimeMs, mode}: lstat, so the final component is described, never followed. */
export async function fsStat(policy: PeerPolicy, params: FsStatParams, home: string, _opts?: FsOpts): Promise<FsStatResult> {
  const entry = await resolveEntry(policy, params.path, home);
  const st = await lstatOrNotFound(entry);
  return { type: entryType(st), size: st.size, mtimeMs: st.mtimeMs, mode: st.mode };
}

/**
 * fs.list {path, limit?}: one directory's entries, dotfiles included, sorted
 * by name, never recursing and never following an entry's own link. Sizes
 * cost one lstat each, bounded by the entry cap, so a listing stays cheap
 * however large the directory is.
 */
export async function fsList(policy: PeerPolicy, params: FsListParams, home: string, _opts?: FsOpts): Promise<FsListResult> {
  if (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > MAX_LIST_ENTRIES)) {
    throw invalidParams(`fs.list's limit must be an integer from 1 to ${MAX_LIST_ENTRIES}`);
  }
  const entry = await resolveEntry(policy, params.path, home);
  const st = await lstatOrNotFound(entry);
  if (!st.isDirectory()) {
    throw denied(`fs.list lists directories; this path is a ${entryType(st)}, and no fs method follows the final component`);
  }
  const limit = params.limit ?? DEFAULT_LIST_ENTRIES;
  // Read through an iterator with a hard ceiling, so a huge directory is never one allocation.
  const dirents: import("node:fs").Dirent[] = [];
  const handle = await fs.opendir(entry);
  try {
    for await (const dirent of handle) {
      dirents.push(dirent);
      if (dirents.length >= MAX_SCAN_ENTRIES) break;
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const truncated = dirents.length > limit || dirents.length >= MAX_SCAN_ENTRIES;
  const entries: FsListEntry[] = [];
  for (const dirent of dirents.slice(0, limit)) {
    // A racing delete leaves a name readdir saw but lstat cannot reach; the
    // listing is a snapshot, so the entry stays with the type readdir reported.
    let size = 0;
    try {
      size = (await fs.lstat(path.join(entry, dirent.name))).size;
    } catch {
      // gone between readdir and lstat: keep the name, size 0
    }
    entries.push({ name: dirent.name, type: direntType(dirent), size });
  }
  return { entries, truncated };
}

/**
 * fs.read {path, offset?, length?}: one slice of one regular file, base64 on
 * the wire. The final component is checked three ways — lstat before the
 * open, O_NOFOLLOW on the open where the platform has it, and the opened
 * file's fstat against the lstat's dev/ino — so neither a standing symlink
 * nor a swap between the checks can turn a read into following one.
 */
export async function fsRead(policy: PeerPolicy, params: FsReadParams, home: string, _opts?: FsOpts): Promise<FsReadResult> {
  const length = params.length ?? DEFAULT_READ_BYTES;
  if (length > MAX_RW_BYTES) throw tooBig(`one fs.read is bounded to ${MAX_RW_BYTES} bytes; page through the file instead`);
  const offset = params.offset ?? 0;
  const entry = await resolveEntry(policy, params.path, home);
  const st = await lstatOrNotFound(entry);
  if (st.isSymbolicLink()) throw denied("fs.read never follows the final symlink");
  if (!st.isFile()) throw denied(`fs.read reads regular files; this path is a ${entryType(st)}`);
  // Windows has no O_NOFOLLOW; there the lstat above already refused the link.
  const nofollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(entry, fs.constants.O_RDONLY | nofollow);
  } catch (error) {
    throw fsError(error, "path");
  }
  try {
    const open = await handle.stat();
    if (!open.isFile()) throw denied(`fs.read reads regular files; the path opened as a ${entryType(open)}`);
    if (open.dev !== st.dev || open.ino !== st.ino) throw denied("the file was replaced while it was being opened; read it again");
    if (offset >= open.size) return { data: "", size: open.size, eof: true };
    const want = Math.min(length, open.size - offset);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await handle.read(buf, 0, want, offset);
    return { data: buf.subarray(0, bytesRead).toString("base64"), size: open.size, eof: offset + bytesRead >= open.size };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * fs.write {path, data, mode, expectMtimeMs?}: one whole file, written to a
 * fresh temp file beside the target (O_EXCL, 0600, then chmod'd to the
 * original's mode or 0644), fsynced, and renamed over it. The final component
 * is never a symlink (create refuses to shadow one, overwrite refuses to
 * follow or replace one), and expectMtimeMs turns a lost race into "changed
 * since read" rather than a clobber. A failure anywhere after the temp file
 * appears unlinks it, so nothing is left behind.
 */
export async function fsWrite(policy: PeerPolicy, params: FsWriteParams, home: string, opts: FsOpts = {}): Promise<FsWriteResult> {
  const decoded = Buffer.from(params.data, "base64");
  if (decoded.length > MAX_RW_BYTES) throw tooBig(`one fs.write is bounded to ${MAX_RW_BYTES} bytes; split the file`);
  if (decoded.length > policy.maxFileBytes) throw tooBig(`this peer's policy allows files up to ${policy.maxFileBytes} bytes`);
  const entry = await resolveEntry(policy, params.path, home);
  const dir = path.dirname(entry);
  let dirStat: Stats;
  try {
    dirStat = await fs.stat(dir);
  } catch {
    throw notFound("the directory holding the file does not exist inside the policy's roots");
  }
  if (!dirStat.isDirectory()) throw notFound("the path's parent is not a directory");
  let st: Stats | null = null;
  try {
    st = await fs.lstat(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fsError(error, "path");
  }
  let mode = 0o644;
  if (st === null) {
    // The caller read a file that is gone now: the mtime it expects is nobody's,
    // so a stated expectation is a conflict before the mode has anything to say.
    if (params.expectMtimeMs !== undefined) throw invalidParams("changed since read");
    if (params.mode === "overwrite") throw notFound("no such file to overwrite");
  } else {
    if (params.mode === "create") throw denied('the file already exists; fs.write with mode "create" never replaces it');
    if (st.isSymbolicLink()) throw denied("fs.write never follows or replaces the final symlink");
    if (!st.isFile()) throw denied(`fs.write overwrites regular files; this path is a ${entryType(st)}`);
    if (params.expectMtimeMs !== undefined && params.expectMtimeMs !== st.mtimeMs) throw invalidParams("changed since read");
    // Permission bits only: a peer that controls the content never inherits setuid/setgid/sticky.
    mode = st.mode & 0o777;
  }
  const temp = path.join(dir, `.${path.basename(entry)}.awui-${randomBytes(6).toString("hex")}.tmp`);
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(temp, "wx", 0o600);
  } catch (error) {
    throw fsError(error, "temp file");
  }
  try {
    await handle.writeFile(decoded);
    await handle.sync();
    await handle.chmod(mode);
    // rename preserves the inode's times, so the answer is what the leader's
    // next expectMtimeMs will be checked against.
    const written = await handle.stat();
    opts.failBeforeRename?.(temp, entry);
    // The parent is re-checked right before the rename: a directory swapped for a
    // symlink since it was resolved would carry the write outside the roots.
    const again = await fs.stat(dir);
    if (!again.isDirectory() || again.dev !== dirStat.dev || again.ino !== dirStat.ino) {
      throw denied("the parent directory changed while the file was being written");
    }
    await fs.rename(temp, entry);
    return { size: written.size, mtimeMs: written.mtimeMs };
  } catch (error) {
    // Cleanup never masks the failure and never throws a second one.
    await fs.unlink(temp).catch(() => undefined);
    throw error instanceof MeshRpcError ? error : fsError(error, "rename");
  } finally {
    await handle.close().catch(() => undefined);
  }
}
