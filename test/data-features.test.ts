import { beforeAll, describe, expect, it } from "bun:test";
import { rmSync } from "node:fs";

import { buildLiteLlmTable, matchPrice, setTableForTests, estimateCost, type PricingTable } from "../src/pricing.ts";
import { detectAnomalies } from "../src/anomalies.ts";
import { evaluateBudgets, alertStateKey, filterNewAlerts } from "../src/budgets.ts";
import { parseCsv, mapColumns, importCsv } from "../src/import.ts";

// ---------------------------------------------------------------- pricing

describe("buildLiteLlmTable", () => {
  it("converts per-token costs to per-Mtok and skips non-priced rows", () => {
    const table = buildLiteLlmTable({
      "gpt-4o": {
        input_cost_per_token: 0.000_0025,
        output_cost_per_token: 0.000_01,
        cache_read_input_token_cost: 0.000_00125,
        cache_creation_input_token_cost: 0.000_003125,
        mode: "chat",
      },
      ".status": "ok",
      "text-embedding-3": { mode: "embedding" },
    });
    expect(table["gpt-4o"]).toEqual({
      inputPerMtok: 2.5,
      outputPerMtok: 10,
      cacheReadPerMtok: 1.25,
      cacheWritePerMtok: 3.125,
    });
    expect(table[".status"]).toBeUndefined();
    expect(table["text-embedding-3"]).toBeUndefined();
  });
});

describe("matchPrice", () => {
  const table: PricingTable = {
    "claude-sonnet-4": { inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75 },
    "claude-sonnet-4-5": { inputPerMtok: 3, outputPerMtok: 15, cacheReadPerMtok: 0.3, cacheWritePerMtok: 3.75 },
    gpt: { inputPerMtok: 1, outputPerMtok: 2, cacheReadPerMtok: 0, cacheWritePerMtok: 0 },
  };
  it("exact match wins", () => {
    expect(matchPrice(table, "claude-sonnet-4")!.inputPerMtok).toBe(3);
  });
  it("longest prefix resolves dated snapshots", () => {
    expect(matchPrice(table, "claude-sonnet-4-5-20250929")!.outputPerMtok).toBe(15);
  });
  it("substring fallback handles vendor-prefixed names", () => {
    expect(matchPrice(table, "openrouter/gpt")!.inputPerMtok).toBe(1);
  });
  it("returns undefined for unknown models", () => {
    expect(matchPrice(table, "deepseek-v4")).toBeUndefined();
  });
  it("estimateCost uses the live table when set", () => {
    setTableForTests({ testmodel: { inputPerMtok: 1, outputPerMtok: 10, cacheReadPerMtok: 0.1, cacheWritePerMtok: 0 } });
    const cost = estimateCost("testmodel", { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 0, cacheWriteTokens: 0 });
    expect(cost).toBeCloseTo(11);
    setTableForTests(null as unknown as PricingTable); // restore embedded
  });
});

// ---------------------------------------------------------------- anomalies

function day(day: string, tokens: number): { day: string; tokens: number; costUsd: number; requests: number } {
  return { day, tokens, costUsd: 0, requests: 0 };
}

describe("detectAnomalies", () => {
  it("flags days over 3x a busy baseline", () => {
    const days = Array.from({ length: 20 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, "0")}`, 1_000_000));
    days[19]!.tokens = 5_000_000; // 5x baseline
    const found = detectAnomalies(days as never, { metric: "tokens" });
    expect(found.length).toBe(1);
    expect(found[0]!.day).toBe("2026-08-20");
    expect(found[0]!.ratio).toBeCloseTo(5);
  });
  it("uses 2x for slow periods (mostly idle baseline)", () => {
    const days = Array.from({ length: 20 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, "0")}`, 0));
    for (let i = 0; i < 18; i += 7) days[i]!.tokens = 100_000; // sparse activity
    days[19]!.tokens = 250_000;
    const found = detectAnomalies(days as never, { metric: "tokens" });
    // Aug 15 (7x over the sparse baseline) and Aug 20 (17.5x) both qualify.
    expect(found.map((a) => a.day)).toEqual(["2026-08-15", "2026-08-20"]);
  });
  it("never flags today (partial day)", () => {
    const today = new Date();
    const iso = `${today.getFullYear()}-08-30`;
    void iso;
    const days = [
      ...Array.from({ length: 14 }, (_, i) => day(`2026-08-${String(i + 1).padStart(2, "0")}`, 1_000_000)),
      day("2026-08-30", 99_000_000),
    ];
    const found = detectAnomalies(days as never, { metric: "tokens", now: new Date("2026-08-30T12:00:00") });
    expect(found.find((a) => a.day === "2026-08-30")).toBeUndefined();
  });
  it("ignores first-ever usage days (zero baseline)", () => {
    const found = detectAnomalies([day("2026-08-01", 50_000_000)], { metric: "tokens" });
    expect(found.length).toBe(0);
  });
});

// ---------------------------------------------------------------- budgets

