// The review panel's attribution for the terminal clients: the shared rule
// (shared/review.ts) over the lines a chat's own edits wrote, checked against
// the files as they are on disk now through the same bounded route the web
// panel asks. The read is one request per set of edits; until it answers (or
// if it fails), the transcript's diffs alone still say which lines the agent
// wrote, and nothing flips on a guess.
import type { AttributionSnapshot } from "../shared/protocol.js";
import { attributeLines, groupMarks, type FileChanges, type LineOrigin, type OriginMarks } from "../shared/review.js";

export type { LineOrigin, OriginMarks };
import type { Server } from "./client.js";

/** A stable name for the edits a chat holds now: the read is asked for again only when it changes. */
export function editSignature(files: FileChanges[]): string {
  return files.map((file) => `${file.path}#${file.edits.length}#${file.edits[file.edits.length - 1]?.tool.id ?? ""}`).join("|");
}

export async function readMarks(server: Server, chatId: string, files: FileChanges[]): Promise<OriginMarks> {
  try {
    const snapshot = await server.call<AttributionSnapshot>(`/api/chats/${chatId}/attribution`);
    // A file whose read was truncated is left out of the comparison: its later lines are unknown.
    const present = new Map(snapshot.paths.filter((p) => !p.truncated).map((p) => [p.path, new Set(p.hashes)] as const));
    return groupMarks(files, attributeLines(files, present));
  } catch {
    return groupMarks(files, attributeLines(files, null));
  }
}
