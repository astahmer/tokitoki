import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventCache } from "../src/cache.ts";
import { buildAccountLimits, limitsDocument, readLimitsDocument } from "../src/limits-document.ts";
import type { TokitokiConfig } from "../src/config.ts";

const now = new Date("2026-10-26T12:00:00Z");
const config: TokitokiConfig = { experimental: { zeroStateCards: false } };
const window = (usedPct: number, windowId = "primary") => ({
  windowMinutes: windowId === "primary" ? 300 : 10080, usedPct,
  resetsAtEpoch: now.getTime() / 1000 + 86_400, bucketId: "codex", windowId,
});
const fixture = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tk-native-limits-"));
  const dbPath = path.join(dir, "cache.db");
  let cache = new EventCache(dbPath);
  return {
    dir,
    get cache() { return cache; },
    reopenLegacy: () => {
      // Simulate a cache written by the previous release, before this migration.
      cache.database.query("DELETE FROM meta WHERE key = 'native-quota-provenance-v1'").run();
      cache.close();
      cache = new EventCache(dbPath);
    },
    close: () => { cache.close(); rmSync(dir, { recursive: true, force: true }); },
  };
};

describe("native quota cache migration", () => {
  it("retires proxy-only quota without deleting usage, metadata or preferences", () => {
    const context = fixture();
    try {
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "codex:old", accountId: "old", capturedAtIso: now.toISOString(), eventId: "poll:old:opencodex:old", windows: [window(99)] });
      context.cache.setQuotaAccountMeta("codex", "codex:old", { email: "old@example.com", plan: "Plus", bankedResets: 8 });
      context.cache.insert([{ id: "historical-cost", ts: now.toISOString(), provider: "codex", accountKey: "codex:old", machineId: "test", model: "gpt-5", inputTokens: 10, outputTokens: 5, costUsd: 2 }]);
      context.cache.setMetaValue("user-preferences", JSON.stringify({ hidden: ["codex@codex:old"], order: ["codex@codex:old"] }));
      context.reopenLegacy();
      expect(context.cache.latestQuotaSnapshots("codex", "codex:old")).toEqual([]);
      expect([...context.cache.quotaAccountIds("codex", "codex:old")]).toEqual([]);
      expect(context.cache.quotaAccountKeys({ provider: "codex", accountId: "old" })).toEqual([]);
      expect(context.cache.ownLoginFingerprints("codex").size).toBe(0);
      expect(context.cache.quotaAccountMeta("codex", "codex:old")).toBeUndefined();
      expect(context.cache.metaValue("quota-account:codex@codex:old")).toContain("old@example.com");
      expect(context.cache.metaValue("user-preferences")).toContain("codex@codex:old");
      const cards = buildAccountLimits({ cache: context.cache, config, now });
      expect(cards).toHaveLength(1);
      expect(cards[0]?.windows).toEqual([]);
      expect(cards[0]?.email).toBeUndefined();
      expect(cards[0]?.accountId).toBeUndefined();
      expect(cards[0]?.budgetWindows?.find(window => window.kind === "day")).toMatchObject({ cost: 2, tokens: 15, requests: 1 });
      expect(context.cache.database.query("SELECT COUNT(*) AS n FROM quota_snapshots WHERE retired = 1").get()).toEqual({ n: 1 });
    } finally { context.close(); }
  });

  it("does not discover retired quota-only accounts or revive a removed harness", () => {
    const context = fixture();
    try {
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "codex:foreign", accountId: "foreign", capturedAtIso: now.toISOString(), eventId: "poll:old:opencodex:foreign", windows: [window(20)] });
      context.cache.insertPolledSnapshots({ provider: "opencodex", accountKey: "default", capturedAtIso: now.toISOString(), eventId: "poll:old", windows: [window(20)] });
      context.cache.insert([{ id: "legacy-financial", ts: now.toISOString(), provider: "opencodex", accountKey: "default", machineId: "test", model: "gpt-5", inputTokens: 10, outputTokens: 5, costUsd: 3 }]);
      context.reopenLegacy();
      expect(buildAccountLimits({ cache: context.cache, config, now })).toEqual([]);
      expect(context.cache.aggregate("2026-10-26T00:00:00Z", "provider").find(row => row.bucket === "opencodex")?.costUsd).toBe(3);
    } finally { context.close(); }
  });

  it("prefers validated native history over newer retired topology and email", () => {
    const context = fixture();
    try {
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:work", accountId: "work", capturedAtIso: now.toISOString(), eventId: "scan:native", windows: [window(12)] });
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:work", accountId: "foreign", capturedAtIso: new Date(now.getTime() + 60_000).toISOString(), eventId: "poll:newer:opencodex:foreign", windows: [window(99)] });
      context.cache.setQuotaAccountMeta("codex", "account:work", { email: "foreign@example.com" });
      context.reopenLegacy();
      const cards = buildAccountLimits({ cache: context.cache, config, now });
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ accountId: "work", accountKey: "openai:work", origin: "scan" });
      expect(cards[0]?.email).toBeUndefined();
      expect(cards[0]?.windows[0]).toMatchObject({ usedPct: 12, status: "current" });
      context.cache.setQuotaAccountMeta("codex", "account:work", { email: "work@example.com" });
      expect(buildAccountLimits({ cache: context.cache, config, now })[0]?.email).toBe("work@example.com");
    } finally { context.close(); }
  });
});

