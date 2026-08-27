import { describe, expect, it } from "bun:test";
import type { AggRow } from "../src/cache.ts";
import {
  burnProjection,
  deltaInfo,
  formatDelta,
  matchPlanKey,
  monthStartIso,
  planGaugeFn,
  previousWindow,
  renderBurnLine,
  renderMiniProjects,
  renderTable,
} from "../src/report.ts";

function row(overrides: Partial<AggRow> & { bucket: string }): AggRow {
  return {
    requests: 10,
    sessions: 4,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 500,
    cacheWriteTokens: 0,
    costUsd: 1,
    ...overrides,
  };
}

describe("deltaInfo", () => {
  it("reports increase with rounded pct", () => {
    expect(deltaInfo(150, 100)).toEqual({ kind: "up", pct: 50 });
  });
  it("reports decrease with positive magnitude", () => {
    expect(deltaInfo(75, 100)).toEqual({ kind: "down", pct: 25 });
  });
  it("flags new buckets (prev=0, cur>0)", () => {
    expect(deltaInfo(5, 0)).toEqual({ kind: "new", pct: 0 });
    expect(deltaInfo(5, undefined as unknown as number).kind).toBe("");
  });
  it("drops to -100% when current is zero and prev was not", () => {
    expect(deltaInfo(0, 42)).toEqual({ kind: "down", pct: 100 });
  });
  it("is empty for zero-vs-zero and missing previous", () => {
    expect(deltaInfo(0, 0).kind).toBe("");
    expect(deltaInfo(3, undefined).kind).toBe("");
  });
  it("formats ▲/▼/▲new", () => {
    expect(formatDelta({ kind: "up", pct: 12 })).toBe("▲12%");
    expect(formatDelta({ kind: "down", pct: 8 })).toBe("▼8%");
    expect(formatDelta({ kind: "new", pct: 0 })).toBe("▲new");
    expect(formatDelta({ kind: "", pct: 0 })).toBe("");
  });
});

describe("burnProjection", () => {
  it("projects cost across the full month", () => {
    // Jan 15, 2024 → dayOfMonth 15, daysInMonth 31
    const now = new Date(2024, 0, 15);
    const b = burnProjection(150, now);
    expect(b.perDay).toBeCloseTo(10);
    expect(b.projected).toBeCloseTo(310);
  });
  it("handles February leap years", () => {
    const b = burnProjection(290, new Date(2024, 1, 29)); // Feb 29 / 29 days
    expect(b.perDay).toBe(10);
    expect(b.projected).toBe(290);
  });
  it("renders request-based line when costs are all zero", () => {
    const line = renderBurnLine(0, 310, new Date(2024, 0, 31));
    expect(line).toContain("req/day");
    expect(line).not.toContain("$");
  });
  it("renders dollar line when there is spend", () => {
    const line = renderBurnLine(150, 9999, new Date(2024, 0, 15));
    expect(line).toContain("burn: $10.00/day");
    expect(line).toContain("projected $310 by month end");
    expect(line).not.toContain("req");
  });
});

describe("previousWindow", () => {
  it("day = prior local calendar day", () => {
    const { sinceIso, untilIso } = previousWindow("day", new Date(2024, 5, 20, 14, 30));
    expect(untilIso).toBe(new Date(2024, 5, 20).toISOString());
    expect(sinceIso).toBe(new Date(2024, 5, 19).toISOString());
  });
  it("week windows are exactly 7 days wide", () => {
    const now = new Date(Date.UTC(2024, 5, 20, 12));
    const { sinceIso, untilIso } = previousWindow("week", now);
    // previous window = [now − 14d, now − 7d)
    expect(new Date(untilIso).getTime()).toBe(now.getTime() - 7 * 24 * 3600_000);
    expect(new Date(sinceIso).getTime()).toBe(now.getTime() - 14 * 24 * 3600_000);
    expect(new Date(untilIso).getTime() - new Date(sinceIso).getTime()).toBe(7 * 24 * 3600_000);
  });
  it("year windows are exactly 365 days wide", () => {
    const now = new Date(Date.UTC(2024, 5, 20, 12));
    const { sinceIso, untilIso } = previousWindow("year", now);
    expect(new Date(untilIso).getTime() - new Date(sinceIso).getTime()).toBe(365 * 24 * 3600_000);
  });
  it("monthStartIso lands on the 1st local midnight", () => {
    expect(monthStartIso(new Date(2024, 2, 17))).toBe(new Date(2024, 2, 1).toISOString());
  });
});

