/** Typed fetchers for the tokitoki API (server reuses CLI aggregation). */

export interface AggRow {
  bucket: string;
  requests: number;
  sessions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface Row extends AggRow {
  sharePct: number;
}

export interface GaugeInfo {
  frac: number;
  label: string;
}

export interface TablePayload {
  by: string;
  rows: Row[];
  total: Row;
  accounts: Array<{ key: string; requests: number; email: string | null }>;
  prevCostById?: Record<string, number>;
  totalPrevCost?: number;
  gauges: Record<string, GaugeInfo>;
  emails?: Record<string, string>;
}

export interface SummaryPayload {
  cost: number;
  requests: number;
  sessions: number;
  tokens: number;
  cachePct: number;
  prevWeekCost: number | null;
  burnPerDay: number;
  projectedMonthEnd: number;
}

export interface TimeseriesPayload {
  by: string;
  days: string[];
  series: Array<{ bucket: string; values: number[] }>;
}

export interface GridCell {
  day: string;
  tokens: number;
  costUsd: number;
  requests: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function fetchSummary(): Promise<SummaryPayload> {
  return get<SummaryPayload>("/api/summary");
}

export function fetchTable(params: {
  by: string;
  period: string;
  account?: string;
  providers?: string[];
  delta?: boolean;
  showEmail?: boolean;
}): Promise<TablePayload> {
  const q = new URLSearchParams({ by: params.by, period: params.period });
  if (params.account) q.set("account", params.account);
  for (const p of params.providers ?? []) q.append("provider", p);
  if (params.delta === false) q.set("delta", "0");
  if (params.showEmail === true) q.set("showEmail", "1");
  return get<TablePayload>(`/api/table?${q.toString()}`);
}

export function fetchTimeseries(by: string, days: number): Promise<TimeseriesPayload> {
  return get<TimeseriesPayload>(`/api/timeseries?by=${by}&days=${days}`);
}

export function fetchGrid(days: number, metric: string): Promise<{ metric: string; cells: GridCell[] }> {
  return get(`/api/grid?days=${days}&metric=${metric}`);
}
