import { constants, zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  decodeSessionLog,
  eventsFromText,
  firstPrompt,
  foldAcpUpdate,
  headerFrom,
  itemsFromEvents,
  messageCount,
  projectKey,
  resyncZstd,
  scanZstdFrames,
  sessionSegment,
  titleFromEvents,
  updateOf,
  usageFromEvents,
  type DshEvent,
} from "../../src/server/harness/dsh-transcript.js";

const CHECKSUM = { params: { [constants.ZSTD_c_checksumFlag]: 1 } };
const frame = (text: string) => zstdCompressSync(Buffer.from(text), CHECKSUM);
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const log = (...values: unknown[]) => Buffer.concat(values.map((value) => (typeof value === "string" ? frame(value) : (value as Buffer))));

const HEADER = { type: "session", version: 4, id: "0f0e0d0c-0000-4000-8000-000000000001", createdAt: 1792245548000, cwd: "/home/user/proj", isSeeded: false, delegationDepth: 0 };

function events(...values: unknown[]): DshEvent[] {
  return eventsFromText(values.map(line).join(""));
}

describe("DSH's session directory encoding", () => {
  it("names a project the way DSH files it", () => {
    expect(projectKey("/home/user/proj")).toBe("--home-user-proj--");
    expect(projectKey("/home/user/my project")).toBe("--home-user-my~0020project--");
    expect(projectKey("/home/user/a/b: c\\d~e")).toBe("--home-user-a-b-~0020c-d~007Ee--");
    expect(projectKey("/")).toBe("--root--");
  });

  it("encodes a session id as one safe path segment", () => {
    expect(sessionSegment("session-0f0e")).toBe("session-0f0e");
    expect(sessionSegment("../etc")).toBe("..~002Fetc");
    expect(sessionSegment(".")).toBe("~002E");
    expect(sessionSegment("..")).toBe("~002E~002E");
  });
});

describe("DSH's zstd frame container", () => {
  it("reads every frame of a concatenated log and tolerates a torn final append", () => {
    const first = frame(line(HEADER));
    const second = frame(line({ type: "model/selection", seq: 0, time: 1, data: { provider: "p", model: "m" } }));
    const both = log(first, second);
    expect(decodeSessionLog(both)).toContain('"type":"session"');
    expect(decodeSessionLog(both)).toContain('"type":"model/selection"');
    // A crash can leave the last frame half written; its predecessor is still readable.
    const torn = Buffer.concat([first, second.subarray(0, second.length - 5)]);
    expect(decodeSessionLog(torn)).toContain('"type":"session"');
    expect(decodeSessionLog(torn)).not.toContain('"type":"model/selection"');
    expect(scanZstdFrames(both).frames).toHaveLength(2);
  });

  it("returns nothing for a buffer that is not a frame stream, and resyncs a tail read", () => {
    expect(decodeSessionLog(Buffer.from("{\"type\":\"session\"}\n"))).toBe("");
    const first = frame(line(HEADER));
    const second = frame(line({ type: "session/title", seq: 1, time: 2, data: { title: "A title" } }));
    // A tail read starts mid-frame; resync drops the partial frame.
    const tail = resyncZstd(Buffer.concat([Buffer.from("garbage"), second]));
    expect(decodeSessionLog(tail)).toContain('"title":"A title"');
    expect(decodeSessionLog(first)).toContain('"type":"session"');
  });

  it("keeps the head and tail past its bound, without splitting an event", () => {
    const a = frame(line({ type: "user/message", seq: 1, time: 1, data: { content: [{ type: "text", text: `${"a".repeat(180)}` }] } }));
    const b = frame(line({ type: "assistant/message", seq: 2, time: 2, data: { message: { content: [{ type: "text", text: `${"b".repeat(180)}` }] } } }));
    const c = frame(line({ type: "session/title", seq: 3, time: 3, data: { title: `${"c".repeat(180)}` } }));
    const text = decodeSessionLog(log(a, b, c), 400);
    expect(text).toContain("a".repeat(180));
    expect(text).toContain("c".repeat(180));
    expect(text).not.toContain("b".repeat(180));
    expect(text.endsWith("\n")).toBe(true);
  });
});

