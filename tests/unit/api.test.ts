import { execFileSync } from "node:child_process";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { approvalAnswers } from "../../src/shared/approval.js";
import type { ChatSnapshot, PushNote, SessionsOverview } from "../../src/shared/protocol.js";
import { makeTestApp, openSse, signedIn, tempDir, type TestApp } from "../helpers/app.js";

let t: TestApp | null = null;
afterEach(async () => {
  await t?.close();
  t = null;
});

async function setup(options: Parameters<typeof makeTestApp>[0] = {}) {
  t = await makeTestApp(options);
  const agent = await signedIn(t);
  const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string; path: string };
  return { t, agent, ws };
}

describe("bootstrap and workspaces", () => {
  it("reports the harness registry without paths or secrets", async () => {
    const { agent } = await setup();
    const res = await agent.get("/api/bootstrap");
    expect(res.status).toBe(200);
    expect(res.body.harnesses.map((h: { id: string }) => h.id)).toEqual(["fake", "fake-b"]);
    expect(JSON.stringify(res.body.harnesses)).not.toMatch(/nonexistent/);
  });

  it("names the web build it serves, on the bootstrap and on health", async () => {
    const { agent } = await setup();
    const boot = await agent.get("/api/bootstrap");
    const health = await agent.get("/api/health");
    expect(typeof boot.body.build).toBe("string");
    expect(boot.body.build).not.toBe("");
    // A page compares the two after a deploy: they must be the same string.
    expect(health.body.build).toBe(boot.body.build);
  });

  it("opens workspaces only inside the roots, by realpath", async () => {
    const { agent, t } = await setup();
    const outside = tempDir("awui-outside-");
    expect((await agent.post("/api/workspaces/open").send({ path: outside })).status).toBe(403);
    expect((await agent.post("/api/workspaces/open").send({ path: `${t.project}/../../` })).status).toBe(403);
    symlinkSync(outside, path.join(t.root, "escape"));
    expect((await agent.post("/api/workspaces/open").send({ path: path.join(t.root, "escape") })).status).toBe(403);
    expect((await agent.post("/api/workspaces/open").send({ path: path.join(t.root, "missing") })).status).toBe(404);
  });

  it("allows a blocked .envrc through the workspace route and refuses when there is none", async () => {
    let hasDirenv = true;
    try {
      execFileSync("direnv", ["version"], { stdio: "ignore" });
    } catch {
      hasDirenv = false;
    }
    if (!hasDirenv) return;
    const { agent, t, ws } = await setup();
    // None here: the route says so rather than writing anything.
    expect((await agent.post(`/api/workspaces/${ws.id}/direnv-allow`)).status).toBe(409);
    // A fresh .envrc blocks, the route allows it, and the workspace answer says so.
    writeFileSync(path.join(t.project, ".envrc"), "export AWUI_TEST_ENVRC=route\n");
    const blocked = await agent.post("/api/workspaces/open").send({ path: t.project });
    expect(blocked.body.direnv?.blocked).toBe(true);
    const res = await agent.post(`/api/workspaces/${ws.id}/direnv-allow`);
    expect(res.status).toBe(200);
    expect(res.body.direnv?.blocked).toBe(false);
  });


  it("browses one level of directories and hides symlink escapes", async () => {
    const { agent, t } = await setup();
    mkdirSync(path.join(t.root, ".hidden"));
    symlinkSync(tempDir("awui-out-"), path.join(t.root, "escape"));
    symlinkSync(t.project, path.join(t.root, "inside-link"));
    const roots = await agent.get("/api/workspaces/browse");
    expect(roots.body.path).toBeNull();
    const res = await agent.get(`/api/workspaces/browse?path=${encodeURIComponent(t.root)}`);
    const names = res.body.entries.map((e: { name: string }) => e.name);
    expect(names).toEqual([".hidden", "inside-link", "proj"]);
    expect(res.body.entries[0].hidden).toBe(true);
  });
});

