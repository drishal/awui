// Idempotency-Key on mutating requests (src/server/idempotency.ts): a repeat replays the first
// answer, and the store's own bounds are checked on a small app where a clock and the caps can
// be set. The last cases drive the real app, to prove it is mounted where it belongs.
import express from "express";
import type { Server } from "node:http";
import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { Idempotency, type IdempotencyOptions } from "../../src/server/idempotency.js";
import { IDEMPOTENCY_KEY_HEADER, type ChatSnapshot } from "../../src/shared/protocol.js";
import { makeTestApp, PASS, signedIn, USER, type TestApp } from "../helpers/app.js";

const KEY = "key-00000001";

/** A small app with one mutating route that counts its runs, mounted the way app.ts mounts it. */
function tinyApp(options: IdempotencyOptions = {}) {
  const idempotency = new Idempotency(options);
  const runs = { things: 0, other: 0, slow: 0, failing: 0, upload: 0 };
  let release: (() => void) | null = null;
  const app = express();
  app.use("/api", express.json());
  app.use("/api", idempotency.handle);
  app.post("/api/things", (req, res) => {
    runs.things += 1;
    res.status(201).json({ run: runs.things, body: req.body ?? null });
  });
  app.post("/api/other", (_req, res) => {
    runs.other += 1;
    res.json({ run: runs.other });
  });
  app.post("/api/slow", async (_req, res) => {
    runs.slow += 1;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    res.json({ run: runs.slow });
  });
  app.post("/api/failing", (_req, res) => {
    runs.failing += 1;
    res.status(503).json({ error: "later", run: runs.failing });
  });
  app.post("/api/workspaces/:id/upload", (_req, res) => {
    runs.upload += 1;
    res.json({ run: runs.upload });
  });
  app.get("/api/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.write("event: chat\ndata: one\n\n");
    res.end();
  });
  const server = app.listen(0, "127.0.0.1") as Server;
  return {
    server,
    runs,
    done: () => new Promise<void>((resolve) => server.close(() => resolve())),
    /** Let the request that is parked in /api/slow answer. */
    release: () => release?.(),
  };
}

let app: ReturnType<typeof tinyApp> | null = null;
afterEach(async () => {
  await app?.done();
  app = null;
});

describe("a repeat of a keyed request", () => {
  it("replays the first answer instead of running again", async () => {
    app = tinyApp();
    const first = await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ a: 1 });
    expect(first.status).toBe(201);
    expect(first.body).toEqual({ run: 1, body: { a: 1 } });
    expect(first.headers["idempotent-replay"]).toBeUndefined();
    const again = await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ a: 1 });
    expect(again.status).toBe(201);
    expect(again.body).toEqual({ run: 1, body: { a: 1 } });
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect(again.headers["content-type"]).toContain("application/json");
    expect(app.runs.things).toBe(1);
  });

  it("is left alone without a key", async () => {
    app = tinyApp();
    await request(app.server).post("/api/things").send({ a: 1 });
    const second = await request(app.server).post("/api/things").send({ a: 1 });
    expect(second.body).toEqual({ run: 2, body: { a: 1 } });
    expect(second.headers["idempotent-replay"]).toBeUndefined();
  });

  it("waits for the first request while it is still running", async () => {
    app = tinyApp();
    const first = request(app.server).post("/api/slow").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ a: 1 }).then((r) => r);
    // The second arrives while the first is parked in the route.
    const second = request(app.server).post("/api/slow").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ a: 1 }).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(app.runs.slow).toBe(1);
    app.release();
    const [one, two] = [await first, await second];
    expect(one.body).toEqual({ run: 1 });
    expect(two.body).toEqual({ run: 1 });
    expect(two.headers["idempotent-replay"]).toBe("true");
    expect(app.runs.slow).toBe(1);
  });

  it("answers 409 while a request it cannot wait for keeps running", async () => {
    app = tinyApp({ waitMs: 30 });
    void request(app.server).post("/api/slow").set(IDEMPOTENCY_KEY_HEADER, KEY).send({}).then(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await request(app.server).post("/api/slow").set(IDEMPOTENCY_KEY_HEADER, KEY).send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe("request_in_progress");
    app.release();
  });

  it("refuses the same key with a different body or on another route", async () => {
    app = tinyApp();
    await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ a: 1 });
    const otherBody = await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ a: 2 });
    expect(otherBody.status).toBe(422);
    expect(otherBody.body.code).toBe("idempotency_key_reused");
    const otherRoute = await request(app.server).post("/api/other").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ a: 1 });
    expect(otherRoute.status).toBe(422);
    expect(otherRoute.body.code).toBe("idempotency_key_reused");
    expect(app.runs.things).toBe(1);
    expect(app.runs.other).toBe(0);
  });

  it("refuses a key that is not the shape the server asks for", async () => {
    app = tinyApp();
    const short = await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, "short").send({});
    expect(short.status).toBe(400);
    expect(short.body.code).toBe("invalid_idempotency_key");
    const spaces = await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, "a key with spaces").send({});
    expect(spaces.status).toBe(400);
    expect(app.runs.things).toBe(0);
  });
});

