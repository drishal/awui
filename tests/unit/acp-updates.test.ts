import { describe, expect, it } from "vitest";
import { acpContentText, categoryOfKind, commandsFrom, foldAcpUpdate, itemsFromAcpFolds, type AcpFold } from "../../src/server/harness/acp-updates.js";

const fold = (update: Record<string, unknown>, at = 1_700_000_000_000): AcpFold => foldAcpUpdate(update, at);

describe("foldAcpUpdate", () => {
  it("reads message and thought chunks as deltas, and a block list as its text", () => {
    expect(fold({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } })).toEqual({ type: "delta", field: "text", delta: "Hel" });
    expect(fold({ sessionUpdate: "agent_thought_chunk", content: [{ type: "text", text: "hmm" }] })).toEqual({ type: "delta", field: "thinking", delta: "hmm" });
    // A chunk with no text is not an event.
    expect(fold({ sessionUpdate: "agent_message_chunk", content: { type: "image", data: "x" } })).toEqual({ type: "ignore" });
    expect(acpContentText([{ type: "text", text: "a" }, { type: "resource_link", name: "notes", uri: "file:///n" }])).toBe("a\n[notes](file:///n)");
  });

  it("names a user echo, so a history replay can read it", () => {
    expect(fold({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "why" } })).toEqual({ type: "user", text: "why", at: 1_700_000_000_000 });
  });

  it("files a tool call under the agent's own kind, falling back to its name", () => {
    expect(
      fold({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Reading the config",
        name: "read_file",
        kind: "read",
        rawInput: { path: "/tmp/a.txt" },
        locations: [{ path: "/tmp/a.txt", line: 3 }],
      }),
    ).toEqual({ type: "tool_start", toolCallId: "call-1", name: "read_file", args: { path: "/tmp/a.txt" }, category: "read", paths: ["/tmp/a.txt"], at: 1_700_000_000_000 });
    expect(categoryOfKind("execute", "anything")).toBe("command");
    expect(categoryOfKind("fetch", "anything")).toBe("web");
    expect(categoryOfKind(undefined, "grep")).toBe("search");
    // A call that names no tool still shows the title the user saw.
    expect(fold({ sessionUpdate: "tool_call", toolCallId: "c", title: "Doing a thing" })).toMatchObject({ name: "Doing a thing" });
  });

  it("turns a completed call's diff content into a unified diff the tool row reads", () => {
    const ended = fold({
      sessionUpdate: "tool_call_update",
      toolCallId: "call-2",
      status: "completed",
      content: [{ type: "diff", path: "/tmp/a.txt", oldText: "one\n", newText: "two\n" }],
    });
    expect(ended).toMatchObject({ type: "tool_end", toolCallId: "call-2", isError: false });
    const details = (ended as Extract<AcpFold, { type: "tool_end" }>).details as { diff: string };
    expect(details.diff).toContain("-one");
    expect(details.diff).toContain("+two");
    // An update with no text and no status is progress noise, not an event.
    expect(fold({ sessionUpdate: "tool_call_update", toolCallId: "call-2", locations: [{ path: "/a" }] })).toEqual({ type: "ignore" });
    expect(fold({ sessionUpdate: "tool_call_update", toolCallId: "call-2", status: "failed", content: [{ type: "content", content: { type: "text", text: "boom" } }] })).toMatchObject({ type: "tool_end", output: "boom", isError: true });
  });

  it("keeps the occupancy an agent reports, and only in a known currency", () => {
    expect(fold({ sessionUpdate: "usage_update", used: 12000, size: 200000, cost: { amount: 0.02, currency: "USD" } })).toEqual({ type: "context", used: 12000, size: 200000, costUsd: 0.02 });
    expect(fold({ sessionUpdate: "usage_update", used: 10, size: 0 })).toEqual({ type: "ignore" });
    expect(fold({ sessionUpdate: "usage_update", used: 10, size: 100, cost: { amount: 3, currency: "credits" } })).toEqual({ type: "context", used: 10, size: 100, costUsd: null });
  });

  it("reads a plan as a notice, and a session's own title", () => {
    expect(fold({ sessionUpdate: "plan", entries: [{ content: "Read" }, { content: "Write" }] })).toEqual({ type: "notice", text: "Read; Write", at: 1_700_000_000_000 });
    expect(fold({ sessionUpdate: "session_info_update", title: "  Named  session " })).toEqual({ type: "title", title: "Named session" });
  });

  it("takes an agent's own slash commands, without the slash", () => {
    expect(commandsFrom([{ name: "/review", description: "Review the diff", input: { hint: "[path]" } }, { name: "" }])).toEqual([
      { name: "review", source: "agent", description: "Review the diff", hint: "[path]" },
    ]);
    expect(fold({ sessionUpdate: "available_commands_update", availableCommands: [{ name: "review" }] })).toMatchObject({ type: "commands", commands: [{ name: "review" }] });
  });

  it("notes an unknown kind instead of failing, and passes a config table through", () => {
    expect(fold({ sessionUpdate: "auto_approved", toolCallId: "x" })).toEqual({ type: "unknown", kind: "auto_approved" });
    expect(fold({ sessionUpdate: "config_option_update", configOptions: [{ id: "model" }] })).toEqual({ type: "config", options: [{ id: "model" }] });
    expect(foldAcpUpdate({ content: "no kind" }, 1)).toEqual({ type: "ignore" });
    expect(foldAcpUpdate(null, 1)).toEqual({ type: "ignore" });
  });
});

describe("itemsFromAcpFolds", () => {
  it("builds a replayed conversation: the prompt, the answer, and a tool call with its diff", () => {
    const folds: AcpFold[] = [
      { type: "user", text: "change it", at: 1 },
      { type: "delta", field: "thinking", delta: "reading" },
      { type: "delta", field: "text", delta: "Sure" },
      { type: "tool_start", toolCallId: "c1", name: "edit_file", args: { path: "/tmp/a.txt" }, category: "edit", paths: ["/tmp/a.txt"], at: 3 },
      {
        type: "tool_end",
        toolCallId: "c1",
        output: "done",
        isError: false,
        details: { diff: "--- a/a.txt\n+++ b/a.txt\n@@ -1,1 +1,1 @@\n-old\n+new" },
        at: 4,
      },
      { type: "delta", field: "text", delta: "Changed" },
      { type: "notice", text: "compacting", at: 6 },
    ];
    const items = itemsFromAcpFolds(folds);
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "assistant", "notice"]);
    const tool = items[2];
    expect(tool).toMatchObject({ kind: "tool", name: "edit_file", status: "done", category: "edit", paths: ["/tmp/a.txt"] });
    if (tool?.kind === "tool" && tool.diff) {
      expect(tool.diff.added).toBe(1);
      expect(tool.diff.lines.some((line) => line.kind === "add" && line.text === "new")).toBe(true);
    } else {
      throw new Error("the edit should carry its diff");
    }
  });

  it("fails a call still running at the end of the replay", () => {
    const items = itemsFromAcpFolds([{ type: "tool_start", toolCallId: "c1", name: "run_command", args: {}, category: "command", paths: [], at: 1 }]);
    expect(items[0]).toMatchObject({ kind: "tool", status: "error" });
  });
});