describe("evaluateBudgets", () => {
  it("fires 80% and 100% thresholds", () => {
    const alerts = evaluateBudgets({ daily: 85, weekly: 0, monthly: 0 }, { daily: 100 });
    expect(alerts.map((a) => a.level).sort((a, b) => a - b)).toEqual([80]);
    const alerts2 = evaluateBudgets({ daily: 150, weekly: 0, monthly: 0 }, { daily: 100 });
    expect(alerts2.map((a) => a.level).sort((a, b) => a - b)).toEqual([80, 100]);
  });
  it("matches account patterns with trailing *", () => {
    const alerts = evaluateBudgets(
      { daily: 0, weekly: 0, monthly: 0 },
      { accounts: { "codex*": { monthly: 50 } } },
      [{ key: "codex-work", daily: 0, weekly: 0, monthly: 60 }],
    );
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts[0]!.pattern).toContain("codex*");
  });
  it("ignores zero caps and zero spend", () => {
    expect(evaluateBudgets({ daily: 5, weekly: 0, monthly: 0 }, {})).toEqual([]);
    expect(evaluateBudgets({ daily: 0, weekly: 0, monthly: 0 }, { daily: 10 })).toEqual([]);
  });
});

describe("alert dedupe", () => {
  beforeAll(() => {
    rmSync("/tmp/toki-test-alerts.json", { force: true });
    rmSync("/tmp/toki-test-alerts2.json", { force: true });
  });

  it("same period+threshold fires once", () => {
    const alerts = [evaluateBudgets({ daily: 95, weekly: 0, monthly: 0 }, { daily: 100 })[0]!];
    const now = new Date("2026-08-23T10:00:00");
    const first = filterNewAlerts(alerts, now, "/tmp/toki-test-alerts.json");
    const second = filterNewAlerts(alerts, now, "/tmp/toki-test-alerts.json");
    expect(first.length).toBe(1);
    expect(second.length).toBe(0);
  });
  it("new day re-arms the daily threshold", () => {
    const alerts = [evaluateBudgets({ daily: 95, weekly: 0, monthly: 0 }, { daily: 100 })[0]!];
    filterNewAlerts(alerts, new Date("2026-08-23T10:00:00"), "/tmp/toki-test-alerts2.json");
    const next = filterNewAlerts(alerts, new Date("2026-08-24T10:00:00"), "/tmp/toki-test-alerts2.json");
    expect(next.length).toBe(1);
  });
  it("state key differs per scope/period/pattern", () => {
    const base = { spend: 90, cap: 100, pct: 0.9, level: 80 };
    const k1 = alertStateKey({ ...base, scope: "daily", pattern: "(global)" }, new Date("2026-08-23"));
    const k2 = alertStateKey({ ...base, scope: "weekly", pattern: "(global)" }, new Date("2026-08-23"));
    const k3 = alertStateKey({ ...base, scope: "daily", pattern: "codex*" }, new Date("2026-08-23"));
    const k4 = alertStateKey({ ...base, scope: "daily", pattern: "(global)" }, new Date("2026-08-24"));
    expect(new Set([k1, k2, k3, k4]).size).toBe(4);
  });
});

// ---------------------------------------------------------------- import

describe("parseCsv", () => {
  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('a,"b,c","d""e"\nf,2,3');
    expect(rows).toEqual([["a", "b,c", 'd"e'], ["f", "2", "3"]]);
  });
});

describe("mapColumns / importCsv", () => {
  it("detects anthropic console exports", () => {
    const csv = `Timestamp,Transaction ID,Model,Input Tokens,Output Tokens,Cache Read Tokens,Cache Creation Tokens,Cost USD\n2026-08-01T10:00:00Z,tid,claude-sonnet-4-5,100,50,10,5,0.01`;
    const res = importCsv(csv, "test-machine");
    expect(res.source).toBe("anthropic");
    expect(res.events.length).toBe(1);
    const e = res.events[0]!;
    expect(e.model).toBe("claude-sonnet-4-5");
    expect(e.inputTokens).toBe(100);
    expect(e.cacheReadTokens).toBe(10);
    expect(e.costUsd).toBeCloseTo(0.01);
    expect(e.provider).toBe("anthropic-import");
    expect(e.id.startsWith("import:anthropic:")).toBe(true);
  });

  it("re-importing the same row yields identical ids (dedupe)", () => {
    const csv = `Timestamp,Transaction ID,Model,Input Tokens,Output Tokens,Cache Read Tokens,Cache Creation Tokens,Cost USD\n2026-08-01T10:00:00Z,tid,gpt-4o,100,50,0,0,0.02`;
    const a = importCsv(csv, "m").events[0]!.id;
    const b = importCsv(csv, "m").events[0]!.id;
    expect(a).toBe(b);
  });

  it("maps openrouter-style headers", () => {
    const csv = `Timestamp (UTC),Provider,Model,Prompt Tokens,Completion Tokens,Cache Read,Cost (USD)\n2026-08-02T11:00:00Z,openai,gpt-5.6,200,80,120,0.03`;
    const res = importCsv(csv, "m");
    expect(res.source).toBe("openrouter");
    expect(res.events[0]!.outputTokens).toBe(80);
  });

  it("counts unparseable rows as skipped", () => {
    const csv = `Timestamp,Model,Input Tokens,Output Tokens\nnot-a-date,gpt-4o,1,1`;
    const res = importCsv(csv, "m");
    expect(res.events.length).toBe(0);
    expect(res.skipped).toBe(1);
  });
});
