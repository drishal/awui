// C7 hibernation: the reaper parks (disposes) an idle chat that has stayed hidden —
// unviewed and unread — past its bounded clock, and the same native session reopens
// from its transcript: no second writer, no lost work.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatManager } from "../../src/server/chats/manager.js";
import type { ChatSubscriber } from "../../src/server/chats/chat.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";

afterEach(() => {
  vi.useRealTimers();
});

const WORKSPACE = { id: "w", path: "/p", name: "p" };
/** The reaper is private (its cadence is the server's); tests call it directly. */
function asReaper(manager: ChatManager): { reap(): Promise<void> } {
	const reaper = (manager as unknown as { reap?: () => Promise<void> }).reap;
	if (!reaper) throw new Error("no reaper");
	return { reap: reaper.bind(manager) };
}
const viewer: ChatSubscriber = { send: () => undefined, close: () => undefined };
const until = async (check: () => boolean, ms = 5_000): Promise<void> => {
	const { promise, resolve } = Promise.withResolvers<void>();
	const end = Date.now() + ms;
	const tick = (): void => {
		if (check() || Date.now() >= end) resolve();
		else setTimeout(tick, 10);
	};
	tick();
	return promise;
};

describe("hibernation", () => {
	it("parks a hidden idle chat safely, then resumes the same native session with its transcript", async () => {
		const adapter = new FakeAdapter({ chunkDelayMs: 1 });
		const manager = new ChatManager();
		const parkedIds: string[] = [];
		manager.hibernate = { afterMs: 60_000, onParked: (chat) => parkedIds.push(chat.sessionId as string) };
		const { reap } = asReaper(manager);
		const chat = await manager.create(adapter, WORKSPACE);
		await chat.send("hello", "normal");
		await until(() => chat.status === "idle");
		const nativeId = chat.nativeId as string;
		// A live chat is never parked, however long it has been quiet.
		await reap();
		expect(chat.status).toBe("idle");

		// Past the clock with no viewer: parked, its session intact.
		chat.lastSeen = Date.now() - 10 * 60_000;
		await reap();
		expect(chat.status).toBe("disposed");
		expect(adapter.sessions.has(nativeId)).toBe(true);
		expect(parkedIds).toEqual([`${adapter.id}:${nativeId}`]);

		// The same native session reopens, its conversation present read-only.
		const resumed = await manager.resume(adapter, WORKSPACE, nativeId);
		expect(resumed.chatId).not.toBe(chat.chatId);
		expect(resumed.nativeId).toBe(nativeId);
		expect(resumed.userTurns()).toContain("hello");
		// The resumed chat is the only writer: no second one for this session.
		expect(manager.liveChatFor(adapter.id, nativeId)?.chatId).toBe(resumed.chatId);
		await manager.shutdown();
	});

	it("never parks a running chat, one waiting on an answer, or one holding deferred work", async () => {
		const adapter = new FakeAdapter({ chunkDelayMs: 1 });
		const manager = new ChatManager(60 * 60_000);
		manager.hibernate = { afterMs: 60_000 };
		const { reap } = asReaper(manager);

		// Mid-run: no park, no dispose.
		const running = await manager.create(adapter, WORKSPACE);
		await running.send("slow", "normal");
		running.lastSeen = Date.now() - 10 * 60_000;
		await reap();
		expect(running.status).toBe("running");
		await until(() => running.status === "idle");

		// A confirm request waiting: the child that can take the answer is the only place it goes.
		const asking = await manager.create(adapter, WORKSPACE);
		await asking.send("ask", "normal");
		await until(() => asking.pendingCount > 0);
		asking.lastSeen = Date.now() - 10 * 60_000;
		await reap();
		expect(asking.status).toBe("running");

		// A backgrounded shell whose async-result never arrived: the run settles with the job running on the row.
		const deferred = await manager.create(adapter, WORKSPACE);
		await deferred.send("orphanshell", "normal");
		await until(() => deferred.status === "idle" && deferred.hasDeferredWork);
		deferred.lastSeen = Date.now() - 10 * 60_000;
		await reap();
		expect(deferred.status).not.toBe("disposed");
		await manager.shutdown();
	});

	it("does not park a chat a viewer has seen, and parks again only after it goes hidden once more", async () => {
		const adapter = new FakeAdapter({ chunkDelayMs: 1 });
		const manager = new ChatManager();
		manager.hibernate = { afterMs: 60_000 };
		const { reap } = asReaper(manager);
		const chat = await manager.create(adapter, WORKSPACE);
		await chat.send("hello", "normal");
		await until(() => chat.status === "idle");
		// A viewer attached: seen as the finish lands, never parked while attached.
		const leave = chat.subscribe(viewer);
		chat.lastSeen = Date.now() - 10 * 60_000;
		await reap();
		expect(chat.status).toBe("idle");
		leave();
		// Just left, still inside the clock: it stays.
		await reap();
		expect(chat.status).toBe("idle");
		// Hidden past the clock once more: parked.
		chat.lastSeen = Date.now() - 10 * 60_000;
		await reap();
		expect(chat.status).toBe("disposed");
		await manager.shutdown();
	});

	it("does not park twice: the map no longer holds a parked chat, and a racing reopen waits on the same opening", async () => {
		const adapter = new FakeAdapter({ chunkDelayMs: 1, resumeDelayMs: 50 });
		const manager = new ChatManager();
		const parkedIds: string[] = [];
		manager.hibernate = { afterMs: 60_000, onParked: (chat) => parkedIds.push(chat.chatId) };
		const { reap } = asReaper(manager);
		const chat = await manager.create(adapter, WORKSPACE);
		await chat.send("hello", "normal");
		await until(() => chat.status === "idle");
		const nativeId = chat.nativeId as string;
		chat.lastSeen = Date.now() - 10 * 60_000;
		await reap();
		expect(parkedIds).toEqual([chat.chatId]);
		// Park again immediately: the chat is gone from the map, so nothing parks twice.
		await reap();
		expect(parkedIds).toEqual([chat.chatId]);

		// A reopen while another is in flight shares one opening: one chat, one writer.
		const [a, b] = await Promise.all([manager.resume(adapter, WORKSPACE, nativeId), manager.resume(adapter, WORKSPACE, nativeId)]);
		expect(a.chatId).toBe(b.chatId);
		expect(manager.list().filter((c) => c.nativeId === nativeId)).toHaveLength(1);
		await manager.shutdown();
	});

	it("an adapter without readTranscript never parks: no real resume, no park", async () => {
		const adapter = new FakeAdapter({ chunkDelayMs: 1, capabilities: { supportsResumeCommand: false } });
		const bare = adapter as Partial<Pick<FakeAdapter, "readTranscript">>;
		bare.readTranscript = undefined;
		const manager = new ChatManager();
		manager.hibernate = { afterMs: 60_000 };
		const { reap } = asReaper(manager);
		const chat = await manager.create(adapter, WORKSPACE);
		await chat.send("hello", "normal");
		await until(() => chat.status === "idle");
		chat.lastSeen = Date.now() - 10 * 60_000;
		await reap();
		expect(chat.status).toBe("idle");
		await manager.shutdown();
	});
});
