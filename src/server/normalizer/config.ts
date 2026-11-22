// config.yml's `normalizer:` block, resolved: defaults applied, and the two provider keys its
// environment variables may override. Server-side only — the resolved object carries real keys, so
// nothing built here is ever sent to a browser (the settings route sends `hasJevKey` and friends).
//
// The feature is off unless the file says `enabled: true`, and the default backend is the local one,
// which cannot be used until an endpoint is set: turning it on is always a deliberate act, and the
// default one sends nothing off this machine.
import type { NormalizerBackend } from "../../shared/protocol.js";
import type { NormalizerFileConfig } from "../user-config.js";

export interface NormalizerConfig {
  enabled: boolean;
  backend: NormalizerBackend;
  /** The local backend's URL ("" when unset). */
  endpoint: string;
  jevBaseUrl: string;
  jevModel: string;
  cloudflareAccountId: string;
  /** The gate on the selected option's own probability, and the band on a Noul (0–1). */
  minChoice: number;
  minNoul: number;
  cache: boolean;
  /** null: each backend's own default (see service.ts). */
  timeoutMs: number | null;
  allowFreeText: boolean;
  /** The resolved secrets. Never sent to a browser, never logged. */
  keys: { jev: string | null; commandCode: string | null; cloudflare: string | null };
}

/** What the dialog shows before anything is saved, and what the server falls back to. */
export const NORMALIZER_DEFAULTS = {
  backend: "local-clef-flash",
  jevBaseUrl: "https://api.typesafe.ai/v1/systemone",
  jevModel: "jev-latest",
  minChoice: 0.7,
  minNoul: 0.7,
  cache: true,
} as const satisfies Record<string, unknown>;

/** The local backend's model name; every backend's request names it in the body. */
export const LOCAL_CLEF_MODEL = "clef-flash";

const text = (value: string | undefined): string => value?.trim() ?? "";

/** The block as config.yml states it, under whatever the environment sets (CMD_API_KEY and TYPESAFE_API_KEY win). */
export function normalizerConfigOf(file: NormalizerFileConfig | undefined, env: NodeJS.ProcessEnv): NormalizerConfig {
  return {
    enabled: file?.enabled === true,
    backend: file?.backend ?? NORMALIZER_DEFAULTS.backend,
    endpoint: text(file?.endpoint),
    jevBaseUrl: text(file?.jev_base_url) || NORMALIZER_DEFAULTS.jevBaseUrl,
    jevModel: text(file?.jev_model) || NORMALIZER_DEFAULTS.jevModel,
    cloudflareAccountId: text(file?.cloudflare_account_id),
    minChoice: file?.min_choice_probability ?? NORMALIZER_DEFAULTS.minChoice,
    minNoul: file?.min_noul ?? NORMALIZER_DEFAULTS.minNoul,
    cache: file?.cache ?? NORMALIZER_DEFAULTS.cache,
    timeoutMs: file?.timeout_ms ?? null,
    allowFreeText: file?.allow_free_text === true,
    keys: {
      jev: text(env.TYPESAFE_API_KEY) || text(file?.jev_api_key) || null,
      commandCode: text(env.CMD_API_KEY) || text(file?.command_code_api_key) || null,
      cloudflare: text(file?.cloudflare_api_token) || null,
    },
  };
}
