import { EventCache, type AggRow } from "../cache.ts";
import { loadConfig, type TokitokiConfig } from "../config.ts";
import { cachePct } from "../format.ts";
import {
  burnProjection,
  monthStartIso,
  previousWindow,
  resolveExtraFiles,
  sinceIsoFor,
  totalTokens,
} from "../report.ts";

/** JSON responses reuse the exact CLI aggregation — no duplicated SQL. */

function withCache<T>(fn: (cache: EventCache) => T): T {
  const cache = new EventCache();
  try {
    // Same merge path as the CLI reports: local log + configured extras.
    cache.sync(resolveExtraFiles());
    return fn(cache);
  } finally {
    cache.close();
  }
}

export interface SummaryPayload {
  period: "week";
  cost: number;
  requests: number;
  sessions: number;
  tokens: number;
  cachePct: number;
  prevWeekCost: number | null;
  burnPerDay: number;
  projectedMonthEnd: number;
}

export function apiSummary(): SummaryPayload {
  return withCache((cache) => {
    const since = sinceIsoFor("week");
    const totals = cache.totals(since);
    const prev = previousWindow("week");
    const prevTotals = cache.totals(prev.sinceIso, undefined, prev.untilIso);
    const mtd = cache.totals(monthStartIso());
    const b = burnProjection(mtd.costUsd);
    return {
      period: "week",
      cost: round2(totals.costUsd),
      requests: totals.requests,
      sessions: totals.sessions,
      tokens: totalTokens(totals),
      cachePct: cachePct(totals.inputTokens, totals.cacheReadTokens),
      prevWeekCost: prevTotals.requests > 0 ? round2(prevTotals.costUsd) : null,
      burnPerDay: round2(b.perDay),
      projectedMonthEnd: round2(b.projected),
    };
  });
}

const SERIES_DIMS = ["provider", "model", "account", "machine"] as const;

export interface TimeseriesPayload {
  by: string;
  days: string[];
  series: Array<{ bucket: string; values: number[] }>;
}

export function apiTimeseries(by: string, days: number): TimeseriesPayload {
  if (!SERIES_DIMS.includes(by as (typeof SERIES_DIMS)[number])) {
    throw new Error(`invalid --by for timeseries: ${by} (valid: ${SERIES_DIMS.join(", ")})`);
  }
  const clampedDays = Math.max(1, Math.min(days, 120));
  const since = new Date(Date.now() - clampedDays * 24 * 3600_000).toISOString();
  return withCache((cache) => {
    const buckets = cache.seriesDaily(
      since,
      by as Exclude<(typeof SERIES_DIMS)[number], never>,
    );
    // Union of all bucket days so every series shares one x-axis.
    const daySet = new Set<string>();
    for (const s of buckets) for (const d of s.days) daySet.add(d);
    const allDays = [...daySet].sort();
    return {
      by,
      days: allDays,
      series: buckets.map((s) => ({
        bucket: s.bucket,
        values: allDays.map((d) => {
          const i = s.days.indexOf(d);
          return i >= 0 ? s.values[i]! : 0;
        }),
      })),
    };
  });
}

const TABLE_DIMS = ["provider", "model", "account", "machine", "project"] as const;
const PERIODS = ["day", "week", "month"] as const;

export interface TablePayload {
  by: string;
  rows: Array<AggRow & { sharePct: number }>;
  total: AggRow & { sharePct: number };
  /** Every accountKey seen this period — drives the multi-account tabs. */
  accounts: Array<{ key: string; requests: number }>;
}

export function apiTable(by: string, period: string, filterAccount?: string): TablePayload {
  if (!TABLE_DIMS.includes(by as (typeof TABLE_DIMS)[number])) {
    throw new Error(`invalid dimension: ${by} (valid: ${TABLE_DIMS.join(", ")})`);
  }
  if (!PERIODS.includes(period as (typeof PERIODS)[number])) {
    throw new Error(`invalid period: ${period} (valid: ${PERIODS.join(", ")})`);
  }
  const since = sinceIsoFor(period as (typeof PERIODS)[number]);
  return withCache((cache) => {
    const cfg: TokitokiConfig = loadConfig();
    const accounts = cache
      .aggregate(since, "account")
      .map((r) => ({ key: r.bucket, requests: r.requests }))
      .sort((a, b) => b.requests - a.requests);

    // Account tabs scope every view to one accountKey exactly.
    const rows0 = cache.aggregate(
      since,
      by as (typeof TABLE_DIMS)[number],
      undefined,
      undefined,
      filterAccount,
    );
    const total = cache.totals(since, undefined, undefined, filterAccount);
    const shareBasis = total.costUsd > 0 ? total.costUsd : totalTokens(total);
    const withShare = (r: AggRow): AggRow & { sharePct: number } => ({
      ...r,
      sharePct:
        shareBasis > 0 ? Math.round(((total.costUsd > 0 ? r.costUsd : totalTokens(r)) / shareBasis) * 100) : 0,
    });
    void cfg;
    return {
      by,
      rows: sortRowsByCost(rows0).map(withShare),
      total: withShare(total),
      accounts,
    };
  });
}

function sortRowsByCost(rows: AggRow[]): AggRow[] {
  return [...rows].sort(
    (a, b) => b.costUsd - a.costUsd || b.requests - a.requests || a.bucket.localeCompare(b.bucket),
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
