import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventCache } from "../src/cache.ts";
import { computeLimits } from "../src/limits.ts";
import {
  claudePlanLabel,
  nextPollState,
  parseClaudeProfile,
  parseClaudeUsage,
  pollGate,
  pollQuotas,
} from "../src/poll.ts";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/claude/${name}`, import.meta.url), "utf8"));
const fixturePath = (name: string): string => new URL(`./fixtures/claude/${name}`, import.meta.url).pathname;

describe("Claude usage and profile parsing", () => {
  it("keeps per-model weekly windows and extra usage", () => {
    const parsed = parseClaudeUsage(fixture("usage.json"));
    expect(parsed?.windows).toEqual([
      { bucketId: "claude", windowId: "five_hour", scope: "session", windowEnd: "2026-10-18T15:00:00.123Z", windowMinutes: 300, usedPct: 42, resetsAtEpoch: Math.round(Date.parse("2026-10-18T15:00:00.123Z") / 1000) },
      { bucketId: "claude", windowId: "seven_day", scope: "weekly", windowEnd: "2026-10-22T09:00:00.000Z", windowMinutes: 10_080, usedPct: 61, resetsAtEpoch: Date.parse("2026-10-22T09:00:00Z") / 1000 },
      { bucketId: "opus", windowId: "seven_day", scope: "model", windowEnd: "2026-10-22T09:00:00.000Z", windowMinutes: 10_080, usedPct: 12, resetsAtEpoch: Date.parse("2026-10-22T09:00:00Z") / 1000, model: "opus", label: "Opus weekly" },
      { bucketId: "sonnet", windowId: "seven_day", scope: "model", windowEnd: "2026-10-22T09:00:00.000Z", windowMinutes: 10_080, usedPct: 35.5, resetsAtEpoch: Date.parse("2026-10-22T09:00:00Z") / 1000, model: "sonnet", label: "Sonnet weekly" },
    ]);
    expect(parsed?.extraUsage).toEqual({ enabled: true, usedUsd: 12.5, limitUsd: 50, usedPercent: 25 });
  });

  it("rejects a response that is not a usage object", () => {
    expect(parseClaudeUsage({ five_hour: "busy" })).toBeUndefined();
  });

  it("reads identity and plan from the OAuth profile", () => {
    expect(parseClaudeProfile(fixture("profile.json"))).toEqual({
      email: "dev@example.com",
      accountId: "acc-0f3c9b4e",
      organization: "dev@example.com's Organization",
      plan: "Max 20x",
    });
    expect(parseClaudeProfile({ account: "nope" })).toEqual({});
  });

  it("names plans from subscription type and tier", () => {
    expect(claudePlanLabel({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" })).toBe("Max 5x");
    expect(claudePlanLabel({ subscriptionType: "pro" })).toBe("Pro");
    expect(claudePlanLabel({ subscriptionType: "claude_team", rateLimitTier: "default_claude_max_5x" })).toBe("Team");
    expect(claudePlanLabel({})).toBeUndefined();
  });
});

const futureUsage = (now: number) => ({
  five_hour: { utilization: 80, resets_at: new Date(now + 150 * 60_000).toISOString() },
  seven_day: { utilization: 30, resets_at: new Date(now + 3 * 86_400_000).toISOString() },
  seven_day_opus: { utilization: 10, resets_at: new Date(now + 3 * 86_400_000).toISOString() },
  extra_usage: { is_enabled: false, monthly_limit: null, used_credits: null, utilization: null },
});

const setup = (credentials: Record<string, unknown>) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tk-claude-quota-"));
  const credentialsPath = path.join(dir, "credentials.json");
  writeFileSync(credentialsPath, JSON.stringify({ claudeAiOauth: { accessToken: "at", refreshToken: "rt", ...credentials } }));
  const missing = (name: string) => path.join(dir, name);
  return {
    dir,
    cache: new EventCache(path.join(dir, "cache.db")),
    options: {
      providers: ["claude-code"],
      claudeCredentialsPath: credentialsPath,
      claudeAccountPath: missing("dot-claude.json"),
      authPath: missing("codex-auth.json"),
      piAuthPath: missing("pi-auth.json"),
      copilotAuthPath: missing("copilot.json"),
      cursorAuthPath: missing("cursor.json"),
      cursorStateVscdbPath: missing("cursor.vscdb"),
      opencodexCachePath: missing("opencodex-cache.json"),
      opencodexAccountsPath: missing("opencodex-accounts.json"),
      commandcodeAuthPath: missing("commandcode.json"),
    },
  };
};

describe("Claude polling", () => {
  it("stores model windows, plan, extra usage, and the local login without calling the profile endpoint", async () => {
    const now = Date.now();
    const { cache, options } = setup({ subscriptionType: "max", rateLimitTier: "default_claude_max_5x" });
    const urls: string[] = [];
    const fetcher = (async (input: unknown) => {
      urls.push(String(input));
      if (String(input).includes("/api/oauth/usage")) return new Response(JSON.stringify(futureUsage(now)), { status: 200 });
      throw new Error(`unexpected fetch: ${String(input)}`);
    }) as unknown as typeof fetch;
    try {
      const result = await pollQuotas({ ...options, claudeAccountPath: fixturePath("dot-claude.json"), fetcher, cache, now });
      expect(urls).toHaveLength(1);
      const account = result.accounts[0]!;
      expect(account).toMatchObject({
        accountKey: "default",
        accountId: "acc-local-1",
        email: "local@example.com",
        planType: "Max 5x",
        extraUsage: { enabled: false },
        inserted: 3,
      });

      cache.insert([{
        id: "claude-code:default:s1:m1",
        ts: new Date(now - 60_000).toISOString(),
        machineId: "m",
        provider: "claude-code",
        accountKey: "default",
        model: "claude-opus-4-1",
        inputTokens: 1000,
        outputTokens: 500,
        costUsd: 0.5,
      }]);
      const limits = computeLimits(cache, {}, new Date(now));
      const card = limits.find((limit) => limit.provider === "claude-code")!;
      expect(card.accountId).toBe("acc-local-1");
      expect(card.plan).toBe("Max 5x");
      expect(card.planLabel).toBe("Max 5x");
      expect(card.extraUsage).toEqual({ enabled: false });
      expect(card.windows.map((window) => window.id).sort()).toEqual(["claude:five_hour", "claude:seven_day", "opus:seven_day:opus"]);
      expect(card.windows.every((window) => window.source === "embedded" && window.status === "current")).toBe(true);
      const session = card.windows.find((window) => window.id === "claude:five_hour")!;
      expect(session).toMatchObject({ bucketId: "claude", windowId: "five_hour", kind: "day", scope: "session", label: "Session", usedPercent: 80, windowMinutes: 300, tokens: 1500 });
      expect(session.pace?.status).toBe("over");
      expect(Date.parse(session.pace!.runsOutAt!)).toBeLessThan(Date.parse(session.resetsAt!));
      expect(card.windows.find((window) => window.id === "opus:seven_day:opus")).toMatchObject({
        bucketId: "opus",
        windowId: "seven_day",
        source: "embedded",
        kind: "Opus weekly",
        scope: "model",
        model: "opus",
        usedPercent: 10,
      });
    } finally {
      cache.close();
    }
  });

  it("falls back to the OAuth profile for identity and plan", async () => {
    const now = Date.now();
    const { cache, options } = setup({});
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetcher = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      if (url.includes("/api/oauth/usage")) return new Response(JSON.stringify(futureUsage(now)), { status: 200 });
      if (url.includes("/api/oauth/profile")) return new Response(JSON.stringify(fixture("profile.json")), { status: 200 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;
    try {
      const result = await pollQuotas({ ...options, fetcher, cache, now });
      expect(result.accounts[0]).toMatchObject({ accountId: "acc-0f3c9b4e", email: "dev@example.com", planType: "Max 20x" });
      const profile = requests.find((request) => request.url.endsWith("/api/oauth/profile"));
      expect(profile?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
      expect(cache.quotaAccountMeta("claude-code", "default")?.email).toBe("dev@example.com");
    } finally {
      cache.close();
    }
  });

  it("holds at least five minutes after HTTP 429 and never polls more often than every 300s", async () => {
    const start = Date.now();
    const { cache, options } = setup({ subscriptionType: "pro" });
    let usageCalls = 0;
    let rateLimited = true;
    const fetcher = (async (input: unknown) => {
      if (!String(input).includes("/api/oauth/usage")) throw new Error(`unexpected fetch: ${String(input)}`);
      usageCalls += 1;
      if (rateLimited) return new Response("slow down", { status: 429, headers: { "retry-after": "60" } });
      return new Response(JSON.stringify(futureUsage(start)), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const limited = await pollQuotas({ ...options, fetcher, cache, now: start });
      expect(limited.ok).toBe(false);
      expect(limited.reason).toContain("HTTP 429");
      expect(limited.providerAuthStates).toEqual({ "claude-code": "temporarily-unavailable" });

      rateLimited = false;
      const held = await pollQuotas({ ...options, fetcher, cache, now: start + 4 * 60_000 });
      expect(usageCalls).toBe(1);
      expect(held.reason).toContain("holding until");

      const resumed = await pollQuotas({ ...options, fetcher, cache, now: start + 5 * 60_000 + 1 });
      expect(usageCalls).toBe(2);
      expect(resumed.ok).toBe(true);

      const throttled = await pollQuotas({ ...options, fetcher, cache, now: start + 6 * 60_000 });
      expect(usageCalls).toBe(2);
      expect(throttled.ok).toBe(true);
      expect(throttled.accounts[0]?.deferredUntil).toBe(new Date(start + 10 * 60_000 + 1).toISOString());
      expect(throttled.accounts[0]?.windows).toHaveLength(3);
    } finally {
      cache.close();
    }
  });
});

describe("poll backoff state", () => {
  it("honours a Retry-After longer than the minimum hold", () => {
    const state = nextPollState({ outcome: "usage endpoint returned HTTP 429 (retry after 900s)", now: 1_000 });
    expect(state).toEqual({ lastAttemptAt: 1_000, holdUntil: 901_000 });
    expect(pollGate({ provider: "copilot", state, now: 900_000 })).toMatchObject({ allowed: false, until: 901_000 });
    expect(pollGate({ provider: "copilot", state, now: 901_000 })).toEqual({ allowed: true });
  });

  it("only throttles answered requests, and only for rate-limited providers", () => {
    expect(nextPollState({ outcome: "not logged in", now: 1_000 })).toBeUndefined();
    const answered = { lastAttemptAt: 0 };
    expect(pollGate({ provider: "claude-code", state: answered, now: 299_000 }).allowed).toBe(false);
    expect(pollGate({ provider: "claude-code", state: answered, now: 300_000 }).allowed).toBe(true);
    expect(pollGate({ provider: "cursor", state: answered, now: 1_000 }).allowed).toBe(true);
  });
});
