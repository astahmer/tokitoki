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
