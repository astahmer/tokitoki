import { defineChart } from "@tanstack/charts";
import { pie, polar, radialArc } from "@tanstack/charts/polar";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { Chart } from "@tanstack/charts/react";

import { formatCost, humanCount } from "../lib/fmt";
import type { Row } from "../lib/api";

// Palette readable on both light and dark backgrounds.
const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#f43f5e", "#06b6d4", "#8b5cf6", "#84cc16"];

/** Donut share of total tokens per bucket (TanStack polar pie). */
export function DonutShare({ rows }: { rows: Row[] }) {
  const data = rows
    .map((r) => ({
      name: r.bucket,
      tokens:
        r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
      cost: r.costUsd,
    }))
    .filter((d) => d.tokens > 0)
    .slice(0, 7);
  if (data.length === 0) {
    return <p className="py-8 text-center text-xs text-muted">no usage recorded</p>;
  }

  const slices = pie(data, { value: "tokens" });
  const names = data.map((d) => d.name);
  const definition = defineChart({
    marks: [
      polar({
        inset: 8,
        radiusRatio: 0.82,
        marks: [
          radialArc(slices, {
            innerRadius: ({ radius }: { radius: number }) => radius * 0.58,
            cornerRadius: 4,
            color: "name",
            key: "name",
          }),
        ],
      }),
    ],
    color: {
      // Own the domain order so colors stay stable when data is refiltered.
      scale: scaleOrdinal<string, string>().domain(names).range(COLORS.slice(0, names.length)),
    },
  });

  const total = data.reduce((s, d) => s + d.tokens, 0);
  return (
    <div className="flex flex-wrap items-center gap-6">
      <Chart definition={definition} height={220} ariaLabel="usage share donut" />
      <ul className="space-y-1 text-xs">
        {data.map((d, i) => (
          <li key={d.name} className="flex items-center gap-2">
            <span
              className="inline-block size-2.5 rounded-sm"
              style={{ background: COLORS[i % COLORS.length] }}
            />
            <span className="text-ink">{d.name}</span>
            <span className="text-muted">
              {Math.round((d.tokens / total) * 100)}% · {humanCount(d.tokens)} tok ·{" "}
              {formatCost(d.cost)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
