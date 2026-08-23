import { describe, expect, test } from "bun:test";

import type { EventCache } from "../src/cache.ts";
import { computeBudgetStatus, daysLeftForScope, gaugesForMenubar } from "../src/budget-status.ts";
import type { BudgetsConfig } from "../src/budgets.ts";

// Minimal EventCache stand-in: computeBudgetStatus only calls totals() and
// aggregate() with cost-shaped rows.
function fakeCache(spends: { day: number; week: number; month: number }, accounts: Array<{ key: string; usd: number }> = []): EventCache {
  const agg = (_since: string, dim: string) =>
    dim === "account" ? accounts.map((a) => ({ bucket: a.key, costUsd: a.usd })) : [];
  return {
    totals: (sinceIso: string) => {
      const now = Date.now();
      const t = new Date(sinceIso).getTime();
      const spanDays = Math.max(1, (now - t) / 86_400_000);
      if (spanDays <= 1.5) return { costUsd: spends.day };
      if (spanDays <= 8) return { costUsd: spends.week };
      return { costUsd: spends.month };
    },
    aggregate: agg,
  } as unknown as EventCache;
}

describe("computeBudgetStatus", () => {
  test("unconfigured → configured:false with empty rows", () => {
    expect(computeBudgetStatus(fakeCache({ day: 0, week: 0, month: 0 }), undefined)).toEqual({
      configured: false,
      rows: [],
      alerts: [],
    });
  });

  test("levels map spend/cap ratios onto ok|warn|exceeded", () => {
    const cfg: BudgetsConfig = { daily: 10, weekly: 100 };
    const payload = computeBudgetStatus(fakeCache({ day: 5, week: 150, month: 0 }), cfg);
    const daily = payload.rows.find((r) => r.scope === "daily")!;
    const weekly = payload.rows.find((r) => r.scope === "weekly")!;
    expect(daily.level).toBe(0); // 50% — below warn threshold
    expect(weekly.level).toBe(100); // 150%
  });

  test("wildcard account patterns aggregate into a single gauge row", () => {
    const cfg: BudgetsConfig = { accounts: { "codex*": { monthly: 10 } } };
    const cache = fakeCache({ day: 0, week: 0, month: 0 }, [
      { key: "codex-work", usd: 5 },
      { key: "codex-perso", usd: 4 },
      { key: "pi", usd: 99 },
    ]);
    const payload = computeBudgetStatus(cache, cfg);
    expect(payload.rows).toHaveLength(1);
    expect(payload.rows[0]!.spend).toBeCloseTo(9); // wildcard matches summed
    expect(payload.rows[0]!.level).toBe(80); // 90% of the 10 cap
  });
});

describe("gaugesForMenubar", () => {
  test("scope names map explicitly (daily→day), never by string surgery", () => {
    // Regression: .replace(/ly$/, "") turned "daily" into "dai", which also
    // misrouted daysLeft into the month branch.
    const cfg: BudgetsConfig = { daily: 10 };
    const gauges = gaugesForMenubar(computeBudgetStatus(fakeCache({ day: 2, week: 2, month: 2 }), cfg));
    expect(gauges).toHaveLength(1);
    expect(gauges[0]).toMatchObject({
      scope: "day",
      label: "daily",
      unit: "usd",
      used: 2,
      cap: 10,
      ratio: 0.2,
      state: "ok",
    });
    expect(gauges[0]!.daysLeft).toBeGreaterThanOrEqual(0);
    expect(gauges[0]!.daysLeft).toBeLessThanOrEqual(1); // a calendar day rolls within 24h
  });

  test("weekly period has ≤7 days left, monthly ≤31", () => {
    expect(daysLeftForScope("week")).toBeLessThanOrEqual(7);
    expect(daysLeftForScope("month")).toBeLessThanOrEqual(31);
    expect(daysLeftForScope("day")).toBeLessThanOrEqual(1);
  });

  test("state thresholds: warn at ≥80%, exceeded at ≥100%", () => {
    const cfg: BudgetsConfig = { daily: 10, weekly: 10, monthly: 10 };
    const gauges = gaugesForMenubar(computeBudgetStatus(fakeCache({ day: 8.5, week: 10.5, month: 1 }), cfg));
    expect(gauges.find((g) => g.scope === "day")!.state).toBe("warn");
    expect(gauges.find((g) => g.scope === "week")!.state).toBe("exceeded");
    expect(gauges.find((g) => g.scope === "month")!.state).toBe("ok");
  });
});
