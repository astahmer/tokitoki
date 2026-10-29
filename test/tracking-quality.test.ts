import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventCache } from "../src/cache.ts";
import { EXTRACTION_VERSION } from "../src/scan.ts";
import { apiTracking, apiWidgetStatus, trackingPeriods } from "../src/web/api.ts";
import type { UsageEvent } from "../src/types.ts";

const sinceIso = "2026-10-01T00:00:00.000Z";

it("opens the shared cache concurrently without rebuilding quota views on every read", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tokitoki-cache-open-"));
  const dbPath = path.join(dir, "cache.db");
  writeFileSync(path.join(dir, "pricing.last-attempt"), String(Date.now()));
  const program = `import {EventCache} from ${JSON.stringify(new URL("../src/cache.ts", import.meta.url).pathname)};
    for(let i=0;i<3;i++){const c=new EventCache(${JSON.stringify(dbPath)}); c.latestQuotaSnapshots("codex","test"); c.close();}`;
  const children = Array.from({ length: 6 }, () => Bun.spawn([process.execPath, "-e", program], {
    env: { ...process.env, TOKITOKI_DATA_DIR: dir }, stdout: "pipe", stderr: "pipe",
  }));
  try {
    const results = await Promise.all(children.map(async child => ({
      exit: await child.exited, error: await new Response(child.stderr).text(),
    })));
    for (const result of results) {
      expect(result.error).toBe("");
      expect(result.exit).toBe(0);
    }
    const cache = new EventCache(dbPath);
    try { expect(cache.metaValue("quota-retirement-views-v1")).toBe("1"); }
    finally { cache.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function event(id: string, overrides: Partial<UsageEvent> = {}): UsageEvent {
  return { id, ts: "2026-10-20T12:00:00.000Z", machineId: "test", provider: "codex",
    accountKey: "test", model: "test-model", inputTokens: 60, outputTokens: 20,
    cacheReadTokens: 30, cacheWriteTokens: 10, sessionId: "session", ...overrides };
}

function fixture(run: (cache: EventCache, dir: string) => void): void {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tokitoki-tracking-"));
  const oldData = process.env.TOKITOKI_DATA_DIR;
  const oldConfig = process.env.TOKITOKI_CONFIG;
  process.env.TOKITOKI_DATA_DIR = dir;
  process.env.TOKITOKI_CONFIG = path.join(dir, "config.toml");
  writeFileSync(process.env.TOKITOKI_CONFIG, "");
  const cache = new EventCache(path.join(dir, "cache.db"), () => "test-repo");
  try { run(cache, dir); }
  finally {
    cache.close();
    if (oldData === undefined) delete process.env.TOKITOKI_DATA_DIR; else process.env.TOKITOKI_DATA_DIR = oldData;
    if (oldConfig === undefined) delete process.env.TOKITOKI_CONFIG; else process.env.TOKITOKI_CONFIG = oldConfig;
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("tracking quality", () => {
  it("counts normalized tokens and provenance, excluding overlapping T3 activity", () => fixture(cache => {
    cache.insert([
      event("reported-zero", { costUsd: 0, costSource: "reported" }),
      event("estimate", { costUsd: 2, costSource: "estimated" }),
      event("legacy", { costUsd: 3 }),
      event("unpriced-z", { model: "z", costSource: "unpriced" }),
      event("unpriced-a", { model: "a", costSource: "unpriced" }),
      event("unpriced-a2", { model: "a", costSource: "unpriced" }),
      event("overlap", { provider: "t3code", inputTokens: 9000, costUsd: 9000, costSource: "reported" }),
    ]);
    const summary = cache.trackingSummary({ sinceIso });
    // Codex rows without provenance are legacy: their input included cache
    // hits, so ingest derives the uncached part (60 - 30) as an estimate.
    expect(summary).toEqual({ requests: 6, totalTokens: 540, inputTokens: 180, outputTokens: 120,
      cacheReadTokens: 180, cacheWriteTokens: 60, costUsd: 5, reportedRequests: 1,
      estimatedRequests: 1, unpricedRequests: 3, unknownRequests: 1, pricedRequests: 2,
      pricingCoveragePercent: 100 / 3, cachedInputPercent: 180 / 420 * 100, unpricedModels: ["a", "z"],
      reportedTokenRequests: 0, estimatedTokenRequests: 6, unknownTokenRequests: 0,
      reportedTokens: 0, estimatedTokens: 540, unknownTokens: 0 });
    expect(cache.sessionDetail("codex", "session").find(row => row.costSource === "reported")?.costUsd).toBe(0);
  }));

  it("returns null percentages for absent denominators", () => fixture(cache => {
    expect(cache.trackingSummary({ sinceIso })).toMatchObject({ requests: 0, totalTokens: 0,
      costUsd: 0, pricingCoveragePercent: null, cachedInputPercent: null, unpricedModels: [] });
    cache.insert([event("output-only", { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costSource: "unpriced" })]);
    expect(cache.trackingSummary({ sinceIso })).toMatchObject({ totalTokens: 20, pricingCoveragePercent: 0, cachedInputPercent: null });
  }));

  it("uses inclusive lower and exclusive upper timestamp bounds", () => fixture(cache => {
    const untilIso = "2026-10-02T00:00:00.000Z";
    cache.insert([event("before", { ts: "2026-09-30T23:59:59.999Z" }),
      event("start", { ts: sinceIso, costSource: "reported" }),
      event("inside", { ts: "2026-10-01T23:59:59.999Z", costSource: "unpriced" }),
      event("end", { ts: untilIso })]);
    expect(cache.trackingSummary({ sinceIso, untilIso })).toMatchObject({ requests: 2, reportedRequests: 1, unpricedRequests: 1 });
    expect(cache.trackingSummary({ sinceIso: untilIso, untilIso: sinceIso }).requests).toBe(0);
  }));

  it("migrates historical nonzero and zero amounts to unknown without changing dollars", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tokitoki-legacy-tracking-"));
    const dbPath = path.join(dir, "cache.db");
    const old = new Database(dbPath);
    old.exec(`CREATE TABLE events (id TEXT PRIMARY KEY, ts TEXT NOT NULL, machine_id TEXT NOT NULL,
      provider TEXT NOT NULL, account_key TEXT NOT NULL, model TEXT NOT NULL, input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
      project_dir TEXT, session_id TEXT, tool TEXT, description TEXT);
      INSERT INTO events VALUES ('old', '2026-10-20T12:00:00.000Z', 'm', 'codex', 'a', 'model', 1, 2, 0, 0, 7, NULL, NULL, NULL, NULL);
      INSERT INTO events SELECT 'zero', ts, machine_id, provider, account_key, model, input_tokens,
      output_tokens, cache_read_tokens, cache_write_tokens, 0, project_dir, session_id, tool, description FROM events;`);
    old.close();
    const cache = new EventCache(dbPath, () => "test-repo");
    try { expect(cache.trackingSummary({ sinceIso })).toMatchObject({ requests: 2, costUsd: 7, unknownRequests: 2, pricedRequests: 0 }); }
    finally { cache.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("enriches repeated direct scan inserts and preserves rollups for unchanged sums", () => fixture(cache => {
    const legacy = event("scan", { costUsd: 2 });
    cache.insert([legacy]);
    cache.database.exec(`CREATE TRIGGER reject_rollup_delete BEFORE DELETE ON daily_rollups BEGIN SELECT RAISE(ABORT, 'unchanged sums'); END;`);
    expect(cache.insert([{ ...legacy, costSource: "estimated" }])).toBe(0);
    expect(cache.trackingSummary({ sinceIso })).toMatchObject({ requests: 1, estimatedRequests: 1, costUsd: 2 });
    cache.database.exec("DROP TRIGGER reject_rollup_delete");
    cache.insert([{ ...legacy, costSource: "reported", costUsd: 0 }]);
    cache.insert([{ ...legacy, costSource: "estimated", costUsd: 99 }]);
    cache.insert([{ ...legacy, costSource: "unpriced" }]);
    cache.insert([legacy]);
    expect(cache.trackingSummary({ sinceIso })).toMatchObject({ requests: 1, reportedRequests: 1, costUsd: 0 });
    expect(cache.hybridUsage(sinceIso).costUsd).toBe(0);
  }));

  it("upgrades tail replays and preserves reported zero across full legacy replay", () => fixture((cache, dir) => {
    const log = path.join(dir, "events.jsonl");
    const legacy = event("replay", { costUsd: 2 });
    writeFileSync(log, JSON.stringify(legacy) + "\n");
    cache.rebuild([]);
    cache.markExtractionVersion(EXTRACTION_VERSION);
    appendFileSync(log, JSON.stringify({ ...legacy, costSource: "estimated" }) + "\n");
    cache.sync([]);
    expect(cache.trackingSummary({ sinceIso }).estimatedRequests).toBe(1);
    appendFileSync(log, JSON.stringify({ ...legacy, tool: "Read", costSource: "reported", costUsd: 0 }) + "\n");
    cache.sync([]);
    expect(cache.trackingSummary({ sinceIso })).toMatchObject({ reportedRequests: 1, costUsd: 0 });
    // Simulate a replaced legacy log following an authoritative direct rescan.
    writeFileSync(log, JSON.stringify(legacy) + "\n");
    cache.rebuild([]);
    expect(cache.trackingSummary({ sinceIso })).toMatchObject({ requests: 1, reportedRequests: 1, costUsd: 0 });
  }));

  it("normalizes legacy counters once during direct scan enrichment and keeps rollups consistent", () => fixture(cache => {
    const legacy = event("normalized", { inputTokens: 1000, outputTokens: 100,
      cacheReadTokens: 800, cacheWriteTokens: 0, costUsd: 5 });
    const normalized = { ...legacy, inputTokens: 200, costSource: "estimated" as const };
    cache.insert([legacy]);
    // Legacy Codex input included cache hits; ingest derives the uncached part.
    expect(cache.trackingSummary({ sinceIso }).totalTokens).toBe(1100);
    expect(cache.insert([normalized])).toBe(0);
    for (let i = 0; i < 3; i++) {
      cache.insert([legacy, normalized]);
      expect(cache.trackingSummary({ sinceIso })).toMatchObject({ requests: 1,
        inputTokens: 200, outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 0,
        totalTokens: 1100, costUsd: 5, estimatedRequests: 1 });
      expect(cache.hybridUsage(sinceIso)).toMatchObject({ requests: 1, inputTokens: 200,
        outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 0, costUsd: 5 });
    }
    // A pricing-only authority upgrade cannot bring legacy counters back.
    cache.insert([{ ...legacy, costSource: "reported", costUsd: 0 }]);
    cache.insert([{ ...legacy, costSource: "estimated", costUsd: 99 }, legacy]);
    expect(cache.trackingSummary({ sinceIso })).toMatchObject({ totalTokens: 1100, reportedRequests: 1, costUsd: 0 });
  }));

  it("normalizes legacy counters on tail replay and preserves them when only an old log remains", () => fixture((cache, dir) => {
    const log = path.join(dir, "events.jsonl");
    const legacy = event("normalized-tail", { inputTokens: 1000, outputTokens: 100,
      cacheReadTokens: 800, cacheWriteTokens: 0, costUsd: 7, tool: "Read" });
    const normalized = { ...legacy, tool: undefined, inputTokens: 200, costSource: "reported" as const, costUsd: 0 };
    writeFileSync(log, JSON.stringify(legacy) + "\n");
    cache.rebuild([]);
    cache.markExtractionVersion(EXTRACTION_VERSION);
    appendFileSync(log, JSON.stringify(normalized) + "\n");
    cache.sync([]);
    appendFileSync(log, JSON.stringify(legacy) + "\n");
    cache.sync([]);
    expect(cache.trackingSummary({ sinceIso })).toMatchObject({ requests: 1, totalTokens: 1100,
      inputTokens: 200, cacheReadTokens: 800, reportedRequests: 1, costUsd: 0 });
    writeFileSync(log, JSON.stringify(legacy) + "\n");
    for (let i = 0; i < 2; i++) {
      cache.rebuild([]);
      expect(cache.trackingSummary({ sinceIso })).toMatchObject({ requests: 1, totalTokens: 1100,
        inputTokens: 200, cacheReadTokens: 800, reportedRequests: 1, costUsd: 0 });
      expect(cache.hybridUsage(sinceIso)).toMatchObject({ inputTokens: 200, cacheReadTokens: 800, costUsd: 0 });
    }
  }));

  it("chooses normalized log counters independently of tool richness and source order", () => fixture((cache, dir) => {
    const log = path.join(dir, "events.jsonl");
    const legacy = event("legacy-first", { inputTokens: 1000, outputTokens: 100,
      cacheReadTokens: 800, cacheWriteTokens: 0, costUsd: 7, tool: "Read" });
    const normalized = { ...legacy, tool: undefined, inputTokens: 200, costSource: "reported" as const, costUsd: 0 };
    writeFileSync(log, [legacy, normalized,
      { ...normalized, id: "normalized-first" }, { ...legacy, id: "normalized-first" },
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    for (let i = 0; i < 2; i++) {
      cache.rebuild([]);
      expect(cache.trackingSummary({ sinceIso })).toMatchObject({ requests: 2, totalTokens: 2200,
        inputTokens: 400, outputTokens: 200, cacheReadTokens: 1600, costUsd: 0, reportedRequests: 2 });
      expect(cache.sessionDetail("codex", "session").every(row =>
        row.tool === "Read" && row.inputTokens === 200 && row.costSource === "reported")).toBe(true);
    }
  }));

  it("combines tool richness independently from pricing authority when rebuilding logs", () => fixture((cache, dir) => {
    const log = path.join(dir, "events.jsonl");
    writeFileSync(log, [event("mixed", { costUsd: 0, costSource: "reported" }),
      event("mixed", { tool: "Read", costUsd: 10, costSource: "estimated" })].map(e => JSON.stringify(e)).join("\n") + "\n");
    cache.rebuild([]);
    expect(cache.sessionDetail("codex", "session")[0]).toMatchObject({ tool: "Read", costUsd: 0, costSource: "reported" });
  }));

  it("provides rolling day separately from isolated local today and yesterday", () => fixture(cache => {
    const now = new Date(2026, 9, 20, 12);
    const today = new Date(2026, 9, 20);
    const yesterday = new Date(2026, 9, 19);
    cache.insert([event("today", { ts: today.toISOString() }),
      event("yesterday-start", { ts: yesterday.toISOString() }),
      event("yesterday-evening", { ts: new Date(2026, 9, 19, 20).toISOString() })]);
    const periods = trackingPeriods(cache, now);
    expect(Object.keys(periods).sort()).toEqual(["day", "month", "today", "week", "year", "yesterday"]);
    expect(periods.today.requests).toBe(1);
    expect(periods.yesterday.requests).toBe(2);
    expect(periods.day.requests).toBe(2);
    expect(periods.week.requests).toBe(3);
  }));

  it("exposes a flat tracking API response using existing range parameters", () => fixture((_cache, dir) => {
    writeFileSync(path.join(dir, "events.jsonl"), JSON.stringify(event("api", { costSource: "estimated", costUsd: 2 })) + "\n");
    const response = apiTracking({ from: "2026-10-20T00:00:00.000Z", to: "2026-10-21T00:00:00.000Z" });
    expect(response).toMatchObject({ requests: 1, estimatedRequests: 1, costUsd: 2,
      window: { since: "2026-10-20T00:00:00.000Z", until: "2026-10-21T00:00:00.000Z" } });
    expect(() => apiTracking({ last: "typo" })).toThrow("invalid --last");
    expect(() => apiTracking({ from: "bad-date" })).toThrow("invalid --from");
    expect(() => apiTracking({ last: "day", from: sinceIso })).toThrow("cannot be combined");
  }));

  it("includes the same summaries on the HTTP status projection", () => fixture((_cache, dir) => {
    writeFileSync(path.join(dir, "events.jsonl"), [
      event("status", { costSource: "reported", costUsd: 0 }),
      event("overlap", { provider: "t3code", costSource: "reported", costUsd: 99 }),
    ].map(row => JSON.stringify(row)).join("\n") + "\n");
    const status = apiWidgetStatus({ from: sinceIso, to: "2026-11-01T00:00:00.000Z" });
    expect(status.tracking).toMatchObject({ requests: 1, reportedRequests: 1, costUsd: 0, pricingCoveragePercent: 100 });
    expect(Object.keys(status.trackingPeriods).sort()).toEqual(["day", "month", "today", "week", "year", "yesterday"]);
  }));
});
