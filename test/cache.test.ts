import { describe, expect, it } from "bun:test";
import { appendFileSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventCache } from "../src/cache.ts";
import { readEventsFile } from "../src/store.ts";
import type { UsageEvent } from "../src/types.ts";

function makeEvent(overrides: Partial<UsageEvent> & Pick<UsageEvent, "id">): UsageEvent {
  return {
    ts: "2026-08-23T09:00:00.000Z",
    machineId: "mac-one",
    provider: "pi",
    accountKey: "opencode-go",
    model: "ox-alpha-free",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    costUsd: 0.01,
    projectDir: "/Users/me/dev/proj",
    sessionId: "s1",
    ...overrides,
  };
}

describe("store.readEventsFile", () => {
  it("parses valid lines, skips corrupt and partial trailing lines", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-store-"));
    const file = path.join(dir, "events.jsonl");
    writeFileSync(file, JSON.stringify(makeEvent({ id: "a" })) + "\nbroken{\n" + JSON.stringify(makeEvent({ id: "b" })) + "\n{\"id\":\"partial");
    const events = readEventsFile(file);
    expect(events.map((e) => e.id)).toEqual(["a", "b"]);
  });
});

describe("EventCache", () => {
  it("dedupes on stable id across machines and files", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-cache-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      const sameLogicalEventMac1 = makeEvent({ id: "pi:k:s1:m1", machineId: "mac-one" });
      const sameLogicalEventMac2 = makeEvent({ id: "pi:k:s1:m1", machineId: "mac-two", inputTokens: 100 });
      expect(cache.insert([sameLogicalEventMac1])).toBe(1);
      // Same logical usage synced from another machine counts once
      expect(cache.insert([sameLogicalEventMac2])).toBe(0);
      expect(cache.insert([makeEvent({ id: "pi:k:s1:m2" })])).toBe(1);
      expect(cache.count()).toBe(2);
    } finally {
      cache.close();
    }
  });

  it("aggregates by dimension within a time window", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-cache2-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.insert([
        makeEvent({ id: "1", model: "m-a", inputTokens: 100, outputTokens: 100, costUsd: 0.5 }),
        makeEvent({ id: "2", model: "m-a", inputTokens: 10, outputTokens: 10, costUsd: 0.05 }),
        makeEvent({ id: "3", model: "m-b", inputTokens: 1000, outputTokens: 5, costUsd: 2 }),
        makeEvent({
          id: "old",
          model: "m-a",
          ts: "2020-01-01T00:00:00.000Z",
          inputTokens: 50000,
          outputTokens: 50000,
        }),
      ]);
      const rows = cache.aggregate("2026-08-01T00:00:00.000Z", "model");
      expect(rows).toHaveLength(2);
      // aggregation is order-independent here; sorting happens in report layer
      const byBucket = Object.fromEntries(rows.map((r) => [r.bucket, r]));
      expect(byBucket["m-b"]!.inputTokens).toBe(1000);
      expect(byBucket["m-a"]!.requests).toBe(2);
      expect(byBucket["m-a"]!.inputTokens).toBe(110);
      expect(byBucket["m-a"]!.costUsd).toBeCloseTo(0.55);
    } finally {
      cache.close();
    }
  });

  it("aggregates upstream providers without losing harness attribution", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-cache-provider-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.insert([
        makeEvent({ id: "openai-1", provider: "codex", accountKey: "openai:plus", model: "gpt-5", inputTokens: 100 }),
        makeEvent({ id: "openai-2", provider: "pi", accountKey: "codex-work", model: "gpt-5", inputTokens: 200 }),
        makeEvent({ id: "router-1", provider: "pi", accountKey: "openrouter", model: "anthropic/claude-sonnet-4", inputTokens: 300 }),
      ]);
      const rows = cache.aggregateModelProviders("2026-08-01T00:00:00.000Z");
      const byBucket = Object.fromEntries(rows.map((r) => [r.bucket, r]));
      expect(byBucket.openai?.inputTokens).toBe(300);
      expect(byBucket.openai?.requests).toBe(2);
      expect(byBucket.openrouter?.inputTokens).toBe(300);
      expect(byBucket.openrouter?.requests).toBe(1);
    } finally {
      cache.close();
    }
  });

  it("rebuild is a pure projection of the merged logs", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-cache3-"));
    process.env.TOKITOKI_DATA_DIR = dir;
    const localLog = path.join(dir, "events.jsonl");
    const remoteLog = path.join(dir, "remote.jsonl");
    writeFileSync(localLog, JSON.stringify(makeEvent({ id: "x1" })) + "\n");
    // Remote machine saw the same session (synced) plus its own event
    writeFileSync(
      remoteLog,
      JSON.stringify(makeEvent({ id: "x1", machineId: "mac-two" })) +
        "\n" +
        JSON.stringify(makeEvent({ id: "x2", machineId: "mac-two" })) +
        "\n",
    );
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.rebuild([remoteLog]);
      expect(cache.count()).toBe(2);
      const byMachine = cache.aggregate("2026-01-01T00:00:00.000Z", "machine");
      expect(byMachine).toHaveLength(2); // mac-one has x1, mac-two has x2
      expect(Object.fromEntries(byMachine.map((r) => [r.bucket, r.requests]))).toEqual({
        "mac-one": 1,
        "mac-two": 1,
      });
    } finally {
      cache.close();
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });
});

