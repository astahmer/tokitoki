import { expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventCache } from "../src/cache.ts";
import { EXTRACTION_VERSION } from "../src/scan.ts";
import { cursorDashboardUsageEvents } from "../src/providers/cursor-dashboard.ts";
import { t3CodeProvider } from "../src/providers/t3code.ts";
import type { UsageEvent } from "../src/types.ts";

const sinceIso = "2026-10-01T00:00:00.000Z";
const untilIso = "2026-11-01T00:00:00.000Z";
const event = (id: string, extra: Partial<UsageEvent> = {}): UsageEvent => ({
  id, provider: "codex", accountKey: "default", model: "unknown", machineId: "test",
  ts: "2026-10-20T12:00:00.000Z", sessionId: "session",
  inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, ...extra,
});
function fixture(run: (cache: EventCache, directory: string) => void): void {
  const directory = mkdtempSync(join(tmpdir(), "tk-token-provenance-"));
  const cache = new EventCache(join(directory, "cache.db"), () => "repo");
  try { run(cache, directory); }
  finally { cache.close(); rmSync(directory, { recursive: true, force: true }); }
}

it("summarizes token provenance independently of known pricing using four disjoint buckets", () => fixture(cache => {
  cache.insert([
    event("reported", { tokenSource: "reported", costSource: "estimated" }),
    event("estimated", { tokenSource: "estimated", costSource: "reported" }),
    event("legacy", { costSource: "reported" }),
    event("zero", { tokenSource: "reported", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    event("outside", { tokenSource: "estimated", ts: untilIso }),
  ]);
  expect(cache.trackingSummary({ sinceIso, untilIso })).toMatchObject({
    requests: 4, totalTokens: 300, reportedTokenRequests: 2, estimatedTokenRequests: 1,
    unknownTokenRequests: 1, reportedTokens: 100, estimatedTokens: 100, unknownTokens: 100,
    reportedRequests: 2, estimatedRequests: 1,
  });
  expect(cache.sessionDetail("codex", "session").find(row => row.tokenSource === "estimated")).toBeDefined();
}));

it("enriches token provenance without a pricing upgrade and preserves normalized counters and rollups", () => fixture(cache => {
  const legacy = event("same", { inputTokens: 1000, costSource: "reported", costUsd: 7 });
  const normalized = { ...legacy, inputTokens: 100, tokenSource: "reported" as const, costSource: "estimated" as const, costUsd: 99 };
  cache.insert([legacy]);
  cache.insert([normalized, legacy]);
  expect(cache.trackingSummary({ sinceIso })).toMatchObject({ reportedTokenRequests: 1, reportedTokens: 190, costUsd: 7, reportedRequests: 1 });
  expect(cache.hybridUsage(sinceIso, undefined, untilIso)).toMatchObject({ requests: 1, inputTokens: 100, costUsd: 7 });
  cache.database.exec(`CREATE TRIGGER reject_rollup_delete BEFORE DELETE ON daily_rollups BEGIN SELECT RAISE(ABORT, 'unchanged sums'); END;`);
  cache.insert([normalized]);
  expect(cache.trackingSummary({ sinceIso }).reportedTokens).toBe(190);
}));

it("keeps provenance-only replay enrichment from rebuilding rollups", () => fixture(cache => {
  cache.insert([event("same", { costSource: "reported" })]);
  cache.database.exec(`CREATE TRIGGER reject_rollup_delete BEFORE DELETE ON daily_rollups BEGIN SELECT RAISE(ABORT, 'unchanged sums'); END;`);
  cache.insert([event("same", { costSource: "estimated", tokenSource: "reported" })]);
  expect(cache.trackingSummary({ sinceIso })).toMatchObject({ reportedTokens: 100, reportedRequests: 1 });
}));

it("preserves independent provenance through tail replay and full legacy replay", () => fixture((cache, directory) => {
  const old = process.env.TOKITOKI_DATA_DIR;
  process.env.TOKITOKI_DATA_DIR = directory;
  try {
    const file = join(directory, "events.jsonl");
    const legacy = event("replay", { inputTokens: 1000, costSource: "reported", costUsd: 7, tool: "Read" });
    const normalized = { ...legacy, inputTokens: 100, tokenSource: "reported", costSource: "estimated", costUsd: 99, tool: undefined };
    writeFileSync(file, JSON.stringify(legacy) + "\n");
    cache.rebuild([]); cache.markExtractionVersion(EXTRACTION_VERSION);
    appendFileSync(file, JSON.stringify(normalized) + "\n");
    cache.sync([]);
    expect(cache.trackingSummary({ sinceIso })).toMatchObject({ reportedTokens: 190, costUsd: 7 });
    writeFileSync(file, JSON.stringify(legacy) + "\n");
    cache.rebuild([]);
    expect(cache.trackingSummary({ sinceIso })).toMatchObject({ reportedTokens: 190, costUsd: 7 });
    // Richness/source order cannot undo normalized tokens.
    writeFileSync(file, [legacy, normalized, { ...normalized, id: "second" }, { ...legacy, id: "second" }].map(row => JSON.stringify(row)).join("\n") + "\n");
    cache.rebuild([]);
    expect(cache.trackingSummary({ sinceIso })).toMatchObject({ requests: 2, reportedTokens: 380, costUsd: 14 });
  } finally { if (old === undefined) delete process.env.TOKITOKI_DATA_DIR; else process.env.TOKITOKI_DATA_DIR = old; }
}));

it("excludes Cursor bubble estimates, including legacy IDs, across account totals while keeping sessions", () => fixture(cache => {
  cache.insert([
    event("cursor:default:s:bubbleId:s:b", { provider: "cursor", projectDir: "/repo" }),
    event("cursor:estimated", { provider: "cursor", tokenSource: "estimated", projectDir: "/repo" }),
    event("dashboard", { provider: "cursor", tokenSource: "reported", costUsd: 2, projectDir: "/repo" }),
  ]);
  expect(cache.trackingSummary({ sinceIso, untilIso })).toMatchObject({ requests: 1, totalTokens: 100, reportedTokens: 100, costUsd: 2 });
  expect(cache.hybridUsage(sinceIso, undefined, untilIso)).toMatchObject({ requests: 1, inputTokens: 10, costUsd: 2 });
  expect(cache.aggregate(sinceIso, "repo")).toMatchObject([{ requests: 1 }]);
  expect(cache.hybridAggregate(sinceIso, "repo", undefined, untilIso)).toMatchObject([{ requests: 1 }]);
  expect(cache.sessionDetail("cursor", "session")).toHaveLength(3);
}));

it("exposes the six provenance fields on T3 activity totals and model rows", () => fixture(cache => {
  cache.insert([event("r", { provider: "t3code", tokenSource: "reported" }),
    event("e", { provider: "t3code", tokenSource: "estimated" }), event("u", { provider: "t3code" })]);
  const activity = cache.t3codeActivity({ sinceIso, untilIso });
  const quality = { reportedTokenRequests: 1, estimatedTokenRequests: 1, unknownTokenRequests: 1,
    reportedTokens: 100, estimatedTokens: 100, unknownTokens: 100 };
  expect(activity.total).toMatchObject(quality);
  expect(activity.rows[0]).toMatchObject(quality);
  expect(cache.trackingSummary({ sinceIso }).requests).toBe(0);
}));

it("reports decimal-cent Cursor dashboard usage without truncating money", () => {
  const rows = cursorDashboardUsageEvents({ machineId: "test", body: { usageEventsDisplay: [{
    model: "unknown", timestamp: 1792497600000,
    tokenUsage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, totalCents: 1.25 },
  }] } });
  expect(rows[0]).toMatchObject({ tokenSource: "reported", costSource: "reported", costUsd: 0.0125 });
  const legacy = cursorDashboardUsageEvents({ machineId: "test", body: { usageEventsDisplay: [{
    model: "unknown", timestamp: 1792497600000,
    tokenUsage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30, cacheWriteTokens: 40, totalCents: 1 },
  }] } });
  expect(rows[0]?.id).toBe(legacy[0]?.id);
});

