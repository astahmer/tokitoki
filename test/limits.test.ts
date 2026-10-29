import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "bun:test";

import { EventCache } from "../src/cache.ts";
import type { UsageEvent } from "../src/types.ts";
import {
  collapseHarnessVariants,
  computeLimits,
  dedupeAccountLimits,
  groupBySharedCredential,
  mergeAliasLimits,
  nextLocalMidnight,
  nextMonthStart,
  nextWeekStart,
} from "../src/limits.ts";
import { isVisibleOn, parseToggleTarget, setSurfaceVisibility } from "../src/uiToggles.ts";

function makeEvent(overrides: Partial<UsageEvent> & Pick<UsageEvent, "id">): UsageEvent {
  return {
    ts: "2026-08-23T09:00:00.000Z",
    machineId: "mac-one",
    provider: "codex",
    accountKey: "openai:plus",
    model: "gpt-5.6-luna",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.01,
    ...overrides,
  };
}

// ---------------------------------------------------------------- reset math

describe("shared credential cards", () => {
  it("collapses pi and opencode mirrors into one card", () => {
    const windows = [{ kind: "week", source: "derived" as const, tokens: 10, cost: 1, requests: 1 }];
    const result = groupBySharedCredential([
      { provider: "pi", accountKey: "opencode-go", credential: "sk-a…z", windows },
      { provider: "opencode", accountKey: "opencode-go", credential: "sk-a…z", windows: [{ ...windows[0]!, tokens: 20 }] },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]?.provider).toBe("opencode");
    expect(result[0]?.alsoOn).toEqual(["pi"]);
    expect(result[0]?.windows[0]?.tokens).toBe(30);
  });
});

describe("default harness card projection", () => {
  it("collapses equivalent upstream account keys across harnesses", () => {
    const window = (tokens: number) => ({ kind: "week", source: "derived" as const, tokens, cost: 0, requests: 1 });
    const result = collapseHarnessVariants([
      { provider: "pi", accountKey: "opencode-go-api-key-1", windows: [window(10)] },
      { provider: "opencode", accountKey: "opencode-go-api-key-1", windows: [window(20)] },
      { provider: "codex", accountKey: "opencode-go-api-key-1", windows: [window(30)] },
      { provider: "codex", accountKey: "openai-acc-1", windows: [window(40)] },
      { provider: "t3code", accountKey: "openai-acc-1", windows: [window(50)] },
    ]);

    expect(result).toHaveLength(2);
    expect(result.find((limit) => limit.accountKey === "opencode-go-api-key-1")?.windows[0]?.tokens).toBe(60);
    expect(result.find((limit) => limit.accountKey === "opencode-go-api-key-1")?.alsoOn).toEqual(["pi", "codex"]);
    expect(result.find((limit) => limit.accountKey === "openai-acc-1")?.windows[0]?.tokens).toBe(90);
    expect(result.find((limit) => limit.accountKey === "openai-acc-1")?.alsoOn).toEqual(["t3code"]);
  });

  it("does not merge distinct stable account ids", () => {
    const windows = [{ kind: "week", source: "embedded" as const, tokens: 1, cost: 0, requests: 1 }];
    const result = collapseHarnessVariants([
      { provider: "codex", accountKey: "openai-acc-1", accountId: "account-a", windows },
      { provider: "t3code", accountKey: "openai-acc-1", accountId: "account-b", windows },
    ]);

    expect(result).toHaveLength(2);
  });

  it("does not merge unrelated providers that happen to share an account key", () => {
    const windows = [{ kind: "week", source: "derived" as const, tokens: 1, cost: 0, requests: 1 }];
    const result = collapseHarnessVariants([
      { provider: "claude-code", accountKey: "openai-acc-1", windows },
      { provider: "codex", accountKey: "openai-acc-1", windows },
    ]);

    expect(result).toHaveLength(2);
  });
});

