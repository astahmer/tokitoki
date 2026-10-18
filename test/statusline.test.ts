import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventCache } from "../src/cache.ts";
import { incidentSegment, parseStatuslineStdin, renderStatusline } from "../src/statusline.ts";
import type { UsageEvent } from "../src/types.ts";

const T0 = new Date(2026, 7, 25, 10).getTime();
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

  it("adds a short incident segment when the session vendor's status page is degraded", async () => {
    const now = T0 + 60 * 60 * 1000;
    const cache = setup([ev({ id: "1", ts: iso(T0), costUsd: 0.3 })]);
    const fetcher: typeof fetch = Object.assign(
      async () => new Response(JSON.stringify({
        page: { url: "https://status.claude.com" },
        status: { indicator: "major", description: "Partial System Outage" },
        incidents: [{ name: "Elevated errors on Claude Opus 5 and Sonnet", status: "investigating", impact: "major", shortlink: "https://stspg.io/x" }],
      })),
      { preconnect: () => {} },
    );
    try {
      const line = await renderStatusline(parseStatuslineStdin('{"session_id":"sess-1"}'), cache, now, { refreshIncidents: true, fetcher });
      expect(line).toContain("Claude partial outage: Elevated errors on Claude Opus…");
      const cachedOnly = await renderStatusline(parseStatuslineStdin("{}"), cache, now);
      expect(cachedOnly).toContain("Claude partial outage");
    } finally {
      cache.close();
      delete process.env.TOKITOKI_DATA_DIR;
    }
  });

  it("keeps the incident segment out when every vendor is operational", () => {
    expect(incidentSegment({ anthropic: { indicator: "none", description: "All Systems Operational" } })).toBeUndefined();
    expect(incidentSegment({
      google: { indicator: "minor", description: "" },
      openai: { indicator: "critical", description: "API down" },
    })).toBe("OpenAI outage: API down");
  });
});
