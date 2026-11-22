// How long something took or how long ago it was, in the fewest words that
// still say it: "2m 5s" for a duration, "1.2s" for a span where tenths matter,
// "3m ago" for an age. Pure, and shared (src/shared) so the server's fold and
// every client word a time alike; the web's turns.ts re-exports them for the
// components that have always imported them from there.

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  // A sub-second run reads as "<1s": "0s" reads as the letter O, and a tally
  // that rounds to zero is not a time.
  if (s === 0) return "<1s";
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return rest ? `${m}m ${rest}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** A span of time: tenths of a second under ten seconds ("1.2s"), where a whole second hides what is worth seeing, else the fold's "2m 5s". */
export function formatSpan(ms: number): string {
  return ms < 10_000 ? `${(Math.max(0, ms) / 1000).toFixed(1)}s` : formatDuration(ms);
}

/** "3m ago", "2h ago", "4d ago", else the date. */
export function ago(at: number, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - at) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(at).toLocaleDateString();
}
