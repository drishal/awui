// The branches of a Pi-family session file: one per leaf, the active one first, and a fork of a leaf keeps its whole path.
import { describe, expect, it } from "vitest";
import type { Obj } from "../../src/server/harness/agent-events.js";
import { chainTo, sessionBranches } from "../../src/server/harness/session-branches.js";
import { forkSessionText } from "../../src/server/harness/session-files.js";

const user = (id: string, parentId: string | null, text: string): Obj => ({ type: "message", id, parentId, message: { role: "user", content: text } });
const reply = (id: string, parentId: string, text: string): Obj => ({ type: "message", id, parentId, message: { role: "assistant", content: [{ type: "text", text }] } });

/** u1 a1 u2 a2, then the second prompt was edited: u2b a2b (the file's last entry, so the active leaf). */
const entries = (): Obj[] => [
  { type: "session", id: "sess", version: 3 },
  user("u1", null, "first question"),
  reply("a1", "u1", "one"),
  user("u2", "a1", "second question"),
  reply("a2", "u2", "two"),
  user("u2b", "a1", "a better second question"),
  reply("a2b", "u2b", "two again"),
];

describe("sessionBranches", () => {
  it("lists each leaf, the active path first, with the prompt that tells it apart", () => {
    expect(sessionBranches(entries())).toEqual([
      { leafId: "a2b", active: true, turns: 2, shared: 2, prompt: "a better second question" },
      { leafId: "a2", active: false, turns: 2, shared: 1, prompt: "second question" },
    ]);
  });
  it("is one branch for a straight session, and none for an empty one", () => {
    expect(sessionBranches(entries().slice(0, 5)).map((b) => b.leafId)).toEqual(["a2"]);
    expect(sessionBranches([{ type: "session", id: "s" }])).toEqual([]);
  });
  it("shows the last prompt of a branch that only answered differently", () => {
    const retried = [...entries().slice(0, 5), reply("a2c", "u2", "two, another way")];
    const branches = sessionBranches(retried);
    expect(branches.map((b) => [b.leafId, b.active, b.shared, b.prompt])).toEqual([
      ["a2c", true, 2, "second question"],
      ["a2", false, 2, "second question"],
    ]);
  });
  it("walks a chain to a leaf, root first", () => {
    expect(chainTo(entries().slice(1), "a2").map((e) => e.id)).toEqual(["u1", "a1", "u2", "a2"]);
    expect(chainTo(entries().slice(1), "missing")).toEqual([]);
  });
});

describe("forkSessionText with a leaf", () => {
  const text = entries().map((e) => JSON.stringify(e)).join("\n");
  const fork = (leafId: string) => forkSessionText(text, { throughTurns: 0, leafId, id: "copy", now: new Date(0), cwd: "/p", parentSession: "sess" });
  it("keeps the whole path to a branch the chat is not on", () => {
    const ids = fork("a2").trim().split("\n").map((l) => (JSON.parse(l) as Obj).id);
    expect(ids).toEqual(["copy", "u1", "a1", "u2", "a2"]);
  });
  it("refuses a leaf that is not in the file", () => {
    expect(() => fork("nope")).toThrow(/not in the session/);
  });
});
