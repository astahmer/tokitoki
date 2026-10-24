import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { EventCache } from "../src/cache.ts";
import { computeLimits, dedupeAccountLimits, embeddedLimitWindow } from "../src/limits.ts";

const dirs: string[] = [];
const caches: EventCache[] = [];
const fixture = () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "quota-topology-"));
  dirs.push(dir);
  const cache = new EventCache(path.join(dir, "cache.sqlite"));
  caches.push(cache);
  return cache;
};
afterEach(() => {
  for (const cache of caches.splice(0)) cache.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const NOW = new Date("2026-10-24T12:00:00Z");
const window = (overrides = {}) => ({ windowMinutes: 300, usedPct: 25, resetsAtEpoch: NOW.getTime() / 1000 + 3600,
  bucketId: "codex", windowId: "primary", ...overrides });
const save = (cache: EventCache, overrides: Partial<Parameters<EventCache["insertPolledSnapshots"]>[0]> = {}) =>
  cache.insertPolledSnapshots({ provider: "codex", accountKey: "openai:personal", accountId: "personal",
    windows: [window()], capturedAtIso: NOW.toISOString(), eventId: "poll:current", ...overrides });

describe("quota observation topology", () => {
  it("migrates legacy windows without losing identity or resurrecting earlier cycles", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "quota-migration-"));
    dirs.push(dir);
    const file = path.join(dir, "cache.sqlite");
    const old = new Database(file);
    old.exec(`CREATE TABLE quota_snapshots (
      provider TEXT NOT NULL, account_key TEXT NOT NULL, account_id TEXT,
      window_minutes INTEGER NOT NULL, label TEXT NOT NULL DEFAULT '',
      used_pct REAL NOT NULL, resets_at INTEGER NOT NULL, captured_at TEXT NOT NULL,
      event_id TEXT NOT NULL, credits_json TEXT, amount_usd REAL, model TEXT,
      PRIMARY KEY(provider, account_key, window_minutes, label, captured_at));
      INSERT INTO quota_snapshots VALUES
      ('cursor','default','cursor-id',43200,'Included',45,1800000000,'2026-09-24T12:00:00Z','poll:old',NULL,NULL,NULL),
      ('cursor','default','cursor-id',44640,'Included',15,1800000000,'2026-10-24T12:00:00Z','poll:new',NULL,NULL,NULL);`);
    old.close();
    const cache = new EventCache(file);
    caches.push(cache);
    expect(cache.latestQuotaSnapshots("cursor", "default")).toMatchObject([{ windowMinutes: 44640, accountId: "cursor-id" }]);
    expect(cache.database.query("SELECT COUNT(*) AS count FROM quota_snapshots").get()).toEqual({ count: 2 });
  });
  it("replaces previous windows and retires every window on an empty full response", () => {
    const cache = fixture();
    save(cache, { capturedAtIso: "2026-10-24T10:00:00Z", windows: [window(), window({ windowId: "secondary", windowMinutes: 10080 })] });
    save(cache, { windows: [window({ windowMinutes: 43200 })] });
    expect(cache.latestQuotaSnapshots("codex", "openai:personal").map(w => w.windowMinutes)).toEqual([43200]);
    save(cache, { windows: [], capturedAtIso: "2026-10-24T12:01:00Z", eventId: "poll:empty" });
    expect(cache.latestQuotaSnapshots("codex", "openai:personal")).toEqual([]);
    expect([...cache.quotaAccountIds("codex", "openai:personal")]).toEqual(["personal"]);
  });
  it("replaces a metered bucket without removing independent meters", () => {
    const cache = fixture();
    save(cache, { windows: [window(), window({ bucketId: "review", windowMinutes: 10080 })], capturedAtIso: "2026-10-24T10:00:00Z" });
    save(cache, { bucketId: "codex", windows: [], eventId: "scan:empty" });
    expect(cache.latestQuotaSnapshots("codex", "openai:personal").map(w => w.bucketId)).toEqual(["review"]);
    save(cache, { windows: [window()], eventId: "poll:full-again" });
    expect(cache.latestQuotaSnapshots("codex", "openai:personal").map(w => w.bucketId)).toEqual(["codex"]);
  });
  it("keeps independent same-duration model updates and stable slots", () => {
    const cache = fixture();
    save(cache, { windows: [window({ model: "opus" }), window({ model: "sonnet" }), window({ windowId: "secondary" })] });
    save(cache, { complete: false, capturedAtIso: "2026-10-24T12:01:00Z", windows: [window({ model: "opus", usedPct: 60 })] });
    const rows = cache.latestQuotaSnapshots("codex", "openai:personal");
    expect(rows).toHaveLength(3);
    expect(rows.find(w => w.model === "opus")?.usedPct).toBe(60);
  });
  it("retires a previous Cursor cycle even when its duration changes", () => {
    const cache = fixture();
    save(cache, { provider: "cursor", windows: [window({ windowMinutes: 43200 })], capturedAtIso: "2026-09-24T12:00:00Z" });
    save(cache, { provider: "cursor", windows: [window({ windowMinutes: 44640 })] });
    expect(cache.latestQuotaSnapshots("cursor", "openai:personal").map(w => w.windowMinutes)).toEqual([44640]);
  });
  it("retains independently updated meters when every observation is partial", () => {
    const cache = fixture();
    save(cache, { complete: false, windows: [window({ model: "opus" })] });
    save(cache, { complete: false, windows: [window({ model: "sonnet" })], capturedAtIso: "2026-10-24T12:01:00Z" });
    expect(cache.latestQuotaSnapshots("codex", "openai:personal").map(w => w.model).sort()).toEqual(["opus", "sonnet"]);
  });
  it("retains a partial update ordered after a complete packet with the same timestamp", () => {
    const cache = fixture();
    save(cache, { bucketId: "codex" });
    save(cache, { complete: false, capturedAtIso: "2026-10-24T14:00:00+02:00", windows: [window({ usedPct: 45 })], eventId: "scan:partial" });
    expect(cache.latestQuotaSnapshots("codex", "openai:personal")[0]?.usedPct).toBe(45);
  });
  it("preserves meter identity while deduplicating cards", () => {
    const cache = fixture();
    save(cache, { windows: [window(), window({ bucketId: "review" }), window({ model: "opus" }), window({ model: "sonnet" })] });
    const windows = cache.latestQuotaSnapshots("codex", "openai:personal").map(snapshot => embeddedLimitWindow({ snapshot, now: NOW }));
    const card = { provider: "codex", accountKey: "openai:personal", windows };
    expect(dedupeAccountLimits([card, card])[0]?.windows).toHaveLength(4);
  });
});

