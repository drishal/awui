import { describe, expect, it } from "vitest";
import { branchMessages, forkSessionText, seedSessionText, uuidv7 } from "../../src/server/harness/session-files.js";
import { historyToItems, toolCategory } from "../../src/server/harness/agent-events.js";

/** A Pi-family file: title slot, header, then a tree of entries. */
function sessionText(): string {
  const lines = [
    JSON.stringify({ type: "title", v: 1, title: "Fork me", source: "auto", updatedAt: "2026-01-01T00:00:00.000Z", pad: "  " }),
    JSON.stringify({ type: "session", version: 3, id: "src-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/project", title: "Fork me", providerPromptCacheKey: "cache-1" }),
    JSON.stringify({ type: "message", id: "u1", parentId: null, timestamp: "t1", message: { role: "user", content: "first" } }),
    JSON.stringify({ type: "message", id: "a1", parentId: "u1", timestamp: "t2", message: { role: "assistant", content: [{ type: "text", text: "one" }] } }),
    // An abandoned attempt branching off turn 1: not an ancestor of the leaf.
    JSON.stringify({ type: "message", id: "a1x", parentId: "a1", timestamp: "t3", message: { role: "assistant", content: [{ type: "text", text: "abandoned" }] } }),
    // A compaction whose kept entry rides an abandoned branch; must be dropped.
    JSON.stringify({ type: "compaction", id: "c1", parentId: "a1", timestamp: "t4", firstKeptEntryId: "a1x", tokensBefore: 10 }),
    JSON.stringify({ type: "message", id: "u2", parentId: "c1", timestamp: "t5", message: { role: "user", content: "second" } }),
    JSON.stringify({ type: "message", id: "a2", parentId: "u2", timestamp: "t6", message: { role: "assistant", content: [{ type: "text", text: "two" }] } }),
  ];
  return `${lines.join("\n")}\n`;
}

function parse(text: string) {
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("forkSessionText", () => {
  it("keeps the branch through the Nth turn, not file order", () => {
    const forked = parse(forkSessionText(sessionText(), { throughTurns: 1, id: "fork-1", now: new Date("2026-02-01T10:00:00.000Z"), cwd: "/tmp/project", parentSession: "src-1" }));
    expect(forked[0]).toMatchObject({ type: "title", title: "Fork me" });
    expect(forked[1]).toMatchObject({ type: "session", id: "fork-1", version: 3, cwd: "/tmp/project", parentSession: "src-1", title: "Fork me", providerPromptCacheKey: "cache-1", timestamp: "2026-02-01T10:00:00.000Z" });
    expect(forked.slice(2).map((e) => e.id)).toEqual(["u1", "a1"]);
    // The abandoned attempt and the compaction that pointed into it are gone.
    expect(forked.some((e) => e.id === "a1x" || e.id === "c1")).toBe(false);
  });

  it("drops only the tail when the cut is later, and tolerates a half-written line", () => {
    const forked = parse(forkSessionText(`${sessionText()}{"type":"message","id":"u3","paren`, { throughTurns: 2, id: "fork-2", now: new Date("2026-02-01T10:00:00.000Z"), cwd: "/tmp/project", parentSession: "src-1" }));
    expect(forked.slice(2).map((e) => e.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });

  it("keeps everything when the fork is past the last turn", () => {
    const forked = parse(forkSessionText(sessionText(), { throughTurns: 9, id: "fork-3", now: new Date(), cwd: "/tmp/project", parentSession: "src-1" }));
    expect(forked.slice(2).map((e) => e.id)).toEqual(["u1", "a1", "u2", "a2"]);
  });
});

describe("uuidv7", () => {
  it("is a version-7 uuid and sorts by time", () => {
    const early = uuidv7(1_700_000_000_000);
    const late = uuidv7(1_800_000_000_000);
    expect(early).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(early < late).toBe(true);
  });

  it("writes a handoff seed as one parentId chain both harnesses can walk", () => {
    const text = seedSessionText({
      id: "seed-1",
      cwd: "/tmp/project",
      now: new Date("2026-01-01T00:00:00.000Z"),
      entries: [
        { role: "user", text: "q" },
        { role: "tool", name: "read", summary: "README.md", output: "body" },
        { role: "assistant", text: "a", thinking: "hmm" },
      ],
    });
    const [header, ...entries] = text.trim().split("\n").map((l) => JSON.parse(l));
    expect(header).toMatchObject({ type: "session", version: 3, id: "seed-1", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/project" });
    expect(entries.map((e) => e.parentId)).toEqual([null, entries[0].id, entries[1].id]);
    for (const e of entries) {
      expect(e.id).toMatch(/^[0-9a-f]{8}$/);
      expect(typeof e.timestamp).toBe("string");
      expect(typeof e.message.timestamp).toBe("number");
    }
    expect(entries[1].message.content[0].text).toContain("README.md");
    // Assistant entries carry usage, or session totals throw on them.
    expect(entries[2].message).toMatchObject({ role: "assistant", usage: { input: 0, cost: { total: 0 } }, stopReason: "stop" });
    expect(entries[2].message.content.map((c: { type: string }) => c.type)).toEqual(["thinking", "text"]);
  });

  it("reads the active branch's messages from the file, as the harness lists them", () => {
    const lines = [
      { type: "title", v: 1, title: "T", source: "auto" },
      { type: "session", version: 3, id: "s1", cwd: "/p" },
      { type: "message", id: "u1", parentId: null, message: { role: "user", content: "old" } },
      { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } },
      { type: "message", id: "u2", parentId: "a1", message: { role: "user", content: "kept" } },
      // An abandoned attempt off u2: not on the branch.
      { type: "message", id: "ax", parentId: "u2", message: { role: "assistant", content: [{ type: "text", text: "abandoned" }] } },
      { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: [{ type: "text", text: "kept answer" }] } },
      { type: "compaction", id: "c1", parentId: "a2", summary: "summary", firstKeptEntryId: "u2", timestamp: "2026-01-01T00:00:00.000Z" },
      { type: "branch_summary", id: "b1", parentId: "c1", summary: "came back" },
      { type: "message", id: "u3", parentId: "b1", message: { role: "user", content: "new" } },
    ];
    const messages = branchMessages(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n{"type":"message","id":"torn`) as Array<Record<string, unknown>>;
    expect(messages.map((m) => m.role)).toEqual(["compactionSummary", "user", "assistant", "branchSummary", "user"]);
    expect(messages.map((m) => (typeof m.content === "string" ? m.content : ""))).toEqual(["", "kept", "", "", "new"]);
  });
});

describe("a handoff seed read back", () => {
  it("draws a tool record as the tool row it was, and only when the seed wrote it", () => {
    const record = (model: string) => ({ role: "assistant", model, content: [{ type: "text", text: "[Handed off from another harness] bash: ls -la\ntotal 0\nREADME.md" }], timestamp: 5 });
    const [row] = historyToItems([record("handoff")]);
    expect(row).toMatchObject({ kind: "tool", name: "bash", summary: "ls -la", output: "total 0\nREADME.md", status: "done", category: toolCategory("bash"), at: 5 });
    // The same words from a real model are its own text, not a record.
    expect(historyToItems([record("deepseek-v4.1-flash")])[0]).toMatchObject({ kind: "assistant" });
  });
});
