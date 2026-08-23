import { lineY } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scalePoint } from "@tanstack/charts/scales/point";
import { Chart } from "@tanstack/charts/react";
import { tooltip } from "@tanstack/charts/tooltip";
import { defineChart, type ChartPoint } from "@tanstack/charts";
import { useMemo } from "react";

import type { TimeseriesPayload } from "../lib/api";
import { humanCount } from "../lib/fmt";

// Palette readable on both light and dark backgrounds.
const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#f43f5e", "#06b6d4", "#8b5cf6", "#84cc16"];

function buildDefinition(
  payload: TimeseriesPayload,
  metric: "tokens" | "cost",
  show: Set<string>,
) {
  const marks = payload.series
    .filter((s) => show.has(s.bucket))
    .map((s, i) => {
      const rows = payload.days.map((day, j) => ({ day, value: s.values[j] ?? 0 }));
      return lineY(rows, {
        x: "day",
        y: "value",
        stroke: COLORS[i % COLORS.length]!,
        key: () => s.bucket,
      });
    });
  return defineChart({
    marks,
    x: { scale: () => scalePoint<string>().padding(0.2) },
    y: {
      scale: scaleLinear,
      nice: true,
      grid: true,
      axis: {
        label: metric,
        // Human-formatted tick labels (1.5B instead of 1500000000).
        ticks: { format: (v: number) => humanCount(v) },
      },
    },
    // Hover: date header + per-series raw values (human-formatted).
    tooltip: {
      use: tooltip,
      formatGroup: (points: readonly ChartPoint[]) => {
        const day = String(points[0]?.xValue ?? "");
        const lines = points.map((p) => {
          const value = typeof p.yValue === "number" ? p.yValue : Number(p.yValue);
          const share =
            points.length > 1 && points.reduce((acc, q) => acc + Number(q.yValue), 0) > 0
              ? ` (${Math.round((value / points.reduce((acc, q) => acc + Number(q.yValue), 0)) * 100)}%)`
              : "";
          return `${p.key}: ${humanCount(value)}${share}`;
        });
        return `${day}\n${lines.join("\n")}`;
      },
    },
  });
}

export function TimeseriesChart({
  data,
  metric,
  visible,
}: {
  data: TimeseriesPayload;
  metric: "tokens" | "cost";
  /** Bucket names currently toggled on (legend). Empty set = hide chart body. */
  visible: Set<string>;
}) {
  const definition = useMemo(
    () => buildDefinition(data, metric, visible),
    [data, metric, visible],
  );
  if (visible.size === 0) {
    return <p className="py-8 text-center text-xs text-muted">no series selected</p>;
  }
  return <Chart definition={definition} height={280} ariaLabel="daily usage timeseries" />;
}
