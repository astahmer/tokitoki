import { afterEach, describe, expect, it } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { parseClaudeUsage, pollQuotas } from "../src/poll.ts";
import { hermeticPoll, json, routeFetcher } from "./support/quota-poll.ts";

const cleanups: Array<() => void> = [];
const setup = (provider: string) => {
  const context = hermeticPoll({ providers: [provider] });
  cleanups.push(() => {
    context.cache.close();
    rmSync(context.dir, { recursive: true, force: true });
  });
  return context;
};
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const copilot = async (body: unknown) => {
  const { dir, cache, options } = setup("copilot");
  const auth = path.join(dir, "apps.json");
  writeFileSync(auth, JSON.stringify({ "github.com": { oauth_token: "fixture" } }));
  const { fetcher } = routeFetcher({ "copilot_internal/user": () => json(body) });
  const result = await pollQuotas({ ...options, copilotAuthPath: auth, fetcher, now: Date.parse("2026-10-24T12:00:00Z") });
  return { result, cache, windows: result.accounts[0]?.windows ?? [] };
};

describe("Copilot provider quota semantics", () => {
  for (const [end, start, days] of [
    ["2026-11-01", "2026-10-01", 31],
    ["2026-12-01", "2026-11-01", 30],
    ["2027-03-01", "2027-02-01", 28],
    ["2028-03-01", "2028-02-01", 29],
  ] as const) {
    it(`preserves the ${days}-day calendar month ending ${end}`, async () => {
      const { windows } = await copilot({ quota_reset_date_utc: `${end}T00:00:00Z`, quota_snapshots: { chat: { entitlement: 100, quota_remaining: 75 } } });
      expect(windows).toMatchObject([{ bucketId: "chat", windowId: "monthly", scope: "monthly", usedPct: 25, windowMinutes: days * 1440, windowStart: `${start}T00:00:00.000Z`, windowEnd: `${end}T00:00:00.000Z` }]);
    });
  }

  it("keeps every bounded bucket and prioritizes UTC and per-bucket resets", async () => {
    const { windows } = await copilot({
      quota_reset_date_utc: "2026-11-01T00:00:00Z",
      quota_reset_date: "2026-12-01",
      token_based_billing: true,
      quota_snapshots: {
        chat: { entitlement: "100", quota_remaining: "80", remaining: 0 },
        completions: { entitlement: 100, quota_remaining: 70, quota_reset_at: Date.parse("2026-12-01T00:00:00Z") / 1000 },
        premium_interactions: { entitlement: 300, percent_remaining: 90 },
        unlimited: { unlimited: true, percent_remaining: 100 },
        unallocated: { entitlement: 0, percent_remaining: 100 },
      },
    });
    expect(windows).toHaveLength(3);
    expect(windows[0]).toMatchObject({ bucketId: "chat", usedPct: 20, windowEnd: "2026-11-01T00:00:00.000Z" });
    expect(windows[1]).toMatchObject({ bucketId: "completions", usedPct: 30, windowMinutes: 43200, windowEnd: "2026-12-01T00:00:00.000Z" });
    expect(windows[2]).toMatchObject({ bucketId: "premium_interactions", label: "AI Credits", usedPct: 10 });
  });

  it("supports legacy free quotas and the legacy reset date", async () => {
    const { windows } = await copilot({ limited_user_reset_date: "2026-11-01", monthly_quotas: { chat: 50, completions: 100 }, limited_user_quotas: { chat: 25, completions: 20 } });
    expect(windows).toMatchObject([{ bucketId: "chat", usedPct: 50, windowMinutes: 44640 }, { bucketId: "completions", usedPct: 80 }]);
  });

  it("keeps unknown and non-calendar resets without fabricating a duration", async () => {
    const { windows } = await copilot({ quota_snapshots: {
      premium_interactions: { entitlement: 10, quota_remaining: 5 },
      chat: { entitlement: 10, quota_remaining: 5, quota_reset_at: Date.parse("2026-11-03T12:00:00Z") / 1000 },
    } });
    expect(windows[0]).toMatchObject({ label: "Premium requests", resetsAtEpoch: 0, windowMinutes: 0 });
    expect(windows[1]).toMatchObject({ windowEnd: "2026-11-03T12:00:00.000Z", windowMinutes: 0 });
    expect(windows.every((window) => window.windowStart === undefined)).toBe(true);
  });
});

const cursor = async (body: unknown) => {
  const { dir, options } = setup("cursor");
  const auth = path.join(dir, "cursor.json");
  writeFileSync(auth, JSON.stringify({ accessToken: "fixture" }));
  const { fetcher } = routeFetcher({
    GetCurrentPeriodUsage: () => json(body),
    "cursor.com": () => json({}, { status: 503 }),
  });
  return pollQuotas({ ...options, cursorAuthPath: auth, fetcher });
};

