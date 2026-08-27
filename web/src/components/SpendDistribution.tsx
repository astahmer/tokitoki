import { useMemo, useState } from "react";

import { fetchBreakdown, type BreakdownDimension, type WindowSelection } from "../lib/api";
import { formatCost, humanCount } from "../lib/fmt";
import { useAsyncStaleWhileRevalidate } from "../lib/useAsync";
import { DonutShare } from "./DonutShare";
import { EmptyState, Pill, SkeletonBlock } from "../ui";

const DIMENSIONS: Array<{ key: BreakdownDimension; label: string }> = [
  { key: "harness", label: "harness" },
  { key: "provider", label: "provider" },
  { key: "model", label: "model" },
];

/** Shared breakdown surface. The dashboard-wide range, including custom
 * from/to dates, is passed directly so every slice uses the same window. */
export function SpendDistribution({ win, providers = [] }: { win: WindowSelection; providers?: string[] }) {
  const [by, setBy] = useState<BreakdownDimension>("provider");
  const [metric, setMetric] = useState<"cost" | "tokens">("cost");
  const [selected, setSelected] = useState<string>();
  const breakdown = useAsyncStaleWhileRevalidate(
    () => fetchBreakdown(by, win, providers),
    [by, JSON.stringify(win), providers.join("|")],
  );
  const rows = breakdown.state === "ok" ? breakdown.data.rows : [];
  const selectedRow = useMemo(() => rows.find((r) => r.bucket === selected), [rows, selected]);

  const download = (format: "json" | "csv") => {
    const content = format === "json"
      ? JSON.stringify({ by, window: breakdown.state === "ok" ? breakdown.data.window : win, rows }, null, 2)
      : [
          "bucket,requests,sessions,inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,costUsd",
          ...rows.map((r) => [r.bucket, r.requests, r.sessions, r.inputTokens, r.outputTokens, r.cacheReadTokens, r.cacheWriteTokens, r.costUsd.toFixed(6)].map((v) => JSON.stringify(v)).join(",")),
        ].join("\n");
    const url = URL.createObjectURL(new Blob([content], { type: format === "json" ? "application/json" : "text/csv" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `tokitoki-${by}-breakdown.${format}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-1.5">
        {DIMENSIONS.map((d) => (
          <Pill key={d.key} active={by === d.key} onClick={() => { setBy(d.key); setSelected(undefined); }}>
            {d.label}
          </Pill>
        ))}
        <span className="mx-1 text-kumo-line">|</span>
        {(["cost", "tokens"] as const).map((m) => (
          <Pill key={m} active={metric === m} onClick={() => setMetric(m)} title={`size slices by ${m}`}>
            {m}
          </Pill>
        ))}
        <span className="ml-auto text-[11px] text-kumo-subtle">
          {breakdown.state === "ok" ? breakdown.data.window.label : ""}
        </span>
        <span className="flex gap-1">
          {(["json", "csv"] as const).map((format) => (
            <button key={format} type="button" onClick={() => download(format)} className="rounded border border-kumo-border px-1.5 py-0.5 font-mono text-[10px] text-kumo-subtle hover:text-kumo-default" disabled={rows.length === 0}>
              ↓{format}
            </button>
          ))}
        </span>
      </div>
      {breakdown.state === "loading" ? (
        <SkeletonBlock className="mx-auto h-48 w-48 rounded-full" />
      ) : breakdown.state === "error" ? (
        <p className="text-xs text-kumo-danger">{breakdown.error}</p>
      ) : rows.length === 0 ? (
        <EmptyState message="no usage in this range — widen the range or run a scan" />
      ) : (
        <>
          <DonutShare rows={rows} metric={metric} selected={selected} onSelect={setSelected} />
          {selectedRow !== undefined && (
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-kumo-border pt-2 text-[11px] text-kumo-subtle">
              <strong className="text-kumo-default">{selectedRow.bucket}</strong>
              <span>{humanCount(selectedRow.inputTokens + selectedRow.outputTokens + selectedRow.cacheReadTokens + selectedRow.cacheWriteTokens)} tokens</span>
              <span>{selectedRow.requests.toLocaleString("en-US")} requests</span>
              <span>{formatCost(selectedRow.costUsd)}</span>
              <span>{Math.round((selectedRow.inputTokens > 0 ? selectedRow.cacheReadTokens / selectedRow.inputTokens : 0) * 100)}% cache read</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
