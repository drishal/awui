// The Tern client's own decisions about the work surfaces, without a terminal: where a tool call
// was drawn (the rail's run and job rows open it), the board's cursor arithmetic, and the filters'
// cycles. The grouping and the words are the web UI's and are tested there.
import { describe, expect, it } from "bun:test";
import type { ChatItem, ProjectSession } from "../../src/shared/protocol.js";
import { buildTurns } from "../../src/web/turns.js";
import { toolPlace } from "../../src/tern/rail.js";
import { boardFilterLine, cursorCard, moveCard, moveColumn, nextPrFilter, nextProject, type BoardCursor } from "../../src/tern/board.js";
import { BOARD_COLUMNS, type BoardCard, type BoardColumn } from "../../src/web/dashboard.js";

const tool = (id: string): ChatItem => ({ kind: "tool", id, name: "read", args: "", status: "done", output: "", truncated: false, category: "read", summary: "README.md", paths: [] });

describe("where the conversation drew a tool call", () => {
  it("names the turn, the fold holding the call, and the call's row under the page", () => {
    const items: ChatItem[] = [
      { kind: "user", id: "u1", text: "one", at: 1 } as ChatItem,
      tool("t1"),
      tool("t2"),
      { kind: "user", id: "u2", text: "two", at: 2 } as ChatItem,
      tool("t3"),
    ];
    const turns = buildTurns(items, "idle");
    expect(toolPlace(turns, "t2", "main.page")).toMatchObject({ turn: 0, row: expect.stringContaining("main.page.") });
    expect(toolPlace(turns, "t2", "main.page")?.row.endsWith(".items.t2")).toBe(true);
    expect(toolPlace(turns, "t3", "main.page")?.turn).toBe(1);
    expect(toolPlace(turns, "gone", "main.page")).toBeNull();
  });
});

const session = (id: string, title = id): ProjectSession => ({ id, harnessId: "fake", title, workspaceId: "ws", updatedAt: "2026-01-01T00:00:00.000Z" }) as ProjectSession;
const card = (id: string, children: ProjectSession[] = []): BoardCard => ({ session: session(id), children });
const cards = (needs: BoardCard[] = [], working: BoardCard[] = [], done: BoardCard[] = []): Record<BoardColumn, BoardCard[]> => ({ needs, working, done });

describe("the board's cursor", () => {
  it("moves a card at a time, held at the ends, and across the columns", () => {
    const board = cards([card("a"), card("b")], [], [card("c"), card("d"), card("e")]);
    const at = (cursor: BoardCursor) => `${cursor.column}:${cursor.at}`;
    expect(at(moveCard(board, { column: "done", at: 0 }, 1))).toBe("done:1");
    expect(at(moveCard(board, { column: "done", at: 0 }, -1))).toBe("done:0");
    expect(at(moveCard(board, { column: "done", at: 2 }, 1))).toBe("done:2");
    expect(at(moveCard(board, { column: "working", at: 0 }, 1))).toBe("working:0");
    expect(at(moveColumn(board, { column: "needs", at: 1 }, 1))).toBe("working:0");
    expect(at(moveColumn(board, { column: "needs", at: 1 }, -1))).toBe("needs:1");
    // A column with fewer cards holds the cursor inside its own list.
    expect(at(moveColumn(board, { column: "done", at: 2 }, -1))).toBe("working:0");
    expect(at(moveColumn(board, { column: "needs", at: 1 }, 2))).toBe("done:1");
  });

  it("names the card under the cursor, and nothing in an empty column", () => {
    const board = cards([card("a")]);
    expect(cursorCard(board, { column: "needs", at: 0 })?.session.id).toBe("a");
    expect(cursorCard(board, { column: "needs", at: 3 })).toBeNull();
    expect(cursorCard(board, { column: "done", at: 0 })).toBeNull();
  });

  it("cycles the project filter through every project and each one, then back", () => {
    expect(nextProject(["a", "b"], null)).toBe("a");
    expect(nextProject(["a", "b"], "a")).toBe("b");
    expect(nextProject(["a", "b"], "b")).toBeNull();
    expect(nextProject([], null)).toBeNull();
  });

  it("cycles the pull-request filter in the web UI's order", () => {
    const seen = [nextPrFilter("any")];
    for (let i = 0; i < 5; i++) seen.push(nextPrFilter(seen[seen.length - 1] as never));
    expect(seen).toEqual(["open", "draft", "merged", "closed", "none", "any"]);
  });

  it("writes the filter line as the browser's selects read", () => {
    expect(boardFilterLine(null, 3, "any")).toBe("Every project (3) · Any pull request");
    expect(boardFilterLine("alpha", 3, "draft")).toBe("alpha · Draft");
  });
});

describe("the board's columns", () => {
  it("is the web UI's three, in its order", () => {
    expect(BOARD_COLUMNS).toEqual(["needs", "working", "done"]);
  });
});