describe("chat lifecycle over HTTP + SSE", () => {
  it("creates a chat, streams a reply, and settles", async () => {
    const { agent, ws, t } = await setup();
    const created = await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id });
    expect(created.status).toBe(201);
    const chat = created.body as ChatSnapshot;
    expect(chat.config).not.toHaveProperty("toolsMode");
    const sse = openSse(t, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    const sent = await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hello tool" });
    expect(sent.status).toBe(202);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    const snap = (await agent.get(`/api/chats/${chat.chatId}`)).body as ChatSnapshot;
    const kinds = snap.items.map((i) => i.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("tool");
    const reply = snap.items.find((i) => i.kind === "assistant" && i.text.startsWith("Echo"));
    expect(reply && reply.kind === "assistant" && reply.thinking).toBeTruthy();
    expect(snap.items.find((i) => i.kind === "tool")).toMatchObject({
      status: "done",
      name: "read",
      category: "read",
      summary: "README.md",
      paths: ["README.md"],
    });
    const user = snap.items.find((i) => i.kind === "user");
    expect(user?.at).toBeGreaterThan(0);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "context"));
    expect(t.manager.get(chat.chatId).snapshot().context?.tokens).toBeGreaterThan(0);
    expect(t.manager.get(chat.chatId).snapshot().context?.categories?.map((c) => c.label)).toEqual(["System prompt", "Tool definitions", "Messages"]);
    // Session tokens come from the harness; timing is measured from the stream.
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "usage"));
    const usage = t.manager.get(chat.chatId).snapshot().usage;
    expect(usage).toMatchObject({ turns: 1, steps: 2 });
    expect(usage?.llmMs).toBeGreaterThan(0);
    expect(usage?.ttftMs).not.toBeNull();
    expect(usage?.tokensPerSecond).toBeGreaterThan(0);
    // Monotonic event ids.
    const ids = sse.messages.filter((m) => m.id !== undefined).map((m) => m.id as number);
    expect([...ids].sort((a, b) => a - b)).toEqual(ids);
    sse.close();
  });

  it("forks a chat through a turn into a new session", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "first question" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "second question" });
    await sse.waitFor(() => sse.chatEvents().filter((e) => e.type === "status" && e.status === "idle").length >= 2);

    const forked = await agent.post(`/api/chats/${chat.chatId}/fork`).send({ through: 1 });
    expect(forked.status).toBe(201);
    const copy = forked.body as ChatSnapshot;
    expect(copy.chatId).not.toBe(chat.chatId);
    expect(copy.sessionId).not.toBe(chat.sessionId);
    expect(copy.items.filter((i) => i.kind === "user").map((i) => (i.kind === "user" ? i.text : ""))).toEqual(["first question"]);
    // The source keeps both turns; the copy is its own session.
    const source = (await agent.get(`/api/chats/${chat.chatId}`)).body as ChatSnapshot;
    expect(source.items.filter((i) => i.kind === "user")).toHaveLength(2);
    // A fork needs a live session to copy.
    expect((await agent.post("/api/chats/resume-nonexistent/fork").send({ through: 1 })).status).toBe(404);
    sse.close();
  });

  it("hands a chat off to another harness with transcript and draft", async () => {
    const { agent, ws } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t as TestApp, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "first tool question" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    const moved = await agent.post(`/api/chats/${chat.chatId}/handoff`).send({ harness: "fake-b", prompt: "continue there" });
    expect(moved.status).toBe(201);
    const copy = moved.body as ChatSnapshot;
    expect(copy.chatId).not.toBe(chat.chatId);
    expect(copy.harnessId).toBe("fake-b");
    // The transcript is recorded; the draft then runs as the target's first real turn.
    const target = (t as TestApp).manager.get(copy.chatId);
    await sse.waitFor(() => target.status === "idle" && target.snapshot().items.some((i) => i.kind === "assistant" && i.text.startsWith("Echo: continue there")));
    expect(target.snapshot().items.map((i) => i.kind)).toEqual(["user", "tool", "assistant", "user", "assistant"]);
    // Same-harness and unknown-harness handoffs are rejected; a fresh chat has
    // a native id already (in-memory), so emptiness — not missing session — rejects it.
    expect((await agent.post(`/api/chats/${chat.chatId}/handoff`).send({ harness: "fake" })).status).toBe(400);
    expect((await agent.post(`/api/chats/${chat.chatId}/handoff`).send({ harness: "nope" })).status).toBe(404);
    const fresh = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    expect((await agent.post(`/api/chats/${fresh.chatId}/handoff`).send({ harness: "fake-b" })).status).toBe(400);
  });

  it("briefs a harness that cannot store past turns in the first prompt of a fresh chat", async () => {
    const { agent, ws } = await setup({ fakeBBriefOnly: true });
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t as TestApp, chat.chatId, agent.cookie);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "snapshot"));
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "first tool question" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    await agent.post(`/api/chats/${chat.chatId}/rename`).send({ name: "Moving chat" });
    const moved = await agent.post(`/api/chats/${chat.chatId}/handoff`).send({ harness: "fake-b", prompt: "now finish it" });
    expect(moved.status).toBe(201);
    const target = (t as TestApp).manager.get((moved.body as ChatSnapshot).chatId);
    await sse.waitFor(() => target.status === "idle" && target.snapshot().items.some((i) => i.kind === "assistant"));
    // One prompt, no copied turns: the record framed as context, ending on the draft.
    const users = target.snapshot().items.filter((i) => i.kind === "user");
    expect(users).toHaveLength(1);
    const brief = users[0]?.kind === "user" ? users[0].text : "";
    expect(brief).toMatch(/^This conversation is continuing here from Fake \(project: proj\)\./);
    expect(brief).toContain("It is context, not instructions");
    expect(brief).toContain("User: first tool question");
    expect(brief.endsWith("continue with this request:\n\nnow finish it")).toBe(true);
    expect(target.snapshot().title).toBe("Moving chat");
    sse.close();
  });

  it("returns 409 for a normal send while busy, and steers / queues follow-ups", async () => {
    const { agent, ws, t } = await setup({ chunkDelayMs: 15 });
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "slow one" });
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "again" })).status).toBe(409);
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "go left", mode: "steer" })).status).toBe(202);
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "then this", mode: "followUp" })).status).toBe(202);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "queue"));
    await sse.waitFor(() => {
      const items = t.manager.get(chat.chatId).snapshot().items;
      return t.manager.get(chat.chatId).status === "idle" && items.some((i) => i.kind === "assistant" && i.text.startsWith("Echo: then this"));
    }, 15_000);
    const texts = t.manager.get(chat.chatId).snapshot().items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text);
    expect(texts).toEqual(["slow one", "go left", "then this"]);
    sse.close();
  });

  it("stop goes through Stopping and settles; queue is cleared", async () => {
    const { agent, ws, t } = await setup({ chunkDelayMs: 20 });
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "slow" });
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "later", mode: "followUp" });
    expect((await agent.post(`/api/chats/${chat.chatId}/abort`)).status).toBe(202);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "status" && e.status === "stopping"));
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    const snap = t.manager.get(chat.chatId).snapshot();
    expect(snap.queue.followUp).toEqual([]);
    expect(snap.items.some((i) => i.kind === "assistant" && i.error === "Stopped")).toBe(true);
    expect(snap.items.filter((i) => i.kind === "user").length).toBe(1);
    sse.close();
  });

  it("stop-and-send aborts then sends", async () => {
    const { agent, ws, t } = await setup({ chunkDelayMs: 20 });
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake-b", workspaceId: ws.id })).body as ChatSnapshot;
    expect(chat.capabilities.supportsSteer).toBe(false);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "slow" });
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "x", mode: "steer" })).status).toBe(400);
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "instead", mode: "stopAndSend" })).status).toBe(202);
    const sse = openSse(t, chat.chatId, agent.cookie);
    await sse.waitFor(() => {
      const c = t.manager.get(chat.chatId);
      return c.status === "idle" && c.snapshot().items.some((i) => i.kind === "assistant" && i.text.startsWith("Echo: instead"));
    });
    sse.close();
  });

  it("replays from lastEventId without duplicates, and resnapshots when too old", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const first = openSse(t, chat.chatId, agent.cookie);
    await first.waitFor(() => first.chatEvents().length > 0);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "one" });
    await first.waitFor(() => first.chatEvents().filter((e) => e.type === "item").length >= 2);
    const cut = first.lastId() as number;
    first.close();
    await new Promise<void>((resolve) => {
      const check = () => (t?.manager.get(chat.chatId).status === "idle" ? resolve() : setTimeout(check, 10));
      check();
    });
    const second = openSse(t, chat.chatId, agent.cookie, cut);
    await second.waitFor(() => second.chatEvents().some((e) => e.type === "status" && e.status === "idle"));
    expect(second.chatEvents().some((e) => e.type === "snapshot")).toBe(false);
    const replayedIds = second.messages.filter((m) => m.id !== undefined).map((m) => m.id as number);
    expect(Math.min(...replayedIds)).toBe(cut + 1);
    second.close();
    const stale = openSse(t, chat.chatId, agent.cookie, 999_999);
    await stale.waitFor(() => stale.chatEvents().some((e) => e.type === "snapshot"));
    stale.close();
  });

  it("resumes an existing live session instead of opening a second writer", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "persist me" });
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    sse.close();
    const list = await agent.get(`/api/harnesses/fake/sessions?workspaceId=${ws.id}`);
    expect(list.body.sessions).toHaveLength(1);
    const session = list.body.sessions[0];
    expect(session.id).toBe(`fake:${t.fake.sessions.keys().next().value}`);
    expect(session.liveChatId).toBe(chat.chatId);
    const resumed = await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: session.id });
    expect(resumed.body.chatId).toBe(chat.chatId);
    // After closing the live chat, resume opens a fresh instance rebuilt from history.
    await agent.post(`/api/chats/${chat.chatId}/dispose`);
    const reopened = (await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: session.id }))
      .body as ChatSnapshot;
    expect(reopened.chatId).not.toBe(chat.chatId);
    expect(reopened.items.filter((i) => i.kind === "user").map((i) => (i as { text: string }).text)).toEqual(["persist me"]);
    expect(reopened.items.filter((i) => i.kind === "assistant").map((i) => (i as { text: string; error?: string }).error ?? "ok")).toEqual(["ok"]);
    expect((await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: "fake-b:x" })).status).toBe(400);
    expect((await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: "fake:unknown" })).status).toBe(404);
  });

  it("lists a harness's models for a folder before any chat exists", async () => {
    const { agent, ws } = await setup();
    const res = await agent.get(`/api/harnesses/fake/models?workspaceId=${ws.id}`);
    expect(res.status).toBe(200);
    expect(res.body.models.map((m: { key: string }) => m.key)).toContain("fake/slow");
    expect((await agent.get("/api/harnesses/fake/models?workspaceId=missing")).status).toBe(404);
    expect((await agent.get("/api/harnesses/missing/models?workspaceId=" + ws.id)).status).toBe(404);
  });

  it("starts a chat on the model picked on the start screen", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id, model: "fake/slow" })).body as ChatSnapshot;
    expect(chat.config.model).toBe("fake/slow");
    // A model the harness refuses leaves no half-made chat behind.
    const refused = await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id, model: "nope/nope" });
    expect(refused.status).toBe(422);
    expect(t.manager.list().filter((c) => c.status !== "disposed")).toHaveLength(1);
  });

  it("round-trips an approval request; first answer wins, late answers get 409", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "please ask first" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "request"));
    const request = (sse.chatEvents().find((e) => e.type === "request") as unknown as { request: { id: string } }).request;
    // A reconnecting device sees the pending request in its snapshot.
    const other = openSse(t, chat.chatId, agent.cookie);
    await other.waitFor(() => other.chatEvents().some((e) => e.type === "snapshot"));
    const snap = (other.chatEvents()[0] as unknown as { snapshot: ChatSnapshot }).snapshot;
    expect(snap.pending.map((p) => p.id)).toEqual([request.id]);
    const ok = await agent.post(`/api/chats/${chat.chatId}/requests/${request.id}`).send({ answer: { kind: "confirm", confirmed: true } });
    expect(ok.status).toBe(200);
    expect(ok.body.outcome).toBe("Approved");
    const late = await agent.post(`/api/chats/${chat.chatId}/requests/${request.id}`).send({ answer: { kind: "confirm", confirmed: false } });
    expect(late.status).toBe(409);
    await other.waitFor(() => other.chatEvents().some((e) => e.type === "request_resolved"));
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    expect(t.manager.get(chat.chatId).snapshot().items.some((i) => i.kind === "tool")).toBe(true);
    sse.close();
    other.close();
  });

  it("abort cancels a pending request", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "ask now" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "request"));
    await agent.post(`/api/chats/${chat.chatId}/abort`);
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "request_resolved"));
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    expect(t.manager.get(chat.chatId).snapshot().pending).toEqual([]);
    sse.close();
  });

  it("changes config only while idle and validates values", async () => {
    const { agent, ws } = await setup({ chunkDelayMs: 20 });
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const ok = await agent.patch(`/api/chats/${chat.chatId}/config`).send({ model: "fake/slow", thinkingLevel: "high" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ model: "fake/slow", thinkingLevel: "high" });
    // There is no tool-narrowing mode to switch to.
    expect((await agent.patch(`/api/chats/${chat.chatId}/config`).send({ toolsMode: "readOnly" })).status).toBe(400);
    expect((await agent.patch(`/api/chats/${chat.chatId}/config`).send({ model: "nope/x" })).status).toBe(422);
    expect((await agent.patch(`/api/chats/${chat.chatId}/config`).send({})).status).toBe(400);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "slow" });
    expect((await agent.patch(`/api/chats/${chat.chatId}/config`).send({ thinkingLevel: "off" })).status).toBe(409);
  });

  it("changes the permission mode mid-run, on a harness that has modes", async () => {
    const { t, agent, ws } = await setup({ chunkDelayMs: 20 });
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    expect(chat.config.permissionMode).toBe("default");
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "slow" });
    expect(t.manager.get(chat.chatId).status).toBe("running");
    const res = await agent.patch(`/api/chats/${chat.chatId}/config`).send({ permissionMode: "acceptEdits" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ permissionMode: "acceptEdits" });
    expect((await agent.patch(`/api/chats/${chat.chatId}/config`).send({ permissionMode: "nope" })).status).toBe(422);
    const other = (await agent.post("/api/chats").send({ harnessId: "fake-b", workspaceId: ws.id })).body as ChatSnapshot;
    expect(other.config.permissionModes).toBeUndefined();
    expect((await agent.patch(`/api/chats/${other.chatId}/config`).send({ permissionMode: "default" })).status).toBe(400);
  });

  it("lists the chat harness's / commands", async () => {
    const { agent, ws } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const res = await agent.get(`/api/chats/${chat.chatId}/commands`).expect(200);
    expect(res.body.commands.map((c: { name: string }) => c.name)).toEqual(["fake-status", "skill:review"]);
  });

  it("refresh reports models discovered after the cache drop", async () => {
    const { agent, ws } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    expect(chat.config.models.map((m) => m.key)).not.toContain("fake/fresh");
    const refreshed = await agent.post(`/api/chats/${chat.chatId}/models/refresh`).send({});
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.models.map((m: { key: string }) => m.key)).toContain("fake/fresh");
    expect(refreshed.body.model).toBe(chat.config.model);
  });

  it("bounds oversized tool output", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "big output" });
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    const tool = t.manager.get(chat.chatId).snapshot().items.find((i) => i.kind === "tool");
    expect(tool && tool.kind === "tool" && tool.truncated).toBe(true);
    expect(tool && tool.kind === "tool" && tool.output.length).toBeLessThan(17_000);
    const largest = Math.max(...sse.messages.map((m) => JSON.stringify(m.data).length));
    expect(largest).toBeLessThan(64_000);
    sse.close();
  });

  it("rejects oversized and malformed bodies", async () => {
    const { agent, ws } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "" })).status).toBe(400);
    expect((await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "x".repeat(100_001) })).status).toBe(400);
    expect((await agent.post("/api/chats").send({ harnessId: "nope", workspaceId: ws.id })).status).toBe(404);
    expect((await agent.get("/api/chats/does-not-exist")).status).toBe(404);
  });

  it("sends pasted images with the prompt, and refuses fakes, extras, and image-only messages", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const url = `/api/chats/${chat.chatId}/messages`;
    // A ~1 MB PNG: well past the 455 kB limit every other body keeps.
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(1024 * 1024)]).toString("base64");
    const image = { mimeType: "image/png", data: png };

    expect((await agent.post(url).send({ text: "what is this?", images: [{ ...image, mimeType: "image/jpeg" }] })).body.code).toBe("bad_image");
    expect((await agent.post(url).send({ text: "", images: [image] })).status).toBe(400);
    expect((await agent.post(url).send({ text: "too many", images: Array(9).fill(image) })).status).toBe(400);
    expect((await agent.post(url).send({ text: "svg", images: [{ mimeType: "image/svg+xml", data: png }] })).status).toBe(400);

    const sse = openSse(t, chat.chatId, agent.cookie);
    expect((await agent.post(url).send({ text: "what is this?", images: [image, image] })).status).toBe(202);
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    const user = (await agent.get(`/api/chats/${chat.chatId}`)).body.items.find((i: { kind: string }) => i.kind === "user");
    expect(user).toMatchObject({ text: "what is this?", imageCount: 2 });
    sse.close();
  });

  it("never returns filesystem paths for sessions", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hi" });
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    const list = await agent.get(`/api/harnesses/fake/sessions?workspaceId=${ws.id}`);
    expect(JSON.stringify(list.body)).not.toMatch(/nonexistent|\.jsonl/);
    sse.close();
  });
});

