// Pi's own context figure, as `get_session_stats` and `get_messages` answer over
// RPC (recorded shapes: `contextUsage` is `{ tokens, contextWindow, percent }`,
// and the system message carries `content`, `sections`, and `toolsAdded`).
import { describe, expect, it } from "vitest";
import { contextFromStats } from "../../src/server/harness/pi.js";

const messages = [
  { role: "system", content: "x".repeat(400), sections: { "Project context": "y".repeat(800) }, toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object" } }] },
  { role: "user", content: "hello" },
  { role: "assistant", content: [{ type: "text", text: "z".repeat(400) }] },
];

const stats = (contextUsage: unknown) => ({ contextUsage });

describe("contextFromStats", () => {
  it("takes the tokens, window, and percent Pi reports", () => {
    expect(contextFromStats(stats({ tokens: 48_120, contextWindow: 200_000, percent: 24.06 }), messages)).toEqual({
      tokens: 48_120,
      window: 200_000,
      percent: 24.06,
      categories: [
        { id: "system", label: "System prompt", tokens: 300 },
        { id: "tools", label: "Tool definitions", tokens: 19 },
        { id: "messages", label: "Messages", tokens: 102 },
      ],
    });
  });

  it("is unknown while no model is selected (Pi sends no contextUsage)", () => {
    expect(contextFromStats({}, messages)).toBeNull();
    expect(contextFromStats(null, messages)).toBeNull();
  });

  it("is unknown right after a compaction, rather than our own estimate of the context", () => {
    const usage = contextFromStats(stats({ tokens: null, contextWindow: 200_000, percent: null }), messages);
    expect(usage).toMatchObject({ tokens: null, window: 200_000, percent: null });
    // The breakdown the panel draws is still there, labelled as the estimate it is.
    expect(usage?.categories?.[2]).toEqual({ id: "messages", label: "Messages", tokens: 102 });
  });

  it("works the percentage out from the tokens when Pi sends only those", () => {
    expect(contextFromStats(stats({ tokens: 50_000, contextWindow: 200_000 }), messages)).toMatchObject({ tokens: 50_000, percent: 25 });
  });

  it("keeps the window and leaves the percentage unknown when the window is unknown", () => {
    expect(contextFromStats(stats({ tokens: 0, contextWindow: 0 }), messages)).toMatchObject({ tokens: null, window: 0, percent: null });
  });
});