it("normalizes real T3 turns, accepts measured partials and zero, and revisits running or unavailable rows", () => {
  const directory = mkdtempSync(join(tmpdir(), "tk-t3-tokens-"));
  const file = join(directory, "statev2.sqlite");
  const db = new Database(file);
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, provider_instance_id TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_messages (message_id TEXT PRIMARY KEY);
    CREATE TABLE orchestration_v2_projection_provider_turns (provider_turn_id TEXT PRIMARY KEY, thread_id TEXT, completed_at TEXT, started_at TEXT, payload_json TEXT);`);
  db.query("INSERT INTO orchestration_v2_projection_threads VALUES (?, ?, ?)").run("thread", "codex", JSON.stringify({ modelSelection: { instanceId: "codex", model: "unknown" } }));
  const usage = { usageScope: "main_agent", hasSubagents: false, usageStatus: "complete", inputTokens: 1000, outputTokens: 100,
    cachedInputTokens: 200, cacheCreationTokens: 50, reasoningTokens: 40 };
  const insert = (id: string, payload: unknown) => db.query("INSERT INTO orchestration_v2_projection_provider_turns VALUES (?, 'thread', ?, ?, ?)").run(id, "2026-10-20T12:00:00.000Z", sinceIso, JSON.stringify(payload));
  insert("running", { status: "running" });
  insert("unavailable", { status: "completed", turnTokenUsage: { ...usage, usageStatus: "unavailable" } });
  insert("complete", { status: "completed", turnTokenUsage: usage });
  insert("partial", { status: "failed", turnTokenUsage: { ...usage, usageStatus: "partial" } });
  insert("missing", { status: "completed", turnTokenUsage: { ...usage, inputTokens: undefined } });
  insert("bad-cache", { status: "completed", turnTokenUsage: { ...usage, cachedInputTokens: 1001 } });
  insert("approximate", { status: "completed", turnTokenUsage: { ...usage, usageStatus: "estimated" } });
  insert("zero", { status: "completed", turnTokenUsage: { ...usage, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationTokens: 0, reasoningTokens: 0 } });
  insert("cache-unknown", { status: "completed", turnTokenUsage: { ...usage, cachedInputTokens: undefined, cacheCreationTokens: undefined } });
  const context = { state: {} as Record<string, unknown>, machineId: "test", freshFile: true };
  try {
    const rows = t3CodeProvider.scanDb!(file, context);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ inputTokens: 750, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50, tokenSource: "reported" });
    expect(rows[1]?.tokenSource).toBe("reported");
    expect(rows[2]).toMatchObject({ inputTokens: 0, outputTokens: 0, tokenSource: "reported" });
    expect(rows[3]).toMatchObject({ inputTokens: 1000, outputTokens: 100, tokenSource: "reported", costSource: "unpriced" });
    expect(rows[3]?.cacheReadTokens).toBeUndefined();
    expect(t3CodeProvider.scanDb!(file, context)).toEqual([]);
    db.query("UPDATE orchestration_v2_projection_provider_turns SET payload_json = ? WHERE provider_turn_id IN ('running', 'unavailable', 'missing')")
      .run(JSON.stringify({ status: "completed", turnTokenUsage: usage }));
    const completed = t3CodeProvider.scanDb!(file, context);
    expect(completed).toHaveLength(3);
    expect(completed.every(row => row.inputTokens === 750 && row.tokenSource === "reported")).toBe(true);
    expect(t3CodeProvider.scanDb!(file, context)).toEqual([]);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("does not turn an absent Cursor measurement into synthetic zero usage", () => {
  const events = cursorDashboardUsageEvents({ machineId: "test", body: { usageEventsDisplay: [
    { model: "unknown", timestamp: 1792497600000, tokenUsage: {} },
    { model: "unknown", timestamp: 1792497600000, tokenUsage: { inputTokens: 1 } },
    { model: "unknown", timestamp: 1792497600000, tokenUsage: { inputTokens: 0, outputTokens: 0 } },
  ] } });
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ inputTokens: 0, outputTokens: 0, tokenSource: "reported" });
});

it("migrates legacy measured-cost rows to unknown tokens and removes historical Cursor bubble rollups", () => {
  const directory = mkdtempSync(join(tmpdir(), "tk-token-migration-"));
  const file = join(directory, "cache.db");
  const old = new EventCache(file, () => "repo");
  old.insert([event("native", { costSource: "reported", projectDir: "/repo" }),
    event("cursor:default:s:bubbleId:s:old", { provider: "cursor", projectDir: "/repo" })]);
  old.database.exec(`ALTER TABLE events DROP COLUMN token_source;
    DELETE FROM meta WHERE key = 'cursor-local-activity-v1';
    INSERT INTO daily_rollups SELECT substr(ts, 1, 10), provider, account_key, model, machine_id, 'repo',
      input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, 1 FROM events WHERE provider = 'cursor';`);
  old.close();
  const migrated = new EventCache(file, () => "repo");
  try {
    expect(migrated.trackingSummary({ sinceIso })).toMatchObject({ requests: 1, unknownTokenRequests: 1, unknownTokens: 100, reportedRequests: 1 });
    expect(migrated.hybridUsage(sinceIso, undefined, untilIso).requests).toBe(1);
    expect(migrated.sessionDetail("cursor", "session")).toHaveLength(1);
  } finally { migrated.close(); rmSync(directory, { recursive: true, force: true }); }
});

it("derives uncached input for legacy Codex rows once, across rebuilds, and lets a rescan replace it", () => fixture((cache, directory) => {
  const old = process.env.TOKITOKI_DATA_DIR;
  process.env.TOKITOKI_DATA_DIR = directory;
  try {
    const legacy = event("legacy-codex", { model: "gpt-5", inputTokens: 1000, cacheReadTokens: 800, cacheWriteTokens: 0, costUsd: 50 });
    writeFileSync(join(directory, "events.jsonl"), JSON.stringify(legacy) + "\n");
    for (let i = 0; i < 2; i++) {
      cache.rebuild([]);
      const summary = cache.trackingSummary({ sinceIso });
      expect(summary).toMatchObject({ inputTokens: 200, cacheReadTokens: 800, estimatedTokenRequests: 1, estimatedRequests: 1 });
      expect(summary.costUsd).toBeLessThan(1);
    }
    cache.insert([{ ...legacy, inputTokens: 150, tokenSource: "reported" }]);
    expect(cache.trackingSummary({ sinceIso })).toMatchObject({ inputTokens: 150, reportedTokenRequests: 1 });
  } finally { if (old === undefined) delete process.env.TOKITOKI_DATA_DIR; else process.env.TOKITOKI_DATA_DIR = old; }
}));

it("counts a Claude Code message copied into a resumed session once", () => fixture(cache => {
  const message = (session: string): UsageEvent => event(`claude-code:default:${session}:msg_01ABC`, {
    provider: "claude-code", sessionId: session, tokenSource: "reported", costSource: "estimated", costUsd: 1,
  });
  cache.insert([message("original")]);
  cache.insert([message("resumed"), message("original")]);
  expect(cache.trackingSummary({ sinceIso })).toMatchObject({ requests: 1, costUsd: 1 });
}));

it("leaves Codex requests billed through Cursor to the Cursor dashboard", () => fixture(cache => {
  cache.insert([
    event("routed", { model: "cursor/grok-4.6", tokenSource: "reported", costSource: "estimated", costUsd: 4 }),
    event("direct", { model: "gpt-5", tokenSource: "reported", costSource: "estimated", costUsd: 1 }),
  ]);
  expect(cache.trackingSummary({ sinceIso })).toMatchObject({ requests: 1, costUsd: 1 });
  expect(cache.hybridUsage(sinceIso, undefined, untilIso)).toMatchObject({ requests: 1, costUsd: 1 });
}));
