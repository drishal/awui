// A routine's webhook (routine-webhook.ts): the signature a sender must hold, the
// filters that narrow what counts, the delivery key that makes a repeat a no-op, the
// prompt substitution, and the per-routine rate limit.
import { describe, expect, it } from "vitest";
import type { RoutineHook } from "../../src/shared/protocol.js";
import { deliveryKey, HOOK_PLACEHOLDER, HookGate, hookMatches, hookPrompt, MAX_HOOKS_PER_HOUR, MAX_SEEN, SEEN_TTL_MS, signatureMatches, signatureOf, valueAtPath } from "../../src/server/routine-webhook.js";

const hook = (extra: Partial<RoutineHook> = {}): RoutineHook => ({ secret: "s3cret-s3cret-s3cret", header: "", headerValue: "", path: "", pathValue: "", dedupePath: "", ...extra });
const noHeaders = () => undefined;

describe("a routine's webhook", () => {
  it("accepts only a body signed with the routine's own secret", () => {
    const body = '{"action":"opened"}';
    expect(signatureOf("abc", body)).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(signatureMatches("abc", body, signatureOf("abc", body))).toBe(true);
    // Hex is case-insensitive; the prefix is not optional.
    expect(signatureMatches("abc", body, signatureOf("abc", body).toUpperCase().replace("SHA256=", "sha256="))).toBe(true);
    expect(signatureMatches("other", body, signatureOf("abc", body))).toBe(false);
    expect(signatureMatches("abc", `${body} `, signatureOf("abc", body))).toBe(false);
    expect(signatureMatches("abc", body, undefined)).toBe(false);
    expect(signatureMatches("abc", body, "sha1=abc")).toBe(false);
  });

  it("reads a dotted path, through objects and arrays", () => {
    const body = { action: "opened", pull_request: { merged: true, number: 7 }, commits: [{ id: "c1" }], empty: null };
    expect(valueAtPath(body, "action")).toBe("opened");
    expect(valueAtPath(body, "pull_request.merged")).toBe("true");
    expect(valueAtPath(body, "pull_request.number")).toBe("7");
    expect(valueAtPath(body, "commits.0.id")).toBe("c1");
    expect(valueAtPath(body, "commits.9.id")).toBeNull();
    expect(valueAtPath(body, "empty")).toBeNull();
    expect(valueAtPath(body, "")).toBeNull();
  });

  it("counts a delivery only when its header and body filters agree", () => {
    const body = { action: "opened" };
    const headers = (values: Record<string, string>) => (name: string) => values[name];
    const filtered = hook({ header: "x-github-event", headerValue: "pull_request", path: "action", pathValue: "opened" });
    expect(hookMatches(filtered, headers({ "x-github-event": "pull_request" }), body)).toBe(true);
    expect(hookMatches(filtered, headers({ "x-github-event": "issues" }), body)).toBe(false);
    expect(hookMatches(filtered, headers({ "x-github-event": "pull_request" }), { action: "closed" })).toBe(false);
    // No filter at all means any signed body counts.
    expect(hookMatches(hook(), noHeaders, {})).toBe(true);
  });

  it("names a delivery by its header first, else by a body path", () => {
    expect(deliveryKey(hook(), (name) => (name === "x-github-delivery" ? "d-1" : undefined), {})).toBe("d-1");
    expect(deliveryKey(hook(), noHeaders, { event: { id: "e-1" } })).toBeNull();
    expect(deliveryKey(hook({ dedupePath: "event.id" }), noHeaders, { event: { id: "e-1" } })).toBe("e-1");
  });

  it("puts the delivery in the prompt where the placeholder is, bounded", () => {
    expect(hookPrompt("Review this: {{webhook}}", { action: "opened" })).toContain('"action": "opened"');
    expect(hookPrompt("no placeholder", { action: "opened" })).toBe("no placeholder");
    const long = hookPrompt(HOOK_PLACEHOLDER, { text: "x".repeat(20_000) });
    expect(long.length).toBeLessThan(4_200);
    expect(long).toContain("only its start is here");
  });

  it("rate limits one routine, and refuses the same delivery twice", () => {
    const gate = new HookGate();
    const now = 1_000_000;
    expect(gate.first("r1", "d-1", now)).toBe(true);
    expect(gate.first("r1", "d-1", now + 1000)).toBe(false);
    // The same key for another routine is a different delivery.
    expect(gate.first("r2", "d-1", now)).toBe(true);
    // Once the window has passed, the same delivery may come again (a real retry is days later).
    expect(gate.first("r1", "d-1", now + SEEN_TTL_MS + 1)).toBe(true);
    // A key-less delivery is always allowed.
    expect(gate.first("r1", null, now)).toBe(true);
  });

  it("holds one routine to its hourly cap", () => {
    const gate = new HookGate();
    for (let i = 0; i < MAX_HOOKS_PER_HOUR; i++) expect(gate.allow("r1", 1000 + i)).toBe(true);
    expect(gate.allow("r1", 2000)).toBe(false);
    // Another routine has its own budget, and an hour later the first one is free again.
    expect(gate.allow("r2", 2000)).toBe(true);
    expect(gate.allow("r1", 1000 + 3_600_001)).toBe(true);
  });

  it("forgets old keys before MAX_SEEN piles up", () => {
    const gate = new HookGate();
    const now = 5_000_000;
    for (let i = 0; i < MAX_SEEN + 20; i++) gate.first("r1", `d-${i}`, now + i);
    // The newest were kept; the oldest went.
    expect(gate.first("r1", `d-${MAX_SEEN + 19}`, now + 1000)).toBe(false);
    expect(gate.first("r1", "d-0", now + 1000)).toBe(true);
  });
});
