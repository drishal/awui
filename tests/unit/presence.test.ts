import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { PresenceTable } from "../../src/server/presence.js";
import { makeTestApp, openSse, signedIn, type TestApp } from "../helpers/app.js";
import type { ChatSnapshot } from "../../src/shared/protocol.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

describe("presence table", () => {
  const report = (p: PresenceTable, clientId: string, chatId: string | null, visible: boolean, focused: boolean, at: number) =>
    p.report(clientId, { chatId, roomId: null }, visible, focused, at);

  it("suppresses a note only for a target a client visibly focuses", () => {
    const p = PresenceTable.inMemory();
    const now = 1_000_000;
    report(p, "tab1", "c1", true, true, now);
    expect(p.viewed({ chatId: "c1" }, now)).toBe(true);
    // A different chat, a room, and no target do not match.
    expect(p.viewed({ chatId: "c2" }, now)).toBe(false);
    expect(p.viewed({ roomId: "c1" }, now)).toBe(false);
    expect(p.viewed({ chatId: null, roomId: null }, now)).toBe(false);
    // Hidden or unfocused: the user is not looking, so the note goes.
    report(p, "tab1", "c1", true, false, now + 1);
    expect(p.viewed({ chatId: "c1" }, now + 1)).toBe(false);
    report(p, "tab1", "c1", false, true, now + 2);
    expect(p.viewed({ chatId: "c1" }, now + 2)).toBe(false);
    // A client that is not looking does not keep another client's suppression away.
    report(p, "tab2", "c1", false, false, now + 3);
    report(p, "tab3", "c1", true, true, now + 4);
    expect(p.viewed({ chatId: "c1" }, now + 4)).toBe(true);
  });

  it("lets an entry expire without a heartbeat", () => {
    const p = PresenceTable.inMemory();
    const now = 2_000_000;
    report(p, "tab1", "c1", true, true, now);
    expect(p.viewed({ chatId: "c1" }, now + 59_999)).toBe(true);
    expect(p.viewed({ chatId: "c1" }, now + 60_000)).toBe(false);
    // A late report brings it back.
    report(p, "tab1", "c1", true, true, now + 90_000);
    expect(p.viewed({ chatId: "c1" }, now + 90_000)).toBe(true);
  });

  it("keeps a client's latest report and stays bounded", () => {
    const p = PresenceTable.inMemory();
    const now = 3_000_000;
    report(p, "tab1", "c1", true, true, now);
    // The same tab switched to another chat: only the newest target counts.
    report(p, "tab1", "c2", true, true, now + 1);
    expect(p.viewed({ chatId: "c1" }, now + 1)).toBe(false);
    expect(p.viewed({ chatId: "c2" }, now + 1)).toBe(true);
    for (let i = 0; i < 250; i++) report(p, `tab${i}`, `c${i}`, true, true, now + 2 + i);
    expect(p.viewed({ chatId: "c249" }, now + 251)).toBe(true);
    // The oldest reports were evicted, not every report.
    expect(p.viewed({ chatId: "c0" }, now + 251)).toBe(false);
  });
});

describe("presence route", () => {
  it("needs auth and a valid body", async () => {
    t = await makeTestApp({ withPassword: true, lanHosts: ["192.168.1.50"] });
    // Other devices sign in; local requests pass without a cookie (security.ts).
    const lan = { Host: `192.168.1.50:${t.port}` };
    expect((await request(t.server).post("/api/presence").set(lan).send({ clientId: "tab1", chatId: "c1", visible: true, focused: true })).status).toBe(401);
    const agent = await signedIn(t);
    expect((await agent.post("/api/presence").send({})).status).toBe(400);
    expect((await agent.post("/api/presence").send({ clientId: "tab1", chatId: "c1", roomId: "r1", visible: true, focused: true })).status).toBe(400);
    expect((await agent.post("/api/presence").send({ clientId: "tab1", chatId: "c1", visible: "yes", focused: true })).status).toBe(400);
    expect((await agent.post("/api/presence").send({ clientId: "tab1", visible: true, focused: false })).status).toBe(200);
  });

  it("skips a chat's note while a client visibly focuses it, and sends once it does not", async () => {
    t = await makeTestApp();
    const app = t;
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(app, chat.chatId, agent.cookie);
    const notes = async () =>
      ((await agent.get("/api/notifications?since=0").expect(200)).body as { notes: Array<{ kind: string; chatId: string; body: string }> }).notes;

    // This tab visibly shows the chat: the finished run is not worth a notification.
    await agent.post("/api/presence").send({ clientId: "tab1", chatId: chat.chatId, visible: true, focused: true }).expect(200);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hello" });
    await sse.waitFor(() => app.manager.get(chat.chatId).status === "running");
    await sse.waitFor(() => app.manager.get(chat.chatId).status === "idle");
    expect(await notes()).toEqual([]);

    // The tab moved to the background: the next finish is announced again.
    await agent.post("/api/presence").send({ clientId: "tab1", chatId: chat.chatId, visible: false, focused: false }).expect(200);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "second" });
    await sse.waitFor(() => app.manager.get(chat.chatId).status === "idle");
    expect(await notes()).toEqual([expect.objectContaining({ kind: "done", chatId: chat.chatId, body: "Echo: second" })]);
    sse.close();
  });
});
