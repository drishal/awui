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
import { groupMarks, type OriginMarks } from "../shared/review.js";

/** The agent's lines, grouped for drawing: moved to shared/review.ts, which the terminal clients run too. */
export { groupMarks, type OriginMarks };

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
