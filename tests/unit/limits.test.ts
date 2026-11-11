import { describe, expect, it, vi } from "vitest";
import { claudeLimits, ompLimits } from "../../src/server/harness/limits.js";
import { HarnessRegistry } from "../../src/server/harness/registry.js";
import type { HarnessAdapter } from "../../src/server/harness/types.js";
import { Limits } from "../../src/server/limits.js";
import type { LimitAccount } from "../../src/shared/protocol.js";
import { level, resetsIn } from "../../src/web/limits.js";

// As Claude Code 2.x prints it on a run (stream-json).
const claudeInfo = {
  status: "allowed_warning",
  resetsAt: 1791828000,
  rateLimitType: "seven_day",
  utilization: 0.55,
  isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: 1791407400 }, seven_day: { utilization: 0.55, resetsAt: 1791828000 } },
};

// As `omp usage --json --redact` prints it (trimmed).
const ompJson = {
  generatedAt: 1791392119244,
  reports: [
    {
      provider: "openai-codex",
      fetchedAt: 1791392116560,
      limits: [
        {
          id: "openai-codex:primary",
          label: "30 days",
          window: { id: "30d", label: "30 days", durationMs: 2592000000, resetsAt: 1791746762000 },
          amount: { used: 2, limit: 100, remaining: 98, usedFraction: 0.02, remainingFraction: 0.98, unit: "percent" },
          status: "ok",
        },
      ],
      metadata: { planType: "free", allowed: true, limitReached: false, email: "someone@example.com", accountId: "b418" },
    },
  ],
};

describe("subscription limits", () => {
  it("reads Claude Code's five-hour and weekly windows", () => {
    expect(claudeLimits(claudeInfo, 5)).toEqual({
      id: "claude",
      source: "Claude Code",
      provider: "Anthropic",
      windows: [
        { label: "5 hours", used: 0.15, resetsAt: 1791407400000 },
        { label: "7 days", used: 0.55, resetsAt: 1791828000000 },
      ],
      limited: false,
      at: 5,
    });
    expect(claudeLimits({ status: "rejected", rateLimitType: "five_hour", resetsAt: 100 }).limited).toBe(true);
    expect(claudeLimits({ status: "rejected", rateLimitType: "five_hour", resetsAt: 100 }).windows).toEqual([{ label: "5 hours", used: null, resetsAt: 100_000 }]);
  });

  it("reads omp's accounts without their emails or ids", () => {
    const accounts = ompLimits(ompJson);
    expect(accounts).toEqual([
      {
        id: "omp:openai-codex:0",
        source: "omp",
        provider: "openai-codex",
        plan: "free",
        windows: [{ label: "30 days", used: 0.02, resetsAt: 1791746762000 }],
        limited: false,
        at: 1791392116560,
      },
    ]);
    expect(JSON.stringify(accounts)).not.toMatch(/example\.com|b418/);
    expect(ompLimits({ nope: true })).toEqual([]);
  });

  it("names two limits on one window by their own labels, as xAI's credits and GrokChat cap are", () => {
    const limit = (label: string, used: number) => ({ label, window: { label: "Weekly", resetsAt: 1792269519760 }, amount: { usedFraction: used }, status: "ok" });
    const [xai] = ompLimits({
      reports: [{ provider: "xai-oauth", fetchedAt: 1, limits: [limit("SuperGrok Weekly Credits", 0.34), limit("GrokChat (Weekly)", 0.34), { label: "Monthly cap", window: { label: "Monthly" }, amount: { usedFraction: 0.1 } }] }],
    });
    expect(xai?.windows.map((w) => w.label)).toEqual(["SuperGrok Weekly Credits", "GrokChat (Weekly)", "Monthly"]);
  });

  it("grades a window by how full it is and says when it resets", () => {
    expect([level(0.5), level(0.75), level(0.95), level(0.1, true)]).toEqual(["ok", "warn", "full", "full"]);
    const now = Date.UTC(2026, 9, 7, 12);
    expect(resetsIn(now + 40 * 60_000, now)).toBe("in 40m");
    expect(resetsIn(now + 192 * 60_000, now)).toBe("in 3h 12m");
    expect(resetsIn(now + 52 * 3600_000, now)).toBe("in 2d 4h");
  });

  it("shows an account heard both from a run and from a poll once, at its newer reading", async () => {
    const registry = new HarnessRegistry();
    const polled: LimitAccount = { id: "claude", source: "Claude Code", provider: "Anthropic", windows: [{ label: "5 hours", used: 0.7, resetsAt: null }], limited: false, at: 2000 };
    registry.register({ id: "claude", displayName: "Claude Code", usageLimits: async () => [polled] } as unknown as HarnessAdapter);
    registry.isAvailable = () => true;
    const limits = Limits.inMemory(registry);
    limits.report({ ...polled, windows: [{ label: "5 hours", used: 0.4, resetsAt: null }], at: 1000 });
    const got = await limits.get();
    expect(got.accounts).toHaveLength(1);
    expect(got.accounts[0]?.windows[0]?.used).toBe(0.7);
    limits.report({ ...polled, windows: [{ label: "5 hours", used: 0.9, resetsAt: null }], at: 3000 });
    expect((await limits.get()).accounts[0]?.windows[0]?.used).toBe(0.9);
  });
  it("serves a stale reading at once and refreshes it behind the request", async () => {
    vi.useFakeTimers();
    try {
      const account = (used: number): LimitAccount => ({ id: "claude", source: "Claude Code", provider: "Anthropic", windows: [{ label: "5 hours", used, resetsAt: null }], limited: false, at: used });
      let reading = 0.1;
      let release: (() => void) | null = null;
      let slow = false;
      const registry = new HarnessRegistry();
      registry.register({
        id: "claude",
        displayName: "Claude Code",
        usageLimits: async () => {
          if (slow) await new Promise<void>((resolve) => (release = resolve));
          return [account(reading)];
        },
      } as unknown as HarnessAdapter);
      registry.isAvailable = () => true;
      const limits = Limits.inMemory(registry);
      expect((await limits.get()).accounts[0]?.windows[0]?.used).toBe(0.1);
      reading = 0.2;
      expect((await limits.get(true)).accounts[0]?.windows[0]?.used).toBe(0.2);
      vi.setSystemTime(Date.now() + 61_000);
      slow = true;
      expect((await limits.get()).accounts[0]?.windows[0]?.used).toBe(0.2);
      reading = 0.3;
      slow = false;
      (release as (() => void) | null)?.();
      await vi.advanceTimersByTimeAsync(0);
      expect((await limits.get()).accounts[0]?.windows[0]?.used).toBe(0.3);
    } finally {
      vi.useRealTimers();
    }
  });
});
