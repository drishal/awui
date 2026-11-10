import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestApp, openSse, signedIn, type TestApp } from "../helpers/app.js";
import { agent as boardAgent, makeBot, makeRoom, openProject, send } from "../helpers/board.js";
import type { ChatSnapshot, OverviewEvent } from "../../src/shared/protocol.js";

let t: TestApp | null = null;
afterEach(async () => { await t?.close(); t = null; });

describe("live overview channel", () => {
  it("publishes native-session work and settled status without any transcript", async () => {
    t = await makeTestApp({ chunkDelayMs: 50 });
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body;
    const created = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    // Establish the subscriber before starting a second turn, not half through it.
    await vi.waitFor(async () => expect((await agent.get(`/api/chats/${created.chatId}`)).body.sessionId).toBeTruthy());
    const stream = openSse(t, "overview", agent.cookie, undefined, "/api/overview/events");
    const sent = await agent.post(`/api/chats/${created.chatId}/messages`).send({ text: "hello" });
    expect(sent.status).toBe(202);
    await expect.poll(() => stream.chatEvents().some((event) => event.type === "session" && event.liveChatId === created.chatId && event.status === "running"), { timeout: 8000 }).toBe(true);
    await expect.poll(() => stream.chatEvents().some((event) => event.type === "session" && event.liveChatId === created.chatId && event.status === "idle"), { timeout: 8000 }).toBe(true);
    const payloads = stream.messages.filter((message) => message.event === "chat").map((message) => message.data as OverviewEvent);
    expect(payloads.every((event) => !("items" in event))).toBe(true);
    stream.close();
  }, 20_000);

  it("publishes a room's summary while nobody has that room open", async () => {
    t = await makeTestApp();
    const a = await boardAgent(t);
    const ws = await openProject(t, a);
    const lead = await makeBot(a, { name: "Atlas", harnessId: "fake", role: "lead" });
    const room = await makeRoom(a, ws.id, [{ botId: lead.id, handle: "atlas" }]);
    const stream = openSse(t, "overview", a.cookie, undefined, "/api/overview/events");
    await send(a, room.room.id, "hello room");
    const rooms = () => stream.messages.map((message) => message.data as OverviewEvent).flatMap((event) => (event?.type === "room" && event.room.id === room.room.id ? [event.room] : []));
    await expect.poll(() => rooms().some((summary) => summary.status === "running"), { timeout: 8000 }).toBe(true);
    await expect.poll(() => rooms().some((summary) => summary.status === "idle" && summary.lastActivityAt !== null), { timeout: 8000 }).toBe(true);
    stream.close();
  }, 20_000);
});
