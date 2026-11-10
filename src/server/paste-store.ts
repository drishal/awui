// Pasted composer blobs parked as files under /tmp so a huge paste does not
// pin the prompt field. One directory per chat; ids are random. Nothing here
// names a user path to the browser beyond the file the server itself issued.
import { randomBytes } from "node:crypto";
import { mkdir, readFile, realpath, readdir, stat, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_PASTE_BYTES, type PasteAttachment } from "../shared/protocol.js";
import { ChatError } from "./chats/chat.js";

const ROOT = path.join(tmpdir(), "awui-pastes");
const ID = /^[A-Za-z0-9_-]{8,40}$/;
/** Agents read these paths on later turns, so keep them for a bounded week. */
const PASTE_TTL_MS = 7 * 24 * 60 * 60_000;

/** Store one pasted blob for a chat, returning its attachment handle. */
export async function storePaste(chatId: string, text: string): Promise<PasteAttachment> {
  if (!/^([0-9a-f-]{36})$/.test(chatId)) throw new ChatError(400, "bad_chat", "Unknown chat");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > MAX_PASTE_BYTES) throw new ChatError(413, "paste_too_big", "That paste is larger than the 1 MiB file limit");
  const dir = path.join(ROOT, chatId);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = randomBytes(9).toString("base64url");
  const file = path.join(dir, `${id}.txt`);
  await writeFile(file, text, { mode: 0o600 });
  return { id, path: file, bytes, lines: text.split("\n").length };
}

/** Resolve a client-supplied paste id back to its real file, confined to the chat's paste dir. */
export async function resolvePaste(chatId: string, id: string): Promise<PasteAttachment> {
  if (!ID.test(id)) throw new ChatError(400, "bad_paste", "Unknown attachment");
  const dir = path.join(ROOT, chatId);
  const file = path.join(dir, `${id}.txt`);
  const real = await realpath(file).catch(() => null);
  if (!real || !real.startsWith(dir + path.sep)) throw new ChatError(404, "paste_gone", "That attachment is no longer on disk");
  const info = await stat(real).catch(() => null);
  if (info && !info.isFile()) throw new ChatError(404, "paste_gone", "That attachment is no longer on disk");
  if (info && info.mtimeMs + PASTE_TTL_MS < Date.now()) {
    await unlink(real).catch(() => undefined);
    throw new ChatError(410, "paste_expired", "That paste expired after seven days. Attach it again so the agent can read it.");
  }
  const text = await readFile(real, "utf8");
  return { id, path: real, bytes: Buffer.byteLength(text, "utf8"), lines: text.split("\n").length };
}

/** Drop an unsent attachment, never a project file or a path sent to a harness. */
export async function deletePaste(chatId: string, id: string) {
  if (!/^([0-9a-f-]{36})$/.test(chatId)) throw new ChatError(400, "bad_chat", "Unknown chat");
  if (!ID.test(id)) throw new ChatError(400, "bad_paste", "Unknown attachment");
  const file = path.join(ROOT, chatId, `${id}.txt`);
  const real = await realpath(file).catch(() => null);
  if (!real || !real.startsWith(path.join(ROOT, chatId) + path.sep)) throw new ChatError(404, "paste_gone", "That paste is no longer here");
  await unlink(real);
  await rmdir(path.dirname(real)).catch(() => undefined);
}

/** Remove stale plaintext on a small daily sweep, preserving active-week attachments. */
export async function cleanupPastes(): Promise<void> {
  const dirs = await readdir(ROOT, { withFileTypes: true }).catch(() => []);
  let done = 0;
  for (const dir of dirs) {
    if (done >= 200) break;
    if (!dir.isDirectory() || !/^[0-9a-f-]{36}$/.test(dir.name)) continue;
    for (const file of await readdir(path.join(ROOT, dir.name)).catch(() => [])) {
      if (done >= 200) break;
      if (!ID.test(file.replace(/\.txt$/, "")) || !file.endsWith(".txt")) continue;
      const target = path.join(ROOT, dir.name, file);
      const info = await stat(target).catch(() => null);
      if (!info?.isFile() || info.mtimeMs + PASTE_TTL_MS >= Date.now()) continue;
      await unlink(target).catch(() => undefined);
      done++;
    }
    await rmdir(path.join(ROOT, dir.name)).catch(() => undefined);
  }
}
