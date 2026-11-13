// Actual Chromium against a real stored render page in makeTestApp, not a stub browser:
// owner-token page ids, live-button action state and escaped-link refusal all checked, plus
// the one shared browser (a page is a context), its idle close, the theme a page applies when
// the host changes it, and the WebRTC launch flags.
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { saveHtmlRender, isHtmlRenderId } from "../../src/server/html-render.js";
import { previewState, releaseIdleBrowser } from "../../src/server/render-browser.js";
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

/** Whether some process was launched with the WebRTC flags every preview page needs. */
function webrtcClosedAtLaunch(): boolean {
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const command = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      if (command.includes("--force-webrtc-ip-handling-policy=disable_non_proxied_udp") && command.includes("--disable-features=WebRtcHideLocalIpsWithMdns")) return true;
    } catch {
      // A process that exited while this looked: nothing to read, nothing to say.
    }
  }
  return false;
}

describe("the shared preview browser", () => {
  it("serves two pages from one Chromium, closes it when idle, and applies a theme change", async () => {
    app = await makeTestApp();
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const html = `<!doctype html><p id="status">Before</p>`;

    /** One chat with one published page, and the action route's token for it. */
    const publish = async (title: string) => {
      const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
      const saved = await saveHtmlRender(app!.stateDir, { html, title, height: 200 });
      if (!saved) throw new Error("no stored page");
      const live = await (async () => {
        for (let count = 0; count < 100; count++) {
          const managed = app!.manager.peek(chat.chatId);
          if (managed?.sessionId) return managed;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        throw new Error(`chat ${title} was never registered`);
      })();
      live.apply({ type: "tool_start", toolCallId: "r-1", name: "render_html", args: { html, title, height: 200 } });
      live.apply({ type: "tool_end", toolCallId: "r-1", output: "published page", isError: false, details: { htmlRender: saved } });
      const token = app!.manager.get(chat.chatId).render?.token;
      if (!token) throw new Error(`chat ${title} has no render token`);
      const act = (body: Record<string, unknown>) => agent.post("/api/render/action").set("x-awui-render-token", token).send(body);
      return { chatId: chat.chatId, renderId: saved.id, act };
    };

    const first = await publish("First page");
    const second = await publish("Second page");
    expect((await first.act({ renderId: first.renderId, action: "snapshot" })).status).toBe(200);
    expect((await second.act({ renderId: second.renderId, action: "snapshot" })).status).toBe(200);
    // Two live pages, one browser: a page is a context, not a process.
    expect(previewState()).toMatchObject({ browser: true, pages: 2, idle: false });

    // A theme change reaches the page. It is sandboxed (an opaque origin), so the message the
    // host used to post is dispatched on the page's own window; the style element the page's
    // bootstrap owns carries the values it was given.
    const dark = await first.act({ renderId: first.renderId, action: "snapshot", selector: "#awui-html-render-theme", theme: { appearance: "dark", variables: { "--bg": "#111111" } } });
    expect(dark.status, JSON.stringify(dark.body)).toBe(200);
    expect(dark.body.elements[0]?.label).toContain("#111111");
    // A second theme replaces the first: this is the message that used to be dropped.
    const light = await first.act({ renderId: first.renderId, action: "snapshot", selector: "#awui-html-render-theme", theme: { appearance: "light", variables: { "--bg": "#222222" } } });
    expect(light.body.elements[0]?.label).toContain("#222222");
    expect(light.body.elements[0]?.label).not.toContain("#111111");

    // Closing one page closes its context and leaves the other on the same browser.
    expect((await first.act({ renderId: first.renderId, action: "close" })).body.action).toBe("close");
    expect(previewState()).toMatchObject({ browser: true, pages: 1, idle: false });
    expect((await second.act({ renderId: second.renderId, action: "snapshot", selector: "#status" })).body.elements[0]?.label).toBe("Before");

    // The last page closes the browser's window: nothing live, the idle close armed.
    expect((await second.act({ renderId: second.renderId, action: "close" })).body.action).toBe("close");
    expect(previewState()).toMatchObject({ browser: true, pages: 0, idle: true });
    await releaseIdleBrowser();
    expect(previewState()).toMatchObject({ browser: false, pages: 0, idle: false });

    // The next action makes a fresh browser and works as before.
    expect((await first.act({ renderId: first.renderId, action: "snapshot", selector: "#status" })).body.elements[0]?.label).toBe("Before");
    expect(previewState().browser).toBe(true);
    await first.act({ renderId: first.renderId, action: "close" });
    await releaseIdleBrowser();
    expect(previewState()).toMatchObject({ browser: false, pages: 0 });
  }, 60_000);

  it.runIf(process.platform === "linux")("launches Chromium with WebRTC closed off", async () => {
    app = await makeTestApp();
    const agent = await signedIn(app);
    const ws = (await agent.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const saved = await saveHtmlRender(app.stateDir, { html: "<!doctype html><p id=status>ok</p>", title: "RTC", height: 200 });
    if (!saved) throw new Error("no stored page");
    const live = app.manager.get(chat.chatId);
    live.apply({ type: "tool_start", toolCallId: "r-rtc", name: "render_html", args: {} });
    live.apply({ type: "tool_end", toolCallId: "r-rtc", output: "page", isError: false, details: { htmlRender: saved } });
    const token = app.manager.get(chat.chatId).render?.token;
    if (!token) throw new Error("no render token");
    const action = (body: Record<string, unknown>) => agent.post("/api/render/action").set("x-awui-render-token", token).send(body);
    expect((await action({ renderId: saved.id, action: "snapshot" })).status).toBe(200);
    // WebRTC is not an HTTP request, so the route blocker cannot abort it: the browser itself
    // must be launched with the flags that keep a page off STUN and UDP hosts.
    expect(webrtcClosedAtLaunch()).toBe(true);
    await action({ renderId: saved.id, action: "close" });
    await releaseIdleBrowser();
  }, 60_000);
});
