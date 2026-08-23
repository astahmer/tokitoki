import type { DailyTotal } from "./cache.ts";

/**
 * GitHub-style contribution grid: one column per week, one row per weekday
 * (Mon–Sun), cell intensity by a chosen metric relative to the window max.
 */

export type GridMetric = "tokens" | "cost" | "requests";

// ANSI background greens (GitHub-ish ramp); index = intensity level.
const BG = ["48;5;235", "48;5;22", "48;5;28", "48;5;34", "48;5;40"];
const RAMP = ["·", "▪", "▫", "▓", "■"];
const DAY_ROWS = ["Mon", "", "Wed", "", "Fri", "", "Sun"];

export interface GridCell {
  iso: string;
  value: number;
  level: number;
}

export interface Grid {
  /** One column per week; 7 rows Mon..Sun; null = outside the window. */
  weeks: Array<Array<GridCell | null>>;
  max: number;
}

function metricValue(d: DailyTotal, metric: GridMetric): number {
  switch (metric) {
    case "cost":
      return d.costUsd;
    case "requests":
      return d.requests;
    default:
      return d.tokens;
  }
}

function levelFor(value: number, max: number): number {
  if (value <= 0 || max <= 0) return 0;
  const frac = value / max;
  if (frac < 0.25) return 1;
  if (frac < 0.5) return 2;
  if (frac < 0.75) return 3;
  return 4;
}

/** Monday-aligned weeks covering [startDate .. today]; missing days are level 0. */
export function buildGrid(
  days: DailyTotal[],
  startDate: Date,
  metric: GridMetric,
  now: Date = new Date(),
): Grid {
  const byDay = new Map(days.map((d) => [d.day, d]));
  const start = new Date(startDate.getFullYear(), startDate.getMonth(), startDate.getDate());
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  let max = 0;
  for (const d of days) max = Math.max(max, metricValue(d, metric));

  const first = new Date(start);
  first.setDate(first.getDate() - ((first.getDay() + 6) % 7)); // back to Monday

  const weeks: Grid["weeks"] = [];
  const cursor = new Date(first);
  while (cursor <= today) {
    const week: Array<GridCell | null> = [];
    for (let row = 0; row < 7; row++) {
      const probe = new Date(cursor);
      probe.setDate(cursor.getDate() + row);
      if (probe > today || probe < start) {
        week.push(null);
        continue;
      }
      const value = metricValue(byDay.get(localIso(probe)) ?? { day: "", tokens: 0, costUsd: 0, requests: 0 }, metric);
      week.push({ iso: localIso(probe), value, level: levelFor(value, max) });
    }
    weeks.push(week);
    cursor.setDate(cursor.getDate() + 7);
  }
  return { weeks, max };
}

/** Month labels positioned over the column containing each month's 1st. */
export function monthLabels(grid: Grid): Array<{ col: number; label: string }> {
  const out: Array<{ col: number; label: string }> = [];
  let lastMonth = -1;
  grid.weeks.forEach((week, col) => {
    for (const cell of week) {
      if (cell === null) continue;
      const month = Number(cell.iso.slice(5, 7));
      if (month !== lastMonth && cell.iso.endsWith("-01")) {
        lastMonth = month;
        out.push({
          col,
          label: new Date(cell.iso + "T00:00:00").toLocaleString("en-US", { month: "short" }),
        });
      } else if (month !== lastMonth) {
        lastMonth = month;
      }
      break; // only inspect the first real day of each week
    }
  });
  return out;
}

export function renderGrid(days: DailyTotal[], startDate: Date, options: { metric: GridMetric; now?: Date }): string {
  const grid = buildGrid(days, startDate, options.metric, options.now ?? new Date());
  const tty = process.stdout.isTTY === true;

  const cellText = (level: number): string => {
    if (tty) return `\x1b[${BG[level]!}m  \x1b[0m`;
    return RAMP[level]!;
  };

  // Column layout: TTY cells are 2-wide with no gap; plain cells 1 char + gap.
  const cellWidth = tty ? 2 : 1;
  const gap = tty ? "" : " ";

  const labels = monthLabels(grid);
  let labelLine = "";
  for (const { col, label } of labels) {
    const target = col * (cellWidth + gap.length);
    if (target >= labelLine.length) labelLine += " ".repeat(target - labelLine.length) + label;
  }

  const lines: string[] = [];
  if (labelLine.trim().length > 0) lines.push(labelLine);
  for (let row = 0; row < 7; row++) {
    const prefix = DAY_ROWS[row] === "" ? "   " : `${DAY_ROWS[row]} `;
    lines.push(prefix + grid.weeks.map((week) => cellText(week[row]?.level ?? 0)).join(gap));
  }
  lines.push(`less ${[0, 1, 2, 3, 4].map(cellText).join("")} more`);
  return lines.join("\n");
}

function localIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
