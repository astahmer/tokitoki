import { useState } from "react";

import { Badge, Surface, Table } from "@cloudflare/kumo";

import { fetchAnomalies } from "../lib/api";
import { formatCost, humanCount } from "../lib/fmt";
import { useAsyncStaleWhileRevalidate } from "../lib/useAsync";
import type { WindowSelection } from "../lib/api";
import { EmptyState, Heading, Pill, SkeletonBlock } from "../ui";

const METRICS = ["tokens", "cost", "requests"] as const;
export type AnomalyMetric = (typeof METRICS)[number];

export function AnomaliesView({
  win,
  onOpenDay,
}: {
  win: WindowSelection;
  /** Drill into the sessions view pinned to this day. */
  onOpenDay?: (day: string) => void;
}) {
  const [metric, setMetric] = useState<AnomalyMetric>("tokens");
  const anomalies = useAsyncStaleWhileRevalidate(
    () => fetchAnomalies(win, metric),
    [win.from ?? "", win.to ?? "", win.last ?? "", metric],
  );

  return (
    <Surface as="section" className="mb-4 p-4">
      <div className="mb-3 flex items-center justify-between">
        <Heading>anomalies · days above 3× rolling 14-day average</Heading>
        <div className="flex gap-1.5">
          {METRICS.map((m) => (
            <Pill key={m} active={metric === m} onClick={() => setMetric(m)}>
              {m}
            </Pill>
          ))}
        </div>
      </div>
      {anomalies.state === "loading" ? (
        <SkeletonBlock className="h-48" />
      ) : anomalies.state === "error" ? (
        <p className="text-xs text-kumo-danger">{anomalies.error}</p>
      ) : anomalies.data.anomalies.length === 0 ? (
        <EmptyState message="no unusual activity in this window — spikes land here when a day crosses 3× the rolling average" />
      ) : (
        <Table className="w-full text-xs">
          <Table.Header>
            <Table.Row>
              {["day", "metric", "value", "baseline (14d)", "ratio"].map((h, i) => (
                <Table.Head
                  key={h}
                  className={`whitespace-nowrap text-[10px] tracking-wider uppercase select-none ${
                    i >= 2 ? "text-right" : "text-left"
                  }`}
                >
                  {h}
                </Table.Head>
              ))}
            </Table.Row>
          </Table.Header>
          <Table.Body>
            {anomalies.data.anomalies.map((a) => (
              <Table.Row
                key={`${a.day}-${a.metric}`}
                className={onOpenDay !== undefined ? "cursor-pointer hover:bg-kumo-recessed/40" : ""}
                onClick={() => metric === "cost" || metric === "tokens" ? onOpenDay?.(a.day) : undefined}
                title={onOpenDay !== undefined ? `open sessions for ${a.day}` : undefined}
              >
                <Table.Cell className="whitespace-nowrap">{a.day}</Table.Cell>
                <Table.Cell>{a.metric}</Table.Cell>
                <Table.Cell className="text-right">{humanCount(a.value)}</Table.Cell>
                <Table.Cell className="text-right">{humanCount(a.baseline)}</Table.Cell>
                <Table.Cell className="text-right">
                  <Badge variant={a.ratio >= 10 ? "error" : "warning"}>{a.ratio.toFixed(1)}×</Badge>
                  {metric === "cost" && a.value > 0 && (
                    <span className="ml-2 text-kumo-subtle">{formatCost(a.value)}</span>
                  )}
                </Table.Cell>
              </Table.Row>
            ))}
          </Table.Body>
        </Table>
      )}
    </Surface>
  );
}
