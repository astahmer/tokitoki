import { EventCache, type AggRow } from "../cache.ts";
import { loadConfig, type TokitokiConfig } from "../config.ts";
import { accountEmailMap } from "../accounts.ts";
import { cachePct } from "../format.ts";
import {
  burnProjection,
  matchPlanKey,
  monthStartIso,
  planGaugeFn,
  previousWindow,
  resolveExtraFiles,
  sinceIsoFor,
  sinceIsoForDays,
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

const TABLE_DIMS = ["provider", "model", "account", "machine", "project", "repo"] as const;
const PERIODS = ["day", "week", "month"] as const;

export interface GaugeInfo {
  frac: number;
  label: string;
}

export interface TablePayload {
  by: string;
  rows: Array<AggRow & { sharePct: number }>;
  total: AggRow & { sharePct: number };
  /** Every accountKey seen this period — drives the multi-account tabs. */
  accounts: Array<{ key: string; requests: number; email: string | null }>;
  /** Previous-period cost per bucket, for Δ badges (absent when delta=0). */
  prevCostById?: Record<string, number>;
  totalPrevCost?: number;
  /** Plan-quota gauges per bucket, from config [plans]. */
  gauges: Record<string, GaugeInfo>;
  /** accountKey → email, present when showEmail=1 and resolvable. */
  emails?: Record<string, string>;
}

export function apiTable(
  by: string,
  period: string,
  filterAccount?: string,
  providers: string[] = [],
  delta = true,
  showEmail = false,
): TablePayload {
  if (!TABLE_DIMS.includes(by as (typeof TABLE_DIMS)[number])) {
    throw new Error(`invalid dimension: ${by} (valid: ${TABLE_DIMS.join(", ")})`);
  }
  if (!PERIODS.includes(period as (typeof PERIODS)[number])) {
    throw new Error(`invalid period: ${period} (valid: ${PERIODS.join(", ")})`);
  }
  const providerFilter = providers.length > 0 ? providers : undefined;
  const since = sinceIsoFor(period as (typeof PERIODS)[number]);
  return withCache((cache) => {
    void loadConfig();
    const accounts = cache
      .aggregate(since, "account", providerFilter)
      .map((r) => ({ key: r.bucket, requests: r.requests, email: null as string | null }))
      .sort((a, b) => b.requests - a.requests);

    // Account tabs scope every view to one accountKey exactly.
    const rows0 = cache.aggregate(
      since,
      by as (typeof TABLE_DIMS)[number],
      providerFilter,
      undefined,
      filterAccount,
    );
    const total = cache.totals(since, providerFilter, undefined, filterAccount);
    const shareBasis = total.costUsd > 0 ? total.costUsd : totalTokens(total);
    const withShare = (r: AggRow): AggRow & { sharePct: number } => ({
      ...r,
      sharePct:
        shareBasis > 0 ? Math.round(((total.costUsd > 0 ? r.costUsd : totalTokens(r)) / shareBasis) * 100) : 0,
    });

    const payload: TablePayload = {
      by,
      rows: sortRowsByCost(rows0).map(withShare),
      total: withShare(total),
      accounts,
      gauges: {},
    };

    if (delta) {
      const prev = previousWindow(period as (typeof PERIODS)[number]);
      const prevRows = cache.aggregate(prev.sinceIso, by as (typeof TABLE_DIMS)[number], providerFilter, prev.untilIso);
      payload.prevCostById = Object.fromEntries(prevRows.map((r) => [r.bucket, round2(r.costUsd)]));
      payload.totalPrevCost = round2(cache.totals(prev.sinceIso, providerFilter, prev.untilIso).costUsd);
    }

    // Plan gauges mirror the CLI's [plans] config semantics.
    const cfg: TokitokiConfig = loadConfig();
    if (cfg.plans !== undefined && Object.keys(cfg.plans).length > 0) {
      const gaugeFn = planGaugeFn(cfg.plans, new Map());
      void gaugeFn;
      const mtdByAccount = new Map(
        cache.aggregate(monthStartIso(), "account", providerFilter).map((r) => [r.bucket, r]),
      );
      for (const r of rows0) {
        const key = matchPlanKey(cfg.plans!, r.bucket);
        if (key === undefined) continue;
        const plan = cfg.plans![key]!;
        const usage = mtdByAccount.get(r.bucket);
        if (plan.monthlyRequestCap !== undefined && plan.monthlyRequestCap > 0) {
          payload.gauges[r.bucket] = {
            frac: usage === undefined ? 0 : usage.requests / plan.monthlyRequestCap,
            label: `of ${plan.monthlyRequestCap.toLocaleString()} req cap`,
          };
        } else if (plan.monthlyCostCap !== undefined && plan.monthlyCostCap > 0) {
          payload.gauges[r.bucket] = {
            frac: usage === undefined ? 0 : usage.costUsd / plan.monthlyCostCap,
            label: `of $${plan.monthlyCostCap} cap`,
          };
        }
      }
    }

    // Emails key off accounts and always ride the account tabs, regardless
    // of which dimension the table is grouped by.
    if (showEmail) {
      const providersByKey = new Map<string, Set<string>>();
      for (const [key, provider] of cache.accountProviders(since)) {
        let set = providersByKey.get(key);
        if (set === undefined) {
          set = new Set();
          providersByKey.set(key, set);
        }
        set.add(provider);
      }
      const emails = accountEmailMap(accounts.map((a) => a.key), providersByKey);
      if (emails.size > 0) payload.emails = Object.fromEntries(emails);
      for (const a of accounts) a.email = emails.get(a.key) ?? null;
    }
    return payload;
  });
}

export interface GridPayload {
  metric: string;
  cells: Array<{ day: string; tokens: number; costUsd: number; requests: number }>;
}

/** Daily metrics for the calendar heatmap (max 366 days). */
export function apiGrid(daysParam: number, metric: string): GridPayload {
  if (!["tokens", "cost", "requests"].includes(metric)) {
    throw new Error(`invalid metric: ${metric} (valid: tokens, cost, requests)`);
  }
  const clamped = Math.max(7, Math.min(daysParam, 366));
  return withCache((cache) => {
    return { metric, cells: cache.dailyTotals(sinceIsoForDays(clamped)) };
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
