import { describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import { EventCache } from "../src/cache.ts";
import {
  opencodeCredentials,
  pollQuotas,
  redactCredential,
  type PollOptions,
} from "../src/poll.ts";

/** All optional store paths pointing at nonexistent files — hermetic by default. */
function hermeticPaths(): PollOptions {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-hermetic-"));
  const miss = (name: string) => path.join(dir, name);
  return {
    claudeCredentialsPath: miss("claude.json"),
    claudeAccountPath: miss("claude-account.json"),
    copilotAuthPath: miss("copilot-apps.json"),
    cursorAuthPath: miss("cursor-auth.json"),
    cursorStateVscdbPath: miss("cursor-state.vscdb"),
    commandcodeAuthPath: miss("commandcode-auth.json"),
    geminiCredsPath: miss("gemini-oauth-creds.json"),
    kimiHome: miss("kimi-code"),
    env: { TOKITOKI_POLL_LOCK: miss("poll.lock") },
  };
}

/** Minimal pi auth store fixture (openrouter + opencode-go keys). */
function piAuthFixture(dir: string): string {
  const file = path.join(dir, "pi-auth.json");
  writeFileSync(
    file,
    JSON.stringify({
      openrouter: { type: "api_key", key: "sk-or-v1-hermetic" },
      "opencode-go": { type: "api_key", key: "sk-MDe8-hermetic" },
    }),
  );
  return file;
}

describe("redactCredential", () => {
  it("keeps first4 + last4 and never the middle", () => {
    expect(redactCredential("sk-io-AbCdEfGhIjKlMnOpXy12")).toBe("sk-i…Xy12");
    // short keys degrade to a bare hint instead of leaking content
    expect(redactCredential("short")).toBe("…");
  });
});

describe("opencodeCredentials", () => {
  it("reads and redacts stored api keys", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-oc-"));
    const file = path.join(dir, "auth.json");
    writeFileSync(
      file,
      JSON.stringify({ "opencode-go": { type: "api", key: "sk-io-AbCdEfGhIjKlMnOpXy12" }, broken: null }),
    );
    const creds = opencodeCredentials(file);
    expect(creds["opencode-go"]).toBe("sk-i…Xy12");
    expect(Object.keys(creds)).not.toContain("broken");
  });
});

