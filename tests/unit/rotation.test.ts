// Free context rotation: the offer's threshold and words, and the route that starts a
// fresh session from a chat's own transcript without touching the old one.
import { afterEach, describe, expect, it } from "vitest";
import type { ChatSnapshot, RotateResult } from "../../src/shared/protocol.js";
import { ROTATION_PERCENT, chatRotation, rotationHint, rotationSupported, rotationText } from "../../src/web/rotation.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function until(check: () => boolean, ms = 10_000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

const caps = { supportsHandoff: true } as ChatSnapshot["capabilities"];

describe("the rotation offer", () => {
  it("comes at four-fifths of the window, and never below it", () => {
    expect(rotationHint({ percent: ROTATION_PERCENT, supported: true, busy: false })).toEqual({ percent: ROTATION_PERCENT, ageMs: null });
    expect(rotationHint({ percent: ROTATION_PERCENT - 1, supported: true, busy: false })).toBeNull();
    expect(rotationHint({ percent: 94.4, supported: true, busy: false })?.percent).toBe(94);
    expect(rotationHint({ percent: null, supported: true, busy: false })).toBeNull();
  });

  it("stays away while a run is going, where the harness cannot seed a session, and after a no", () => {
    expect(rotationHint({ percent: 90, supported: true, busy: true })).toBeNull();
    expect(rotationHint({ percent: 90, supported: false, busy: false })).toBeNull();
    expect(rotationHint({ percent: 90, supported: true, busy: false, off: true })).toBeNull();
  });

  it("reads the chat's own figures", () => {
    const chat = {
      capabilities: caps,
      sessionId: "fake:1",
      context: { tokens: 900, window: 1000, percent: 90 },
      status: "idle" as const,
      items: [{ kind: "user" as const, id: "u", text: "hi", at: 1_000 }],
    };
    expect(chatRotation(chat, { now: 1_500 })).toEqual({ percent: 90, ageMs: 500 });
    expect(chatRotation({ ...chat, sessionId: null })).toBeNull();
    expect(chatRotation({ ...chat, status: "running" })).toBeNull();
    expect(rotationSupported({ capabilities: { ...caps, supportsHandoff: false }, sessionId: "x" })).toBe(false);
  });

  it("says what is kept and what is not", () => {
    const words = rotationText({ percent: 82, ageMs: null });
    expect(words).toContain("82% full");
    expect(words).toContain("word for word");
    expect(words).toContain("no summary");
  });
});

describe("the rotate route", () => {
  it("starts a fresh session seeded from the transcript, and leaves the old chat's session alone", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hello rotation" });
    const original = () => t?.manager.get(chat.chatId).snapshot();
    await until(() => original()?.status === "idle" && original()?.sessionId !== null);
    const before = original() as ChatSnapshot;
    expect(before.items.some((item) => item.kind === "assistant")).toBe(true);

    const rotated = await agent.post(`/api/chats/${chat.chatId}/rotate`).send({});
    expect(rotated.status).toBe(201);
    const fresh = (rotated.body as RotateResult).snapshot;
    expect(fresh.chatId).not.toBe(chat.chatId);
    expect(fresh.sessionId).not.toBe(before.sessionId);
    // The seed carries the conversation over: the prompt and the answer are the fresh chat's own items.
    expect(fresh.items.flatMap((item) => (item.kind === "user" ? [item.text] : []))).toContain("hello rotation");
    expect(fresh.items.some((item) => item.kind === "assistant")).toBe(true);

    // The old chat is untouched: same session, same items.
    const after = original() as ChatSnapshot;
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.items).toHaveLength(before.items.length);
  });

  it("refuses a harness that cannot seed a session, and a chat with nothing to carry", async () => {
    t = await makeTestApp({ fakeBBriefOnly: true });
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const briefOnly = (await agent.post("/api/chats").send({ harnessId: "fake-b", workspaceId: ws.id })).body as ChatSnapshot;
    expect((await agent.post(`/api/chats/${briefOnly.chatId}/rotate`).send({})).body).toMatchObject({ code: "unsupported" });

    const fresh = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    expect((await agent.post(`/api/chats/${fresh.chatId}/rotate`).send({})).body).toMatchObject({ code: "empty_seed" });
  });
});
