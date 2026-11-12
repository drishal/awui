// How long a prompt's cached prefix stays readable: the provider's own answer, read off the
// usage it reports per model call. Claude Code's messages carry a breakdown
// (`cache_creation: { ephemeral_5m_input_tokens, ephemeral_1h_input_tokens }`) that names which
// cache the call wrote, and the lifetime starts with the request, not its response. A chat
// parks the pair on its usage so the composer can say when the next prompt will pay for the
// prefix again; nothing here talks to a provider.
export const PROMPT_CACHE_5M_MS = 5 * 60_000;
export const PROMPT_CACHE_1H_MS = 60 * 60_000;

const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);

/**
 * The cache lifetime a usage report names, or undefined when it names none (no cache written,
 * or a shape this does not know). A 1-hour write wins: a call that wrote both windows keeps
 * the longer one readable.
 */
export function promptCacheTtlMs(usage: unknown): number | undefined {
  if (typeof usage !== "object" || usage === null) return undefined;
  const creation = (usage as { cache_creation?: unknown }).cache_creation;
  if (typeof creation !== "object" || creation === null) return undefined;
  const windows = creation as { ephemeral_1h_input_tokens?: unknown; ephemeral_5m_input_tokens?: unknown };
  if (count(windows.ephemeral_1h_input_tokens) > 0) return PROMPT_CACHE_1H_MS;
  if (count(windows.ephemeral_5m_input_tokens) > 0) return PROMPT_CACHE_5M_MS;
  return undefined;
}

/** When that cache stops being readable: the request's time plus its lifetime. */
export function promptCacheExpiresAt(ttlMs: number, requestedAt: number): number {
  return requestedAt + ttlMs;
}