describe("pollQuotas", () => {
  it("polls Command Code session/week/month meters from its billing API", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-commandcode-"));
    const auth = path.join(dir, "auth.json");
    writeFileSync(auth, JSON.stringify({ apiKey: "user-test-key" }));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      const fetcher = (async (input: unknown) => {
        const url = String(input);
        if (url.endsWith("/alpha/whoami")) return new Response(JSON.stringify({ user: { email: "cc@example.com" }, org: null }), { status: 200 });
        if (url.includes("/alpha/billing/credits")) {
          return new Response(JSON.stringify({
            credits: { monthlyCredits: 20 },
            windowLimits: {
              fiveHour: { used: 1, cap: 4, resetAt: 1_800_000_000 },
              weekly: { used: 2, cap: 10, resetAt: 1_805_000_000 },
            },
          }), { status: 200 });
        }
        if (url.includes("/alpha/billing/subscriptions")) return new Response(JSON.stringify({ data: { currentPeriodEnd: "2026-09-01T00:00:00.000Z" } }), { status: 200 });
        if (url.includes("/alpha/usage/summary")) return new Response(JSON.stringify({ totalMonthlyCredits: 5 }), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;
      const res = await pollQuotas({
        authPath: path.join(dir, "missing-codex.json"),
        piAuthPath: path.join(dir, "missing-pi.json"),
        fetcher,
        cache,
        ...hermeticPaths(),
        commandcodeAuthPath: auth,
      });
      const account = res.accounts.find((a) => a.harnesses === undefined && a.accountKey === "default" && a.email === "cc@example.com");
      expect(account).toBeDefined();
      expect(account!.windows.map((w) => w.windowMinutes).sort((a, b) => a - b)).toEqual([0, 300, 10_080]);
      expect(account!.windows.map((w) => Math.round(w.usedPct)).sort((a, b) => a - b)).toEqual([25, 20, 100 * 5 / 25].sort((a, b) => a - b));
      expect(account!.inserted).toBe(3);
    } finally {
      cache.close();
    }
  });

  it("reports not-logged-in when every auth store is missing", async () => {
    const res = await pollQuotas({
      authPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
      piAuthPath: path.join(os.tmpdir(), `missing-pi-${Date.now()}.json`),
      ...hermeticPaths(),
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("not logged in");
  });

  it("polls claude oauth usage and stores snapshots under claude-code/default", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-claude-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      writeFileSync(
        path.join(dir, "claude.json"),
        JSON.stringify({ claudeAiOauth: { accessToken: "at-claude", refreshToken: "rt-claude" } }),
      );
      const fetcher = (async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/oauth/usage")) {
          return new Response(
            JSON.stringify({
              five_hour: { utilization: 21.5, resets_at: new Date(1_700_000_000_000).toISOString() },
              seven_day: { utilization: 63, resets_at: new Date(1_700_100_000_000).toISOString() },
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;

      const res = await pollQuotas({
        ...hermeticPaths(),
        providers: ["claude-code"],
        authPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
        piAuthPath: path.join(os.tmpdir(), `missing-pi-${Date.now()}.json`),
        claudeCredentialsPath: path.join(dir, "claude.json"),
        fetcher,
        cache,
      });
      const acc = res.accounts.find((a) => a.accountKey === "default" && a.harnesses?.includes("claude-code"));
      expect(acc).toBeDefined();
      expect(acc!.windows.map((w) => w.windowMinutes).sort((a, b) => a - b)).toEqual([300, 10_080]);
      expect(acc!.windows[0]!.usedPct).toBeCloseTo(21.5);
      expect(acc!.inserted).toBe(2);

      const rows = cache.database
        .query("SELECT provider, account_key FROM quota_snapshots WHERE provider='claude-code'")
        .all() as Array<{ provider: string; account_key: string }>;
      expect(rows.length).toBe(2);
      expect(rows.every((r) => r.account_key === "default")).toBe(true);
    } finally {
      cache.close();
    }
  });

  it("refreshes the claude token once on 401 and retries", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-claude-r-"));
    writeFileSync(
      path.join(dir, "claude.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "stale", refreshToken: "rt-x" } }),
    );
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    let usageCalls = 0;
    const fetcher = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.includes("/v1/oauth/token")) {
        return new Response(JSON.stringify({ access_token: "fresh" }), { status: 200 });
      }
      if (url.includes("/api/oauth/usage")) {
        usageCalls += 1;
        // First attempt: stale token → 401. Retry with refreshed token: valid windows.
        if (usageCalls === 1) return new Response("unauthorized", { status: 401 });
        return new Response(
          JSON.stringify({ five_hour: { utilization: 10, resets_at: "2026-09-01T00:00:00Z" } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const res = await pollQuotas({
      ...hermeticPaths(),
      authPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
      piAuthPath: path.join(os.tmpdir(), `missing-pi-${Date.now()}.json`),
      claudeCredentialsPath: path.join(dir, "claude.json"),
      fetcher,
    });
    const refreshRequest = requests.find((request) => request.url.includes("/v1/oauth/token"));
    expect(refreshRequest).toBeDefined();
    expect((refreshRequest!.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(JSON.parse(String(refreshRequest!.init?.body))).toEqual({
      grant_type: "refresh_token",
      refresh_token: "rt-x",
      client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
    });
    const acc = res.accounts.find((a) => a.harnesses?.includes("claude-code"));
    expect(acc).toBeDefined();
    expect(acc!.windows.length).toBeGreaterThan(0);
  });

  it("persists a rotated refresh token so Claude Code's own session doesn't get invalidated", async () => {
    // Anthropic's refresh tokens are single-use and rotate on every refresh —
    // a tool that refreshes without saving the new one silently breaks
    // Claude Code's (or another device's) next refresh attempt.
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-claude-rotate-"));
    const credPath = path.join(dir, "claude.json");
    writeFileSync(
      credPath,
      JSON.stringify({
        claudeAiOauth: { accessToken: "stale", refreshToken: "rt-old", scopes: ["user:inference"], subscriptionType: "max" },
        mcpOAuth: { untouched: true },
      }),
    );
    let usageCalls = 0;
    const fetcher = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/v1/oauth/token")) {
        return new Response(
          JSON.stringify({ access_token: "fresh", refresh_token: "rt-new", expires_in: 3600 }),
          { status: 200 },
        );
      }
      if (url.includes("/api/oauth/usage")) {
        usageCalls += 1;
        if (usageCalls === 1) return new Response("unauthorized", { status: 401 });
        return new Response(
          JSON.stringify({ five_hour: { utilization: 10, resets_at: "2026-09-01T00:00:00Z" } }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    await pollQuotas({
      ...hermeticPaths(),
      authPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
      piAuthPath: path.join(os.tmpdir(), `missing-pi-${Date.now()}.json`),
      claudeCredentialsPath: credPath,
      fetcher,
    });

    const saved = JSON.parse(readFileSync(credPath, "utf8")) as {
      claudeAiOauth: { accessToken: string; refreshToken: string; scopes: string[]; subscriptionType: string; expiresAt: number };
      mcpOAuth: { untouched: boolean };
    };
    expect(saved.claudeAiOauth.accessToken).toBe("fresh");
    expect(saved.claudeAiOauth.refreshToken).toBe("rt-new");
    // Sibling fields (this account's own, and the unrelated mcpOAuth key)
    // must survive the rewrite untouched.
    expect(saved.claudeAiOauth.scopes).toEqual(["user:inference"]);
    expect(saved.claudeAiOauth.subscriptionType).toBe("max");
    expect(saved.mcpOAuth).toEqual({ untouched: true });
    expect(saved.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now());
  });

  it("marks Claude as requiring login when its refresh token is rejected", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-claude-auth-"));
    writeFileSync(
      path.join(dir, "claude.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "expired", refreshToken: "revoked" } }),
    );
    const fetcher = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/oauth/usage")) return new Response("unauthorized", { status: 401 });
      if (url.includes("/v1/oauth/token")) {
        return new Response(JSON.stringify({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }), { status: 400 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await pollQuotas({
      ...hermeticPaths(),
      providers: ["claude-code"],
      authPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
      piAuthPath: path.join(os.tmpdir(), `missing-pi-${Date.now()}.json`),
      claudeCredentialsPath: path.join(dir, "claude.json"),
      fetcher,
    });
    expect(result.ok).toBe(false);
    expect(result.authRequiredProviders).toEqual(["claude-code"]);
    expect(result.reason).toContain("Refresh token not found or invalid");
  });

  it("marks other providers and shared harness cards when credentials fail", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-provider-auth-"));
    const piAuth = piAuthFixture(dir);
    const cursorAuth = path.join(dir, "cursor.json");
    writeFileSync(cursorAuth, JSON.stringify({ accessToken: "expired" }));
    const fetcher = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("openrouter.ai")) return new Response("unauthorized", { status: 401 });
      if (url.includes("api2.cursor.sh")) return new Response("unauthorized", { status: 403 });
      throw new Error(`unexpected fetch: ${url}`);
    }) as unknown as typeof fetch;

    const result = await pollQuotas({
      ...hermeticPaths(),
      providers: ["openrouter", "cursor"],
      authPath: path.join(dir, "missing-codex.json"),
      piAuthPath: piAuth,
      cursorAuthPath: cursorAuth,
      fetcher,
    });
    expect(result.providerAuthStates).toEqual({
      cursor: "login-required",
      openrouter: "api-key-required",
      pi: "api-key-required",
    });
  });

  it("marks missing Copilot credentials as requiring login", async () => {
    const result = await pollQuotas({
      ...hermeticPaths(),
      providers: ["copilot"],
      authPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
      piAuthPath: path.join(os.tmpdir(), `missing-pi-${Date.now()}.json`),
    });
    expect(result.authRequiredProviders).toEqual(["copilot"]);
  });

  it("reads the copilot token from apps.json and stores a percent meter", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-pilot-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      const copilotAuth = path.join(dir, "apps.json");
      writeFileSync(copilotAuth, JSON.stringify({ "github.com": { oauth_token: "gho-test" } }));
      const reset = new Date(Date.now() + 10 * 24 * 3600_000).toISOString();
      const fetcher = (async (input: unknown) => {
        const url = String(input);
        if (url.includes("copilot_internal/user")) {
          return new Response(
            JSON.stringify({
              quota_reset_date: reset,
              quota_snapshots: {
                chat: { entitlement: 300, remaining: 150, percent_remaining: 50 },
                premium_interactions: { unlimited: true, entitlement: -1, remaining: -1 },
                credits: { entitlement: 0, remaining: 0 },
              },
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;

      const res = await pollQuotas({
        ...hermeticPaths(),
        providers: ["copilot"],
        authPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
        piAuthPath: path.join(os.tmpdir(), `missing-pi-${Date.now()}.json`),
        copilotAuthPath: copilotAuth,
        fetcher,
        cache,
      });
      const acc = res.accounts.find((a) => a.accountKey === "default" && a.harnesses?.includes("copilot"));
      expect(acc).toBeDefined();
      expect(res.accounts.every((a) => a.harnesses?.includes("copilot"))).toBe(true);
      // chat bucket only — unlimited and zero-entitlement buckets suppressed
      expect(acc!.windows).toHaveLength(1);
      expect(acc!.windows[0]!.usedPct).toBeCloseTo(50);
      expect(acc!.inserted).toBe(1);
    } finally {
      cache.close();
    }
  });

  it("falls back to the Cursor IDE's own login (state.vscdb) when there's no cursor-agent CLI login", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-cursor-ide-auth-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      const vscdb = path.join(dir, "state.vscdb");
      const db = new Database(vscdb);
      db.exec("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)");
      db.query("INSERT INTO ItemTable VALUES ('cursorAuth/accessToken', 'ide-token-123')").run();
      db.close();

      const endMs = Date.now() + 5 * 24 * 3600_000;
      const fetcher = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("api2.cursor.sh")) {
          expect((init?.headers as Record<string, string>).authorization).toBe("Bearer ide-token-123");
          // Real GetCurrentPeriodUsage shape (verified against a live account
          // 2026-09-01) — not the {usagePercent,...} shape the old parser guessed.
          return new Response(
            JSON.stringify({
              billingCycleStart: String(Date.now() - 25 * 24 * 3600_000),
              billingCycleEnd: String(endMs),
              planUsage: { autoPercentUsed: 38.5, apiPercentUsed: 0, totalPercentUsed: 32.4 },
              spendLimitUsage: { pooledUsed: 34_770, pooledLimit: 300_000, limitType: "team" },
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;

      const res = await pollQuotas({
        ...hermeticPaths(),
        providers: ["cursor"],
        authPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
        piAuthPath: path.join(os.tmpdir(), `missing-pi-${Date.now()}.json`),
        cursorAuthPath: path.join(dir, "missing-cli-auth.json"),
        cursorStateVscdbPath: vscdb,
        fetcher,
        cache,
      });
      const acc = res.accounts.find((a) => a.harnesses?.includes("cursor"));
      expect(acc).toBeDefined();
      // Three labeled buckets, not one blended percent.
      expect(acc!.windows).toHaveLength(3);
      expect(acc!.windows.find((w) => w.label === "Cursor Models")?.usedPct).toBeCloseTo(38.5);
      expect(acc!.windows.find((w) => w.label === "Other Models")?.usedPct).toBeCloseTo(0);
      // On-Demand shows a real dollar amount (matching Cursor's own dashboard,
      // which never shows a percent for it) — usedPct still drives the bar
      // fill since a real pooled cap exists here (34770/300000).
      const onDemand = acc!.windows.find((w) => w.label === "On-Demand");
      expect(onDemand?.amountUsd).toBeCloseTo(347.7);
      expect(onDemand?.usedPct).toBeCloseTo(11.59, 1);
    } finally {
      cache.close();
    }
  });

  it("keeps legacy Copilot reset snapshots as one visible quota window", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-pilot-legacy-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      cache.insertPolledSnapshots({
        provider: "copilot",
        accountKey: "default",
        windows: [{ windowMinutes: 7_656, usedPct: 95, resetsAtEpoch: 1_800_000_000 }],
        capturedAtIso: "2026-08-27T10:00:00.000Z",
        eventId: "poll:legacy-1:copilot",
      });
      cache.insertPolledSnapshots({
        provider: "copilot",
        accountKey: "default",
        windows: [{ windowMinutes: 43_200, usedPct: 94, resetsAtEpoch: 1_800_000_100 }],
        capturedAtIso: "2026-08-27T11:00:00.000Z",
        eventId: "poll:current:copilot",
      });
      const snapshots = cache.latestQuotaSnapshots("copilot", "default");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]!.windowMinutes).toBe(43_200);
    } finally {
      cache.close();
    }
  });

  it("persists manual gateway keys under pi/<id> and opencode/<id>", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-manual-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      const fetcher = (async (input: unknown) => {
        const url = String(input);
        if (url.includes("zen/go/v1/usage")) {
          return new Response(
            JSON.stringify({ usage: { weekly: { percent: 12, resetsAt: "2026-09-01T00:00:00Z" } } }),
            { status: 200 },
          );
        }
        if (url.includes("openrouter.ai/api/v1/key")) {
          return new Response(
            JSON.stringify({ data: { limit: 100, limit_remaining: 40, limit_reset: "monthly" } }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;

      const res = await pollQuotas({
        manualKeys: [
          { id: "work-gateway", provider: "opencode-go", key: "sk-manual" },
          { id: "personal-router", provider: "openrouter", key: "sk-router" },
        ],
        fetcher,
        cache,
        ...hermeticPaths(),
        authPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
        piAuthPath: path.join(os.tmpdir(), `missing-pi-${Date.now()}.json`),
      });
      const acc = res.accounts.find((a) => a.accountKey === "work-gateway");
      expect(acc).toBeDefined();
      expect(acc!.harnesses).toEqual(["pi", "opencode"]);
      const rows = cache.database
        .query("SELECT DISTINCT provider, account_key FROM quota_snapshots WHERE account_key='work-gateway'")
        .all() as Array<{ provider: string; account_key: string }>;
      expect(rows).toContainEqual({ provider: "pi", account_key: "work-gateway" });
      expect(rows).toContainEqual({ provider: "opencode", account_key: "work-gateway" });
      expect(res.accounts.find((a) => a.accountKey === "personal-router")?.windows[0]?.usedPct).toBeCloseTo(60);
      const routerRows = cache.database
        .query("SELECT DISTINCT provider, account_key FROM quota_snapshots WHERE account_key='personal-router'")
        .all() as Array<{ provider: string; account_key: string }>;
      expect(routerRows).toContainEqual({ provider: "openrouter", account_key: "personal-router" });
    } finally {
      cache.close();
    }
  });

  it("persists the same unknown reset it returns for OpenRouter's key-based account", async () => {
    // The key endpoint supplies a period, but no reset timestamp.
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-or-reset-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      const piAuth = piAuthFixture(dir);
      const fetcher = (async (input: unknown) => {
        const url = String(input);
        if (url.includes("openrouter.ai/api/v1/key")) {
          return new Response(
            JSON.stringify({ data: { limit: 100, limit_remaining: 40, limit_reset: "monthly" } }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;

      const res = await pollQuotas({
        providers: ["openrouter"],
        fetcher,
        cache,
        ...hermeticPaths(),
        authPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
        piAuthPath: piAuth,
      });
      const acc = res.accounts.find((a) => a.accountKey === "openrouter");
      expect(acc).toBeDefined();
      const returnedResetsAt = acc!.windows[0]!.resetsAtEpoch;
      expect(returnedResetsAt).toBe(0);

      const row = cache.database
        .query("SELECT resets_at FROM quota_snapshots WHERE provider = 'pi' AND account_key = 'openrouter'")
        .get() as { resets_at: number } | undefined;
      expect(row).toBeDefined();
      expect(row!.resets_at).toBe(returnedResetsAt);
    } finally {
      cache.close();
    }
  });

});
