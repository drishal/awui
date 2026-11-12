// When a routine next runs. Shared: the server schedules from it and the Routines
// dialog says when that will be.
//
// A cadence is read on a wall clock: this machine's own unless the routine names an
// IANA timezone, in which case the same minute of the same day in that zone (so a
// 09:00 routine in Berlin stays 09:00 across a DST change). The arithmetic runs on
// wall-clock readings held as UTC milliseconds (`wallAt`, `wallToEpoch`), so the
// calendar logic is one code path for both cases. A weekly day follows Date's
// convention (0 = Sunday). A cron expression is the familiar five fields
// (minute hour day-of-month month day-of-week) with `*`, `n`, `a-b`, `a-b/n`, `*/n`
// and comma lists; numbers only, and when both day fields are restricted a day
// matching either runs (Vixie cron's rule).
export type RoutineCadence =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number }
  | { kind: "cron"; expr: string }
  /** One run at an epoch: the next slot is that instant, and there is none after it. */
  | { kind: "once"; at: number };

const MIN = 60_000;
const DAY = 86_400_000;
/** How far ahead a cadence may look: a cron that matches nothing in a year is a typo. */
const HORIZON = 366 * DAY;
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** A cron expression is five short fields; longer than this is a typo, not a schedule. */
export const MAX_CRON_CHARS = 120;

// ---- the wall clock ------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The zone's formatter, or null for a name Intl does not know. */
function formatterFor(timezone: string): Intl.DateTimeFormat | null {
  const known = formatters.get(timezone);
  if (known) return known;
  try {
    const formatter = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    formatters.set(timezone, formatter);
    return formatter;
  } catch {
    return null;
  }
}

/** Why this timezone name cannot be used, or null when it can (and when it is left to this machine). */
export function zoneProblem(timezone: string): string | null {
  if (!timezone) return null;
  if (timezone.length > 64) return "a timezone name is at most 64 characters";
  return formatterFor(timezone) ? null : `"${timezone}" is not a timezone name this machine knows (try Europe/Berlin)`;
}

function zonedParts(at: number, formatter: Intl.DateTimeFormat): number[] {
  const parts = formatter.formatToParts(at);
  const pick = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? NaN);
  return [pick("year"), pick("month") - 1, pick("day"), pick("hour"), pick("minute")];
}

/** The wall clock reading at `at`, as a UTC Date value (so calendar math is plain UTC). */
function wallAt(at: number, timezone: string): number {
  if (!timezone) {
    const d = new Date(at);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes());
  }
  const formatter = formatterFor(timezone);
  if (!formatter) return NaN;
  const [y, mo, d, h, mi] = zonedParts(at, formatter) as [number, number, number, number, number];
  return Date.UTC(y, mo, d, h, mi);
}

/** The zone's offset at an instant, in milliseconds (positive east of UTC). */
function offsetAt(at: number, formatter: Intl.DateTimeFormat): number {
  const [y, mo, d, h, mi] = zonedParts(at, formatter) as [number, number, number, number, number];
  return Date.UTC(y, mo, d, h, mi) - at;
}

/** The instant a wall clock reading names in the zone (this machine's when it is empty). */
function wallToEpoch(wall: number, timezone: string): number {
  if (!Number.isFinite(wall)) return NaN;
  if (!timezone) {
    const w = new Date(wall);
    return new Date(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate(), w.getUTCHours(), w.getUTCMinutes()).getTime();
  }
  const formatter = formatterFor(timezone);
  if (!formatter) return NaN;
  // The reading taken as UTC, then corrected by the zone's offset ("read as UTC" twice, so
  // a DST boundary between the guess and the answer is taken into account).
  const guess = wall - offsetAt(wall, formatter);
  return wall - offsetAt(guess, formatter);
}

// ---- cron ----------------------------------------------------------------------

interface CronFields {
  minutes: Set<number>;
  hours: Set<number>;
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Whether each day field was restricted: a day then matches either one, as Vixie cron does. */
  daysOnly: boolean;
  weekdaysOnly: boolean;
}

const CRON_BOUNDS: Array<[number, number]> = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

/** One field's numbers, or null when it is not a list of valid ranges. */
function cronField(text: string, [low, high]: [number, number]): Set<number> | null {
  const out = new Set<number>();
  for (const item of text.split(",")) {
    const match = /^(\*|\d+(-\d+)?)(\/\d+)?$/.exec(item.trim());
    if (!match) return null;
    const spec = match[1] as string;
    const [from, to] = (spec === "*" ? [low, high] : spec.includes("-") ? spec.split("-").map(Number) : [Number(spec), Number(spec)]) as [number, number];
    const step = match[3] ? Number(match[3].slice(1)) : 1;
    if (!Number.isFinite(from) || !Number.isFinite(to) || step < 1) return null;
    if (from < low || to > high || from > to) return null;
    for (let n = from; n <= to; n += step) out.add(n);
  }
  return out.size > 0 ? out : null;
}

function cronParse(expr: string): CronFields | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minutes, hours, days, months, weekdays] = fields as [string, string, string, string, string];
  const parsed: Array<Set<number> | null> = [minutes, hours, days, months, weekdays].map((text, i) => cronField(text, CRON_BOUNDS[i] as [number, number]));
  const [m, h, dom, mo, dow] = parsed as [Set<number> | null, Set<number> | null, Set<number> | null, Set<number> | null, Set<number> | null];
  if (!m || !h || !dom || !mo || !dow) return null;
  // 7 is Sunday, as in some cron dialects; Date's own is 0.
  if (dow.delete(7)) dow.add(0);
  return { minutes: m, hours: h, days: dom, months: mo, weekdays: dow, daysOnly: days !== "*", weekdaysOnly: weekdays !== "*" };
}

