// Attribution's server half: the lines a chat's own edits wrote are the transcript's
// business (shared/review.ts), but whether those lines are still in the file is the
// working tree's. This reads each edited file as it is now — the same confinement and
// 512 KB bound as the file viewer — and hands back the hashes of its lines, so a line
// the agent wrote that is no longer there can say so.
import type { Chat } from "./chats/chat.js";
import { viewFile } from "./file-view.js";
import { MAX_ATTRIBUTION_FILES, MAX_ATTRIBUTION_LINES, type AttributionSnapshot } from "../shared/protocol.js";
import { hashLine } from "../shared/review.js";

const EDITS = new Set(["edit", "write"]);

/** The paths a chat's edits touched, in the order they were first touched, bounded and project-relative. */
function editedPaths(chat: Chat): string[] {
  const base = chat.workspace.path.endsWith("/") ? chat.workspace.path : `${chat.workspace.path}/`;
  const paths: string[] = [];
  for (const item of chat.snapshot().items) {
    if (item.kind !== "tool" || !EDITS.has(item.category) || !item.diff) continue;
    const path = item.paths[0];
    if (!path) continue;
    const relative = path.startsWith(base) ? path.slice(base.length) : path;
    if (!relative.startsWith("/") && !paths.includes(relative)) paths.push(relative);
  }
  return paths;
}

/**
 * Each edited file's present lines as hashes, bounded by count and by lines: what the
 * gutter compares the agent's lines against. A file the project does not list (a
 * gitignored build output, one the agent never created here) is skipped rather than
 * read, and nothing about it flips.
 */
export async function attributionSnapshot(chat: Chat): Promise<AttributionSnapshot> {
  const paths = editedPaths(chat);
  const out: AttributionSnapshot["paths"] = [];
  let skipped = 0;
  for (const path of paths) {
    if (out.length >= MAX_ATTRIBUTION_FILES) {
      skipped += 1;
      continue;
    }
    const view = await viewFile(chat.workspace.path, path).catch(() => null);
    if (!view || view.text === null) {
      skipped += 1;
      continue;
    }
    // A file's last newline ends its last line; it does not start an empty one.
    const lines = view.text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    const kept = lines.slice(0, MAX_ATTRIBUTION_LINES);
    out.push({ path: view.path, hashes: kept.map(hashLine), truncated: view.truncated || kept.length < lines.length });
  }
  return { paths: out, skipped };
}
