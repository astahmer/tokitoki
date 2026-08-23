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
  renderMarkdownTable,
  repoEfficiency,
  resolveExtraFiles,
  sinceIsoForDays,
  totalTokens,
} from "../report.ts";
import {
  resolveCalendarWindow,
  resolveTimeWindow,
  type Period,
  type TimeWindow,
} from "../period.ts";
import { collectSources } from "../sources.ts";
import { detectAnomalies, type AnomalyMetric } from "../anomalies.ts";

/** JSON responses reuse the exact CLI aggregation — no duplicated SQL. */

/** Query-window params shared by every time-based endpoint. */
export interface WindowParams {
  /** day|week|month or a duration like 24h / 2days / 150m */
  last?: string;
  from?: string;
  to?: string;
}

export interface ApiWindow {
  since: string;
  until: string | null;
  label: string;
}

function toApiWindow(w: TimeWindow): ApiWindow {
  return { since: w.sinceIso, until: w.untilIso ?? null, label: w.label };
}

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
  window: ApiWindow;
  cost: number;
  requests: number;
  sessions: number;
  tokens: number;
  cachePct: number;
  prevWeekCost: number | null;
  burnPerDay: number;
  projectedMonthEnd: number;
}

export function apiSummary(wp: WindowParams = {}): SummaryPayload {
  return withCache((cache) => {
    const w = resolveTimeWindow({ ...wp, fallbackPeriod: "week" });
    const totals = cache.totals(w.sinceIso, undefined, w.untilIso);
    const prev = w.period !== undefined ? previousWindow(w.period) : null;
    const prevTotals = prev !== null ? cache.totals(prev.sinceIso, undefined, prev.untilIso) : null;
    const mtd = cache.totals(monthStartIso());
    const b = burnProjection(mtd.costUsd);
    return {
      window: toApiWindow(w),
      cost: round2(totals.costUsd),
      requests: totals.requests,
      sessions: totals.sessions,
      tokens: totalTokens(totals),
      cachePct: cachePct(totals.inputTokens, totals.cacheReadTokens),
      prevWeekCost: prevTotals !== null && prevTotals.requests > 0 ? round2(prevTotals.costUsd) : null,
      burnPerDay: round2(b.perDay),
      projectedMonthEnd: round2(b.projected),
    };
  });
}

const SERIES_DIMS = ["provider", "model", "account", "machine"] as const;

export interface TimeseriesPayload {
  by: string;
  window: ApiWindow;
  days: string[];
  series: Array<{ bucket: string; values: number[] }>;
}