describe("Cursor supported legacy quota contract", () => {
  it("retains the actual cycle, distinct pools and on-demand spend", async () => {
    const result = await cursor({ billingCycleStart: String(Date.parse("2026-10-23T07:24:56Z")), billingCycleEnd: String(Date.parse("2026-11-23T07:24:56Z")), planUsage: { autoPercentUsed: 30, apiPercentUsed: 10 }, spendLimitUsage: { pooledUsed: 1234, pooledLimit: 5000 } });
    expect(result.accounts[0]?.windows).toMatchObject([
      { bucketId: "cursor-models", windowMinutes: 44640, windowStart: "2026-10-23T07:24:56.000Z", scope: "monthly", usedPct: 30 },
      { bucketId: "other-models", windowMinutes: 44640, usedPct: 10 },
      { bucketId: "on-demand", amountUsd: 12.34, usedPct: 24.68 },
    ]);
  });

  it("does not invent a cycle when dates are missing", async () => {
    const result = await cursor({ planUsage: { autoPercentUsed: 12 } });
    expect(result.accounts[0]?.windows[0]).toMatchObject({ windowMinutes: 0, resetsAtEpoch: 0, usedPct: 12 });
    expect(result.accounts[0]?.windows[0]?.windowStart).toBeUndefined();
  });

  it("reports unsupported current-plan shapes without inferring weekly usage", async () => {
    const result = await cursor({ planUsage: { totalPercentUsed: 35 }, spendLimitUsage: { pooledUsed: 100 } });
    expect(result.accounts).toEqual([]);
    expect(result.reason).toContain("current weekly plan schema is unverified");
  });
});

it("keeps Claude session, weekly and observed model identities without guessing Fable fields", () => {
  const result = parseClaudeUsage({ five_hour: { utilization: 0 }, seven_day: { utilization: 10 }, seven_day_opus: { utilization: 20 }, seven_day_sonnet: { utilization: 30 }, seven_day_fable: { utilization: 40 } });
  expect(result?.windows).toMatchObject([
    { bucketId: "claude", windowId: "five_hour", scope: "session", windowMinutes: 300, resetsAtEpoch: 0 },
    { bucketId: "claude", windowId: "seven_day", scope: "weekly" },
    { bucketId: "opus", windowId: "seven_day", scope: "model", model: "opus" },
    { bucketId: "sonnet", windowId: "seven_day", scope: "model", model: "sonnet" },
  ]);
});

it("keeps OpenRouter reset and monthly duration unknown, alongside the prepaid balance", async () => {
  const { dir, options } = setup("openrouter");
  const auth = path.join(dir, "pi.json");
  writeFileSync(auth, JSON.stringify({ openrouter: { type: "api_key", key: "fixture" } }));
  const { fetcher } = routeFetcher({
    "/api/v1/key": () => json({ data: { limit: 100, limit_remaining: 40, limit_reset: "monthly" } }),
    "/api/v1/credits": () => json({ data: { total_credits: 50, total_usage: 10 } }),
  });
  const result = await pollQuotas({ ...options, piAuthPath: auth, fetcher });
  expect(result.accounts[0]).toMatchObject({ windows: [{ bucketId: "key-credit-limit", scope: "monthly", usedPct: 60, windowMinutes: 0, resetsAtEpoch: 0 }], balance: { remaining: 40 } });
});

describe("Command Code monthly credit duration", () => {
  for (const start of [undefined, "2026-10-01T00:00:00Z"]) {
    it(`uses ${start === undefined ? "unknown duration without start" : "supplied period bounds"}`, async () => {
      const { dir, options } = setup("commandcode");
      const auth = path.join(dir, "command.json");
      writeFileSync(auth, JSON.stringify({ apiKey: "fixture" }));
      const { fetcher } = routeFetcher({
        "/alpha/whoami": () => json({ user: { email: "fixture@example.com" } }),
        "/alpha/billing/credits": () => json({ credits: { monthlyCredits: 20 } }),
        "/alpha/billing/subscriptions": () => json({ data: { currentPeriodStart: start, currentPeriodEnd: "2026-11-01T00:00:00Z" } }),
        "/alpha/usage/summary": () => json({ totalMonthlyCredits: 5 }),
      });
      const result = await pollQuotas({ ...options, commandcodeAuthPath: auth, fetcher });
      expect(result.accounts[0]?.windows).toMatchObject([{ bucketId: "monthly-credits", windowId: "billing-cycle", scope: "monthly", windowMinutes: start === undefined ? 0 : 44640, usedPct: 20, windowEnd: "2026-11-01T00:00:00.000Z" }]);
    });
  }
});