describe("plan gauges", () => {
  const plans = {
    codex: { kind: "subscription" as const, monthlyRequestCap: 1000 },
    "pi-*": { kind: "subscription" as const, monthlyCostCap: 200 },
  };
  const mtd = new Map<string, AggRow>([["codex", row({ bucket: "codex", requests: 420 })]]);

  it("matches exact keys and trailing-* prefixes", () => {
    expect(matchPlanKey(plans, "codex")).toBe("codex");
    expect(matchPlanKey(plans, "pi-personal")).toBe("pi-*");
    expect(matchPlanKey(plans, "other")).toBeUndefined();
  });

  it("renders a gauge with usage vs cap", () => {
    const g = planGaugeFn(plans, mtd)!;
    const cell = g("codex")!;
    expect(cell).toContain("▇▇▇▇");
    expect(cell).toContain("42% of 1K req cap");
  });

  it("shows an empty gauge when the account has no MTD usage", () => {
    const g = planGaugeFn(plans, mtd)!;
    expect(g("unknown-account")).toBeUndefined(); // no matching plan
    const g2 = planGaugeFn({ pi2: { kind: "subscription", monthlyCostCap: 100 } }, mtd)!;
    // bucket matches pattern but has no usage row yet
    expect(g2("pi2")).toBe("░░░░░░░░░░ 0%");
  });

  it("returns undefined when no plans configured", () => {
    expect(planGaugeFn(undefined, mtd)).toBeUndefined();
  });
});

describe("renderTable extras", () => {
  it("adds %share based on cost when any cost exists", () => {
    const rows = [row({ bucket: "a", costUsd: 3 }), row({ bucket: "b", costUsd: 1 })];
    const out = renderTable(rows);
    expect(out).toContain("%share");
    expect(out).toContain(" 75% ");
    expect(out).toContain(" 25% ");
  });

  it("falls back to token share when all costs are zero", () => {
    const rows = [
      row({ bucket: "big", costUsd: 0, outputTokens: 0, inputTokens: 3000, cacheReadTokens: 0 }),
      row({ bucket: "small", costUsd: 0, outputTokens: 0, inputTokens: 1000, cacheReadTokens: 0 }),
    ];
    const out = renderTable(rows);
    expect(out).toContain(" 75% ");
    expect(out).toContain(" 25% ");
  });

  it("appends Δ next to cost using previous-period costs", () => {
    const rows = [row({ bucket: "a", costUsd: 150 })];
    const out = renderTable(rows, {
      totalPrevCost: 100,
      prevCostById: new Map([["a", 100]]),
    });
    expect(out).toContain("▲50%");
  });

  it("replaces cost with a gauge cell for matched plans", () => {
    const rows = [row({ bucket: "codex", costUsd: 0 })];
    const g = planGaugeFn(
      { codex: { kind: "subscription", monthlyRequestCap: 10 } },
      new Map([["codex", row({ bucket: "codex", requests: 5 })]]),
    )!;
    const out = renderTable(rows, { gaugeFor: g });
    expect(out).toContain("50% of 10 req cap");
    expect(out.split("\n")[2]!).not.toContain("$0.00");
  });

  it("includes sessions and avg tokens/request columns", () => {
    const r = row({
      bucket: "a",
      sessions: 3,
      requests: 4,
      inputTokens: 400,
      outputTokens: 40,
      cacheReadTokens: 160,
      cacheWriteTokens: 0,
    });
    const out = renderTable([r]);
    expect(out).toContain("sess");
    expect(out).toContain("avg/req");
    expect(out).toContain("150"); // (400+40+160)/4 = 150
  });
});

describe("renderMiniProjects", () => {
  it("renders a small project breakdown", () => {
    const out = renderMiniProjects([
      row({ bucket: "~/dev/api", requests: 12 }),
      row({ bucket: "~/dev/web", requests: 3 }),
    ]);
    expect(out).toContain("project");
    expect(out).toContain("~/dev/api");
    expect(out).toContain("%cache");
  });
  it("is empty without rows", () => {
    expect(renderMiniProjects([])).toBe("");
  });
});
