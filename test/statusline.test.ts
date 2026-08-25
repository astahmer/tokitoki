import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventCache } from "../src/cache.ts";
import { parseStatuslineStdin, renderStatusline } from "../src/statusline.ts";
import type { UsageEvent } from "../src/types.ts";

const T0 = Date.parse("2026-08-25T10:00:00Z");
const iso = (ms: number) => new Date(ms).toISOString();

function ev(overrides: Partial<UsageEvent>): UsageEvent {
  return {
    id: "x",
    ts: iso(T0),
    machineId: "mac",
    provider: "claude-code",
    accountKey: "default",
    model: "Sonnet",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.1,
    sessionId: "sess-1",
    ...overrides,
  };
}

function setup(events: UsageEvent[]): EventCache {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tk-statusline-"));
  process.env.TOKITOKI_DATA_DIR = dir;
  writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const cache = new EventCache(path.join(dir, "cache.db"));
  cache.rebuild([]);
  return cache;
}

describe("parseStatuslineStdin", () => {
  it("parses the hook shape and degrades on garbage", () => {
    expect(parseStatuslineStdin('{"session_id":"s1","model":{"display_name":"Opus"}}')).toEqual({
      sessionId: "s1",
      modelName: "Opus",
    });
    expect(parseStatuslineStdin("not json")).toEqual({});
    expect(parseStatuslineStdin("{}")).toEqual({});
  });
});

describe("renderStatusline", () => {
  it("renders model + session/today/MTD spend + active block countdown", async () => {
    const now = T0 + 60 * 60 * 1000; // 1h into the block
    const cache = setup([
      ev({ id: "1", ts: iso(T0), costUsd: 0.3 }),
      ev({ id: "2", ts: iso(T0 + 1000), costUsd: 0.2 }),
      // yesterday — counts toward MTD only if same month; Aug 24 is
      ev({ id: "3", ts: iso(T0 - 24 * 3600_000), costUsd: 2, sessionId: "other" }),
    ]);
    try {
      const line = await renderStatusline(
        parseStatuslineStdin('{"session_id":"sess-1","model":{"display_name":"Opus"}}'),
        cache,
        now,
      );
      expect(line).toContain("Opus");
      expect(line).toContain("$0.50 sess");
      expect(line).toContain("today");
      expect(line).toContain("MTD");
      expect(line).toMatch(/block \d+% \(\d+m left\)/);
    } finally {
      cache.close();
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("omits missing segments gracefully (no session match, no blocks)", async () => {
    const cache = setup([ev({ id: "1", ts: "2020-01-01T00:00:00Z" })]); // old event, no active block at `now`
    try {
      const line = await renderStatusline(
        parseStatuslineStdin('{"session_id":"nope"}'),
        cache,
        Date.now(),
      );
      // no model, no session match ($0), no today/MTD spend this month, no active block
      expect(line).toBe("");
    } finally {
      cache.close();
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });
});