describe("EventCache.sync (incremental)", () => {
  it("consumes only appended tails and preserves dedupe/richness", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-cache-sync-"));
    process.env.TOKITOKI_DATA_DIR = dir;
    const log = path.join(dir, "events.jsonl");
    writeFileSync(log, JSON.stringify(makeEvent({ id: "a" })) + "\n" + JSON.stringify(makeEvent({ id: "b" })) + "\n");
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.sync([]);
      expect(cache.count()).toBe(2);

      // Append-only growth: sync picks up exactly the tail, no rebuild.
      // 'a2' duplicates an existing id with a tool attribution → upgrade.
      appendFileSync(
        log,
        JSON.stringify(makeEvent({ id: "c", tool: "Bash" })) + "\n" +
        JSON.stringify(makeEvent({ id: "a", tool: "Read" })) + "\n",
      );
      cache.sync([]);
      expect(cache.count()).toBe(3);
      const rows = cache.database.query("SELECT id, tool FROM events ORDER BY id").all() as Array<{ id: string; tool: string | null }>;
      expect(rows.find((r) => r.id === "a")?.tool).toBe("Read");

      // Partial trailing line is not consumed until completed.
      appendFileSync(log, '{"id":"partial');
      cache.sync([]);
      expect(cache.count()).toBe(3);
      appendFileSync(log, '"}\n'); // completes the line: valid JSON, invalid event → skipped but consumed
      // now the line is complete: {"id":"partial"} — invalid event shape, skipped but consumed
      cache.sync([]);
      expect(cache.count()).toBe(3);
    } finally {
      cache.close();
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("full-rebuilds when an extra log shrinks (replaced by sync backend)", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-cache-shrink-"));
    process.env.TOKITOKI_DATA_DIR = dir;
    const localLog = path.join(dir, "events.jsonl");
    const remoteLog = path.join(dir, "remote.jsonl");
    writeFileSync(localLog, JSON.stringify(makeEvent({ id: "l1" })) + "\n");
    writeFileSync(remoteLog, JSON.stringify(makeEvent({ id: "r1" })) + "\n" + JSON.stringify(makeEvent({ id: "r2" })) + "\n");
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.sync([remoteLog]);
      expect(cache.count()).toBe(3);
      // Sync backend rewrote the remote log to a shorter history
      writeFileSync(remoteLog, JSON.stringify(makeEvent({ id: "r9" })) + "\n");
      cache.sync([remoteLog]);
      expect(cache.count()).toBe(2); // l1 + r9
      const ids = (cache.database.query("SELECT id FROM events ORDER BY id").all() as Array<{ id: string }>).map((r) => r.id);
      expect(ids).toEqual(["l1", "r9"]);
    } finally {
      cache.close();
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });
});

