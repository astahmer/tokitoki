import { describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { buildAccountLimits, limitsDocument, LimitsDocumentSchema } from "../src/limits-document.ts";
import type { AccountLimits } from "../src/limits.ts";
import { hermeticPoll } from "./support/quota-poll.ts";

const now = new Date("2026-10-24T12:00:00Z");
const fixture = () => {
  const context = hermeticPoll({ providers: ["codex"] });
  const previousHome = process.env.HOME;
  const previousCodexHome = process.env.CODEX_HOME;
  process.env.HOME = context.dir;
  process.env.CODEX_HOME = path.join(context.dir, "codex");
  mkdirSync(process.env.CODEX_HOME);
  const payload = Buffer.from(JSON.stringify({ email: "local@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "local" } })).toString("base64url");
  writeFileSync(path.join(process.env.CODEX_HOME, "auth.json"), JSON.stringify({ tokens: { id_token: `header.${payload}.signature`, account_id: "local" } }));
  return {
    ...context,
    close: () => {
      context.cache.close();
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodexHome;
    },
  };
};

describe("limits builder provenance", () => {
  it("preserves independent aliases through partial updates and accepts newer partials at a complete bucket's timestamp", () => {
    const context = fixture();
    try {
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "openai:local", accountId: "local", capturedAtIso: new Date(now.getTime() - 60_000).toISOString(), eventId: "poll:full", windows: [
        { windowMinutes: 300, usedPct: 10, resetsAtEpoch: 0, bucketId: "codex", windowId: "primary" },
        { windowMinutes: 10080, usedPct: 20, resetsAtEpoch: 0, bucketId: "codex", windowId: "secondary" },
        { windowMinutes: 10080, usedPct: 30, resetsAtEpoch: 0, bucketId: "review", windowId: "primary" },
      ] });
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:local", accountId: "local", capturedAtIso: now.toISOString(), eventId: "scan:bucket", bucketId: "codex", windows: [
        { windowMinutes: 300, usedPct: 40, resetsAtEpoch: 0, bucketId: "codex", windowId: "primary" },
        { windowMinutes: 10080, usedPct: 50, resetsAtEpoch: 0, bucketId: "codex", windowId: "secondary" },
      ] });
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "openai:local", accountId: "local", capturedAtIso: now.toISOString(), eventId: "scan:partial", complete: false, windows: [
        { windowMinutes: 300, usedPct: 60, resetsAtEpoch: 0, bucketId: "codex", windowId: "primary" },
      ] });
      const cards = buildAccountLimits({ cache: context.cache, config: { experimental: { zeroStateCards: false } }, now });
      const local = cards.filter((card) => card.accountId === "local");
      expect(local).toHaveLength(1);
      expect(local[0]?.windows.map((window) => [window.bucketId, window.windowId, window.usedPct]).sort()).toEqual([
        ["codex", "primary", 60], ["codex", "secondary", 50], ["review", "primary", 30],
      ]);
    } finally { context.close(); }
  });

  it("retains independent slots across aliases with only partial observations", () => {
    const context = fixture();
    try {
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:local", accountId: "local", capturedAtIso: new Date(now.getTime() - 60_000).toISOString(), eventId: "scan:primary", complete: false, windows: [
        { windowMinutes: 300, usedPct: 10, resetsAtEpoch: 0, bucketId: "codex", windowId: "primary" },
      ] });
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "openai:local", accountId: "local", capturedAtIso: now.toISOString(), eventId: "scan:secondary", complete: false, windows: [
        { windowMinutes: 10080, usedPct: 20, resetsAtEpoch: 0, bucketId: "codex", windowId: "secondary" },
      ] });
      const cards = buildAccountLimits({ cache: context.cache, config: { experimental: { zeroStateCards: false } }, now });
      expect(cards.filter((card) => card.accountId === "local")).toHaveLength(1);
      expect(cards.find((card) => card.accountId === "local")?.windows).toHaveLength(2);
    } finally { context.close(); }
  });

  it("collapses proven scanner and legacy aliases onto the latest live topology and retains budgets", () => {
    const context = fixture();
    try {
      for (const accountKey of ["account:local", "openai:plus"]) {
        context.cache.insertPolledSnapshots({ provider: "codex", accountKey, accountId: "local", capturedAtIso: new Date(now.getTime() - 60_000).toISOString(), eventId: `scan:${accountKey}`,
          windows: [{ windowMinutes: 300, usedPct: 25, resetsAtEpoch: 0, bucketId: "codex", windowId: "primary" }, { windowMinutes: 10080, usedPct: 30, resetsAtEpoch: 0, bucketId: "codex", windowId: "secondary" }] });
      }
      context.cache.insert([{ id: "local-usage", ts: now.toISOString(), provider: "codex", accountKey: "account:local", machineId: "test", model: "gpt-5", inputTokens: 100, outputTokens: 10, costUsd: 1 }]);
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "openai:local", accountId: "local", capturedAtIso: now.toISOString(), eventId: "poll:monthly",
        windows: [{ windowMinutes: 43200, usedPct: 40, resetsAtEpoch: 0, bucketId: "codex", windowId: "primary" }] });
      const cards = buildAccountLimits({ cache: context.cache, config: { experimental: { zeroStateCards: false } }, now });
      const local = cards.filter((card) => card.provider === "codex" && card.accountId === "local");
      expect(local).toHaveLength(1);
      expect(local[0]?.accountKey).toBe("openai:local");
      expect(local[0]?.windows.map((window) => window.windowMinutes)).toEqual([43200]);
      expect(local[0]?.budgetWindows?.find((window) => window.kind === "day")?.tokens).toBe(110);
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "openai:local", accountId: "local", capturedAtIso: new Date(now.getTime() + 1000).toISOString(), eventId: "poll:empty", windows: [] });
      const empty = buildAccountLimits({ cache: context.cache, config: { experimental: { zeroStateCards: false } }, now });
      expect(empty.filter((card) => card.provider === "codex" && card.accountId === "local")).toHaveLength(1);
      expect(empty.find((card) => card.accountKey === "openai:local")?.windows).toEqual([]);
      expect(empty.find((card) => card.accountKey === "openai:local")?.budgetWindows?.find((window) => window.kind === "day")?.tokens).toBe(110);
    } finally { context.close(); }
  });

  it("includes a stable scan-only local account and binds email using cached account proof", () => {
    const context = fixture();
    try {
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:local", accountId: "local", capturedAtIso: now.toISOString(), eventId: "scan:local",
        windows: [{ windowMinutes: 300, usedPct: 25, resetsAtEpoch: 0, bucketId: "codex", windowId: "primary" }] });
      const cards = buildAccountLimits({ cache: context.cache, config: { experimental: { zeroStateCards: false } }, now });
      expect(cards.find((card) => card.accountKey === "openai:local")).toMatchObject({ email: "local@example.com", accountId: "local", origin: "scan", freshness: "fresh" });
      expect(cards.find((card) => card.accountKey === "openai:local")?.windows[0]).toMatchObject({ status: "current", usedPct: 25 });
    } finally { context.close(); }
  });

  it("quarantines unidentified keys and leaves historical generic identity unverified", () => {
    const context = fixture();
    try {
      for (const accountKey of ["unidentified:old-session", "codex"]) {
        context.cache.insertPolledSnapshots({ provider: "codex", accountKey, capturedAtIso: now.toISOString(), eventId: `scan:${accountKey}`,
          windows: [{ windowMinutes: 300, usedPct: 25, resetsAtEpoch: 0 }] });
      }
      const cards = buildAccountLimits({ cache: context.cache, config: { experimental: { zeroStateCards: false } }, now });
      expect(cards.some((card) => card.accountKey.startsWith("unidentified:"))).toBe(false);
      const historical = cards.find((card) => card.accountKey === "codex");
      expect(historical?.email).toBeUndefined();
      expect(historical?.windows[0]?.status).toBe("unknown");
      expect(historical?.windows[0]?.usedPct).toBeUndefined();
    } finally { context.close(); }
  });

  it("applies configured poll TTL to quota-only accounts", () => {
    const context = fixture();
    try {
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:local", accountId: "local", capturedAtIso: new Date(now.getTime() - 45 * 60_000).toISOString(), eventId: "poll:local",
        windows: [{ windowMinutes: 300, usedPct: 25, resetsAtEpoch: 0 }] });
      const config = { poll: { intervalMinutes: 30 }, experimental: { zeroStateCards: false } };
      const current = buildAccountLimits({ cache: context.cache, config, now }).find((card) => card.accountKey === "openai:local");
      expect(current?.windows[0]?.status).toBe("current");
      const stale = buildAccountLimits({ cache: context.cache, config: { ...config, poll: { intervalMinutes: 5 } }, now }).find((card) => card.accountKey === "openai:local");
      expect(stale?.windows[0]?.status).toBe("stale");
      expect(stale?.windows[0]?.usedPct).toBeUndefined();
    } finally { context.close(); }
  });

  it("keeps a complete empty topology empty", () => {
    const context = fixture();
    try {
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:local", accountId: "local", capturedAtIso: new Date(now.getTime() - 1000).toISOString(), eventId: "poll:before",
        windows: [{ windowMinutes: 300, usedPct: 25, resetsAtEpoch: 0 }] });
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:local", accountId: "local", capturedAtIso: now.toISOString(), eventId: "poll:empty", windows: [] });
      const cards = buildAccountLimits({ cache: context.cache, config: { experimental: { zeroStateCards: false } }, now });
      expect(cards.find((card) => card.accountKey === "openai:local")?.windows).toEqual([]);
    } finally { context.close(); }
  });

  it("resolves a native home scan account by verified identity without using the current local email", () => {
    const context = fixture();
    try {
      const workHome = path.join(context.dir, "work-codex");
      mkdirSync(workHome);
      const payload = Buffer.from(JSON.stringify({ email: "work@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "work" } })).toString("base64url");
      writeFileSync(path.join(workHome, "auth.json"), JSON.stringify({ tokens: { id_token: `header.${payload}.signature`, account_id: "work" } }));
      context.cache.insertPolledSnapshots({ provider: "codex", accountKey: "account:work", accountId: "work", capturedAtIso: now.toISOString(), eventId: "scan:work",
        windows: [{ windowMinutes: 10080, usedPct: 25, resetsAtEpoch: 0 }] });
      const cards = buildAccountLimits({ cache: context.cache, config: { poll: { codexHomes: [workHome] }, experimental: { zeroStateCards: false } }, now });
      const work = cards.find((card) => card.accountKey === "openai:work");
      expect(work).toMatchObject({ email: "work@example.com", accountId: "work" });
      const document = LimitsDocumentSchema.parse(limitsDocument({ limits: cards, now, showEmail: true }));
      expect(document.accounts.find((account) => account.accountKey === "openai:work")).toMatchObject({ email: "work@example.com", accountId: "work" });
    } finally { context.close(); }
  });
});

describe("limits document window metadata", () => {
  it("separates budgets and preserves provenance while omitting non-current percentages", () => {
    const account: AccountLimits = { provider: "codex", accountKey: "account:local", windows: [
      { kind: "custom", source: "embedded", tokens: 0, cost: 0, requests: 0, status: "expired", usedPct: 10, observedAt: now.toISOString(), bucketId: "codex", windowId: "primary", windowEnd: now.toISOString() },
    ], budgetWindows: [{ kind: "day", source: "derived", tokens: 12, cost: 1, requests: 1, usedPct: 50 }] };
    const document = LimitsDocumentSchema.parse(limitsDocument({ limits: [account], now }));
    expect(document.accounts[0]?.windows[0]).toMatchObject({ status: "expired", scope: "other", observedAt: now.toISOString(), bucketId: "codex", windowId: "primary", windowEnd: now.toISOString() });
    expect(document.accounts[0]?.windows[0]?.usedPercent).toBeUndefined();
    expect(document.accounts[0]?.budgetWindows?.[0]).toMatchObject({ scope: "daily", source: "derived", usedPercent: 50 });
  });
});
