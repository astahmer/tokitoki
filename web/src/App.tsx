import { useEffect, useMemo, useState } from "react";

import { Button, Surface, Tabs } from "@cloudflare/kumo";

import {
  fetchGrid,
  fetchSummary,
  fetchTable,
  fetchTimeseries,
  type GridCell,
  type SummaryPayload,
  type TablePayload,
  type TimeseriesPayload,
} from "./lib/api";
import { useAsyncStaleWhileRevalidate } from "./lib/useAsync";
import { SummaryCards } from "./components/SummaryCards";
import { UsageTable } from "./components/UsageTable";
import { TimeseriesChart } from "./components/TimeseriesChart";
import { DonutShare } from "./components/DonutShare";
import { CalendarGrid, type GridMetric } from "./components/CalendarGrid";
import { SessionsView } from "./components/SessionsView";
import { Panel, Pill, SkeletonBlock, SummaryCardsSkeleton, TableSkeleton, Toggle } from "./ui";
import { applyMode, persistMode, resolveInitialMode, type ThemeMode } from "./theme";

const DIMENSIONS = ["model", "provider", "account", "machine", "project", "repo"] as const;
const PERIODS = ["day", "week", "month"] as const;
const GRID_METRICS: GridMetric[] = ["tokens", "cost", "requests"];

type View = "dashboard" | "sessions";

