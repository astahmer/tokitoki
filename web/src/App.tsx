import { useEffect, useMemo, useState } from "react";

import { Button, Surface, Tabs } from "@cloudflare/kumo";

import {
  exportUrl,
  fetchGrid,
  fetchSummary,
  fetchTable,
  fetchTimeseries,
  type GridCell,
  type SummaryPayload,
  type TablePayload,
  type TimeseriesPayload,
  type WindowSelection,
} from "./lib/api";
import { useAsyncStaleWhileRevalidate } from "./lib/useAsync";
import { SummaryCards } from "./components/SummaryCards";
import { UsageTable } from "./components/UsageTable";
import { ToolsView } from "./components/ToolsView";
import { TimeseriesChart } from "./components/TimeseriesChart";
import { DonutShare } from "./components/DonutShare";
import { CalendarGrid, type GridMetric } from "./components/CalendarGrid";
import { SessionsView } from "./components/SessionsView";
import { SourcesView } from "./components/SourcesView";
import { AnomaliesView } from "./components/AnomaliesView";
import { BudgetsView } from "./components/BudgetsView";
import { ShareButton } from "./components/ShareButton";
import { EmptyState, Panel, Pill, SkeletonBlock, SummaryCardsSkeleton, TableSkeleton, Toggle } from "./ui";
import { applyMode, persistMode, resolveInitialMode, type ThemeMode } from "./theme";

const DIMENSIONS = ["model", "provider", "account", "machine", "project", "repo"] as const;
const GRID_METRICS: GridMetric[] = ["tokens", "cost", "requests"];
/** Preset chips: named rolling windows + Duration-style spans. */
const RANGE_PRESETS: Array<{ label: string; value: string }> = [
  { label: "day", value: "day" },
  { label: "week", value: "week" },
  { label: "month", value: "month" },
  { label: "24h", value: "24h" },
  { label: "7d", value: "7d" },
  { label: "30d", value: "30d" },
  { label: "90d", value: "90d" },
];

type View = "dashboard" | "tools" | "sessions" | "sources" | "anomalies" | "budgets";

