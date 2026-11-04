// Resuming from the session file: the chat shows at once, marked Starting,
// while the harness starts behind it.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSubscriber } from "../../src/server/chats/chat.js";
import { ChatManager } from "../../src/server/chats/manager.js";
import { FakeAdapter } from "../../src/server/harness/fake.js";
import { DeferredLiveChat, UNPROMPTED } from "../../src/server/harness/deferred.js";
import { EventHub } from "../../src/server/harness/event-hub.js";
import type { HarnessEventListener, LiveChat } from "../../src/server/harness/types.js";
import type { ChatEvent, ChatStatus } from "../../src/shared/protocol.js";

const ws = { id: "w", path: "/p", name: "p" };
const managers: ChatManager[] = [];
afterEach(async () => {
  for (const m of managers.splice(0)) await m.shutdown();
});

async function until(predicate: () => boolean, ms = 5000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** A stored session with one finished turn, then an adapter that takes `delay` ms to resume it. */
async function storedSession(delay: number) {
  const adapter = new FakeAdapter({ chunkDelayMs: 1, resumeDelayMs: delay });
  const live = await adapter.openChat({ cwd: ws.path });
  let settled = false;
  live.subscribe((e) => {
    if (e.type === "settled") settled = true;
  });
  await live.prompt("remember me");
  await until(() => settled);
  await live.dispose();
  const manager = new ChatManager();
  managers.push(manager);
  return { adapter, manager, nativeId: live.nativeId as string };
}

function statuses(chat: { subscribe(s: ChatSubscriber): () => void }): ChatStatus[] {
  const seen: ChatStatus[] = [];
  chat.subscribe({ send: (_id: number, e: ChatEvent) => void (e.type === "status" && seen.push(e.status)), close: () => undefined });
  return seen;
}

describe("resume from the session file", () => {
  it("shows the transcript at once, Starting, then Idle with the harness's config", async () => {
    const { manager, adapter, nativeId } = await storedSession(300);
    const t0 = Date.now();
    const chat = await manager.resume(adapter, ws, nativeId);
    expect(Date.now() - t0).toBeLessThan(200);
    expect(chat.status).toBe("starting");
    expect(chat.snapshot().items.map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(chat.snapshot().config.model).toBeNull();
    await until(() => chat.status === "idle");
    expect(chat.snapshot().config.model).toBe("fake/echo");
    expect(chat.snapshot().config.models.length).toBeGreaterThan(0);
  });

  it("a prompt sent while starting runs once the harness is up, with no Idle in between", async () => {
    const { manager, adapter, nativeId } = await storedSession(200);
    const chat = await manager.resume(adapter, ws, nativeId);
    const seen = statuses(chat);
    await chat.send("and again", "normal");
    expect(chat.status).toBe("running");
    await until(() => chat.status === "idle" && chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.includes("Echo: and again")));
    expect(seen).toEqual(["running", "idle"]);
  });

  it("replaces a past message in a resumed chat, once the harness is up", async () => {
    const { manager, adapter, nativeId } = await storedSession(50);
    const chat = await manager.resume(adapter, ws, nativeId);
    await until(() => chat.status === "idle");
    await chat.rewind(1, "remember this instead");
    await until(() => chat.status === "idle" && chat.snapshot().items.some((i) => i.kind === "assistant" && i.text.includes("Echo: remember this instead")));
    expect(chat.snapshot().items.flatMap((i) => (i.kind === "user" ? [i.text] : []))).toEqual(["remember this instead"]);
  });

  it("applies a model change made while starting", async () => {
    const { manager, adapter, nativeId } = await storedSession(150);
    const chat = await manager.resume(adapter, ws, nativeId);
    await chat.setConfig({ model: "fake/slow" });
    expect(chat.snapshot().config.model).toBe("fake/slow");
  });

  it("keeps the transcript and shows the error when the harness fails to start", async () => {
    const { manager, adapter, nativeId } = await storedSession(50);
    adapter.openChat = async () => {
      throw new Error("no such binary");
    };
    const chat = await manager.resume(adapter, ws, nativeId);
    await until(() => chat.status === "error");
    const snap = chat.snapshot();
    expect(snap.items.filter((i) => i.kind !== "notice").map((i) => i.kind)).toEqual(["user", "assistant"]);
    expect(snap.items.find((i) => i.kind === "notice")).toMatchObject({ level: "error", text: expect.stringContaining("no such binary") });
  });

  it("marks a backgrounded shell job still running on the file as stopped after a fresh start", async () => {
    // The job's async-result never reached the old server (a restart, say): the file still says running.
    const adapter = new FakeAdapter({ chunkDelayMs: 1, resumeDelayMs: 50 });
    const live = await adapter.openChat({ cwd: ws.path });
    let settled = false;
    live.subscribe((e) => {
      if (e.type === "settled") settled = true;
    });
    await live.prompt("orphanshell");
    await until(() => settled);
    await live.dispose();
    const manager = new ChatManager();
    managers.push(manager);
    const chat = await manager.resume(adapter, ws, live.nativeId as string);
    // Read at once: the deferred view is the transcript. The job is reconciled, not ticking.
    const jobs = chat.snapshot().items.flatMap((i) => (i.kind === "tool" ? (i.jobs ?? []) : []));
    expect(jobs.map((j) => [j.id, j.status])).toEqual([["bg_1", "stopped"]]);
    expect(jobs[0]?.endedAt).toBeTypeOf("number");
    // And once the harness is up the flipped state still holds (nothing re-runs it).
    await until(() => chat.status === "idle");
    const again = chat.snapshot().items.flatMap((i) => (i.kind === "tool" ? (i.jobs ?? []) : []));
    expect(again.map((j) => [j.id, j.status])).toEqual([["bg_1", "stopped"]]);
  });

  it("closes the harness that arrives after its chat was closed", async () => {
    const { manager, adapter, nativeId } = await storedSession(150);
    const open = adapter.openChat.bind(adapter);
    let started: LiveChat | null = null;
    let disposed = false;
    adapter.openChat = async (req) => {
      const live = await open(req);
      const dispose = live.dispose.bind(live);
      live.dispose = async () => {
        disposed = true;
        await dispose();
      };
      started = live;
      return live;
    };
    const chat = await manager.resume(adapter, ws, nativeId);
    await chat.dispose("closed while starting");
    await until(() => started !== null && disposed);
  });
});

describe("a harness that is already running when it comes up", () => {
  it("stays running, not Idle: its own settle ends the run", async () => {
    // A turn an extension started at load (Pi's background-tasks): the start is buffered before anyone subscribes.
    const hub = new EventHub();
    hub.emit({ type: "busy" });
    const real = { nativeId: "n1", subscribe: (l: HarnessEventListener) => hub.subscribe(l), getConfig: async () => ({ model: "fake/echo", thinkingLevel: null, models: [], thinkingLevels: [] }), dispose: async () => undefined } as unknown as LiveChat;
    const chat = new DeferredLiveChat("n1", { items: [], title: null }, async () => real, String);
    const seen: string[] = [];
    const notices: string[] = [];
    chat.subscribe((e) => {
      seen.push(e.type);
      if (e.type === "notice") notices.push(`${e.level}: ${e.text}`);
    });
    await until(() => seen.includes("config"));
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toContain("busy");
    expect(seen).not.toContain("settled");
    // Said once, above the work: nothing here asked for this run.
    expect(notices).toEqual([`warning: ${UNPROMPTED}`]);
    expect(seen.indexOf("notice")).toBeLessThan(seen.indexOf("busy"));
    // The harness's own settle is what ends it.
    hub.emit({ type: "settled" });
    expect(seen.at(-1)).toBe("settled");
  });
});