export function App() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("week");
  const [dimension, setDimension] = useState<(typeof DIMENSIONS)[number]>("model");
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [providers, setProviders] = useState<string[]>([]);
  const [showEmail, setShowEmail] = useState(
    () => localStorage.getItem("tokitoki.showEmail") === "1",
  );
  const [mode, setMode] = useState<ThemeMode>(() => resolveInitialMode());
  const [view, setView] = useState<View>("dashboard");

  useEffect(() => {
    applyMode(mode);
    persistMode(mode);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem("tokitoki.showEmail", showEmail ? "1" : "0");
  }, [showEmail]);

  // Stale-while-revalidate everywhere: toggling a filter keeps the previous
  // data on screen (dimmed) instead of collapsing to skeletons.
  const summary = useAsyncStaleWhileRevalidate<SummaryPayload>(() => fetchSummary(), []);
  const table = useAsyncStaleWhileRevalidate<TablePayload>(
    () => fetchTable({ by: dimension, period, account, providers, showEmail }),
    [dimension, period, account, providers.join("|"), showEmail],
  );
  const timeseries = useAsyncStaleWhileRevalidate<TimeseriesPayload>(
    () =>
      fetchTimeseries(
        dimension === "account" || dimension === "machine" || dimension === "repo"
          ? "provider"
          : dimension === "project"
            ? "model"
            : dimension,
        period === "day" ? 7 : period === "week" ? 30 : 90,
      ),
    [dimension, period],
  );
  const grid = useAsyncStaleWhileRevalidate<{ metric: string; cells: GridCell[] }>(
    () => fetchGrid(365, "tokens"),
    [],
  );
  const [gridMetric, setGridMetric] = useState<GridMetric>("tokens");

  // Provider filter chips come from the table's provider rows (or all providers).
  const providerChips = useMemo(() => {
    if (dimension !== "model" && dimension !== "project" && dimension !== "repo") return [];
    return table.state === "ok"
      ? table.data.rows.map((r) => r.bucket).slice(0, 12)
      : [];
  }, [table, dimension]);

  const visibleSeries = useMemo(
    () =>
      new Set(timeseries.state === "ok" ? timeseries.data.series.slice(0, 5).map((s) => s.bucket) : []),
    [timeseries],
  );

  const refreshingClass =
    (table.state === "ok" && table.refreshing) || (summary.state === "ok" && summary.refreshing)
      ? "opacity-70 transition-opacity"
      : "";

  return (
    <main className="min-h-screen p-6 text-sm">
      <header className="mb-4 flex items-start justify-between">
        <div>
          <h1 className="mb-0.5 text-lg tracking-widest">⏱ tokitoki</h1>
          <p className="text-xs text-muted">unified coding-agent usage analytics · local only</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          shape="square"
          aria-label={`switch to ${mode === "dark" ? "light" : "dark"} mode`}
          title={`switch to ${mode === "dark" ? "light" : "dark"} mode`}
          onClick={() => setMode(mode === "dark" ? "light" : "dark")}
        >
          {mode === "dark" ? "☀" : "☾"}
        </Button>
      </header>

      <Tabs
        variant="segmented"
        className="mb-4 w-fit"
        value={view}
        onValueChange={(v) => setView(v as View)}
        tabs={[
          { value: "dashboard", label: "dashboard" },
          { value: "sessions", label: "sessions" },
        ]}
      />

      {view === "sessions" ? (
        <SessionsView period={period} providers={providers} account={account} />
      ) : (
        <>
          <div className={refreshingClass}>
            {summary.state === "loading" ? (
              <SummaryCardsSkeleton />
            ) : summary.state === "error" ? (
              <ErrorNote error={summary.error} />
            ) : (
              <SummaryCards summary={summary.data} />
            )}
          </div>

          <Panel className="mb-4">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="flex items-center gap-1.5">
                <span className="mr-1 text-[10px] tracking-wider text-muted uppercase">period</span>
                {PERIODS.map((p) => (
                  <Pill key={p} active={period === p} onClick={() => setPeriod(p)}>
                    {p}
                  </Pill>
                ))}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="mr-1 text-[10px] tracking-wider text-muted uppercase">by</span>
                {DIMENSIONS.map((d) => (
                  <Pill key={d} active={dimension === d} onClick={() => setDimension(d)}>
                    {d}
                  </Pill>
                ))}
              </div>
              {providerChips.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="mr-1 text-[10px] tracking-wider text-muted uppercase">provider</span>
                  <Pill active={providers.length === 0} onClick={() => setProviders([])}>
                    all
                  </Pill>
                  {providerChips.map((p) => (
                    <Pill
                      key={p}
                      active={providers.includes(p)}
                      onClick={() =>
                        setProviders((cur) =>
                          cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p],
                        )
                      }
                    >
                      {p}
                    </Pill>
                  ))}
                </div>
              )}
              <Toggle label="show emails" checked={showEmail} onChange={setShowEmail} />
            </div>

            {/* Account tabs */}
            {table.state === "ok" && (
              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                <span className="mr-1 text-[10px] tracking-wider text-muted uppercase">account</span>
                <Pill active={account === undefined} onClick={() => setAccount(undefined)}>
                  all
                </Pill>
                {table.data.accounts.map((a) => (
                  <Pill
                    key={a.key}
                    active={account === a.key}
                    title={a.email ?? undefined}
                    onClick={() => setAccount(account === a.key ? undefined : a.key)}
                  >
                    {a.key}
                    {showEmail && a.email !== null ? ` · ${a.email}` : ""}
                  </Pill>
                ))}
              </div>
            )}
          </Panel>

          {table.state === "error" && <ErrorNote error={table.error} />}
          {table.state === "loading" ? (
            <Panel className="mb-4">
              <TableSkeleton />
            </Panel>
          ) : table.state === "ok" ? (
            <Panel className={`mb-4 overflow-x-auto ${refreshingClass}`}>
              {/* min-w reserves the email space so toggling swaps text in place */}
              <UsageTable data={table.data} showEmail={showEmail} />
            </Panel>
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <Heading>evolution</Heading>
              {timeseries.state === "loading" ? (
                <SkeletonBlock className="h-56" />
              ) : timeseries.state === "error" ? (
                <ErrorNote error={timeseries.error} />
              ) : (
                <TimeseriesChart data={timeseries.data} metric="tokens" visible={visibleSeries} />
              )}
            </Panel>
            <Panel>
              <Heading>share</Heading>
              {table.state === "ok" ? (
                <DonutShare rows={table.data.rows} />
              ) : table.state === "loading" ? (
                <SkeletonBlock className="mx-auto h-48 w-48 rounded-full" />
              ) : null}
            </Panel>
          </div>

          <Panel className="mt-4">
            <div className="flex items-center justify-between">
              <Heading>activity</Heading>
              <div className="flex gap-1.5">
                {GRID_METRICS.map((m) => (
                  <Pill key={m} active={gridMetric === m} onClick={() => setGridMetric(m)}>
                    {m}
                  </Pill>
                ))}
              </div>
            </div>
            {grid.state === "loading" ? (
              <SkeletonBlock className="h-44" />
            ) : grid.state === "error" ? (
              <ErrorNote error={grid.error} />
            ) : (
              <CalendarGrid cells={grid.data.cells} metric={gridMetric} />
            )}
          </Panel>
        </>
      )}
    </main>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <span className="mb-3 block text-[10px] tracking-wider text-muted uppercase">{children}</span>;
}

function ErrorNote({ error }: { error: string }) {
  return (
    <Surface as="div" className="px-3 py-2 text-xs text-kumo-danger">
      {error}
    </Surface>
  );
}
