// The browser client's half of Idempotency-Key (src/web/api.ts): every mutating call carries a
// key of its own, and a caller that retries a call sends the same one again.
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDEMPOTENCY_KEY_HEADER } from "../../src/shared/protocol.js";
import { api, idempotencyKey } from "../../src/web/api.js";

const sent: Array<{ url: string; init: RequestInit }> = [];

function stubFetch(): void {
  sent.length = 0;
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
}

const header = (at: number): string | undefined => (sent[at]?.init.headers as Record<string, string>)?.[IDEMPOTENCY_KEY_HEADER];

afterEach(() => {
  vi.unstubAllGlobals();
  sent.length = 0;
});

describe("the browser client's idempotency keys", () => {
  it("sends a fresh key on each mutating call", async () => {
    stubFetch();
    await api("/api/chats", { body: { harnessId: "pi" } });
    await api("/api/chats", { body: { harnessId: "pi" } });
    expect(header(0)).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(header(1)).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
    expect(header(0)).not.toBe(header(1));
  });

  it("sends no key on a read, and one on a bodyless delete", async () => {
    stubFetch();
    await api("/api/chats/c1");
    await api("/api/chats/c1/pastes/p1", { method: "DELETE" });
    expect(header(0)).toBeUndefined();
    expect(header(1)).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
  });

  it("sends back the key a caller gives it, so its retry is the same call", async () => {
    stubFetch();
    await api("/api/chats/c1/messages", { body: { text: "hello", mode: "normal" }, idempotencyKey: "attempt-0001" });
    await api("/api/chats/c1/messages", { body: { text: "hello", mode: "normal" }, idempotencyKey: "attempt-0001" });
    expect(header(0)).toBe("attempt-0001");
    expect(header(1)).toBe("attempt-0001");
  });

  it("keeps the content type it always sent", async () => {
    stubFetch();
    await api("/api/chats", { body: { harnessId: "pi" } });
    expect((sent[0]?.init.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(sent[0]?.init.body).toBe(JSON.stringify({ harnessId: "pi" }));
  });

  it("mints keys that fit the shape the server accepts", () => {
    const one = idempotencyKey();
    expect(one).not.toBe(idempotencyKey());
    expect(one).toMatch(/^[A-Za-z0-9_.:-]{8,128}$/);
  });
});

describe("reads in flight", () => {
  it("shares one request between identical reads that overlap, and hands each caller its own copy", async () => {
    stubFetch();
    const [a, b] = await Promise.all([api<{ ok: boolean }>("/api/sessions"), api<{ ok: boolean }>("/api/sessions")]);
    expect(sent).toHaveLength(1);
    expect(a).toEqual({ ok: true });
    expect(a).not.toBe(b);
    await api("/api/sessions");
    expect(sent).toHaveLength(2);
  });

  it("does not join reads of different paths, or a read made after a change began", async () => {
    stubFetch();
    await Promise.all([api("/api/sessions"), api("/api/sessions?path=%2Fp")]);
    expect(sent).toHaveLength(2);
    sent.length = 0;
    const first = api("/api/sessions");
    const change = api("/api/chats/c1/rename", { body: { title: "x" } });
    const second = api("/api/sessions");
    await Promise.all([first, change, second]);
    expect(sent.map((s) => s.url)).toEqual(["/api/sessions", "/api/chats/c1/rename", "/api/sessions"]);
  });

  it("gives every joined caller the same error", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ error: "nope", code: "bad" }), { status: 409 })) as unknown as typeof fetch;
    const results = await Promise.allSettled([api("/api/x"), api("/api/x")]);
    expect(results.map((r) => (r.status === "rejected" ? (r.reason as { code: string }).code : "ok"))).toEqual(["bad", "bad"]);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});
