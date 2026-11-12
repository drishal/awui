// The terminal client and the headless CLI send their own Idempotency-Key (src/atui/client.ts,
// src/server/cli-run.ts): every mutating call carries one, a read carries none, and two different
// requests never share one — the server refuses a key it has already seen on another request.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runHeadlessCli } from "../../src/server/cli-run.js";
import { idempotencyKey, Server } from "../../src/atui/client.js";
import { IDEMPOTENCY_KEY_HEADER } from "../../src/shared/protocol.js";

interface Sent {
  url: string;
  method: string;
  key: string | undefined;
  body: string | null;
}

const sent: Sent[] = [];
const SHAPE = /^[A-Za-z0-9_.:-]{8,128}$/;

/** Answer each request from `routes`, recording what was asked. */
function stubFetch(routes: (url: string, method: string, body: string | null) => unknown): void {
  sent.length = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : null;
    const headers = (init?.headers ?? {}) as Record<string, string>;
    sent.push({ url: String(url), method, key: headers[IDEMPOTENCY_KEY_HEADER], body });
    const answer = routes(String(url), method, body);
    if (answer === undefined) return new Response("Not found", { status: 404 });
    return new Response(JSON.stringify(answer), { status: 200, headers: { "content-type": "application/json" } });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  sent.length = 0;
});

describe("the terminal client", () => {
  it("keys each mutating call and never a read", async () => {
    stubFetch(() => ({ ok: true }));
    const server = new Server("http://127.0.0.1:1");
    await server.call("/api/chats/c1");
    await server.call("/api/chats", { body: { harnessId: "pi" } });
    await server.call("/api/chats/c2/messages", { body: { text: "hi" } });
    await server.call("/api/chats/c2/pastes/p1", { method: "DELETE" });
    expect(sent[0]?.key).toBeUndefined();
    expect(sent[1]?.key).toMatch(SHAPE);
    expect(sent[2]?.key).toMatch(SHAPE);
    expect(sent[2]?.key).not.toBe(sent[1]?.key);
    expect(sent[3]?.key).toMatch(SHAPE);
  });

  it("sends back the key a caller gives it, so its retry is the same call", async () => {
    stubFetch(() => ({ ok: true }));
    const server = new Server("http://127.0.0.1:1");
    await server.call("/api/chats/c1/messages", { body: { text: "hi" }, idempotencyKey: "attempt-0001" });
    await server.call("/api/chats/c1/messages", { body: { text: "hi" }, idempotencyKey: "attempt-0001" });
    expect(sent.map((one) => one.key)).toEqual(["attempt-0001", "attempt-0001"]);
  });

  it("mints keys the server accepts", () => {
    expect(idempotencyKey()).toMatch(SHAPE);
    expect(idempotencyKey()).not.toBe(idempotencyKey());
  });
});

describe("the headless CLI", () => {
  it("gives the chat it starts and the message it sends keys of their own", async () => {
    stubFetch((url, method, body) => {
      if (url.endsWith("/api/health")) return { ok: true, build: "test" };
      if (url.endsWith("/api/bootstrap")) return { harnesses: [{ id: "fake", available: true }] };
      if (url.endsWith("/api/workspaces/open")) return { id: "w1", path: "/tmp", name: "tmp" };
      if (url.endsWith("/api/chats") && method === "POST") return { chatId: "c1", status: "idle", items: [] };
      if (url.endsWith("/api/chats/c1/messages") && method === "POST" && body !== null) return { accepted: true };
      return undefined;
    });
    const io = { env: { AWUI_URL: "http://127.0.0.1:1" } as NodeJS.ProcessEnv, out: () => undefined, err: () => undefined };
    const code = await runHeadlessCli(["run", "--project", mkdtempSync(path.join(tmpdir(), "awui-cli-")), "hello"], io);
    expect(code).toBe(0);
    const mutating = sent.filter((one) => one.method !== "GET" && !one.url.endsWith("/api/health"));
    // The project open, the chat create, and the message: three requests, three keys.
    expect(mutating).toHaveLength(3);
    for (const one of mutating) expect(one.key).toMatch(SHAPE);
    expect(new Set(mutating.map((one) => one.key)).size).toBe(3);
  });
});
