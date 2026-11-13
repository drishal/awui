// Actual Chromium against a real stored render page in makeTestApp, not a stub browser:
// owner-token page ids, live-button action state and escaped-link refusal all checked.
import { afterEach, describe, expect, it } from "vitest";
import { saveHtmlRender, isHtmlRenderId } from "../../src/server/html-render.js";
import { makeTestApp, signedIn, type TestApp } from "../helpers/app.js";
import type { ChatSnapshot } from "../../src/shared/protocol.js";

let app: TestApp | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe("bounded per-page browser actions", () => {
  it("operates only the owning chat's saved document, keeping DOM state, and screenshots in the image store", async () => {
    app = await makeTestApp();
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const token = app.manager.get(chat.chatId).render?.token;
    expect(token).toBeTruthy();
    const html = `<!doctype html><style>body{background:var(--bg);color:var(--text)}</style><p id="status">Before</p><label for="tag">Name</label><input id="tag" name="tag"><button id="action" onclick="document.querySelector('#tag').value='value';document.querySelector('#status').textContent='After';">Set</button>`;
    const saved = await saveHtmlRender(app.stateDir, { html, title: "Direct test page", height: 400 });
    expect(saved).not.toBeNull();
    if (!saved) throw new Error("saved page required");
    const ref = { id: saved.id, title: saved.title, height: saved.height };
    const live = await (async () => {
      for (let tryCount = 0; tryCount < 100; tryCount++) {
        const managed = app.manager.peek(chat.chatId);
        if (managed?.sessionId) return managed;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error("live chat was not registered");
    })();
    live.apply({ type: "tool_start", toolCallId: "r-1", name: "render_html", args: { html, title: saved.title, height: saved.height } });
    live.apply({ type: "tool_end", toolCallId: "r-1", output: "published page", isError: false, details: { htmlRender: ref } });
    if (!token) throw new Error("live fake chat doesn't carry its render token");
    const actionUrl = "/api/render/action";
    expect((await agent.post("/api/render/action").set("x-awui-render-token", token ?? "").send({ renderId: "a".repeat(32), action: "snapshot" })).status).toBe(404);
    expect((await agent.post("/api/render/action").set("x-awui-render-token", "bad").send({ renderId: ref.id, action: "snapshot" })).status).toBe(403);

    async function required(args: Record<string, string | number>) {
      return agent.post(actionUrl).set("x-awui-render-token", token ?? "").send(args);
    }
    const before = await required({ renderId: ref.id, action: "snapshot" });
    expect(before.status, JSON.stringify(before.body)).toBe(200);
    expect(before.body.elements).toEqual(expect.arrayContaining([expect.objectContaining({ role: "input", label: "tag" })]));
    const fill = await required({ renderId: ref.id, action: "fill", selector: "#tag", value: "local state version" });
    expect(fill.status).toBe(200);
    const clicked = await required({ renderId: ref.id, action: "click", selector: "#action" });
    expect(clicked.status).toBe(200);
    const snapshot = await required({ renderId: ref.id, action: "snapshot", selector: "#status" });
    expect(snapshot.body.elements[0]?.label).toBe("After");
    const shot = await required({ renderId: ref.id, action: "screenshot" });
    expect(shot.status).toBe(200);
    expect(shot.body.image.url).toMatch(/^\/api\/images\//);
    expect((await agent.get(shot.body.image.url)).status).toBe(200);
    const blocked = await required({ renderId: ref.id, action: "click", selector: "#not-there" });
    expect(blocked.status).toBe(422);
    expect(blocked.body.code).toBe("selector_ambiguous");
    expect((await required({ renderId: ref.id, action: "close" })).body.action).toBe("close");
    // The next open is a fresh context derived from the saved original HTML, not a
    // modified DOM history. This prevents memory-only click state from surviving.
    const afterClose = await required({ renderId: ref.id, action: "snapshot", selector: "#status" });
    expect(afterClose.body.elements[0]?.label).toBe("Before");
  });

  it("rejects an external link before a click, instead of just blocking later resource reads", async () => {
    app = await makeTestApp();
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const token = app.manager.get(chat.chatId).render?.token;
    const html = `<a id="link" href="https://example.invalid/should-not-fetch">Do not navigate</a>`;
    const saved = await saveHtmlRender(app.stateDir, { html, title: "Blocked example.com", height: 200 });
    if (!saved) throw new Error("no saved link");
    const live = await (async () => {
      for (let count = 0; count < 100; count++) {
        const kid = app.manager.peek(chat.chatId);
        if (kid) return kid;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("chat for blocked-link scenario never registered");
    })();
    live.apply({ type: "tool_start", toolCallId: "r-own", name: "render_html", args: { html, title: "Blocked", height: 200 } });
    live.apply({ type: "tool_end", toolCallId: "r-own", output: "visual note", isError: false, details: { htmlRender: saved } });
    if (!token) throw new Error("fixture render token missing");
    const navigate = await agent.post("/api/render/action").set("x-awui-render-token", token ?? "").send({ renderId: saved.id, action: "click", selector: "#link" });
    expect(navigate.status).toBe(422);
    expect(navigate.body.code).toBe("navigation_blocked");

    for (const reqBody of [
      { renderId: saved.id, action: "click", selector: "#link" },
      { renderId: "../forbidden", action: "snapshot" },
      { renderId: saved.id, action: "fill", selector: "#none", value: "some" },
    ]) {
      const result = await agent.post("/api/render/action").set("x-awui-render-token", token ?? "").send(reqBody);
      expect(result.status).not.toBe(200);
    }
  });
});