describe("native account cards", () => {
  it("joins proven retired aliases without losing financial budgets or saved preferences", () => {
    const context = fixture();
    try {
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "codex:old", accountId: "work", capturedAtIso: now.toISOString(), eventId: "poll:old:opencodex", windows: [window(99)] });
      context.cache.insert([{ id: "alias-cost", ts: now.toISOString(), provider: "codex", accountKey: "codex:old", machineId: "test", model: "gpt-5", inputTokens: 10, outputTokens: 5, costUsd: 2 }]);
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "openai:work", accountId: "work", capturedAtIso: now.toISOString(), eventId: "poll:native", windows: [window(20)] });
      expect(context.cache.nativeAccountAliases(config).get("codex@codex:old")).toBe("codex@openai:work");
      context.cache.insert([{ id: "native-cost", ts: now.toISOString(), provider: "codex", accountKey: "openai:work", machineId: "test", model: "gpt-5", inputTokens: 10, outputTokens: 5, costUsd: 1 }]);
      const cards = buildAccountLimits({ cache: context.cache, config: { ...config, plans: { "codex:old": { monthlyCostCap: 100 } } }, now });
      expect(cards).toHaveLength(1);
      expect(cards[0]?.accountKey).toBe("openai:work");
      expect(cards[0]?.budgetWindows?.find(window => window.kind === "day")).toMatchObject({ cost: 3, tokens: 30, requests: 2 });
      expect(cards[0]?.budgetWindows?.find(window => window.kind === "month")).toMatchObject({ cost: 3, usedPct: 3, label: "Monthly budget" });
      expect(context.cache.windowUsageForAccount("codex", "codex:old", "2026-10-26T00:00:00Z").cost).toBe(2);
    } finally { context.close(); }
  });

  it("projects migrated order into the shared limits document", () => {
    const context = fixture();
    const previousData = process.env.TOKITOKI_DATA_DIR;
    process.env.TOKITOKI_DATA_DIR = context.dir;
    try {
      context.cache.sync([]);
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "codex:old", accountId: "work", capturedAtIso: now.toISOString(), eventId: "poll:old:opencodex", windows: [window(99)] });
      for (const accountId of ["personal", "work"]) context.cache.insertPolledSnapshots({ provider: "codex", accountKey: `openai:${accountId}`, accountId, capturedAtIso: now.toISOString(), eventId: `poll:${accountId}`, windows: [window(20)] });
      const savedConfig = { ...config, ui: { menubarAccountOrder: ["codex@codex:old", "codex@openai:personal"] } };
      const document = readLimitsDocument({ cache: context.cache, config: savedConfig, now });
      expect(document.accountOrder).toEqual(["codex@openai:work", "codex@openai:personal"]);
      expect(document.accounts.map(account => account.id)).toEqual(["codex@openai:work", "codex@openai:personal"]);
      expect(savedConfig.ui.menubarAccountOrder[0]).toBe("codex@codex:old");
    } finally {
      if (previousData === undefined) delete process.env.TOKITOKI_DATA_DIR;
      else process.env.TOKITOKI_DATA_DIR = previousData;
      context.close();
    }
  });

  it("keeps retired slots absent across alias replay and accepts newer native observations", () => {
    const context = fixture();
    try {
      const before = new Date(now.getTime() - 60_000).toISOString();
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:work", accountId: "work", capturedAtIso: before, eventId: "poll:before", windows: [window(20), window(30, "secondary")] });
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "openai:work", accountId: "work", capturedAtIso: now.toISOString(), eventId: "poll:partial", complete: false, windows: [], retiredWindows: [{ bucketId: "codex", windowId: "primary" }] });
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:work", accountId: "work", capturedAtIso: before, eventId: "scan:replay", complete: false, windows: [window(20)] });
      expect(buildAccountLimits({ cache: context.cache, config, now })[0]?.windows.map(window => window.windowId)).toEqual(["secondary"]);
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "openai:work", accountId: "work", capturedAtIso: new Date(now.getTime() + 1000).toISOString(), eventId: "poll:next", complete: false, windows: [window(10)] });
      expect(buildAccountLimits({ cache: context.cache, config, now })[0]?.windows).toHaveLength(2);
    } finally { context.close(); }
  });

  it("keeps two same-plan accounts with identical meters, home actions and reset credits separate", () => {
    const context = fixture();
    try {
      for (const accountId of ["work", "personal"]) {
        context.cache.insertPolledSnapshots({ provider: "codex", accountKey: `account:${accountId}`, accountId, capturedAtIso: now.toISOString(), eventId: `poll:${accountId}:codex`, windows: [window(20)], credits: { hasCredits: true, unlimited: false, balance: "999" } });
        context.cache.setQuotaAccountMeta("codex", `account:${accountId}`, { plan: "Plus", email: `${accountId}@example.com`, codexHome: `/native/${accountId}`, ...(accountId === "work" ? { bankedResets: 2, bankedExpiresAt: "2026-11-01T00:00:00Z" } : {}) });
      }
      const cards = buildAccountLimits({ cache: context.cache, config, now });
      expect(cards).toHaveLength(2);
      expect(cards.find(card => card.accountId === "work")).toMatchObject({ email: "work@example.com", plan: "Plus", codexHome: "/native/work", bankedResets: 2, bankedExpiresAt: "2026-11-01T00:00:00Z" });
      expect(cards.find(card => card.accountId === "personal")).toMatchObject({ email: "personal@example.com", plan: "Plus", codexHome: "/native/personal" });
      expect(cards.find(card => card.accountId === "personal")?.bankedResets).toBeUndefined();
      expect(JSON.stringify(limitsDocument({ limits: cards, now, showEmail: true }))).not.toContain("/native/");
    } finally { context.close(); }
  });

  it("retains partial slot freshness and marks a complete empty native response fresh", () => {
    const context = fixture();
    try {
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:work", accountId: "work", capturedAtIso: new Date(now.getTime() - 2 * 60 * 60_000).toISOString(), eventId: "poll:old:codex", windows: [window(20), window(30, "secondary")] });
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "openai:work", accountId: "work", capturedAtIso: now.toISOString(), eventId: "scan:partial", complete: false, windows: [window(40)] });
      const card = buildAccountLimits({ cache: context.cache, config, now })[0]!;
      expect(card).toMatchObject({ freshness: "fresh", observedAt: now.toISOString() });
      expect(card.windows.find(window => window.windowId === "primary")).toMatchObject({ usedPct: 40, status: "current" });
      expect(card.windows.find(window => window.windowId === "secondary")).toMatchObject({ status: "stale" });
      expect(card.windows.find(window => window.windowId === "secondary")?.usedPct).toBeUndefined();
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:work", accountId: "work", capturedAtIso: now.toISOString(), eventId: "poll:empty:codex", windows: [] });
      expect(buildAccountLimits({ cache: context.cache, config, now })[0]).toMatchObject({ freshness: "fresh", observedAt: now.toISOString(), origin: "polled", windows: [] });
    } finally { context.close(); }
  });
});
