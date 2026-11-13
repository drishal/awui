// Guest links: a real fake session shared by an owner, redeemed into one browser,
// with owner-reviewed dispatch. Every case drives the actual routes.
import { afterEach, describe, expect, it } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { GUEST_TTL_MS, GuestStore } from "../../src/server/guests.js";
import { makeTestApp, signedIn, tempDir, type TestApp } from "../helpers/app.js";
import type { ChatItem } from "../../src/shared/protocol.js";

let t: TestApp | undefined;
afterEach(async () => { await t?.close(); });

/** Real native fake session, settled, then shared by the owner. Returns the guest URL token. */
async function fixture(options: Parameters<typeof makeTestApp>[0] = {}) {
  const app = t = await makeTestApp(options);
  const owner = await signedIn(app);
  const workspace = (await owner.post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
  const chat = (await owner.post(`/api/chats`).send({ harnessId: "fake", workspaceId: workspace.id })).body as { chatId?: string };
  if (!chat.chatId) throw new Error("No real native chat was started: " + JSON.stringify(chat));
  await owner.post(`/api/chats/${chat.chatId}/messages`).send({ text: "Seed prompt" });
  let sessionId: string | undefined;
  for (let i = 0; i < 100 && !sessionId; i++) {
    sessionId = app.manager.list().find((row) => row.chatId === chat.chatId)?.sessionId ?? undefined;
    if (!sessionId) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!sessionId?.startsWith("fake:")) throw new Error("actual fake session missing: " + String(sessionId));
  const native = sessionId.slice("fake:".length);
  const share = await owner.post(`/api/guests/fake/${encodeURIComponent(native)}`).send({ workspaceId: workspace.id });
  expect(share.status).toBe(200);
  const guestId = (share.body as { guest: { id: string } }).guest.id;
  const token = (share.body as { url: string }).url.slice("/guest/".length);
  return { owner, workspace, native, guestId, token, chatId: chat.chatId };
}

/** Waits for a predicate, the shared pattern for live fake sessions. */
async function until(predicate: () => boolean, ms = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("bounded expiring guest links", () => {
  it("issues a hashed token, binds one browser, and refuses a second", async () => {
    const { token } = await fixture();
    // The plaintext token appears once (the create response); the store keeps only its hash.
    expect(readFileSync(path.join(t!.stateDir, "guest-sessions.json"), "utf8")).not.toContain(token);
    const guest = request.agent(t!.server);
    const first = await guest.post("/api/guests/redeem").send({ token });
    expect(first.status).toBe(200);
    const meta = await guest.get("/api/guest");
    expect(meta.status).toBe(200);
    expect(meta.body).toMatchObject({ harnessId: "fake", browserSession: "bound", expiresAt: expect.any(Number) });
    expect(meta.body.id).toMatch(/^[a-f0-9]{32}$/);
    // A different browser (no cookie jar) is refused: the link is already claimed.
    const second = await request(t!.server).post("/api/guests/redeem").send({ token });
    expect(second.status).toBe(403);
    expect(second.body.code).toBe("guest_in_use");
  });

  it("shows the guest only title, harness, workspace name, expiry, and pending queue", async () => {
    const { token } = await fixture();
    const jar = request.agent(t!.server);
    const guest = await jar.post("/api/guests/redeem").send({ token });
    expect(guest.status).toBe(200);
    const view = guest.body.guest as Record<string, unknown>;
    expect(Object.keys(view).sort()).toEqual(["browserSession", "expiresAt", "harnessId", "id", "pending", "title", "workspaceName"]);
    expect(view).not.toHaveProperty("workspace");
    expect(view).not.toHaveProperty("tokenHash");
    const meta = await jar.get("/api/guest");
    expect(Object.keys(meta.body).sort()).toEqual(["browserSession", "expiresAt", "harnessId", "id", "pending", "title", "workspaceName"]);
  });

  it("projects text-only history: user and assistant text, no tool output or thinking", async () => {
    const rows: ChatItem[] = [
      { kind: "user", id: "u1", text: "one visible prompt" },
      { kind: "assistant", id: "a1", text: "explicit answer", thinking: "private thought", streaming: false },
      { kind: "tool", id: "t1", name: "write", args: "{\"text\":\"x\"}", status: "done", category: "write", output: "secret tool output", truncated: false, summary: "w", paths: [] },
      { kind: "request", id: "r1", text: "an approval request" },
    ] as unknown as ChatItem[];
    expect(GuestStore.history(rows)).toEqual([
      { id: "u1", kind: "user", text: "one visible prompt", at: undefined },
      { id: "a1", kind: "assistant", text: "explicit answer", at: undefined },
    ]);
  });

  it("queues a guest message for owner review, idempotent by retry id", async () => {
    const { guestId, token } = await fixture();
    const guest = request.agent(t!.server);
    await guest.post("/api/guests/redeem").send({ token });
    const first = await guest.post("/api/guest/messages").send({ text: "Please consider this", requestId: "guestflow1" });
    expect(first.status).toBe(202);
    expect(first.body.accepted).toBe("owner_review");
    // The same retry id and content is a no-op; a changed content with the same id is a conflict.
    expect((await guest.post("/api/guest/messages").send({ text: "Please consider this", requestId: "guestflow1" })).status).toBe(202);
    expect((await guest.post("/api/guest/messages").send({ text: "Different text", requestId: "guestflow1" })).status).toBe(409);
    const pending = ((await guest.get("/api/guest")).body as { pending: Array<{ id: string; state?: string }> }).pending;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.state === undefined || pending[0]!.state === "queued").toBe(true);
    expect(typeof pending[0]!.id).toBe("string");
    // Only the owner can release it; a guest cookie is a guest everywhere, so an owner
    // route refuses it before any grant is read (401, not 403 missing_grant).
    const release = await guest.post(`/api/guests/${guestId}/messages/${pending[0]!.id}/send`).send({});
    expect(release.status).toBe(401);
    expect(release.body.code).toBe("guest_required");
  });

  it("refuses every owner route to a request that carries no session at all", async () => {
    // A password server reached from the LAN: with no cookie, grantsOf reads "full access", so only
    // requireAuth stands between a stranger and the owner's routes.
    const { guestId, native, workspace, token } = await fixture({ withPassword: true, lanHosts: ["192.168.1.50"] });
    const guest = request.agent(t!.server);
    await guest.post("/api/guests/redeem").send({ token });
    await guest.post("/api/guest/messages").send({ text: "Queued", requestId: "nosession1" });
    const pending = ((await guest.get("/api/guest")).body as { pending: Array<{ id: string }> }).pending;
    const host = `192.168.1.50:${t!.port}`;
    const bare = { get: (u: string) => request(t!.server).get(u).set("Host", host), post: (u: string) => request(t!.server).post(u).set("Host", host), delete: (u: string) => request(t!.server).delete(u).set("Host", host) };
    const calls = [
      await bare.get(`/api/guests/fake/${encodeURIComponent(native)}`),
      await bare.post(`/api/guests/fake/${encodeURIComponent(native)}`).send({ workspaceId: workspace.id }),
      await bare.post(`/api/guests/${guestId}/messages/${pending[0]!.id}/send`).send({}),
      await bare.post(`/api/guests/${guestId}/messages/${pending[0]!.id}/dismiss`).send({}),
      await bare.delete(`/api/guests/${guestId}`),
    ];
    for (const res of calls) expect(res.status).toBe(401);
    // Nothing happened: the message is still queued for the owner.
    expect(((await guest.get("/api/guest")).body as { pending: unknown[] }).pending).toHaveLength(1);
  });

  it("refuses a guest cookie on every owner route, on a password server and on this machine", async () => {
    // On a password server the cookie used to pass requireAuth as a session and then read
    // /api/bootstrap (home, roots, username). The guest marker makes it a guest everywhere;
    // the guest's own three routes stay open, and they never learn any of that.
    for (const options of [{ withPassword: true, lanHosts: ["192.168.1.50"] }, {}]) {
      t = await makeTestApp(options);
      const owner = await signedIn(t);
      const workspace = (await owner.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
      const chat = (await owner.post("/api/chats").send({ harnessId: "fake", workspaceId: workspace.id })).body as { chatId: string };
      await owner.post(`/api/chats/${chat.chatId}/messages`).send({ text: "Seed prompt" });
      await until(() => t!.manager.list().find((row) => row.chatId === chat.chatId)?.sessionId !== undefined);
      const sessionId = t!.manager.list().find((row) => row.chatId === chat.chatId)?.sessionId as string;
      const native = sessionId.slice("fake:".length);
      const share = await owner.post(`/api/guests/fake/${encodeURIComponent(native)}`).send({ workspaceId: workspace.id });
      const token = (share.body as { url: string }).url.slice("/guest/".length);
      const host = options.withPassword ? `192.168.1.50:${t.port}` : undefined;
      const guest = request.agent(t.server);
      // The cookie is bound to the authority it was issued for: a LAN guest redeems over the LAN host.
      const redeem = host ? guest.post("/api/guests/redeem").set("Host", host) : guest.post("/api/guests/redeem");
      expect((await redeem.send({ token })).status).toBe(200);
      const call = (method: "get" | "post", url: string) => {
        const req = method === "get" ? guest.get(url) : guest.post(url).send({});
        return host ? req.set("Host", host) : req;
      };
      for (const url of ["/api/bootstrap", "/api/sessions", "/api/chats", "/api/workspaces", "/api/settings", "/api/invites", "/api/guests"]) {
        const res = await call("get", url);
        expect(res.status, url).toBe(401);
        expect(res.body.code, url).toBe("guest_required");
      }
      expect((await call("post", "/api/workspaces/open")).status).toBe(401);
      // The guest's own routes still work, and answer no owner material.
      const meta = await call("get", "/api/guest");
      expect(meta.status).toBe(200);
      expect(meta.body).not.toHaveProperty("home");
      const history = await call("get", "/api/guest/history");
      expect(history.status).toBe(200);
      expect(Object.keys(history.body).sort()).toEqual(["expiresAt", "harnessId", "history", "title", "workspaceName"]);
      await t.close();
      t = undefined;
    }
  });

  it("sends accepted visitor content on to the exact session once the owner releases it", async () => {
    const { owner, guestId, token, chatId } = await fixture();
    const guest = request.agent(t!.server);
    await guest.post("/api/guests/redeem").send({ token });
    await guest.post("/api/guest/messages").send({ text: "A queued request", requestId: "clientchecka" });
    const pending = ((await guest.get("/api/guest")).body as { pending: Array<{ id: string }> }).pending;
    expect(pending).toHaveLength(1);
    await until(() => t!.manager.get(chatId).status === "idle");
    const sent = await owner.post(`/api/guests/${guestId}/messages/${pending[0]!.id}/send`).send({});
    expect(sent.status).toBe(200);
    expect(sent.body.ok).toBe(true);
    // The native session received exactly the guest text as its next prompt.
    await until(() => t!.manager.get(chatId).snapshot().items.some((item) => item.kind === "user" && item.text === "A queued request"));
    expect(t!.manager.get(chatId).snapshot().items.some((item) => item.kind === "user" && item.text === "A queued request")).toBe(true);
    // The message is now sent: dismissing a sent message is refused, and the queue is empty.
    expect((await guest.get("/api/guest")).body.pending).toHaveLength(0);
    expect((await owner.post(`/api/guests/${guestId}/messages/${pending[0]!.id}/dismiss`).send({})).status).toBe(404);
  });

  it("keeps the message queued when the session is busy, then releases it after", async () => {
    const { owner, guestId, token, chatId } = await fixture();
    const guest = request.agent(t!.server);
    await guest.post("/api/guests/redeem").send({ token });
    // While the seed run is still live, a release is refused and the message stays queued.
    await guest.post("/api/guest/messages").send({ text: "While busy", requestId: "busycheck1" });
    const pending = ((await guest.get("/api/guest")).body as { pending: Array<{ id: string }> }).pending;
    const busy = await owner.post(`/api/guests/${guestId}/messages/${pending[0]!.id}/send`).send({});
    if (busy.status === 409) {
      expect(busy.body.code).toBe("busy");
      expect((await guest.get("/api/guest")).body.pending).toHaveLength(1);
      // Wait for the seed run to settle, then the same release succeeds.
      await until(() => t!.manager.get(chatId).status === "idle");
      expect((await owner.post(`/api/guests/${guestId}/messages/${pending[0]!.id}/send`).send({})).status).toBe(200);
      await until(() => t!.manager.get(chatId).snapshot().items.some((item) => item.kind === "user" && item.text === "While busy"));
    } else {
      // The run already settled: the release went straight through.
      expect(busy.status).toBe(200);
    }
  });

  it("drops the guest's access as soon as the owner revokes the link", async () => {
    const { owner, guestId, token } = await fixture();
    const guest = request.agent(t!.server);
    await guest.post("/api/guests/redeem").send({ token });
    expect((await guest.get("/api/guest")).status).toBe(200);
    expect((await owner.delete(`/api/guests/${guestId}`)).status).toBe(200);
    const after = await guest.get("/api/guest");
    expect(after.status).toBe(410);
    expect(after.body.code).toBe("guest_expired");
  });
});

describe("the guest store's bounds", () => {
  const target = (n: number, harnessId = "fake") => ({ harnessId, nativeId: `session-${n}`, workspace: { id: "w", path: "/tmp/project", name: "project" }, title: `link ${n}` });
  const storeAt = (file: string, clock: () => number) => new GuestStore(file, clock);

  it("prunes expired and revoked links instead of counting them against the cap", async () => {
    let now = 1_000_000;
    const file = path.join(tempDir("awui-guests-"), "guest-sessions.json");
    const store = storeAt(file, () => now);
    for (let i = 0; i < 32; i++) await store.create(target(i));
    await expect(store.create(target(32))).rejects.toMatchObject({ code: "guest_limit" });
    // Revoked links are not invitations any more: the next create drops them first.
    for (const guest of await store.list()) await store.revoke(guest.id);
    const fresh = await store.create(target(100));
    expect((await store.list()).map((guest) => guest.title)).toEqual(["link 100"]);
    // A restart after their TTL drops the expired records on load, and the next write
    // leaves them out of the file too.
    now += GUEST_TTL_MS + 1;
    const reloaded = storeAt(file, () => now);
    expect(await reloaded.list()).toEqual([]);
    await reloaded.create(target(101));
    const saved = readFileSync(file, "utf8");
    expect(saved).not.toContain(fresh.record.id);
    expect(saved).toContain("link 101");
  });

  it("keys the list by harness and native id, not the native id alone", async () => {
    const store = storeAt(path.join(tempDir("awui-guests-"), "guest-sessions.json"), () => Date.now());
    await store.create(target(1, "fake"));
    await store.create(target(1, "fake-b"));
    expect((await store.list("fake", "session-1")).map((guest) => guest.harnessId)).toEqual(["fake"]);
    expect((await store.list("fake-b", "session-1")).map((guest) => guest.harnessId)).toEqual(["fake-b"]);
    expect(await store.list("fake", "session-2")).toEqual([]);
    expect(await store.list()).toHaveLength(2);
  });
});
