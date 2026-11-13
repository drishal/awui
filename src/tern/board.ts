// The agents dashboard in Tern (the web UI's Agents board): every session in three columns — Needs
// you, Working, Done — with a delegated child nested under the parent it runs for. The grouping is
// web/dashboard.ts's (boardCards), the words are its BOARD_* tables and prBadge, so a card sits in
// the same column in all three clients; this file lays the board out as Tern nodes and keeps the
// column/cursor arithmetic in pure helpers. Tern draws it; app.ts keeps the filters and opens the
// chat on Enter.
import { span, ui, type IconName, type Node } from "@stencil-hq/tern";
import type { ProjectSession } from "../shared/protocol.js";
import { BOARD_COLUMNS, BOARD_EMPTY, BOARD_TITLES, PR_FILTERS, PR_FILTER_LABELS, prBadge, type BoardCard, type BoardColumn, type PrFilter, type PullRequestShape } from "../web/dashboard.js";
import { isBusy } from "../web/session-groups.js";
import { plainTitle } from "../web/plain-title.js";
import { agentStatusText } from "../web/agent-status.js";
import { ago } from "../web/turns.js";

/** How many cards a column draws before it says how many are left. */
export const COLUMN_CARDS = 8;

/** Where the board's cursor is: a column and a card in it. */
export interface BoardCursor {
  column: BoardColumn;
  at: number;
}

/** The cursor `by` cards down (or up) in its column, held at the ends. */
export function moveCard(cards: Record<BoardColumn, BoardCard[]>, cursor: BoardCursor, by: number): BoardCursor {
  const count = cards[cursor.column].length;
  if (count === 0) return cursor;
  return { ...cursor, at: Math.max(0, Math.min(count - 1, cursor.at + by)) };
}

/** The cursor `by` columns along (or back), its card held inside the new column's list. */
export function moveColumn(cards: Record<BoardColumn, BoardCard[]>, cursor: BoardCursor, by: number): BoardCursor {
  const i = Math.max(0, Math.min(BOARD_COLUMNS.length - 1, BOARD_COLUMNS.indexOf(cursor.column) + by));
  const column = BOARD_COLUMNS[i] as BoardColumn;
  const count = cards[column].length;
  return { column, at: count === 0 ? 0 : Math.min(cursor.at, count - 1) };
}

/** The card under the cursor, when its column holds one. */
export function cursorCard(cards: Record<BoardColumn, BoardCard[]>, cursor: BoardCursor): BoardCard | null {
  return cards[cursor.column][cursor.at] ?? null;
}

/** The next project in the filter's cycle (every project, then each project with cards), or null for every project. */
export function nextProject(projects: readonly string[], current: string | null): string | null {
  const list: Array<string | null> = [null, ...projects];
  return list[(list.indexOf(current) + 1) % list.length] ?? null;
}

/** The next pull-request filter in its cycle. */
export function nextPrFilter(current: PrFilter): PrFilter {
  return PR_FILTERS[(PR_FILTERS.indexOf(current) + 1) % PR_FILTERS.length] ?? "any";
}

export interface BoardCx {
  cards: Record<BoardColumn, BoardCard[]>;
  counts: Record<BoardColumn, number>;
  cursor: BoardCursor;
  /** The filter line: the project's name (or every project) and the pull-request state. */
  filter: string;
  projectName: (workspaceId: string) => string;
  harnessName: (harnessId: string) => string;
  /** Each project's pull request as last read, for the card's badge. */
  prs: Record<string, PullRequestShape | null>;
  /** The sessions are being read: an empty board says so rather than claiming nothing runs. */
  reading: boolean;
  on: { close: () => void; select: (column: BoardColumn, at: number) => void; open: (session: ProjectSession) => void };
}

/** One card's row: its title, the project and age under it, its own status line, and its badge. */
function cardItem(card: BoardCard, cx: BoardCx, index: number): Node {
  const s = card.session;
  const badge = prBadge(s, cx.prs);
  const status = s.agentStatus ? agentStatusText(s.agentStatus) : null;
  const meta = [cx.projectName(s.workspaceId), s.updatedAt ? ago(new Date(s.updatedAt).getTime()) : "", s.asking ? "needs you" : "", s.origin === "agent" ? "delegated" : ""].filter(Boolean).join(" · ");
  return ui.item({
    key: `c${index}`,
    label: plainTitle(s.title) || "Untitled",
    detail: [meta, status ?? ""].filter(Boolean).join(" — "),
    value: [span(badge ? badge.words : "", "muted")],
    icon: (s.origin === "agent" ? "agent" : "session") as IconName,
    ...(s.asking ? { dot: "warning" } : isBusy(s.status) ? { dot: "accent" } : s.status === "error" ? { dot: "error" } : {}),
  });
}

