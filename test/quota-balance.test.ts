import { describe, expect, it } from "bun:test";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { appendBalanceOnlyAccounts, computeLimits } from "../src/limits.ts";
import { pollQuotas } from "../src/poll.ts";
import { parseDeepSeekBalance } from "../src/quota/deepseek.ts";
import { parseOpenRouterCredits } from "../src/quota/openrouter-credits.ts";
import { hermeticPoll, json, readFixture, routeFetcher } from "./support/quota-poll.ts";

describe("balance parsing", () => {
  it("prefers the USD DeepSeek balance", () => {
    expect(parseDeepSeekBalance(readFixture("deepseek", "balance.json"))).toEqual({
      currency: "USD",
      remaining: 12.5,
      granted: 2.5,
      paid: 10,
      available: true,
    });
    expect(parseDeepSeekBalance({ is_available: false, balance_infos: [{ currency: "cny", total_balance: "3.20" }] })).toEqual({
      currency: "CNY",
      remaining: 3.2,
      available: false,
    });
    expect(parseDeepSeekBalance({ balance_infos: [{ currency: "USD", total_balance: "n/a" }] })).toBeUndefined();
  });

  it("derives the OpenRouter remaining credit", () => {
    expect(parseOpenRouterCredits(readFixture("openrouter", "credits.json"))).toEqual({ currency: "USD", remaining: 17.875, total: 25, used: 7.125 });
    expect(parseOpenRouterCredits({ data: {} })).toBeUndefined();
  });
});

describe("balance-only accounts", () => {
  it("polls DeepSeek as a balance-only card", async () => {
    const { cache, options } = hermeticPoll({ providers: ["deepseek"], env: { DEEPSEEK_KEY: "sk-ds" } });
    const { fetcher, requests } = routeFetcher({ "api.deepseek.com/user/balance": () => json(readFixture("deepseek", "balance.json")) });
    try {
      const result = await pollQuotas({ ...options, fetcher });
      expect(requests[0]?.headers.authorization).toBe("Bearer sk-ds");
      expect(result.ok).toBe(true);
      expect(result.accounts[0]).toMatchObject({ accountKey: "default", windows: [], balance: { currency: "USD", remaining: 12.5 } });

      const cards = appendBalanceOnlyAccounts({ limits: computeLimits(cache, {}), cache });
      expect(cards.find((card) => card.provider === "deepseek")).toMatchObject({
        accountKey: "default",
        origin: "polled",
        windows: [],
        balance: { currency: "USD", remaining: 12.5, granted: 2.5, paid: 10, available: true },
      });
    } finally {
      cache.close();
    }
  });

  it("skips DeepSeek silently without a key, and flags a rejected key", async () => {
    const { cache, options } = hermeticPoll({ providers: ["deepseek"] });
    const { fetcher, requests } = routeFetcher({ "api.deepseek.com": () => json({}, { status: 401 }) });
    try {
      const absent = await pollQuotas({ ...options, fetcher });
      expect(requests).toHaveLength(0);
      expect(absent.providerAuthStates).toBeUndefined();
      const rejected = await pollQuotas({ ...options, providerKeys: { deepseek: "sk-bad" }, fetcher });
      expect(rejected.providerAuthStates).toEqual({ deepseek: "api-key-required" });
    } finally {
      cache.close();
    }
  });

  it("turns an OpenRouter key without a limit into a balance card instead of a skip", async () => {
    const { dir, cache, options } = hermeticPoll({ providers: ["openrouter"] });
    const piAuthPath = path.join(dir, "pi-auth.json");
    writeFileSync(piAuthPath, JSON.stringify({ openrouter: { type: "api_key", key: "sk-or-v1-pi" } }));
    const { fetcher } = routeFetcher({
      "openrouter.ai/api/v1/key": () => json({ data: { limit: null, limit_remaining: null } }),
      "openrouter.ai/api/v1/credits": () => json(readFixture("openrouter", "credits.json")),
    });
    try {
      const result = await pollQuotas({
        ...options,
        piAuthPath,
        manualKeys: [{ id: "work-router", provider: "openrouter", key: "sk-or-v1-work" }],
        fetcher,
      });
      expect(result.ok).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(result.accounts.map((account) => [account.accountKey, account.balance?.remaining])).toEqual([
        ["openrouter", 17.875],
        ["work-router", 17.875],
      ]);
      const cards = appendBalanceOnlyAccounts({ limits: [], cache });
      expect(cards.map((card) => `${card.provider}@${card.accountKey}`)).toEqual(["pi@openrouter", "openrouter@work-router"]);
    } finally {
      cache.close();
    }
  });
});
