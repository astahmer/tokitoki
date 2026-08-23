import { useMemo, useState } from "react";

import { formatCost, humanCount, cachePct, totalTokens } from "../lib/fmt";
import type { Row, TablePayload } from "../lib/api";
import { DeltaBadge, Gauge } from "../ui";

type SortKey =
  | "bucket"
  | "requests"
  | "sessions"
  | "avg"
  | "inputTokens"
  | "outputTokens"
  | "cacheReadTokens"
  | "cachePct"
  | "sharePct"
  | "costUsd";

const COLUMNS: Array<{ key: SortKey; label: string; numeric: boolean }> = [
  { key: "bucket", label: "name", numeric: false },
  { key: "requests", label: "req", numeric: true },
  { key: "sessions", label: "sess", numeric: true },
  { key: "avg", label: "avg/req", numeric: true },
  { key: "inputTokens", label: "input", numeric: true },
  { key: "outputTokens", label: "output", numeric: true },
  { key: "cacheReadTokens", label: "cache", numeric: true },
  { key: "cachePct", label: "%cache", numeric: true },
  { key: "sharePct", label: "%share", numeric: true },
  { key: "costUsd", label: "cost", numeric: true },
];

function sortValue(r: Row, key: SortKey): number | string {
  switch (key) {
    case "bucket":
      return r.bucket;
    case "avg":
      return r.requests > 0 ? totalTokens(r) / r.requests : 0;
    case "cachePct":
      return cachePct(r.inputTokens, r.cacheReadTokens);
    default:
      return r[key] as number;
  }
}

export function UsageTable({
  data,
  showEmail,
}: {
  data: TablePayload;
  showEmail: boolean;
}) {
  const [sortKey, setSortKey] = useState<SortKey>("costUsd");
  const [asc, setAsc] = useState(false);

  const rows = useMemo(() => {
    const sorted = [...data.rows];
    const dir = asc ? 1 : -1;
    sorted.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      const cmp =
        typeof va === "string" || typeof vb === "string"
          ? String(va).localeCompare(String(vb))
          : va - vb;
      return cmp * dir || b.requests - a.requests || a.bucket.localeCompare(b.bucket);
    });
    return sorted;
  }, [data.rows, sortKey, asc]);

  const clickColumn = (key: SortKey) => {
    if (key === sortKey) setAsc(!asc);
    else {
      setSortKey(key);
      setAsc(key === "bucket");
    }
  };

  const renderName = (r: Row) => {
    const email = data.emails?.[r.bucket];
    return email !== undefined && showEmail ? `${r.bucket} <${email}>` : r.bucket;
  };

  const cellFor = (r: Row, key: SortKey): string => {
    switch (key) {
      case "bucket":
        return "";
      case "requests":
        return r.requests.toLocaleString("en-US");
      case "sessions":
        return r.sessions.toLocaleString("en-US");
      case "avg":
        return humanCount(r.requests > 0 ? totalTokens(r) / r.requests : 0);
      case "inputTokens":
        return humanCount(r.inputTokens);
      case "outputTokens":
        return humanCount(r.outputTokens);
      case "cacheReadTokens":
        return humanCount(r.cacheReadTokens);
      case "cachePct":
        return `${cachePct(r.inputTokens, r.cacheReadTokens)}%`;
      case "sharePct":
        return `${r.sharePct}%`;
      case "costUsd":
        return formatCost(r.costUsd);
    }
  };

  const gaugeCell = (r: Row) => {
    const g = data.gauges[r.bucket];
    if (g !== undefined) return <Gauge frac={g.frac} label={g.label} />;
    return (
      <span className="inline-flex items-baseline">
        {formatCost(r.costUsd)}
        <DeltaBadge current={r.costUsd} previous={data.prevCostById?.[r.bucket]} />
      </span>
    );
  };

  return (
    <table className="w-full border-collapse text-xs">
      <thead>
        <tr>
          {COLUMNS.map((c) => (
            <th
              key={c.key}
              onClick={() => clickColumn(c.key)}
              className={`cursor-pointer border-b border-edge px-2 py-1.5 text-[10px] tracking-wider whitespace-nowrap text-muted uppercase select-none hover:text-ink ${
                c.numeric ? "text-right" : "text-left"
              }`}
            >
              {c.label}
              {sortKey === c.key ? (asc ? " ↑" : " ↓") : ""}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.bucket} className="border-b border-edge/60 hover:bg-panel2">
            <td className="px-2 py-1.5 text-left whitespace-nowrap">{renderName(r)}</td>
            <td className="px-2 py-1.5 text-right">{cellFor(r, "requests")}</td>
            <td className="px-2 py-1.5 text-right">{cellFor(r, "sessions")}</td>
            <td className="px-2 py-1.5 text-right">{cellFor(r, "avg")}</td>
            <td className="px-2 py-1.5 text-right">{cellFor(r, "inputTokens")}</td>
            <td className="px-2 py-1.5 text-right">{cellFor(r, "outputTokens")}</td>
            <td className="px-2 py-1.5 text-right">{cellFor(r, "cacheReadTokens")}</td>
            <td className="px-2 py-1.5 text-right">{cellFor(r, "cachePct")}</td>
            <td className="px-2 py-1.5 text-right">{cellFor(r, "sharePct")}</td>
            <td className="px-2 py-1.5 text-right whitespace-nowrap">{gaugeCell(r)}</td>
          </tr>
        ))}
        <tr className="font-semibold text-accent">
          <td className="px-2 py-1.5 text-left">TOTAL</td>
          <td className="px-2 py-1.5 text-right">{data.total.requests.toLocaleString("en-US")}</td>
          <td className="px-2 py-1.5 text-right">{data.total.sessions.toLocaleString("en-US")}</td>
          <td className="px-2 py-1.5 text-right">
            {humanCount(data.total.requests > 0 ? totalTokens(data.total) / data.total.requests : 0)}
          </td>
          <td className="px-2 py-1.5 text-right">{humanCount(data.total.inputTokens)}</td>
          <td className="px-2 py-1.5 text-right">{humanCount(data.total.outputTokens)}</td>
          <td className="px-2 py-1.5 text-right">{humanCount(data.total.cacheReadTokens)}</td>
          <td className="px-2 py-1.5 text-right">{cachePct(data.total.inputTokens, data.total.cacheReadTokens)}%</td>
          <td className="px-2 py-1.5 text-right">100%</td>
          <td className="px-2 py-1.5 text-right">
            <span className="inline-flex items-baseline">
              {formatCost(data.total.costUsd)}
              <DeltaBadge current={data.total.costUsd} previous={data.totalPrevCost} />
            </span>
          </td>
        </tr>
      </tbody>
    </table>
  );
}