describe("DSH's session events", () => {
  it("reads the header, title, first prompt, and message count", () => {
    const parsed = events(
      HEADER,
      { type: "user/message", seq: 1, time: 1, data: { content: [{ type: "text", text: "  hello   there\n" }], role: "user" } },
      { type: "assistant/message", seq: 2, time: 2, data: { message: { content: [{ type: "text", text: "hi" }] } } },
      { type: "session/title", seq: 3, time: 3, data: { title: "A named session" } },
      { type: "session/title", seq: 4, time: 4, data: { title: "The newer title" } },
    );
    expect(headerFrom(parsed)).toMatchObject({ id: HEADER.id, cwd: "/home/user/proj", version: 4 });
    expect(titleFromEvents(parsed)).toBe("The newer title");
    expect(firstPrompt(parsed)).toBe("hello there");
    expect(messageCount(parsed)).toBe(2);
  });

  it("adds up token usage and leaves every call unpriced", () => {
    const parsed = events(
      { type: "turn/start", seq: 1, time: 1, data: { turn: 1 } },
      { type: "request/context", seq: 2, time: 2, data: { provider: "deepseek-official", model: "deepseek-v4-flash", contextWindow: 1_000_000 } },
      {
        type: "assistant/message",
        seq: 3,
        time: 3,
        data: { message: { content: [], source: { model: "deepseek-v4-flash" } }, usage: { inputTokens: 10, outputTokens: 12, totalTokens: 122, cacheReadTokens: 100 } },
      },
    );
    const usage = usageFromEvents(parsed);
    expect(usage.usage).toEqual({ turns: 1, steps: 1, input: 10, cachedInput: 100, cacheWrite: 0, output: 12, cost: null });
    expect(usage.entries).toEqual([{ at: 3, model: "deepseek-v4-flash", input: 10, cachedInput: 100, cacheWrite: 0, output: 12, cost: null }]);
    expect(usage.lastTokens).toBe(122);
    expect(usage.contextWindow).toBe(1_000_000);
  });

  it("builds the conversation, an edit's diff from the result meta, and a render page", () => {
    const items = itemsFromEvents(
      events(
        HEADER,
        { type: "user/message", seq: 1, time: 10, data: { content: [{ type: "text", text: "fix it" }] } },
        {
          type: "assistant/message",
          seq: 2,
          time: 20,
          data: {
            message: {
              role: "assistant",
              content: [
                { type: "reasoning", text: "thinking" },
                { type: "text", text: "on it" },
                { type: "tool-call", id: "call-1", name: "edit", arguments: JSON.stringify({ file_path: "file.txt" }) },
              ],
            },
          },
        },
        { type: "tool/call", seq: 3, time: 21, data: { callId: "call-1", name: "edit", arguments: JSON.stringify({ file_path: "file.txt" }) } },
        {
          type: "tool/result",
          seq: 4,
          time: 22,
          data: {
            message: { role: "tool", toolCallId: "call-1", content: [{ type: "text", text: "The file file.txt has been updated successfully." }], isError: false },
            meta: { path: "file.txt", diffs: [{ path: "file.txt", oldText: "a\n", newText: "b\n" }] },
          },
        },
        { type: "tool/call", seq: 5, time: 30, data: { callId: "call-2", name: "mcp__awui__render_html", arguments: JSON.stringify({ title: "Page" }) } },
        {
          type: "tool/result",
          seq: 6,
          time: 31,
          data: {
            message: {
              role: "tool",
              toolCallId: "call-2",
              content: [{ type: "text", text: `Published.\nawui-html-render:${JSON.stringify({ id: "a".repeat(32), title: "Page", height: 300 })}` }],
              isError: false,
            },
          },
        },
        { type: "tool/call", seq: 7, time: 40, data: { callId: "call-3", name: "read", arguments: JSON.stringify({ file_path: "README.md" }) } },
        { type: "assistant/message", seq: 8, time: 40, data: { message: { content: [{ type: "tool-call", id: "call-3", name: "read", arguments: JSON.stringify({ file_path: "README.md" }) }] } } },
      ),
    );
    expect(items.map((item) => item.kind)).toEqual(["user", "assistant", "tool", "tool", "tool"]);
    expect(items[1]).toMatchObject({ text: "on it", thinking: "thinking", streaming: false });
    const edit = items[2];
    if (!edit || edit.kind !== "tool") throw new Error("expected an edit");
    expect(edit).toMatchObject({ status: "done", category: "edit", output: "The file file.txt has been updated successfully.", diffStat: { added: 1, removed: 1 } });
    expect(edit.diff?.lines.some((entry) => entry.kind === "del" && entry.text === "a")).toBe(true);
    const render = items[3];
    if (!render || render.kind !== "tool") throw new Error("expected a render");
    expect(render.htmlRender).toEqual({ id: "a".repeat(32), title: "Page", height: 300 });
    expect(render.output).toBe("Published.");
    // A call whose result never came failed with the session.
    expect(items[4]).toMatchObject({ kind: "tool", name: "read", status: "error" });
  });

  it("creates a tool row from tool/call when its assistant message was cut out of the read", () => {
    const items = itemsFromEvents(
      events(
        { type: "tool/call", seq: 1, time: 10, data: { callId: "c1", name: "bash", arguments: JSON.stringify({ command: "ls" }) } },
        { type: "tool/result", seq: 2, time: 11, data: { message: { toolCallId: "c1", content: [{ type: "text", text: "a\nb" }], isError: true } } },
      ),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "tool", name: "bash", category: "command", summary: "ls", status: "error", output: "a\nb" });
  });
});

