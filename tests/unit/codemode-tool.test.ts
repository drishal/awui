// Pi's codemode runs other tools inside one script, so its result records the calls it made
// (`details.calls`) instead of a diff of its own. The adapter reads the edits among them as the
// call's facts, and the fold puts that diff on the row: a script that appended one line shows +1.
import { describe, expect, it } from "vitest";
import { Chat } from "../../src/server/chats/chat.js";
import { historyToItems, normalizeAgentEvent } from "../../src/server/harness/agent-events.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import type { HarnessEvent, HarnessEventListener, LiveChat } from "../../src/server/harness/types.js";
import type { ChatConfig, ChatItem, ChatSnapshot, ToolItem, WorkspaceInfo } from "../../src/shared/protocol.js";
import { buildTurns } from "../../src/web/turns.js";

const config: ChatConfig = { model: null, thinkingLevel: null, models: [], thinkingLevels: [] };
const workspace: WorkspaceInfo = { id: "w", path: "/tmp/proj", name: "proj" };

/** A LiveChat that records its subscriber so a test can hand the chat the adapter's events. */
function stubLive(): { live: LiveChat; emit: (event: HarnessEvent) => void } {
  let listener: HarnessEventListener | null = null;
  const live = {
    nativeId: null,
    title: null,
    subscribe(next: HarnessEventListener) {
      listener = next;
      return () => {
        listener = null;
      };
    },
    history: async () => [],
    getConfig: async () => config,
    getContextUsage: async () => null,
    getUsage: async () => null,
    getTodos: async () => [],
    listCommands: async () => [],
    prompt: async () => undefined,
    steer: async () => undefined,
    followUp: async () => undefined,
    abort: async () => undefined,
    setConfig: async () => undefined,
    refreshModels: async () => undefined,
    rename: async () => undefined,
    compact: async () => undefined,
    answer: () => false,
    dispose: async () => undefined,
  } satisfies LiveChat;
  return { live, emit: (event) => listener?.(event) };
}

const tools = (snapshot: ChatSnapshot): ToolItem[] => snapshot.items.filter((item): item is ToolItem => item.kind === "tool");

describe("a codemode script that edited a file", () => {
  it("reports the edit as the call's diff, so the row counts it", async () => {
    const { live, emit } = stubLive();
    const chat = await Chat.open("c1", new FakeAdapter(), workspace, live);
    const frame = {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "codemode",
      result: {
        content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
        // The real record: each call's arguments are a JSON string, truncated for a long one.
        details: { calls: [{ id: "call_1/1", name: "insert", status: "ok", args: JSON.stringify({ path: "SCRATCH.md", anchor: "a1b2c", direction: "after", text: "touched by the live check" }) }] },
      },
      isError: false,
    };
    for (const event of normalizeAgentEvent({ type: "tool_execution_start", toolCallId: "call_1", toolName: "codemode", args: { code: "await tools.insert({…})" } }, "agent_settled")) emit(event);
    for (const event of normalizeAgentEvent(frame, "agent_settled")) emit(event);
    const [tool] = tools(chat.snapshot());
    expect(tool).toMatchObject({ name: "codemode", status: "done", category: "other", diffStat: { added: 1, removed: 0 } });
    expect(tool?.diff?.lines).toEqual([
      { kind: "hunk", text: "SCRATCH.md" },
      { kind: "add", text: "touched by the live check", line: 1 },
    ]);
    // The script edited a file its own arguments do not name: the nested calls do.
    expect(tool?.paths).toEqual(["SCRATCH.md"]);
    // The turn's footer counts it too: +1 over one file, like an edit call's.
    const [turn] = buildTurns(chat.snapshot().items, "idle");
    expect(turn?.changeStat).toEqual({ added: 1, removed: 0, files: 1, partial: false });
    expect(turn?.changedFiles).toEqual(["SCRATCH.md"]);
    await chat.dispose("test");
  });

  it("reads the same from a stored transcript, so a reload keeps the count", () => {
    const calls = [{ name: "insert", args: JSON.stringify({ path: "SCRATCH.md", anchor: "a1b2c", direction: "after", text: "touched by the live check" }) }];
    const items = historyToItems([
      { role: "assistant", content: [{ type: "toolCall", id: "call_1", name: "codemode", arguments: { code: "await tools.insert({…})" } }], timestamp: 1000 },
      { role: "toolResult", toolCallId: "call_1", toolName: "codemode", content: [{ type: "text", text: "Script completed" }], details: { calls }, isError: false, timestamp: 1001 },
    ]);
    const tool = items.find((item): item is ToolItem => item.kind === "tool");
    expect(tool).toMatchObject({ paths: ["SCRATCH.md"], diffStat: { added: 1, removed: 0 } });
  });

  it("leaves a script that only read alone, and a plain command keeps no diff", async () => {
    const { live, emit } = stubLive();
    const chat = await Chat.open("c2", new FakeAdapter(), workspace, live);
    const codemode: HarnessEvent[] = [
      { type: "tool_start", toolCallId: "call_1", name: "codemode", args: { code: "await tools.read({ path: 'a.ts' })" } },
      { type: "tool_end", toolCallId: "call_1", output: "Script completed", isError: false, details: { calls: [{ name: "read", args: JSON.stringify({ path: "a.ts" }) }] } },
      { type: "tool_start", toolCallId: "call_2", name: "bash", args: { command: "echo '{\"diff\":\"x\"}'" } },
      { type: "tool_end", toolCallId: "call_2", output: '{"diff":"--- a/x\\n+++ b/x\\n@@ -1 +1 @@\\n-a\\n+b\\n"}', isError: false },
    ];
    for (const event of codemode) emit(event);
    const items: ChatItem[] = chat.snapshot().items;
    expect(items.find((item): item is ToolItem => item.kind === "tool" && item.name === "codemode")?.diff).toBeUndefined();
    expect(items.find((item): item is ToolItem => item.kind === "tool" && item.name === "bash")?.diffStat).toBeUndefined();
    await chat.dispose("test");
  });
});
