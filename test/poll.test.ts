import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventCache } from "../src/cache.ts";
import {
  opencodeCredentials,
  opencodexAccountIdentities,
  pollQuotas,
  redactCredential,
} from "../src/poll.ts";

const ID_TOKEN = (() => {
  // header.payload.signature — only payload matters to the parser
  const payload = Buffer.from(
    JSON.stringify({
      email: "user@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-123",
        chatgpt_plan_type: "plus",
      },
    }),
  ).toString("base64url");
  return `abc.${payload}.sig`;
})();

function fixtureAuth(overrides: Record<string, unknown> = {}): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-"));
  const file = path.join(dir, "auth.json");
  writeFileSync(
    file,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        id_token: ID_TOKEN,
        access_token: "at-test",
        refresh_token: "rt-test",
        account_id: "acct-123",
      },
      ...overrides,
    }),
  );
  return file;
}

const USAGE_BODY = {
  account_id: "acct-123",
  plan_type: "plus",
  rate_limit: {
    primary_window: {
      used_percent: 12,
      reset_at: 1_800_000_000,
      limit_window_seconds: 18_000, // 300min session window
    },
    secondary_window: {
      used_percent: 40,
      reset_at: 1_805_000_000,
      limit_window_seconds: 604_800, // 10080min week window
    },
  },
};