describe("sessions across projects", () => {
  it("lists every project's recent sessions, newest first, and leaves out folders outside the roots", async () => {
    const { agent, t } = await setup();
    const other = path.join(t.root, "other");
    mkdirSync(other);
    const outside = tempDir("awui-outside-");
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
    for (const [nativeId, cwd, title, age] of [
      ["a1", t.project, "Fix the build", 5],
      ["b1", other, "Write docs", 1],
      ["x1", outside, "Somewhere else", 0],
      ["gone", path.join(t.root, "deleted"), "Removed project", 2],
    ] as const) {
      t.fake.sessions.set(nativeId, { nativeId, cwd, title, messages: [{}], updatedAt: minutesAgo(age) });
    }

    const body = (await agent.get("/api/sessions").expect(200)).body as SessionsOverview;
    expect(body.errors).toEqual([]);
    const project = (id: string) => body.workspaces.find((w) => w.id === id)?.name;
    expect(body.sessions.map((s) => [s.title, project(s.workspaceId)])).toEqual([
      ["Write docs", "other"],
      ["Fix the build", "proj"],
    ]);
    expect(JSON.stringify(body)).not.toContain(outside);

    // The current project is listed even before it has sessions.
    const empty = path.join(t.root, "empty");
    mkdirSync(empty);
    const current = (await agent.get(`/api/sessions?path=${encodeURIComponent(empty)}`).expect(200)).body as SessionsOverview;
    expect(current.workspaces.map((w) => w.name)).toContain("empty");
  });

  it("pins and archives sessions, one mark at a time", async () => {
    const { agent, t } = await setup();
    t.fake.sessions.set("a1", { nativeId: "a1", cwd: t.project, title: "Fix the build", messages: [{}], updatedAt: new Date() });
    const marks = async () => ((await agent.get("/api/sessions").expect(200)).body as SessionsOverview).sessions.map((s) => [s.id, s.pinned, s.archived]);

    expect((await agent.post("/api/sessions/marks").send({ sessionId: "fake:a1", pinned: true }).expect(200)).body).toEqual({ pinned: true });
    expect(await marks()).toEqual([["fake:a1", true, undefined]]);
    // Archiving unpins: a session lives in one place in the list.
    expect((await agent.post("/api/sessions/marks").send({ sessionId: "fake:a1", archived: true }).expect(200)).body).toEqual({ archived: true });
    expect(await marks()).toEqual([["fake:a1", undefined, true]]);
    expect((await agent.post("/api/sessions/marks").send({ sessionId: "fake:a1", archived: false }).expect(200)).body).toEqual({});
    expect(await marks()).toEqual([["fake:a1", undefined, undefined]]);
    await agent.post("/api/sessions/marks").send({ sessionId: "fake:a1" }).expect(400);
  });

  it("applies one mark to a selection, and puts the whole selection back", async () => {
    const { agent, t } = await setup();
    for (const [id, title] of [["a1", "Fix the build"], ["a2", "Ship it"]] as Array<[string, string]>) {
      t.fake.sessions.set(id, { nativeId: id, cwd: t.project, title, messages: [{}], updatedAt: new Date() });
    }
    const marks = async () => ((await agent.get("/api/sessions").expect(200)).body as SessionsOverview).sessions.map((s) => [s.id, s.pinned, s.archived]).sort();
    const bulk = (change: object) => agent.post("/api/sessions/marks/bulk").send({ ids: ["fake:a1", "fake:a2"], ...change });

    expect((await bulk({ archived: true }).expect(200)).body.marks).toEqual({ "fake:a1": { archived: true }, "fake:a2": { archived: true } });
    expect(await marks()).toEqual([["fake:a1", undefined, true], ["fake:a2", undefined, true]]);
    // Putting a selection back is one call with replace, as one row's undo is.
    await bulk({ replace: true }).expect(200);
    expect(await marks()).toEqual([["fake:a1", undefined, undefined], ["fake:a2", undefined, undefined]]);
    // Unread sits beside a place: marking it read leaves the archive alone.
    await bulk({ archived: true, unread: true }).expect(200);
    expect(((await agent.get("/api/sessions").expect(200)).body as SessionsOverview).sessions.every((s) => s.unread === true && s.archived === true)).toBe(true);
    await bulk({ unread: false }).expect(200);
    expect(((await agent.get("/api/sessions").expect(200)).body as SessionsOverview).sessions.every((s) => s.unread === undefined && s.archived === true)).toBe(true);
    await bulk({ replace: true }).expect(200);
    await bulk({}).expect(400);
    await agent.post("/api/sessions/marks/bulk").send({ ids: [], settled: true }).expect(400);
    await agent.post("/api/sessions/marks/bulk").send({ ids: Array.from({ length: 501 }, (_, i) => `fake:${i}`), settled: true }).expect(400);
  });

  it("restarts a chat on the same session, under a new chat id", async () => {
    const { agent, t, ws } = await setup();
    t.fake.sessions.set("r1", { nativeId: "r1", cwd: t.project, title: "Restart me", messages: [{}], updatedAt: new Date() });
    const before = (await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: "fake:r1" }).expect(200)).body as ChatSnapshot;

    const after = (await agent.post(`/api/chats/${before.chatId}/restart`).expect(200)).body as ChatSnapshot;
    expect(after.chatId).not.toBe(before.chatId);
    expect(after.sessionId).toBe(before.sessionId);
    expect(after.status).toBe("idle");
    // The old chat is gone: the caller follows the new id.
    await agent.get(`/api/chats/${before.chatId}`).expect(404);

    // Restarting waits for the run: a live harness is not torn down under it.
    await agent.post(`/api/chats/${after.chatId}/messages`).send({ text: "slow first run" });
    expect((await agent.post(`/api/chats/${after.chatId}/restart`)).status).toBe(409);
  });

  it("keeps a hand-made order per project and harness, bounded", async () => {
    const { agent, ws } = await setup();
    const saved = await agent.post("/api/sessions/order").send({ harnessId: "fake", workspaceId: ws.id, ids: ["fake:b", "fake:a", "fake:b"] }).expect(200);
    expect(saved.body).toEqual({ ids: ["fake:b", "fake:a"] });
    const body = (await agent.get("/api/sessions").expect(200)).body as SessionsOverview;
    expect(body.orders).toEqual({ [`fake:${ws.id}`]: ["fake:b", "fake:a"] });
    await agent.post("/api/sessions/order").send({ harnessId: "fake", workspaceId: ws.id, ids: "fake:a" }).expect(400);
    await agent.post("/api/sessions/order").send({ harnessId: "fake", workspaceId: ws.id, ids: Array.from({ length: 501 }, (_, i) => `fake:${i}`) }).expect(400);
  });

  it("says which repository and branch each git project is on, a worktree included", async () => {
    const { agent, t } = await setup();
    const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });
    run(t.project, "init", "-b", "main");
    run(t.project, "commit", "--allow-empty", "-m", "start");
    const worktree = path.join(t.root, "proj-feat");
    run(t.project, "worktree", "add", "-b", "feat", worktree);
    const plain = path.join(t.root, "plain");
    mkdirSync(plain);
    for (const [nativeId, cwd] of [["m", t.project], ["f", worktree], ["p", plain]] as const) t.fake.sessions.set(nativeId, { nativeId, cwd, title: nativeId, messages: [{}], updatedAt: new Date() });
    const body = (await agent.get("/api/sessions").expect(200)).body as SessionsOverview;
    const byName = Object.fromEntries(body.workspaces.map((w) => [w.name, body.checkouts?.[w.id]]));
    expect(byName.proj).toMatchObject({ branch: "main", primary: true });
    expect(byName["proj-feat"]).toMatchObject({ branch: "feat", primary: false, repo: byName.proj?.repo });
    expect(byName.plain).toBeUndefined();
  });

  it("keeps an old session's place when it is only opened, and lifts it once someone talks in it", async () => {
    const { agent, ws, t } = await setup();
    const old = new Date(Date.now() - 3 * 86_400_000);
    t.fake.sessions.set("o1", { nativeId: "o1", cwd: t.project, title: "Old one", messages: [{}], updatedAt: old });
    const updated = async () => ((await agent.get("/api/sessions").expect(200)).body as SessionsOverview).sessions.find((s) => s.id === "fake:o1")?.updatedAt;
    const chat = (await agent.post("/api/chats/resume").send({ harnessId: "fake", workspaceId: ws.id, sessionId: "fake:o1" }).expect(200)).body as ChatSnapshot;
    expect(await updated()).toBe(old.toISOString());
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "back again" });
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle" && t.manager.get(chat.chatId).talkedAt !== null);
    sse.close();
    expect(Date.parse((await updated()) ?? "")).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe("inbox marks", () => {
  it("wakes a settled session when a run starts in it, and flags a chat waiting on an answer", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hello" }).expect(202);
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle" && t.manager.get(chat.chatId).sessionId !== null);
    const sessionId = t.manager.get(chat.chatId).sessionId as string;
    const mine = async () => ((await agent.get("/api/sessions").expect(200)).body as SessionsOverview).sessions.find((x) => x.id === sessionId);
    await agent.post("/api/sessions/marks").send({ sessionId, settled: true }).expect(200);
    expect(await mine()).toMatchObject({ settled: true });
    await agent.post("/api/sessions/marks").send({ sessionId, snoozedUntil: Date.now() - 1000 }).expect(400);

    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "please ask first" }).expect(202);
    await sse.waitFor(() => t.manager.get(chat.chatId).snapshot().pending.length > 0);
    const asking = await mine();
    expect(asking?.settled).toBeUndefined();
    expect(asking?.asking).toBe(true);
    await agent.post(`/api/chats/${chat.chatId}/abort`);
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    expect((await mine())?.asking).toBeUndefined();
    sse.close();
  });
});

