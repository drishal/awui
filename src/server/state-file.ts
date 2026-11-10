// Small JSON files in the state folder (pins, push subscriptions, checkpoint
// lists): read leniently, written whole through a temp file and a rename, one
// write at a time per file.
import { promises as fs } from "node:fs";
import path from "node:path";

export async function readJson(file: string | null): Promise<unknown> {
  if (!file) return null;
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  } catch {
    return null;
  }
}

const queues = new Map<string, Promise<void>>();

/** One serialized write: temp file, then a rename over the target. */
async function writeOnce(file: string, text: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, text, { mode: 0o600 });
  await fs.rename(tmp, file);
}

/** Resolves once this write (and every earlier one to the same file) is on disk; failures are swallowed. */
function enqueue(file: string, text: string, rethrow: boolean): Promise<void> {
  const next = (queues.get(file) ?? Promise.resolve())
    .then(() => writeOnce(file, text))
    .catch((err) => {
      if (rethrow) throw err;
      return undefined;
    });
  queues.set(file, rethrow ? next.catch(() => undefined) : next);
  return next;
}

/** Resolves once this write (and every earlier one to the same file) is on disk; failures are swallowed. */
export function writeJson(file: string | null, data: unknown): Promise<void> {
  if (!file) return Promise.resolve();
  return enqueue(file, JSON.stringify(data), false);
}

/** Like writeJson, but a failed write rejects: the caller can tell the record never landed. */
export function writeJsonChecked(file: string | null, data: unknown): Promise<void> {
  if (!file) return Promise.resolve();
  return enqueue(file, JSON.stringify(data), true);
}

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
