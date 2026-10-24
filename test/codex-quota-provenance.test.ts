import { describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { pollQuotas } from "../src/poll.ts";
import { buildAccountLimits } from "../src/limits-document.ts";
import { hermeticPoll, json, routeFetcher } from "./support/quota-poll.ts";

const NOW = Date.parse("2026-10-24T12:00:00Z");
const setup = () => {
  const fixture = hermeticPoll({ providers: ["codex"] });
  return { ...fixture, options: { ...fixture.options, now: NOW } };
};
const authFile = (input: { dir: string; id: string }) => {
  const file = path.join(input.dir, "auth.json");
  writeFileSync(file, JSON.stringify({ tokens: { access_token: "native", refresh_token: "native-refresh", account_id: input.id } }));
  return file;
};
const usageFetcher = (body: unknown) => routeFetcher({
  "wham/usage": () => json(body),
  "rate-limit-reset-credits": () => json({ available_count: 0 }),
});

describe("Codex quota provenance", () => {
  it("uses proven scanner aliases when matching a fallback weekly primary slot", async () => {
    const fixture = setup();
    try {
      fixture.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:work", accountId: "work",
        capturedAtIso: new Date(NOW - 600_000).toISOString(), eventId: "scan:weekly", bucketId: "codex",
        windows: [{ bucketId: "codex", windowId: "primary", scope: "weekly", windowMinutes: 10080, usedPct: 20, resetsAtEpoch: 0 }] });
      const pool = path.join(fixture.dir, "pool.json");
      const cached = path.join(fixture.dir, "cached.json");
      writeFileSync(pool, JSON.stringify({ work: { credential: { chatgptAccountId: "work" } } }));
      writeFileSync(cached, JSON.stringify({ quotas: { work: { updatedAt: NOW - 1000, weeklyPercent: 30 } } }));
      const { fetcher } = usageFetcher({});
      await pollQuotas({ ...fixture.options, opencodexAccountsPath: pool, opencodexCachePath: cached, fetcher });
      const cards = buildAccountLimits({ cache: fixture.cache, config: {}, now: new Date(NOW) });
      const account = cards.find(card => card.accountId === "work");
      expect(account?.windows).toHaveLength(1);
      expect(account?.windows[0]).toMatchObject({ windowId: "primary", scope: "weekly", usedPct: 30 });
    } finally { fixture.cache.close(); }
  });
  it("updates the same cached provider slots without duplicating a live pair or replacing additional meters", async () => {
    const fixture = setup();
    try {
      const capturedAtIso = new Date(NOW - 10 * 60_000).toISOString();
      fixture.cache.insertPolledSnapshots({ provider: "codex", accountKey: "codex:work", accountId: "work", capturedAtIso, eventId: "poll:live-work", windows: [
        { windowMinutes: 300, usedPct: 10, resetsAtEpoch: 0, bucketId: "codex", windowId: "primary" },
        { windowMinutes: 10080, usedPct: 20, resetsAtEpoch: 0, bucketId: "codex", windowId: "secondary" },
        { windowMinutes: 10080, usedPct: 30, resetsAtEpoch: 0, bucketId: "code-review", windowId: "primary" },
        { windowMinutes: 10080, usedPct: 40, resetsAtEpoch: 0, bucketId: "model-meter", windowId: "primary" },
      ] });
      const pool = path.join(fixture.dir, "pool.json");
      const cached = path.join(fixture.dir, "cached.json");
      writeFileSync(pool, JSON.stringify({ work: { credential: { chatgptAccountId: "work" } } }));
      writeFileSync(cached, JSON.stringify({ quotas: { work: { updatedAt: NOW - 1000, shortObservedAt: NOW - 1000, shortPercent: 11, shortWindowSeconds: 18000, weeklyPercent: 21 } } }));
      const { fetcher } = usageFetcher({});
      await pollQuotas({ ...fixture.options, opencodexAccountsPath: pool, opencodexCachePath: cached, fetcher });
      const snapshots = fixture.cache.latestQuotaSnapshots("codex", "codex:work");
      expect(snapshots.filter((row) => row.bucketId === "codex").map((row) => [row.windowId, row.usedPct]).sort()).toEqual([["primary", 11], ["secondary", 21]]);
      expect(snapshots.filter((row) => row.bucketId !== "codex")).toHaveLength(2);
    } finally { fixture.cache.close(); }
  });

  it("uses the primary slot for explicitly monthly-primary cache data", async () => {
    const fixture = setup();
    try {
      const cached = path.join(fixture.dir, "cached.json");
      writeFileSync(cached, JSON.stringify({ quotas: { work: { updatedAt: NOW - 1000, monthlyPercent: 30, monthlyIsPrimaryWindow: true, shortPercent: 90 } } }));
      const { fetcher } = usageFetcher({});
      const result = await pollQuotas({ ...fixture.options, opencodexCachePath: cached, fetcher });
      expect(result.accounts[0]?.windows[0]).toMatchObject({ bucketId: "codex", windowId: "primary", scope: "monthly", usedPct: 30 });
      expect(result.accounts[0]?.windows).toHaveLength(1);
    } finally { fixture.cache.close(); }
  });

  it("keeps same-plan logins separate and preserves plan metadata", async () => {
    const fixture = setup();
    try {
      const keys: string[] = [];
      for (const id of ["personal", "work"]) {
        const { fetcher } = usageFetcher({ account_id: id, plan_type: "plus", rate_limit: {} });
        const result = await pollQuotas({ ...fixture.options, authPath: authFile({ dir: fixture.dir, id }), fetcher });
        expect(result.accounts[0]?.planType).toBe("plus");
        expect(fixture.cache.quotaAccountMeta("codex", `openai:${id}`)?.plan).toBe("plus");
        keys.push(result.accounts[0]!.accountKey);
      }
      expect(keys).toEqual(["openai:personal", "openai:work"]);
    } finally { fixture.cache.close(); }
  });

  it("preserves independent additional, review and tertiary meters", async () => {
    const fixture = setup();
    try {
      const window = { used_percent: 12, limit_window_seconds: 18000, reset_at: NOW / 1000 + 3600 };
      const { fetcher } = usageFetcher({
        rate_limit: { primary_window: window, tertiary_window: window },
        code_review_rate_limit: { primary_window: window },
        additional_rate_limits: [{ metered_feature: "model-meter", limit_name: "Model", rate_limit: { primary_window: window } }],
      });
      const result = await pollQuotas({ ...fixture.options, authPath: authFile({ dir: fixture.dir, id: "personal" }), fetcher });
      expect(result.accounts[0]?.windows.map((w) => [w.bucketId, w.windowId])).toEqual([
        ["codex", "primary"], ["codex", "tertiary"], ["code-review", "primary"], ["model-meter", "primary"],
      ]);
      expect(result.accounts[0]?.windows.every((w) => w.observedAt === new Date(NOW).toISOString())).toBe(true);
      expect(fixture.cache.latestQuotaSnapshots("codex", "openai:personal")).toHaveLength(4);
    } finally { fixture.cache.close(); }
  });

  it("keeps a reported percentage with unknown reset and duration", async () => {
    const fixture = setup();
    try {
      const { fetcher } = usageFetcher({ rate_limit: { primary_window: { used_percent: 15 } } });
      const result = await pollQuotas({ ...fixture.options, authPath: authFile({ dir: fixture.dir, id: "personal" }), fetcher });
      expect(result.accounts[0]?.windows[0]).toMatchObject({ usedPct: 15, windowMinutes: 0, resetsAtEpoch: 0, scope: "other" });
    } finally { fixture.cache.close(); }
  });

  it("rejects responses from a different account", async () => {
    const fixture = setup();
    try {
      const { fetcher } = usageFetcher({ account_id: "other", rate_limit: {} });
      const result = await pollQuotas({ ...fixture.options, authPath: authFile({ dir: fixture.dir, id: "personal" }), fetcher });
      expect(result.accounts).toEqual([]);
      expect(result.reason).toContain("identity does not match");
    } finally { fixture.cache.close(); }
  });

  it("delegates pooled renewal without writing native credentials or importing cached usage", async () => {
    const fixture = setup();
    try {
      const native = authFile({ dir: fixture.dir, id: "personal" });
      const before = readFileSync(native, "utf8");
      const pool = path.join(fixture.dir, "pool.json");
      const cached = path.join(fixture.dir, "cached.json");
      writeFileSync(pool, JSON.stringify({ work: { credential: { accessToken: "pool", refreshToken: "pool-refresh", chatgptAccountId: "work" } } }));
      writeFileSync(cached, JSON.stringify({ quotas: { work: { updatedAt: NOW - 1000, weeklyPercent: 20 } } }));
      const { fetcher, requests } = routeFetcher({
        "wham/usage": (request) => request.headers.authorization === "Bearer pool" ? json({}, { status: 401 }) : json({ rate_limit: {} }),
        "rate-limit-reset-credits": () => json({ available_count: 0 }),
      });
      const result = await pollQuotas({ ...fixture.options, authPath: native, opencodexAccountsPath: pool, opencodexCachePath: cached, fetcher });
      expect(requests.some((request) => request.url.includes("oauth/token"))).toBe(false);
      expect(readFileSync(native, "utf8")).toBe(before);
      expect(result.providerAuthStates?.codex).toBe("login-required");
      expect(result.accounts.some((account) => account.accountKey === "codex:work")).toBe(false);
    } finally { fixture.cache.close(); }
  });

  it("imports monthly-only and custom counters without inventing durations or observation times", async () => {
    const fixture = setup();
    try {
      const cached = path.join(fixture.dir, "cached.json");
      const observed = NOW - 3600_000;
      writeFileSync(cached, JSON.stringify({ quotas: { work: {
        updatedAt: observed, monthlyPercent: 35, shortPercent: 10, shortObservedAt: observed - 1000,
        customWindows: [{ label: "Review", percent: 42 }],
      } } }));
      const { fetcher } = usageFetcher({});
      const result = await pollQuotas({ ...fixture.options, opencodexCachePath: cached, fetcher });
      const windows = result.accounts[0]!.windows;
      expect(windows.map((w) => [w.windowId, w.windowMinutes, w.usedPct])).toEqual([
        ["tertiary", 0, 35], ["primary", 0, 10], ["custom:Review", 0, 42],
      ]);
      expect(windows[1]?.observedAt).toBe(new Date(observed - 1000).toISOString());
      expect(windows[0]?.observedAt).toBe(new Date(observed).toISOString());
      const rows = fixture.cache.database.query("SELECT DISTINCT captured_at FROM quota_snapshots WHERE account_key = 'codex:work'").all();
      expect(rows).toEqual([{ captured_at: new Date(observed).toISOString() }]);
    } finally { fixture.cache.close(); }
  });

  it("rejects old or missing cache timestamps and excludes stale short usage independently", async () => {
    const fixture = setup();
    try {
      const cached = path.join(fixture.dir, "cached.json");
      writeFileSync(cached, JSON.stringify({ quotas: {
        old: { updatedAt: NOW - 7 * 3600_000, weeklyPercent: 50 },
        missing: { weeklyPercent: 50 },
        current: { updatedAt: NOW - 1000, weeklyPercent: 10, shortPercent: 90, shortObservedAt: NOW - 7 * 3600_000 },
      } }));
      const { fetcher } = usageFetcher({});
      const result = await pollQuotas({ ...fixture.options, opencodexCachePath: cached, fetcher });
      expect(result.accounts.map((a) => a.accountKey)).toEqual(["codex:current"]);
      expect(result.accounts[0]?.windows.map((w) => w.windowId)).toEqual(["secondary"]);
    } finally { fixture.cache.close(); }
  });

  it("accepts a successful empty pool response without reviving cached topology", async () => {
    const fixture = setup();
    try {
      const pool = path.join(fixture.dir, "pool.json");
      const cached = path.join(fixture.dir, "cached.json");
      writeFileSync(pool, JSON.stringify({ work: { credential: { accessToken: "pool", chatgptAccountId: "work" } } }));
      writeFileSync(cached, JSON.stringify({ quotas: { work: { updatedAt: NOW - 1000, weeklyPercent: 20 } } }));
      const { fetcher } = usageFetcher({ rate_limit: { primary_window: null, secondary_window: null } });
      const result = await pollQuotas({ ...fixture.options, opencodexAccountsPath: pool, opencodexCachePath: cached, fetcher });
      expect(result.accounts).toHaveLength(1);
      expect(result.accounts[0]?.windows).toEqual([]);
      expect(result.accounts[0]?.error).toBeUndefined();
    } finally { fixture.cache.close(); }
  });

  it("retires a previous pair after a monthly-only response and retires all windows after an empty response", async () => {
    const fixture = setup();
    try {
      const authPath = authFile({ dir: fixture.dir, id: "personal" });
      const bodies = [
        { rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 }, secondary_window: { used_percent: 20, limit_window_seconds: 604800 } } },
        { rate_limit: { primary_window: { used_percent: 15, limit_window_seconds: 2592000 }, secondary_window: null } },
        { rate_limit: { primary_window: null, secondary_window: null } },
      ];
      const observedTopologies: number[][] = [];
      for (const [index, body] of bodies.entries()) {
        const { fetcher } = usageFetcher(body);
        await pollQuotas({ ...fixture.options, now: NOW + index * 1000, authPath, fetcher });
        observedTopologies.push(fixture.cache.latestQuotaSnapshots("codex", "openai:personal").map((row) => row.windowMinutes).sort((a, b) => a - b));
      }
      expect(observedTopologies).toEqual([[300, 10080], [43200], []]);
    } finally { fixture.cache.close(); }
  });
});