export function App() {
  const [range, setRange] = useState<WindowSelection>({ last: "week" });
  const [dimension, setDimension] = useState<(typeof DIMENSIONS)[number]>("model");
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [providers, setProviders] = useState<string[]>([]);
  const [showEmail, setShowEmail] = useState(
    () => localStorage.getItem("tokitoki.showEmail") === "1",
  );
  const [mode, setMode] = useState<ThemeMode>(() => resolveInitialMode());
  // Sessions is the landing view: search-first across every harness.
  const [view, setView] = useState<View>(
    () => (localStorage.getItem("tokitoki.view") as View | null) ?? "sessions",
  );

  useEffect(() => {
    applyMode(mode);
    persistMode(mode);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem("tokitoki.showEmail", showEmail ? "1" : "0");
  }, [showEmail]);

  // Stable dependency key for the current window selection.
  const rangeKey = useMemo(
    () => ("from" in range && range.from !== undefined ? `${range.from}..${range.to ?? ""}` : (range.last ?? "")),
    [range],
  );
  const win: WindowSelection = range;

  // Stale-while-revalidate everywhere: toggling a filter keeps the previous
  // data on screen (dimmed) instead of collapsing to skeletons.
  const summary = useAsyncStaleWhileRevalidate<SummaryPayload>(() => fetchSummary(), []);
  const table = useAsyncStaleWhileRevalidate<TablePayload>(
    () => fetchTable({ by: dimension, account, providers, showEmail, ...win }),
    [dimension, rangeKey, account, providers.join("|"), showEmail],
  );
  const timeseries = useAsyncStaleWhileRevalidate<TimeseriesPayload>(
    () =>
      fetchTimeseries(
        dimension === "account" || dimension === "machine" || dimension === "repo"
          ? "provider"
          : dimension === "project"
            ? "model"
            : dimension,
        30,
        win,
      ),
    [dimension, rangeKey],
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
        <div className="flex items-center gap-1">
          <ShareButton />
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
        </div>
      </header>

      <Tabs
        variant="segmented"
        className="mb-4 w-fit"
        value={view}
        onValueChange={(v) => {
          setView(v as View);
          localStorage.setItem("tokitoki.view", v);
        }}
        tabs={[
          { value: "dashboard", label: "dashboard" },
          { value: "tools", label: "tools" },
          { value: "sessions", label: "sessions" },
          { value: "anomalies", label: "anomalies" },
          { value: "budgets", label: "budgets" },
          { value: "sources", label: "sources" },
        ]}
      />

      {view === "sessions" ? (
        <>
          <FilterBar
            range={range}
            setRange={setRange}
            dimension={dimension}
            setDimension={setDimension}
            providers={providers}
            setProviders={setProviders}
            providerChips={providerChips}
            showEmail={showEmail}
            setShowEmail={setShowEmail}
            exportBy={dimension}
            account={account}
          />
          <SessionsView win={win} providers={providers} account={account} />
        </>
      ) : view === "tools" ? (
        <ToolsView win={win} providers={providers} />
      ) : view === "sources" ? (
        <SourcesView />
      ) : view === "anomalies" ? (
        <AnomaliesView win={win} />
      ) : view === "budgets" ? (
        <BudgetsView />
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

          <FilterBar
            range={range}
            setRange={setRange}
            dimension={dimension}
            setDimension={setDimension}
            providers={providers}
            setProviders={setProviders}
            providerChips={providerChips}
            showEmail={showEmail}
            setShowEmail={setShowEmail}
            exportBy={dimension}
            account={account}
          />

          {/* Account tabs */}
          {table.state === "ok" && (
            <Panel className="mb-4">
              <div className="flex flex-wrap items-center gap-1.5">
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
              {/* Effective window straight from the aggregation layer */}
              <p className="mt-2 text-[11px] text-kumo-subtle">
                period: {formatWindow(table.data.window)}
              </p>
            </Panel>
          )}

          {table.state === "error" && <ErrorNote error={table.error} />}
          {table.state === "loading" ? (
            <Panel className="mb-4">
              <TableSkeleton />
            </Panel>
          ) : table.state === "ok" ? (
            table.data.rows.length === 0 ? (
              <Panel className="mb-4">
                <EmptyState message={`no usage recorded ${windowHint(range)} — try widening the range or clearing filters`} />
              </Panel>
            ) : (
              <Panel className={`mb-4 overflow-x-auto ${refreshingClass}`}>
                {/* min-w reserves the email space so toggling swaps text in place */}
                <UsageTable data={table.data} showEmail={showEmail} />
              </Panel>
            )
          ) : null}

          <div className="grid gap-4 lg:grid-cols-2">
            <Panel>
              <Heading>evolution</Heading>
              {timeseries.state === "loading" ? (
                <SkeletonBlock className="h-56" />
              ) : timeseries.state === "error" ? (
                <ErrorNote error={timeseries.error} />
              ) : timeseries.data.series.every((s) => s.values.every((v) => v === 0)) ? (
                <EmptyState message={`no data in this window (${timeseries.data.window.label})`} />
              ) : (
                <TimeseriesChart data={timeseries.data} metric="tokens" visible={visibleSeries} />
              )}
            </Panel>
            <Panel>
              <Heading>share</Heading>
              {table.state === "ok" ? (
                table.data.rows.length === 0 ? (
                  <EmptyState message="nothing to share yet in this window" />
                ) : (
                  <DonutShare rows={table.data.rows} />
                )
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

function formatWindow(w: { since: string; until: string | null; label: string }): string {
  const fmt: Intl.DateTimeFormatOptions = { dateStyle: "short", timeStyle: "short" };
  const since = new Date(w.since).toLocaleString([], fmt);
  const until = w.until === null ? "now" : new Date(w.until).toLocaleString([], fmt);
  return `${since} → ${until} · ${w.label}`;
}

function windowHint(range: WindowSelection): string {
  if (range.from !== undefined) return `between ${range.from} and ${range.to ?? "now"}`;
  return `in the last ${range.last ?? "week"}`;
}

interface FilterBarProps {
  range: WindowSelection;
  setRange: (r: WindowSelection) => void;
  dimension: string;
  setDimension: (d: (typeof DIMENSIONS)[number]) => void;
  providers: string[];
  setProviders: (p: string[]) => void;
  providerChips: string[];
  showEmail: boolean;
  setShowEmail: (v: boolean) => void;
  exportBy: string;
  account?: string;
}

/** Shared filter toolbar: range presets, custom dates, dimensions, exports. */
function FilterBar(props: FilterBarProps) {
  const {
    range,
    setRange,
    dimension,
    setDimension,
    providers,
    setProviders,
    providerChips,
    showEmail,
    setShowEmail,
    exportBy,
    account,
  } = props;
  const activeLast = "from" in range ? undefined : (range.last ?? undefined);

  return (
    <Panel className="mb-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-[10px] tracking-wider text-muted uppercase">period</span>
          {RANGE_PRESETS.map((p) => (
            <Pill key={p.value} active={activeLast === p.value} onClick={() => setRange({ last: p.value })}>
              {p.label}
            </Pill>
          ))}
          <input
            type="date"
            aria-label="from date"
            className="rounded-md border border-edge bg-transparent px-1.5 py-0.5 text-[11px]"
            value={"from" in range ? (range.from ?? "") : ""}
            onChange={(e) => {
              const v = e.currentTarget.value;
              if (v.length > 0) setRange({ from: v, to: "from" in range ? range.to : undefined });
            }}
          />
          <span className="text-[10px] text-muted">→</span>
          <input
            type="date"
            aria-label="to date"
            className="rounded-md border border-edge bg-transparent px-1.5 py-0.5 text-[11px]"
            value={"from" in range ? (range.to ?? "") : ""}
            onChange={(e) => setRange({ from: "from" in range ? (range.from ?? "") : "", to: e.currentTarget.value })}
          />
          {"from" in range && (
            <Button size="xs" variant="ghost" onClick={() => setRange({ last: "week" })}>
              clear
            </Button>
          )}
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
                  setProviders(providers.includes(p) ? providers.filter((x) => x !== p) : [...providers, p])
                }
              >
                {p}
              </Pill>
            ))}
          </div>
        )}
        <Toggle label="show emails" checked={showEmail} onChange={setShowEmail} />
        <div className="flex items-center gap-1.5">
          <span className="mr-1 text-[10px] tracking-wider text-muted uppercase">export</span>
          {(["json", "md", "csv"] as const).map((f) => (
            <a
              key={f}
              href={exportUrl({ format: f, by: exportBy, account, providers, ...(activeLast !== undefined ? { last: activeLast } : range) })}
              download
              className="rounded-full border border-edge px-2.5 py-0.5 font-mono text-[11px] hover:bg-kumo-recessed"
            >
              ↓{f}
            </a>
          ))}
        </div>
      </div>
    </Panel>
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