describe("reset schedule math", () => {
  it("next local midnight is tomorrow 00:00 local", () => {
    const now = new Date(2026, 7, 24, 15, 30); // Aug 24 15:30 local
    const next = nextLocalMidnight(now);
    expect(next.getDate()).toBe(25);
    expect(next.getHours()).toBe(0);
    expect(next.getMinutes()).toBe(0);
  });

  it("next week start is a Monday midnight (Sunday evening → tomorrow)", () => {
    // 2026-08-23 is a Sunday.
    const sunday = new Date(2026, 7, 23, 20, 0);
    const next = nextWeekStart(sunday);
    expect(next.getDay()).toBe(1); // Monday
    expect(next.getDate()).toBe(24);
    expect(next.getHours()).toBe(0);

    // Monday itself rolls to the NEXT Monday.
    const mondayNight = new Date(2026, 7, 24, 21, 0);
    const following = nextWeekStart(mondayNight);
    expect(following.getDay()).toBe(1);
    expect(following.getDate()).toBe(31);
  });

  it("next month start is the 1st at midnight", () => {
    const mid = new Date(2026, 7, 24, 12, 0);
    const next = nextMonthStart(mid);
    expect(next.getMonth()).toBe(8); // September
    expect(next.getDate()).toBe(1);
    expect(next.getHours()).toBe(0);
  });

  it("crosses DST fall-back without drifting off local midnight", () => {
    // Europe/Paris DST ends 2026-10-25 (03:00→02:00). The night of Oct 24→25
    // is 25h long; the next-midnight after Oct 24 must still read Oct 25 00:00
    // local, and after Oct 25 must read Oct 26 00:00 (a normal 24h day).
    const before = new Date(2026, 9, 24, 12, 0);
    const n1 = nextLocalMidnight(before);
    expect([n1.getDate(), n1.getMonth(), n1.getHours()]).toEqual([25, 9, 0]);
    const n2 = nextLocalMidnight(n1);
    expect([n2.getDate(), n2.getMonth(), n2.getHours()]).toEqual([26, 9, 0]);
    const spanH = (n2.getTime() - n1.getTime()) / 3600_000;
    expect(spanH === 23 || spanH === 24 || spanH === 25).toBe(true); // tz-dependent but always whole hours
    // Week/month boundaries stay at local midnight too.
    expect(nextWeekStart(new Date(2026, 9, 24, 18, 0)).getHours()).toBe(0);
    expect(nextMonthStart(new Date(2026, 9, 24, 18, 0)).getHours()).toBe(0);
  });
});

// ------------------------------------------------------------- limits engine

function limitsCache(): EventCache {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tk-limits-"));
  return new EventCache(path.join(dir, "cache.db"));
}

