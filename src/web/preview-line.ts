// The one line a session's card shows of its preview: pure, so the web's cards and atui's board word it alike.
import type { SessionPreview } from "../shared/protocol.js";
import { plainTitle } from "./plain-title.js";

/** The one line a card shows of it: the last answer, else the last prompt, collapsed. */
export function previewLine(preview: SessionPreview | null): string | null {
  const text = preview?.answer ?? preview?.prompt ?? null;
  if (!text) return null;
  // Each line loses its Markdown markers first (a card is plain words, as a tab's title is); the lines then join with a dot, so a paragraph and the bullet under it do not run into one sentence.
  const line = text.split("\n").map((l) => plainTitle(l.trim()).replace(/\s+/g, " ").trim()).filter(Boolean).join(" · ");
  return line.length > 220 ? `${line.slice(0, 219).trimEnd()}…` : line;
}