describe("daily_rollups", () => {
  function rollupRows(cache: EventCache): Array<{
    day: string; provider: string; account_key: string; model: string;
    machine_id: string; repo: string | null;
    input_tokens: number; output_tokens: number; cost_usd: number; requests: number;
  }> {
    return cache.database.query("SELECT * FROM daily_rollups ORDER BY day, provider, model").all() as never;
  }

  it("insert() maintains rollups transactionally and is idempotent on re-insert", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-rollup-1-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      const e1 = makeEvent({ id: "r1", ts: "2026-08-20T10:00:00.000Z", inputTokens: 100, outputTokens: 50, costUsd: 0.5 });
      const e2 = makeEvent({ id: "r2", ts: "2026-08-21T11:00:00.000Z", model: "m-b", inputTokens: 10, outputTokens: 5, costUsd: 0.05 });
      expect(cache.insert([e1, e2])).toBe(2);

      const rows = rollupRows(cache);
      expect(rows).toHaveLength(2); // different days → two rows
      const day1 = rows.find((r) => r.day === "2026-08-20")!;
      expect(day1.requests).toBe(1);
      expect(day1.input_tokens).toBe(100);
      expect(day1.cost_usd).toBeCloseTo(0.5);
      expect(day1.provider).toBe("pi");
      expect(day1.machine_id).toBe("mac-one");

      // idempotent re-insert: INSERT OR IGNORE must not bump rollups
      expect(cache.insert([e1])).toBe(0);
      expect(rollupRows(cache).find((r) => r.day === "2026-08-20")!.requests).toBe(1);

      // same-day second event folds into the same row
      cache.insert([makeEvent({ id: "r3", ts: "2026-08-20T18:00:00.000Z", inputTokens: 7 })]);
      const day1b = rollupRows(cache).find((r) => r.day === "2026-08-20")!;
      expect(day1b.requests).toBe(2);
      expect(day1b.input_tokens).toBe(107);
    } finally {
      cache.close();
    }
  });

  it("rebuild() recomputes identical rollups from the logs", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-rollup-2-"));
    process.env.TOKITOKI_DATA_DIR = dir;
    const log = path.join(dir, "events.jsonl");
    writeFileSync(
      log,
      JSON.stringify(makeEvent({ id: "a", ts: "2026-08-20T09:00:00.000Z" })) + "\n" +
      JSON.stringify(makeEvent({ id: "b", ts: "2026-08-21T09:00:00.000Z", costUsd: 0.02 })) + "\n",
    );
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.rebuild([]);
      const afterRebuild = JSON.stringify(rollupRows(cache));
      expect(cache.database.query("SELECT COALESCE(SUM(requests),0) AS n FROM daily_rollups").get() as { n: number }).toEqual({ n: 2 });
      // rebuild again — same projection
      cache.rebuild([]);
      expect(JSON.stringify(rollupRows(cache))).toBe(afterRebuild);
    } finally {
      cache.close();
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("sync() tail-appends update rollups incrementally", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-rollup-3-"));
    process.env.TOKITOKI_DATA_DIR = dir;
    const log = path.join(dir, "events.jsonl");
    writeFileSync(log, JSON.stringify(makeEvent({ id: "t1", ts: "2026-08-22T09:00:00.000Z" })) + "\n");
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.sync([]);
      expect(rollupRows(cache)).toHaveLength(1);

      appendFileSync(log, JSON.stringify(makeEvent({ id: "t2", ts: "2026-08-22T10:00:00.000Z", inputTokens: 42 })) + "\n");
      cache.sync([]);
      const row = rollupRows(cache)[0]!;
      // rollups must mirror the events table exactly
      const ev = cache.database
        .query("SELECT SUM(input_tokens) AS s, COUNT(*) AS n FROM events")
        .get() as { s: number; n: number };
      expect(row.input_tokens).toBe(ev.s);
      expect(row.requests).toBe(ev.n);
    } finally {
      cache.close();
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("consistency guard heals a corrupted rollup row on sync()", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-rollup-4-"));
    process.env.TOKITOKI_DATA_DIR = dir;
    const log = path.join(dir, "events.jsonl");
    writeFileSync(log, JSON.stringify(makeEvent({ id: "h1", ts: "2026-08-22T09:00:00.000Z" })) + "\n");
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.sync([]);
      cache.database.exec("UPDATE daily_rollups SET requests = requests + 7, cost_usd = cost_usd + 99");
      cache.sync([]); // no new tails — guard still runs and heals
      const row = rollupRows(cache)[0]!;
      expect(row.requests).toBe(1);
      expect(row.cost_usd).toBeCloseTo(makeEvent({ id: "h1" }).costUsd ?? 0.01);
    } finally {
      cache.close();
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("spendSnapshot reads rollups with old semantics at day granularity", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-rollup-5-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.insert([
        makeEvent({ id: "s1", ts: "2026-08-25T08:00:00.000Z", accountKey: "acct-a", costUsd: 1 }),
        makeEvent({ id: "s2", ts: "2026-08-25T12:00:00.000Z", accountKey: "acct-a", costUsd: 2 }),
        makeEvent({ id: "s3", ts: "2026-08-19T09:00:00.000Z", accountKey: "acct-b", costUsd: 4 }),
      ]);
      // boundaries inside the same UTC days as the fixtures → parity holds
      const snap = cache.spendSnapshot(
        "2026-08-25T00:00:00.000Z",
        "2026-08-23T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      );
      expect(snap.totals.day).toBeCloseTo(3);
      expect(snap.totals.week).toBeCloseTo(3); // week starts the 23rd → both events on the 25th count
      expect(snap.totals.month).toBeCloseTo(7);
      const acctA = snap.accounts.find((a) => a.key === "acct-a")!;
      expect(acctA.month).toBeCloseTo(3);
      const acctB = snap.accounts.find((a) => a.key === "acct-b")!;
      expect(acctB.month).toBeCloseTo(4);
    } finally {
      cache.close();
    }
  });

  it("spendSnapshot's day total uses the exact local-midnight instant, not the whole UTC day it starts in", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-rollup-day-tz-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.insert([
        // Local midnight for a UTC+2 timezone is 2026-08-25T22:00:00Z. This
        // event lands earlier the same UTC calendar day but before that
        // instant, so it is still "yesterday" for that timezone.
        makeEvent({ id: "before-local-midnight", ts: "2026-08-25T10:00:00.000Z", accountKey: "acct-a", costUsd: 5 }),
        // At/after local midnight — genuinely "today".
        makeEvent({ id: "after-local-midnight", ts: "2026-08-25T23:00:00.000Z", accountKey: "acct-a", costUsd: 2 }),
      ]);
      const dayIso = "2026-08-25T22:00:00.000Z"; // local midnight, UTC+2
      const snap = cache.spendSnapshot(dayIso, dayIso, dayIso);
      expect(snap.totals.day).toBeCloseTo(2);
      const acctA = snap.accounts.find((a) => a.key === "acct-a")!;
      expect(acctA.day).toBeCloseTo(2);
    } finally {
      cache.close();
    }
  });

  it("rollupAggregate groups by provider and day buckets", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-rollup-6-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.insert([
        makeEvent({ id: "g1", ts: "2026-08-20T09:00:00.000Z", provider: "pi" }),
        makeEvent({ id: "g2", ts: "2026-08-20T15:00:00.000Z", provider: "codex", model: "m-x" }),
        makeEvent({ id: "g3", ts: "2026-08-21T15:00:00.000Z", provider: "codex", model: "m-x" }),
      ]);
      const byProvider = cache.rollupAggregate("2026-08-01T00:00:00.000Z", undefined, "provider");
      const buckets = Object.fromEntries(byProvider.map((r) => [r.bucket, r]));
      expect(buckets["pi"]!.requests).toBe(1);
      expect(buckets["codex"]!.requests).toBe(2);
      for (const r of byProvider) expect(r.sessions).toBe(0); // not derivable

      const byDay = cache.rollupAggregate("2026-08-20T00:00:00.000Z", "2026-08-20T23:59:59.999Z", "day");
      expect(byDay).toHaveLength(1); // until-day inclusive, only the 20th
      expect(byDay[0]!.bucket).toBe("2026-08-20");
      expect(byDay[0]!.requests).toBe(2);
    } finally {
      cache.close();
    }
  });
});