export function apiTimeseries(by: string, wp: WindowParams & { days?: number } = {}): TimeseriesPayload {
  if (!SERIES_DIMS.includes(by as (typeof SERIES_DIMS)[number])) {
    throw new Error(`invalid --by for timeseries: ${by} (valid: ${SERIES_DIMS.join(", ")})`);
  }
  let w: TimeWindow;
  if (wp.last !== undefined || wp.from !== undefined || wp.to !== undefined) {
    w = resolveTimeWindow({ ...wp, fallbackPeriod: "month" });
  } else {
    const clampedDays = Math.max(1, Math.min(wp.days ?? 30, 120));
    w = { sinceIso: new Date(Date.now() - clampedDays * 24 * 3600_000).toISOString(), label: `last ${clampedDays}d` };
  }
  return withCache((cache) => {
    const buckets = cache.seriesDaily(
      w.sinceIso,
      by as Exclude<(typeof SERIES_DIMS)[number], never>,
    );
    // Union of all bucket days so every series shares one x-axis.
    const daySet = new Set<string>();
    for (const s of buckets) for (const d of s.days) daySet.add(d);
    const allDays = [...daySet].sort();
    return {
      by,
      window: toApiWindow(w),
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
  window: ApiWindow;
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
  /** Repo efficiency metrics per bucket, only when by=repo. */
  efficiency?: Record<string, ReturnType<typeof repoEfficiency>>;
}

export function apiTable(
  by: string,
  wp: WindowParams,
  legacyPeriod: string,
  filterAccount?: string,
  providers: string[] = [],
  delta = true,
  showEmail = false,
): TablePayload {
  if (!TABLE_DIMS.includes(by as (typeof TABLE_DIMS)[number])) {
    throw new Error(`invalid dimension: ${by} (valid: ${TABLE_DIMS.join(", ")})`);
  }
  if (!PERIODS.includes((wp.last ?? legacyPeriod) as (typeof PERIODS)[number]) && wp.last !== undefined && !/^\d+\s*[a-z]+$/i.test(wp.last)) {
    throw new Error(`invalid period: ${wp.last} (valid: ${PERIODS.join(", ")} or durations like 24h)`);
  }
  const w = resolveTimeWindow({ ...wp, fallbackPeriod: legacyPeriod as Period });
  const providerFilter = providers.length > 0 ? providers : undefined;
  const since = w.sinceIso;
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
      window: toApiWindow(w),
      rows: sortRowsByCost(rows0).map(withShare),
      total: withShare(total),
      accounts,
      gauges: {},
    };

    if (delta && w.period !== undefined) {
      const prev = previousWindow(w.period);
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
    // Repo efficiency metrics ride along when grouping by repo.
    if (by === "repo") {
      const prevRows = new Map<string, AggRow>();
      if (w.period !== undefined) {
        const prev = previousWindow(w.period);
        for (const r of cache.aggregate(prev.sinceIso, "repo", providerFilter, prev.untilIso)) prevRows.set(r.bucket, r);
      }
      payload.efficiency = Object.fromEntries(
        rows0.map((r) => [r.bucket, repoEfficiency(r, prevRows.get(r.bucket))]),
      );
    }
    return payload;
  });
}

export interface AnomaliesPayload {
  window: ApiWindow;
  metric: string;
  anomalies: Array<{ day: string; metric: string; value: number; baseline: number; ratio: number }>;
}

/** Spike days for the menubar/web badge. */
export function apiAnomalies(wp: WindowParams = {}, metric = "tokens"): AnomaliesPayload {
  const w = resolveCalendarWindow(wp, "month");
  return withCache((cache) => {
    void loadConfig();
    const daily = cache.dailyTotals(w.sinceIso, w.untilIso);
    return {
      window: toApiWindow(w),
      metric,
      anomalies: detectAnomalies(daily, { metric: metric as AnomalyMetric }),
    };
  });
}

export interface GridPayload {
  metric: string;
  window: ApiWindow;
  cells: Array<{ day: string; tokens: number; costUsd: number; requests: number }>;
}

/** Daily metrics for the calendar heatmap (max 366 days). */
export function apiGrid(wp: WindowParams & { days?: number }, metric: string): GridPayload {
  if (!["tokens", "cost", "requests"].includes(metric)) {
    throw new Error(`invalid metric: ${metric} (valid: tokens, cost, requests)`);
  }
  let w: TimeWindow;
  if (wp.last !== undefined || wp.from !== undefined || wp.to !== undefined) {
    w = resolveCalendarWindow(wp, "year");
  } else {
    const clamped = Math.max(7, Math.min(wp.days ?? 365, 366));
    w = { sinceIso: sinceIsoForDays(clamped), label: `trailing ${clamped}d` };
  }
  return withCache((cache) => {
    return { metric, window: toApiWindow(w), cells: cache.dailyTotals(w.sinceIso, w.untilIso) };
  });
}

const SESSION_BY = ["provider", "repo"] as const;

export interface SessionsPayload {
  window: ApiWindow;
  rows: Array<{
    sessionId: string;
    provider: string;
    accountKey: string;
    startedAt: string;
    requests: number;
    models: string[];
    repos: string[];
    totalTokens: number;
    cachePct: number;
    costUsd: number;
  }>;
}

/** Session leaderboard — same aggregation as the CLI `sessions` command. */
export function apiSessions(
  wp: WindowParams,
  providers: string[] = [],
  account?: string,
  top = 25,
  legacyPeriod = "week",
): SessionsPayload {
  const w = resolveTimeWindow({ ...wp, fallbackPeriod: legacyPeriod as Period });
  return withCache((cache) => {
    const rows = cache.topSessions({
      sinceIso: w.sinceIso,
      untilIso: w.untilIso,
      providers: providers.length > 0 ? providers : undefined,
      accountKey: account,
      limit: Math.max(1, Math.min(top, 100)),
    });
    return { window: toApiWindow(w), rows };
  });
}

export interface SessionDetailPayload {
  provider: string;
  sessionId: string;
  events: Array<{
    ts: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    costUsd: number;
  }>;
}

/** Request timeline for one session (provider required to disambiguate). */
export function apiSessionDetail(provider: string, sessionId: string): SessionDetailPayload {
  return withCache((cache) => {
    const events = cache.sessionDetail(provider, sessionId);
    return { provider, sessionId, events };
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

// ---------------------------------------------------------------- sources

export interface SourcesPayload {
  providers: Array<{
    id: string;
    label: string;
    envVar?: string;
    roots: string[];
    filesFound: number;
    trackedFiles: number;
    upToDateFiles: number;
    events: number;
    accounts: Array<{ key: string; email: string | null }>;
    models: string[];
  }>;
}

/** Provenance per provider — backs the future Sources tab. */
export function apiSources(): SourcesPayload {
  return withCache((cache) => ({ providers: collectSources(cache) }));
}

// ---------------------------------------------------------------- export

export interface ExportPayload {
  content: string;
  contentType: string;
  filename: string;
}

/**
 * Downloadable export in the same formats as the CLI (`json|md|csv`),
 * aggregating exactly like `report`.
 */
export function apiExport(
  format: string,
  by: string,
  wp: WindowParams,
  filterAccount?: string,
  providers: string[] = [],
): ExportPayload {
  if (!TABLE_DIMS.includes(by as (typeof TABLE_DIMS)[number])) {
    throw new Error(`invalid dimension: ${by} (valid: ${TABLE_DIMS.join(", ")})`);
  }
  const w = resolveTimeWindow({ ...wp, fallbackPeriod: "week" });
  return withCache((cache) => {
    const rows = sortRowsByCost(cache.aggregate(w.sinceIso, by as (typeof TABLE_DIMS)[number], providers.length > 0 ? providers : undefined, w.untilIso));
    const windowLabel = `${w.sinceIso} → ${w.untilIso ?? "now"} (${w.label})`;
    if (format === "md") {
      return { content: renderMarkdownTable(rows, windowLabel), contentType: "text/markdown; charset=utf-8", filename: "tokitoki-usage.md" };
    }
    if (format === "csv") {
      const head = ["bucket", "requests", "sessions", "inputTokens", "outputTokens", "cacheReadTokens", "costUsd"];
      const lines = [head.join(",")];
      for (const r of rows) {
        lines.push([
          JSON.stringify(r.bucket),
          String(r.requests),
          String(r.sessions),
          String(r.inputTokens),
          String(r.outputTokens),
          String(r.cacheReadTokens),
          r.costUsd.toFixed(6),
        ].join(","));
      }
      return { content: lines.join("\n"), contentType: "text/csv; charset=utf-8", filename: "tokitoki-usage.csv" };
    }
    if (format === "json") {
      return {
        content: JSON.stringify({ window: toApiWindow(w), groupBy: by, rows }, null, 2),
        contentType: "application/json",
        filename: "tokitoki-usage.json",
      };
    }
    throw new Error(`invalid format: ${format} (valid: csv, json, md)`);
  });
}
