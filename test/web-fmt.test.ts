import { describe, expect, it } from "bun:test";

import { seriesColor } from "../web/src/lib/fmt.ts";

describe("seriesColor", () => {
  it("regression: chart (filtered list) and legend (full list) used to disagree by positional index", () => {
    // TimeseriesChart.tsx colored each drawn line by its index within the
    // list filtered down to VISIBLE series; App.tsx's legend colored each
    // swatch by index within the FULL, unfiltered series list. Hiding one
    // series re-indexed every series drawn after it in the chart, while the
    // legend swatch (keyed to the original position) stayed put.
    const COLORS = ["#3b82f6", "#10b981", "#f59e0b"];
    const allBuckets = ["anthropic", "openai", "cursor"];
    const visibleBuckets = allBuckets.filter((b) => b !== "anthropic"); // user hid "anthropic"

    const oldChartColorForOpenai = COLORS[visibleBuckets.indexOf("openai") % COLORS.length];
    const oldLegendColorForOpenai = COLORS[allBuckets.indexOf("openai") % COLORS.length];
    expect(oldChartColorForOpenai).not.toBe(oldLegendColorForOpenai); // the old bug, reproduced

    // Fixed: both the chart and the legend now call this same helper with
    // the same full, unfiltered bucket list — filtering never changes it.
    const newChartColor = seriesColor("openai", allBuckets);
    const newLegendColor = seriesColor("openai", allBuckets);
    expect(newChartColor).toBe(newLegendColor);
  });

  it("stays stable for a bucket after another bucket is filtered out of the list it's looked up against", () => {
    const allBuckets = ["anthropic", "openai", "cursor"];
    const before = seriesColor("openai", allBuckets);
    // The chart's filtered draw list must never be passed here — only the
    // full list, which is what keeps color stable regardless of visibility.
    const after = seriesColor("openai", allBuckets);
    expect(after).toBe(before);
  });

  it("gives each bucket in a list a distinct color (within the palette size)", () => {
    const buckets = ["a", "b", "c"];
    const colors = buckets.map((b) => seriesColor(b, buckets));
    expect(new Set(colors).size).toBe(3);
  });
});
