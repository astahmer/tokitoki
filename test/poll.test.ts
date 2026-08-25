import { describe, expect, it } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { EventCache } from "../src/cache.ts";
import {
  opencodeCredentials,
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
  it("reports not-logged-in when auth store is missing", async () => {
    const res = await pollQuotas({ authPath: path.join(os.tmpdir(), `missing-${Date.now()}.json`) });
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
        throw new Error(`unexpected fetch: ${url}`);
      }) as unknown as typeof fetch;

      const res = await pollQuotas({ authPath: fixtureAuth(), fetcher, cache });
      expect(called).toBe(1); // no refresh round-trip on success
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

      const res = await pollQuotas({ authPath: fixtureAuth(), fetcher, cache });
      expect(res.ok).toBe(true);
      expect(calls.filter((u) => u.includes("oauth/token")).length).toBe(1);
      expect(res.accounts[0]!.windows.length).toBe(2);
    } finally {
      cache.close();
    }
  });

  it("surfaces HTTP errors instead of throwing", async () => {
    const fetcher = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const res = await pollQuotas({ authPath: fixtureAuth(), fetcher });
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("500");
  });
});
