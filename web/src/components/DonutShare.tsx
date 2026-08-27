import { defineChart } from "@tanstack/charts";
import { pie, polar, radialArc } from "@tanstack/charts/polar";
import { scaleOrdinal } from "@tanstack/charts/scales/ordinal";
import { Chart } from "@tanstack/charts/react";

import { formatCost, humanCount } from "../lib/fmt";
import type { AggRow } from "../lib/api";

// Palette readable on both light and dark backgrounds.
const COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#f43f5e", "#06b6d4", "#8b5cf6", "#84cc16"];

/**
 * Donut share per bucket (TanStack polar pie). metric="tokens" (default)
 * keeps the original behavior; "cost" sizes slices by USD spend.
 */
export function DonutShare({
  rows,
  metric = "tokens",
  selected,
  onSelect,
}: {
  rows: AggRow[];
  metric?: "tokens" | "cost";
  selected?: string;
  onSelect?: (bucket: string) => void;
}) {
  const ranked = rows
    .map((r) => ({
      name: r.bucket,
      tokens:
        r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens,
      cost: r.costUsd,
    }))
    .filter((d) => d[metric] > 0)
    .sort((a, b) => b[metric] - a[metric]);
  // Tail beyond the top 6 folds into an "other" slice so shares sum to 100%.
  const TOP_N = 6;
  const data =
    ranked.length > TOP_N
      ? [
          ...ranked.slice(0, TOP_N),
          {
            name: "other",
            tokens: ranked.slice(TOP_N).reduce((s, d) => s + d.tokens, 0),
            cost: ranked.slice(TOP_N).reduce((s, d) => s + d.cost, 0),
          },
        ]
      : ranked;
  if (data.length === 0) {
    return <p className="py-8 text-center text-xs text-muted">no usage recorded</p>;
  }

  const slices = pie(data, { value: metric });
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

  const total = data.reduce((s, d) => s + d[metric], 0);
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
            {onSelect === undefined ? <span className="text-ink">{d.name}</span> : (
              <button
                type="button"
                onClick={() => onSelect(d.name)}
                className={`text-left hover:text-kumo-default ${selected === d.name ? "font-semibold text-kumo-default" : "text-ink"}`}
                aria-pressed={selected === d.name}
              >
                {d.name}
              </button>
            )}
            <span className="text-muted">
              {Math.round((d[metric] / total) * 100)}% ·{" "}
              {metric === "cost"
                ? formatCost(d.cost)
                : `${humanCount(d.tokens)} tok · ${formatCost(d.cost)}`}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