describe("what the store remembers", () => {
  it("forgets an answer once its window has passed", async () => {
    let clock = 1_000_000;
    app = tinyApp({ ttlMs: 1000, now: () => clock });
    await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ a: 1 });
    const before = await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ a: 1 });
    expect(before.headers["idempotent-replay"]).toBe("true");
    clock += 1500;
    const after = await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ a: 1 });
    expect(after.body).toEqual({ run: 2, body: { a: 1 } });
    expect(after.headers["idempotent-replay"]).toBeUndefined();
  });

  it("keeps at most its cap of answers, dropping the oldest first", async () => {
    app = tinyApp({ maxEntries: 2 });
    for (const key of ["key-00000001", "key-00000002", "key-00000003"]) await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, key).send({});
    expect(app.runs.things).toBe(3);
    // The first key's answer went with the oldest entry: it runs again rather than replaying.
    const old = await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, "key-00000001").send({});
    expect(old.body).toEqual({ run: 4, body: {} });
    // The newest one is still there.
    const recent = await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, "key-00000003").send({});
    expect(recent.headers["idempotent-replay"]).toBe("true");
  });

  it("runs an answer it cannot keep (too big) again, rather than truncating it", async () => {
    app = tinyApp({ maxBodyBytes: 16 });
    const first = await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ a: "a long body that will not fit in sixteen bytes" });
    expect(first.status).toBe(201);
    const again = await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ a: "a long body that will not fit in sixteen bytes" });
    expect(again.headers["idempotent-replay"]).toBeUndefined();
    expect(app.runs.things).toBe(2);
  });

  it("does not remember a 5xx, so the client may try again", async () => {
    app = tinyApp();
    const first = await request(app.server).post("/api/failing").set(IDEMPOTENCY_KEY_HEADER, KEY).send({});
    expect(first.status).toBe(503);
    const again = await request(app.server).post("/api/failing").set(IDEMPOTENCY_KEY_HEADER, KEY).send({});
    expect(again.status).toBe(503);
    expect(again.headers["idempotent-replay"]).toBeUndefined();
    expect(app.runs.failing).toBe(2);
  });

  it("leaves a streamed answer and an upload alone", async () => {
    app = tinyApp();
    const streamed = await request(app.server).post("/api/things").set(IDEMPOTENCY_KEY_HEADER, KEY).set("Accept", "text/event-stream").send({});
    expect(streamed.headers["idempotent-replay"]).toBeUndefined();
    expect(app.runs.things).toBe(1);
    const upload = await request(app.server).post("/api/workspaces/w1/upload").set(IDEMPOTENCY_KEY_HEADER, KEY).set("Content-Type", "application/octet-stream").send("bytes");
    expect(upload.status).toBe(200);
    const uploadAgain = await request(app.server).post("/api/workspaces/w1/upload").set(IDEMPOTENCY_KEY_HEADER, KEY).set("Content-Type", "application/octet-stream").send("bytes");
    expect(uploadAgain.headers["idempotent-replay"]).toBeUndefined();
    expect(app.runs.upload).toBe(2);
  });
});

describe("in the real app", () => {
  let t: TestApp | null = null;
  afterEach(async () => {
    await t?.close();
    t = null;
  });

  it("makes one chat for one key, and replays its snapshot", async () => {
    t = await makeTestApp();
    const agent = await signedIn(t);
    const ws = (await agent.post("/api/workspaces/open").send({ path: t.project })).body as { id: string };
    const first = await agent.post("/api/chats").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ harnessId: "fake", workspaceId: ws.id });
    expect(first.status).toBe(201);
    const again = await agent.post("/api/chats").set(IDEMPOTENCY_KEY_HEADER, KEY).send({ harnessId: "fake", workspaceId: ws.id });
    expect(again.status).toBe(201);
    expect(again.headers["idempotent-replay"]).toBe("true");
    expect((again.body as ChatSnapshot).chatId).toBe((first.body as ChatSnapshot).chatId);
    const snapshot = (await agent.get(`/api/chats/${(again.body as ChatSnapshot).chatId}`)).body as { chatId: string };
    expect(snapshot.chatId).toBe((first.body as ChatSnapshot).chatId);
  });

  it("keeps one device's key out of another device's way", async () => {
    const app = await makeTestApp({ withPassword: true, lanHosts: ["192.168.1.50"] });
    t = app;
    const host = `192.168.1.50:${app.port}`;
    const ws = (await request(app.server).post("/api/workspaces/open").send({ path: app.project })).body as { id: string };
    const signIn = async () => {
      const res = await request(app.server).post("/api/login").set("Host", host).send({ username: USER, password: PASS });
      return String((res.headers["set-cookie"] as unknown as string[])[0]).split(";")[0] as string;
    };
    // Two sign-ins are two sessions (each cookie carries its own id), even with one password.
    const send = (cookie: string) => request(app.server).post("/api/chats").set("Host", host).set("Cookie", cookie).set(IDEMPOTENCY_KEY_HEADER, KEY).send({ harnessId: "fake", workspaceId: ws.id });
    const one = await send(await signIn());
    const two = await send(await signIn());
    expect(one.status).toBe(201);
    expect(two.status).toBe(201);
    expect(two.headers["idempotent-replay"]).toBeUndefined();
    expect((two.body as ChatSnapshot).chatId).not.toBe((one.body as ChatSnapshot).chatId);
  }, 20_000);
});
