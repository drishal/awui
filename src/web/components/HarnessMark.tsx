// Recognisable harness marks beside the selectors, distinct from the tiny dots
// session rows also use to say running, unread, and handed off. Built-ins ship
// as small local PNG masks; custom agents upload a raster into awui's own state
// folder, never fetch one from an external registry. They are decoration: the
// accessible harness name always stays in text.
import { useState, type CSSProperties } from "react";
import type { HarnessStatus } from "../../shared/protocol.js";

const BUILT_INS: Record<string, true> = { pi: true, omp: true, hermes: true, claude: true, codex: true, opencode: true, grok: true, dsh: true };

export function builtInHarnessMark(harnessId: string | undefined): string | undefined {
  return harnessId && BUILT_INS[harnessId] ? `/harness-marks/${harnessId}.png` : undefined;
}

// The optional field is additive: built-ins of older running servers have none.
export function harnessMarkUrl(harness: Pick<HarnessStatus, "id"> & { icon?: string }): string | undefined {
  if (harness.icon && /^\/api\/harness-marks\/[a-z0-9][a-z0-9-]{0,31}\.png(?:\?v=[a-f0-9]{12})?$/.test(harness.icon)) return harness.icon;
  return builtInHarnessMark(harness.id);
}

/** Mask so a monochrome source takes the harness's accent in both schemes. */
const tint = (url: string): CSSProperties => ({
  mask: `url("${url}") center / contain no-repeat`,
});

export function HarnessMark({ harness, size = 16, className }: { harness: (Pick<HarnessStatus, "id"> & { icon?: string }) | string | undefined; size?: number; className?: string }) {
  const known = typeof harness === "string" || harness === undefined ? undefined : harness;
  const url = known ? harnessMarkUrl(known) : builtInHarnessMark(typeof harness === "string" ? harness : undefined);
  const custom = known?.icon !== undefined && known.icon === url;

  // A failed or missing custom image reveals the neutral ACP glyph, not a dead tile.
  // The controlled state, not useEffect, forgets one row's failure when it changes identity.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  if (!url || failedUrl === url) {
    return (
      <svg className={`harness-mark is-fallback${className ? ` ${className}` : ""}`} width={size} height={size} viewBox="0 0 24 18" fill="currentColor" aria-hidden="true" focusable="false">
        <path d="m7.7 15.2-5-8.7A1.6 1.6 0 0 1 4.1 4h2.7a1.6 1.6 0 0 1 1.4.8l2.1 3.5 2.1-3.5a1.6 1.6 0 0 1 1.4-.8h2.7a1.6 1.6 0 0 1 1.4 2.5l-5 8.7a1.6 1.6 0 0 1-2.8 0L8.8 12 7.7 13.8a1.6 1.6 0 0 1 0 1.4Z" />
      </svg>
    );
  }
  return (
    <span className={["harness-mark", ...(custom ? ["is-custom"] : []), ...(className ? [className] : [])].join(" ")} style={{ ...(custom ? {} : tint(url)), width: size, height: size }} aria-hidden="true">
      <img src={url} width={size} height={size} alt="" aria-hidden="true" onError={() => setFailedUrl(url)} />
    </span>
  );
}