describe("quota truthfulness", () => {
  it("suppresses expired capacity rather than inventing zero usage", () => {
    const cache = fixture();
    save(cache, { windows: [window({ resetsAtEpoch: NOW.getTime() / 1000 - 1 })] });
    const snapshot = cache.latestQuotaSnapshots("codex", "openai:personal")[0]!;
    const rendered = embeddedLimitWindow({ snapshot, now: NOW });
    expect(rendered).toMatchObject({ status: "expired", usedPct: undefined, usedPercent: undefined, label: "Session" });
    expect(rendered.pace).toBeUndefined();
  });
  it("uses the original observation timestamp for freshness", () => {
    const cache = fixture();
    save(cache, { windows: [window({ observedAt: "2026-10-23T12:00:00Z" })] });
    const snapshot = cache.latestQuotaSnapshots("codex", "openai:personal")[0]!;
    expect(embeddedLimitWindow({ snapshot, now: NOW })).toMatchObject({ status: "stale", usedPct: undefined, observedAt: "2026-10-23T12:00:00Z" });
  });
  it("keeps true zero use with unknown duration/reset and no invented pace", () => {
    const cache = fixture();
    save(cache, { windows: [window({ usedPct: 0, resetsAtEpoch: 0, windowMinutes: 0 })] });
    const snapshot = cache.latestQuotaSnapshots("codex", "openai:personal")[0]!;
    const rendered = embeddedLimitWindow({ snapshot, now: NOW });
    expect(rendered).toMatchObject({ status: "current", usedPct: 0, scope: "other", label: "Limit" });
    expect(rendered.pace).toBeUndefined();
    expect(rendered.windowMinutes).toBeUndefined();
    expect(embeddedLimitWindow({ snapshot, now: NOW, identityVerified: false })).toMatchObject({ status: "unknown", usedPct: undefined });
  });
  it("separates local calendar budgets from provider quotas", () => {
    const cache = fixture();
    const result = computeLimits(cache, { plans: { personal: { monthlyCostCap: 100 } } }, NOW, [{ provider: "codex", accountKey: "personal" }]);
    expect(result[0]?.windows).toEqual([]);
    expect(result[0]?.budgetWindows?.map(w => w.scope)).toEqual(["daily", "weekly", "monthly"]);
  });
});