/** The children a card nests: a delegated child is its own row under its parent's, marked as one. */
function childItems(card: BoardCard, cx: BoardCx, from: number): Node[] {
  return card.children.map((child, i) =>
    ui.item({
      key: `c${from + i}`,
      label: `└ ${plainTitle(child.title) || "Untitled"}`,
      detail: `${cx.projectName(child.workspaceId)} · delegated`,
      value: [span(child.asking ? "needs you" : isBusy(child.status) ? "working" : "done", child.asking ? "warning" : isBusy(child.status) ? "accent" : "muted")],
      icon: "agent" as IconName,
      ...(child.asking ? { dot: "warning" } : isBusy(child.status) ? { dot: "accent" } : {}),
    }),
  );
}

/**
 * The board: a tab a column, with its count, and the selected column's cards under it. Three
 * columns of lists do not fit a terminal pane side by side; the tabs keep the browser's three
 * groups, one at a time, with ←/→ moving between them.
 */
export function boardNode(cx: BoardCx): Node {
  const cards = cx.cards[cx.cursor.column];
  // A card and its children are rows of one list, so the cursor's card is what Enter opens.
  const rows: Node[] = [];
  let childIndex = cards.length;
  for (const [i, card] of cards.slice(0, COLUMN_CARDS).entries()) {
    rows.push(cardItem(card, cx, i));
    const children = childItems(card, cx, childIndex);
    childIndex += children.length;
    rows.push(...children);
  }
  const at = cards[cx.cursor.at] as BoardCard | undefined;
  return ui.overlay(
    {
      key: "board",
      anchor: "center",
      size: "lg",
      head: "Agents",
      meta: [span(cx.filter, "muted")],
      end: ui.button({ key: "close", text: "Close", keys: ["esc"], variant: "quiet", size: "sm", onClick: cx.on.close }),
      foot: ui.text({ key: "keys" }, [
        span("←/→ column · ↑/↓ card · Enter opens · f project · r pull request · Esc closes", "muted"),
        ...(at ? [span(`  ·  ${cx.harnessName(at.session.harnessId)}: ${plainTitle(at.session.title) || "Untitled"}`, "dim")] : []),
      ]),
    },
    ui.col(
      { key: "board", gap: "sm" },
      ui.tabs({
        key: "cols",
        role: "awui.board-columns",
        active: cx.cursor.column,
        items: BOARD_COLUMNS.map((id) => ({ id, label: id === "needs" && cx.counts[id] > 0 ? [span(BOARD_TITLES[id], "warning"), span(` ${cx.counts[id]}`, "muted")] : [span(BOARD_TITLES[id]), span(` ${cx.counts[id]}`, "muted")] })),
        onSelect: (e) => {
          const column = BOARD_COLUMNS.find((id) => id === e.item);
          if (column) cx.on.select(column, 0);
        },
      }),
      rows.length > 0
        ? ui.list(
            {
              key: "l",
              selected: at ? `layer.board.l.c${cx.cursor.at}` : undefined,
              max: { lines: COLUMN_CARDS + 4 },
              onSelect: (e) => {
                const n = Number(/\.c(\d+)$/.exec(e.item)?.[1] ?? -1);
                if (n >= 0) cx.on.select(cx.cursor.column, n);
              },
              onActivate: (e) => {
                const n = Number(/\.c(\d+)$/.exec(e.item)?.[1] ?? -1);
                const card = cards[n];
                if (card) cx.on.open(card.session);
              },
            },
            rows,
          )
        : ui.text({ key: "empty" }, span(cx.reading ? "Reading this server's sessions…" : BOARD_EMPTY[cx.cursor.column], "muted")),
      cards.length > COLUMN_CARDS ? ui.text({ key: "more" }, span(`${cards.length - COLUMN_CARDS} more in this column`, "muted")) : null,
    ),
  );
}

/** The filter line the overlay's head carries: the project in view and the pull-request state. */
export const boardFilterLine = (projectName: string | null, total: number, pr: PrFilter): string => `${projectName ?? `Every project (${total})`} · ${PR_FILTER_LABELS[pr]}`;
