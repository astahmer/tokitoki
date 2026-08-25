/**
 * Local MCP server (`tokitoki mcp`): exposes every CLI reporting surface as
 * MCP tools over stdio. No daemon, no network port — lifecycle is owned by
 * the connecting client. Read tools share one lazily-opened EventCache
 * (WAL + busy_timeout make concurrent CLI/menubar/web access safe);
 * `scan_now` is the only mutator and mirrors the CLI's incremental scan.
 *
 * Window semantics come from src/period.ts — the exact helpers behind the
 * CLI's --last/--from/--to, so CLI and MCP never drift.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { DIMENSIONS, EventCache, type AggRow, type Dimension } from "./cache.ts";
import { searchSessions } from "./sessionIndex.ts";
import { loadConfig } from "./config.ts";
import { UserError } from "./errors.ts";
import { localMachineId } from "./machine.ts";
import { detectAnomalies } from "./anomalies.ts";
import { PROVIDERS } from "./providers/index.ts";
import { scanProviderCore } from "./scan.ts";
import type { ScanResult } from "./scan.ts";
import { repoEfficiency, resolveExtraFiles } from "./report.ts";
import { computeBudgetStatus, gaugesForMenubar } from "./budget-status.ts";
import { collectSources } from "./sources.ts";
import { appendEvents, eventsFile, saveProviderCursors } from "./store.ts";
import { resolveTimeWindow, type TimeWindow } from "./period.ts";

const WINDOW_SHAPE = {
  last: z.string().optional().describe("rolling window: day|week|month or a duration like 24h/2days/150m"),
  from: z.string().optional().describe("window start: YYYY-MM-DD or ISO timestamp (exclusive with last)"),
  to: z.string().optional().describe("window end: YYYY-MM-DD or ISO timestamp (default now)"),
} as const;

type WindowArgs = { last?: string; from?: string; to?: string };

function windowFrom(args: WindowArgs, fallbackPeriod: "day" | "week" | "month" = "week"): TimeWindow {
  return resolveTimeWindow({ last: args.last, from: args.from, to: args.to, fallbackPeriod });
}

type ToolResult = { content: Array<{ type: "text"; text: string }> };

function text(payload: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function errorResult(e: unknown): ToolResult & { isError: true } {
  return { isError: true, content: [{ type: "text", text: e instanceof Error ? e.message : String(e) }] };
}

/** Compact report payload shape shared by usage_report / export_report(json). */
interface ReportPayload {
  window: { since: string; until: string | null; label: string };
  dimension: Dimension;
  totals: AggRow;
  rows: AggRow[];
}

export class TokitokiMcpServer {
  private cache: EventCache | null = null;
  readonly server: McpServer;

  constructor() {
    this.server = new McpServer({ name: "tokitoki", version: "0.4.0" });
    this.registerTools();
  }

  /** Lazily open + sync the cache on first use; shared by all tools. */
  private getCache(): EventCache {
    if (this.cache === null) {
      const cache = new EventCache();
      try {
        cache.sync(resolveExtraFiles(loadConfig()));
      } catch {
        // A broken extra-file config must not take down reads of local data.
      }
      this.cache = cache;
    }
    return this.cache;
  }

  async close(): Promise<void> {
    this.cache?.close();
    this.cache = null;
  }

  private reportRows(
    w: TimeWindow,
    dimension: Dimension,
    provider?: string,
  ): { totals: AggRow; rows: AggRow[] } {
    const providers = provider !== undefined && provider.length > 0 ? [provider] : undefined;
    const cache = this.getCache();
    return {
      totals: cache.totals(w.sinceIso, providers, w.untilIso),
      rows: cache.aggregate(w.sinceIso, dimension, providers, w.untilIso),
    };
  }

  /**
   * Incremental scan mirroring cli.ts runScan minus console output and budget
   * banners: events append to the log AND insert straight into the shared
   * cache handle, then the log is marked consumed so later reads skip the tail.
   */
  private scanNow(): { scanned: ScanResult[] } {
    const cache = this.getCache();
    const machineId = localMachineId();
    const scanned: ScanResult[] = [];
    for (const p of PROVIDERS) {
      scanned.push(
        scanProviderCore(p, machineId, {
          onEvents: (batch) => {
            appendEvents(batch);
            cache.insert(batch);
          },
          onSaveCursors: (cursors) => saveProviderCursors(p.id, cursors),
        }),
      );
    }
    cache.recordLogOffsets([eventsFile()]);
    return { scanned };
  }

