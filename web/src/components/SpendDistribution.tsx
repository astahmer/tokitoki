import { useEffect, useMemo, useState } from "react";

import {
  fetchTable,
  type Row,
  type TablePayload,
  type WindowSelection,
} from "../lib/api";
import { useAsyncStaleWhileRevalidate } from "../lib/useAsync";
import { DonutShare } from "./DonutShare";
import { EmptyState, Pill, SkeletonBlock } from "../ui";

/** Spend-distribution periods: calendar today/yesterday + rolling week/month. */
export type SpendPeriod = "today" | "yesterday" | "week" | "month";

const PERIODS: Array<{ key: SpendPeriod; label: string }> = [
  { key: "today", label: "today" },
  { key: "yesterday", label: "yesterday" },
  { key: "week", label: "week" },
  { key: "month", label: "month" },
];

function localDateKey(offsetDays = 0): string {
  const d = new Date(Date.now() - offsetDays * 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Calendar-day windows for today/yesterday; rolling presets for week/month. */
export function spendWindow(period: SpendPeriod): WindowSelection {
  switch (period) {
    case "today":
      return { from: localDateKey(), to: localDateKey() };
    case "yesterday":
      return { from: localDateKey(1), to: localDateKey(1) };
    case "week":
      return { last: "week" };
    case "month":
      return { last: "month" };
  }
}

const VALID = new Set(PERIODS.map((p) => p.key));

/** Read ?spend= from the URL on first load (invalid values fall back to today). */
function initialPeriod(): SpendPeriod {
  const raw = new URLSearchParams(window.location.search).get("spend");
  return raw !== null && VALID.has(raw as SpendPeriod) ? (raw as SpendPeriod) : "today";
}

/**
 * Usage distribution donut with its OWN period switcher (today/yesterday/
 * week/month) and cost⇄tokens metric toggle, independent of the dashboard-
 * wide range. Period persists in the URL query (?spend=week) so links can
 * point at a specific view.
 */
export function SpendDistribution() {
  const [period, setPeriod] = useState<SpendPeriod>(initialPeriod);
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");

  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set("spend", period);
    window.history.replaceState(null, "", url);
  }, [period]);

  const win = useMemo(() => spendWindow(period), [period]);
  // Provider-level rows are what the donut slices; cost-ordered like openusage.
  const table = useAsyncStaleWhileRevalidate<TablePayload>(
    () => fetchTable({ by: "provider", ...win }),
    [period],
  );

  const rows: Row[] = table.state === "ok" ? table.data.rows : [];

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <div className="flex gap-1.5">
          {PERIODS.map((p) => (
            <Pill key={p.key} active={period === p.key} onClick={() => setPeriod(p.key)}>
              {p.label}
            </Pill>
          ))}
          <span className="mx-1 text-kumo-line">|</span>
          {(["cost", "tokens"] as const).map((m) => (
            <Pill key={m} active={metric === m} onClick={() => setMetric(m)} title={`size slices by ${m}`}>
              {m}
            </Pill>
          ))}
        </div>
        <span className="text-[11px] text-kumo-subtle">
          {table.state === "ok" ? table.data.window.label : ""}
        </span>
      </div>
      {table.state === "loading" ? (
        <SkeletonBlock className="mx-auto h-48 w-48 rounded-full" />
      ) : rows.length === 0 ? (
        <EmptyState message={`no usage ${period === "yesterday" ? "yesterday" : `this ${period}`}`} />
      ) : (
        <DonutShare rows={rows} metric={metric} />
      )}
    </div>
  );
}
