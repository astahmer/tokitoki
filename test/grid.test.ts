import { describe, expect, it, test } from "bun:test";

import { buildGrid, monthLabels, renderGrid } from "../src/grid.ts";
import type { DailyTotal } from "../src/cache.ts";

const day = (iso: string, tokens: number): DailyTotal => ({
  day: iso,
  tokens,
  costUsd: tokens / 1e6,
  requests: tokens / 1000,
});

// Fixture: two busy days + quiet days inside one known week window.
// 2026-08-17 is a Monday; today is pinned to Sun 2026-08-23.
const NOW = new Date("2026-08-23T12:00:00");
const FIXTURE = [
  day("2026-08-17", 100),
  day("2026-08-19", 900), // window max → level 4
  day("2026-08-21", 450), // ~max/2
];

describe("grid", () => {
  it("aligns columns to weeks with Mon..Sun rows", () => {
    const grid = buildGrid(FIXTURE, new Date("2026-08-17T00:00:00"), "tokens", NOW);
    expect(grid.weeks.length).toBe(1);
    expect(grid.weeks[0]).toHaveLength(7);
    // Mon=level1(100/900<0.25), Wed=level4(max), Fri=level2(0.5), others empty
    expect(grid.weeks[0]![0]!.level).toBe(1);
    expect(grid.weeks[0]![2]!.level).toBe(4);
    expect(grid.weeks[0]![4]!.level).toBe(3); // 450/900 = 0.5 → upper bucket
    expect(grid.weeks[0]![6]!.level).toBe(0);
  });

  it("renders every day exactly once — grid totals match input totals", () => {
    const start = new Date("2026-07-25T00:00:00"); // 30-day window
    const daily: DailyTotal[] = [];
    let t = 250;
    for (let i = 0; i < 30; i++) {
      const d = new Date(start);
      d.setDate(d.getDate() + i);
      t += 111_000;
      daily.push(day(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, t));
    }
    const previousNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = "1";
    const out = renderGrid(daily, start, { metric: "tokens", now: new Date("2026-08-23T12:00:00") });
    if (previousNoColor === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = previousNoColor;
    // Drop the legend line (it contains ramp glyphs too), then count cells.
    const body = out.split("\n").filter((l) => !l.startsWith("less")).join("\n");
    const ansi = new RegExp("\\x1b\\[48;5;\\d+m", "g");
    const plain = body.replaceAll(ansi, "").replaceAll("\x1b[0m", "");
    const filled = [...plain.matchAll(/[░▒▓█]/g)].length / 2; // 2-char cells
    expect(filled).toBe(30);
  });

  it("labels each month once, in order", () => {
    const start = new Date("2026-07-25T00:00:00");
    const grid = buildGrid([], start, "tokens", new Date("2026-08-23T12:00:00"));
    const labels = monthLabels(grid).map((l) => l.label);
    expect(labels).toEqual(["Jul", "Aug"]);
  });
});
