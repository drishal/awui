// The desktop app a compiled binary can carry. `bun run scripts/build-binary.ts
// --with-desktop` appends the packaged app to the executable and records where
// it sits:
//
//   [binary][payload bytes][length u64 LE][AWUIDESK01]
//
// Trailing bytes after an ELF or Mach-O image are ignored by the loader — the
// same trick an AppImage plays with its squashfs — so the binary runs untouched.
// Reading the payload back is one seek and a streamed copy into the state
// folder: it never enters memory whole, and a later run finds the extracted
// copy already there.
import { createReadStream, createWriteStream, promises as fsp } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";

/** The last ten bytes of a binary that carries the app. */
export const DESKTOP_MAGIC = "AWUIDESK01";
/** length (u64) + magic. */
const FOOTER = 8 + DESKTOP_MAGIC.length;

export interface DesktopPayload {
  /** Where the payload starts in the executable. */
  offset: number;
  length: number;
}

/** Where the payload sits inside this executable, or null when it carries none. */
export async function embeddedDesktopPayload(execPath: string): Promise<DesktopPayload | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await fsp.open(execPath, "r");
    const { size } = await handle.stat();
    if (size < FOOTER) return null;
    const footer = Buffer.alloc(FOOTER);
    await handle.read(footer, 0, FOOTER, size - FOOTER);
    if (footer.subarray(8).toString("utf8") !== DESKTOP_MAGIC) return null;
    const length = Number(footer.readBigUInt64LE(0));
    const offset = size - FOOTER - length;
    if (length <= 0 || offset < 0) return null;
    return { offset, length };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}

/** Copy the payload out of the executable to `target`, executable, in one rename. */
export async function extractDesktopPayload(execPath: string, payload: DesktopPayload, target: string): Promise<void> {
  await fsp.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  await fsp.rm(tmp, { force: true });
  const source = createReadStream(execPath, { start: payload.offset, end: payload.offset + payload.length - 1 });
  await pipeline(source, createWriteStream(tmp, { mode: 0o700 }));
  await fsp.chmod(tmp, 0o755);
  await fsp.rename(tmp, target);
}

/** The name the extracted app is written under. */
export function bundledDesktopName(platform: string = process.platform): string {
  return platform === "win32" ? "awui-desktop.exe" : "awui-desktop";
}

/**
 * The desktop app this binary carries, extracted into the state folder once per
 * version; null when it carries none (a source run, or a build without it).
 */
export async function bundledDesktop(execPath: string, stateDir: string, version: string): Promise<string | null> {
  const payload = await embeddedDesktopPayload(execPath);
  if (!payload) return null;
  const target = path.join(stateDir, "desktop", version, bundledDesktopName());
  const there = await fsp.stat(target).catch(() => null);
  if (there?.size === payload.length) return target;
  await extractDesktopPayload(execPath, payload, target);
  return target;
}
