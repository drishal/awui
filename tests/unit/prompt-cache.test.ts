import { describe, expect, it } from "vitest";
import { PROMPT_CACHE_1H_MS, PROMPT_CACHE_5M_MS, promptCacheExpiresAt, promptCacheTtlMs } from "../../src/server/harness/prompt-cache.js";

describe("prompt cache lifetime", () => {
  // The shape a real message carries; a session file under ~/.claude/projects writes it per call.
  const wrote = (hour: number, fiveMinute: number) => ({ input_tokens: 2, cache_creation_input_tokens: 14711, cache_creation: { ephemeral_1h_input_tokens: hour, ephemeral_5m_input_tokens: fiveMinute } });

  it("reads the window the call wrote", () => {
    expect(promptCacheTtlMs(wrote(0, 14711))).toBe(PROMPT_CACHE_5M_MS);
    expect(promptCacheTtlMs(wrote(14711, 0))).toBe(PROMPT_CACHE_1H_MS);
  });

  it("keeps the longer window readable when a call wrote both", () => {
    expect(promptCacheTtlMs(wrote(900, 300))).toBe(PROMPT_CACHE_1H_MS);
  });

  it("says nothing when no cache was written, or the shape is one it does not know", () => {
    expect(promptCacheTtlMs(wrote(0, 0))).toBeUndefined();
    expect(promptCacheTtlMs({ input_tokens: 10, cache_creation_input_tokens: 20 })).toBeUndefined();
    expect(promptCacheTtlMs({ cache_creation: { ephemeral_5m_input_tokens: -1 } })).toBeUndefined();
    expect(promptCacheTtlMs({ cache_creation: { ephemeral_5m_input_tokens: "20" } })).toBeUndefined();
    expect(promptCacheTtlMs(null)).toBeUndefined();
    expect(promptCacheTtlMs("cache")).toBeUndefined();
  });

  it("expires a lifetime's length after the request that wrote it", () => {
    expect(promptCacheExpiresAt(PROMPT_CACHE_5M_MS, 1_700_000_000_000)).toBe(1_700_000_300_000);
    expect(promptCacheExpiresAt(PROMPT_CACHE_1H_MS, 1_700_000_000_000)).toBe(1_700_003_600_000);
  });
});
