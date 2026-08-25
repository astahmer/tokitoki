import { useMemo, useState } from "react";

import { Badge, Table } from "@cloudflare/kumo";

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
    if (g !== undefined) {
      const used = g.unit === "usd" ? formatCost(g.used) : g.used.toLocaleString("en-US");
      const cap = g.unit === "usd" ? formatCost(g.cap) : g.cap.toLocaleString("en-US");
      return (
        <Gauge
          frac={g.frac}
          label={g.label}
          tooltip={`${r.bucket}: ${used} of ${cap} this month (${(g.frac * 100).toFixed(1)}%)`}
        />
      );
    }
    return (
      <span className="inline-flex items-baseline gap-1.5">
        {formatCost(r.costUsd)}
        <DeltaBadge current={r.costUsd} previous={data.prevCostById?.[r.bucket]} />
      </span>
    );
  };

  return (
    <Table className="w-full text-xs">
      <Table.Header>
        <Table.Row>
          {COLUMNS.map((c) => (
            <Table.Head
              key={c.key}
              onClick={() => clickColumn(c.key)}
              className={`cursor-pointer px-3 py-2 text-[10px] tracking-wider whitespace-nowrap uppercase select-none hover:text-kumo-default ${
                c.key === "sessions" || c.key === "avg" ? "hidden lg:table-cell" : ""
              } ${c.key === "inputTokens" || c.key === "outputTokens" || c.key === "cacheReadTokens" ? "hidden xl:table-cell" : ""} ${
                c.numeric ? "text-right" : "text-left"
              }`}
              aria-sort={sortKey === c.key ? (asc ? "ascending" : "descending") : "none"}
            >
              {c.label}
              {sortKey === c.key ? (asc ? " ↑" : " ↓") : ""}
            </Table.Head>
          ))}
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {rows.map((r) => (
          <Table.Row key={r.bucket} className="[&>td]:border-b [&>td]:border-edge/40 hover:bg-kumo-recessed/40">
            {/* min-w reserves the space emails will occupy, so toggling
                show-email swaps text in place instead of shifting columns */}
            <Table.Cell className="min-w-44 whitespace-nowrap lg:min-w-64">{renderName(r)}</Table.Cell>
            <Table.Cell className="text-right tabular-nums opacity-80">{cellFor(r, "requests")}</Table.Cell>
            <Table.Cell className="hidden text-right tabular-nums opacity-80 lg:table-cell">{cellFor(r, "sessions")}</Table.Cell>
            <Table.Cell className="hidden text-right tabular-nums opacity-80 lg:table-cell">{cellFor(r, "avg")}</Table.Cell>
            <Table.Cell className="hidden text-right tabular-nums opacity-60 xl:table-cell">{cellFor(r, "inputTokens")}</Table.Cell>
            <Table.Cell className="hidden text-right tabular-nums opacity-60 xl:table-cell">{cellFor(r, "outputTokens")}</Table.Cell>
            <Table.Cell className="hidden text-right tabular-nums opacity-60 xl:table-cell">{cellFor(r, "cacheReadTokens")}</Table.Cell>
            <Table.Cell className="whitespace-nowrap text-right font-medium tabular-nums">{cellFor(r, "cachePct")}</Table.Cell>
            <Table.Cell className="text-right tabular-nums opacity-80">{r.sharePct}%</Table.Cell>
            <Table.Cell className="whitespace-nowrap text-right font-medium tabular-nums">{gaugeCell(r)}</Table.Cell>
          </Table.Row>
        ))}
        <Table.Row className="font-semibold">
          <Table.Cell>TOTAL</Table.Cell>
          <Table.Cell className="text-right">
            {data.total.requests.toLocaleString("en-US")}
          </Table.Cell>
          <Table.Cell className="hidden text-right">
            {data.total.sessions.toLocaleString("en-US")}
          </Table.Cell>
          <Table.Cell className="hidden text-right">
            {humanCount(data.total.requests > 0 ? totalTokens(data.total) / data.total.requests : 0)}
          </Table.Cell>
          <Table.Cell className="hidden text-right">{humanCount(data.total.inputTokens)}</Table.Cell>
          <Table.Cell className="hidden text-right">{humanCount(data.total.outputTokens)}</Table.Cell>
          <Table.Cell className="hidden text-right">
            {humanCount(data.total.cacheReadTokens)}
          </Table.Cell>
          <Table.Cell className="text-right">
            {cachePct(data.total.inputTokens, data.total.cacheReadTokens)}%
          </Table.Cell>
          <Table.Cell className="text-right">100%</Table.Cell>
          <Table.Cell className="whitespace-nowrap text-right">
            <span className="inline-flex items-baseline gap-1.5">
              {formatCost(data.total.costUsd)}
              <Badge variant="primary" className="ml-0.5">
                Σ
              </Badge>
              <DeltaBadge current={data.total.costUsd} previous={data.totalPrevCost} />
            </span>
          </Table.Cell>
        </Table.Row>
      </Table.Body>
    </Table>
  );
}
