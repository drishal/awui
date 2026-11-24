// Find in chat (find.ts): matching, stepping, and the folds a query opens.
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/shared/protocol.js";
import { findOffsets, findSnippet, findTurns, foldsToOpen, stepMatch } from "../../src/web/find.js";
import { buildTurns } from "../../src/web/turns.js";

const user = (id: string, text: string): ChatItem => ({ kind: "user", id, text });
const reply = (id: string, text: string, extra: Partial<ChatItem> = {}): ChatItem => ({ kind: "assistant", id, text, thinking: "", streaming: false, ...extra }) as ChatItem;
describe("find in chat", () => {
  it("finds every occurrence without case, steps around, and opens the folds that hold one", () => {
    expect(findOffsets("Echo echo ECHO", "echo")).toEqual([0, 5, 10]);
    expect(findOffsets("aaaa", "aa")).toEqual([0, 2]);
    expect(stepMatch(-1, 3, 1)).toBe(0);
    expect(stepMatch(2, 3, 1)).toBe(0);
    expect(stepMatch(0, 3, -1)).toBe(2);
    expect(stepMatch(0, 0, 1)).toBe(-1);
    const items: ChatItem[] = [
      user("u1", "go"),
      { kind: "tool", id: "t1", name: "read", args: "", status: "done", output: "", truncated: false, category: "read", summary: "src/needle.ts", paths: [] },
      reply("a1", "done"),
      user("u2", "again"),
      reply("a2", "nothing here"),
    ];
    expect(foldsToOpen(buildTurns(items, "idle"), "NEEDLE")).toEqual(["u1"]);
  });

  it("lists the turns that mention a query with a line around the first match, and says when it is in the work", () => {
    const items: ChatItem[] = [
      user("u1", "go"),
      { kind: "tool", id: "t1", name: "read", args: "", status: "done", output: "", truncated: false, category: "read", summary: "src/needle.ts", paths: [] },
      reply("a1", "done"),
      user("u2", "find the Needle please"),
      reply("a2", "the needle is in src and the other needle is not"),
      user("u3", "unrelated"),
      reply("a3", "nothing"),
    ];
    const found = findTurns(buildTurns(items, "idle"), "NEEDLE");
    expect(found.map((m) => [m.index, m.count, m.inWork])).toEqual([[0, 1, true], [1, 3, false]]);
    // One read call is one match: its sentence is what is drawn, not its raw name and summary as well.
    expect(found[1]?.snippet).toContain("Needle");
    expect(findTurns(buildTurns(items, "idle"), "  ")).toEqual([]);
    // The project's own folder leaves the text before it is cut, so a snippet never starts in the middle of a path.
    const under: ChatItem[] = [user("p1", "go"), { kind: "tool", id: "t9", name: "edit", args: "", status: "done", output: "", truncated: false, category: "edit", summary: "/home/me/proj/src/needle.ts", paths: ["/home/me/proj/src/needle.ts"] }, reply("a9", "done")];
    expect(findTurns(buildTurns(under, "idle"), "needle", 30, "/home/me/proj/")[0]?.snippet).not.toContain("/home/me");
    expect(findSnippet("a".repeat(100) + "needle" + "b".repeat(100), "needle", 5)).toBe("…aaaaaneedlebbbbb…");
  });
});
