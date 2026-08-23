import { describe, expect, it } from "bun:test";

import { UserError } from "../src/errors.ts";
import {
  calendarDayWindow,
  fmtLocal,
  parseDuration,
  resolveCalendarWindow,
  resolveTimeWindow,
  rollingWindow,
  windowLine,
} from "../src/period.ts";
import { renderMarkdownTable } from "../src/report.ts";
import type { AggRow } from "../src/cache.ts";

describe("parseDuration", () => {
  it("parses unit map incl. long forms", () => {
    expect(parseDuration("24h")).toBe(24 * 3_600_000);
    expect(parseDuration("2days")).toBe(2 * 86_400_000);
    expect(parseDuration("150m")).toBe(150 * 60_000);
    expect(parseDuration("30min")).toBe(30 * 60_000);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("1w")).toBe(7 * 86_400_000);
    expect(parseDuration("2 hours")).toBe(2 * 3_600_000);
  });

  it("returns null for non-durations and unknown units", () => {
    expect(parseDuration("week")).toBeNull();
    expect(parseDuration("24x")).toBeNull();
    expect(parseDuration("")).toBeNull();
  });
});

describe("resolveTimeWindow", () => {
  it("named periods are ROLLING (day = now-24h, not local midnight)", () => {
    const before = Date.now();
    const w = resolveTimeWindow({ last: "day" });
    const expected = new Date(before - 24 * 3600_000).getTime();
    expect(Math.abs(new Date(w.sinceIso).getTime() - expected)).toBeLessThan(5_000);
    expect(w.label).toBe("rolling day");
    expect(w.period).toBe("day");
  });

  it("durations produce a 'last <raw>' label", () => {
    const w = resolveTimeWindow({ last: "24h" });
    expect(w.label).toBe("last 24h");
    expect(w.period).toBeUndefined();
  });

  it("--from/--to are mutually exclusive with --last", () => {
    expect(() => resolveTimeWindow({ last: "week", from: "2026-08-20" })).toThrow(UserError);
  });

  it("bare --from/--to dates cover whole local days", () => {
    const w = resolveTimeWindow({ from: "2026-08-20", to: "2026-08-22" });
    expect(new Date(w.sinceIso).toISOString()).toBe(new Date(2026, 7, 20).toISOString());
    // to date ends at local 23:59:59.999
    expect(new Date(w.untilIso!).getHours()).toBe(23);
    expect(w.period).toBeUndefined();
  });

  it("rejects combining --from with --last", () => {
    expect(() => resolveTimeWindow({ last: "week", from: "2026-08-20" })).toThrow(UserError);
  });

  it("rejects invalid dates and durations with hints", () => {
    expect(() => resolveTimeWindow({ from: "not-a-date" })).toThrow(UserError);
    expect(() => resolveTimeWindow({ last: "24x" })).toThrow(UserError);
  });
});

describe("calendar windows", () => {
  it("today is a calendar window starting at local midnight", () => {
    const w = calendarDayWindow();
    const start = new Date(w.sinceIso);
    expect(start.getHours()).toBe(0);
    expect(start.getMinutes()).toBe(0);
    expect(w.label).toContain("calendar day");
  });

  it("trailing names map to day counts (quarter = 91 days)", () => {
    const w = resolveCalendarWindow({ last: "quarter" });
    expect(w.label).toBe("trailing quarter");
    const days = Math.round((Date.now() - new Date(w.sinceIso).getTime()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(90);
    expect(days).toBeLessThanOrEqual(91);
  });
});

describe("windowLine", () => {
  it("renders explicit period bounds", () => {
    const w = rollingWindow("week", new Date(2026, 7, 23, 14, 2));
    expect(windowLine(w)).toMatch(/^period: \d{4}-\d{2}-\d{2} \d{2}:\d{2} → \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(rolling week\)$/);
  });

  it("open-ended windows end at now", () => {
    const w = calendarDayWindow();
    expect(windowLine(w)).toContain("→ now (");
  });
});

describe("fmtLocal", () => {
  it("formats as YYYY-MM-DD HH:mm in local time", () => {
    expect(fmtLocal(new Date(2026, 7, 16, 14, 2).toISOString())).toBe("2026-08-16 14:02");
  });
});

const ROWS: AggRow[] = [
  {
    bucket: "gpt-5.6-luna",
    requests: 10,
    sessions: 2,
    inputTokens: 1_000_000,
    outputTokens: 50_000,
    cacheReadTokens: 900_000,
    cacheWriteTokens: 0,
    costUsd: 12.5,
  },
];

describe("renderMarkdownTable", () => {
  it("includes a period header and a GFM table with TOTAL row", () => {
    const md = renderMarkdownTable(ROWS, "2026-08-16 14:02 → now (rolling week)");
    expect(md).toContain("# tokitoki usage");
    expect(md).toContain("period: 2026-08-16 14:02 → now (rolling week)");
    expect(md).toContain("| name");
    expect(md).toMatch(/\| --- \|/);
    expect(md).toContain("**TOTAL**");
  });
});
