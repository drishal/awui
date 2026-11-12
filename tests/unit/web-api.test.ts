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
