// An agent's render_html call publishes a page: the fake harness POSTs it to
// the chat's render endpoint, the reference rides the tool card's details into
// the transcript, and the framed page is served back under the chat that owns
// it. Reopening the chat re-reads the stored reference and re-arms the frame.
import { describe, expect, it, afterEach } from "vitest";
import type { ChatSnapshot } from "../../src/shared/protocol.js";
import { makeTestApp, openSse, signedIn, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup() {
  t = await makeTestApp();
  const agent = await signedIn(t);
  const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
  return { t, agent, ws };
}

describe("agent HTML renders", () => {
  it("stores a render_html page and serves it back to its chat", async () => {
    const { agent, ws } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t as TestApp, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    // The fake answers "render" with a real render_html call through the endpoint.
    const sent = await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "render a report" });
    expect(sent.status).toBe(202);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));

    const snap = (await agent.get(`/api/chats/${chat.chatId}`)).body as ChatSnapshot;
    const tool = snap.items.find((i) => i.kind === "tool" && i.name === "render_html");
    expect(tool && tool.kind === "tool" ? tool.status : null).toBe("done");
    const page = tool && tool.kind === "tool" ? tool.htmlRender : undefined;
    expect(page).toMatchObject({ title: "Fake report", height: 160 });
    expect(page?.id).toMatch(/^[0-9a-f]{32}$/);

    // The owning chat gets the page; the frame's bootstrap was injected.
    const served = await agent.get(`/api/chats/${chat.chatId}/html-render/${page!.id}`);
    expect(served.status).toBe(200);
    expect(served.headers["content-type"]).toMatch(/^text\/html/);
    // Framing from the chat itself only, never from a stranger site.
    expect(served.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
    expect(served.headers["x-frame-options"]?.toUpperCase() ?? "SAMEORIGIN").not.toBe("DENY");
    expect(served.text).toContain("<h1>Fake report</h1>");
    expect(served.text).toContain("awui-html-render-theme");
    sse.close();
  });

  it("publishes a page whose reference arrives only on the device result's text", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t as TestApp, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "xdrender" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));

    // omp's `write xd://render_html` keeps only the tool's text, so the reference is
    // lifted off that text's last line and the card shows the text without it.
    const snap = (await agent.get(`/api/chats/${chat.chatId}`)).body as ChatSnapshot;
    const tool = snap.items.find((i) => i.kind === "tool" && i.name === "write");
    expect(tool && tool.kind === "tool" ? tool.output : null).toBe('Rendered "Fake report" into the chat.');
    const page = tool && tool.kind === "tool" ? tool.htmlRender : undefined;
    expect(page).toMatchObject({ title: "Fake report", height: 160 });
    expect(page?.id).toMatch(/^[0-9a-f]{32}$/);
    // Ownership follows the reference, so the frame and browser_action can reach it.
    expect((await agent.get(`/api/chats/${chat.chatId}/html-render/${page!.id}`)).status).toBe(200);

    // A reload re-reads the transcript and finds the same reference on the result's text.
    const nativeId = chat.sessionId!.split(":")[1] ?? "";
    const history = await t.fake.readTranscript({ cwd: t.project, nativeId });
    const replayed = history?.items.find((i) => i.kind === "tool" && i.name === "write");
    expect(replayed && replayed.kind === "tool" ? replayed.htmlRender?.id : undefined).toBe(page!.id);
    expect(replayed && replayed.kind === "tool" ? replayed.output : null).toBe('Rendered "Fake report" into the chat.');
    sse.close();
  });

  it("rejects a page posted with a token no live chat holds", async () => {
    const { agent } = await setup();
    const res = await agent.post("/api/render").set("x-awui-render-token", "0".repeat(32)).send({ html: "<p>x</p>", title: "x", height: 120 });
    expect(res.status).toBe(403);
  });

  it("does not serve one chat's page to another", async () => {
    const { agent, ws } = await setup();
    const first = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t as TestApp, first.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${first.chatId}/messages`).send({ text: "render" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    const snap = (await agent.get(`/api/chats/${first.chatId}`)).body as ChatSnapshot;
    const page = snap.items.find((i) => i.kind === "tool" && i.htmlRender);
    const id = page && page.kind === "tool" ? page.htmlRender?.id : undefined;
    expect(id).toBeDefined();

    const other = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    expect((await agent.get(`/api/chats/${other.chatId}/html-render/${id}`)).status).toBe(404);
    expect((await agent.get(`/api/chats/${first.chatId}/html-render/${id}`)).status).toBe(200);
    sse.close();
  });

  it("re-arms the frame's reference when the chat's transcript is re-read", async () => {
    const { agent, ws, t } = await setup();
    const first = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t as TestApp, first.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${first.chatId}/messages`).send({ text: "render" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    const found = t.manager
      .get(first.chatId)
      .snapshot()
      .items.find((i) => i.kind === "tool" && i.htmlRender !== undefined);
    const pageId = found && found.kind === "tool" ? found.htmlRender?.id : undefined;
    expect(pageId).toBeDefined();
    sse.close();

    // Re-reading the native session's transcript (what a fresh open does) must
    // carry the same reference, so the frame re-arms from history.
    const nativeId = first.sessionId!.split(":")[1] ?? "";
    const history = await t.fake.readTranscript({ cwd: t.project, nativeId });
    const tool = history?.items.find((i) => i.kind === "tool" && i.name === "render_html");
    expect(tool && tool.kind === "tool" ? tool.htmlRender?.id : undefined).toBe(pageId);

    // And the reopened chat (a new chat id, as after a restart) still serves the page.
    await agent.post(`/api/chats/${first.chatId}/dispose`);
    const reopened = (await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: first.sessionId })).body as ChatSnapshot;
    expect(reopened.chatId).not.toBe(first.chatId);
    const served = await agent.get(`/api/chats/${reopened.chatId}/html-render/${pageId}`);
    expect(served.status).toBe(200);
    expect(served.text).toContain("Fake report");
  });

  it("frames a missing page as a short HTML note, not a JSON error the browser refuses to frame", async () => {
    const { agent, ws } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const res = await agent.get(`/api/chats/${chat.chatId}/html-render/${"a".repeat(32)}`);
    expect(res.status).toBe(404);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'self'");
  });

  it("serves the render page with ONE csp header, so the app can frame it", async () => {
    const { agent, ws } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t as TestApp, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "render" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    const snap = (await agent.get(`/api/chats/${chat.chatId}`)).body as ChatSnapshot;
    const page = snap.items.find((i) => i.kind === "tool" && i.htmlRender);
    const id = page && page.kind === "tool" ? page.htmlRender?.id : undefined;

    const served = await agent.get(`/api/chats/${chat.chatId}/html-render/${id}`);
    expect(served.status).toBe(200);
    // Exactly one CSP: two headers (global helmet 'none' + the route's 'self') make the
    // browser enforce the stricter and permanently block the frame (the clickjacking page).
    // Express's res.headers returns a string or string[]; a doubled header is a string[].
    const csp = served.headers["content-security-policy"];
    expect(Array.isArray(csp) ? csp.length : 1).toBe(1);
    expect(csp).toContain("frame-ancestors 'self'");
    sse.close();
  });
});
