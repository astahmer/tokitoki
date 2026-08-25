import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { partitionBlocks, renderBlocks, describeBlock, BLOCK_MS } from "../src/blocks.ts";
import { EventCache } from "../src/cache.ts";
import type { UsageEvent } from "../src/types.ts";

function ev(overrides: Partial<UsageEvent> & Pick<UsageEvent, "id" | "ts">): UsageEvent {
  return {
    machineId: "mac",
    provider: "claude-code",
    accountKey: "default",
    model: "m",
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 0,
    costUsd: 0.1,
    sessionId: "s",
    ...overrides,
  };
}

const T0 = Date.parse("2026-08-25T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

describe("partitionBlocks", () => {
  it("keeps events within 5h in one block, opens a new block after the gap", () => {
    const rows = partitionBlocks([
      { ts: T0, accountKey: "a", inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, costUsd: 0.5 },
      // +4h59m — still inside
      { ts: T0 + BLOCK_MS - 60_000, accountKey: "a", inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, costUsd: 0.25 },
      // +6h — outside → new block
      { ts: T0 + 6 * 3_600_000, accountKey: "a", inputTokens: 4, outputTokens: 0, cacheReadTokens: 0, costUsd: 1 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.startIso).toBe(iso(T0));
    expect(rows[0]!.endIso).toBe(iso(T0 + BLOCK_MS));
    expect(rows[0]!.tokens).toBe(3);
    expect(rows[0]!.costUsd).toBeCloseTo(0.75);
    expect(rows[0]!.requests).toBe(2);
    expect(rows[1]!.startIso).toBe(iso(T0 + 6 * 3_600_000));
    expect(rows[1]!.costUsd).toBeCloseTo(1);
  });

  it("partitions per account — same window never merges across accounts", () => {
    const rows = partitionBlocks([
      { ts: T0, accountKey: "a", inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
      { ts: T0 + 1000, accountKey: "b", inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.accountKey).sort()).toEqual(["a", "b"]);
  });

  it("marks a still-open block active relative to injected now", () => {
    const rows = partitionBlocks(
      [{ ts: T0, accountKey: "a", inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }],
      T0 + 60_000, // now = 1 minute into the block
    );
    expect(rows[0]!.isActive).toBe(true);
    const later = partitionBlocks(
      [{ ts: T0, accountKey: "a", inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, costUsd: 0 }],
      T0 + BLOCK_MS + 1000,
    );
    expect(later[0]!.isActive).toBe(false);
  });
});

function setupCache(events: UsageEvent[]): { cache: EventCache; dir: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tk-blocks-"));
  process.env.TOKITOKI_DATA_DIR = dir;
  writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const cache = new EventCache(path.join(dir, "cache.db"));
  cache.rebuild([]);
  return { cache, dir };
}

describe("EventCache.blockWindows", () => {
  it("queries event-level windows and respects account filter", () => {
    const base = { id: "x", model: "m", sessionId: "s" };
    const { cache } = setupCache([
      ev({ ...base, id: "1", ts: iso(T0), accountKey: "alpha" }),
      ev({ ...base, id: "2", ts: iso(T0 + BLOCK_MS - 1000), accountKey: "alpha" }),
      ev({ ...base, id: "3", ts: iso(T0 + 2000), accountKey: "beta" }),
    ]);
    try {
      const all = cache.blockWindows(iso(T0 - 1000), undefined, undefined, { now: T0 + 5000 });
      expect(all).toHaveLength(2);
      expect(all.find((r) => r.accountKey === "beta")?.requests).toBe(1);

      const alpha = cache.blockWindows(iso(T0 - 1000), undefined, "alpha", { now: T0 + 5000 });
      expect(alpha).toHaveLength(1);
      expect(alpha[0]!.requests).toBe(2);
    } finally {
      cache.close();
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });
});

describe("renderBlocks / describeBlock", () => {
  it("renders table and an ACTIVE gauge line with countdown", () => {
    const rows = partitionBlocks(
      [
        { ts: T0, accountKey: "a", inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, costUsd: 0.4 },
        { ts: T0 + 3_600_000 * 6, accountKey: "a", inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, costUsd: 0.05 },
      ],
      T0 + 3_600_000 * 6,
    );
    const out = renderBlocks(rows, T0 + 3_600_000 * 6);
    expect(out).toContain("ACTIVE");
    expect(out).toContain("m left");
    // closed block shows its cost
    expect(out).toContain("$0.40");

    const line = describeBlock(rows.find((r) => r.isActive)!, T0 + 3_600_000 * 7);
    // one hour into the second block → 4h = 240m remain
    expect(line).toContain("240m left");
  });

  it("empty input renders the no-data hint", () => {
    expect(renderBlocks([])).toContain("no billing blocks");
  });
});