  private registerTools(): void {
    this.server.registerTool(
      "usage_report",
      {
        title: "Usage report",
        description:
          "Token/cost aggregation grouped by a dimension over a window. Dimensions: model, project, repo, account, machine, provider, tool.",
        inputSchema: {
          ...WINDOW_SHAPE,
          dimension: z.enum(DIMENSIONS).optional().describe("grouping dimension (default provider)"),
          provider: z.string().optional().describe("filter to one harness provider id"),
        },
      },
      (args: WindowArgs & { dimension?: Dimension; provider?: string }) => {
        try {
          const w = windowFrom(args);
          const dimension = args.dimension ?? "provider";
          const { totals, rows } = this.reportRows(w, dimension, args.provider);
          const payload: ReportPayload = {
            window: { since: w.sinceIso, until: w.untilIso ?? null, label: w.label },
            dimension,
            totals,
            rows,
          };
          return text(payload);
        } catch (e) {
          return errorResult(e);
        }
      },
    );

    this.server.registerTool(
      "usage_totals",
      {
        title: "Usage totals",
        description: "Window totals only: requests, sessions, tokens, cache tokens, cost.",
        inputSchema: { ...WINDOW_SHAPE, provider: z.string().optional() },
      },
      (args: WindowArgs & { provider?: string }) => {
        try {
          const w = windowFrom(args);
          const providers = args.provider !== undefined && args.provider.length > 0 ? [args.provider] : undefined;
          const totals = this.getCache().totals(w.sinceIso, providers, w.untilIso);
          return text({ window: { since: w.sinceIso, until: w.untilIso ?? null, label: w.label }, totals });
        } catch (e) {
          return errorResult(e);
        }
      },
    );

    this.server.registerTool(
      "sessions_top",
      {
        title: "Top sessions",
        description: "Costliest / most token-heavy sessions in the window.",
        inputSchema: {
          ...WINDOW_SHAPE,
          limit: z.number().int().min(1).max(100).optional().describe("max sessions (default 10)"),
          provider: z.string().optional(),
        },
      },
      (args: WindowArgs & { limit?: number; provider?: string }) => {
        try {
          const w = windowFrom(args);
          const rows = this.getCache().topSessions({
            sinceIso: w.sinceIso,
            untilIso: w.untilIso,
            providers: args.provider !== undefined && args.provider.length > 0 ? [args.provider] : undefined,
            limit: args.limit ?? 10,
          });
          return text({ window: { since: w.sinceIso, until: w.untilIso ?? null, label: w.label }, rows });
        } catch (e) {
          return errorResult(e);
        }
      },
    );

    this.server.registerTool(
      "session_detail",
      {
        title: "Session detail",
        description: "Per-request drill-down for one session id (from sessions_top).",
        inputSchema: { session_id: z.string().min(1) },
      },
      (args: { session_id: string }) => {
        try {
          const matches = this.getCache().sessionProviders(args.session_id);
          if (matches.length === 0) {
            throw new UserError(`no session '${args.session_id}' in the local data`, "run scan_now, then sessions_top");
          }
          if (matches.length > 1) {
            throw new UserError(`session id exists under multiple providers: ${matches.join(", ")}`, "");
          }
          return text({
            provider: matches[0],
            sessionId: args.session_id,
            events: this.getCache().sessionDetail(matches[0]!, args.session_id),
          });
        } catch (e) {
          return errorResult(e);
        }
      },
    );

    this.server.registerTool(
      "tool_spend",
      {
        title: "Tool spend",
        description: "Spend attributed to the tool that caused each request (mcp:<server> rollups included).",
        inputSchema: WINDOW_SHAPE,
      },
      (args: WindowArgs) => {
        try {
          const w = windowFrom(args);
          const rows = this.getCache().aggregate(w.sinceIso, "tool", undefined, w.untilIso);
          return text({ window: { since: w.sinceIso, until: w.untilIso ?? null, label: w.label }, rows });
        } catch (e) {
          return errorResult(e);
        }
      },
    );

    this.server.registerTool(
      "repo_efficiency",
      {
        title: "Repo efficiency",
        description: "Repo ranking: cost per request/session and cache-hostility signals.",
        inputSchema: WINDOW_SHAPE,
      },
      (args: WindowArgs) => {
        try {
          const w = windowFrom(args);
          const cache = this.getCache();
          const rows = cache.aggregate(w.sinceIso, "repo", undefined, w.untilIso).map((row) => ({
            repo: row.bucket,
            ...row,
            efficiency: repoEfficiency(row),
          }));
          return text({ window: { since: w.sinceIso, until: w.untilIso ?? null, label: w.label }, rows });
        } catch (e) {
          return errorResult(e);
        }
      },
    );

    this.server.registerTool(
      "budgets_status",
      {
        title: "Budget status",
        description:
          "Spending caps vs usage (the menubar `budgets --json` contract). Empty gauge list when no budgets are configured.",
        inputSchema: {},
      },
      () => {
        try {
          const cfg = loadConfig();
          if (cfg.budgets === undefined) return text({ configured: false, gauges: [] });
          const payload = computeBudgetStatus(this.getCache(), cfg.budgets);
          return text({ configured: payload.configured, gauges: gaugesForMenubar(payload) });
        } catch (e) {
          return errorResult(e);
        }
      },
    );

    this.server.registerTool(
      "quota_snapshot",
      {
        title: "Quota snapshot",
        description:
          "Latest embedded provider quota windows (provider-reported rate limits; currently codex only — see plans/quota-windows-findings.md).",
        inputSchema: { provider: z.string().min(1), account_key: z.string().min(1) },
      },
      (args: { provider: string; account_key: string }) => {
        try {
          return text(this.getCache().latestQuotaSnapshots(args.provider, args.account_key));
        } catch (e) {
          return errorResult(e);
        }
      },
    );

    this.server.registerTool(
      "anomalies",
      {
        title: "Anomalies",
        description: "Unusual-activity days vs the trailing baseline.",
        inputSchema: WINDOW_SHAPE,
      },
      (args: WindowArgs) => {
        try {
          const w = windowFrom(args);
          const anomalies = detectAnomalies(this.getCache().dailyTotals(w.sinceIso, w.untilIso), {});
          return text({ window: { since: w.sinceIso, until: w.untilIso ?? null, label: w.label }, anomalies });
        } catch (e) {
          return errorResult(e);
        }
      },
    );

    this.server.registerTool(
      "sources",
      {
        title: "Sources",
        description: "Per-provider provenance: roots, tracked files, freshness, accounts, models.",
        inputSchema: {},
      },
      () => {
        try {
          return text(collectSources(this.getCache()));
        } catch (e) {
          return errorResult(e);
        }
      },
    );

    this.server.registerTool(
      "scan_now",
      {
        title: "Scan now",
        description:
          "Incrementally scan all harness stores into the local cache (same as `tokitoki scan`). Idempotent — safe to call before reads.",
        inputSchema: {},
      },
      () => {
        try {
          return text(this.scanNow());
        } catch (e) {
          return errorResult(e);
        }
      },
    );

    this.server.registerTool(
      "search_sessions",
      {
        title: "Search sessions",
        description:
          "Full-text search across every indexed harness session (titles + conversation bodies). Terms AND together; returns snippets with [[match]] markers.",
        inputSchema: {
          query: z.string().min(1).describe("whitespace-separated search terms"),
          limit: z.number().int().min(1).max(50).optional().describe("max hits (default 10)"),
          provider: z.string().optional().describe("filter to one harness provider id"),
        },
      },
      (args: { query: string; limit?: number; provider?: string }) => {
        try {
          const cache = this.getCache();
          let rows: Awaited<ReturnType<typeof searchSessions>>["rows"];
          let hasMore = false;
          try {
            const res = searchSessions(cache.database, {
              query: args.query,
              providers:
                args.provider !== undefined && args.provider.length > 0 ? [args.provider] : undefined,
              limit: args.limit ?? 10,
            });
            rows = res.rows;
            hasMore = res.hasMore;
          } catch {
            // FTS5 unavailable in this sqlite build — degrade to an empty
            // result set rather than failing the tool.
            rows = [];
          }
          return text({
            query: args.query,
            matches: rows.length,
            hasMore,
            rows: rows.map((r) => ({
              provider: r.provider,
              sessionId: r.sessionId,
              accountKey: r.accountKey,
              startedAt: r.startedAt,
              title: r.title,
              snippet: r.snippet.slice(0, 300),
              requests: r.requests,
              tokens: r.totalTokens,
              costUsd: r.costUsd,
              repos: r.repos,
            })),
          });
        } catch (e) {
          return errorResult(e);
        }
      },
    );

    this.server.registerTool(
      "usage_chart",
      {
        title: "Usage chart",
        description:
          "Daily time series for a window, ascending by day. Same data as the `chart` command; pick a metric to sort/reason over.",
        inputSchema: {
          ...WINDOW_SHAPE,
          metric: z.enum(["tokens", "cost", "requests"]).optional().describe("primary metric (default tokens)"),
        },
      },
      (args: WindowArgs & { metric?: "tokens" | "cost" | "requests" }) => {
        try {
          const w = windowFrom(args);
          // Same daily-series helper the `chart` and `anomalies` commands use.
          const days = this.getCache().dailyTotals(w.sinceIso, w.untilIso);
          return text({
            window: { since: w.sinceIso, until: w.untilIso ?? null, label: w.label },
            metric: args.metric ?? "tokens",
            series: days.map((d) => ({
              day: d.day,
              tokens: Math.round(d.tokens),
              costUsd: Number(d.costUsd.toFixed(4)),
              requests: d.requests,
            })),
          });
        } catch (e) {
          return errorResult(e);
        }
      },
    );

    this.server.registerTool(
      "export_report",
      {
        title: "Export report",
        description: "Report rows as json, csv, or markdown blob.",
        inputSchema: {
          ...WINDOW_SHAPE,
          format: z.enum(["json", "csv", "markdown"]).optional().describe("default json"),
          dimension: z.enum(DIMENSIONS).optional(),
          provider: z.string().optional(),
        },
      },
      (args: WindowArgs & { format?: "json" | "csv" | "markdown"; dimension?: Dimension; provider?: string }) => {
        try {
          const w = windowFrom(args);
          const format = args.format ?? "json";
          const dimension = args.dimension ?? "provider";
          const { rows } = this.reportRows(w, dimension, args.provider);
          const label = `${w.sinceIso} → ${w.untilIso ?? "now"} (${w.label})`;
          if (format === "markdown") return text(renderMarkdown(rows, label));
          if (format === "csv") return text(toCsv(rows));
          const payload: ReportPayload = {
            window: { since: w.sinceIso, until: w.untilIso ?? null, label: w.label },
            dimension,
            totals: this.reportRows(w, dimension, args.provider).totals,
            rows,
          };
          return text(payload);
        } catch (e) {
          return errorResult(e);
        }
      },
    );
  }
}

