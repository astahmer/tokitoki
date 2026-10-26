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
  window: ApiWindow;
  rows: Row[];
  total: Row;
  accounts: Array<{ key: string; requests: number; email: string | null }>;
  prevCostById?: Record<string, number>;
  totalPrevCost?: number;
  gauges: Record<string, GaugeInfo>;
  emails?: Record<string, string>;
}

export interface GaugeInfo {
  frac: number;
  label: string;
  used: number;
  cap: number;
  unit: "requests" | "usd";
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
  window: ApiWindow;
  days: string[];
  series: Array<{ bucket: string; values: number[] }>;
}

/** `provider` (routing service: openrouter, opencode, …) stays API-only; the UI shows vendor/harness/model. */
export type BreakdownDimension = "harness" | "vendor" | "provider" | "model";
export interface BreakdownPayload {
  by: BreakdownDimension;
  window: ApiWindow;
  rows: AggRow[];
}

export interface GridCell {
  day: string;
  tokens: number;
  costUsd: number;
  requests: number;
}

/** Window selection shared by every fetcher: preset/duration `last` OR explicit from/to. */
export interface WindowSelection {
  last?: string;
  from?: string;
  to?: string;
}

function windowQuery(w: WindowSelection): URLSearchParams {
  const q = new URLSearchParams();
  if (w.from !== undefined && w.from.length > 0) {
    q.set("from", w.from);
    if (w.to !== undefined && w.to.length > 0) q.set("to", w.to);
  } else if (w.last !== undefined && w.last.length > 0) {
    q.set("last", w.last);
  }
  return q;
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export function fetchSummary(win?: WindowSelection): Promise<SummaryPayload> {
  const q = win !== undefined ? windowQuery(win).toString() : "";
  return get<SummaryPayload>(`/api/summary${q.length > 0 ? `?${q}` : ""}`);
}

export function fetchTable(params: {
  by: string;
  period?: string;
  account?: string;
  providers?: string[];
  delta?: boolean;
  showEmail?: boolean;
} & WindowSelection): Promise<TablePayload> {
  const q = windowQuery(params);
  q.set("by", params.by);
  if (params.period !== undefined) q.set("period", params.period);
  if (params.account) q.set("account", params.account);
  for (const p of params.providers ?? []) q.append("provider", p);
  if (params.delta === false) q.set("delta", "0");
  if (params.showEmail === true) q.set("showEmail", "1");
  return get<TablePayload>(`/api/table?${q.toString()}`);
}

export function fetchTimeseries(
  by: string,
  days: number,
  win?: WindowSelection,
  metric: "tokens" | "cost" = "tokens",
): Promise<TimeseriesPayload> {
  const q = win !== undefined ? windowQuery(win) : new URLSearchParams({ days: String(days) });
  q.set("by", by);
  q.set("metric", metric);
  return get<TimeseriesPayload>(`/api/timeseries?${q.toString()}`);
}

export function fetchBreakdown(
  by: BreakdownDimension,
  win: WindowSelection,
  providers: string[] = [],
): Promise<BreakdownPayload> {
  const q = windowQuery(win);
  q.set("by", by);
  for (const provider of providers) q.append("provider", provider);
  return get<BreakdownPayload>(`/api/breakdown?${q.toString()}`);
}

export function fetchGrid(days: number, metric: string): Promise<{ metric: string; cells: GridCell[] }> {
  return get(`/api/grid?days=${days}&metric=${metric}`);
}

// ---------------------------------------------------------------- sessions

export type SessionRow = {
  sessionId: string;
  provider: string;
  accountKey: string;
  startedAt: string;
  /** Last request timestamp — recency sort key for the leaderboard. */
  lastRequestAt?: string;
  requests: number;
  models: string[];
  repos: string[];
  totalTokens: number;
  cachePct: number;
  costUsd: number;
  title?: string;
  snippet?: string;
};

export interface SessionsPayload {
  window: ApiWindow;
  rows: SessionRow[];
}

export interface SessionEvent {
  ts: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  tool?: string;
  description: string;
}

export interface CacheDurationEstimate {
  estimatedSeconds: number | null;
  confidence: "low" | "medium" | "high";
  samples: number;
  busts: number;
  lastBustAt: string | null;
}

export interface SessionDetailPayload {
  provider: string;
  sessionId: string;
  conversation: { title: string; body: string } | null;
  eventsTotal: number;
  eventsOffset: number;
  eventsHasMore: boolean;
  cacheDuration: CacheDurationEstimate;
  events: SessionEvent[];
}

export function fetchSessions(params: {
  period?: string;
  providers?: string[];
  account?: string;
  top?: number;
} & WindowSelection): Promise<SessionsPayload> {
  const q = windowQuery(params);
  if (params.period !== undefined) q.set("period", params.period);
  if (params.account) q.set("account", params.account);
  for (const p of params.providers ?? []) q.append("provider", p);
  if (params.top !== undefined) q.set("top", String(params.top));
  return get<SessionsPayload>(`/api/sessions?${q.toString()}`);
}

export function fetchSessionDetail(
  provider: string,
  sessionId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<SessionDetailPayload> {
  const params = new URLSearchParams({ provider, id: sessionId });
  if (opts.limit !== undefined) params.set("limit", String(opts.limit));
  if (opts.offset !== undefined) params.set("offset", String(opts.offset));
  return get<SessionDetailPayload>(`/api/sessions/detail?${params.toString()}`).then((raw) => {
    // Deep links can outlive a server/frontend rebuild. Normalize the small
    // numeric surface here so an older or partially populated response cannot
    // turn a detail view into `undefined.toLocaleString()`.
    const numberOrZero = (value: unknown): number =>
      typeof value === "number" && Number.isFinite(value) ? value : 0;
    const events = Array.isArray(raw.events)
      ? raw.events.map((event) => ({
          ts: typeof event.ts === "string" ? event.ts : "",
          model: typeof event.model === "string" ? event.model : "unknown",
          inputTokens: numberOrZero(event.inputTokens),
          outputTokens: numberOrZero(event.outputTokens),
          cacheReadTokens: numberOrZero(event.cacheReadTokens),
          cacheWriteTokens: numberOrZero(event.cacheWriteTokens),
          costUsd: numberOrZero(event.costUsd),
          tool: typeof event.tool === "string" ? event.tool : undefined,
          description: typeof event.description === "string" ? event.description : "",
        }))
      : [];
    return {
      ...raw,
      provider: typeof raw.provider === "string" ? raw.provider : provider,
      sessionId: typeof raw.sessionId === "string" ? raw.sessionId : sessionId,
      eventsTotal: numberOrZero(raw.eventsTotal),
      eventsOffset: numberOrZero(raw.eventsOffset),
      eventsHasMore: raw.eventsHasMore === true,
      cacheDuration: raw.cacheDuration ?? { estimatedSeconds: null, confidence: "low", samples: 0, busts: 0, lastBustAt: null },
      events,
      conversation:
        raw.conversation !== null && typeof raw.conversation === "object"
          ? {
              title: typeof raw.conversation.title === "string" ? raw.conversation.title : "",
              body: typeof raw.conversation.body === "string" ? raw.conversation.body : "",
            }
          : null,
    };
  });
}

// ---------------------------------------------------------------- sessions search

export interface SessionSearchRow {
  provider: string;
  sessionId: string;
  accountKey: string;
  startedAt: string;
  title: string;
  /** Snippet with [[match]] markers around hits. */
  snippet: string;
  requests: number;
  totalTokens: number;
  cachePct: number;
  costUsd: number;
  repos: string[];
}

export interface SessionSearchPayload {
  window: ApiWindow;
  query: string;
  page: number;
  hasMore: boolean;
  searchMs: number;
  indexedFiles: number;
  indexMs: number;
  /** Store files too large to index (perf guard). */
  skippedLargeFiles?: number;
  rows: SessionSearchRow[];
}

export function fetchSessionsSearch(params: {
  q: string;
  page?: number;
  providers?: string[];
} & WindowSelection): Promise<SessionSearchPayload> {
  const q = windowQuery(params);
  q.set("q", params.q);
  if (params.page !== undefined && params.page > 1) q.set("page", String(params.page));
  for (const p of params.providers ?? []) q.append("provider", p);
  return get<SessionSearchPayload>(`/api/sessions/search?${q.toString()}`);
}

// ---------------------------------------------------------------- sources

export interface ProviderSource {
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
}

export interface MachinePresence {
  machineId: string;
  host: string;
  ts: number;
  state: "active" | "recent" | "stale";
}

export function fetchSources(): Promise<{ providers: ProviderSource[]; machines: MachinePresence[] }> {
  return get("/api/sources");
}

// ---------------------------------------------------------------- anomalies

export interface AnomalyRow {
  day: string;
  metric: string;
  value: number;
  baseline: number;
  ratio: number;
}

export function fetchAnomalies(win?: WindowSelection, metric = "tokens"): Promise<{ window: ApiWindow; metric: string; anomalies: AnomalyRow[] }> {
  const q = win !== undefined ? windowQuery(win) : new URLSearchParams();
  q.set("metric", metric);
  return get(`/api/anomalies?${q.toString()}`);
}

// ---------------------------------------------------------------- budgets

export interface BudgetRow {
  scope: "daily" | "weekly" | "monthly";
  pattern: string;
  spend: number;
  cap: number;
  pct: number;
  level: number;
}

export interface BudgetAlertInfo {
  scope: "daily" | "weekly" | "monthly";
  pattern: string;
  spend: number;
  cap: number;
  pct: number;
  level: number;
}

export function fetchBudgets(): Promise<{ configured: boolean; rows: BudgetRow[]; alerts: BudgetAlertInfo[] }> {
  return get("/api/budgets");
}

/** Mirror of src/limits-document.ts (schema version 1) — keep in sync. */
export interface LimitsPace {
  expectedPercent: number;
  deltaPercent: number;
  status: "under" | "on" | "over";
  runsOutAt?: string;
}

export interface LimitsWindow {
  id: string;
  label: string;
  scope: "session" | "daily" | "weekly" | "monthly" | "model" | "other";
  model?: string;
  source: "provider" | "derived";
  usedPercent: number | null;
  amountUsd?: number;
  windowMinutes?: number;
  resetsAt?: string;
  pace?: LimitsPace;
  tokens: number;
  costUsd: number;
  requests: number;
}

export interface LimitsAccount {
  id: string;
  vendor: string;
  vendorName: string;
  harness: string;
  alsoOn: string[];
  accountKey: string;
  label?: string;
  email?: string;
  plan?: string;
  credential?: string;
  origin?: string;
  freshness?: "fresh" | "stale" | "unknown";
  observedAt?: string;
  extraUsage?: { enabled: boolean; usedUsd?: number; limitUsd?: number; usedPercent?: number };
  balance?: { currency: string; remaining: number; total?: number; used?: number; granted?: number; paid?: number; available?: boolean };
  bankedResets?: number;
  bankedExpiresAt?: string;
  windows: LimitsWindow[];
}

export interface LimitsDocument {
  version: 1;
  generatedAt: string;
  accounts: LimitsAccount[];
  accountOrder?: string[];
  uiPreview?: { accountOrder: string[]; barAccountOrder: string[]; barHiddenAccounts: string[]; menubarHidden: string[]; previewHidden: string[] };
}

export async function saveAccountOrder(ids: string[], bar = false, barIds?: string[]): Promise<void> {
  const response = await fetch(bar ? "/v1/ui/bar-account-order" : "/v1/ui/account-order", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids, ...(barIds !== undefined ? { barIds } : {}) }),
  });
  if (!response.ok) throw new Error("Could not save account order (HTTP " + response.status + ")");
}

export async function saveAccountVisibility(id: string, preference: { hidden?: boolean; barHidden?: boolean }): Promise<void> {
  const response = await fetch("/v1/ui/account-visibility", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...preference }),
  });
  if (!response.ok) throw new Error("Could not save account visibility (HTTP " + response.status + ")");
}

export function fetchLimits(showEmail: boolean): Promise<LimitsDocument> {
  return get(showEmail ? "/api/limits?showEmail=1" : "/api/limits");
}

export interface NotificationRecord {
  id: string;
  at: string;
  title: string;
  body: string;
  reason: string;
}

export function fetchNotificationHistory(): Promise<{ records: NotificationRecord[] }> {
  return get("/api/notifications");
}

// ---------------------------------------------------------------- export

/** Build a download link reflecting the currently-selected filters. */
export function exportUrl(opts: {
  format: "json" | "md" | "csv";
  by: string;
  account?: string;
  providers?: string[];
} & WindowSelection): string {
  const q = windowQuery(opts);
  q.set("format", opts.format);
  q.set("by", opts.by);
  if (opts.account !== undefined && opts.account.length > 0) q.set("account", opts.account);
  for (const p of opts.providers ?? []) q.append("provider", p);
  return `/api/export?${q.toString()}`;
}
