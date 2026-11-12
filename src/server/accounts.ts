// Opaque native choices, never credentials or user emails. Index is 1-based, as /session pin wants it.
import { z } from "zod";

export interface ProviderAccount {
  provider: string;
  index: number;
  id: string;
  supported: boolean;
  current?: boolean;
}

export const accountIdSchema = z.string().regex(/^([a-z0-9][a-z0-9-]{0,63}):([1-9][0-9]{0,1})$/i).max(66);

export function parseProviderList(provider: string, output: string): ProviderAccount[] {
  const accounts: ProviderAccount[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)[.)]\s+/.exec(line);
    if (!match) continue;
    const index = Number(match[1]);
    if (index < 1 || index > 64) continue;
    const current = /(?:\(|\[)\s*(?:active|current|selected)\s*(?:\]|\))\s*$/.test(line) || line.includes("*current*") || line.includes("• active");
    accounts.push({ provider, index, id: `${provider}:${index}`, supported: true, ...(current ? { current: true } : {}) });
  }
  return accounts;
}
