// A harness that comes back after the page loaded — a Hermes gateway that finished
// starting, a CLI just installed — stays greyed out in the harness menu until the page is
// reloaded, because the bootstrap payload (and its harness list) is fetched once. This
// asks the server again about exactly the harnesses it reports as blocked, and folds the
// answers back in; the server throttles its side (registry.recheck), so a harness that is
// still broken costs one discovery every so often, never one per render.
import { useEffect, useRef } from "react";
import type { Bootstrap, HarnessStatus } from "../shared/protocol.js";
import { api } from "./api.js";

/** How often a blocked harness is asked about again while the page stays open. */
export const RECHECK_MS = 20_000;

/** The payload with `fresh` rows replacing the rows they describe (order and the rest kept). */
export function mergeHarnesses(boot: Bootstrap, fresh: HarnessStatus[]): Bootstrap {
  if (fresh.length === 0) return boot;
  const byId = new Map(fresh.map((status) => [status.id, status]));
  let changed = false;
  const harnesses = boot.harnesses.map((status) => {
    const next = byId.get(status.id);
    if (!next || sameStatus(status, next)) return status;
    changed = true;
    return next;
  });
  // A poll that learned nothing must not replace boot: that re-renders the shell every interval.
  return changed ? { ...boot, harnesses } : boot;
}

function sameStatus(a: HarnessStatus, b: HarnessStatus): boolean {
  return a.id === b.id
    && a.displayName === b.displayName
    && a.available === b.available
    && a.version === b.version
    && a.versionDetail === b.versionDetail
    && a.reason === b.reason
    && a.accent === b.accent
    && a.setupCommand === b.setupCommand
    && a.warnings.length === b.warnings.length
    && a.warnings.every((warning, i) => warning === b.warnings[i])
    && sameRecord(a.capabilities, b.capabilities)
    && sameRecord(a.overrides, b.overrides);
}

function sameRecord(a: object, b: object): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every((key) => left[key] === right[key]);
}

/**
 * Keep the blocked rows honest: ask again when they appear, on the interval while any is
 * blocked, and when the window regains focus (the usual way a service that was down
 * comes back). Nothing polls once every harness is available.
 */
export function useHarnessRecheck(boot: Bootstrap | null, onFresh: (rows: HarnessStatus[]) => void): void {
  const blocked = (boot?.harnesses ?? [])
    .filter((harness) => !harness.available)
    .map((harness) => harness.id)
    .join(",");
  // The callback is app state, not a dependency: a new identity each render must not restart the poll.
  const latest = useRef(onFresh);
  latest.current = onFresh;
  useEffect(() => {
    if (!blocked) return;
    const ids = blocked.split(",");
    let cancelled = false;
    const ask = async () => {
      const answers = await Promise.all(ids.map((id) => api<HarnessStatus>(`/api/harnesses/${encodeURIComponent(id)}/status`).catch(() => null)));
      if (cancelled) return;
      const rows = answers.filter((status): status is HarnessStatus => status !== null);
      if (rows.length > 0) latest.current(rows);
    };
    void ask();
    const timer = setInterval(() => void ask(), RECHECK_MS);
    const onFocus = () => void ask();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [blocked]);
}
