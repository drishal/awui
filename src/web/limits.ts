// Shared subscription limits: read on load, every five minutes while the page is visible,
// after a run in the shown chat settles, and explicitly from the Usage panel.
import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageLimits } from "../shared/protocol.js";
import { api } from "./api.js";

const REFRESH_MS = 5 * 60_000;

/** `settled` counts finished runs; each one after the first load re-reads the limits. */
export function useLimits(enabled: boolean, settled: number): { limits: UsageLimits | null; refresh: () => Promise<void> } {
  const [limits, setLimits] = useState<UsageLimits | null>(null);
  const seq = useRef(0);
  const read = useCallback(async (refresh: boolean) => {
    const mine = ++seq.current;
    try {
      const next = await api<UsageLimits>(`/api/limits${refresh ? "?refresh=1" : ""}`);
      if (mine === seq.current) setLimits(next);
    } catch {
      // the meter just keeps what it had
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void read(false);
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void read(false);
    }, REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && void read(false);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, read]);

  useEffect(() => {
    if (enabled && settled > 0) void read(false);
  }, [enabled, settled, read]);

  const refresh = useCallback(() => read(true), [read]);
  return { limits, refresh };
}

// The words and numbers for limits live in limit-words.ts, which has no React, so the terminal clients share them.
export { accountName, level, percent, resetsIn } from "./limit-words.js";
