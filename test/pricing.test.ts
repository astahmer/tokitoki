import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLiteLlmTable, buildModelsDevTable, estimateCost, matchPrice,
  resolveUsageCost, setTableForTests, type ModelPrice, type TokenCounts,
} from "../src/pricing.ts";

const price: ModelPrice = { inputPerMtok: 2, outputPerMtok: 8, cacheReadPerMtok: 0.5, cacheWritePerMtok: 3 };
const tokens: TokenCounts = { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 1e6 };
afterEach(() => setTableForTests(null));

describe("pricing provenance", () => {
  it("rejects legacy caches with fabricated zero rates and preserves explicit zero in the new format", () => {
    const dir = mkdtempSync(join(tmpdir(), "tokitoki-pricing-format-"));
    const program = `import { estimateCost } from ${JSON.stringify(new URL("../src/pricing.ts", import.meta.url).pathname)}; console.log(JSON.stringify({cost:estimateCost("fixture-cache-model", {inputTokens:0,outputTokens:0,cacheReadTokens:1000,cacheWriteTokens:0})}));`;
    const read = () => {
      const result = Bun.spawnSync([process.execPath, "-e", program], { env: { ...process.env, TOKITOKI_DATA_DIR: dir } });
      expect(result.exitCode).toBe(0);
      return JSON.parse(result.stdout.toString());
    };
    try {
      writeFileSync(join(dir, "pricing.last-attempt"), String(Date.now()));
      const modelPrice: ModelPrice = { inputPerMtok: 2, outputPerMtok: 8, cacheReadPerMtok: 0 };
      const cached = { fetchedAt: Date.now(), source: "https://models.dev/api.json", models: { "fixture-cache-model": modelPrice } };
      writeFileSync(join(dir, "pricing.json"), JSON.stringify(cached));
      expect(read()).toEqual({});
      writeFileSync(join(dir, "pricing.json"), JSON.stringify({ ...cached, formatVersion: 2 }));
      expect(read()).toEqual({ cost: 0 });
      delete cached.models["fixture-cache-model"].cacheReadPerMtok;
      writeFileSync(join(dir, "pricing.json"), JSON.stringify({ ...cached, formatVersion: 2 }));
      expect(read()).toEqual({});
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  it("distinguishes reported zero, an explicit free rate and missing pricing", () => {
    setTableForTests({ free: { inputPerMtok: 0, outputPerMtok: 0, cacheReadPerMtok: 0, cacheWritePerMtok: 0 } });
    expect(resolveUsageCost({ model: "unlisted-model", tokens, reportedCost: 0 })).toEqual({ costUsd: 0, costSource: "reported" });
    expect(resolveUsageCost({ model: "free", tokens })).toEqual({ costUsd: 0, costSource: "estimated" });
    expect(estimateCost("unlisted-model", tokens)).toBeUndefined();
    expect(resolveUsageCost({ model: "unlisted-model", tokens })).toEqual({ costSource: "unpriced" });
  });

  it("trusts finite nonnegative reported amounts and otherwise uses real pricing", () => {
    setTableForTests({ priced: price });
    expect(resolveUsageCost({ model: "priced", tokens, reportedCost: 42 })).toEqual({ costUsd: 42, costSource: "reported" });
    for (const reportedCost of [-1, NaN, Infinity, -Infinity, "0", null]) {
      expect(resolveUsageCost({ model: "priced", tokens, reportedCost })).toEqual({ costUsd: 13.5, costSource: "estimated" });
      expect(resolveUsageCost({ model: "unlisted-model", tokens, reportedCost })).toEqual({ costSource: "unpriced" });
    }
  });

  it("rejects malformed token buckets and overflowing amounts", () => {
    setTableForTests({ priced: price, huge: { ...price, outputPerMtok: Number.MAX_VALUE } });
    for (const key of Object.keys(tokens)) {
      for (const value of [-1, NaN, Infinity, -Infinity, "100", undefined, null]) {
        const invalid = { ...tokens, [key]: value } as TokenCounts;
        expect(estimateCost("priced", invalid)).toBeUndefined();
        expect(resolveUsageCost({ model: "priced", tokens: invalid })).toEqual({ costSource: "unpriced" });
      }
    }
    expect(estimateCost("huge", { ...tokens, outputTokens: Number.MAX_VALUE })).toBeUndefined();
  });

  it("prices all disjoint cache buckets once", () => {
    setTableForTests({ priced: price });
    expect(estimateCost("priced", tokens)).toBe(13.5);
  });
});

describe("price matching boundaries", () => {
  const table = { "gpt-5": price, o3: price, "claude-opus": price, "claude-sonnet-4-5": price };
  it("does not invent rates for tiers or numeric generations", () => {
    for (const model of ["gpt-5-mini", "openrouter/gpt-5-mini", "o3-mini", "vendor/o3-mini", "gpt-5.6-sol",
      "gpt-5.6", "gpt-5-1", "claude-opus-4-5", "prefix-gpt-5", "claude-sonnet-4-5-thinking", "gpt-5-2025-13-01"]) {
      expect(matchPrice(table, model)).toBeUndefined();
    }
  });
  it("matches exact variants, canonical aliases and calendar-date snapshots", () => {
    const mini = { ...price, inputPerMtok: 0.1 };
    expect(matchPrice({ ...table, "gpt-5-mini": mini }, "openrouter/gpt-5-mini")).toBe(mini);
    expect(matchPrice(table, "gpt-5-2025-08-07")).toBe(price);
    expect(matchPrice(table, "accounts/project/models/claude-sonnet-4-5-20250929")).toBe(price);
    expect(matchPrice(table, "sonnet-4.5")).toBe(price);
    expect(matchPrice({ "gpt-5.6-sol": mini, ...table }, "gpt-5.6-sol")).toBe(mini);
  });
  it("keeps qualified prices separate from other providers", () => {
    const routed = { ...price, inputPerMtok: 9 };
    expect(matchPrice({ ...table, "vendor/gpt-5": routed }, "vendor/gpt-5")).toBe(routed);
    expect(matchPrice({ "vendor/gpt-5": routed }, "other/gpt-5")).toBeUndefined();
  });
});

it("catalog builders reject invalid rates and preserve explicit zero", () => {
  const models = buildModelsDevTable({ a: { models: {
    free: { cost: { input: 0, output: 0 } }, bad: { cost: { input: -1, output: 2 } },
  } }, b: { models: { free: { cost: { input: 1, output: 2 } } } } });
  expect(models.free?.inputPerMtok).toBe(0);
  expect(models.bad).toBeUndefined();
  const lite = buildLiteLlmTable({ free: { input_cost_per_token: 0, output_cost_per_token: 0 },
    bad: { input_cost_per_token: -1 }, invalid: { output_cost_per_token: Infinity } });
  expect(lite.free?.inputPerMtok).toBe(0);
  expect(lite.bad).toBeUndefined();
  expect(lite.invalid).toBeUndefined();
});

it("keeps missing consumed rate classes unpriced instead of treating them as free", () => {
  for (const table of [
    buildModelsDevTable({ vendor: { models: { partial: { cost: { input: 2, output: 8 } } } } }),
    buildLiteLlmTable({ partial: { input_cost_per_token: 0.000002, output_cost_per_token: 0.000008 } }),
  ]) {
    setTableForTests(table);
    expect(estimateCost("partial", tokens)).toBeUndefined();
    expect(estimateCost("partial", { ...tokens, cacheReadTokens: 0, cacheWriteTokens: 0 })).toBe(10);
  }
});
