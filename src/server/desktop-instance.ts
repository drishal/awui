// Coordinate the CLI with the native desktop before spawning an AppImage. A
// short-held launch mutex and the native winner's PID identity hold across child
// publication, eliminating the cold-start race in detached launchers. Repeated
// invocations queue a focus request and signal that one owner. Stale records are
// safe because a Linux PID must also carry its original /proc start-time.
import { promises as fs } from "node:fs";
import path from "node:path";
import { ChatError } from "./chats/chat.js";
import { randomUUID } from "node:crypto";

export interface Owner {
  pid: number;
  started: string | null;
}

export function desktopDirectory(stateDir: string): string {
  return path.join(stateDir, "desktop");
}
export function ownerPath(directory: string): string {
  return path.join(directory, "owner.json");
}
const mutexPath = (directory: string): string => path.join(directory, "launch.lock");
const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function processStartTime(stat: string): string | null {
  return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19] ?? null;
}

export async function processIdentity(pid: number, platform: NodeJS.Platform = process.platform): Promise<string | null> {
  if (platform !== "linux") return null;
  return processStartTime(await fs.readFile(`/proc/${pid}/stat`, "utf8"));
}

export async function liveOwner(directory: string): Promise<Owner | null> {
  let owner: Owner;
  try {
    owner = JSON.parse(await fs.readFile(ownerPath(directory), "utf8")) as Owner;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null;
    process.kill(owner.pid, 0);
  } catch {
    return null;
  }
  try {
    if (process.platform === "linux" && owner.started !== await processIdentity(owner.pid)) return null;
  } catch {
    return null;
  }
  return owner;
}

/** Atomic mkdir remains authoritative regardless of namespace/process wrappers. */
async function withLaunchLock(directory: string, action: () => Promise<void>): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = mutexPath(directory);
  for (let attempt = 0; attempt < 400; attempt++) {
    const token = randomUUID();
    try {
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, "id"), token, { mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let date: number | null = null;
      try { date = (await fs.stat(lock)).mtimeMs; } catch { continue; }
      // A crashed CLI leaves a token, not an OS-level file lock. Recover after its
      // real startup deadline; don't detach-and-hope while another CLI is locked.
      if (Date.now() - date > 25_000) await fs.rm(lock, { recursive: true, force: true });
      else await pause(50);
      continue;
    }
    try {
      await action();
    } finally {
      try {
        if (await fs.readFile(path.join(lock, "id"), "utf8") === token) await fs.rm(lock, { recursive: true, force: true });
      } catch {
        // Lock ownership elapsed and was replaced: no cleanup of that other lock.
      }
    }
    return;
  }
  throw new ChatError(409, "desktop_starting", "the desktop is still starting; retry after its window appears");
}

/** Queue only a focus command or bounded supported awui:// target, never a CLI command. */
export async function queueActivation(directory: string, target: string | null): Promise<void> {
  const queue = path.join(directory, "activation-requests");
  await fs.mkdir(queue, { recursive: true, mode: 0o700 });
  const name = `${process.pid}-${randomUUID()}`;
  await fs.writeFile(path.join(queue, `${name}.json`), JSON.stringify({ link: target }), { mode: 0o600, flag: "wx" });
}

export async function activateOwner(owner: Owner): Promise<void> {
  process.kill(owner.pid, "SIGUSR1");
}

/**
 * First launch: keep the profile mutex until the native winner owner exists.
 * A repeat never reaches the spawn code, so an AppImage wrapper cannot create
 * a second master even when its Chromium instance handoff is unavailable.
 */
export async function launchExclusive(stateDir: string, args: string[], start: () => Promise<number | undefined>): Promise<"activated" | "started"> {
  const directory = desktopDirectory(stateDir);
  let result: "activated" | "started" = "started";
  await withLaunchLock(directory, async () => {
    const owner = await liveOwner(directory);
    if (owner) {
      await queueActivation(directory, args.find((arg) => arg.startsWith("awui://")) ?? null);
      await activateOwner(owner);
      result = "activated";
      return;
    }
    const child = await start();
    // Owner publishes before app.whenReady, so a spawn failure gets the same
    // attention as a missing signal, not an unbounded wait or a fallback launch.
    const deadline = Date.now() + 20_000;
    do {
      if (await liveOwner(directory)) return;
      if (child !== undefined) {
        try { process.kill(child, 0); }
        catch { throw new ChatError(500, "desktop_failed", "the desktop exited before it created its window; check its startup error"); }
      }
      await pause(50);
    } while (Date.now() < deadline);
    throw new ChatError(500, "desktop_start_timeout", "the desktop did not register its launch; the previous app is not duplicated");
  });
  return result;
}