/** Why a cron expression cannot run, or null when it is one this server understands. */
export function cronProblem(expr: string): string | null {
  if (!expr.trim()) return "a cron expression is five fields, e.g. 0 9 * * 1-5";
  if (expr.length > MAX_CRON_CHARS) return `a cron expression is at most ${MAX_CRON_CHARS} characters`;
  if (!cronParse(expr)) return "a cron expression is five fields of numbers: minute hour day-of-month month day-of-week (with *, a-b, */n and comma lists)";
  return null;
}

/** The first minute matching the expression after `from` (a wall clock value), or null. */
function cronNext(fields: CronFields, from: number): number | null {
  const end = from + HORIZON;
  let at = Math.floor(from / MIN) * MIN + MIN;
  while (at <= end) {
    const d = new Date(at);
    if (!fields.months.has(d.getUTCMonth() + 1)) {
      at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
      continue;
    }
    // Either day field alone is the rule; both together match either one, as Vixie cron does.
    const dayMatches =
      fields.daysOnly && fields.weekdaysOnly
        ? fields.days.has(d.getUTCDate()) || fields.weekdays.has(d.getUTCDay())
        : fields.daysOnly
          ? fields.days.has(d.getUTCDate())
          : fields.weekdaysOnly
            ? fields.weekdays.has(d.getUTCDay())
            : true;
    if (!dayMatches) {
      at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
      continue;
    }
    if (!fields.hours.has(d.getUTCHours())) {
      at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours() + 1);
      continue;
    }
    if (!fields.minutes.has(d.getUTCMinutes())) {
      at += MIN;
      continue;
    }
    return at;
  }
  return null;
}

// ---- the next slot -------------------------------------------------------------

/** The next slot of a cadence, as a wall clock value strictly after `wall`. */
function wallNext(cadence: Exclude<RoutineCadence, { kind: "once" }>, wall: number): number | null {
  const from = new Date(wall);
  const sameDay = (offset: number) => {
    const day = new Date(wall);
    day.setUTCDate(from.getUTCDate() + offset);
    day.setUTCHours(cadenceHour(cadence), cadenceMinute(cadence), 0, 0);
    return day;
  };
  switch (cadence.kind) {
    case "hourly": {
      const at = new Date(wall);
      at.setUTCMinutes(cadence.minute, 0, 0);
      if (at.getTime() <= wall) at.setUTCHours(at.getUTCHours() + 1);
      return at.getTime();
    }
    case "daily": {
      const today = sameDay(0);
      return today.getTime() > wall ? today.getTime() : sameDay(1).getTime();
    }
    case "weekdays":
    case "weekly": {
      for (let offset = 0; offset < 8; offset++) {
        const day = sameDay(offset);
        if (day.getTime() <= wall) continue;
        const weekday = day.getUTCDay();
        if (cadence.kind === "weekdays" ? weekday >= 1 && weekday <= 5 : weekday === cadence.weekday) return day.getTime();
      }
      // Unreachable: eight days always include the wanted weekday.
      return null;
    }
    case "cron": {
      const fields = cronParse(cadence.expr);
      return fields ? cronNext(fields, wall) : null;
    }
  }
}

const cadenceHour = (cadence: Exclude<RoutineCadence, { kind: "once" }>): number => ("hour" in cadence ? cadence.hour : 0);
const cadenceMinute = (cadence: Exclude<RoutineCadence, { kind: "once" }>): number => ("minute" in cadence ? cadence.minute : 0);

/** The first run strictly after `now`, on this machine's clock or in `timezone`, or null when there is none. */
export function nextRunAt(cadence: RoutineCadence, now = Date.now(), timezone = ""): number | null {
  if (cadence.kind === "once") return cadence.at > now ? cadence.at : null;
  let cursor = now;
  // A DST fold can map a wall clock reading to an instant before `now`: step past it.
  for (let tries = 0; tries < 4; tries++) {
    const wall = wallNext(cadence, wallAt(cursor, timezone));
    if (wall === null) return null;
    const at = wallToEpoch(wall, timezone);
    if (Number.isFinite(at) && at > now) return at;
    cursor = Number.isFinite(at) ? at + MIN : cursor + MIN;
  }
  return null;
}

/**
 * Why this cadence cannot run, or null when it can: a cron expression this server
 * does not read, a one-off in the past, or a schedule with no run in the next year.
 */
export function cadenceProblem(cadence: RoutineCadence, now = Date.now(), timezone = ""): string | null {
  const zone = zoneProblem(timezone);
  if (zone) return zone;
  if (cadence.kind === "cron") {
    const problem = cronProblem(cadence.expr);
    if (problem) return problem;
  }
  if (cadence.kind === "once") return cadence.at > now ? null : "a one-time run has to be in the future";
  return nextRunAt(cadence, now, timezone) === null ? "that schedule has no run in the next year" : null;
}

/** The dialog's own words for a cadence (its timezone is the row's to say, not the label's). */
export function cadenceLabel(cadence: RoutineCadence): string {
  const time = `${String("hour" in cadence ? cadence.hour : 0).padStart(2, "0")}:${String("minute" in cadence ? cadence.minute : 0).padStart(2, "0")}`;
  switch (cadence.kind) {
    case "hourly":
      return `every hour at :${String(cadence.minute).padStart(2, "0")}`;
    case "daily":
      return `every day at ${time}`;
    case "weekdays":
      return `weekdays at ${time}`;
    case "weekly":
      return `${WEEKDAYS[cadence.weekday] ?? "?"}s at ${time}`;
    case "cron":
      return `cron ${cadence.expr}`;
    case "once": {
      const at = new Date(cadence.at);
      return `once at ${at.toLocaleString()}`;
    }
  }
}
