import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

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
import { seriesColor } from "./lib/fmt";
import type { GridMetric } from "./components/CalendarGrid";
import { MultiSelect } from "./components/MultiSelect";
import { ShareButton } from "./components/ShareButton";
import { EmptyState, Panel, Pill, SkeletonBlock, SummaryCardsSkeleton, TableSkeleton, Toggle } from "./ui";
import { applyMode, effectiveMode, persistMode, resolveInitialMode, watchSystemMode, type ThemeMode } from "./theme";

// Keep the shell and controls in the first paint. Charts and secondary views
// are loaded only when their route or panel is rendered, which keeps the
// menubar-compatible dashboard bundle comfortably below Vite's warning size.
const SummaryCards = lazy(() => import("./components/SummaryCards").then((m) => ({ default: m.SummaryCards })));
const UsageTable = lazy(() => import("./components/UsageTable").then((m) => ({ default: m.UsageTable })));
const TimeseriesChart = lazy(() => import("./components/TimeseriesChart").then((m) => ({ default: m.TimeseriesChart })));
const SpendDistribution = lazy(() => import("./components/SpendDistribution").then((m) => ({ default: m.SpendDistribution })));
const CalendarGrid = lazy(() => import("./components/CalendarGrid").then((m) => ({ default: m.CalendarGrid })));
const ToolsView = lazy(() => import("./components/ToolsView").then((m) => ({ default: m.ToolsView })));
const SessionsView = lazy(() => import("./components/SessionsView").then((m) => ({ default: m.SessionsView })));
const SourcesView = lazy(() => import("./components/SourcesView").then((m) => ({ default: m.SourcesView })));
const AnomaliesView = lazy(() => import("./components/AnomaliesView").then((m) => ({ default: m.AnomaliesView })));
const BudgetsView = lazy(() => import("./components/BudgetsView").then((m) => ({ default: m.BudgetsView })));
const ReportsView = lazy(() => import("./components/ReportsView").then((m) => ({ default: m.ReportsView })));

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
  { label: "year", value: "year" },
];
const VIEWS = ["dashboard", "reports", "tools", "sessions", "anomalies", "budgets", "sources"] as const;
type View = (typeof VIEWS)[number];

// ---------------------------------------------------------------- url state

/** The app's filter state, mirrored into the URL query so views are
 * deep-linkable and the back button works. */
interface AppState {
  view: View;
  range: WindowSelection;
  dimension: string;
  account?: string;
  providers: string[];
  showEmail: boolean;
  sessionProvider?: string;
  sessionId?: string;
}

function readStateFromUrl(): AppState {
  const p = new URLSearchParams(window.location.search);
  const viewRaw = p.get("view");
  const view: View = VIEWS.includes(viewRaw as View) ? (viewRaw as View) : "dashboard";
  let range: WindowSelection = { last: "week" };
  if (p.get("from") !== null) {
    range = { from: p.get("from") ?? "", to: p.get("to") ?? undefined };
  } else if (p.get("last") !== null) {
    const last = p.get("last") ?? "";
    if (RANGE_PRESETS.some((r) => r.value === last)) range = { last };
  }
  const by = p.get("by") ?? "model";
  return {
    view,
    range,
    dimension: DIMENSIONS.includes(by as (typeof DIMENSIONS)[number]) ? by : "model",
    account: p.get("account") ?? undefined,
    providers: p.getAll("provider").filter((x) => x.length > 0),
    showEmail: p.get("emails") === "1",
    sessionProvider: p.get("provider") ?? undefined,
    sessionId: p.get("session") ?? undefined,
  };
}