describe("computeLimits", () => {
  it("never merges distinct stable Codex accounts with identical quota windows", () => {
    const reset = new Date("2026-08-31T12:00:00.000Z").toISOString();
    const base = {
      provider: "codex",
      windows: [{ kind: "week", source: "embedded" as const, tokens: 0, cost: 0, requests: 0, usedPct: 40, resetsAt: reset }],
    };
    const limits = mergeAliasLimits([
      { ...base, accountKey: "openai:plus", accountId: "personal-account", email: "personal@example.com" },
      { ...base, accountKey: "codex:work", accountId: "work-account", email: "work@example.com" },
    ]);

    expect(limits).toHaveLength(2);
    expect(limits.map((l) => l.email).sort()).toEqual(["personal@example.com", "work@example.com"]);
  });

  it("dedupes repeated Copilot account identities without dropping metadata", () => {
    const limits = dedupeAccountLimits([
      {
        provider: "copilot",
        accountKey: "default",
        email: "github@example.com",
        label: "Work account",
        windows: [{ kind: "month", source: "derived", tokens: 1, cost: 0, requests: 1 }],
      },
      {
        provider: "copilot",
        accountKey: "default",
        windows: [{ kind: "month", source: "embedded", tokens: 2, cost: 0, requests: 2, usedPct: 40 }],
        origin: "polled",
      },
    ]);
    expect(limits).toHaveLength(1);
    expect(limits[0]?.email).toBe("github@example.com");
    expect(limits[0]?.label).toBe("Work account");
    expect(limits[0]?.origin).toBe("polled");
    expect(limits[0]?.windows[0]?.source).toBe("embedded");
    expect(limits[0]?.windows[0]?.usedPct).toBe(40);
  });

  it("attributes Codex email only to the matching stable account id", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-limits-identity-"));
    const oldCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = dir;
    const payload = Buffer.from(JSON.stringify({
      email: "personal@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "personal-account" },
    })).toString("base64url");
    writeFileSync(path.join(dir, "auth.json"), JSON.stringify({
      tokens: { id_token: `header.${payload}.signature` },
    }));
    const cache = limitsCache();
    try {
      const windows = [{ windowMinutes: 300, usedPct: 10, resetsAtEpoch: 1_800_000_000 }];
      cache.insertPolledSnapshots({
        provider: "codex",
        accountKey: "openai:plus",
        accountId: "personal-account",
        windows,
        capturedAtIso: "2026-08-27T10:00:00.000Z",
        eventId: "poll:personal",
      });
      cache.insertPolledSnapshots({
        provider: "codex",
        accountKey: "codex",
        accountId: "work-account",
        windows,
        capturedAtIso: "2026-08-27T10:01:00.000Z",
        eventId: "poll:work",
      });
      const limits = computeLimits(cache, {}, new Date(2026, 7, 27, 12, 0), [
        { provider: "codex", accountKey: "openai:plus" },
        { provider: "codex", accountKey: "codex" },
      ]);
      expect(limits.find((l) => l.accountKey === "openai:plus")?.email).toBe("personal@example.com");
      expect(limits.find((l) => l.accountKey === "codex")?.email).toBeUndefined();
    } finally {
      cache.close();
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
    }
  });

  it("derived windows sum per account and omit usedPct without plan caps", () => {
    const cache = limitsCache();
    try {
      cache.insert([
        makeEvent({ id: "1", ts: new Date(2026, 7, 24, 8, 0).toISOString() }),
        makeEvent({ id: "2", inputTokens: 200, ts: new Date(2026, 7, 24, 8, 30).toISOString() }),
      ]);
      const limits = computeLimits(cache, {}, new Date(2026, 7, 24, 12, 0));
      const codex = limits.find((l) => l.provider === "codex" && l.accountKey === "openai:plus");
      expect(codex).toBeDefined();
      const codexDef = codex!;
      expect(codexDef.windows).toEqual([]);
      const kinds = codexDef.budgetWindows?.map((w) => w.kind);
      expect(kinds).toEqual(["day", "week", "month"]);
      for (const w of codexDef.budgetWindows ?? []) {
        expect(w.source).toBe("derived");
        expect(w.usedPct).toBeUndefined(); // no caps configured
        expect(w.resetsAt).toBeDefined();
      }
      const day = codexDef.budgetWindows?.find((w) => w.kind === "day")!;
      expect(day.tokens).toBe(400);
      expect(day.requests).toBe(2);
      expect(day).toMatchObject({ id: "local:day", scope: "daily", label: "Today usage" });
    } finally {
      cache.close();
    }
  });

  it("keeps an expired quota unknown while preserving a fresh independent weekly meter", () => {
    const cache = limitsCache();
    try {
      const now = new Date("2026-09-10T12:00:00.000Z");
      cache.insertPolledSnapshots({
        provider: "codex",
        accountKey: "codex",
        accountId: "reported-account",
        windows: [
          // 5h session window: its reset instant is months in the past, so the
          // captured 100% used describes a window that no longer exists.
          { windowMinutes: 300, usedPct: 100, resetsAtEpoch: Math.round(Date.parse("2026-07-12T21:17:06.000Z") / 1000) },
          // Still-open weekly window: the provider-reported utilization stands.
          { windowMinutes: 10_080, usedPct: 10, resetsAtEpoch: Math.round(Date.parse("2026-09-14T10:47:05.000Z") / 1000) },
        ],
        capturedAtIso: "2026-09-10T11:55:00.000Z",
        eventId: "poll:stale",
      });
      const limits = computeLimits(cache, {}, now, [{ provider: "codex", accountKey: "codex" }]);
      const windows = limits[0]!.windows;
      const session = windows.find((w) => w.kind === "day")!;
      expect(session).toMatchObject({ status: "expired", observedAt: "2026-09-10T11:55:00.000Z", resetsAt: "2026-07-12T21:17:06.000Z" });
      expect(session.usedPct).toBeUndefined();
      expect(session.usedPercent).toBeUndefined();
      expect(session.pace).toBeUndefined();
      expect(windows.find((w) => w.kind === "week")).toMatchObject({ status: "current", usedPct: 10, usedPercent: 10 });
      expect(cache.latestQuotaSnapshots("codex", "codex").find((row) => row.windowMinutes === 300)?.usedPct).toBe(100);
    } finally {
      cache.close();
    }
  });

  it("keeps provider quota separate from local calendar usage of the same scope", () => {
    const cache = limitsCache();
    try {
      cache.insert([
        makeEvent({
          id: "q",
          accountKey: "account:reported-account",
          ts: "2026-08-24T11:00:00.000Z",
          quota: {
            accountId: "reported-account",
            primary: { usedPct: 42.5, windowMinutes: 10080, resetsAtEpoch: 1788160164 },
            credits: {
              hasCredits: true,
              unlimited: false,
              balance: "2",
              expiresAt: "2026-08-30T12:00:00.000Z",
            },
          },
        }),
      ]);
      const limits = computeLimits(cache, {}, new Date("2026-08-24T12:00:00.000Z"));
      const codex = limits.find((l) => l.provider === "codex")!;
      const week = codex.windows.find((w) => w.kind === "week")!;
      expect(week.source).toBe("embedded");
      expect(week.usedPct).toBeCloseTo(42.5);
      expect(week.resetsAt).toBe(new Date(1788160164 * 1000).toISOString());
      expect(codex.windows).toHaveLength(1);
      expect(codex.budgetWindows?.map((w) => w.kind)).toEqual(["day", "week", "month"]);
      expect(codex.budgetWindows?.every((w) => w.source === "derived" && w.usedPct === undefined)).toBe(true);
      // Monetary workspace credits do not imply available rate-limit resets.
      expect(codex.bankedResets).toBeUndefined();
      expect(codex.bankedExpiresAt).toBeUndefined();
    } finally {
      cache.close();
    }
  });

  it("keeps provider quota rows separate from local usage for every provider", () => {
    const cache = limitsCache();
    try {
      const now = new Date("2026-08-24T12:00:00.000Z");
      cache.insert(["cursor", "copilot", "grok"].map((provider) => makeEvent({ id: `usage:${provider}`, provider, accountKey: "default", ts: "2026-08-24T11:00:00.000Z" })));
      // Cursor: anniversary billing cycle (~31 days = 44640min, not exactly
      // 43200) split into three differently-labeled real buckets.
      cache.insertPolledSnapshots({
        provider: "cursor",
        accountKey: "default",
        windows: [
          { windowMinutes: 44640, usedPct: 38.5, resetsAtEpoch: 1790148296, label: "Cursor Models" },
          { windowMinutes: 44640, usedPct: 0, resetsAtEpoch: 1790148296, label: "Other Models" },
          { windowMinutes: 44640, usedPct: 11.6, resetsAtEpoch: 1790148296, label: "On-Demand", amountUsd: 34.77 },
        ],
        capturedAtIso: now.toISOString(),
        eventId: "poll:test:cursor",
      });
      // Copilot: one provider monthly meter, no separate day/week quota.
      cache.insertPolledSnapshots({
        provider: "copilot",
        accountKey: "default",
        windows: [{ windowMinutes: 43200, usedPct: 55, resetsAtEpoch: 1790148296 }],
        capturedAtIso: now.toISOString(),
        eventId: "poll:test:copilot",
      });
      const limits = computeLimits(cache, {}, now, [
        { provider: "cursor", accountKey: "default" },
        { provider: "copilot", accountKey: "default" },
        { provider: "grok", accountKey: "default" },
      ]);

      const cursor = limits.find((l) => l.provider === "cursor")!;
      expect(cursor.windows.map((w) => w.kind).sort()).toEqual(["Cursor Models", "On-Demand", "Other Models"]);
      expect(cursor.windows.find((w) => w.kind === "On-Demand")?.amountUsd).toBeCloseTo(34.77);
      expect(cursor.windows.some((w) => w.kind === "day" || w.kind === "week" || w.kind === "month")).toBe(false);
      expect(cursor.budgetWindows?.map((w) => w.kind)).toEqual(["day", "week", "month"]);

      const copilot = limits.find((l) => l.provider === "copilot")!;
      expect(copilot.windows.map((w) => w.kind)).toEqual(["month"]);
      expect(copilot.budgetWindows?.map((w) => w.kind)).toEqual(["day", "week", "month"]);

      const grok = limits.find((l) => l.provider === "grok")!;
      expect(grok.windows).toEqual([]);
      expect(grok.budgetWindows?.map((w) => w.kind)).toEqual(["day", "week", "month"]);
      for (const limit of [cursor, copilot, grok]) {
        expect(limit.budgetWindows?.every((w) => w.source === "derived" && w.requests === 1 && w.usedPct === undefined)).toBe(true);
        expect(limit.windows.every((w) => w.source === "embedded")).toBe(true);
      }
    } finally {
      cache.close();
    }
  });

  it("uses monthly plan caps as the denominator when configured", () => {
    const cache = limitsCache();
    try {
      cache.insert([
        makeEvent({ id: "1", ts: "2026-08-05T09:00:00.000Z", costUsd: 10 }),
      ]);
      const config = { plans: { "openai:*": { monthlyCostCap: 200 } } };
      const limits = computeLimits(cache, config as never, new Date(2026, 7, 24, 12, 0));
      expect(limits.length).toBeGreaterThan(0);
      expect(limits[0]!.windows).toEqual([]);
      const month = limits[0]!.budgetWindows?.find((w) => w.kind === "month")!;
      expect(month.usedPct).toBeCloseTo(5, 0); // $10 of $200
      // day window carries a pace gauge (>100% = burning hot), not raw share
      const day = limits[0]!.budgetWindows?.find((w) => w.kind === "day")!;
      expect(day.usedPct).toBeUndefined(); // zero-cost day has no pace signal
    } finally {
      cache.close();
    }
  });

  it("day pace gauge compares spend to its own pro-rated share of the monthly cap, not the whole cap", () => {
    const cache = limitsCache();
    try {
      cache.insert([
        // Half of Aug 24 has elapsed by noon. A $310 monthly cap over
        // August's 31 days is a $10/day budget, so $5 spent by noon is
        // exactly on pace (100%) — not ~3% of the full monthly cap.
        makeEvent({ id: "1", ts: new Date(2026, 7, 24, 6, 0).toISOString(), costUsd: 5 }),
      ]);
      const config = { plans: { "openai:*": { monthlyCostCap: 310 } } };
      const limits = computeLimits(cache, config as never, new Date(2026, 7, 24, 12, 0));
      expect(limits[0]!.windows).toEqual([]);
      const day = limits[0]!.budgetWindows?.find((w) => w.kind === "day")!;
      expect(day.usedPct).toBeCloseTo(100, 0);
    } finally {
      cache.close();
    }
  });

  it("uses the latest observation of the same identified bucket and slot", () => {
    const cache = limitsCache();
    try {
      cache.insert([
        makeEvent({ id: "old", accountKey: "account:reported-account", ts: "2026-08-20T10:00:00.000Z", quota: { accountId: "reported-account", primary: { usedPct: 90, windowMinutes: 10080, resetsAtEpoch: 1 } } }),
        makeEvent({ id: "new", accountKey: "account:reported-account", ts: "2026-08-24T10:00:00.000Z", quota: { accountId: "reported-account", primary: { usedPct: 5, windowMinutes: 10080, resetsAtEpoch: 1788160164 } } }),
      ]);
      const limits = computeLimits(cache, {}, new Date("2026-08-24T12:00:00.000Z"));
      const week = limits[0]!.windows.find((w) => w.kind === "week")!;
      expect(week.usedPct).toBeCloseTo(5);
      expect(week).toMatchObject({ status: "current", bucketId: "codex", windowId: "primary", observedAt: "2026-08-24T10:00:00.000Z" });
      expect(cache.latestQuotaSnapshots("codex", "account:reported-account")).toHaveLength(1);
    } finally {
      cache.close();
    }
  });

  it("quarantines unidentified scanned quota while keeping its original observation time", () => {
    const cache = limitsCache();
    try {
      cache.insert([
        makeEvent({ id: "scanned", sessionId: "unbound-session", ts: "2026-08-20T10:00:00.000Z", quota: { primary: { usedPct: 40, windowMinutes: 300, resetsAtEpoch: 0 } } }),
      ]);
      const usageAccount = computeLimits(cache, {}, new Date("2026-08-20T12:00:00.000Z"))[0]!;
      expect(usageAccount.accountKey).toBe("openai:plus");
      expect(usageAccount.freshness).toBe("unknown");
      expect(usageAccount.windows).toEqual([]);
      expect(usageAccount.budgetWindows?.find((window) => window.kind === "day")?.requests).toBe(1);
      expect(cache.latestQuotaSnapshots("codex", "openai:plus")).toEqual([]);
      const snapshots = cache.latestQuotaSnapshots("codex", "unidentified:unbound-session");
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({ accountId: null, usedPct: 40, capturedAt: "2026-08-20T10:00:00.000Z" });
      const accounts = [{ provider: "codex", accountKey: "unidentified:unbound-session" }];
      const fresh = computeLimits(cache, {}, new Date("2026-08-20T12:00:00.000Z"), accounts)[0]!;
      expect(fresh.freshness).toBe("fresh");
      expect(fresh.email).toBeUndefined();
      expect(fresh.windows[0]).toMatchObject({ status: "unknown", observedAt: "2026-08-20T10:00:00.000Z" });
      expect(fresh.windows[0]?.usedPct).toBeUndefined();
      expect(fresh.windows[0]?.usedPercent).toBeUndefined();
      expect(computeLimits(cache, {}, new Date("2026-08-24T12:00:00.000Z"), accounts)[0]?.freshness).toBe("stale");
    } finally {
      cache.close();
    }
  });

  it("marks old live quota observations stale instead of implying zero", () => {
    const cache = limitsCache();
    try {
      cache.insertPolledSnapshots({
        provider: "codex",
        accountKey: "openai:plus",
        accountId: "personal-account",
        windows: [{ windowMinutes: 300, usedPct: 73, resetsAtEpoch: 1_800_000_000 }],
        capturedAtIso: "2026-08-27T10:00:00.000Z",
        eventId: "poll:2026-08-27T10:00:00.000Z:codex",
      });
      const limits = computeLimits(
        cache,
        { poll: { intervalMinutes: 15 } },
        new Date("2026-08-27T10:31:00.000Z"),
        [{ provider: "codex", accountKey: "openai:plus" }],
      );
      expect(limits[0]?.freshness).toBe("stale");
      expect(limits[0]?.observedAt).toBe("2026-08-27T10:00:00.000Z");
      expect(limits[0]?.windows[0]).toMatchObject({ status: "stale", observedAt: "2026-08-27T10:00:00.000Z" });
      expect(limits[0]?.windows[0]?.usedPct).toBeUndefined();
      expect(limits[0]?.windows[0]?.usedPercent).toBeUndefined();
      expect(limits[0]?.windows[0]?.pace).toBeUndefined();
      expect(cache.latestQuotaSnapshots("codex", "openai:plus")[0]?.usedPct).toBe(73);
    } finally {
      cache.close();
    }
  });
});