/** All optional store paths pointing at nonexistent files — hermetic by default. */
function hermeticPaths(): Record<string, string> {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-hermetic-"));
  const miss = (name: string) => path.join(dir, name);
  return {
    claudeCredentialsPath: miss("claude.json"),
    copilotAuthPath: miss("copilot-apps.json"),
    cursorAuthPath: miss("cursor-auth.json"),
    opencodexCachePath: miss("opencodex-cache.json"),
    opencodexAccountsPath: miss("opencodex-accounts.json"),
    commandcodeAuthPath: miss("commandcode-auth.json"),
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

describe("opencodexAccountIdentities", () => {
  it("reads email and stable account id from pooled credentials", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-pool-identity-"));
    const file = path.join(dir, "accounts.json");
    const payload = Buffer.from(JSON.stringify({
      "https://api.openai.com/profile": { email: "work@example.com" },
      "https://api.openai.com/auth": { chatgpt_account_id: "work-account" },
    })).toString("base64url");
    writeFileSync(file, JSON.stringify({
      work: { credential: { accessToken: `header.${payload}.signature`, chatgptAccountId: "work-account" } },
    }));
    expect(opencodexAccountIdentities(file)).toEqual({
      work: { email: "work@example.com", accountId: "work-account" },
    });
  });
});

describe("pollQuotas", () => {
  it("coalesces concurrent callers into one upstream poll", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-single-flight-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    const previousLock = process.env.TOKITOKI_POLL_LOCK;
    process.env.TOKITOKI_POLL_LOCK = path.join(dir, "poll.lock");
    try {
      let calls = 0;
      const fetcher = (async (input: unknown) => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        const url = String(input);
        if (url.includes("wham/usage")) return new Response(JSON.stringify(USAGE_BODY), { status: 200 });
        if (url.includes("rate-limit-reset-credits")) return new Response(JSON.stringify({ credits: [], available_count: 0 }), { status: 200 });
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;
      const options = {
        ...hermeticPaths(),
        providers: ["codex"],
        authPath: fixtureAuth(),
        fetcher,
        cache,
      };
      const [one, two] = await Promise.all([pollQuotas(options), pollQuotas(options)]);
      expect(one).toEqual(two);
      expect(calls).toBe(2); // usage + banked-reset inventory
    } finally {
      cache.close();
      if (previousLock === undefined) delete process.env.TOKITOKI_POLL_LOCK;
      else process.env.TOKITOKI_POLL_LOCK = previousLock;
    }
  });

  it("keeps a pooled account's stable identity when materializing its quota card", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-pool-stable-id-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    const ocCache = path.join(dir, "codex-quota-cache.json");
    const ocAccounts = path.join(dir, "codex-accounts.json");
    writeFileSync(ocCache, JSON.stringify({
      quotas: { "chatgpt-work": { weeklyPercent: 41, weeklyResetAt: 1_800_000_001 } },
    }));
    writeFileSync(ocAccounts, JSON.stringify({
      "chatgpt-work": { credential: { chatgptAccountId: "work-account" } },
    }));
    try {
      const fetcher = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
      const res = await pollQuotas({
        ...hermeticPaths(),
        authPath: path.join(dir, "missing-auth.json"),
        piAuthPath: path.join(dir, "missing-pi.json"),
        opencodexCachePath: ocCache,
        opencodexAccountsPath: ocAccounts,
        fetcher,
        cache,
      });
      const account = res.accounts.find((a) => a.accountKey === "codex:chatgpt-work");
      expect(account?.accountId).toBe("work-account");
      expect(cache.database.query(
        "SELECT DISTINCT account_id FROM quota_snapshots WHERE provider='codex' AND account_key='codex:chatgpt-work'",
      ).all()).toEqual([{ account_id: "work-account" }]);
    } finally {
      cache.close();
    }
  });

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
      expect(account!.windows.map((w) => w.windowMinutes).sort((a, b) => a - b)).toEqual([300, 10_080, 43_200]);
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

  it("parses wham/usage windows and stores snapshots on the matching account key", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-db-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      let called = 0;
      const fetcher = (async (input: unknown) => {
        called++;
        const url = String(input);
        if (url.includes("wham/usage")) {
          return new Response(JSON.stringify(USAGE_BODY), { status: 200 });
        }
        if (url.includes("rate-limit-reset-credits")) {
          return new Response(JSON.stringify({ credits: [], available_count: 0 }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;

      // Hermetic pi auth store (other tests poison HOME).
      const piAuth = path.join(dir, "pi-auth.json");
      writeFileSync(
        piAuth,
        JSON.stringify({
          openrouter: { type: "api_key", key: "sk-or-v1-hermetic" },
          "opencode-go": { type: "api_key", key: "sk-MDe8-hermetic" },
        }),
      );
      const res = await pollQuotas({ authPath: fixtureAuth(), piAuthPath: piAuth, fetcher, cache, ...hermeticPaths() });
      expect(called).toBe(4); // codex usage + reset credits + gateway probes
      expect(res.ok).toBe(true);
      const acc = res.accounts[0]!;
      // scan-era key shape: <model_provider>:<plan_type>
      expect(acc.accountKey).toBe("openai:plus");
      expect(acc.email).toBe("user@example.com");
      expect(acc.windows.map((w) => w.windowMinutes).sort((a, b) => a - b)).toEqual([300, 10_080]);
      expect(acc.inserted).toBe(2);

      const rows = cache.database
        .query("SELECT account_key, window_minutes, used_pct FROM quota_snapshots ORDER BY window_minutes")
        .all() as Array<{ account_key: string; window_minutes: number; used_pct: number }>;
      expect(rows.map((r) => [r.account_key, r.window_minutes])).toEqual([
        ["openai:plus", 300],
        ["openai:plus", 10_080],
      ]);
      expect(rows.every((r) => r.account_key === "openai:plus")).toBe(true);
    } finally {
      cache.close();
    }
  });

  it("refreshes the token once on 401 and retries", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-r-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      const calls: string[] = [];
      const fetcher = (async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.includes("oauth/token")) {
          return new Response(JSON.stringify({ access_token: "at-refreshed" }), { status: 200 });
        }
        // first usage call uses the stale token → 401; retry succeeds
        const auth = String((init?.headers as Record<string, string>)?.authorization ?? "");
        const stale = auth.includes("at-test");
        return new Response(stale ? "{}" : JSON.stringify(USAGE_BODY), { status: stale ? 401 : 200 });
      }) as unknown as typeof fetch;

      const res = await pollQuotas({ authPath: fixtureAuth(), fetcher, cache, ...hermeticPaths() });
      expect(res.ok).toBe(true);
      expect(calls.filter((u) => u.includes("oauth/token")).length).toBe(1);
      expect(res.accounts[0]!.windows.length).toBe(2);
    } finally {
      cache.close();
    }
  });

  it("persists banked Codex reset credits from live wham polling", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-credits-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      const body = JSON.parse(JSON.stringify(USAGE_BODY)) as typeof USAGE_BODY;
      (body.rate_limit as typeof body.rate_limit & { credits: Record<string, unknown> }).credits = {
        has_credits: true,
        unlimited: false,
        balance: "1",
        expires_at: 1_800_000_000,
      };
      const fetcher = (async (input: unknown) => {
        if (String(input).includes("wham/usage")) return new Response(JSON.stringify(body), { status: 200 });
        if (String(input).includes("rate-limit-reset-credits")) {
          return new Response(JSON.stringify({
            credits: [{ status: "available", expires_at: "2026-08-30T12:00:00Z" }],
            available_count: 1,
          }), { status: 200 });
        }
        throw new Error(`unexpected fetch: ${String(input)}`);
      }) as unknown as typeof fetch;
      const result = await pollQuotas({ authPath: fixtureAuth(), fetcher, cache, ...hermeticPaths() });
      expect(result.accounts[0]!.credits).toEqual({
        hasCredits: true,
        unlimited: false,
        balance: "1",
        expiresAt: new Date(1_800_000_000 * 1000).toISOString(),
      });
      const row = cache.database.query("SELECT credits_json AS creditsJson FROM quota_snapshots WHERE provider = 'codex' LIMIT 1").get() as { creditsJson: string | null };
      expect(JSON.parse(row.creditsJson!)).toMatchObject({ hasCredits: true, balance: "1" });
    } finally {
      cache.close();
    }
  });

  it("surfaces HTTP errors instead of throwing", async () => {
    const fetcher = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await pollQuotas({ authPath: fixtureAuth(), fetcher, ...hermeticPaths() });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("500");
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

  it("merges opencodex pooled quotas when codex yields nothing fresh", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-pool-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      const ocCache = path.join(dir, "codex-quota-cache.json");
      writeFileSync(
        ocCache,
        JSON.stringify({
          quotas: {
            __main__: {
              weeklyPercent: 41,
              weeklyResetAt: 1_800_000_000,
              shortPercent: 12,
              shortResetAt: 1_800_001_000,
              shortWindowSeconds: 18_000,
            },
            "chatgpt-abc": { weeklyPercent: 41, weeklyResetAt: 1_800_000_000 }, // same window → collapses
          },
        }),
      );
      const fetcher = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
      const res = await pollQuotas({
        ...hermeticPaths(),
        authPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
        piAuthPath: path.join(os.tmpdir(), `missing-pi-${Date.now()}.json`),
        opencodexCachePath: ocCache,
        fetcher,
        cache,
      });
      const codexRows = cache.database
        .query("SELECT window_minutes, used_pct, resets_at FROM quota_snapshots WHERE provider='codex' AND account_key='codex'")
        .all() as Array<{ window_minutes: number; used_pct: number; resets_at: number }>;
      expect(codexRows).toHaveLength(2);
      expect(codexRows.find((row) => row.window_minutes === 10_080)?.used_pct).toBeCloseTo(41);
      const windows = res.accounts.find((a) => a.accountKey === "codex")?.windows ?? [];
      expect(windows.map((window) => window.windowMinutes)).toEqual([18_000 / 60, 10_080]);
      void res;
    } finally {
      cache.close();
    }
  });

  it("polls pooled Codex OAuth accounts directly so 5-hour and weekly stay distinct", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-pool-live-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      const ocCache = path.join(dir, "codex-quota-cache.json");
      const ocAccounts = path.join(dir, "codex-accounts.json");
      writeFileSync(ocCache, JSON.stringify({ quotas: {
        "chatgpt-work": { weeklyPercent: 23, weeklyResetAt: 1_800_000_000, shortPercent: 65, shortResetAt: 1_800_000_001, shortWindowSeconds: 18_000 },
      }}));
      writeFileSync(ocAccounts, JSON.stringify({ "chatgpt-work": {
        credential: { accessToken: "at-work", refreshToken: "rt-work", chatgptAccountId: "work-id", email: "work@example.com" },
      }}));
      const fetcher = (async (input: unknown) => {
        const url = String(input);
        if (url.includes("rate-limit-reset-credits")) {
          return new Response(JSON.stringify({ available_count: 0, credits: [] }), { status: 200 });
        }
        return new Response(JSON.stringify({
          plan_type: "plus",
          email: "work@example.com",
          rate_limit: {
            primary_window: { used_percent: 65, reset_at: 1_800_000_100, limit_window_seconds: 18_000 },
            secondary_window: { used_percent: 10, reset_at: 1_800_604_900, limit_window_seconds: 604_800 },
          },
        }), { status: 200 });
      }) as unknown as typeof fetch;
      const result = await pollQuotas({
        ...hermeticPaths(),
        providers: ["codex"],
        authPath: path.join(dir, "missing-auth.json"),
        opencodexCachePath: ocCache,
        opencodexAccountsPath: ocAccounts,
        fetcher,
        cache,
      });
      const account = result.accounts.find((candidate) => candidate.accountKey === "codex:chatgpt-work");
      expect(account?.windows.map((window) => [window.windowMinutes, window.usedPct])).toEqual([
        [300, 65],
        [10_080, 10],
      ]);
      expect(account?.email).toBe("work@example.com");
      expect(account?.harnesses).toEqual(["opencodex"]);
    } finally {
      cache.close();
    }
  });

  it("keeps two pooled Codex accounts even when their reset epochs match", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-poll-pool-same-reset-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    try {
      const ocCache = path.join(dir, "codex-quota-cache.json");
      const ocAccounts = path.join(dir, "codex-accounts.json");
      writeFileSync(ocCache, JSON.stringify({ quotas: {
        "chatgpt-personal": { weeklyPercent: 0, weeklyResetAt: 1_800_000_000 },
        "chatgpt-work": { weeklyPercent: 44, weeklyResetAt: 1_800_000_000 },
      }}));
      writeFileSync(ocAccounts, JSON.stringify({
        "chatgpt-personal": { credential: { chatgptAccountId: "personal-id", email: "personal@example.com" } },
        "chatgpt-work": { credential: { chatgptAccountId: "work-id", email: "work@example.com" } },
      }));
      const fetcher = (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;
      const result = await pollQuotas({
        ...hermeticPaths(),
        authPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`),
        piAuthPath: path.join(os.tmpdir(), `missing-pi-${Date.now()}.json`),
        opencodexCachePath: ocCache,
        opencodexAccountsPath: ocAccounts,
        fetcher,
        cache,
      });
      const pooled = result.accounts.filter((a) => a.accountKey.startsWith("codex:"));
      expect(pooled.map((a) => a.accountKey).sort()).toEqual(["codex:chatgpt-personal", "codex:chatgpt-work"]);
      expect(pooled.map((a) => a.accountId).sort()).toEqual(["personal-id", "work-id"]);
    } finally {
      cache.close();
    }
  });
});