describe("compact before send", () => {
  it("compacts first, then runs the message", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "bloat the context" }).expect(202);
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle" && (t.manager.get(chat.chatId).snapshot().context?.percent ?? 0) > 60);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "after compaction", compactFirst: true }).expect(202);
    await sse.waitFor(() => t.manager.get(chat.chatId).snapshot().items.some((i) => i.kind === "assistant" && i.text.includes("Echo: after compaction")));
    const statuses = sse.chatEvents().flatMap((e) => (e.type === "status" ? [e.status] : []));
    expect(statuses).toContain("compacting");
    expect(statuses.lastIndexOf("compacting")).toBeLessThan(statuses.lastIndexOf("running"));
    sse.close();
  });
});

describe("rewind", () => {
  it("replaces a past prompt and what followed in the same session, and refuses where the harness cannot", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    const settled = async () => sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    for (const text of ["first", "second", "third"]) {
      await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text }).expect(202);
      await sse.waitFor(() => t.manager.get(chat.chatId).status === "running");
      await settled();
    }
    const sessionId = t.manager.get(chat.chatId).sessionId;
    await agent.post(`/api/chats/${chat.chatId}/rewind`).send({ turn: 2, text: "second, again" }).expect(202);
    await settled();
    const texts = (items: ChatSnapshot["items"]) => items.flatMap((i) => (i.kind === "user" ? [i.text] : i.kind === "assistant" && i.text ? [i.text.split("\n")[0]] : []));
    const live = t.manager.get(chat.chatId).snapshot();
    expect(texts(live.items)).toEqual(["first", "Echo: first", "second, again", "Echo: second, again"]);
    expect(live.sessionId).toBe(sessionId);
    // Viewers got the cut as a fresh snapshot, and the harness's own session agrees.
    expect(sse.chatEvents().filter((e) => e.type === "snapshot").length).toBeGreaterThanOrEqual(2);
    const stored = t.fake.sessions.get(String(sessionId).replace(/^fake:/, ""));
    expect(stored?.messages.filter((m) => (m as { role?: string }).role === "user").length).toBe(2);
    await agent.post(`/api/chats/${chat.chatId}/rewind`).send({ turn: 9, text: "x" }).expect(400);

    const other = (await agent.post("/api/chats").send({ harnessId: "fake-b", workspaceId: ws.id })).body as ChatSnapshot;
    expect(other.capabilities.supportsRewind).toBe(false);
    await agent.post(`/api/chats/${other.chatId}/rewind`).send({ turn: 1, text: "x" }).expect(400);
    sse.close();
  });
});

