import { describe, expect, it } from "bun:test";

import type { TokitokiConfig } from "../src/config.ts";
import { LimitsDocumentSchema, buildAccountLimits, limitsDocument } from "../src/limits-document.ts";
import type { AccountLimits } from "../src/limits.ts";
import { pollQuotas } from "../src/poll.ts";
import { hermeticPoll, json, readFixture, routeFetcher } from "./support/quota-poll.ts";

const now = new Date("2026-10-18T12:00:00.000Z");

const claude: AccountLimits = {
  provider: "claude-code",
  accountKey: "default",
  email: "me@example.com",
  plan: "Max 20x",
  extraUsage: { enabled: true, usedUsd: 12, limitUsd: 50, usedPercent: 24 },
  origin: "polled",
  freshness: "fresh",
  windows: [
    {
      kind: "day",
      source: "embedded",
      tokens: 1000,
      cost: 1.23456,
      requests: 4,
      usedPct: 40,
      resetsAt: "2026-10-18T14:00:00.000Z",
      id: "session",
      label: "Session",
      scope: "session",
      usedPercent: 40,
      windowMinutes: 300,
      pace: { expectedPercent: 60, deltaPercent: -20, status: "under" },
    },
  ],
};

const piGateway: AccountLimits = {
  provider: "pi",
  accountKey: "openrouter",
  alsoOn: ["opencode"],
  windows: [{ kind: "month", source: "derived", tokens: 5, cost: 0.5, requests: 1 }],
};

const codex: AccountLimits = {
  provider: "codex",
  accountKey: "openai:plus",
  planLabel: "Plus",
  windows: [],
};

describe("limitsDocument", () => {
  it("hides account emails unless explicitly requested", () => {
    const hidden = limitsDocument({ limits: [claude], now });
    expect(hidden.accounts[0]?.email).toBeUndefined();
    const shown = limitsDocument({ limits: [claude], now, showEmail: true });
    expect(shown.accounts[0]?.email).toBe("me@example.com");
  });

  it("projects card limits onto the versioned vendor → account → plan → windows schema", () => {
    const document = LimitsDocumentSchema.parse(limitsDocument({ limits: [piGateway, codex, claude], now }));
    expect(document.version).toBe(1);
    expect(document.generatedAt).toBe(now.toISOString());
    expect(document.accounts.map((account) => [account.vendor, account.harness])).toEqual([
      ["anthropic", "claude-code"],
      ["openai", "codex"],
      ["openrouter", "pi"],
    ]);
    const [anthropic, openai, openrouter] = document.accounts;
    expect(anthropic).toMatchObject({ id: "claude-code@default", plan: "Max 20x", extraUsage: { usedUsd: 12 } });
    expect(anthropic!.windows[0]).toEqual({
      id: "session",
      label: "Session",
      scope: "session",
      source: "provider",
      usedPercent: 40,
      windowMinutes: 300,
      resetsAt: "2026-10-18T14:00:00.000Z",
      pace: { expectedPercent: 60, deltaPercent: -20, status: "under" },
      tokens: 1000,
      costUsd: 1.2346,
      requests: 4,
    });
    expect(openai!.plan).toBe("Plus");
    expect(openrouter!.alsoOn).toEqual(["opencode"]);
    expect(openrouter!.windows[0]).toMatchObject({ id: "month", label: "This month", scope: "monthly", source: "derived", usedPercent: null });
  });
});

describe("buildAccountLimits", () => {
  it("keeps single-account provider keys out of gateway cards and includes balance-only accounts", async () => {
    const { cache, options } = hermeticPoll({ providers: ["deepseek"], env: { DEEPSEEK_KEY: "sk-ds" } });
    const { fetcher } = routeFetcher({ "api.deepseek.com/user/balance": () => json(readFixture("deepseek", "balance.json")) });
    try {
      await pollQuotas({ ...options, fetcher });
      const config: TokitokiConfig = {
        poll: {
          extraKeys: [
            { id: "zai-main", provider: "zai", key: "zai-secret" },
            { id: "kimi-main", provider: "kimi", key: "kimi-secret" },
            { id: "deepseek-main", provider: "deepseek", key: "sk-ds" },
            { id: "go-work", label: "Work", key: "sk-go-secret" },
          ],
        },
      };
      const cards = buildAccountLimits({ cache, config, now });
      const keys = cards.map((card) => `${card.provider}@${card.accountKey}`);
      expect(keys).not.toContain("opencode@zai-main");
      expect(keys).not.toContain("opencode@kimi-main");
      expect(keys).not.toContain("opencode@deepseek-main");
      expect(cards.find((card) => card.accountKey === "go-work")).toMatchObject({ provider: "opencode", origin: "manual", label: "Work" });

      const document = limitsDocument({ limits: cards, now });
      expect(document.accounts.find((account) => account.id === "deepseek@default")).toMatchObject({
        vendor: "deepseek",
        balance: { currency: "USD", remaining: 12.5 },
      });
      expect(document.accounts.find((account) => account.id === "opencode@go-work")?.vendor).toBe("opencode");
    } finally {
      cache.close();
    }
  });
});