// ------------------------------------------------------------------ toggles

describe("ui toggles", () => {
  it("parses provider and provider:account targets", () => {
    expect(parseToggleTarget("codex")).toEqual({ provider: "codex" });
    expect(parseToggleTarget("codex:openai:plus")).toEqual({ provider: "codex", accountKey: "openai:plus" });
  });

  it("isVisibleOn honors hidden lists and menubarProviders allowlist", () => {
    const base = {} as Parameters<typeof isVisibleOn>[0];
    const hiddenWidget = { ui: { hidden: { widget: ["codex:openai:plus"] } } } as never;
    expect(isVisibleOn(hiddenWidget, "widget", "codex", "openai:plus")).toBe(false);
    expect(isVisibleOn(hiddenWidget, "widget", "codex", "other")).toBe(true);
    expect(isVisibleOn(hiddenWidget, "dashboard", "codex", "openai:plus")).toBe(true); // surface-scoped

    // pre-rename configs still resolve on the widget surface
    const hiddenMenubar = { ui: { hidden: { menubar: ["codex:openai:plus"] } } } as never;
    expect(isVisibleOn(hiddenMenubar, "widget", "codex", "openai:plus")).toBe(false);
    const hiddenBar = { ui: { hidden: { bar: ["codex:openai:plus"] } } } as never;
    expect(isVisibleOn(hiddenBar, "widget", "codex", "openai:plus")).toBe(false);

    const allowlist = { ui: { menubarProviders: ["claude-code"] } } as never;
    expect(isVisibleOn(allowlist, "widget", "codex", "x")).toBe(false);
    expect(isVisibleOn(allowlist, "widget", "claude-code", "default")).toBe(true);
    expect(isVisibleOn(allowlist, "dashboard", "codex", "x")).toBe(true); // allowlist is widget-only

    expect(isVisibleOn(base, "widget", "anything", "anyone")).toBe(true);
  });

  it("matches accountKey by suffix only, not substring anywhere", () => {
    // Docstring contract: "codex:plus" matches by suffix on accountKey.
    // Hiding it must not also hide an unrelated account that merely
    // contains "plus" somewhere in the middle.
    const hidden = { ui: { hidden: { widget: ["codex:plus"] } } } as never;
    expect(isVisibleOn(hidden, "widget", "codex", "plus-team-extra")).toBe(true);
    expect(isVisibleOn(hidden, "widget", "codex", "openai:plus")).toBe(false); // real suffix match still works
  });

  it("setSurfaceVisibility writes canonical json config", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-ui-"));
    const previousConfig = process.env.TOKITOKI_CONFIG;
    const previousData = process.env.TOKITOKI_DATA_DIR;
    process.env.TOKITOKI_CONFIG = path.join(dir, "config.json");
    process.env.TOKITOKI_DATA_DIR = dir;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require("node:fs").writeFileSync(process.env.TOKITOKI_CONFIG, JSON.stringify({ ui: { hidden: { menubar: ["stale"] } } }));
      setSurfaceVisibility("codex:openai:plus", "widget", false);
      setSurfaceVisibility("pi", "dashboard", false);
      // re-show removes the entry entirely
      setSurfaceVisibility("codex:openai:plus", "widget", true);
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const cfg = JSON.parse(require("node:fs").readFileSync(process.env.TOKITOKI_CONFIG, "utf8"));
      expect(cfg.ui.hidden.widget).toEqual(["stale"]); // legacy entry folded forward
      expect(cfg.ui.hidden.menubar).toBeUndefined();
      expect(cfg.ui.hidden.dashboard).toEqual(["pi"]);
    } finally {
      if (previousConfig === undefined) delete process.env.TOKITOKI_CONFIG;
      else process.env.TOKITOKI_CONFIG = previousConfig;
      if (previousData === undefined) delete process.env.TOKITOKI_DATA_DIR;
      else process.env.TOKITOKI_DATA_DIR = previousData;
    }
  });
});

