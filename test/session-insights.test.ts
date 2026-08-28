import { describe, expect, it } from "bun:test";

import { describeSessionEvent, estimateCacheDuration } from "../src/session-insights.ts";

const sample = (second: number, cacheReadTokens: number, inputTokens = 1000) => ({
  ts: `2026-08-28T10:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`,
  inputTokens,
  cacheReadTokens,
});

describe("session insights", () => {
  it("does not invent a cache lifetime without repeated cache transitions", () => {
    const estimate = estimateCacheDuration([sample(0, 0), sample(60, 900), sample(120, 900)]);
    expect(estimate.estimatedSeconds).toBeNull();
    expect(estimate.confidence).toBe("low");
  });

  it("uses the median interval between separated cache busts", () => {
    const estimate = estimateCacheDuration([
      sample(0, 900), sample(60, 900), sample(120, 0),
      sample(180, 900), sample(240, 900), sample(300, 0),
      sample(360, 900), sample(420, 900), sample(480, 0),
    ]);
    expect(estimate.estimatedSeconds).toBe(180);
    expect(estimate.busts).toBe(3);
    expect(estimate.confidence).toBe("medium");
  });

  it("describes tools and falls back to a compact message excerpt", () => {
    expect(describeSessionEvent({ model: "gpt", tool: "tools.read_file" }, 0)).toContain("tool call");
    expect(describeSessionEvent({ model: "gpt" }, 0, "Inspect the cache implementation")).toContain("Inspect the cache");
  });
});