describe("hybrid rollup reads", () => {
  // Events land inside a single UTC day but at times that make windows cut
  // through the day — exercising both partial edge slices + the interior.
  const T0 = "2026-08-20T10:30:00.000Z";
  const mk = (id: string, ts: string, cost: number) =>
    makeEvent({ id, ts, costUsd: cost, inputTokens: 100, outputTokens: 50 });

  function seed(cache: InstanceType<typeof EventCache>): void {
    cache.insert([
      mk("h1", "2026-08-19T23:59:59.000Z", 1), // day before the window's first full day
      mk("a1", T0, 2),
      mk("a2", "2026-08-21T00:00:01.000Z", 3),
      mk("a3", "2026-08-22T12:00:00.000Z", 4),
      mk("t1", "2026-08-24T07:15:00.000Z", 5), // after the window's last full day
    ]);
  }

  it("hybridUsage matches totals() exactly across partial edges", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-hybrid-"));
    process.env.TOKITOKI_DATA_DIR = dir;
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      seed(cache);
      // Window cutting mid-day on BOTH edges:
      const since = "2026-08-20T10:30:00.000Z";
      const until = "2026-08-24T07:15:00.000Z";
      const expected = cache.totals(since, undefined, until);
      const got = cache.hybridUsage(since, undefined, until);
      expect(got.requests).toBe(expected.requests);
      expect(got.inputTokens).toBe(expected.inputTokens);
      expect(got.outputTokens).toBe(expected.outputTokens);
      expect(got.cacheReadTokens).toBe(expected.cacheReadTokens);
      expect(got.cacheWriteTokens).toBe(expected.cacheWriteTokens);
      expect(got.costUsd).toBeCloseTo(expected.costUsd, 10);
      // open-ended (until = now) agrees with totals() too
      const openExpected = cache.totals(since);
      const openGot = cache.hybridUsage(since);
      expect(openGot.requests).toBe(openExpected.requests);
      expect(openGot.costUsd).toBeCloseTo(openExpected.costUsd, 10);
    } finally {
      cache.close();
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("totals honors an upper bound for calendar-day reports", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-bounded-total-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.insert([
        mk("before", "2026-08-27T08:00:00.000Z", 2),
        mk("after", "2026-08-28T08:00:00.000Z", 3),
      ]);
      const total = cache.totals("2026-08-27T00:00:00.000Z", undefined, "2026-08-28T00:00:00.000Z");
      expect(total.requests).toBe(1);
      expect(total.costUsd).toBe(2);
    } finally {
      cache.close();
    }
  });

  it("hybridAggregate matches aggregate() per bucket for rollup dimensions", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-hybrid-agg-"));
    process.env.TOKITOKI_DATA_DIR = dir;
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      seed(cache);
      const since = "2026-08-20T10:30:00.000Z";
      const until = "2026-08-24T07:15:00.000Z";
      for (const dim of ["account", "provider", "model", "machine"] as const) {
        const eventsRows = cache.aggregate(since, dim, undefined, until);
        const hybridRows = cache.hybridAggregate(since, dim, undefined, until);
        const norm = (rows: typeof eventsRows) =>
          rows
            .map((r) => ({ bucket: r.bucket, requests: r.requests, costUsd: r.costUsd }))
            .sort((a, b) => a.bucket.localeCompare(b.bucket));
        expect(norm(hybridRows)).toEqual(norm(eventsRows));
      }
    } finally {
      cache.close();
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("hybrid model-provider aggregation preserves exact edge attribution", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-hybrid-model-provider-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.insert([
        makeEvent({
          id: "model-provider-edge",
          ts: "2026-08-20T10:30:00.000Z",
          provider: "pi",
          accountKey: "openrouter",
          model: "anthropic/claude-sonnet-4",
          inputTokens: 7,
          outputTokens: 11,
          costUsd: 0.25,
        }),
        makeEvent({
          id: "model-provider-interior",
          ts: "2026-08-21T12:00:00.000Z",
          provider: "codex",
          accountKey: "codex:plus",
          model: "gpt-5",
          inputTokens: 13,
          outputTokens: 17,
          costUsd: 0.5,
        }),
      ]);
      const since = "2026-08-20T10:30:00.000Z";
      const until = "2026-08-22T10:30:00.000Z";
      const normalize = (rows: ReturnType<EventCache["aggregateModelProviders"]>) =>
        rows
          .map((r) => ({
            bucket: r.bucket,
            requests: r.requests,
            inputTokens: r.inputTokens,
            outputTokens: r.outputTokens,
            costUsd: r.costUsd,
          }))
          .sort((a, b) => a.bucket.localeCompare(b.bucket));
      expect(normalize(cache.hybridAggregateModelProviders(since, undefined, until))).toEqual(
        normalize(cache.aggregateModelProviders(since, undefined, until)),
      );
    } finally {
      cache.close();
    }
  });
});
