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

export interface ApiWindow {
  since: string;
  until: string | null;
  label: string;
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

// ---------------------------------------------------------------- sessions

export interface SessionRow {
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
}

export interface SessionsPayload {
  period: string;
  rows: SessionRow[];
}

export interface SessionEvent {
  ts: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface SessionDetailPayload {
  provider: string;
  sessionId: string;
  events: SessionEvent[];
}

export function fetchSessions(params: {
  period: string;
  providers?: string[];
  account?: string;
  top?: number;
}): Promise<SessionsPayload> {
  const q = new URLSearchParams({ period: params.period });
  if (params.account) q.set("account", params.account);
  for (const p of params.providers ?? []) q.append("provider", p);
  if (params.top !== undefined) q.set("top", String(params.top));
  return get<SessionsPayload>(`/api/sessions?${q.toString()}`);
}

export function fetchSessionDetail(provider: string, sessionId: string): Promise<SessionDetailPayload> {
  return get<SessionDetailPayload>(
    `/api/sessions/detail?provider=${encodeURIComponent(provider)}&id=${encodeURIComponent(sessionId)}`,
  );
}
