/**
 * Time-window resolution shared by the CLI and the web API.
 *
 * Semantics (documented everywhere a window is shown):
 * - `--last day|week|month|year` are ROLLING windows ending at "now"
 *   (now−24h, now−7d, now−30d). Only `today` uses a calendar day.
 * - `--last` also accepts durations: 24h, 2days, 150m, 30min, 90s, 1w
 * - `--from`/`--to` accept YYYY-MM-DD or full ISO timestamps; --to defaults
 *   to now. Mutually exclusive with --last.
 */
import { UserError } from "./errors.ts";

export type Period = "day" | "week" | "month" | "year";

export const PERIODS: Period[] = ["day", "week", "month", "year"];

/** A resolved query window in UTC ISO bounds + a human label. */
export interface TimeWindow {
  sinceIso: string;
  /** undefined = open-ended up to now */
  untilIso?: string;
  label: string;
  /**
   * Set only for named rolling periods — those are the windows that have an
   * equally-sized predecessor, which is what Δ needs.
   */
  period?: Period;
}

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  sec: 1_000,
  secs: 1_000,
  second: 1_000,
  seconds: 1_000,
  m: 60_000,
  min: 60_000,
  mins: 60_000,
  minute: 60_000,
  minutes: 60_000,
  h: 3_600_000,
  hr: 3_600_000,
  hrs: 3_600_000,
  hour: 3_600_000,
  hours: 3_600_000,
  d: 86_400_000,
  day: 86_400_000,
  days: 86_400_000,
  w: 604_800_000,
  week: 604_800_000,
  weeks: 604_800_000,
};

/** Parse `24h`, `2days`, `150m`, `30min`, `90s`, `1w` → ms (null when not a duration). */
export function parseDuration(raw: string): number | null {
  const match = /^(\d+)\s*([a-z]+)$/i.exec(raw.trim());
  if (match === null) return null;
  const unit = UNIT_MS[match[2]!.toLowerCase()];
  if (unit === undefined) return null;
  return Number(match[1]!) * unit;
}

/** True when raw is one of day|week|month|year. */
export function isNamedPeriod(raw: string): raw is Period {
  return PERIODS.includes(raw as Period);
}

interface ResolveOptions {
  last?: string;
  from?: string;
  to?: string;
  /** Used when no flag was given at all. */
  fallbackPeriod?: Period;
}

/** Parse a user-supplied date/datetime into UTC ISO. Local midnight for bare dates. */
function parseBound(raw: string, flag: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const d = new Date(`${raw}T00:00:00`);
    if (Number.isNaN(d.getTime())) throw rangeError(raw, flag);
    if (flag === "--from") return d.toISOString();
    // bare --to date covers the whole local day
    return endOfLocalDay(d);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw rangeError(raw, flag);
  return d.toISOString();
}

function rangeError(raw: string, flag: string): UserError {
  return new UserError(
    `invalid ${flag}: '${raw}' (expected YYYY-MM-DD or an ISO timestamp)`,
    `tokitoki report --from 2026-08-20 --to 2026-08-22`,
  );
}

function endOfLocalDay(d: Date): string {
  const local = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return local.toISOString();
}

/**
 * Resolve CLI/API window flags into concrete bounds.
 *
 * Precedence: --from/--to wins over --last; --last accepts named periods and
 * durations; nothing given falls back to fallbackPeriod (default week).
 */
