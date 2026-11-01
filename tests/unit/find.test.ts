// Find in chat (find.ts): matching, stepping, and the folds a query opens.
import { describe, expect, it } from "vitest";
import type { ChatItem } from "../../src/shared/protocol.js";
import { findOffsets, foldsToOpen, stepMatch } from "../../src/web/find.js";
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
});
