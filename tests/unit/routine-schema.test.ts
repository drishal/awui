// The routines dialog's wire shape: a prompt on a cadence, validated.
import { describe, expect, it } from "vitest";
import { routineSchema } from "../../src/shared/protocol.js";

const base = { name: "Nightly review", prompt: "Review today's commits", harnessId: "pi", workspaceId: "w1" };

describe("a routine's shape", () => {
  it("accepts every cadence, and enabled by default", () => {
    const parsed = routineSchema.parse({ ...base, cadence: { kind: "daily", hour: 9, minute: 0 } });
    expect(parsed.enabled).toBe(true);
    for (const cadence of [
      { kind: "hourly", minute: 30 },
      { kind: "daily", hour: 9, minute: 0 },
      { kind: "weekdays", hour: 8, minute: 30 },
      { kind: "weekly", weekday: 1, hour: 9, minute: 0 },
      { kind: "cron", expr: "0 9 * * 1-5" },
      { kind: "once", at: Date.now() + 3_600_000 },
    ]) {
      expect(routineSchema.safeParse({ ...base, cadence }).success).toBe(true);
    }
  });

  it("refuses a time that does not exist, a nameless or empty routine", () => {
    expect(routineSchema.safeParse({ ...base, cadence: { kind: "daily", hour: 24, minute: 0 } }).success).toBe(false);
    expect(routineSchema.safeParse({ ...base, cadence: { kind: "daily", hour: 9, minute: 60 } }).success).toBe(false);
    expect(routineSchema.safeParse({ ...base, cadence: { kind: "weekly", weekday: 7, hour: 9, minute: 0 } }).success).toBe(false);
    expect(routineSchema.safeParse({ ...base, name: "   ", cadence: { kind: "hourly", minute: 0 } }).success).toBe(false);
    expect(routineSchema.safeParse({ ...base, prompt: "", cadence: { kind: "hourly", minute: 0 } }).success).toBe(false);
    expect(routineSchema.safeParse({ ...base, cadence: { kind: "monthly", day: 1 } }).success).toBe(false);
  });

  it("carries no precheck by default, and trims the one given", () => {
    const cadence = { kind: "hourly", minute: 0 };
    expect(routineSchema.parse({ ...base, cadence }).precheck).toBe("");
    expect(routineSchema.parse({ ...base, cadence, precheck: "  git diff --quiet  " }).precheck).toBe("git diff --quiet");
    expect(routineSchema.safeParse({ ...base, cadence, precheck: "x".repeat(501) }).success).toBe(false);
  });

  it("carries no timezone, expiry, cap or grace by default, and bounds each one", () => {
    const cadence = { kind: "hourly", minute: 0 };
    expect(routineSchema.parse({ ...base, cadence })).toMatchObject({ timezone: "", until: null, maxRuns: null, graceMinutes: 0 });
    expect(routineSchema.safeParse({ ...base, cadence, timezone: "x".repeat(65) }).success).toBe(false);
    expect(routineSchema.safeParse({ ...base, cadence, maxRuns: 0 }).success).toBe(false);
    expect(routineSchema.safeParse({ ...base, cadence, graceMinutes: 1441 }).success).toBe(false);
    expect(routineSchema.safeParse({ ...base, cadence: { kind: "cron", expr: "x".repeat(121) } }).success).toBe(false);
    expect(routineSchema.safeParse({ ...base, cadence, until: -1 }).success).toBe(false);
  });

  it("keeps the id when it is editing one", () => {
    const parsed = routineSchema.parse({ ...base, id: "r-1", cadence: { kind: "hourly", minute: 5 }, enabled: false });
    expect(parsed.id).toBe("r-1");
    expect(parsed.enabled).toBe(false);
  });
});
