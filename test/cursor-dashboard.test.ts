import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventCache } from "../src/cache.ts";
import {
  cursorDashboardUsageEvents,
  cursorWorkosCookie,
  syncCursorDashboardUsage,
} from "../src/providers/cursor-dashboard.ts";

function loginToken(): string {
  const payload = Buffer.from(JSON.stringify({ sub: "user_01|user_abc" })).toString("base64url");
  return `hdr.${payload}.sig`;
}

describe("cursor dashboard usage", () => {
  it("builds the Workos cookie from the login JWT subject", () => {
    const cookie = cursorWorkosCookie(loginToken());
    expect(cookie).toBe(`WorkosCursorSessionToken=${encodeURIComponent(`user_abc::${loginToken()}`)}`);
    expect(cursorWorkosCookie("not-a-jwt")).toBeNull();
  });

  it("maps a dashboard page onto cursor usage events", () => {
    const events = cursorDashboardUsageEvents({
      machineId: "test",
      body: {
        usageEventsDisplay: [
          {
            timestamp: "1761000000000",
            model: "grok-4.7",
            conversationId: "conv-1",
            tokenUsage: {
              inputTokens: 1000,
              outputTokens: 50,
              cacheReadTokens: 10,
              cacheWriteTokens: 0,
              totalCents: 25,
            },
          },
          { timestamp: "1761000001000", model: "grok-4.7", tokenUsage: null },
          {
            timestamp: "1761000002000",
            model: "composer-2.5",
            tokenUsage: { inputTokens: 20, outputTokens: 4, cacheReadTokens: 8, totalCents: 10 },
          },
        ],
      },
    });
    expect(events).toHaveLength(2);
    expect(events[1]!.cacheWriteTokens).toBe(0);
    expect(events[1]!.cacheReadTokens).toBe(8);
    expect(events[1]!.costUsd).toBeCloseTo(0.1);
    expect(events[0]!.provider).toBe("cursor");
    expect(events[0]!.accountKey).toBe("default");
    expect(events[0]!.sessionId).toBe("conv-1");
    expect(events[0]!.inputTokens).toBe(1000);
    expect(events[0]!.costUsd).toBeCloseTo(0.25);
    expect(events[0]!.ts).toBe(new Date(1_761_000_000_000).toISOString());
  });

  it("stores dashboard events on poll and leaves a non-JWT login alone", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-cursor-dashboard-"));
    const previous = process.env.TOKITOKI_DATA_DIR;
    process.env.TOKITOKI_DATA_DIR = dir;
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      const fetcher = (async (input: unknown) => {
        expect(String(input)).toContain("get-filtered-usage-events");
        return new Response(JSON.stringify({
          usageEventsDisplay: [{
            timestamp: String(Date.parse("2026-10-20T12:00:00.000Z")),
            model: "grok-4.7",
            conversationId: "conv-9",
            tokenUsage: {
              inputTokens: 10,
              outputTokens: 2,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalCents: 100,
            },
          }],
        }), { status: 200 });
      }) as unknown as typeof fetch;
      expect(await syncCursorDashboardUsage({
        accessToken: loginToken(),
        fetcher,
        cache,
        now: Date.parse("2026-10-20T18:00:00.000Z"),
        machineId: "test",
      })).toBe(1);
      expect(cache.totals("2026-10-01T00:00:00.000Z").costUsd).toBeCloseTo(1);
      expect(await syncCursorDashboardUsage({
        accessToken: "ide-token",
        fetcher: (() => {
          throw new Error("should not fetch");
        }) as unknown as typeof fetch,
        cache,
      })).toBe(0);
    } finally {
      cache.close();
      if (previous === undefined) delete process.env.TOKITOKI_DATA_DIR;
      else process.env.TOKITOKI_DATA_DIR = previous;
    }
  });
});
