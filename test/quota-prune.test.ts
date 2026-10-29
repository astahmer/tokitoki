import { afterAll, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tokitoki-quota-prune-"));
process.env.TOKITOKI_DATA_DIR = dataDir;
const { EventCache } = await import("../src/cache.ts");
afterAll(() => fs.rmSync(dataDir, { recursive: true, force: true }));

it("keeps the newest row per window and recent history, drops the rest once a day", () => {
  const cache = new EventCache();
  try {
    const now = new Date("2026-10-29T12:00:00.000Z");
    const poll = (daysAgo: number, windows: Array<{ windowMinutes: number; usedPct: number }>) => cache.insertPolledSnapshots({
      provider: "claude-code", accountKey: "default", accountId: "acc", eventId: `poll:${daysAgo}`, complete: false,
      capturedAtIso: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
      windows: windows.map((window) => ({ ...window, resetsAtEpoch: Math.floor(now.getTime() / 1000) + 3600 })),
    });
    poll(30, [{ windowMinutes: 300, usedPct: 10 }, { windowMinutes: 10080, usedPct: 20 }]);
    poll(20, [{ windowMinutes: 300, usedPct: 30 }]);
    poll(1, [{ windowMinutes: 300, usedPct: 50 }]);
    const before = cache.latestQuotaSnapshots("claude-code", "default").map((row) => [row.windowMinutes, row.usedPct]);

    expect(cache.pruneQuotaHistory({ now })).toEqual({ snapshots: 2, observations: 1 });
    expect(cache.latestQuotaSnapshots("claude-code", "default").map((row) => [row.windowMinutes, row.usedPct])).toEqual(before);
    expect(cache.database.query("SELECT COUNT(*) AS n FROM quota_snapshots").get()).toEqual({ n: 2 });
    expect(cache.pruneQuotaHistory({ now })).toEqual({ snapshots: 0, observations: 0 });
  } finally { cache.close(); }
});
