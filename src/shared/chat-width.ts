// config.yml's `chat_width` (the bootstrap's `ui.chatWidth`) as the terminal
// clients need it: atui counts terminal columns, the Tern client sets CSS
// caps. The browser has its own mapping in App.tsx (--chat-col: 960px,
// 1400px, 100%); comfortable here is what both terminal clients drew before
// the setting existed, so a server without it looks exactly as it did.
import type { ChatWidth } from "./protocol.js";

/** The three widths, in the order the clients' C-x key cycles them. */
export const CHAT_WIDTHS = ["comfortable", "wide", "full"] as const satisfies readonly ChatWidth[];

/** atui's reading column: the width the transcript has always stopped at. */
export const ATUI_COMFORTABLE = 104;
/** atui's wide column: roomier than the reading column, still a column on a very wide terminal. */
export const ATUI_WIDE = 160;

/** Tern's reading column in CSS pixels; the dock runs 12px wider, as the web composer runs 8px wider. */
const TERN_COMFORTABLE = 780;
const TERN_DOCK_EXTRA = 12;
/** The start screen's list of recent sessions, as the share of the page it has always taken (560 of 780px). */
const TERN_RECENT_SHARE = 560 / TERN_COMFORTABLE;
/** Tern's wide page: the web UI's wide column. */
const TERN_WIDE = 1400;

/** The setting's word, as a palette row and a notice say it. Null is comfortable. */
export function chatWidthLabel(width: ChatWidth | null): string {
  return width === "wide" ? "Wide" : width === "full" ? "Full" : "Comfortable";
}

/** The next width the C-x key cycles to: comfortable, wide, full, and round again. */
export function nextChatWidth(width: ChatWidth | null): ChatWidth {
  return width === "wide" ? "full" : width === "full" ? "comfortable" : "wide";
}

/**
 * atui's column within `content` terminal columns: comfortable stops at 104,
 * wide at 160, and full is the content itself. A terminal narrower than the
 * cap keeps its own width, so a narrow pane never loses room to the setting.
 */
export function atuiColumn(width: ChatWidth | null, content: number): number {
  const room = Math.max(1, Math.floor(content));
  if (width === "full") return room;
  return Math.min(width === "wide" ? ATUI_WIDE : ATUI_COMFORTABLE, room);
}

/** Tern's layout caps as CSS lengths: the conversation's page, the dock, and the start screen's list. */
export interface TernColumn {
  page: string;
  dock: string;
  recent: string;
}

/**
 * Tern's caps: comfortable is the 780px page and 792px dock the sheet has always
 * drawn, wide is 1400px, full is the pane. The prompt bubble, the tab strip and
 * the tables are shares of the page, so they need no value of their own.
 */
export function ternColumn(width: ChatWidth | null): TernColumn {
  if (width === "full") return { page: "100%", dock: "100%", recent: "100%" };
  const page = width === "wide" ? TERN_WIDE : TERN_COMFORTABLE;
  return { page: `${page}px`, dock: `${page + TERN_DOCK_EXTRA}px`, recent: `${Math.round(page * TERN_RECENT_SHARE)}px` };
}
