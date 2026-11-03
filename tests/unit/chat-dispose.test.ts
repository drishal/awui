// Disposing a chat is idempotent even when two disposes overlap (the reaper and
// the dispose route, or shutdown): the second must not tear the chat down again.
import { describe, expect, it } from "vitest";
import { ChatManager } from "../../src/server/chats/manager.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";

describe("chat dispose", () => {
  it("runs once when two disposes overlap", async () => {
    const manager = new ChatManager();
    const chat = await manager.create(new FakeAdapter({ chunkDelayMs: 1 }), { id: "w", path: "/p", name: "p" });
    let forgotten = 0;
    const forget = chat.onDisposed;
    chat.onDisposed = (c) => {
      forgotten += 1;
      forget?.(c);
    };
    const events: string[] = [];
    chat.subscribe({ send: (_id, event) => events.push(event.type), close: () => undefined });
    await Promise.all([chat.dispose("first"), chat.dispose("second")]);
    expect(chat.status).toBe("disposed");
    expect(forgotten).toBe(1);
    expect(events.filter((t) => t === "disposed")).toHaveLength(1);
    await manager.shutdown();
  });
});
