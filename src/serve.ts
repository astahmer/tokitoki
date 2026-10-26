import { z } from "zod";
import { handleAccountOrderRequest } from "./account-order-api.ts";

import { EventCache, dimensionLabel, parseDimension, type AggRow } from "./cache.ts";
import { readAccountUiPreferences } from "./uiToggles.ts";
import { loadConfig } from "./config.ts";
import { readLimitsDocument } from "./limits-document.ts";
import { calendarDayWindow, rollingWindow, type TimeWindow } from "./period.ts";
import { resolveExtraFiles, totalTokens } from "./report.ts";
import { apiWidgetStatus } from "./web/api.ts";

const LOCAL_API_VERSION = 1;
export const DEFAULT_SERVE_PORT = 6736;
export const DEFAULT_SERVE_HOST = "127.0.0.1";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

export const isLoopbackHost = (host: string): boolean =>
  LOOPBACK_HOSTS.has(host.toLowerCase()) || host.startsWith("127.");

const UsageQuerySchema = z.object({
  period: z.enum(["today", "week", "month"]).default("today"),
  by: z.enum(["vendor", "harness", "provider", "model"]).default("vendor"),
});

type UsagePeriod = z.infer<typeof UsageQuerySchema>["period"];

const windowFor = (period: UsagePeriod, now: Date): TimeWindow =>
  period === "today" ? calendarDayWindow(now) : rollingWindow(period, now);

const usageRow = (row: AggRow) => ({
  key: row.bucket,
  requests: row.requests,
  sessions: row.sessions,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheReadTokens: row.cacheReadTokens,
  cacheWriteTokens: row.cacheWriteTokens,
  tokens: totalTokens(row),
  costUsd: Math.round(row.costUsd * 10_000) / 10_000,
});

const withSyncedCache = <T>(fn: (cache: EventCache) => T): T => {
  const cache = new EventCache();
  try {
    cache.sync(resolveExtraFiles(loadConfig()));
    return fn(cache);
  } finally {
    cache.close();
  }
};

/** Stable `GET /v1/usage` document; `by=provider` is the legacy alias of `harness`. */
const usageDocument = (input: { cache: EventCache; period: UsagePeriod; by: string; now?: Date }) => {
  const now = input.now ?? new Date();
  const dimension = parseDimension(input.by) ?? "vendor";
  const window = windowFor(input.period, now);
  const rows = input.cache
    .aggregate(window.sinceIso, dimension, undefined, window.untilIso)
    .sort((a, b) => b.costUsd - a.costUsd || totalTokens(b) - totalTokens(a))
    .map(usageRow);
  return {
    version: LOCAL_API_VERSION,
    generatedAt: now.toISOString(),
    period: input.period,
    by: dimensionLabel(dimension),
    window: { since: window.sinceIso, until: window.untilIso ?? now.toISOString() },
    total: usageRow(input.cache.totals(window.sinceIso, undefined, window.untilIso)),
    rows,
  };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

const error = (status: number, message: string, details?: unknown): Response =>
  json({ version: LOCAL_API_VERSION, error: message, ...(details !== undefined ? { details } : {}) }, status);

/**
 * Request handler for `tokitoki serve`. Read-only: GET/HEAD only, no CORS
 * headers (browser pages on other origins cannot read responses), and when
 * bound to loopback the Host header must be loopback too, which blocks DNS
 * rebinding from a malicious page.
 */
export const handleLocalApiRequest = async (request: Request, options: { loopbackOnly: boolean; appVersion: string }): Promise<Response> => {
  const url = new URL(request.url);
  if (options.loopbackOnly && !isLoopbackHost(url.hostname.replace(/^\[|\]$/g, ""))) {
    return error(403, "loopback Host header required");
  }
  if (["/v1/ui/account-order", "/v1/ui/bar-account-order", "/v1/ui/account-visibility"].includes(url.pathname)) return handleAccountOrderRequest(request);
  if (request.method !== "GET" && request.method !== "HEAD") return error(405, "read-only data API: use GET");
  try {
    switch (url.pathname) {
      // Same routes as `tokitoki web`: /v1/health is the probe, /v1/status the compact widget summary.
      case "/v1/status":
        return json(apiWidgetStatus({
          last: url.searchParams.get("last") ?? undefined,
          from: url.searchParams.get("from") ?? undefined,
          to: url.searchParams.get("to") ?? undefined,
        }));
      case "/v1/health":
        return json(withSyncedCache((cache) => ({
          version: LOCAL_API_VERSION,
          ok: true,
          app: "tokitoki",
          appVersion: options.appVersion,
          generatedAt: new Date().toISOString(),
          events: cache.count(),
          endpoints: ["/v1/health", "/v1/status", "/v1/limits", "/v1/usage"],
        })));
      case "/v1/limits":
        return json({ ...readLimitsDocument({ showEmail: url.searchParams.get("showEmail") === "1" }), uiPreview: readAccountUiPreferences() });
      case "/v1/usage": {
        const query = UsageQuerySchema.safeParse(Object.fromEntries(url.searchParams));
        if (!query.success) return error(400, "invalid query", z.treeifyError(query.error));
        return json(withSyncedCache((cache) => usageDocument({ cache, period: query.data.period, by: query.data.by })));
      }
      default:
        return error(404, `unknown endpoint: ${url.pathname}`);
    }
  } catch (err) {
    return error(500, err instanceof Error ? err.message : String(err));
  }
};

export const startLocalApiServer = (input: { port: number; host: string; appVersion: string }): Bun.Server<undefined> => {
  const loopbackOnly = isLoopbackHost(input.host);
  return Bun.serve({
    port: input.port,
    hostname: input.host,
    fetch: (request) => handleLocalApiRequest(request, { loopbackOnly, appVersion: input.appVersion }),
  });
};
