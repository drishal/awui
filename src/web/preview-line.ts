// The one line a session's card shows of its preview: pure, so the web's cards and atui's board word it alike.
import type { SessionPreview } from "../shared/protocol.js";

/** The one line a card shows of it: the last answer, else the last prompt, collapsed. */
export function previewLine(preview: SessionPreview | null): string | null {
  const text = preview?.answer ?? preview?.prompt ?? null;
  if (!text) return null;
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > 220 ? `${line.slice(0, 219).trimEnd()}…` : line;
}