function renderMarkdown(rows: AggRow[], label: string): string {
  const lines = [
    "| bucket | requests | sessions | input | output | cache-rd | cost |",
    "|---|---|---|---|---|---|---|",
    ...rows.map((r) =>
      `| ${r.bucket} | ${r.requests} | ${r.sessions} | ${Math.round(r.inputTokens)} | ${Math.round(r.outputTokens)} | ${Math.round(r.cacheReadTokens)} | $${r.costUsd.toFixed(4)} |`,
    ),
  ];
  return `${label}\n\n${lines.join("\n")}`;
}

function toCsv(rows: AggRow[]): string {
  const head = ["bucket", "requests", "sessions", "inputTokens", "outputTokens", "cacheReadTokens", "costUsd"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push([
      JSON.stringify(r.bucket),
      String(r.requests),
      String(r.sessions),
      String(Math.round(r.inputTokens)),
      String(Math.round(r.outputTokens)),
      String(Math.round(r.cacheReadTokens)),
      r.costUsd.toFixed(6),
    ].join(","));
  }
  return lines.join("\n");
}

/** Connect the server over stdio. Resolves when the transport closes. */
export async function runMcpStdio(): Promise<void> {
  const t = new TokitokiMcpServer();
  await t.server.connect(new StdioServerTransport());
}
