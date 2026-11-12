// The reaper's idle clock vs sidebar recency: viewing an old chat must not
// promote it, but it must not make the chat look abandoned either.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatManager } from "../../src/server/chats/manager.js";
import type { ChatSubscriber } from "../../src/server/chats/chat.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { toSeed } from "../../src/server/harness/handoff.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("chat reaper", () => {
  it("counts idle time from the last viewer leaving, not from the old history", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const old = new Date("2026-01-01T00:00:00.000Z");
    vi.setSystemTime(old);
    const adapter = new FakeAdapter({ chunkDelayMs: 1 });
    const seeded = await adapter.seedChat({ cwd: "/p", seed: toSeed([{ kind: "user", id: "u", text: "long ago" }]) });
    const nativeId = seeded.nativeId as string;
    await seeded.dispose();

    vi.setSystemTime(new Date("2026-06-01T00:00:00.000Z"));
    const manager = new ChatManager();
    const chat = await manager.resume(adapter, { id: "w", path: "/p", name: "p" }, nativeId);
    // Sidebar order still says "long ago".
    expect(chat.lastActivity).toBe(old.getTime());
    const viewer: ChatSubscriber = { send: () => undefined, close: () => undefined };
    const leave = chat.subscribe(viewer);
    vi.setSystemTime(new Date("2026-06-01T01:00:00.000Z"));
    leave();

    const reap = () => (manager as unknown as { reap(): Promise<void> }).reap();
    await reap();
    expect(chat.status).toBe("idle");
    vi.setSystemTime(new Date("2026-06-01T01:31:00.000Z"));
    await reap();
    expect(chat.status).toBe("disposed");
    await manager.shutdown();
  });
});

describe("what the reaper leaves alone", () => {
  it("keeps a chat whose chain still has steps to run", async () => {
    const adapter = new FakeAdapter({ chunkDelayMs: 1 });
    const manager = new ChatManager(60_000);
    const chat = await manager.create(adapter, { id: "w", path: "/p", name: "p" });
    await chat.send("hello", "normal");
    const until = Date.now() + 5_000;
    while (chat.status !== "idle" && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
    expect(chat.status).toBe("idle");
    chat.setChain([{ id: "step-1", kind: "send", text: "then do this" }]);
    expect(chat.chainLength).toBe(1);
    // Past the idle clock with no viewer: the queued step is work a closed chat would lose.
    chat.lastSeen = Date.now() - 10 * 60_000;
    const reap = () => (manager as unknown as { reap(): Promise<void> }).reap();
    await reap();
    expect(chat.status).not.toBe("disposed");
    // With nothing queued it goes, as before.
    chat.setChain([]);
    await reap();
    expect(chat.status).toBe("disposed");
    await manager.shutdown();
  });
});
