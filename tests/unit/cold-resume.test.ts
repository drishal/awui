import { describe, expect, it } from "vitest";
import type { ChatItem, SessionUsage } from "../../src/shared/protocol.js";
import { COLD_RESUME_FALLBACK_MS, COLD_RESUME_MIN_TOKENS, coldResumeHint, coldResumeText, lastActivity, span } from "../../src/web/cold-resume.js";

const now = 1_700_000_000_000;
const usage = (extra: Partial<SessionUsage>): SessionUsage => ({ turns: 4, steps: 9, input: 100, cachedInput: 900_000, cacheWrite: 0, output: 200, cost: null, llmMs: null, ttftMs: null, tokensPerSecond: null, ...extra });
const base = { supportsCompact: true, contextTokens: 250_000, usage: usage({ promptCacheTtlMs: 300_000, promptCacheExpiresAt: now - 20 * 60_000 }), now };

describe("cold resume", () => {
  it("offers a compaction once the prompt cache has expired on a full session", () => {
    expect(coldResumeHint(base)).toEqual({ agoMs: 20 * 60_000, tokens: 250_000 });
  });

  it("stays quiet while the cache is still readable", () => {
    expect(coldResumeHint({ ...base, usage: usage({ promptCacheTtlMs: 3_600_000, promptCacheExpiresAt: now + 60_000 }) })).toBeNull();
  });

  it("stays quiet below the token floor, where rebuilding the prefix is not worth a compaction", () => {
    expect(coldResumeHint({ ...base, contextTokens: COLD_RESUME_MIN_TOKENS - 1 })).toBeNull();
    expect(coldResumeHint({ ...base, contextTokens: null })).toBeNull();
  });

  it("stays quiet where compacting is not offered, or where the user said not to ask again", () => {
    expect(coldResumeHint({ ...base, supportsCompact: false })).toBeNull();
    expect(coldResumeHint({ ...base, off: true })).toBeNull();
  });

  it("guesses from the chat's last activity when the harness reports no expiry", () => {
    const old = now - COLD_RESUME_FALLBACK_MS - 5 * 60_000;
    const guessed = coldResumeHint({ ...base, usage: null, lastActivityAt: old });
    expect(guessed).toEqual({ agoMs: 5 * 60_000, tokens: 250_000 });
    expect(coldResumeHint({ ...base, usage: null, lastActivityAt: now - 30 * 60_000 })).toBeNull();
    expect(coldResumeHint({ ...base, usage: null, lastActivityAt: null })).toBeNull();
  });

  it("uses the harness's lifetime on the chat's last activity when only the lifetime is known", () => {
    expect(coldResumeHint({ ...base, usage: usage({ promptCacheTtlMs: 300_000 }), lastActivityAt: now - 10 * 60_000 })).toEqual({ agoMs: 5 * 60_000, tokens: 250_000 });
  });

  it("words the hint with the span and the tokens a compaction would save", () => {
    expect(coldResumeText({ agoMs: 20 * 60_000, tokens: 250_000 })).toBe("The prompt cache expired 20m ago: the next prompt re-sends 250,000 tokens.");
    expect(span(20 * 60_000)).toBe("20m");
    expect(span(3 * 3_600_000 + 12 * 60_000)).toBe("3h 12m");
    expect(span(50 * 3_600_000)).toBe("2d 2h");
  });
});

describe("a chat's last activity", () => {
  const prompt = (at?: number): ChatItem => ({ kind: "user", id: `u${at}`, text: "hi", ...(at === undefined ? {} : { at }) });
  const answer = (at?: number, endedAt?: number): ChatItem => ({ kind: "assistant", id: `a${endedAt ?? at}`, text: "ok", thinking: "", streaming: false, ...(at === undefined ? {} : { at }), ...(endedAt === undefined ? {} : { endedAt }) });

  it("is the newest time an item carries, wherever in the conversation it is", () => {
    expect(lastActivity([prompt(1000), answer(2000, 2500)])).toBe(2500);
    expect(lastActivity([prompt(1000), answer(2000), prompt(3000)])).toBe(3000);
    expect(lastActivity([prompt(1000), answer(2000), { kind: "notice", id: "n", level: "info", text: "x" }])).toBe(2000);
  });

  it("is unknown when no item carries one", () => {
    expect(lastActivity([])).toBeNull();
    expect(lastActivity([prompt(), answer()])).toBeNull();
  });
});
