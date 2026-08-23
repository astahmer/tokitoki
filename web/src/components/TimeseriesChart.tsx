import { lineY } from "@tanstack/charts";
import { scaleLinear } from "@tanstack/charts/scales/linear";
import { scalePoint } from "@tanstack/charts/scales/point";
import { Chart } from "@tanstack/charts/react";
import { tooltip } from "@tanstack/charts/tooltip";
import { defineChart } from "@tanstack/charts";
import { useMemo } from "react";

import type { TimeseriesPayload } from "../lib/api";

const COLORS = ["#7aa2f7", "#9ece6a", "#e0af68", "#f7768e", "#7dcfff"];

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
      axis: { label: metric },
    },
    tooltip,
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
