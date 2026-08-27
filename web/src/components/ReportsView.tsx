import { Surface } from "@cloudflare/kumo";

import { fetchSessions, fetchSummary, fetchTimeseries, type SummaryPayload, type TimeseriesPayload, type WindowSelection } from "../lib/api";
import { useAsyncStaleWhileRevalidate } from "../lib/useAsync";
import { EmptyState, Heading, Panel, SkeletonBlock } from "../ui";
import { SummaryCards } from "./SummaryCards";
import { NotificationHistory } from "./NotificationHistory";
import { TimeseriesChart } from "./TimeseriesChart";
import { formatCost, humanCount } from "../lib/fmt";

export function ReportsView({ win, providers, refreshTick }: { win: WindowSelection; providers: string[]; refreshTick: number }) {
  const key = `${win.last ?? ""}|${win.from ?? ""}|${win.to ?? ""}|${providers.join("|")}|${refreshTick}`;
  const summary = useAsyncStaleWhileRevalidate<SummaryPayload>(() => fetchSummary(win), [key]);
  const chart = useAsyncStaleWhileRevalidate<TimeseriesPayload>(() => fetchTimeseries("provider", 30, win, "cost"), [key]);
  const sessions = useAsyncStaleWhileRevalidate(() => fetchSessions({ ...win, providers, top: 5 }), [key]);

  return (
    <>
      {summary.state === "ok" ? <SummaryCards summary={summary.data} /> : summary.state === "loading" ? <SkeletonBlock className="mb-4 h-32" /> : <p className="mb-4 text-xs text-kumo-danger">{summary.error}</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <Heading>cost trend</Heading>
          {chart.state === "loading" ? <SkeletonBlock className="h-48" /> : chart.state === "error" ? <p className="text-xs text-kumo-danger">{chart.error}</p> : chart.data.series.length === 0 ? <EmptyState message="no cost data in this range" /> : <TimeseriesChart data={chart.data} metric="cost" visible={new Set(chart.data.series.map((s) => s.bucket))} />}
        </Panel>
        <Panel>
          <Heading>top sessions</Heading>
          {sessions.state === "loading" ? <SkeletonBlock className="h-48" /> : sessions.state === "error" ? <p className="text-xs text-kumo-danger">{sessions.error}</p> : sessions.data.rows.length === 0 ? <EmptyState message="no sessions in this range" /> : (
            <div className="space-y-2">
              {sessions.data.rows.map((row) => (
                <div key={`${row.provider}/${row.sessionId}`} className="rounded-md border border-kumo-border/60 p-2 text-xs">
                  <div className="flex items-center gap-2"><span className="truncate font-medium">{row.provider} · {row.sessionId}</span><span className="ml-auto whitespace-nowrap text-kumo-subtle">{formatCost(row.costUsd)}</span></div>
                  <div className="mt-1 text-[11px] text-kumo-subtle">{humanCount(row.totalTokens)} tokens · {row.requests} requests · {row.repos[0] ?? "no repo"}</div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>
      <NotificationHistory />
      <Surface as="section" className="mb-4 p-4">
        <Heading>what this report means</Heading>
        <p className="text-xs leading-relaxed text-kumo-subtle">Costs, burn projections, quota alerts, and session activity all use the selected range and local event store. Click a session in Sessions to inspect its conversation and request timeline.</p>
      </Surface>
    </>
  );
}
