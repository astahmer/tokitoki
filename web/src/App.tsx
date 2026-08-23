import { useEffect, useMemo, useState } from "react";

import { Button } from "@cloudflare/kumo";

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
import { SummaryCards } from "./components/SummaryCards";
import { UsageTable } from "./components/UsageTable";
import { TimeseriesChart } from "./components/TimeseriesChart";
import { DonutShare } from "./components/DonutShare";
import { CalendarGrid, type GridMetric } from "./components/CalendarGrid";
import { Panel, Pill, Toggle } from "./ui";
import { applyMode, persistMode, resolveInitialMode, type ThemeMode } from "./theme";

const DIMENSIONS = ["model", "provider", "account", "machine", "project", "repo"] as const;
const PERIODS = ["day", "week", "month"] as const;
const GRID_METRICS: GridMetric[] = ["tokens", "cost", "requests"];

type Loadable<T> = { state: "loading" } | { state: "error"; error: string } | { state: "ok"; data: T };

function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): Loadable<T> {
  const [state, setState] = useState<Loadable<T>>({ state: "loading" });
  useEffect(() => {
    let alive = true;
    setState({ state: "loading" });
    fn().then(
      (data) => alive && setState({ state: "ok", data }),
      (err) =>
        alive &&
        setState({ state: "error", error: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return state;
}

export function App() {
  const [period, setPeriod] = useState<(typeof PERIODS)[number]>("week");
  const [dimension, setDimension] = useState<(typeof DIMENSIONS)[number]>("model");
  const [account, setAccount] = useState<string | undefined>(undefined);
  const [providers, setProviders] = useState<string[]>([]);
  const [showEmail, setShowEmail] = useState(
    () => localStorage.getItem("tokitoki.showEmail") === "1",
  );
  const [mode, setMode] = useState<ThemeMode>(() => resolveInitialMode());

  useEffect(() => {
    applyMode(mode);
    persistMode(mode);
  }, [mode]);

  useEffect(() => {
    localStorage.setItem("tokitoki.showEmail", showEmail ? "1" : "0");
  }, [showEmail]);

  const summary = useAsync<SummaryPayload>(() => fetchSummary(), []);
  const table = useAsync<TablePayload>(
    () => fetchTable({ by: dimension, period, account, providers, showEmail }),
    [dimension, period, account, providers.join("|"), showEmail],
  );
  const timeseries = useAsync<TimeseriesPayload>(
    () => fetchTimeseries(dimension === "account" || dimension === "machine" ? "provider" : dimension, period === "day" ? 7 : period === "week" ? 30 : 90),
    [dimension, period],
  );
  const grid = useAsync<{ metric: string; cells: GridCell[] }>(() => fetchGrid(365, "tokens"), []);
  const [gridMetric, setGridMetric] = useState<GridMetric>("tokens");

  // Provider filter chips come from the table's provider rows (or all providers).
  const providerChips = useMemo(() => {
    if (dimension !== "model" && dimension !== "project" && dimension !== "repo") return [];
    return table.state === "ok"
      ? table.data.rows.map((r) => r.bucket).slice(0, 12)
      : [];
  }, [table, dimension]);

  const visibleSeries = useMemo(() => new Set(timeseries.state === "ok" ? timeseries.data.series.slice(0, 5).map((s) => s.bucket) : []), [timeseries]);

  return (
    <main className="min-h-screen p-6 text-sm">
      <header className="flex items-start justify-between">
        <div>
          <h1 className="mb-0.5 text-lg tracking-widest">⏱ tokitoki</h1>
          <p className="mb-5 text-xs text-muted">unified coding-agent usage analytics · local only</p>
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

      {summary.state === "ok" ? (
        <SummaryCards summary={summary.data} />
      ) : summary.state === "error" ? (
        <ErrorNote error={summary.error} />
      ) : null}

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
              <Pill
                active={providers.length === 0}
                onClick={() => setProviders([])}
              >
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
      {table.state === "ok" && (
        <Panel className="mb-4 overflow-x-auto">
          <UsageTable data={table.data} showEmail={showEmail} />
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel>
          <Heading>evolution</Heading>
          {timeseries.state === "ok" ? (
            <TimeseriesChart data={timeseries.data} metric="tokens" visible={visibleSeries} />
          ) : timeseries.state === "error" ? (
            <ErrorNote error={timeseries.error} />
          ) : null}
        </Panel>
        <Panel>
          <Heading>share</Heading>
          {table.state === "ok" && <DonutShare rows={table.data.rows} />}
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
        {grid.state === "ok" ? (
          <CalendarGrid cells={grid.data.cells} metric={gridMetric} />
        ) : grid.state === "error" ? (
          <ErrorNote error={grid.error} />
        ) : null}
      </Panel>
    </main>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <h2 className="mb-3 text-[10px] tracking-wider text-muted uppercase">{children}</h2>;
}

function ErrorNote({ error }: { error: string }) {
  return <p className="rounded-lg border border-bad/40 bg-bad/10 px-3 py-2 text-xs text-bad">{error}</p>;
}
