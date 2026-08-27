import { describe, expect, test } from "bun:test";
import { computeSpendHealth } from "../src/spend-health.ts";

describe("spend health", () => {
  test("projects month-end spend from month-to-date burn", () => {
    const health = computeSpendHealth({ costUsd: 150, requests: 42 }, new Date(2024, 0, 15), 400);
    expect(health.monthToDate).toBe(150);
    expect(health.requests).toBe(42);
    expect(health.perDay).toBe(10);
    expect(health.projected).toBe(310);
    expect(health.projectedRatio).toBeCloseTo(0.775);
    expect(health.state).toBe("ok");
  });

  test("warns and then exceeds at the configured projected cap", () => {
    expect(computeSpendHealth({ costUsd: 120, requests: 1 }, new Date(2024, 0, 10), 450).state).toBe("warn");
    expect(computeSpendHealth({ costUsd: 120, requests: 1 }, new Date(2024, 0, 10), 350).state).toBe("exceeded");
  });

  test("reports burn without inventing a warning when no cap exists", () => {
    const health = computeSpendHealth({ costUsd: 20, requests: 8 }, new Date(2024, 1, 5));
    expect(health.projected).toBeCloseTo(116);
    expect(health.monthlyCap).toBeUndefined();
    expect(health.projectedRatio).toBeUndefined();
    expect(health.state).toBe("ok");
  });
});
