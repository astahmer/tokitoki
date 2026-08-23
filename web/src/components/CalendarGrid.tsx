import { useMemo, useState } from "react";

import type { GridCell } from "../lib/api";
import { formatCost, humanCount } from "../lib/fmt";

export type GridMetric = "tokens" | "cost" | "requests";

// Classes defined in index.css — light mode gets solid tint mixes (alpha
// steps were invisible on white), dark mode keeps the alpha ramp.
const LEVEL_BG = ["heat-0", "heat-1", "heat-2", "heat-3", "heat-4"];
const DAY_LABELS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];
const CELL = 13; // px pitch: 12px square + 1px gap

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

function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

interface BuiltCell {
  iso: string;
  level: number;
  title: string;
  requests: number;
  tokens: number;
  costUsd: number;
}

/**
 * GitHub-style contribution grid: weeks as COLUMNS left→right, weekdays
 * Mon..Sun as fixed ROWS top→bottom, month labels along the top.
 * Cells show a rich hover card (date + requests + tokens + cost).
 */
export function CalendarGrid({ cells, metric }: { cells: GridCell[]; metric: GridMetric }) {
  const [hover, setHover] = useState<{
    x: number;
    y: number;
    iso: string;
    requests: number;
    tokens: number;
    costUsd: number;
  } | undefined>(undefined);

  const grid = useMemo(() => {
    const byDay = new Map(cells.map((c) => [c.day, c]));
    const max = Math.max(0, ...cells.map((c) => metricValue(c, metric)));
    const today = new Date();
    const start = new Date(today);
    start.setDate(start.getDate() - 364);

    // Align first column to Monday.
    const first = new Date(start);
    first.setDate(first.getDate() - ((first.getDay() + 6) % 7));

    // weeks[column][row]
    const weeks: Array<Array<BuiltCell | null>> = [];
    const labels: Array<{ col: number; label: string }> = [];
    let lastMonth = -1;
    const cursor = new Date(first);
    while (cursor <= today) {
      const week: Array<BuiltCell | null> = [];
      for (let row = 0; row < 7; row++) {
        const probe = new Date(cursor);
        probe.setDate(cursor.getDate() + row);
        if (probe < start || probe > today) {
          week.push(null);
          continue;
        }
        const iso = localIso(probe);
        const cell = byDay.get(iso) ?? { day: iso, tokens: 0, costUsd: 0, requests: 0 };
        const value = metricValue(cell, metric);
        const frac = max > 0 && value > 0 ? value / max : 0;
        const level = value <= 0 ? 0 : frac < 0.25 ? 1 : frac < 0.5 ? 2 : frac < 0.75 ? 3 : 4;
        week.push({
          iso,
          level,
          title: `${iso} · ${metric}: ${metric === "cost" ? formatCost(value) : humanCount(value)}`,
          requests: cell.requests,
          tokens: cell.tokens,
          costUsd: cell.costUsd,
        });
      }
      // Label a month when its first observable day appears in this column.
      const firstDay = week.find((c) => c !== null);
      if (firstDay !== undefined) {
        const month = Number(firstDay.iso.slice(5, 7));
        if (month !== lastMonth) {
          lastMonth = month;
          labels.push({
            col: weeks.length,
            label: new Date(firstDay.iso + "T00:00:00").toLocaleString("en-US", { month: "short" }),
          });
        }
      }
      weeks.push(week);
      cursor.setDate(cursor.getDate() + 7);
    }
    return { weeks, labels };
  }, [cells, metric]);

  // Transposed render: one flex ROW per weekday, cells across all weeks.
  const rows = [0, 1, 2, 3, 4, 5, 6].map((row) =>
    grid.weeks.map((week) => week[row] ?? null),
  );

  return (
    <div className="overflow-x-auto">
      <div className="inline-block">
        <div className="relative ml-10 h-4">
          {grid.labels.map(({ col, label }) => (
            <span
              key={`${col}-${label}`}
              className="absolute text-[10px] text-muted"
              style={{ left: col * CELL }}
            >
              {label}
            </span>
          ))}
        </div>
        {rows.map((weekRow, i) => (
          <div key={i} className="flex items-center">
            <span className="w-10 shrink-0 text-[10px] leading-[13px] text-muted">
              {DAY_LABELS[i]}
            </span>
            {weekRow.map((cell, j) =>
              cell === null ? (
                <span key={j} className="size-[12px] rounded-[2px]" />
              ) : (
                <span
                  key={j}
                  title={cell.title}
                  onMouseEnter={(e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    setHover({
                      x: rect.left + rect.width / 2,
                      y: rect.top,
                      iso: cell.iso,
                      requests: cell.requests,
                      tokens: cell.tokens,
                      costUsd: cell.costUsd,
                    });
                  }}
                  onMouseLeave={() => setHover(undefined)}
                  className={`mr-px size-[12px] cursor-default rounded-[2px] ${LEVEL_BG[cell.level]}`}
                />
              ),
            )}
          </div>
        ))}
        <div className="ml-10 mt-1 flex items-center gap-1 text-[10px] text-muted">
          less
          {LEVEL_BG.map((c) => (
            <span key={c} className={`size-[11px] rounded-[2px] ${c}`} />
          ))}
          more
        </div>
      </div>
      {hover !== undefined && (
        <div
          className="pointer-events-none fixed z-50 -translate-x-1/2 -translate-y-full rounded-md border border-edge bg-panel px-2.5 py-1.5 text-[11px] shadow-lg"
          style={{ left: hover.x, top: hover.y - 6 }}
        >
          <div className="font-medium">{hover.iso}</div>
          <div className="text-muted">
            {hover.requests.toLocaleString("en-US")} req · {humanCount(hover.tokens)} tok ·{" "}
            {formatCost(hover.costUsd)}
          </div>
        </div>
      )}
    </div>
  );
}
