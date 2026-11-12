// The review panel's attribution: the shared rule (shared/review.ts) over the lines a
// chat's own edits wrote, checked against the files as they are on disk now. The read is
// one bounded request per chat whose edits changed; until it answers, every line keeps
// what the transcript alone says, so nothing flips on a guess. Only the review panel
// asks: the transcript's diffs would need the whole chat re-indexed on every streaming
// event, which the conversation cannot afford.
import { useEffect, useMemo, useState } from "react";
import type { AttributionSnapshot } from "../shared/protocol.js";
import { api } from "./api.js";
import { attributeLines, type FileChanges, type LineOrigin } from "./review.js";

/** The agent's lines, by tool id and line index, and the counts a file's header shows. */
export interface OriginMarks {
  byTool: Map<string, Map<number, LineOrigin>>;
  /** Per path: how many of its marked lines the agent wrote, and how many have changed since. */
  byPath: Map<string, { agent: number; changed: number }>;
}

/** `toolId:index` keys, as shared/review.ts makes them, grouped for drawing: one lookup per edit and one count per file. */
export function groupMarks(files: FileChanges[], marks: ReadonlyMap<string, LineOrigin>): OriginMarks {
  const byTool = new Map<string, Map<number, LineOrigin>>();
  const byPath = new Map<string, { agent: number; changed: number }>();
  const pathOf = new Map<string, string>();
  for (const file of files) {
    const counts = byPath.get(file.path) ?? { agent: 0, changed: 0 };
    byPath.set(file.path, counts);
    for (const edit of file.edits) pathOf.set(edit.tool.id, file.path);
  }
  for (const [key, origin] of marks) {
    const at = key.lastIndexOf(":");
    if (at < 0) continue;
    const toolId = key.slice(0, at);
    const index = Number(key.slice(at + 1));
    if (!Number.isInteger(index)) continue;
    let lines = byTool.get(toolId);
    if (!lines) byTool.set(toolId, (lines = new Map()));
    lines.set(index, origin);
    const counts = byPath.get(pathOf.get(toolId) ?? "");
    if (counts) counts[origin] += 1;
  }
  return { byTool, byPath };
}

/** A stable name for the edits a chat holds now: the read is asked for again only when it changes. */
function editSignature(files: FileChanges[]): string {
  return files.map((file) => `${file.path}#${file.edits.length}#${file.edits[file.edits.length - 1]?.tool.id ?? ""}`).join("|");
}

/**
 * A chat's line origins, read once per set of edits. A file whose read was truncated is
 * left out of the comparison: its later lines are unknown, and a line marked changed on
 * a guess is worse than no mark.
 */
export function useAttribution(chatId: string, files: FileChanges[]): OriginMarks {
  const signature = useMemo(() => editSignature(files), [files]);
  const [snapshot, setSnapshot] = useState<AttributionSnapshot | null>(null);
  useEffect(() => {
    let live = true;
    setSnapshot(null);
    if (files.length === 0) return;
    api<AttributionSnapshot>(`/api/chats/${chatId}/attribution`)
      .then((body) => {
        if (live) setSnapshot(body);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // `files` is read through its signature: the array is rebuilt on every items change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, signature]);
  return useMemo(() => {
    const present = snapshot
      ? new Map(
          snapshot.paths
            .filter((path) => !path.truncated)
            .map((path) => [path.path, new Set(path.hashes)] as const),
        )
      : null;
    return groupMarks(files, attributeLines(files, present));
  }, [files, snapshot]);
}
