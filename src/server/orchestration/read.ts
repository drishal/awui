// thread_read's answer: a page of a delegated child's chat items, as the parent's model reads it.
// The page counts from the newest item backwards (`before` skips, `limit` caps) and stops when the
// rendered text reaches its budget, so one read cannot flood a parent's context; each item's text
// goes through the same bound the reducer cuts tool output to (boundText), never a second cutter.
// Pure: the orchestrator hands in a live chat's items, or the ones the harness's own file holds.
import { boundText } from "../harness/agent-events.js";
import type { ChatItem } from "../../shared/protocol.js";

/** Items one read returns, and the most a caller may ask for. */
export const DEFAULT_READ_ITEMS = 40;
export const MAX_READ_ITEMS = 200;
/** What the model reads in one call: the newest items that fit, with the way back spelled out. */
export const MAX_READ_TEXT_CHARS = 24_000;

export interface ReadPage {
  /** The page, oldest first (reading order). */
  items: ChatItem[];
  /** The page as text, with a line saying how to read older items. */
  text: string;
  /** Older items are left out, or a long item was cut: there is more than this read shows. */
  truncated: boolean;
}

/** One item's text fields cut to the server's bound, its image references dropped. */
function boundedItem(item: ChatItem): { item: ChatItem; cut: boolean } {
  let cut = false;
  const bound = (text: string): string => {
    const bounded = boundText(text);
    cut = cut || bounded.truncated;
    return bounded.text;
  };
  switch (item.kind) {
    case "user": {
      // Pictures are references this parent has no way to open: the count says what is missing.
      const copy: ChatItem = { ...item, text: bound(item.text) };
      delete (copy as { images?: unknown }).images;
      return { item: copy, cut };
    }
    case "assistant":
      return { item: { ...item, text: bound(item.text) }, cut };
    case "tool": {
      const copy: ChatItem = { ...item, args: bound(item.args), output: bound(item.output) };
      delete (copy as { images?: unknown }).images;
      return { item: copy, cut };
    }
    case "notice":
      return { item: { ...item, text: bound(item.text), ...(item.detail !== undefined ? { detail: bound(item.detail) } : {}) }, cut };
    case "request":
      return { item, cut };
  }
}

/** One item as a block of the transcript text: who said it, or which call ran. */
function renderItem(item: ChatItem): string {
  switch (item.kind) {
    case "user": {
      const images = item.imageCount ? `\n[${item.imageCount} image${item.imageCount === 1 ? "" : "s"}, not shown]` : "";
      return `User: ${item.text}${images}`;
    }
    case "assistant": {
      const text = item.text.trim() === "" ? "(no text)" : item.text;
      const error = item.error ? `\n[its model call failed: ${item.error}]` : "";
      return `Assistant: ${text}${error}`;
    }
    case "tool": {
      const head = `Tool ${item.name}${item.summary ? ` — ${item.summary}` : ""}${item.status === "error" ? " (failed)" : ""}`;
      const output = item.output.trim();
      return output === "" ? head : `${head}\n${output.replace(/^/gm, "  ")}`;
    }
    case "notice":
      return `Notice (${item.level}): ${item.text}`;
    case "request":
      return `Question: ${item.request.title}${item.outcome ? ` — ${item.outcome}` : ""}`;
  }
}

/**
 * The newest page of `all` that a caller asked for. An item too large for what is left of the
 * budget ends the page (nothing older is shown), so the returned count is always the count to
 * skip next time: `before + items.length` reads the page before this one.
 */
export function readPage(all: ChatItem[], args: { before?: number; limit?: number }): ReadPage {
  const limit = Math.min(Math.max(args.limit ?? DEFAULT_READ_ITEMS, 1), MAX_READ_ITEMS);
  const skipped = Math.max(0, args.before ?? 0);
  const end = Math.max(0, all.length - skipped);
  const items: ChatItem[] = [];
  const blocks: string[] = [];
  let budget = MAX_READ_TEXT_CHARS;
  let cut = false;
  for (let i = end - 1; i >= 0 && items.length < limit; i--) {
    const bounded = boundedItem(all[i] as ChatItem);
    const block = renderItem(bounded.item);
    // The oldest items of a page give way to the budget; the newest are what a caller came for.
    if (block.length > budget && items.length > 0) break;
    const shown = block.length > budget ? `${block.slice(0, Math.max(0, budget - 20)).trimEnd()}\n[… cut to fit]` : block;
    cut = cut || bounded.cut || shown !== block;
    items.unshift(bounded.item);
    blocks.unshift(shown);
    budget -= shown.length + 2;
    if (budget <= 0) break;
  }
  const older = end - items.length;
  const head =
    items.length === 0
      ? "This chat has no items on that page."
      : `${items.length} item${items.length === 1 ? "" : "s"}${older > 0 ? `, ${older} older left out (read again with before=${skipped + items.length})` : ""}.`;
  return { items, text: [head, ...blocks].join("\n\n"), truncated: older > 0 || cut };
}
