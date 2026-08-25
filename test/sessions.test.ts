import { describe, expect, it } from "bun:test";
import path from "node:path";
import os from "node:os";

import { EventCache } from "../src/cache.ts";
import type { UsageEvent } from "../src/types.ts";

function tmpCache(): EventCache {
  return new EventCache(path.join(os.tmpdir(), `tokitoki-sessions-${Date.now()}-${Math.random().toString(36).slice(2)}.db`), () => "testrepo");
}

let n = 0;
function ev(partial: Partial<UsageEvent> & { ts: string; sessionId?: string }): UsageEvent {
  const sessionId = partial.sessionId ?? null;
  const id = partial.id ?? `p1:acct:${sessionId}:${++n}`;
  return {
    id,
    machineId: "m1",
    provider: "p1",
    accountKey: "acct",
    model: "m-a",
    inputTokens: 0,
    outputTokens: 0,
    ...partial,
    sessionId: sessionId ?? undefined,
  };
}

describe("topSessions", () => {
  it("groups by (provider, session_id) and orders by cost then tokens", () => {
    const cache = tmpCache();
    cache.insert([
      // costly session (2 requests)
      ev({ ts: "2026-08-20T10:00:00Z", sessionId: "s-costly", costUsd: 5, inputTokens: 100 }),
      ev({ ts: "2026-08-20T10:01:00Z", sessionId: "s-costly", costUsd: 1, outputTokens: 50, model: "m-b" }),
      // free but heavy session
      ev({ ts: "2026-08-20T11:00:00Z", sessionId: "s-heavy", inputTokens: 900_000, cacheReadTokens: 100_000 }),
      // other provider with the SAME session id must stay separate
      ev({ ts: "2026-08-20T12:00:00Z", provider: "p2", sessionId: "s-costly", costUsd: 0.5 }),
      // null session excluded
      ev({ ts: "2026-08-20T13:00:00Z", inputTokens: 9_999_999 }),
    ]);
    // Explicit cost leaderboard (legacy ordering).
    const rows = cache.topSessions({ sinceIso: "2026-08-01T00:00:00Z", sort: "cost" });
    // Cost desc first; token volume only breaks ties between equal costs.
    expect(rows.map((r) => `${r.provider}/${r.sessionId}`)).toEqual([
      "p1/s-costly",
      "p2/s-costly",
      "p1/s-heavy",
    ]);
    // Default is RECENT first (last_ts DESC): free/unbilled sessions must not
    // be buried under paid ones.
    const recent = cache.topSessions({ sinceIso: "2026-08-01T00:00:00Z" });
    expect(recent.map((r) => `${r.provider}/${r.sessionId}`)).toEqual([
      "p2/s-costly", // last event 12:00
      "p1/s-heavy", // 11:00
      "p1/s-costly", // 10:01
    ]);
    // Token tiebreak: two zero-cost sessions at the same instant order by
    // total tokens even in recency mode.
    cache.insert([
      ev({ ts: "2026-08-20T14:00:00Z", sessionId: "s-small", inputTokens: 10 }),
      ev({ ts: "2026-08-20T14:00:00Z", sessionId: "s-big", inputTokens: 20 }),
    ]);
    expect(
      cache
        .topSessions({ sinceIso: "2026-08-01T00:00:00Z" })
        .filter((r) => r.costUsd === 0)
        .map((r) => r.sessionId),
    ).toEqual(["s-big", "s-small", "s-heavy"]);
    const costly = rows[0]!;
    expect(costly.requests).toBe(2);
    expect(costly.models.sort()).toEqual(["m-a", "m-b"]);
    expect(costly.costUsd).toBeCloseTo(6);
    expect(costly.cachePct).toBe(0); // no cache read on either request
    cache.close();
  });

  it("computes %cache from cacheRead / (input + cacheRead)", () => {
    const cache = tmpCache();
    cache.insert([ev({ ts: "2026-08-20T10:00:00Z", sessionId: "s1", inputTokens: 300, cacheReadTokens: 700 })]);
    expect(cache.topSessions({ sinceIso: "2026-08-01T00:00:00Z" })[0]!.cachePct).toBe(70);
    cache.close();
  });

  it("applies provider filter and limit", () => {
    const cache = tmpCache();
    cache.insert([
      ev({ ts: "2026-08-20T10:00:00Z", sessionId: "a", costUsd: 3 }),
      ev({ ts: "2026-08-20T10:00:00Z", provider: "p2", sessionId: "b", costUsd: 2 }),
      ev({ ts: "2026-08-20T10:00:00Z", sessionId: "c", costUsd: 1 }),
    ]);
    const filtered = cache.topSessions({ sinceIso: "2026-08-01T00:00:00Z", providers: ["p1"] });
    expect(filtered).toHaveLength(2);
    const limited = cache.topSessions({ sinceIso: "2026-08-01T00:00:00Z", limit: 1, sort: "cost" });
    expect(limited.map((r) => r.sessionId)).toEqual(["a"]);
    cache.close();
  });
});

describe("sessionDetail + sessionProviders", () => {
  it("returns the request timeline ordered by ts and disambiguates providers", () => {
    const cache = tmpCache();
    cache.insert([
      ev({ ts: "2026-08-20T10:02:00Z", sessionId: "s1", inputTokens: 200, costUsd: 0.2 }),
      ev({ ts: "2026-08-20T10:00:00Z", sessionId: "s1", inputTokens: 100, costUsd: 0.1 }),
      ev({ ts: "2026-08-20T10:00:00Z", provider: "p2", sessionId: "s1" }),
    ]);
    expect(cache.sessionProviders("s1")).toEqual(["p1", "p2"]);
    const detail = cache.sessionDetail("p1", "s1");
    expect(detail.map((r) => r.ts)).toEqual(["2026-08-20T10:00:00Z", "2026-08-20T10:02:00Z"]);
    expect(detail.reduce((s, r) => s + r.costUsd, 0)).toBeCloseTo(0.3);
    cache.close();
  });

  it("returns an empty timeline for unknown sessions", () => {
    const cache = tmpCache();
    expect(cache.sessionProviders("nope")).toEqual([]);
    expect(cache.sessionDetail("p1", "nope")).toEqual([]);
    cache.close();
  });
});