describe("notifications", () => {
  it("notes a finished run and a question for an answer, but not a run stopped from here", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    const notes = async () => ((await agent.get("/api/notifications?since=0").expect(200)).body as { notes: Array<{ kind: string; chatId: string; body: string }> }).notes;

    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "hello" });
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "running");
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    expect(await notes()).toEqual([expect.objectContaining({ kind: "done", chatId: chat.chatId, body: "Echo: hello" })]);

    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "please ask first" });
    await sse.waitFor(() => t.manager.get(chat.chatId).snapshot().pending.length > 0);
    expect((await notes()).map((n) => n.kind)).toEqual(["done", "ask"]);
    await agent.post(`/api/chats/${chat.chatId}/abort`);
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    expect((await notes()).map((n) => n.kind)).toEqual(["done", "ask"]);

    // Subscriptions only to a browser push service.
    await agent.post("/api/push/subscribe").send({ endpoint: "https://example.com/push" }).expect(422);
    expect((await agent.get("/api/push/key").expect(200)).body.key).toMatch(/^[\w-]{87}$/);
    sse.close();
  });
});

describe("approving from a notification", () => {
  it("puts an approval's two answers on its note, and the note's Approve answers the request", async () => {
    const { agent, ws, t } = await setup();
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "please ask first" });
    await sse.waitFor(() => t.manager.get(chat.chatId).snapshot().pending.length > 0);
    const request = t.manager.get(chat.chatId).snapshot().pending[0];
    const notes = (await agent.get("/api/notifications?since=0").expect(200)).body.notes as PushNote[];
    const ask = notes.find((n) => n.kind === "ask");
    expect(ask?.approval).toEqual({ requestId: request?.id, approve: { kind: "confirm", confirmed: true }, deny: { kind: "confirm", confirmed: false } });
    // What the service worker posts when the notification's Approve is pressed.
    await agent.post(`/api/chats/${chat.chatId}/requests/${ask?.approval?.requestId}`).send({ answer: ask?.approval?.approve }).expect(200);
    await sse.waitFor(() => t.manager.get(chat.chatId).status === "idle");
    // Pressed again (another device got there first): the worker reads a 409 as "Already answered".
    expect((await agent.post(`/api/chats/${chat.chatId}/requests/${ask?.approval?.requestId}`).send({ answer: ask?.approval?.approve })).status).toBe(409);
    sse.close();
  });

  it("knows an approval from a question", () => {
    const base = { id: "r", title: "t", createdAt: 0 };
    expect(approvalAnswers({ ...base, kind: "select", options: ["Approve", "Deny"] })?.approve).toEqual({ kind: "select", value: "Approve" });
    expect(approvalAnswers({ ...base, kind: "select", options: ["A", "B", "C"] })).toBeNull();
    expect(approvalAnswers({ ...base, kind: "input" })).toBeNull();
  });
});