describe("DSH's live ACP updates", () => {
  it("folds chunks, the generic tool lifecycle, usage, and config", () => {
    expect(foldAcpUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } }, 1)).toEqual({ type: "delta", field: "text", delta: "hi" });
    expect(foldAcpUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hm" } }, 1)).toEqual({ type: "delta", field: "thinking", delta: "hm" });
    expect(foldAcpUpdate({ sessionUpdate: "tool_call", toolCallId: "c1", title: "bash", rawInput: { command: "ls" } }, 2)).toEqual({ type: "tool_start", toolCallId: "c1", name: "bash", args: { command: "ls" }, at: 2 });
    expect(
      foldAcpUpdate({ sessionUpdate: "tool_call_update", toolCallId: "c1", status: "completed", content: [{ type: "content", content: { type: "text", text: "a\nb" } }] }, 3),
    ).toEqual({ type: "tool_end", toolCallId: "c1", output: "a\nb", isError: false, at: 3 });
    expect(foldAcpUpdate({ sessionUpdate: "usage_update", used: 120, size: 1000 }, 4)).toEqual({ type: "usage", used: 120, size: 1000 });
    expect(foldAcpUpdate({ sessionUpdate: "config_option_update", configOptions: [{ id: "model" }] }, 5)).toEqual({ type: "config", options: [{ id: "model" }] });
    // Commands, modes, plans, and terminals are outside DSH's automation surface.
    expect(foldAcpUpdate({ sessionUpdate: "plan", entries: [] }, 6)).toEqual({ type: "ignore" });
  });

  it("finds the update in either ACP envelope shape", () => {
    expect(updateOf({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "x" } } })).toEqual({ sessionUpdate: "x" });
    expect(updateOf({ method: "session/update", params: { sessionUpdate: "y" } })).toEqual({ sessionUpdate: "y" });
    expect(updateOf({ method: "other" })).toBeNull();
  });
});