function writeStateToUrl(s: AppState): void {
  const p = new URLSearchParams(window.location.search);
  const setOrDel = (key: string, value: string | undefined, fallback: string): void => {
    if (value === undefined || value === "" || value === fallback) p.delete(key);
    else p.set(key, value);
  };
  // spend= is owned by SpendDistribution; leave it untouched here.
  setOrDel("view", s.view, "sessions");
  if ("from" in s.range && s.range.from !== undefined && s.range.from.length > 0) {
    p.set("from", s.range.from);
    if (s.range.to !== undefined && s.range.to.length > 0) p.set("to", s.range.to);
    else p.delete("to");
    p.delete("last");
  } else {
    setOrDel("last", "last" in s.range ? s.range.last : undefined, "week");
    p.delete("from");
    p.delete("to");
  }
  setOrDel("by", s.dimension, "model");
  setOrDel("account", s.account ?? "", "");
  const existingProviders = p.getAll("provider");
  for (const e of existingProviders) p.delete("provider");
  for (const prov of s.providers) p.append("provider", prov);
  if (s.showEmail) p.set("emails", "1");
  else p.delete("emails");
  window.history.pushState(null, "", `${window.location.pathname}?${p.toString()}${window.location.hash}`);
}

export function App() {
  const [state, setState] = useState<AppState>(readStateFromUrl);
  const { view, range, dimension, account, providers, showEmail, sessionProvider, sessionId } = state;

  const patch = useCallback((partial: Partial<AppState>): void => {
    setState((prev) => {
      const next = { ...prev, ...partial };
      writeStateToUrl(next); // pushState → back button walks filter history
      return next;
    });
  }, []);

  // Back/forward restores the mirrored state.
  useEffect(() => {
    const onPop = (): void => setState(readStateFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Manual refresh: bumps a tick that every data hook depends on.
  const [refreshTick, setRefreshTick] = useState(0);

  const [mode, setMode] = useState<ThemeMode>(() => resolveInitialMode());
  useEffect(() => {
    applyMode(mode);
    persistMode(mode);
  }, [mode]);
  useEffect(() => (mode === "system" ? watchSystemMode(() => applyMode(mode)) : undefined), [mode]);

  // Stable dependency key for the current window selection.
  const rangeKey = useMemo(
    () => ("from" in range && range.from !== undefined ? `${range.from}..${range.to ?? ""}` : (range.last ?? "")),
    [range],
  );
  const win: WindowSelection = range;

  // Stale-while-revalidate everywhere: toggling a filter keeps the previous
  // data on screen (dimmed) instead of collapsing to skeletons.
  const summary = useAsyncStaleWhileRevalidate<SummaryPayload>(() => fetchSummary(win), [rangeKey, refreshTick]);
  const table = useAsyncStaleWhileRevalidate<TablePayload>(
    () => fetchTable({ by: dimension, account, providers, showEmail, ...win }),
    [dimension, rangeKey, account, providers.join("|"), showEmail, refreshTick],
  );
  const [tsMetric, setTsMetric] = useState<"tokens" | "cost">("cost");
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
        tsMetric,
      ),
    [dimension, rangeKey, tsMetric, refreshTick],
  );
  const grid = useAsyncStaleWhileRevalidate<{ metric: string; cells: GridCell[] }>(
    () => fetchGrid(365, "tokens"),
    [refreshTick],
  );
  const [gridMetric, setGridMetric] = useState<GridMetric>("tokens");

  // Provider filter chips come from the table's provider rows (or all providers).
  const providerChips = useMemo(() => {
    if (dimension !== "model" && dimension !== "project" && dimension !== "repo") return [];
    return table.state === "ok"
      ? table.data.rows.map((r) => r.bucket).slice(0, 12)
      : [];
  }, [table, dimension]);

  // Clickable timeseries legend: which series are drawn.
  const [visibleSeries, setVisibleSeries] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (timeseries.state === "ok") setVisibleSeries(new Set(timeseries.data.series.slice(0, 5).map((s) => s.bucket)));
  }, [timeseries]);
  const toggleSeries = useCallback((bucket: string): void => {
    setVisibleSeries((prev) => {
      const next = new Set(prev);
      if (next.has(bucket)) next.delete(bucket);
      else next.add(bucket);
      return next;
    });
  }, []);

  const refreshingClass =
    (table.state === "ok" && table.refreshing) || (summary.state === "ok" && summary.refreshing)
      ? "opacity-70 transition-opacity"
      : "";

  const openDay = useCallback(
    (day: string): void => {
      patch({ view: "sessions", range: { from: day, to: day } });
    },
    [patch],
  );

  return (
    <main className="min-h-screen p-4 text-sm">
      {/* Compact header: brand, nav, share + theme all on one line. */}
      <header className="mb-3 flex items-center gap-3">
        <h1 className="text-sm font-semibold tracking-tight">tokitoki</h1>
        <Tabs
          variant="segmented"
          value={view}
          onValueChange={(v) => patch({ view: v as View })}
          tabs={VIEWS.map((v) => ({ value: v, label: v }))}
        />
        <span className="text-[10px] text-muted">local only</span>
        <div className="ml-auto flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            aria-label="refresh data"
            title="refetch all data"
            onClick={() => setRefreshTick((t) => t + 1)}
          >
            ⟳
          </Button>
          <ShareButton />
          <Button
            variant="ghost"
            size="sm"
            shape="square"
            aria-label={`theme: ${mode} — click to cycle`}
            title={`theme: ${mode} — click to cycle light → dark → system`}
            onClick={() => {
              const next: ThemeMode =
                mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
              setMode(next);
              applyMode(next);
            }}
          >
            {mode === "system" ? "◐" : effectiveMode(mode) === "dark" ? "☀" : "☾"}
          </Button>
        </div>
      </header>

      <Suspense fallback={<PageLoading />}>{view === "sessions" ? (
        <>
          <FilterBar
            range={range}
            setRange={(r) => patch({ range: r })}
            providers={providers}
            setProviders={(p) => patch({ providers: p })}
            providerChips={providerChips}
            showEmail={showEmail}
            setShowEmail={(v) => patch({ showEmail: v })}
            account={account}
            accounts={table.state === "ok" ? table.data.accounts.map((a) => a.key) : []}
            setAccount={(a) => patch({ account: a })}
          />
          <SessionsView
            win={win}
            providers={providers}
            account={account}
            initialSessionProvider={sessionProvider}
            initialSessionId={sessionId}
          />
        </>
      ) : view === "reports" ? (
        <>
          <FilterBar
            range={range}
            setRange={(r) => patch({ range: r })}
            providers={providers}
            setProviders={(p) => patch({ providers: p })}
            providerChips={providerChips}
            showEmail={showEmail}
            setShowEmail={(v) => patch({ showEmail: v })}
            account={account}
            accounts={table.state === "ok" ? table.data.accounts.map((a) => a.key) : []}
            setAccount={(a) => patch({ account: a })}
          />
          <ReportsView win={win} providers={providers} refreshTick={refreshTick} />
        </>
      ) : view === "tools" ? (
        <ToolsView win={win} providers={providers} />
      ) : view === "sources" ? (
        <SourcesView />
      ) : view === "anomalies" ? (
        <AnomaliesView win={win} onOpenDay={openDay} />
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
            setRange={(r) => patch({ range: r })}
            dimension={dimension}
            setDimension={(d) => patch({ dimension: d })}
            providers={providers}
            setProviders={(p) => patch({ providers: p })}
            providerChips={providerChips}
            showEmail={showEmail}
            setShowEmail={(v) => patch({ showEmail: v })}
            exportBy={dimension}
            account={account}
            accounts={table.state === "ok" ? table.data.accounts.map((a) => a.key) : []}
            setAccount={(a) => patch({ account: a })}
          />

          {/* Hero charts side by side, directly under filters. */}
          <div className="mb-4 grid gap-4 lg:grid-cols-2">
            <Panel>
              <div className="mb-3 flex items-center justify-between">
                <Heading>evolution</Heading>
                <div className="flex gap-1.5">
                  {(["cost", "tokens"] as const).map((m) => (
                    <Pill key={m} active={tsMetric === m} onClick={() => setTsMetric(m)}>
                      {m}
                    </Pill>
                  ))}
                </div>
              </div>
              {timeseries.state === "loading" ? (
                <SkeletonBlock className="h-56" />
              ) : timeseries.state === "error" ? (
                <ErrorNote error={timeseries.error} />
              ) : timeseries.data.series.every((s) => s.values.every((v) => v === 0)) ? (
                <EmptyState message={`no data in this window (${timeseries.data.window.label})`} />
              ) : (
                <>
                  <TimeseriesChart data={timeseries.data} metric={tsMetric} visible={visibleSeries} />
                  {/* Clickable legend: toggle series visibility. */}
                  <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
                    {timeseries.data.series.slice(0, 5).map((s) => (
                      <button
                        key={s.bucket}
                        onClick={() => toggleSeries(s.bucket)}
                        className={`flex items-center gap-1.5 text-[11px] ${
                          visibleSeries.has(s.bucket) ? "text-kumo-default" : "text-kumo-subtle line-through opacity-60"
                        }`}
                      >
                        <span
                          aria-hidden="true"
                          className="inline-block size-2 rounded-sm"
                          style={{
                            background: visibleSeries.has(s.bucket)
                              ? seriesColor(s.bucket, timeseries.data.series.map((x) => x.bucket))
                              : "currentColor",
                          }}
                        />
                        {s.bucket}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </Panel>
            <Panel>
              <Heading>usage distribution</Heading>
              <SpendDistribution win={win} providers={providers} />
            </Panel>
          </div>

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
              <>
                {/* Account tabs after the table they scope, per ui-review §b10. */}
                <AccountTabs
                  accounts={table.data.accounts}
                  account={account}
                  setAccount={(a) => patch({ account: a })}
                  showEmail={showEmail}
                  windowLabel={formatWindow(table.data.window)}
                />
                <Panel className={`mb-4 overflow-x-auto ${refreshingClass}`}>
                  {/* min-w reserves the email space so toggling swaps text in place */}
                  <UsageTable data={table.data} showEmail={showEmail} />
                </Panel>
              </>
            )
          ) : null}

          <Panel className="mt-4">
            <div className="flex items-center justify-between">
              <Heading>activity</Heading>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-kumo-subtle">last 365 days</span>
                <div className="flex gap-1.5">
                  {GRID_METRICS.map((m) => (
                    <Pill key={m} active={gridMetric === m} onClick={() => setGridMetric(m)}>
                      {m}
                    </Pill>
                  ))}
                </div>
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
      )}</Suspense>
    </main>
  );
}

function PageLoading() {
  return (
    <Panel className="flex min-h-48 items-center justify-center">
      <div className="flex items-center gap-2 text-xs text-kumo-subtle" role="status" aria-live="polite">
        <span className="size-2 animate-pulse rounded-full bg-kumo-primary" aria-hidden="true" />
        loading view…
      </div>
    </Panel>
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
  dimension?: string;
  setDimension?: (d: (typeof DIMENSIONS)[number]) => void;
  providers: string[];
  setProviders: (p: string[]) => void;
  providerChips: string[];
  showEmail: boolean;
  setShowEmail: (v: boolean) => void;
  exportBy?: string;
  account?: string;
  accounts?: string[];
  setAccount?: (a: string | undefined) => void;
}

/** Compact filter toolbar: period presets always visible; the rest collapses
 * behind a Filters toggle. Dimension + export only apply to dashboard views. */
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
    accounts = [],
    setAccount,
  } = props;
  const activeLast = "from" in range ? undefined : (range.last ?? undefined);
  const [expanded, setExpanded] = useState(false);
  const hasAdvanced =
    dimension !== undefined || setAccount !== undefined || providerChips.length > 0;

  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="flex items-center gap-1">
        <span className="mr-1 text-[10px] tracking-wider text-muted uppercase">period</span>
        {RANGE_PRESETS.map((p) => (
          <button
            key={p.value}
            onClick={() => setRange({ last: p.value })}
            aria-pressed={activeLast === p.value}
            className={`rounded-full px-2 py-0.5 font-mono text-[10px] transition-colors duration-150 ${
              activeLast === p.value
                ? "bg-kumo-primary/15 text-kumo-default ring-1 ring-kumo-primary/40"
                : "text-kumo-subtle hover:text-kumo-default"
            }`}
          >
            {p.label}
          </button>
        ))}
        <input
          type="date"
          aria-label="from date"
          title="from date"
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
          title="to date"
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

      {hasAdvanced && (
        <>
          {providers.length > 0 && (
            <Pill active onClick={() => setProviders([])} title={`providers: ${providers.join(", ")}`}>
              {providers.length} provider{providers.length === 1 ? "" : "s"} ×
            </Pill>
          )}
          {account !== undefined && setAccount !== undefined && (
            <Pill active onClick={() => setAccount(undefined)} title={`account: ${account}`}>
              {account} ×
            </Pill>
          )}
          {showEmail && <Pill active onClick={() => setShowEmail(false)}>emails on ×</Pill>}
          <Button
            size="xs"
            variant={expanded ? "secondary" : "outline"}
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
          >
            filters {expanded ? "▴" : "▾"}
          </Button>

          {expanded && (
            <Panel className="w-full">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
                {dimension !== undefined && setDimension !== undefined && (
                  <div className="flex items-center gap-1.5">
                    <span className="mr-1 text-[10px] tracking-wider text-muted uppercase">by</span>
                    {DIMENSIONS.map((d) => (
                      <Pill key={d} active={dimension === d} onClick={() => setDimension(d)}>
                        {d}
                      </Pill>
                    ))}
                  </div>
                )}
                {providerChips.length > 0 && (
                  <MultiSelect
                    label="provider"
                    options={providerChips}
                    selected={providers}
                    onChange={(next) =>
                      // Single-click convenience: picking one fresh provider
                      // replaces the selection; toggling behaves as expected.
                      setProviders(next)
                    }
                  />
                )}
                {setAccount !== undefined && accounts.length > 0 && (
                  <MultiSelect
                    label="account"
                    options={accounts}
                    selected={account !== undefined ? [account] : []}
                    onChange={(next) => {
                      const added = next.find((n) => n !== account);
                      setAccount(added); // undefined when cleared
                    }}
                    width="w-64"
                  />
                )}
                <Toggle label="show emails" checked={showEmail} onChange={setShowEmail} />
                {exportBy !== undefined && (
                  <div className="flex items-center gap-1.5">
                    <span className="mr-1 text-[10px] tracking-wider text-muted uppercase">export</span>
                    {(["json", "md", "csv"] as const).map((f) => (
                      <a
                        key={f}
                        href={exportUrl({
                          format: f,
                          by: exportBy,
                          account,
                          providers,
                          ...(activeLast !== undefined ? { last: activeLast } : range),
                        })}
                        download
                        title={`exports current window × ${exportBy} × filters as ${f.toUpperCase()}`}
                        className="rounded-full border border-edge px-2.5 py-0.5 font-mono text-[11px] hover:bg-kumo-recessed"
                      >
                        ↓{f}
                      </a>
                    ))}
                  </div>
                )}
              </div>
            </Panel>
          )}
        </>
      )}
    </div>
  );
}

/** Account pills, collapsed behind a toggle when there are many. */
function AccountTabs({
  accounts,
  account,
  setAccount,
  showEmail,
  windowLabel,
}: {
  accounts: Array<{ key: string; email: string | null }>;
  account?: string;
  setAccount: (a: string | undefined) => void;
  showEmail: boolean;
  windowLabel?: string;
}) {
  const [open, setOpen] = useState(accounts.length <= 6);
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      <button
        className="text-[10px] tracking-wider text-muted uppercase hover:text-kumo-default"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        accounts ({accounts.length}) {open ? "▴" : "▾"}
      </button>
      {open &&
        accounts.map((a) => (
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
      <span className="ml-auto text-[11px] text-kumo-subtle">{windowLabel}</span>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return <span className="block text-[10px] tracking-wider text-muted uppercase">{children}</span>;
}

function ErrorNote({ error }: { error: string }) {
  return (
    <Surface as="div" className="px-3 py-2 text-xs text-kumo-danger">
      {error}
    </Surface>
  );
}