describe("todos", () => {
  it("publishes the harness todo list after a run", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const chat = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    expect(chat.todos).toEqual([]);
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "make a todo list" });
    await sse.waitFor(() => sse.chatEvents().some((e) => e.type === "todos"));
    expect(t.manager.get(chat.chatId).snapshot().todos.map((x) => x.status)).toEqual(["completed", "in_progress", "pending"]);
    sse.close();
  });
});

describe("ambient notices", () => {
  it("marks notices raised while idle so they stay out of turns", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const created = (await agent.post("/api/chats").send({ harnessId: "fake", workspaceId: ws.id })).body as ChatSnapshot;
    const chat = t.manager.get(created.chatId);
    const sse = openSse(t, chat.chatId, agent.cookie);
    await agent.post(`/api/chats/${chat.chatId}/messages`).send({ text: "ask please" });
    await sse.waitFor(() => chat.snapshot().pending.length === 1);
    await agent.post(`/api/chats/${chat.chatId}/requests/${chat.snapshot().pending[0]?.id}`).send({ answer: { kind: "confirm", confirmed: false } });
    await sse.waitFor(() => chat.status === "idle");
    // "Fake tool denied" came mid-run: part of the turn.
    const denied = chat.snapshot().items.find((i) => i.kind === "notice" && i.text === "Fake tool denied");
    expect(denied && denied.kind === "notice" && denied.ambient).toBeFalsy();
    // A notice while idle (as extensions post on open) is ambient.
    chat.apply({ type: "notice", level: "info", text: "extension says hi" });
    const hi = chat.snapshot().items.find((i) => i.kind === "notice" && i.text === "extension says hi");
    expect(hi && hi.kind === "notice" && hi.ambient).toBe(true);
    sse.close();
  });
});
