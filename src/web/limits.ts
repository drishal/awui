// Subscription limits for the sidebar meter: read on load, every five minutes
// while the page is visible, and after a run in the shown chat settles.
import { useCallback, useEffect, useRef, useState } from "react";
import type { UsageLimits } from "../shared/protocol.js";
import { api } from "./api.js";

const REFRESH_MS = 5 * 60_000;

/** `settled` counts finished runs; each one after the first load re-reads the limits. */
export function useLimits(enabled: boolean, settled: number): UsageLimits | null {
  const [limits, setLimits] = useState<UsageLimits | null>(null);
  const seq = useRef(0);
  const refresh = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const next = await api<UsageLimits>("/api/limits");
      if (mine === seq.current) setLimits(next);
    } catch {
      // the meter just keeps what it had
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, REFRESH_MS);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (enabled && settled > 0) void refresh();
  }, [enabled, settled, refresh]);

  return limits;
}

// The words and numbers for limits live in limit-words.ts, which has no React, so the terminal clients share them.
export { accountName, level, percent, resetsIn, tightest } from "./limit-words.js";
