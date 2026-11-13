// The Settings dialog's custom icons for config.yml's ACP agents. A harness mark is
// a 64x64 PNG uploaded through the Settings dialog; it is stored server-side under
// the state folder as <id>.png and served to every signed-in client at
// /api/harness-marks/<id>.png. An upload is validated by its own bytes (the PNG
// signature and IHDR), never by the file name or content type a browser claims.
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ACP_AGENT_ID } from "../shared/protocol.js";
import { ChatError } from "./chats/chat.js";

/** The canvas the dialog draws and uploads; the server has no resizer, so it checks the dimension instead. */
export const MARK_SIZE = 64;
/** Largest upload kept: 64x64 PNG of the dialog's own output, so far under a canvas's worth. */
export const MARK_MAX_BYTES = 64 * 1024;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** The store's folder under the state dir: mode 0700, its files 0600, like the rest of it. */
export function marksDirOf(stateDir: string): string {
  return path.join(stateDir, "harness-marks");
}

/**
 * The PNG's width and height from its IHDR: the first chunk after the signature.
 * Null for anything else — a truncated file, an SVG renamed .png, another format.
 */
export function pngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function checkMark(id: string, bytes: Buffer): void {
  if (!ACP_AGENT_ID.test(id)) throw new ChatError(400, "bad_mark_id", "A harness id is a slug: lowercase letters, digits, or '-', at most 32 characters");
  if (bytes.length === 0 || bytes.length > MARK_MAX_BYTES) throw new ChatError(400, "bad_mark", `An icon is at most ${MARK_MAX_BYTES / 1024} KiB`);
  const dims = pngDimensions(bytes);
  if (!dims) throw new ChatError(400, "bad_mark", "An icon must be a PNG");
  if (dims.width !== MARK_SIZE || dims.height !== MARK_SIZE) {
    throw new ChatError(400, "bad_mark", `An icon must be ${MARK_SIZE}x${MARK_SIZE}, not ${dims.width}x${dims.height}`);
  }
}

/** An icon's content hash so a replacement at one path refreshes already loaded clients. */
export function markRevision(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

/** The URL the browser fetches; bootstrap adds this icon's content-hash cache key. */
export function markUrl(id: string): string {
  return `/api/harness-marks/${id}.png`;
}

/** One app's store: only its own state folder; the route resolves the saved ACP whitelist per call. */
export class HarnessMarkStore {
  private readonly dir: string | null;

  constructor(stateDir: string | null | undefined) {
    this.dir = stateDir ? marksDirOf(stateDir) : null;
  }

  /**
   * The stored bytes when they are a validated 64x64 PNG, else null. A missing state
   * folder, a slug that is not one, or a file that is not what an upload must be
   * (truncated, another format) is no icon — nothing is served from here unchecked.
   */
  read(id: string): Buffer | null {
    if (this.dir === null || !ACP_AGENT_ID.test(id)) return null;
    try {
      const bytes = readFileSync(this.file(id));
      const dims = pngDimensions(bytes);
      return bytes.length <= MARK_MAX_BYTES && dims?.width === MARK_SIZE && dims.height === MARK_SIZE ? bytes : null;
    } catch {
      return null;
    }
  }

  /**
   * Validate and save one upload. The caller has already matched the id against
   * config.yml's saved ACP agents (and refused built-ins); the bytes are checked here
   * by their own signature and IHDR, never by what the request named them.
   */
  save(id: string, bytes: Buffer): { icon: string } {
    checkMark(id, bytes);
    if (this.dir === null) throw new ChatError(404, "no_state_dir", "No state folder is wired, so an icon has nowhere to be stored");
    const target = this.file(id);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      // Atomic replacement: a failed upload never leaves a valid icon half-written.
      writeFileSync(tmp, bytes, { mode: 0o600 });
      renameSync(tmp, target);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* no partial output */ }
      throw new ChatError(500, "mark_store_failed", error instanceof Error ? error.message : "Could not store the icon");
    }
    return { icon: markUrl(id) };
  }

  /** Remove one stored icon; a missing one is already the state a removal asks for. */
  remove(id: string): void {
    if (this.dir === null || !ACP_AGENT_ID.test(id)) return;
    try {
      unlinkSync(this.file(id));
    } catch {
      // Nothing stored, or already gone: removal is idempotent.
    }
  }

  private file(id: string): string {
    return path.join(this.dir as string, `${id}.png`);
  }
}