describe("provider-neutral quota windows", () => {
  it("describes every polled provider's windows with scope, id, and pace", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "tk-limits-generic-"));
    const cache = new EventCache(path.join(dir, "cache.db"));
    const now = new Date();
    const epoch = (offsetMinutes: number) => Math.round(now.getTime() / 1000) + offsetMinutes * 60;
    try {
      cache.insertPolledSnapshots({
        provider: "opencode",
        accountKey: "opencode-go",
        windows: [
          { windowMinutes: 300, usedPct: 10, resetsAtEpoch: epoch(240) },
          { windowMinutes: 43_200, usedPct: 70, resetsAtEpoch: epoch(20 * 1440) },
        ],
        capturedAtIso: now.toISOString(),
        eventId: "poll:test:opencode",
      });
      cache.insertPolledSnapshots({
        provider: "cursor",
        accountKey: "default",
        windows: [
          { windowMinutes: 44_640, usedPct: 30, resetsAtEpoch: epoch(10 * 1440), label: "Cursor Models" },
          { windowMinutes: 44_640, usedPct: 0, resetsAtEpoch: epoch(10 * 1440), label: "On-Demand", amountUsd: 12 },
        ],
        capturedAtIso: now.toISOString(),
        eventId: "poll:test:cursor",
      });
      const limits = computeLimits(cache, {}, now, [
        { provider: "opencode", accountKey: "opencode-go" },
        { provider: "cursor", accountKey: "default" },
      ]);
      const opencode = limits.find((limit) => limit.provider === "opencode")!;
      expect(opencode.windows.find((window) => window.id === "session")).toMatchObject({ kind: "day", scope: "session", usedPercent: 10 });
      const monthly = opencode.windows.find((window) => window.id === "monthly")!;
      expect(monthly.pace?.status).toBe("over");
      expect(monthly.pace?.runsOutAt).toBeDefined();
      const cursor = limits.find((limit) => limit.provider === "cursor")!;
      expect(cursor.windows.find((window) => window.id === "monthly:cursor-models")).toMatchObject({ scope: "monthly", label: "Cursor Models" });
      expect(cursor.windows.find((window) => window.id === "monthly:on-demand")?.pace).toBeUndefined();
      expect(cursor.windows.every((window) => window.source === "embedded")).toBe(true);
      expect(cursor.budgetWindows).toBeUndefined();
    } finally {
      cache.close();
    }
  });
});
