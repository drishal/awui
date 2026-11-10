// Native winner registration used by awui's launching CLI. A PID and Linux
// start-time stop a dead recipe from rebounding to a different process. Most
// repeat invocations never spawn Electron: they see this record and signal it.
// Electron still keeps its native fallback for direct application launches.
import { promises as fs } from "node:fs";
import path from "node:path";

export interface Owner {
  pid: number;
  started: string | null;
}

export function ownerPath(directory: string): string { return path.join(directory, "owner.json"); }
export function processStartTime(stat: string): string | null {
  // Skip the parenthesized command to protect fields when it contains spaces / ')'.
  return stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19] ?? null;
}
async function processIdentity(pid: number): Promise<string | null> {
  if (process.platform !== "linux") return null;
  return processStartTime(await fs.readFile(`/proc/${pid}/stat`, "utf8"));
}

async function runningOwner(directory: string): Promise<Owner | null> {
  try {
    const owner = JSON.parse(await fs.readFile(ownerPath(directory), "utf8")) as Owner;
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return null;
    process.kill(owner.pid, 0);
    if (process.platform === "linux" && owner.started !== await processIdentity(owner.pid)) return null;
    return owner;
  } catch {
    return null;
  }
}

/** Register/process owner, matching the launcher's Linux PID validation above. */
export async function publishDesktopOwner(directory: string): Promise<() => Promise<void>> {
  const owner: Owner = { pid: process.pid, started: await processIdentity(process.pid) };
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const existing = await runningOwner(directory);
  if (existing && existing.pid !== process.pid) throw new Error("another awui desktop is already active for this profile");
  const temporary = `${ownerPath(directory)}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(owner), { mode: 0o600 });
  await fs.rename(temporary, ownerPath(directory));
  // This is a live ownership record. Only its matching publisher may remove it,
  // allowing the launch mutex's startup wait and normal quit recovery to finish.
  let closed = false;
  return async () => {
    if (closed) return;
    closed = true;
    try {
      const owner = JSON.parse(await fs.readFile(ownerPath(directory), "utf8")) as Owner;
      if (owner.pid === process.pid && owner.started === await processIdentity(process.pid)) await fs.unlink(ownerPath(directory));
    } catch {
      // Already closed/replaced owner records remain for stale-owner recovery.
    }
  };
}

/** Read bounded queued activation targets without giving the CLI arbitrary exec. */
export async function drainActivationRequests(directory: string, open: (target: string | null) => void): Promise<void> {
  const queue = path.join(directory, "activation-requests");
  for (const file of await fs.readdir(queue).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    const member = path.join(queue, file);
    let target: string | null = null;
    try {
      const value = JSON.parse(await fs.readFile(member, "utf8")) as unknown;
      if (typeof value === "object" && value !== null && "link" in value && typeof value.link === "string") target = value.link;
    } catch {
      // Badly written local input cannot navigate, just focus this window.
    }
    await fs.unlink(member).catch(() => undefined);
    open(target);
  }
}
