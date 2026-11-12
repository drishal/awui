// A delegated child's chip in its chat header: "Delegated by <the parent's title>", which opens the
// chat that started it. It wears the same badge shape as the harness beside it, so a child reads as
// an ordinary chat with a provenance, not as a special screen; a parent's title is cut rather than
// allowed to push the status word off the line.
import type { ChatLineage } from "../../shared/protocol.js";
import { IconAgents } from "../icons.js";

export function LineageChip({ lineage, onOpen }: { lineage: ChatLineage; onOpen: (chatId: string) => void }) {
  const title = lineage.parentTitle ?? "another chat";
  const depth = lineage.depth > 1 ? `, ${lineage.depth} levels below the chat you started` : "";
  return (
    <button type="button" className="badge badge-lineage" title={`Open the chat that delegated this one${depth}`} onClick={() => onOpen(lineage.parentChatId)}>
      <IconAgents size={11} />
      <span className="badge-lineage-title">Delegated by {title}</span>
    </button>
  );
}