export function resolveTimeWindow(opts: ResolveOptions): TimeWindow {
  const hasFrom = opts.from !== undefined && opts.from.length > 0;
  const hasTo = opts.to !== undefined && opts.to.length > 0;
  const hasLast = opts.last !== undefined && opts.last.length > 0;

  if ((hasFrom || hasTo) && hasLast) {
    throw new UserError(
      "--from/--to cannot be combined with --last",
      "tokitoki report --from 2026-08-20 --to 2026-08-22",
    );
  }

  if (hasFrom || hasTo) {
    const sinceIso = hasFrom ? parseBound(opts.from!, "--from") : "";
    const untilIso = hasTo ? parseBound(opts.to!, "--to") : undefined;
    return { sinceIso, untilIso, label: "absolute range (--from/--to)" };
  }

  if (hasLast && !isNamedPeriod(opts.last!)) {
    const ms = parseDuration(opts.last!);
    if (ms === null) {
      throw new UserError(
        `invalid --last: '${opts.last}' (valid: day|week|month|year, or durations like 24h, 2days, 150m, 1w)`,
        "tokitoki report --last 24h",
      );
    }
    return {
      sinceIso: new Date(Date.now() - ms).toISOString(),
      label: `last ${opts.last!.trim()}`,
    };
  }

  const period = (hasLast ? (opts.last as Period) : (opts.fallbackPeriod ?? "week")) as Period;
  return rollingWindow(period);
}

/** Rolling named-period window: now − N·24h (day = 24h, NOT calendar day). */
export function rollingWindow(period: Period, now: Date = new Date()): TimeWindow {
  const ms = period === "day"
    ? 86_400_000
    : period === "week"
      ? 7 * 86_400_000
      : period === "month"
        ? 30 * 86_400_000
        : 365 * 86_400_000;
  return {
    sinceIso: new Date(now.getTime() - ms).toISOString(),
    label: `rolling ${period}`,
    period,
  };
}

/** Calendar day so far: local midnight → now. Used by `today`. */
export function calendarDayWindow(now: Date = new Date()): TimeWindow {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let tz = "local";
  try {
    tz = Intl.DateTimeFormat().resolvedOptions().timeZone ?? tz;
  } catch {
    // no IANA tz available — stay generic
  }
  return { sinceIso: start.toISOString(), label: `calendar day, ${tz} local` };
}

/** "2026-08-16 14:02"-style local timestamp for human-facing headers. */
export function fmtLocal(iso: string): string {
  if (iso === "(beginning)") return iso;
  const d = new Date(iso);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** The explicit header/footer line printed by every time-based command. */
export function windowLine(w: TimeWindow): string {
  // Rolling windows end "now" by definition — print the concrete timestamp;
  // open-ended calendar windows just say "now".
  const until = w.untilIso === undefined
    ? w.period !== undefined
      ? fmtLocal(new Date().toISOString())
      : "now"
    : fmtLocal(w.untilIso);
  return `period: ${fmtLocal(w.sinceIso)} → ${until} (${w.label})`;
}

/** Named trailing day-counts for the calendar-style commands (grid/anomalies). */
export const CALENDAR_WINDOWS = { day: 1, week: 7, month: 30, quarter: 91, year: 365 } as const;

export type CalendarWindowName = keyof typeof CALENDAR_WINDOWS;

/**
 * Window for calendar-style commands: named trailing day-counts
 * (month/quarter/year), durations (--last 90d) or absolute --from/--to.
 */
export function resolveCalendarWindow(
  opts: ResolveOptions,
  fallbackName: CalendarWindowName = "month",
): TimeWindow {
  const hasRange =
    (opts.from !== undefined && opts.from.length > 0) || (opts.to !== undefined && opts.to.length > 0);
  if (hasRange) return resolveTimeWindow({ from: opts.from, to: opts.to });

  const raw = opts.last;
  if (raw !== undefined && raw.length > 0 && !(raw in CALENDAR_WINDOWS)) {
    const ms = parseDuration(raw);
    if (ms === null) {
      throw new UserError(
        `invalid window: '${raw}' (valid: ${Object.keys(CALENDAR_WINDOWS).join(", ")}, or durations like 24h, 30d, 1w)`,
        `tokitoki grid --last ${fallbackName}`,
      );
    }
    return { sinceIso: new Date(Date.now() - ms).toISOString(), label: `last ${raw}` };
  }

  const name = (raw !== undefined && raw in CALENDAR_WINDOWS ? raw : fallbackName) as CalendarWindowName;
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (CALENDAR_WINDOWS[name] - 1));
  return { sinceIso: start.toISOString(), label: `trailing ${name}` };
}
