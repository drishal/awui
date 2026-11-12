// A routine's cadence (routine-schedule.ts): when it next runs, and how it reads.
import { describe, expect, it } from "vitest";
import { cadenceLabel, cadenceProblem, nextRunAt, zoneProblem } from "../../src/shared/routine-schedule.js";

const at = (day: number, hour: number, minute = 0) => new Date(2026, 9, day, hour, minute, 0, 0);
const same = (got: number | null, want: Date) => expect(new Date(got ?? 0).toString()).toBe(want.toString());

describe("a routine's next run", () => {
  it("hourly is the next :MM, strictly after now", () => {
    same(nextRunAt({ kind: "hourly", minute: 30 }, at(9, 10, 45).getTime()), at(9, 11, 30));
    same(nextRunAt({ kind: "hourly", minute: 30 }, at(9, 10, 30).getTime()), at(9, 11, 30));
  });

  it("daily is today if the time is still ahead, else tomorrow", () => {
    same(nextRunAt({ kind: "daily", hour: 9, minute: 0 }, at(9, 8, 0).getTime()), at(9, 9, 0));
    same(nextRunAt({ kind: "daily", hour: 9, minute: 0 }, at(9, 9, 0).getTime()), at(10, 9, 0));
  });

  it("weekdays skip the weekend, and today counts when it is still ahead", () => {
    // Friday 9 October 2026.
    same(nextRunAt({ kind: "weekdays", hour: 9, minute: 0 }, at(9, 8, 0).getTime()), at(9, 9, 0));
    same(nextRunAt({ kind: "weekdays", hour: 9, minute: 0 }, at(9, 10, 0).getTime()), at(12, 9, 0));
    // Saturday asks for Monday.
    same(nextRunAt({ kind: "weekdays", hour: 9, minute: 0 }, at(10, 10, 0).getTime()), at(12, 9, 0));
  });

  it("weekly waits for its weekday, a week out when today's time has gone", () => {
    // Monday 12 October 2026.
    same(nextRunAt({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }, at(12, 8, 0).getTime()), at(12, 9, 0));
    same(nextRunAt({ kind: "weekly", weekday: 1, hour: 9, minute: 0 }, at(12, 9, 30).getTime()), at(19, 9, 0));
  });

  it("reads as the dialog says it", () => {
    expect(cadenceLabel({ kind: "hourly", minute: 5 })).toBe("every hour at :05");
    expect(cadenceLabel({ kind: "daily", hour: 9, minute: 0 })).toBe("every day at 09:00");
    expect(cadenceLabel({ kind: "weekdays", hour: 8, minute: 30 })).toBe("weekdays at 08:30");
    expect(cadenceLabel({ kind: "weekly", weekday: 1, hour: 9, minute: 0 })).toBe("Mondays at 09:00");
  });
});

describe("a cron cadence", () => {
  it("runs at the minutes the expression names", () => {
    // Friday 9 October 2026, 08:07 local.
    const from = at(9, 8, 7).getTime();
    same(nextRunAt({ kind: "cron", expr: "0 9 * * *" }, from), at(9, 9, 0));
    same(nextRunAt({ kind: "cron", expr: "*/15 * * * *" }, from), at(9, 8, 15));
    // Weekdays only: Saturday asks for Monday.
    same(nextRunAt({ kind: "cron", expr: "30 8 * * 1-5" }, at(10, 9, 0).getTime()), at(12, 8, 30));
    // A day of the month, or a weekday, matches either (Vixie cron's rule).
    same(nextRunAt({ kind: "cron", expr: "0 12 1 * 0" }, from), at(11, 12, 0));
  });

  it("says why an expression cannot run", () => {
    expect(cadenceProblem({ kind: "cron", expr: "0 9 * *" })).toMatch(/five fields/);
    expect(cadenceProblem({ kind: "cron", expr: "0 9 * * 1-9" })).toMatch(/five fields/);
    expect(cadenceProblem({ kind: "cron", expr: "0 9 30 2 *" })).toMatch(/no run in the next year/);
    expect(cadenceProblem({ kind: "cron", expr: "0 9 * * 1-5" })).toBeNull();
    expect(cadenceProblem({ kind: "daily", hour: 9, minute: 0 })).toBeNull();
    expect(cadenceProblem({ kind: "once", at: 1000 }, 2000)).toMatch(/future/);
  });
});

describe("a timezone", () => {
  it("reads the cadence on that zone's clock", () => {
    // 09:00 in Berlin is 07:00 UTC in winter (CET) and 07:00 UTC in summer (CEST is 05:00).
    const winter = Date.UTC(2026, 0, 15, 6, 0); // 07:00 Berlin, so today's 09:00 is ahead
    const got = nextRunAt({ kind: "daily", hour: 9, minute: 0 }, winter, "Europe/Berlin");
    expect(new Date(got ?? 0).toISOString()).toBe(new Date(Date.UTC(2026, 0, 15, 8, 0)).toISOString());
    // In July the same wall clock is 07:00 UTC: CEST is two hours ahead.
    const summer = Date.UTC(2026, 6, 15, 5, 30);
    const got2 = nextRunAt({ kind: "daily", hour: 9, minute: 0 }, summer, "Europe/Berlin");
    expect(new Date(got2 ?? 0).toISOString()).toBe(new Date(Date.UTC(2026, 6, 15, 7, 0)).toISOString());
  });

  it("refuses a name this machine does not know", () => {
    expect(zoneProblem("")).toBeNull();
    expect(zoneProblem("Europe/Berlin")).toBeNull();
    expect(zoneProblem("Mars/Olympus")).toMatch(/not a timezone name/);
  });

  it("a one-off runs at its instant, and then not again", () => {
    const at1000 = at(9, 9, 0).getTime();
    same(nextRunAt({ kind: "once", at: at1000 }, at1000 - 1000), at(9, 9, 0));
    expect(nextRunAt({ kind: "once", at: at1000 }, at1000)).toBeNull();
    expect(cadenceLabel({ kind: "once", at: at1000 })).toMatch(/^once at /);
    expect(cadenceLabel({ kind: "cron", expr: "0 9 * * 1-5" })).toBe("cron 0 9 * * 1-5");
  });
});
