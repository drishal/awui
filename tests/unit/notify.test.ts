import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Notifier, pushEndpointProblem, rawPublicKey, roomPushNote, vapidAuthorization, type PushFetch } from "../../src/server/notify.js";
import { roomAnswerSchema } from "../../src/shared/protocol.js";

const FCM = "https://fcm.googleapis.com/fcm/send/abc123";

describe("web push", () => {
  it("accepts only the browsers' push services, over HTTPS", () => {
    expect(pushEndpointProblem(FCM)).toBeNull();
    expect(pushEndpointProblem("https://updates.push.services.mozilla.com/wpush/v2/x")).toBeNull();
    expect(pushEndpointProblem("https://web.push.apple.com/x")).toBeNull();
    expect(pushEndpointProblem("http://fcm.googleapis.com/x")).toMatch(/HTTPS/);
    expect(pushEndpointProblem("https://127.0.0.1/x")).toMatch(/push service/);
    expect(pushEndpointProblem("https://fcm.googleapis.com.evil.example/x")).toMatch(/push service/);
    expect(pushEndpointProblem("not a url")).toMatch(/URL/);
  });

  it("signs a VAPID token the push service can check with the advertised key", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const header = vapidAuthorization(FCM, privateKey, publicKey, Date.UTC(2026, 9, 7));
    const m = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, h, c, sig, k] = m as unknown as string[];
    expect(JSON.parse(Buffer.from(c as string, "base64url").toString())).toMatchObject({ aud: "https://fcm.googleapis.com", exp: Date.UTC(2026, 9, 7) / 1000 + 43200 });
    expect(k).toBe(rawPublicKey(publicKey));
    expect(Buffer.from(k as string, "base64url")).toHaveLength(65);
    const raw = Buffer.from(k as string, "base64url");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") }, format: "jwk" });
    expect(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(sig as string, "base64url"))).toBe(true);
  });

  it("wakes each subscribed device with an empty push and drops subscriptions the browser gave up", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher: PushFetch = async (url, init) => {
      calls.push({ url, headers: init.headers });
      return { status: url.endsWith("gone") ? 410 : 201 };
    };
    const n = Notifier.inMemory(fetcher);
    await n.subscribe(FCM);
    await n.subscribe(`${FCM}gone`);
    const note = n.notify({ kind: "done", chatId: "c1", sessionId: null, title: "Fix", body: "Done" });
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.map((c) => c.url)).toEqual([FCM, `${FCM}gone`]);
    expect(calls[0]?.headers).toMatchObject({ TTL: "3600", Urgency: "high", "Content-Length": "0" });
    expect(calls[0]?.headers.Authorization).toMatch(/^vapid t=/);
    expect(n.since(note.at - 1)).toEqual([note]);
    expect(n.since(note.at)).toEqual([]);
    calls.length = 0;
    n.notify({ kind: "done", chatId: "", sessionId: null, title: "Test", body: "Test" }, FCM);
    await new Promise((r) => setTimeout(r, 10));
    expect(calls.map((c) => c.url)).toEqual([FCM]);
  });

  it("names a Board room's note by its room, with answers the room's route takes", () => {
    const note = roomPushNote({ kind: "ask", roomId: "r1", title: "webui", body: "@lead asks: Run it?", request: { id: "q1", kind: "confirm", title: "Run it?", createdAt: 0 } });
    // No chat id: a room's bots are not ordinary chats, so the worker must go through the room.
    expect(note).toMatchObject({ chatId: "", roomId: "r1", sessionId: null, approval: { requestId: "q1" } });
    expect(roomAnswerSchema.safeParse({ answer: note.approval?.approve }).success).toBe(true);
    expect(roomAnswerSchema.safeParse({ answer: note.approval?.deny }).success).toBe(true);
    expect(roomPushNote({ kind: "done", roomId: "r1", title: "webui", body: "done" }).approval).toBeUndefined();
  });
});
