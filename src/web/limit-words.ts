// Subscription limits in words and numbers: whose account, how full each window is, and when it
// resets. Pure, with no React, so the web Usage panel (limits.ts re-exports these) and the
// terminal clients (the Tern client's Usage screen) word a limit the same way.
import type { LimitAccount, LimitWindow } from "../shared/protocol.js";

const PROVIDERS: Record<string, string> = {
  anthropic: "Anthropic",
  "openai-codex": "ChatGPT",
  openai: "OpenAI",
  "google-gemini-cli": "Gemini",
  "google-antigravity": "Antigravity",
  "github-copilot": "Copilot",
};

export function accountName(a: LimitAccount): string {
  const provider = PROVIDERS[a.provider] ?? a.provider;
  return a.source === "Claude Code" ? "Claude" : provider;
}

export function level(used: number | null, limited = false): "ok" | "warn" | "full" {
  if (limited || (used !== null && used >= 0.9)) return "full";
  if (used !== null && used >= 0.7) return "warn";
  return "ok";
}

/** "in 3h 12m", "in 2d 4h", "in 40m". */
export function resetsIn(at: number | null, now = Date.now()): string | null {
  if (at === null) return null;
  const min = Math.max(0, Math.round((at - now) / 60_000));
  if (min < 60) return `in ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 48) return `in ${h}h ${min % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}

export const percent = (used: number | null): string => (used === null ? "—" : `${Math.round(used * 100)}%`);
