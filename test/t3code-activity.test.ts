import { expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventCache } from "../src/cache.ts";
import type { UsageEvent } from "../src/types.ts";

it("keeps all T3 activity out of spending, charts and rollups while retaining its sessions", () => {
  const directory = mkdtempSync(join(tmpdir(), "tokitoki-t3-activity-"));
  const cache = new EventCache(join(directory, "cache.db"));
  const sinceIso = "2026-10-01T12:00:00.000Z";
  const untilIso = "2026-10-05T12:00:00.000Z";
  const base: UsageEvent = {
    id: "native", ts: "2026-10-02T12:00:00.000Z", machineId: "test",
    provider: "codex", accountKey: "default", model: "gpt-5", sessionId: "native-session",
    inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5, costUsd: 2,
  };
  try {
    cache.insert([
      base,
      ...["codex", "claudeAgent", "cursor"].map((accountKey, index) => ({
        ...base, id: `t3-${index}`, provider: "t3code", accountKey,
        sessionId: "t3-session", model: `model-${index}`, costUsd: 10,
      })),
      { ...base, id: "t3-before", provider: "t3code", ts: "2026-09-30T12:00:00.000Z", costUsd: 100 },
      { ...base, id: "t3-after", provider: "t3code", ts: untilIso, costUsd: 200 },
    ]);
    expect(cache.count()).toBe(6);
    expect(cache.totals(sinceIso, undefined, untilIso)).toMatchObject({ costUsd: 2, requests: 1, sessions: 1 });
    expect(cache.aggregate(sinceIso, "provider", undefined, untilIso).map(row => row.bucket)).toEqual(["codex"]);
    expect(cache.aggregateModelProviders(sinceIso, undefined, untilIso).reduce((sum, row) => sum + row.costUsd, 0)).toBe(2);
    expect(cache.hybridUsage(sinceIso, undefined, untilIso).costUsd).toBe(2);
    expect(cache.hybridAggregate(sinceIso, "provider", undefined, untilIso).map(row => row.bucket)).toEqual(["codex"]);
    expect(cache.hybridAggregateModelProviders(sinceIso, undefined, untilIso).reduce((sum, row) => sum + row.costUsd, 0)).toBe(2);
    expect(cache.dailyTotals(sinceIso, untilIso).reduce((sum, row) => sum + row.costUsd, 0)).toBe(2);
    expect(cache.blockWindows(sinceIso, untilIso).reduce((sum, row) => sum + row.costUsd, 0)).toBe(2);
    expect(cache.seriesDaily(sinceIso, "provider", 5, "cost").map(row => row.bucket)).toEqual(["codex"]);
    expect(cache.spendSnapshot(sinceIso, sinceIso, sinceIso).totals).toEqual({ day: 2, week: 2, month: 2 });
    expect(cache.windowUsageForAccount("t3code", "codex", sinceIso).cost).toBe(0);
    const activity = cache.t3codeActivity({ sinceIso, untilIso });
    expect(activity.total).toMatchObject({ costUsd: 30, requests: 3, sessions: 1, inputTokens: 300 });
    expect(activity.rows.map(row => row.bucket).sort()).toEqual(["model-0", "model-1", "model-2"]);
    expect(cache.topSessions({ sinceIso, untilIso, providers: ["t3code"] })).toHaveLength(1);
    expect(cache.sessionDetail("t3code", "t3-session")).toHaveLength(3);
    expect(cache.t3codeActivity({ sinceIso: "2027-01-01T00:00:00.000Z" }).total).toMatchObject({ costUsd: 0, requests: 0 });
  } finally {
    cache.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

it("upgrades existing T3 rollups on cached-only reads without removing the raw activity", () => {
  const directory = mkdtempSync(join(tmpdir(), "tokitoki-t3-upgrade-"));
  const file = join(directory, "cache.db");
  const old = new EventCache(file);
  old.insert([{
    id: "historical-t3", ts: "2026-10-02T12:00:00.000Z", machineId: "test",
    provider: "t3code", accountKey: "codex", model: "gpt-5", sessionId: "old-session",
    inputTokens: 100, outputTokens: 20, costUsd: 5,
  }]);
  old.database.exec(`INSERT INTO daily_rollups
    SELECT substr(ts, 1, 10), provider, account_key, model, machine_id, NULL,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, 1 FROM events`);
  old.close();
  const upgraded = new EventCache(file);
  try {
    expect(upgraded.hybridUsage("2026-10-01T00:00:00.000Z").costUsd).toBe(0);
    expect(upgraded.count()).toBe(1);
    expect(upgraded.t3codeActivity({ sinceIso: "2026-10-01T00:00:00.000Z" }).total.costUsd).toBe(5);
  } finally {
    upgraded.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
