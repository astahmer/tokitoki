import { useMemo } from "react";

import type { GridCell } from "../lib/api";
import { formatCost, humanCount } from "../lib/fmt";

export type GridMetric = "tokens" | "cost" | "requests";

const LEVEL_BG = ["bg-panel2", "bg-accent/20", "bg-accent/45", "bg-accent/70", "bg-accent"];
const DAY_LABELS = ["M", "", "W", "", "F", "", "S"];

function metricValue(c: GridCell, metric: GridMetric): number {
  switch (metric) {
    case "cost":
      return c.costUsd;
    case "requests":
      return c.requests;
    default:
      return c.tokens;
  }
}

/** GitHub-style contribution grid (weeks = columns, Mon–Sun = rows). */
export function CalendarGrid({ cells, metric }: { cells: GridCell[]; metric: GridMetric }) {
  const grid = useMemo(() => {
    const byDay = new Map(cells.map((c) => [c.day, c]));
    const max = Math.max(0, ...cells.map((c) => metricValue(c, metric)));
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 364);

    // Align first column to Monday.
    const first = new Date(start);
    first.setDate(first.getDate() - ((first.getDay() + 6) % 7));

    const weeks: Array<Array<{ iso: string; level: number; title: string } | null>> = [];
    const labels: Array<{ col: number; label: string }> = [];
    let lastMonth = -1;
    const cursor = new Date(first);
    while (cursor <= today) {
      const week: Array<{ iso: string; level: number; title: string } | null> = [];
      for (let row = 0; row < 7; row++) {
        const probe = new Date(cursor);
        probe.setDate(cursor.getDate() + row);
        if (probe < start || probe > today) {
          week.push(null);
          continue;
        }
        const iso = localIso(probe);
        const value = metricValue(byDay.get(iso) ?? { day: iso, tokens: 0, costUsd: 0, requests: 0 }, metric);
        const frac = max > 0 && value > 0 ? value / max : 0;
        const level = value <= 0 ? 0 : frac < 0.25 ? 1 : frac < 0.5 ? 2 : frac < 0.75 ? 3 : 4;
        week.push({
          iso,
          level,
          title: `${iso} · ${metric}: ${
            metric === "cost" ? formatCost(value) : humanCount(value)
          }`,
        });
      }
      if (cursor.getDate() <= 7) {
        const label = cursor.toLocaleString("en-US", { month: "short" });
        if (label !== undefined && lastMonth !== cursor.getMonth()) {
          lastMonth = cursor.getMonth();
          labels.push({ col: weeks.length, label });
        }
      }
      weeks.push(week);
      cursor.setDate(cursor.getDate() + 7);
    }
    void lastMonth;
    return { weeks, labels };
  }, [cells, metric]);

  return (
    <div className="overflow-x-auto">
      <div className="inline-block">
        <div className="relative ml-8 h-4">
          {grid.labels.map(({ col, label }) => (
            <span
              key={`${col}-${label}`}
              className="absolute text-[10px] text-muted"
              style={{ left: col * 15 }}
            >
              {label}
            </span>
          ))}
        </div>
        {grid.weeks.map((week, i) => (
          <div key={i} className="flex items-center">
            <span className="w-8 text-[10px] leading-[13px] text-muted">
              {DAY_LABELS[i % 7]}
            </span>
            {week.map((cell, j) =>
              cell === null ? (
                <span key={j} className="size-[13px] rounded-[2px]" />
              ) : (
                <span
                  key={j}
                  title={cell.title}
                  className={`size-[13px] rounded-[2px] ${LEVEL_BG[cell.level]}`}
                />
              ),
            )}
          </div>
        ))}
        <div className="ml-8 mt-1 flex items-center gap-1 text-[10px] text-muted">
          less
          {LEVEL_BG.map((c) => (
            <span key={c} className={`size-[11px] rounded-[2px] ${c}`} />
          ))}
          more
        </div>
      </div>
    </div>
  );
}

function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
